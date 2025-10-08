// src/pipeline/llmCheck.ts
import { cfg } from "../config.js";
import OpenAI from "openai";
import type { ClassifiedItem } from "../types.js";
import { log } from "../logger.js";

/* ---------- Buckets ---------- */
export type MoveBucket =
  | "<5%"
  | "5-10%"
  | "10-20%"
  | "20-40%"
  | "40-80%"
  | "80-150%"
  | "150-300%"
  | "300-500%"
  | "500%+";

export type LlmEstimation = {
  label: string;
  catalyst_strength: number; // 0..1
  expected_move: { p50: number; p90: number; bucket: MoveBucket };
  confidence: "low" | "medium" | "high";
  rationale_short: string;
  blurb: string; // 2–3 sentence paragraph
};

type Basics = { marketCapUsd?: number; price?: number };

const POLY_BASE = "https://api.polygon.io";
const FMP_BASE = "https://financialmodelingprep.com";

/* ---------- Display helpers ---------- */
function strengthToBucket(s?: number): { name: string; emoji: string } {
  const x = typeof s === "number" ? Math.max(0, Math.min(1, s)) : 0;
  if (x >= 0.85) return { name: "EXTREME", emoji: "🧨" };
  if (x >= 0.7) return { name: "VERY STRONG", emoji: "🔥" };
  if (x >= 0.5) return { name: "STRONG", emoji: "💥" };
  if (x >= 0.25) return { name: "MODERATE", emoji: "📈" };
  return { name: "WEAK", emoji: "🌤️" };
}
function confidenceEmoji(conf?: string) {
  if (conf === "high") return "🟢";
  if (conf === "medium") return "🟠";
  return "🟡";
}
function humanCap(x?: number) {
  if (!x || x <= 0) return "n/a";
  const b = 1_000_000_000,
    m = 1_000_000;
  return x >= b ? `$${(x / b).toFixed(2)}B` : `$${(x / m).toFixed(1)}M`;
}
function humanPct(x?: number) {
  if (x == null || !isFinite(x)) return "n/a";
  return `${Math.round(x)}%`;
}
function formatDiscordDetail(
  sym: string,
  basics: Basics,
  est: LlmEstimation | null
) {
  const cap = humanCap(basics.marketCapUsd);
  const px =
    basics.price != null ? `$${Number(basics.price).toFixed(2)}` : "n/a";
  if (!est) return `• ${sym} | cap=${cap} | px=${px}`;
  return [
    `• ${sym} | cap=${cap} | px=${px}`,
    `• est: bucket=${est.expected_move.bucket} | p50=${humanPct(
      est.expected_move.p50
    )} | p90=${humanPct(est.expected_move.p90)}`,
    `• strength=${Math.round(est.catalyst_strength * 100)}% | conf=${
      est.confidence
    }`,
  ].join("\n");
}

/* ---------- Data fetchers ---------- */
/** Optional: backfill market cap via Polygon if you still want it */
async function fetchCapPolygon(
  ticker: string,
  apiKey: string
): Promise<{ marketCapUsd?: number }> {
  const out: { marketCapUsd?: number } = {};
  try {
    const ref = await fetch(
      `${POLY_BASE}/v3/reference/tickers/${encodeURIComponent(
        ticker
      )}?apiKey=${apiKey}`
    );
    if (ref.ok) {
      const jr = await ref.json();
      out.marketCapUsd = jr?.results?.market_cap ?? undefined;
    }
  } catch {}
  return out;
}

/** Price via FMP 1-minute historical chart (uses most recent bar's close) */
async function fetchLastPriceFMP(
  ticker: string,
  apiKey: string
): Promise<number | undefined> {
  try {
    const url = `${FMP_BASE}/stable/historical-chart/5min?symbol=${encodeURIComponent(
      ticker
    )}&apikey=${encodeURIComponent(apiKey)}`;
    const r = await fetch(url);
    if (!r.ok) return undefined;
    const arr = await r.json();
    // FMP returns newest-first array like: [{ date, open, low, high, close, volume }, ...]
    if (Array.isArray(arr) && arr.length) {
      const close = Number(arr[0]?.close);
      return Number.isFinite(close) ? close : undefined;
    }
  } catch {}
  return undefined;
}

/* ---------- LLM response sanitize ---------- */
function sanitizeEstimation(raw: any): LlmEstimation | null {
  const BUCKETS: MoveBucket[] = [
    "<5%",
    "5-10%",
    "10-20%",
    "20-40%",
    "40-80%",
    "80-150%",
    "150-300%",
    "300-500%",
    "500%+",
  ];
  try {
    if (!raw || typeof raw !== "object") return null;
    const label = String(raw.label ?? "OTHER");
    const catalyst_strength = Math.max(
      0,
      Math.min(1, Number(raw.catalyst_strength ?? 0))
    );
    const confidence: "low" | "medium" | "high" =
      raw.confidence === "high" || raw.confidence === "medium"
        ? raw.confidence
        : "low";
    const rationale_short = String(raw.rationale_short ?? "");
    const blurb = String(raw.blurb ?? "").slice(0, 600);

    const em = raw.expected_move ?? {};
    let p50 = Number(em.p50 ?? 0);
    let p90 = Number(em.p90 ?? 0);
    if (!Number.isFinite(p50)) p50 = 0;
    if (!Number.isFinite(p90)) p90 = p50;
    p50 = Math.max(0, Math.min(1000, p50));
    p90 = Math.max(p50, Math.min(1000, p90));
    const bucket: MoveBucket = BUCKETS.includes(em.bucket) ? em.bucket : "<5%";

    return {
      label,
      catalyst_strength,
      expected_move: { p50, p90, bucket },
      confidence,
      rationale_short,
      blurb,
    };
  } catch {
    return null;
  }
}

/* ---------- Prompts for Responses API ---------- */
function buildPrompts(payload: any) {
  const system = `
You are an event-driven equities analyst embedded inside an automated trading server.
The server ingests real-time press releases and a rules-based pipeline already classified
each item (event label + score). Your role is NOT to re-detect catalysts, but to estimate
the likely price impact and provide a concise explanation.

Constraints:
- Output STRICT JSON only. No prose outside JSON.
- Use ONLY provided features (do not invent market cap/price).
- Your output triggers Discord alerts; bad formatting breaks the system.
`.trim();

  const user = `
Analyze the payload and return STRICT JSON with this shape:

{
  "label": <one of ["PIVOTAL_TRIAL_SUCCESS","FDA_MARKETING_AUTH","FDA_ADCOM_POSITIVE","REGULATORY_DESIGNATION",
                    "TIER1_PARTNERSHIP","MAJOR_GOV_CONTRACT","GOVERNMENT_EQUITY_OR_GRANT","ACQUISITION_BUYOUT",
                    "IPO_DEBUT_POP","COURT_WIN_INJUNCTION","MEME_OR_INFLUENCER","RESTRUCTURING_OR_FINANCING",
                    "POLICY_OR_POLITICS_TAILWIND","EARNINGS_BEAT_OR_GUIDE_UP","INDEX_INCLUSION","UPLISTING_TO_NASDAQ","OTHER"]>,
  "catalyst_strength": <0..1>,
  "expected_move": {
    "p50": <percent 0..1000>,
    "p90": <percent 0..1000, >= p50>,
    "bucket": "<5%"|"5-10%"|"10-20%"|"20-40%"|"40-80%"|"80-150%"|"150-300%"|"300-500%"|"500%+"
  },
  "confidence": "low"|"medium"|"high",
  "rationale_short": <string <= 240 chars>,
  "blurb": <2-3 sentences (<= 300 chars) summarizing why this PR could move the stock; avoid hype>
}

Guidance:
- If features are missing, set "confidence":"low" and keep moves modest.
- Small-cap / low-float contexts with definitive language (e.g., “definitive agreement”, per-share cash)
  can justify extreme tails (150%+). Reserve 300-500% and 500%+ for rare, transformational micro-caps.
- For large/mega-caps, strong catalysts usually fall in <5% to 20-40%.
- Align catalyst_strength with event materiality (approvals/definitive M&A > process updates).

Payload:
${JSON.stringify(payload)}
`.trim();

  return { system, user };
}

/* ---------- OpenAI Responses API (exact call shape) ---------- */
async function callOpenAI(payload: any): Promise<LlmEstimation | null> {
  const apiKey = process.env.OPENAI_API_KEY || cfg.OPENAI_API_KEY;
  if (!apiKey) return null;

  const openai = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });

  const { system, user } = buildPrompts(payload);

  const first = await openai.responses.create({
    model: "gpt-5",
    instructions: system,
    input: user,
  });

  const text =
    (first as any).output_text ??
    ((Array.isArray((first as any).output) &&
      (first as any).output[0]?.content?.[0]?.text) ||
      null);

  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return sanitizeEstimation(parsed);
  } catch {
    const m = text.match(/\{[\s\S]*\}$/m);
    if (m) {
      try {
        return sanitizeEstimation(JSON.parse(m[0]));
      } catch {}
    }
    return null;
  }
}

/* ---------- Public entry: run AFTER classifier+score passed ---------- */
export async function runLlmCheck(item: ClassifiedItem): Promise<{
  basics: Basics;
  est: LlmEstimation | null;
  blurb: string;
  details: string;
  strengthBucket: string;
  confidenceEmoji: string;
}> {
  const symbol = item.symbols?.[0];

  // Prefer the classifier-provided marketCap when present
  const basics: Basics = {
    marketCapUsd:
      typeof (item as any).marketCap === "number"
        ? (item as any).marketCap
        : undefined,
    price: undefined,
  };

  // Fill price from FMP 1-min endpoint (plan-supported)
  if (cfg.FMP_API_KEY && symbol) {
    const lastPx = await fetchLastPriceFMP(symbol, cfg.FMP_API_KEY);
    if (lastPx != null) basics.price = lastPx;
  }

  // Optional: backfill cap via Polygon if you want (and not already present)
  if (!basics.marketCapUsd && cfg.POLYGON_API_KEY && symbol) {
    const poly = await fetchCapPolygon(symbol, cfg.POLYGON_API_KEY);
    basics.marketCapUsd = poly.marketCapUsd ?? basics.marketCapUsd;
  }
  // Keep PR body tight to save tokens
  const body = (item.summary || "").slice(0, 6000);

  // Payload to LLM: we DO NOT re-detect catalysts; we pass your outputs
  const payload = {
    ticker: symbol ?? "NA",
    press_release: {
      title: item.title ?? "",
      body,
      wire: item.source ?? null,
      url: item.url ?? null,
      time_utc: item.publishedAt ?? null,
    },
    features: {
      marketCapUsd: basics.marketCapUsd ?? null,
      price: basics.price ?? null,
      ruleLabel: String(item.klass ?? "OTHER"),
      ruleScore: Number((item as any).score ?? 0),
    },
  };

  const est = await callOpenAI(payload);
  const blurb = est?.blurb || "Quick take unavailable.";
  const details = formatDiscordDetail(symbol || "?", basics, est || null);

  const sVal = est?.catalyst_strength ?? 0;
  const sb = strengthToBucket(sVal);
  const strengthBucket = `${sb.emoji} ${sb.name} (${Math.round(sVal * 100)}%)`;
  const confEmoji = confidenceEmoji(est?.confidence);

  return {
    basics,
    est,
    blurb,
    details,
    strengthBucket,
    confidenceEmoji: confEmoji,
  };
}
