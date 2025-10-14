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
};

type Basics = { marketCapUsd?: number; price?: number };

export type LlmOut = {
  basics: Basics;
  est: LlmEstimation | null;
  blurb: string;
  details: string;
  strengthBucket: string;
  confidenceEmoji: string;
  // new extras:
  pros?: string[];
  cons?: string[];
  red_flags?: string[];
  sources?: { title: string; url: string; publishedISO?: string }[];
};

const MODEL = "gpt-5" as const;
const REASONING_EFFORT: "low" | "medium" | "high" = "medium";
const MAX_OUT_TOKENS = 80_000;

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

function sanitizeEstimation(raw: any): {
  est: LlmEstimation | null;
  pros: string[];
  cons: string[];
  red_flags: string[];
  sources: { title: string; url: string; publishedISO?: string }[];
  price?: number;
} {
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
  const okStrArr = (x: any) =>
    Array.isArray(x)
      ? x
          .map((s) => String(s || "").trim())
          .filter(Boolean)
          .slice(0, 8)
      : [];
  const okSources = (xs: any) =>
    Array.isArray(xs)
      ? xs
          .map((s) => ({
            title: String(s?.title || "").slice(0, 160),
            url: typeof s?.url === "string" ? s.url : "",
            publishedISO:
              typeof s?.publishedISO === "string" ? s.publishedISO : undefined,
          }))
          .filter((s) => s.title && s.url)
          .slice(0, 8)
      : [];

  try {
    const em = raw?.est ?? {};
    let p50 = Number(em.p50 ?? 0);
    let p90 = Number(em.p90 ?? 0);
    if (!Number.isFinite(p50)) p50 = 0;
    if (!Number.isFinite(p90)) p90 = p50;
    p50 = Math.max(0, Math.min(1000, p50));
    p90 = Math.max(p50, Math.min(1000, p90));

    const est: LlmEstimation | null = raw?.est
      ? {
          label: String(em.label ?? "OTHER"),
          catalyst_strength: Math.max(
            0,
            Math.min(1, Number(em.catalyst_strength ?? 0))
          ),
          expected_move: {
            p50,
            p90,
            bucket: BUCKETS.includes(em.bucket) ? em.bucket : "<5%",
          },
          confidence:
            em.confidence === "high" || em.confidence === "medium"
              ? em.confidence
              : "low",
          rationale_short: String(em.rationale_short ?? "").slice(0, 240),
          blurb: String(em.blurb ?? "").slice(0, 300),
        }
      : null;

    return {
      est,
      pros: okStrArr(raw?.pros),
      cons: okStrArr(raw?.cons),
      red_flags: okStrArr(raw?.red_flags),
      sources: okSources(raw?.sources),
      price:
        raw?.basics && Number.isFinite(Number(raw?.basics?.price))
          ? Number(raw?.basics?.price)
          : undefined,
    };
  } catch {
    return { est: null, pros: [], cons: [], red_flags: [], sources: [] };
  }
}

/* ---------- Prompts ---------- */
function system_background() {
  return [
    "You are an event-driven equities analyst for micro/OTC names.",
    "You are given ONE canonical press release (headline, link, time, wire). DO NOT replace it.",
    "Use web_search ONLY to gather CONTEXT (older articles, filings, IR pages, analyst notes, sector news) and basic financial facts.",
    "Focus window: 12–24 months history; include last 24 hours if relevant.",
    "",
    "Return STRICT JSON with keys:",
    `{
      "est": {
        "label": "string",
        "catalyst_strength": 0..1,
        "expected_move": { "p50": 0..1000, "p90": 0..1000, "bucket": "<5%"|"5-10%"|"10-20%"|"20-40%"|"40-80%"|"80-150%"|"150-300%"|"300-500%"|"500%+" },
        "confidence": "low"|"medium"|"high",
        "rationale_short": "<=240 chars",
        "blurb": "2-3 sentences, <=300 chars"
      },
      "pros": ["bullet", "..."],
      "cons": ["bullet", "..."],
      "red_flags": ["bullet", "..."],
      "sources": [{"title":"...", "url":"...", "publishedISO":"YYYY-MM-DDTHH:mm:ssZ"}],
      "basics": {"price": number|null}
    }`,
    "",
    "Rules:",
    "- Never suggest a different primary headline/link. Treat given PR as canonical.",
    "- Be concise; avoid fluff; use credible sources only (IR/wires/SEC/Reuters/Bloomberg).",
    "- For micro/OTC, be explicit about financing risk, going-concern language, reverse splits, shelf filings, or serial dilutions if relevant.",
    "- If evidence is weak, keep confidence low and bucket small.",
  ].join("\n");
}

/* ---------- Main ---------- */
export async function runLlmCheck(
  item: ClassifiedItem,
  opts?: {
    canonical?: {
      headline: string;
      url: string;
      publishedAt: string | null;
      wire: string | null;
    };
    maxSources?: number; // default 5
  }
): Promise<LlmOut> {
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

  const canonical = {
    headline: opts?.canonical?.headline ?? item.title ?? "",
    url: opts?.canonical?.url ?? item.url ?? "",
    time_utc: opts?.canonical?.publishedAt ?? item.publishedAt ?? null,
    wire: opts?.canonical?.wire ?? item.source ?? null,
  };

  const payload = {
    ticker: symbol ?? "NA",
    press_release: {
      title: canonical.headline,
      body,
      wire: canonical.wire,
      url: canonical.url,
      time_utc: canonical.time_utc,
    },
    features: {
      marketCapUsd: basics.marketCapUsd ?? null,
      price: basics.price ?? null,
      ruleLabel: String(item.klass ?? "OTHER"),
      ruleScore: Number((item as any).score ?? 0),
    },
  };

  const apiKey = process.env.OPENAI_API_KEY || cfg.OPENAI_API_KEY;
  let modelOut: ReturnType<typeof sanitizeEstimation> | null = null;

  if (apiKey) {
    const client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });

    // One pass: background + estimate (with web_search allowed)
    const resp = await client.responses.create({
      model: MODEL,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      reasoning: { effort: REASONING_EFFORT },
      max_output_tokens: MAX_OUT_TOKENS,
      instructions: system_background(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Canonical press release (do not replace): " +
                JSON.stringify({
                  headline: canonical.headline,
                  url: canonical.url,
                  time_utc: canonical.time_utc,
                  wire: canonical.wire,
                }) +
                "\n\n" +
                "Pipeline payload:\n" +
                JSON.stringify(payload),
            },
          ],
        },
      ],
      metadata: {
        purpose: "background_context_and_estimate",
        ticker: payload.ticker,
      },
    } as any);

    const text = extractOutputText(resp);
    try {
      modelOut = sanitizeEstimation(JSON.parse(text));
    } catch (e) {
      log.warn("[LLM] parse error", e);
      const m = text?.match(/\{[\s\S]*\}$/m);
      if (m) {
        try {
          modelOut = sanitizeEstimation(JSON.parse(m[0]));
        } catch {}
      }
    }
  }

  // Compose final output
  const est = modelOut?.est ?? null;
  const blurb = est?.blurb || "Quick take unavailable.";
  const details = formatDiscordDetail(symbol || "?", basics, est || null);

  const sVal = est?.catalyst_strength ?? 0;
  const sb = strengthToBucket(sVal);
  const strengthBucket = `${sb.emoji} ${sb.name} (${Math.round(sVal * 100)}%)`;
  const confEmoji = confidenceEmoji(est?.confidence);

  // Price if model provided
  if (modelOut?.price != null && Number.isFinite(Number(modelOut.price))) {
    basics.price = Number(modelOut.price);
  }

  return {
    basics,
    est,
    blurb,
    details,
    strengthBucket,
    confidenceEmoji: confEmoji,
    pros: modelOut?.pros ?? [],
    cons: modelOut?.cons ?? [],
    red_flags: modelOut?.red_flags ?? [],
    sources: (modelOut?.sources || []).slice(
      0,
      Math.max(1, Math.min(8, opts?.maxSources ?? 5))
    ),
  };
}
