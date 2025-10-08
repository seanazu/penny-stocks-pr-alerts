// src/run_realtime.ts
import path from "path";
import { cfg } from "./config.js";
import { EventDB } from "./db/EventDB.js";
import { fetchAllProviders } from "./providers/index.js";
import { classify } from "./pipeline/classify.js";
import { score } from "./pipeline/score.js";
import { PolygonFeed } from "./marketdata/polygon.js"; // ✅ Polygon feed
import { log } from "./logger.js";
import { notifyDiscord } from "./notify/discord.js";
import { isExchangeOk } from "./providers/fmp.js";
import { hasVeryUnusualVolume } from "./providers/polygon.js";
import { runLlmCheck } from "./pipeline/llmCheck.js";

const nowIso = () => new Date().toISOString();

// ---- Preconditions / config echo ----
if (!cfg.POLYGON_API_KEY) {
  throw new Error("Missing Polygon API key in config (POLYGON_API_KEY).");
}
log.info("[BOOT] using DB:", cfg.DB_PATH);
log.info("[BOOT] polygon ws url:", "wss://socket.polygon.io/stocks");
log.info("[BOOT] thresholds:", {
  ALERT_THRESHOLD: cfg.ALERT_THRESHOLD,
  VOL_Z_MIN: cfg.VOL_Z_MIN,
  RET_1M_MIN: cfg.RET_1M_MIN,
  VWAP_DEV_MIN: cfg.VWAP_DEV_MIN,
});
log.info("[BOOT] cadence:", {
  POLL_NEWS_SECONDS: cfg.POLL_NEWS_SECONDS,
  NEWS_LOOKBACK_MINUTES: cfg.NEWS_LOOKBACK_MINUTES ?? 180,
});

// ---- State ----
const eventDb = new EventDB(cfg.DB_PATH);
const watchlist = new Set<string>();

// visibility & liveness
let lastNewsRun = 0;
let lastBarAt = 0;

// Where to dump “backtest” fills continuously
const CSV_PATH = path.resolve(
  "logs",
  `fills-${new Date().toISOString().slice(0, 10)}.csv`
);

// ---- News → watchlist ----
async function newsCycle() {
  const started = Date.now();
  lastNewsRun = started;
  log.info("[NEWS] cycle start", { at: new Date(started).toISOString() });

  try {
    const rawItems = await fetchAllProviders();
    const rawCount = rawItems.length;

    // Ignore stale items (helps on restarts)
    const cutoffMs =
      Date.now() - Number(cfg.NEWS_LOOKBACK_MINUTES ?? 180) * 60_000;
    const filtered = rawItems.filter((i) => {
      const t = Date.parse(i.publishedAt || "");
      return Number.isFinite(t) ? t >= cutoffMs : true;
    });
    const filteredCount = filtered.length;

    const classified = classify(rawItems);
    const scored = score(classified);
    const passed = scored.filter((it) => it.score >= cfg.ALERT_THRESHOLD);
    const passCount = passed.length;
    console.log("[NEWS] passed", { passCount });

    log.info("[NEWS] fetched", {
      rawCount,
      filteredCount,
      passCount,
      lookbackMin: cfg.NEWS_LOOKBACK_MINUTES ?? 180,
    });

    for (const item of passed) {
      // Symbol check
      const symbol = item.symbols?.[0];
      if (!symbol) {
        log.warn("[NEWS] skip (no symbol)", {
          title: item.title?.slice(0, 120),
        });
        continue;
      }

      // Exchange check (e.g. skip ALL but OTC)
      const passed = await isExchangeOk(symbol);
      if (!passed) {
        log.info("[FMP] skip (exchange check failed)", {
          symbol,
          title: item.title,
        });
        continue;
      }

      // const hasUnusualVolume = await hasVeryUnusualVolume(symbol);
      // if (!hasUnusualVolume) {
      //   log.info("[POLY] skip (no unusual volume)", {
      //     symbol,
      //     title: item.title,
      //   });
      //   continue;
      // }

      // --- Collect LLM fields in outer scope ---
      let blurb = "";
      let details = "";
      let strengthBucket = "";
      let confEmoji = "";
      let confLevel = "low"; // <-- keep this outside try/catch
      let estBucket = "";
      let p50 = "";
      let p90 = "";

      const hash = eventDb.makeHash({
        title: item.title,
        url: item.url,
        source: item.source,
      });
      if (eventDb.seen(hash)) {
        log.info("[NEWS] dedupe", { symbol, title: item.title?.slice(0, 100) });
        continue;
      }

      eventDb.save(item);
      watchlist.add(symbol);

      log.info("[NEWS] added to watchlist", {
        symbol,
        klass: item.klass,
        score: item.score.toFixed(2),
        wlSize: watchlist.size,
        title: item.title?.slice(0, 140),
        url: item.url || "",
      });

      try {
        const out = await runLlmCheck(item);
        blurb = out.blurb;
        details = out.details;
        strengthBucket = out.strengthBucket; // e.g., "🔥 VERY STRONG (72%)"
        confEmoji = out.confidenceEmoji; // 🟢/🟠/🟡
        confLevel = out.est?.confidence ?? "low";
        if (out.est) {
          estBucket = out.est.expected_move.bucket; // e.g., "150-300%"
          p50 = `${Math.round(out.est.expected_move.p50)}%`;
          p90 = `${Math.round(out.est.expected_move.p90)}%`;
        }
        log.info("[LLM] estimation", {
          symbol,
          bucket: estBucket || "n/a",
          strength: out.est?.catalyst_strength ?? null,
          confidence: confLevel,
        });
      } catch (e) {
        log.warn("[LLM] error", e);
      }

      // Discord alert for the news itself
      // --- Beautiful Discord message ---
      const lines: string[] = [];
      lines.push(
        `**📰 NEWS | ${symbol}** — *${
          item.klass
        }*  *(score=${item.score.toFixed(2)})*`
      );
      lines.push(`**${item.title ?? ""}**`);
      if (item.url) lines.push(item.url);

      // Quick take paragraph
      if (blurb) lines.push(`\n> ${blurb}`);

      // LLM + stock details block
      const llmLine = estBucket
        ? `**🎯 Move**: \`${estBucket}\`  •  **p50**: \`${p50}\`  •  **p90**: \`${p90}\`\n**🧪 Strength**: ${strengthBucket}  •  **Confidence**: ${confEmoji} ${confLevel}`
        : `**🎯 Move**: \`n/a\`\n**🧪 Strength**: ${
            strengthBucket || "n/a"
          }  •  **Confidence**: ${confEmoji || "🟡"} ${confLevel}`;

      lines.push("\n" + llmLine);

      // Stock basics (cap/price/etc.)
      if (details) lines.push("\n" + details);

      // Final notify
      await notifyDiscord(lines.join("\n"));
    }
  } catch (err) {
    log.error("newsCycle error:", err);
  } finally {
    const tookMs = Date.now() - started;
    log.info("[NEWS] cycle end", { tookMs });
  }
}

// ---- Market data feed (Polygon) ----
const feed = new PolygonFeed(cfg.POLYGON_API_KEY);

// Polygon status frames: {ev:"status", message/status:string}
feed.on("status", (s: any) => {
  const msg =
    s?.message ?? s?.status ?? (typeof s === "string" ? s : JSON.stringify(s));
  log.info("[WS-STATUS]", msg);
});
feed.on("error", (e) => log.error("[WS-ERROR]", e));

// Liveness: warn if connected but not receiving bars (useful during RTH)
setInterval(() => {
  const idleSec = (Date.now() - (lastBarAt || Date.now())) / 1000;
  if (!lastBarAt) {
    log.info(
      "[WS] no bars yet — if outside RTH or on delayed cluster, this can be normal."
    );
  } else if (idleSec > 300) {
    log.warn(
      "[WS] no bars in",
      Math.round(idleSec),
      "s. If during RTH, check entitlement or WS URL."
    );
  }
  if (watchlist.size) {
    log.info("[WL] symbols under watch", {
      count: watchlist.size,
      list: Array.from(watchlist).slice(0, 10),
    });
  }
}, 60_000);

// ---- Boot ----
function start() {
  log.info("Realtime: polling news & confirming with Polygon 1m bars", {
    at: nowIso(),
  });

  // Kick off immediately, then on interval
  newsCycle();
  const pollMs = Math.max(5, cfg.POLL_NEWS_SECONDS) * 1000;
  setInterval(newsCycle, pollMs);

  // Keep the socket alive with a baseline symbol; real names are tracked via watchlist
  // const keepAliveTickers = ["SPY"];
  // log.info("[BOOT] connecting WS (keepalive):", keepAliveTickers);
  // feed.connect([...new Set(keepAliveTickers)]);
}

start();
