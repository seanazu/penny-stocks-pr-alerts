// src/run_realtime.ts
import { cfg } from "./config.js";
import { EventDB } from "./db/EventDB.js";
import { classify } from "./pipeline/classify.js";
import { score } from "./pipeline/score.js";
import { log } from "./logger.js";
import { notifyDiscord } from "./notify/discord.js";
import { fetchFmpPressReleases, isExchangeOk } from "./providers/fmp.js";
import { runLlmCheck } from "./pipeline/llmCheck.js";

const nowIso = () => new Date().toISOString();

/* ---------------- helpers ---------------- */
function humanCap(x?: number) {
  if (!x || x <= 0) return "n/a";
  const b = 1_000_000_000,
    m = 1_000_000;
  return x >= b ? `$${(x / b).toFixed(2)}B` : `$${(x / m).toFixed(1)}M`;
}
function pct(n?: number) {
  if (!Number.isFinite(n as number)) return "n/a";
  return `${Math.round(n as number)}%`;
}
function meter(value01: number, width = 10) {
  const v = Math.max(0, Math.min(1, value01));
  const filled = Math.round(v * width);
  return "▮".repeat(filled) + "▯".repeat(width - filled);
}
function section(title: string) {
  return `\n__${title}__`;
}

/* --------------- boot preconditions --------------- */
if (!cfg.FMP_API_KEY) {
  throw new Error("Missing FMP API key in config (FMP_API_KEY).");
}

log.info("[BOOT] using DB:", cfg.DB_PATH);
log.info("[BOOT] cadence:", {
  POLL_NEWS_SECONDS: cfg.POLL_NEWS_SECONDS,
  NEWS_LOOKBACK_MINUTES: cfg.NEWS_LOOKBACK_MINUTES ?? 180,
  ALERT_THRESHOLD: cfg.ALERT_THRESHOLD,
});

/* ---------------- state ---------------- */
const eventDb = new EventDB(cfg.DB_PATH);

/* ---------------- core loop ---------------- */
async function newsCycle() {
  const started = Date.now();
  log.info("[NEWS] cycle start", { at: new Date(started).toISOString() });

  try {
    const rawItems = await fetchFmpPressReleases({
      maxPages: 1,
      // keep micro/penny; allow unknown caps so OTC with missing data still pass to classifier
      minMarketCap: 0,
      maxMarketCap: 30_000_000,
      includeUnknownMktCap: true,
      lookbackMinutes: cfg.NEWS_LOOKBACK_MINUTES ?? 180,
    });

    const rawCount = rawItems.length;

    // Classify → Score
    const classified = classify(rawItems);
    const scored = score(classified);
    const passed = scored.filter((it) => it.score >= cfg.ALERT_THRESHOLD);
    const passCount = passed.length;

    log.info("[NEWS] fetched", {
      rawCount,
      passCount,
      lookbackMin: cfg.NEWS_LOOKBACK_MINUTES ?? 180,
    });

    for (const item of passed) {
      const symbol = item.symbols?.[0];
      if (!symbol) {
        log.warn("[NEWS] skip (no symbol)", {
          title: item.title?.slice(0, 120),
        });
        continue;
      }

      // Ensure OTC is allowed (your updated isExchangeOk normalizes all OTC forms)
      const ok = await isExchangeOk(symbol);
      if (!ok) {
        log.info("[NEWS] skip (exchange check failed)", {
          symbol,
          title: item.title,
        });
        continue;
      }

      // Dedupe by (title|url|source)
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

      // ---------- LLM enrichment (move estimate + quick verification) ----------
      let estBucket = "n/a";
      let p50 = "n/a";
      let p90 = "n/a";
      let blurb = "";
      let strengthLabel = "";
      let confEmoji = "🟡";
      let conf = "low";
      let headline = item.title ?? "";
      let link = item.url ?? "";
      let capStr = "n/a";
      let pxStr = "n/a";

      try {
        const out = await runLlmCheck(item);

        // basics
        capStr = humanCap(out.basics.marketCapUsd);
        pxStr =
          out.basics.price != null ? `$${out.basics.price.toFixed(2)}` : "n/a";
        log.info("[LLM] output", out);
        // estimation
        if (out.est) {
          estBucket = out.est.expected_move.bucket;
          p50 = pct(out.est.expected_move.p50);
          p90 = pct(out.est.expected_move.p90);
          conf = out.est.confidence;
          headline = out.est.headline || headline;
          link = out.est.link || link;
        }
        blurb = out.blurb;
        strengthLabel = out.strengthBucket;
        confEmoji = out.confidenceEmoji;

        log.info("[LLM] estimation", {
          symbol,
          bucket: estBucket,
          p50,
          p90,
          strength: out.est?.catalyst_strength ?? null,
          confidence: conf,
        });
      } catch (e) {
        log.warn("[LLM] error", e);
      }

      // ---------- Discord alert (beautiful & understandable) ----------
      const ts = new Date()
        .toISOString()
        .replace("T", " ")
        .replace("Z", " UTC");
      const titleLine = `**📰 ${symbol} — Press Release**`;
      const headlineLine = headline ? `**${headline}**` : "";

      // Primary stats line
      const expected =
        estBucket !== "n/a"
          ? `**🎯 Expected Move:** \`${estBucket}\` • **p50:** \`${p50}\` • **p90:** \`${p90}\``
          : `**🎯 Expected Move:** \`n/a\``;

      // Strength + confidence meter
      const meterLine = (() => {
        const m =
          estBucket !== "n/a"
            ? meter(
                // mild mapping from categorical confidence to numeric 0..1
                conf === "high" ? 0.9 : conf === "medium" ? 0.6 : 0.3
              )
            : meter(0.2);
        return `**Signal:** ${strengthLabel}  •  **Confidence:** ${confEmoji} ${conf}\n${m}`;
      })();

      // Basics
      const basicsLine = `**Market Cap:** ${capStr}  •  **Price:** ${pxStr}`;

      // Blurb
      const blurbLine = blurb ? `> ${blurb}` : "";

      // Source + link
      const srcLine = [
        item.source ? `**Source:** \`${item.source}\`` : "",
        link ? `🔗 ${link}` : "",
      ]
        .filter(Boolean)
        .join("  •  ");

      // Footer
      const footer = `*${ts}*`;

      const messageParts = [
        titleLine,
        headlineLine,
        section("Impact"),
        expected,
        meterLine,
        section("Snapshot"),
        basicsLine,
        blurbLine ? section("Quick Take") + "\n" + blurbLine : "",
        srcLine ? section("Links") + "\n" + srcLine : "",
        section("Meta") +
          `\nscore=${item.score.toFixed(2)} • class=\`${item.klass}\``,
        footer,
      ].filter(Boolean);

      await notifyDiscord(messageParts.join("\n"));
    }
  } catch (err) {
    log.error("newsCycle error:", err);
  } finally {
    const tookMs = Date.now() - started;
    log.info("[NEWS] cycle end", { tookMs });
  }
}

/* ---------------- boot ---------------- */
function start() {
  log.info("Realtime: polling FMP press releases", { at: nowIso() });

  // Kick off immediately, then on interval
  newsCycle();
  const pollMs = Math.max(5, cfg.POLL_NEWS_SECONDS) * 1000;
  setInterval(newsCycle, pollMs);
}

start();
