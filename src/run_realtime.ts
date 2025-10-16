// src/run_realtime.ts
import { cfg } from "./config.js";
import { EventDB } from "./db/EventDB.js";
import { classify } from "./pipeline/classify.js";
import { score } from "./pipeline/score.js";
import { log } from "./logger.js";
import { notifyDiscord } from "./notify/discord.js";
import {
  fetchFmpPressReleases,
  isExchangeOk,
  isMarketCapValid,
} from "./providers/fmp.js";
import { runLlmCheck } from "./pipeline/llmCheck.js";

const nowIso = () => new Date().toISOString();

/* ---------------- helpers ---------------- */
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
function pct(n?: number) {
  return Number.isFinite(n as number) ? `${Math.round(n as number)}%` : "n/a";
}
function humanCapUsd(maybeUsd?: number) {
  if (!maybeUsd || maybeUsd <= 0) return "n/a";
  return maybeUsd >= 1_000_000_000
    ? `$${(maybeUsd / 1_000_000_000).toFixed(2)}B`
    : `$${(maybeUsd / 1_000_000).toFixed(1)}M`;
}
function bullets(arr?: string[], max = 6) {
  if (!arr?.length) return "• _none_";
  return arr
    .slice(0, max)
    .map((s) => `• ${s}`)
    .join("\n");
}
function sourcesLines(srcs?: { title: string; url: string }[], max = 6) {
  if (!srcs?.length) return "• _none_";
  return srcs
    .slice(0, max)
    .map((s) => `• [${s.title.slice(0, 80)}](${s.url})`)
    .join("\n");
}
function confidenceMeter(conf: "low" | "medium" | "high") {
  const v = conf === "high" ? 0.9 : conf === "medium" ? 0.6 : 0.3;
  const width = 14,
    filled = Math.round(clamp01(v) * width);
  return (
    "`" +
    "█".repeat(filled) +
    "░".repeat(width - filled) +
    "` " +
    Math.round(v * 100) +
    "%"
  );
}
function chooseColor(conf: "low" | "medium" | "high") {
  return conf === "high" ? 0x23d18b : conf === "medium" ? 0xffa657 : 0x738adb;
}
function threadName(symbol: string, headline: string) {
  const base = `${symbol} — ${headline}`;
  return base.length <= 95 ? base : base.slice(0, 94) + "…";
}
function linkButtons(symbol: string, prUrl?: string) {
  const buttons = [];
  if (prUrl)
    buttons.push({
      type: 2 as const,
      style: 5 as const,
      label: "Open PR",
      url: prUrl,
      emoji: { name: "📰" },
    });
  buttons.push({
    type: 2 as const,
    style: 5 as const,
    label: "Yahoo",
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    emoji: { name: "🟣" },
  });
  buttons.push({
    type: 2 as const,
    style: 5 as const,
    label: "OTC Markets",
    url: `https://www.otcmarkets.com/stock/${encodeURIComponent(
      symbol
    )}/overview`,
    emoji: { name: "🏷️" },
  });
  buttons.push({
    type: 2 as const,
    style: 5 as const,
    label: "TradingView",
    url: `https://www.tradingview.com/symbols/OTC-${encodeURIComponent(
      symbol
    )}/`,
    emoji: { name: "📈" },
  });
  buttons.push({
    type: 2 as const,
    style: 5 as const,
    label: "SEC Filings",
    url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(symbol)}`,
    emoji: { name: "📄" },
  });
  return [{ type: 1 as const, components: buttons }];
}

/* --------------- preconditions --------------- */
if (!cfg.FMP_API_KEY) {
  throw new Error("Missing FMP API key in config (FMP_API_KEY).");
}
log.info("[BOOT] using DB:", cfg.DB_PATH);
log.info("[BOOT] cadence:", {
  POLL_NEWS_SECONDS: cfg.POLL_NEWS_SECONDS,
  NEWS_LOOKBACK_MINUTES: cfg.NEWS_LOOKBACK_MINUTES ?? 180,
  ALERT_THRESHOLD: cfg.ALERT_THRESHOLD,
});
const ENABLE_THREADS = (cfg as any).DISCORD_CREATE_THREAD !== false; // default true
const ADD_REACTIONS = (cfg as any).DISCORD_ADD_REACTIONS !== false; // default true
const CONCURRENCY = Number(
  process.env.NEON_CONCURRENCY ?? (cfg as any).CONCURRENCY ?? 4
);

// Alert only if expected move >= this percent (uses max(p50, p90) from llmCheck)
const MOVE_ALERT_THRESHOLD_PCT = 40;

/* ---------------- state ---------------- */
const eventDb = new EventDB(cfg.DB_PATH);

/* ---------- tiny concurrency pool (no deps) ---------- */
async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, idx: number) => Promise<void>,
  concurrency: number
) {
  if (items.length === 0) return;
  const queue = items.map((v, i) => ({ v, i }));
  let active = 0;
  let cursor = 0;

  return new Promise<void>((resolve) => {
    const launch = () => {
      if (cursor >= queue.length) {
        if (active === 0) resolve();
        return;
      }
      const { v, i } = queue[cursor++];
      active++;
      Promise.resolve(worker(v, i))
        .catch((err) => {
          // already logged inside worker; keep pool going
          log.error("[WORKER] unhandled error", { idx: i, err });
        })
        .finally(() => {
          active--;
          launch(); // start next
        });
      if (active < concurrency) launch();
    };
    const first = Math.min(concurrency, queue.length);
    for (let k = 0; k < first; k++) launch();
  });
}

/* ---------------- single-item pipeline ---------------- */
async function processItem(item: any) {
  // ---------- SYMBOL ----------
  const symbol = item.symbols?.[0];
  if (!symbol) {
    log.warn("[NEWS] skip (no symbol)", { title: item.title?.slice(0, 140) });
    return;
  }

  // ---------- MARKET CAP ----------
  const isMarketCapOk = await isMarketCapValid({
    item,
    minMarketCap: 0,
    maxMarketCap: 100_000_000,
  });
  if (!isMarketCapOk) {
    log.info("[NEWS] skip (market cap filter)", {
      symbol,
      title: item.title,
    });
    return;
  }

  // ---------- EXCHANGE ----------
  const ok = await isExchangeOk(symbol);
  if (!ok) {
    log.info("[NEWS] skip (exchange check failed)", {
      symbol,
      title: item.title,
    });
    return;
  }

  // ---------- CANONICAL ----------
  const canonicalHeadline = item.title ?? "";
  const canonicalLink = item.url ?? "";
  const publishedAt = item.publishedAt ?? null;

  // ---------- DEDUPE ----------
  const hash = eventDb.makeHash({
    title: canonicalHeadline,
    url: canonicalLink,
    source: item.source,
  });
  if (eventDb.seen(hash)) {
    log.info("[NEWS] dedupe", {
      symbol,
      title: canonicalHeadline.slice(0, 120),
    });
    return;
  }
  eventDb.save(item);

  // ---------- LLM enrichment ----------
  let estBucket = "n/a";
  let p50 = "n/a";
  let p90 = "n/a";
  let p50Num = 0; // numeric capture for gating
  let p90Num = 0; // numeric capture for gating
  let blurb = "";
  let strengthLabel = "";
  let confEmoji = "🟡";
  let conf: "low" | "medium" | "high" = "low";
  let capStr = "n/a";
  let pxStr = "n/a";
  let pros: string[] = [];
  let cons: string[] = [];
  let redFlags: string[] = [];
  let sources: { title: string; url: string }[] = [];

  try {
    const out = await runLlmCheck(item, {
      canonical: {
        headline: canonicalHeadline,
        url: canonicalLink,
        publishedAt,
        wire: item.source ?? null,
      },
      maxSources: 6,
    });
    log.info(out);

    if (out.est) {
      estBucket = out.est.expected_move.bucket;
      p50Num = Number(out.est.expected_move.p50 || 0);
      p90Num = Number(out.est.expected_move.p90 || 0);
      p50 = pct(p50Num);
      p90 = pct(p90Num);
      conf = out.est.confidence as any;
    }
    blurb = out.blurb;
    strengthLabel = out.strengthBucket;
    confEmoji = out.confidenceEmoji;

    if (out.basics?.marketCapUsd) capStr = humanCapUsd(out.basics.marketCapUsd);
    if (out.basics?.price != null) pxStr = `$${out.basics.price.toFixed(4)}`;

    pros = out.pros || [];
    cons = out.cons || [];
    redFlags = out.red_flags || [];
    sources = out.sources || [];
  } catch (e) {
    log.warn("[LLM] error", e);
  }

  // ---------- ALERT GATE: require >= threshold move ----------
  const moveMax = Math.max(
    Number.isFinite(p50Num) ? p50Num : 0,
    Number.isFinite(p90Num) ? p90Num : 0
  );
  if (moveMax < MOVE_ALERT_THRESHOLD_PCT) {
    log.info("[NEWS] skip (expected move below threshold)", {
      symbol,
      p50: p50Num,
      p90: p90Num,
      threshold: MOVE_ALERT_THRESHOLD_PCT,
      bucket: estBucket,
    });
    return; // do not send Discord message
  }

  const color = chooseColor(conf);

  // ---------- Embeds ----------
  const mainEmbed = {
    title: `${symbol} — ${canonicalHeadline}`.slice(0, 256),
    url: canonicalLink || undefined,
    description: blurb ? `> ${blurb}` : undefined,
    color,
    timestamp: publishedAt || nowIso(),
    author: { name: "NEON·PR — Live Catalyst" },
    footer: {
      text: `class=${String(item.klass)} • score=${item.score.toFixed(
        2
      )} • ${strengthLabel}`,
    },
    fields: [
      { name: "🎯 Expected Move", value: `\`${estBucket}\``, inline: true },
      { name: "p50 / p90", value: `\`${p50}\` / \`${p90}\``, inline: true },
      {
        name: "Confidence",
        value: `${confEmoji} ${conf}\n${confidenceMeter(conf)}`,
        inline: true,
      },
      {
        name: "Basics",
        value: `cap **${capStr}**  •  px **${pxStr}**`,
        inline: false,
      },
      { name: "Drivers", value: bullets(pros, 6), inline: false },
      { name: "Caveats", value: bullets(cons, 6), inline: false },
    ],
  };

  const riskFields = [];
  if (redFlags.length)
    riskFields.push({
      name: "⚠️ Red Flags",
      value: bullets(redFlags, 6),
      inline: false,
    });
  if (sources.length)
    riskFields.push({
      name: "Sources",
      value: sourcesLines(sources, 6),
      inline: false,
    });

  const extrasEmbed =
    riskFields.length > 0
      ? { title: `Risk & Sources — ${symbol}`, color, fields: riskFields }
      : null;

  const components = linkButtons(symbol, canonicalLink);

  const wantsThread = ENABLE_THREADS;
  const thread = wantsThread
    ? {
        name: threadName(symbol, canonicalHeadline),
        autoArchiveMinutes: 1440 as 1440,
      }
    : undefined;
  const reactions = ADD_REACTIONS ? ["👀", "📈", "💬"] : undefined;

  await notifyDiscord({
    content: "",
    embeds: extrasEmbed ? [mainEmbed, extrasEmbed] : [mainEmbed],
    components,
    thread,
    reactions,
  });
}

/* ---------------- core loop ---------------- */
async function newsCycle() {
  const started = Date.now();

  try {
    const rawItems = await fetchFmpPressReleases({ maxPages: 1 });
    const classified = classify(rawItems);
    const scored = score(classified);
    const passed = scored.filter((it) => it.score >= cfg.ALERT_THRESHOLD);

    log.info("[NEWS] fetched", {
      rawCount: rawItems.length,
      passCount: passed.length,
      concurrency: CONCURRENCY,
    });

    // ⬇️ run all items concurrently with a safe cap
    await runWithConcurrency(passed, processItem, CONCURRENCY);
  } catch (err) {
    log.error("newsCycle error:", err);
  } finally {
    log.info("[NEWS] cycle end", { tookMs: Date.now() - started });
  }
}

/* ---------------- boot ---------------- */
function start() {
  log.info("Realtime: polling FMP press releases", { at: nowIso() });
  newsCycle();
  const pollMs = Math.max(5, cfg.POLL_NEWS_SECONDS) * 1000;
  setInterval(newsCycle, pollMs);
}
start();
