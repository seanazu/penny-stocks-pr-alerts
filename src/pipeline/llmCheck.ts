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
  // extras:
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

/* ---------- Shared parsing helpers ---------- */
function extractOutputText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text.trim();
  }
  if (Array.isArray(resp?.output)) {
    const texts: string[] = [];
    for (const blk of resp.output) {
      const maybeContent = blk?.content;
      if (Array.isArray(maybeContent)) {
        for (const c of maybeContent) {
          const t = c?.text ?? c?.output_text ?? c?.value ?? "";
          if (typeof t === "string" && t.trim()) texts.push(t);
        }
      }
      const direct = blk?.text ?? blk?.output_text;
      if (typeof direct === "string" && direct.trim()) texts.push(direct);
    }
    const joined = texts.join("").trim();
    if (joined) return joined;
  }
  const choice0 = resp?.choices?.[0];
  const legacyText =
    choice0?.message?.content ??
    choice0?.delta?.content ??
    resp?.message?.content ??
    "";
  if (typeof legacyText === "string" && legacyText.trim()) {
    return legacyText.trim();
  }
  const raw = typeof resp === "string" ? resp : JSON.stringify(resp);
  const fence =
    raw.match(/```json\s*([\s\S]*?)\s*```/i)?.[1] ||
    raw.match(/```\s*([\s\S]*?)\s*```/i)?.[1] ||
    "";
  return (fence || "").trim();
}

function parsePctAny(x: any): number {
  if (x == null) return NaN;
  if (typeof x === "number") return x <= 1 ? x * 100 : x;
  const s = String(x).trim();
  if (!s) return NaN;
  const hasPct = /%$/.test(s);
  const n = parseFloat(s.replace("%", ""));
  if (!isFinite(n)) return NaN;
  return hasPct ? n : n <= 1 ? n * 100 : n;
}
function bucketFromP90(p90: number): MoveBucket {
  if (p90 >= 500) return "500%+";
  if (p90 >= 300) return "300-500%";
  if (p90 >= 150) return "150-300%";
  if (p90 >= 80) return "80-150%";
  if (p90 >= 40) return "40-80%";
  if (p90 >= 20) return "20-40%";
  if (p90 >= 10) return "10-20%";
  if (p90 >= 5) return "5-10%";
  return "<5%";
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
  const arr = (xs: any) =>
    Array.isArray(xs)
      ? xs
          .map((s) => String(s ?? "").trim())
          .filter(Boolean)
          .slice(0, 8)
      : [];
  const srcs = (xs: any) =>
    Array.isArray(xs)
      ? xs
          .map((s) => ({
            title: String(s?.title ?? "").slice(0, 160),
            url: typeof s?.url === "string" ? s.url : "",
            publishedISO:
              typeof s?.publishedISO === "string" ? s.publishedISO : undefined,
          }))
          .filter((x) => x.title && x.url)
          .slice(0, 8)
      : [];

  const node =
    raw?.est && (raw.est.expected_move || raw.est.expectedMove) ? raw.est : raw;

  const em = node?.expected_move ?? node?.expectedMove ?? {};
  let p50 = parsePctAny(em?.p50);
  let p90 = parsePctAny(em?.p90);

  if (!isFinite(p50)) p50 = 0;
  if (!isFinite(p90)) p90 = p50;

  p50 = Math.max(0, Math.min(1000, p50));
  p90 = Math.max(p50, Math.min(1000, p90));

  const bucket: MoveBucket = (() => {
    const b = em?.bucket as MoveBucket;
    return BUCKETS.includes(b) ? b : bucketFromP90(p90);
  })();

  if (p90 === p50) {
    const epsMap: Record<MoveBucket, number> = {
      "<5%": 0.5,
      "5-10%": 1,
      "10-20%": 1.5,
      "20-40%": 2,
      "40-80%": 3,
      "80-150%": 4,
      "150-300%": 5,
      "300-500%": 6,
      "500%+": 8,
    };
    p90 = Math.min(1000, p50 + (epsMap[bucket] ?? 2));
  }

  const confRaw = String(node?.confidence ?? "").toLowerCase();
  const confidence: "low" | "medium" | "high" =
    confRaw === "high" ? "high" : confRaw === "medium" ? "medium" : "low";

  const csNum = Number(node?.catalyst_strength);
  const catalyst_strength = isFinite(csNum)
    ? Math.max(0, Math.min(1, csNum))
    : 0;

  const est: LlmEstimation = {
    label: String(node?.label ?? "OTHER"),
    catalyst_strength,
    expected_move: { p50, p90, bucket },
    confidence,
    rationale_short: String(node?.rationale_short ?? "").slice(0, 240),
    blurb: String(node?.blurb ?? "").slice(0, 300),
  };

  let price: number | undefined;
  const basicsAny = raw?.basics ?? node?.basics;
  if (basicsAny?.price != null) {
    const pv = Number(basicsAny.price);
    if (isFinite(pv)) price = pv;
  }

  // Keep it tight: max 3 pros, 1 con, 0–1 red_flag (user asked to avoid risk lecture)
  const pros = arr(raw?.pros ?? node?.pros).slice(0, 3);
  const cons = arr(raw?.cons ?? node?.cons).slice(0, 1);
  const red_flags = arr(raw?.red_flags ?? node?.red_flags).slice(0, 1);

  return {
    est,
    pros,
    cons,
    red_flags,
    sources: srcs(raw?.sources ?? node?.sources),
    price,
  };
}

/* ---------- OTC heuristics & text helpers ---------- */
// Wire detection (same logic as in other modules)
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
const WIRE_TOKENS = [
  "PR Newswire",
  "GlobeNewswire",
  "Business Wire",
  "ACCESSWIRE",
  "Newsfile",
  "MCAP MediaWire",
  "PRISM MediaWire",
  "MCAP",
  "PRISM",
];
function isWirePR(url?: string, text?: string): boolean {
  const t = (text || "").toLowerCase();
  try {
    if (url) {
      const host = new URL(url).hostname.toLowerCase();
      if (WIRE_HOSTS.has(host)) return true;
      if (/^(ir|investors)\./i.test(host)) return true;
    }
  } catch {}
  return WIRE_TOKENS.some((tok) => t.includes(tok.toLowerCase()));
}

// Dollar extraction (M → number)
function extractDollarsMillions(x: string): number | null {
  const mm = x.match(
    /\$?\s?(\d{1,3}(?:\.\d+)?)\s*(million|billion|bn|mm|m|b)\b/i
  );
  if (mm) {
    const val = parseFloat(mm[1]);
    const unit = mm[2].toLowerCase();
    if (unit === "b" || unit === "billion" || unit === "bn") return val * 1000;
    return val;
  }
  const raw = x.match(/\$\s?(\d{6,12})(?!\.)\b/);
  if (raw) return parseInt(raw[1], 10) / 1_000_000;
  return null;
}
function mcMillionsFrom(item: ClassifiedItem, basics: Basics): number | null {
  const mc = (item as any).marketCap ?? basics.marketCapUsd;
  if (typeof mc === "number" && isFinite(mc)) return mc / 1_000_000;
  return null;
}

// OTC mining/resources & micro-cap triggers
const RX_FULLY_FUNDED =
  /\b(fully[-\s]?fund(?:ed|s|ing)|funds?\s+(?:the\s+)?capex)\b/i;
const RX_PROJECT_FINANCE =
  /\b(secures?|obtains?|arranges?|closes?|executes?|signs?)\b[^.]{0,60}\b(gold loan|loan|credit facility|project financing|project finance|debt financing|term loan|royalty(?:\s+financing)?|stream(?:ing)? (?:deal|agreement)|non[- ]dilutive (?:financing|funding))\b/i;
const RX_CONSTRUCTION_DECISION =
  /\b(board of directors )?approv(?:es|ed)\b[^.]{0,80}\b(construction|final investment decision|FID|go[- ]ahead|build)\b/i;
const RX_PRODUCTION_START =
  /\b(commenc(?:es|ed|ing)|begin(?:s|ning)|starts?|started)\b[^.]{0,80}\b(production|processing|mining|operations?|heap[- ]?leach)\b/i;
const RX_PERMIT_APPROVAL =
  /\b(permit|licen[cs]e|environmental|concession)\b[^.]{0,60}\b(approved|granted|received|obtained|issued)\b/i;
const RX_ROYALTY_STREAM =
  /\b(royalty|stream(?:ing)?)\b[^.]{0,60}\b(agreement|financing|facility|transaction|deal)\b/i;
const RX_OFFTAKE =
  /\b(off[- ]?take|offtake)\b[^.]{0,40}\b(agreement|contract|MOU|memorandum)\b/i;
const RX_NON_DILUTIVE =
  /\b(non[- ]dilutive|no (?:warrants?|reverse split)|without (?:warrants|a reverse split))\b/i;

/** Calibrate p50/p90 upward for OTC if setup warrants it */
function calibrateWithOTCHeuristics(
  item: ClassifiedItem,
  basics: Basics,
  body: string,
  est: LlmEstimation
): LlmEstimation {
  const mcM = mcMillionsFrom(item, basics);
  const amtM = extractDollarsMillions(body) ?? 0;
  const isMicro = mcM != null ? mcM < 150 : true; // assume micro if unknown
  const isNano = mcM != null ? mcM < 50 : true;
  const onWire = isWirePR((item as any).url, body);
  const ruleScore = Number((item as any).score ?? 0);
  const label = String(item.klass ?? est.label);

  // Relative size ratio
  const ratio = mcM && mcM > 0 ? amtM / mcM : 0;

  // Detect key OTC “blast-off” conditions
  const hasProjectFinance =
    RX_PROJECT_FINANCE.test(body) || RX_ROYALTY_STREAM.test(body);
  const hasFullyFunded = RX_FULLY_FUNDED.test(body);
  const hasConstruction = RX_CONSTRUCTION_DECISION.test(body);
  const hasPermit = RX_PERMIT_APPROVAL.test(body);
  const hasProdStart = RX_PRODUCTION_START.test(body);
  const hasOfftake = RX_OFFTAKE.test(body);
  const isNonDilutive = RX_NON_DILUTIVE.test(body);

  // Build a heuristic floor for high-impact OTC catalysts
  let p50Floor = 0;
  let p90Floor = 0;
  const add = (f50: number, f90: number) => {
    p50Floor = Math.max(p50Floor, f50);
    p90Floor = Math.max(p90Floor, f90);
  };

  // Label-based baselines (micro-friendly)
  const hiRule = ruleScore >= 0.58; // your scorer already OTC-weighted
  switch (label) {
    case "RESTRUCTURING_OR_FINANCING": {
      // Transformational path (finance → fully funded capex → construction/permit → ops)
      if (hasProjectFinance) add(25, 70);
      if (hasFullyFunded) add(35, 100);
      if (hasConstruction) add(40, 120);
      if (hasPermit) add(30, 90);
      if (hasOfftake) add(25, 80);
      if (hasProdStart) add(45, 150);

      // Relative materiality vs. market cap
      if (ratio >= 0.5) add(80, 200);
      else if (ratio >= 0.25) add(55, 160);
      else if (ratio >= 0.1) add(40, 110);
      else if (ratio >= 0.05) add(28, 80);

      // Micro tiers
      if (isNano) {
        p50Floor += 12;
        p90Floor += 30;
      } else if (isMicro) {
        p50Floor += 6;
        p90Floor += 18;
      }

      // Wire + non-dilutive language
      if (onWire && isNonDilutive) {
        p50Floor += 6;
        p90Floor += 10;
      }

      // Confidence nudge if multiple strong signals
      const strongSignals =
        (hasProjectFinance ? 1 : 0) +
        (hasFullyFunded ? 1 : 0) +
        (hasConstruction ? 1 : 0) +
        (hasProdStart ? 1 : 0);
      if (strongSignals >= 2 && est.catalyst_strength < 0.72) {
        est.catalyst_strength = 0.72;
      }
      break;
    }
    case "ACQUISITION_BUYOUT":
      if (hiRule) add(45, 120);
      if (isNano) add(10, 30);
      break;
    case "CE_REMOVAL_OR_RESUME_TRADING":
      add(60, 180);
      if (isNano) add(10, 40);
      break;
    case "INSIDER_BUY_CLUSTER":
    case "TOXIC_FINANCING_TERMINATED":
    case "DILUTION_FREE_INVESTMENT":
      if (hiRule) add(35, 100);
      break;
    case "MAJOR_GOV_CONTRACT":
    case "GOVERNMENT_EQUITY_OR_GRANT":
      if (hiRule) add(40, 120);
      if (ratio >= 0.1) add(50, 150);
      break;
    case "LARGE_ORDER_RELATIVE":
    case "DISTRIBUTION_AGREEMENT_MATERIAL":
      if (ratio >= 0.25) add(50, 140);
      else if (ratio >= 0.1) add(35, 100);
      else add(25, 70);
      break;
    case "PIVOTAL_TRIAL_SUCCESS":
    case "FDA_MARKETING_AUTH":
    case "FDA_ADCOM_POSITIVE":
      add(45, 140);
      if (isNano) add(10, 30);
      break;
    default:
      // Generic micro-cap uplift when score strong
      if (hiRule && isMicro) add(25, 70);
      break;
  }

  // Enforce floors if the model under-called
  const p50 = Math.max(est.expected_move.p50, p50Floor);
  const p90 = Math.max(est.expected_move.p90, Math.max(p50, p90Floor));
  const bucket = bucketFromP90(p90);

  // Confidence tuning: if we had to lift a lot (model sandbagged), set at least medium
  let confidence = est.confidence;
  if (
    (p50 - est.expected_move.p50 >= 20 || p90 - est.expected_move.p90 >= 50) &&
    confidence === "low"
  ) {
    confidence = "medium";
  }
  if (
    onWire &&
    (hasFullyFunded || hasConstruction || hasProdStart) &&
    confidence !== "high"
  ) {
    confidence = "medium";
  }

  return {
    ...est,
    expected_move: { p50, p90, bucket },
    confidence,
  };
}

/** Make a simple, punchy blurb if model gave us fluff or nothing */
function makeSimpleBlurb(
  item: ClassifiedItem,
  basics: Basics,
  body: string,
  est: LlmEstimation
): string {
  const mcM = mcMillionsFrom(item, basics);
  const amtM = extractDollarsMillions(body) ?? 0;
  const ratioPct = mcM && mcM > 0 ? Math.round((amtM / mcM) * 100) : null;
  const bits: string[] = [];

  // Prefer explaining *why* in plain words
  if (RX_PROJECT_FINANCE.test(body)) bits.push("secured project financing");
  if (RX_FULLY_FUNDED.test(body)) bits.push("now fully funded");
  if (RX_CONSTRUCTION_DECISION.test(body)) bits.push("construction approved");
  if (RX_PERMIT_APPROVAL.test(body)) bits.push("key permits granted");
  if (RX_OFFTAKE.test(body)) bits.push("offtake in place");
  if (RX_PRODUCTION_START.test(body)) bits.push("operations starting");

  const reasons = bits.length
    ? bits.slice(0, 3).join(", ")
    : "a material catalyst for a small-cap";

  const capTxt =
    basics.marketCapUsd && basics.marketCapUsd > 0
      ? `${humanCap(basics.marketCapUsd)} cap`
      : "micro-cap";

  const ratioTxt =
    ratioPct != null && isFinite(ratioPct) && ratioPct > 0
      ? ` (~${ratioPct}% of mkt cap)`
      : "";

  const p90Txt = Math.round(est.expected_move.p90);

  const line1 = `This is ${capTxt}: ${reasons}.`;
  const line2 =
    amtM > 0
      ? `The deal size is ~$${amtM.toFixed(
          0
        )}M${ratioTxt}, which can trigger a sharp re-rating.`
      : `For OTC names, setups like this can re-rate fast.`;
  const line3 = `Near-term move could be big (p90 ~${p90Txt}%).`;

  const blurb = [line1, line2, line3].join(" ");
  return blurb.slice(0, 300);
}

/* ---------- Prompt (OTC-calibrated) ---------- */
function system_background() {
  return [
    "You are an event-driven equities analyst focused on OTC/micro-cap stocks.",
    "You will receive ONE canonical press release (headline/link/time/wire) and some pipeline metadata (market cap, rule label/score).",
    "Your job: estimate short-term upside potential for a single-day/very-near-term move. OTC names can move 80–300% or more on truly transformational PRs.",
    "",
    "Calibration rules:",
    "- Use micro-cap context: if market cap < $150M (or unknown), do NOT cap upside conservatively. P50 can be 40–100% and P90 can be 150–300%+ for high-impact PRs.",
    "- Consider relative materiality: if the dollar size in the PR is >=10% / >=25% / >=50% of market cap, scale your p50/p90 materially upward.",
    "- Transformational patterns for big moves: fully funded capex; project/debt facilities; royalty/stream; offtake; board-approved construction (FID); key permits; production start; CE removal; definitive/priced M&A; large government contracts; material distribution orders.",
    "- Do not write long risk sections. One short caveat is enough. Be concrete and simple.",
    "",
    "Output strictly in JSON with this shape:",
    `{
      "est": {
        "label": "string",
        "catalyst_strength": 0..1,
        "expected_move": { "p50": 0..1000, "p90": 0..1000, "bucket": "<5%"|"5-10%"|"10-20%"|"20-40%"|"40-80%"|"80-150%"|"150-300%"|"300-500%"|"500%+" },
        "confidence": "low"|"medium"|"high",
        "rationale_short": "<=240 chars, plain words why it could jump",
        "blurb": "2–3 short sentences, <=300 chars, simple English"
      },
      "pros": ["<=3 bullets, terse"],
      "cons": ["<=1 short caveat"],
      "red_flags": ["<=1, optional"],
      "sources": [{"title":"...", "url":"...", "publishedISO":"YYYY-MM-DDTHH:mm:ssZ"}],
      "basics": {"price": number|null}
    }`,
    "",
    "Scoring hints:",
    "- If PR says 'fully fund capex' or 'construction approved' for a <$150M name, P50 often >=40% and P90 can be >=150%.",
    "- If amount ~25–50%+ of mkt cap, lift P50 and P90 accordingly.",
    "- Wire-hosted PRs and specific numbers increase confidence.",
    "- Keep wording tight and useful for a trader.",
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
  const fullBody = (item.summary || (item as any).text || "").trim();
  const body = fullBody.slice(0, 4000);

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
        purpose: "otc_move_estimate",
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

  // If no model output, synthesize a minimal frame
  if (!modelOut) {
    modelOut = sanitizeEstimation({
      est: {
        label: String(item.klass ?? "OTHER"),
        catalyst_strength: Number((item as any).score ?? 0.5),
        expected_move: { p50: 20, p90: 60, bucket: "40-80%" },
        confidence: "low",
        rationale_short: "Material PR for a micro-cap can re-rate quickly.",
        blurb: "",
      },
      pros: [],
      cons: [],
      red_flags: [],
      sources: [
        {
          title: canonical.headline,
          url: canonical.url,
          publishedISO: String(canonical.time_utc || ""),
        },
      ],
      basics: { price: null },
    });
  }

  // OTC calibration (prevents under-calling)
  let est = calibrateWithOTCHeuristics(
    item,
    basics,
    fullBody,
    modelOut.est ?? {
      label: String(item.klass ?? "OTHER"),
      catalyst_strength: Number((item as any).score ?? 0.5),
      expected_move: { p50: 20, p90: 60, bucket: "40-80%" },
      confidence: "low",
      rationale_short: "Material PR for a micro-cap can re-rate quickly.",
      blurb: "",
    }
  );

  // Simple, punchy blurb if missing or too generic
  const blurb =
    est.blurb && est.blurb.length >= 30
      ? est.blurb
      : makeSimpleBlurb(item, basics, fullBody, est);

  // Compose details for Discord
  const details = formatDiscordDetail(symbol || "?", basics, est || null);

  // Strength bucket & emoji
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
    pros: (modelOut?.pros || []).slice(0, 3),
    cons: (modelOut?.cons || []).slice(0, 1),
    red_flags: (modelOut?.red_flags || []).slice(0, 1),
    sources: (modelOut?.sources || []).slice(
      0,
      Math.max(1, Math.min(8, opts?.maxSources ?? 5))
    ),
  };
}
