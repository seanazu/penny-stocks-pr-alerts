// src/pipeline/llmCheck.ts
import { cfg } from "../config.js";
import OpenAI from "openai";
import type { ClassifiedItem } from "../types.js";
import { log } from "../logger.js";
import { fetchMarketCaps } from "../providers/fmp.js";

/* ---------- Public types ---------- */
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
  rationale_short: string; // <= 240 chars
  blurb: string; // 2–3 sentences, <= 300 chars
  headline?: string; // best verified headline (if found)
  link?: string; // best verified link (if found)
};

type Basics = { marketCapUsd?: number; price?: number };

const MODEL = "gpt-5" as const;
const REASONING_EFFORT: "low" | "medium" | "high" = "medium";
const MAX_OUT_TOKENS = 80000;

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
  if (!est) return `• ${sym}  • cap ${cap}  • px ${px}`;
  return [
    `• ${sym}  • cap ${cap}  • px ${px}`,
    `• est: ${est.expected_move.bucket}  |  p50 ${humanPct(
      est.expected_move.p50
    )}  |  p90 ${humanPct(est.expected_move.p90)}`,
    `• strength ${Math.round((est.catalyst_strength ?? 0) * 100)}%  |  conf ${
      est.confidence
    }`,
  ].join("\n");
}

/* ---------- LLM plumbing ---------- */
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
    const rationale_short = String(raw.rationale_short ?? "").slice(0, 240);
    const blurb = String(raw.blurb ?? "").slice(0, 300);
    const em = raw.expected_move ?? {};
    let p50 = Number(em.p50 ?? 0);
    let p90 = Number(em.p90 ?? 0);
    if (!Number.isFinite(p50)) p50 = 0;
    if (!Number.isFinite(p90)) p90 = p50;
    p50 = Math.max(0, Math.min(1000, p50));
    p90 = Math.max(p50, Math.min(1000, p90));
    const bucket: MoveBucket = BUCKETS.includes(em.bucket) ? em.bucket : "<5%";
    const headline =
      typeof raw.headline === "string" ? raw.headline.slice(0, 280) : undefined;
    const link = typeof raw.link === "string" ? raw.link : undefined;

    return {
      label,
      catalyst_strength,
      expected_move: { p50, p90, bucket },
      confidence,
      rationale_short,
      blurb,
      headline,
      link,
    };
  } catch {
    return null;
  }
}

function extractOutputText(resp: any): string {
  if (typeof resp?.output_text === "string") return resp.output_text.trim();
  const blocks: any[] = Array.isArray(resp?.output) ? resp.output : [];
  const txt = blocks
    .filter((b: any) => b?.type === "output_text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  return txt || "";
}

/* ---------- Prompts ---------- */
function system_discover(ticker: string) {
  return [
    `You are verifying the latest catalyst for ${ticker}.`,
    `Use web_search to find 1–3 credible items: prioritize issuer IR/wire (PR Newswire, GlobeNewswire, Business Wire, Accesswire, Newsfile), SEC 8-K/6-K, or reputable outlets (Reuters, Bloomberg).`,
    `Prefer items from the last 120 minutes; otherwise within the last 24 hours.`,
    `Return STRICT JSON only: {"candidates":[{"title":"...","url":"...","publisher":"...","publishedISO":"YYYY-MM-DDTHH:mm:ssZ","bodySnippet":"<=600 chars"}]}`,
    `No commentary or extra keys.`,
  ].join("\n");
}

function system_estimate() {
  return [
    "You are an event-driven equities analyst for micro/OTC names.",
    "Mission: estimate the near-term move from the press release.",
    "",
    "Rules:",
    "- Use the verified catalyst (headline/link) if provided; otherwise use the press_release title/body.",
    "- Align move ranges with micro-cap behavior: approvals/definitive M&A/cash-per-share → higher tails; soft updates → modest.",
    "- Consider market cap and price (smaller = more volatile), some can go up more than a thousand percent in one day.",
    "- Be conservative when confidence is low or evidence is weak.",
    "- For mega/large caps, cap the typical move to <20-40% unless exceptional.",
    "",
    "Output STRICT JSON only with exactly these keys:",
    `{"label": "...", "catalyst_strength": 0..1, "expected_move": {"p50":0..1000, "p90":0..1000, "bucket":"<5%"|"5-10%"|"10-20%"|"20-40%"|"40-80%"|"80-150%"|"150-300%"|"300-500%"|"500%+"}, "confidence":"low"|"medium"|"high", "rationale_short":"<=240 chars", "blurb":"2-3 sentences <=300 chars", "headline":"(optional) best headline", "link":"(optional) url"}`,
    "",
    "Sanity:",
    "- p90 >= p50; both are percentages of potential upside today/very near-term.",
    "- If insufficient evidence, set confidence='low' and keep bucket small.",
  ].join("\n");
}

/* ---------- Stages: discover → estimate ---------- */
async function discoverCatalyst(ticker: string): Promise<{
  headline?: string;
  link?: string;
} | null> {
  const apiKey = process.env.OPENAI_API_KEY || cfg.OPENAI_API_KEY;
  if (!apiKey) return null;
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    maxRetries: 3,
  });

  const resp = await client.responses.create({
    model: MODEL,
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: 80000,
    instructions: system_discover(ticker),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `Ticker: ${ticker}\nReturn JSON only.` },
        ],
      },
    ],
    metadata: { purpose: "catalyst_discovery", ticker },
  } as any);
  log.info("[LLM] discover catalyst response", resp);

  const text = extractOutputText(resp);
  let candidates: any[] | undefined;
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      Array.isArray(parsed.candidates) &&
      parsed.candidates.length
    ) {
      candidates = parsed.candidates;
    }
  } catch (error) {
    log.warn("[LLM] discovery parse error", { ticker, text, error });
  }

  if (!candidates?.length) return null;

  // Prefer issuer IR/wire/reuters/bloomberg
  const weight = (url = "", publisher = "") => {
    const host = (() => {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const p = (publisher || "").toLowerCase();
    if (host.startsWith("investor.") || host.startsWith("ir.")) return 5;
    if (
      /(prnewswire|globenewswire|businesswire|accesswire|newsfile)/.test(host)
    )
      return 5;
    if (/(reuters|bloomberg)\./.test(host)) return 4;
    if (/sec\.gov/.test(host)) return 4;
    if (!url) return 0;
    return 1;
  };

  candidates.sort((a, b) => {
    const wa = weight(a.url, a.publisher);
    const wb = weight(b.url, b.publisher);
    if (wb !== wa) return wb - wa;
    const ta = a.publishedISO ? Date.parse(a.publishedISO) : 0;
    const tb = b.publishedISO ? Date.parse(b.publishedISO) : 0;
    return tb - ta;
  });

  const top = candidates[0];
  return { headline: top?.title, link: top?.url };
}

async function estimateMove(
  payload: any,
  verified?: { headline?: string; link?: string } | null
): Promise<LlmEstimation | null> {
  const apiKey = process.env.OPENAI_API_KEY || cfg.OPENAI_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });

  const merged = {
    ...payload,
    verified_headline: verified?.headline ?? null,
    verified_link: verified?.link ?? null,
  };

  const resp = await client.responses.create({
    model: MODEL,
    tools: [{ type: "web_search" }], // allow a quick follow-up check if needed
    tool_choice: "auto",
    reasoning: { effort: REASONING_EFFORT },
    max_output_tokens: MAX_OUT_TOKENS,
    instructions: system_estimate(),
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(merged) }],
      },
    ],
    metadata: {
      purpose: "press_release_move_estimate",
      ticker: payload?.ticker,
    },
  } as any);
  log.info("[LLM] estimate move response", resp);

  const text = extractOutputText(resp);
  try {
    return sanitizeEstimation(JSON.parse(text));
  } catch (e) {
    log.warn("[LLM] estimation parse error", e);

    const m = text?.match(/\{[\s\S]*\}$/m);
    if (m) {
      try {
        return sanitizeEstimation(JSON.parse(m[0]));
      } catch {}
    }
    return null;
  }
}

/* ---------- Public entry ---------- */
export async function runLlmCheck(item: ClassifiedItem): Promise<{
  basics: Basics;
  est: LlmEstimation | null;
  blurb: string;
  details: string;
  strengthBucket: string;
  confidenceEmoji: string;
}> {
  const symbol = item.symbols?.[0];

  // Basics from pipeline / APIs
  const basics: Basics = {
    marketCapUsd:
      typeof (item as any).marketCap === "number"
        ? (item as any).marketCap
        : undefined,
    price: undefined,
  };

  if (!basics.marketCapUsd && symbol) {
    const poly = await fetchMarketCaps([symbol]);
    basics.marketCapUsd = poly.get(symbol);
  }

  // Tighten PR body to save tokens
  const body = (item.summary || "").slice(0, 3000);

  // Build payload (don’t re-detect label; trust your classifier)
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
      ruleScore: Number((item as any).score ?? 0), // 0..1 or 0..100 — your score is a strong prior
    },
  };
  // Stage A: quick web search to confirm the best headline/link
  let verified: { headline?: string; link?: string } | null = null;
  try {
    if (symbol && (process.env.OPENAI_API_KEY || cfg.OPENAI_API_KEY)) {
      verified = await discoverCatalyst(symbol);
    }
  } catch (e) {
    log.warn("[LLM] discovery error", (e as any)?.message || e);
  }

  // Stage B: estimate move using all inputs
  const est = await estimateMove(payload, verified);
  const blurb = est?.blurb || "Quick take unavailable.";
  const details = formatDiscordDetail(symbol || "?", basics, est || null);

  const sVal = est?.catalyst_strength ?? 0;
  const sb = strengthToBucket(sVal);
  const strengthBucket = `${sb.emoji} ${sb.name} (${Math.round(sVal * 100)}%)`;
  const confEmoji = confidenceEmoji(est?.confidence);

  // attach verified headline if the model didn’t set it
  if (est && verified && !est.headline && verified.headline)
    est.headline = verified.headline;
  if (est && verified && !est.link && verified.link) est.link = verified.link;

  return {
    basics,
    est,
    blurb,
    details,
    strengthBucket,
    confidenceEmoji: confEmoji,
  };
}
