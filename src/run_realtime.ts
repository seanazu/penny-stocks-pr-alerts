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
import { fetchPolygonReferenceNews } from "./providers/polygon.js";

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
function shortDate(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(+d)
    ? ""
    : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
        2,
        "0"
      )}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function sourcesLines(
  srcs?: {
    title: string;
    url: string;
    publisher?: string | null;
    publishedISO?: string | null;
  }[],
  max = 6
) {
  if (!srcs?.length) return "• _none_";
  return srcs
    .slice(0, max)
    .map((s) => {
      const label = s.title ? s.title.slice(0, 90) : s.url;
      const metaParts = [];
      if (s.publisher) metaParts.push(s.publisher);
      const d = shortDate(s.publishedISO ?? undefined);
      if (d) metaParts.push(d);
      const meta = metaParts.length ? ` — _${metaParts.join(" · ")}_` : "";
      return `• [${label}](${s.url})${meta}`;
    })
    .join("\n");
}
function meter01(x: number, width = 14) {
  const v = clamp01(x);
  const filled = Math.round(v * width);
  return (
    "`" +
    "█".repeat(filled) +
    "░".repeat(width - filled) +
    "` " +
    Math.round(v * 100) +
    "%"
  );
}
function confidenceMeter(conf: "low" | "medium" | "high") {
  const v = conf === "high" ? 0.9 : conf === "medium" ? 0.6 : 0.3;
  return meter01(v);
}
function chooseColorByDecision(
  decision: "YES" | "SPECULATIVE" | "PASS",
  belowThreshold: boolean
) {
  if (decision === "YES") return 0x23d18b; // green
  if (decision === "SPECULATIVE") return 0xffa657; // orange
  return belowThreshold ? 0x666a70 : 0x738adb; // muted gray or blurple
}
function boolEmoji(b?: boolean) {
  return b ? "✅" : "❌";
}
function threadName(
  symbol: string,
  headline: string,
  invest: string,
  p90?: number
) {
  const p90txt = Number.isFinite(p90 as number)
    ? ` · p90~${Math.round(p90 as number)}%`
    : "";
  const base = `${symbol} — ${headline}${p90txt} · ${invest}`;
  return base.length <= 95 ? base : base.slice(0, 94) + "…";
}
function hostname(url?: string) {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
const WIRE_HOSTS = new Set([
  "www.prnewswire.com",
  "www.globenewswire.com",
  "www.businesswire.com",
  "www.accesswire.com",
  "www.newsfilecorp.com",
  "prismmediawire.com",
  "www.prismmediawire.com",
  "mcapmediawire.com",
  "www.mcapmediawire.com",
]);
function isIRHost(h?: string) {
  return (
    !!h &&
    (/^ir\./i.test(h) || /^investors?\./i.test(h) || /^newsroom\./i.test(h))
  );
}
function isGovOrFilingHost(h?: string) {
  return (
    !!h &&
    (/(\.|^)sec\.gov$/i.test(h) ||
      /sedar/i.test(h) ||
      /(\.|^)gov$/i.test(h) ||
      /(\.|^)sam\.gov$/i.test(h) ||
      /(\.|^)usaspending\.gov$/i.test(h) ||
      /(\.|^)canada\.ca$/i.test(h) ||
      /(\.|^)europa\.eu$/i.test(h))
  );
}
function isWireHost(h?: string) {
  return !!h && WIRE_HOSTS.has(h);
}
function splitSources(
  symbol: string,
  prUrl: string | undefined,
  srcs?: {
    title: string;
    url: string;
    publisher?: string | null;
    publishedISO?: string | null;
  }[]
) {
  const out = {
    wireOrIR: [] as typeof srcs,
    govOrFiling: [] as typeof srcs,
    counterparty: [] as typeof srcs,
    other: [] as typeof srcs,
  };
  if (!srcs?.length) return out;
  const companyHost = hostname(prUrl);
  for (const s of srcs) {
    const h = hostname(s.url);
    if (isWireHost(h) || isIRHost(h) || (companyHost && h === companyHost)) {
      (out.wireOrIR as any).push(s);
    } else if (isGovOrFilingHost(h)) {
      (out.govOrFiling as any).push(s);
    } else {
      (out.counterparty as any).push(s);
    }
  }
  return out;
}
function pickFirst<T>(xs?: T[]) {
  return xs && xs.length ? xs[0] : undefined;
}
function linkButtonsEnhanced(
  symbol: string,
  prUrl?: string,
  sources?: {
    title: string;
    url: string;
    publisher?: string | null;
    publishedISO?: string | null;
  }[]
) {
  const comps: any[] = [];
  const { wireOrIR, govOrFiling, counterparty } = splitSources(
    symbol,
    prUrl,
    sources
  );

  const irOrWire = pickFirst(wireOrIR);
  const filing = pickFirst(govOrFiling);
  const cp = pickFirst(counterparty);

  const buttons: any[] = [];
  if (irOrWire?.url) {
    buttons.push({
      type: 2 as const,
      style: 5 as const,
      label: irOrWire.publisher
        ? `PR/IR: ${String(irOrWire.publisher).slice(0, 20)}`
        : "Open PR / IR",
      url: irOrWire.url,
      emoji: { name: "📰" },
    });
  } else if (prUrl) {
    buttons.push({
      type: 2 as const,
      style: 5 as const,
      label: "Open PR",
      url: prUrl,
      emoji: { name: "📰" },
    });
  }

  if (filing?.url) {
    buttons.push({
      type: 2 as const,
      style: 5 as const,
      label: "SEC/Gov Source",
      url: filing.url,
      emoji: { name: "📄" },
    });
  }
  if (cp?.url) {
    buttons.push({
      type: 2 as const,
      style: 5 as const,
      label: "Counterparty Newsroom",
      url: cp.url,
      emoji: { name: "🤝" },
    });
  }

  // Convenience links
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

  comps.push({ type: 1 as const, components: buttons });
  return comps;
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
const CONCURRENCY = Number(
  process.env.NEON_CONCURRENCY ?? (cfg as any).CONCURRENCY ?? 4
);

// Soft threshold for context only; we always alert
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
          log.error("[WORKER] unhandled error", { idx: i, err });
        })
        .finally(() => {
          active--;
          launch();
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
  let decision: "YES" | "SPECULATIVE" | "PASS" = "PASS";
  let reasons: string[] = [];
  let gates = {
    isWire: false,
    hasNamedCounterparty: false,
    hasQuantDetails: false,
    hasIndependentCorroboration: false,
    tickerVerified: false,
    redFlagsDetected: false,
  };
  let impact = null as any;

  let estBucket = "n/a";
  let p50 = "n/a";
  let p90 = "n/a";
  let p50Num = 0;
  let p90Num = 0;
  let blurb = "";
  let strengthLabel = "";
  let confEmoji = "🟡";
  let conf: "low" | "medium" | "high" = "low";
  let catalystStrength = 0;
  let capStr = "n/a";
  let pxStr = "n/a";
  let pros: string[] = [];
  let cons: string[] = [];
  let redFlags: string[] = [];
  let sources:
    | {
        title: string;
        url: string;
        publisher?: string | null;
        publishedISO?: string | null;
      }[]
    | undefined = [];

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

    decision = out.decision?.invest ?? "PASS";
    reasons = out.decision?.reasons ?? [];
    gates = out.decision?.gates ?? gates;
    impact = out.decision?.impact ?? null;

    if (out.est) {
      estBucket = out.est.expected_move.bucket;
      p50Num = Number(out.est.expected_move.p50 || 0);
      p90Num = Number(out.est.expected_move.p90 || 0);
      p50 = pct(p50Num);
      p90 = pct(p90Num);
      conf = out.est.confidence as any;
      confEmoji = out.confidenceEmoji || confEmoji;
      catalystStrength = clamp01(out.est.catalyst_strength || 0);
    }
    blurb = out.blurb || blurb;
    strengthLabel = out.strengthBucket || strengthLabel;

    if (out.basics?.marketCapUsd) capStr = humanCapUsd(out.basics.marketCapUsd);
    if (out.basics?.price != null)
      pxStr = `$${Number(out.basics.price).toFixed(4)}`;

    pros = out.pros || [];
    cons = out.cons || [];
    redFlags = out.red_flags || [];
    sources = out.sources || [];
  } catch (e) {
    log.warn("[LLM] error", e);
  }

  // ---------- Context about threshold (no longer gating alerts) ----------
  const moveMax = Math.max(
    Number.isFinite(p50Num) ? p50Num : 0,
    Number.isFinite(p90Num) ? p90Num : 0
  );
  const belowThreshold = moveMax < MOVE_ALERT_THRESHOLD_PCT;
  const thresholdNote = belowThreshold
    ? `Below alert threshold (${Math.round(
        moveMax
      )}% < ${MOVE_ALERT_THRESHOLD_PCT}%).`
    : "";

  // ---------- Build Discord message (always send) ----------
  const color = chooseColorByDecision(decision, belowThreshold);

  const decisionIcon =
    decision === "YES" ? "🟢" : decision === "SPECULATIVE" ? "🟠" : "🟡";
  const verificationLines = [
    `${boolEmoji(gates.isWire)} on wire/IR`,
    `${boolEmoji(gates.hasNamedCounterparty)} named counterparty`,
    `${boolEmoji(gates.hasQuantDetails)} quantitative details`,
    `${boolEmoji(gates.hasIndependentCorroboration)} independent corroboration`,
    `${boolEmoji(gates.tickerVerified)} ticker verified`,
    `${gates.redFlagsDetected ? "❌ red flags" : "✅ no red flags"}`,
  ].join("\n");

  const impactLines = impact
    ? [
        `Total: ${meter01(impact.total ?? 0)}`,
        `• Materiality: ${pct((impact.materiality ?? 0) * 100)}`,
        `• Binding: ${pct((impact.bindingLevel ?? 0) * 100)}`,
        `• Counterparty: ${pct((impact.counterpartyQuality ?? 0) * 100)}`,
        `• Specificity: ${pct((impact.specificity ?? 0) * 100)}`,
        `• Corroboration: ${pct((impact.corroboration ?? 0) * 100)}`,
        `• ExecRisk: ${pct((impact.executionRisk ?? 0) * 100)}`,
      ].join("\n")
    : "• _n/a_";

  const contextLines =
    decision === "PASS" || belowThreshold
      ? bullets(
          [
            decision === "PASS"
              ? "Model decision: **PASS** (posted for awareness)"
              : "",
            thresholdNote,
          ].filter(Boolean),
          3
        )
      : undefined;

  const mainEmbed = {
    title: `${symbol} — ${canonicalHeadline}`.slice(0, 256),
    url: canonicalLink || undefined,
    description: blurb ? `> ${blurb}` : undefined,
    color,
    timestamp: publishedAt || nowIso(),
    author: { name: "NEON·PR — Live Catalyst" },
    footer: {
      text: `class=${String(item.klass)} • score=${Number(
        item.score ?? 0
      ).toFixed(2)} • ${strengthLabel}`,
    },
    fields: [
      {
        name: "🧭 Decision",
        value: `**${decisionIcon} ${decision}**\n${bullets(reasons, 4)}`,
        inline: false,
      },
      {
        name: "🎯 Expected Move",
        value: `\`${estBucket}\`\n**p50 ${p50}**  •  **p90 ${p90}**`,
        inline: true,
      },
      {
        name: "🔥 Catalyst Strength",
        value: `${meter01(catalystStrength)}`,
        inline: true,
      },
      {
        name: "Confidence",
        value: `${confEmoji} ${conf}\n${confidenceMeter(conf)}`,
        inline: true,
      },
      contextLines
        ? { name: "ℹ️ Alert Context", value: contextLines, inline: false }
        : undefined,
      {
        name: "✅ Verification Gates",
        value: verificationLines,
        inline: false,
      },
      {
        name: "📊 Impact Scorecard",
        value: impactLines,
        inline: false,
      },
      {
        name: "Basics",
        value: `cap **${capStr}**  •  px **${pxStr}**`,
        inline: false,
      },
      { name: "Drivers", value: bullets(pros, 6), inline: false },
      { name: "Caveats", value: bullets(cons, 6), inline: false },
    ].filter(Boolean) as any[],
  };

  const riskFields: any[] = [];
  if ((redFlags?.length ?? 0) > 0)
    riskFields.push({
      name: "⚠️ Red Flags",
      value: bullets(redFlags, 6),
      inline: false,
    });
  if ((sources?.length ?? 0) > 0)
    riskFields.push({
      name: "Sources",
      value: sourcesLines(sources, 6),
      inline: false,
    });

  const extrasEmbed =
    riskFields.length > 0
      ? { title: `Risk & Sources — ${symbol}`, color, fields: riskFields }
      : null;

  const components = linkButtonsEnhanced(symbol, canonicalLink, sources);

  const wantsThread = ENABLE_THREADS;
  const thread = wantsThread
    ? {
        name: threadName(symbol, canonicalHeadline, decision, p90Num),
        autoArchiveMinutes: 1440 as 1440,
      }
    : undefined;

  const reactions =
    (cfg as any).DISCORD_ADD_REACTIONS !== false
      ? decision === "PASS"
        ? ["👀", "🧾"]
        : ["👀", "✅", "📈", "🧠"]
      : undefined;

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
    const fmpPressReleases = await fetchFmpPressReleases({ maxPages: 1 });
    const polygonNews = await fetchPolygonReferenceNews({ maxPages: 1 });

    const rawItems = [...fmpPressReleases, ...polygonNews];
    const classified = classify(rawItems);
    const scored = score(classified);
    const passed = scored.filter((it) => it.score >= cfg.ALERT_THRESHOLD);

    log.info("[NEWS] fetched", {
      rawCount: rawItems.length,
      passCount: passed.length,
      concurrency: CONCURRENCY,
    });

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
