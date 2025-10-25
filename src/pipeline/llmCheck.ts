// src/pipeline/llmCheck.ts
import { cfg } from "../config.js";
import OpenAI from "openai";
import type { ClassifiedItem } from "../types.js";
import { log } from "../logger.js";
import { fetchMarketCaps } from "../providers/fmp.js";

/* ============================================================
   Types
   ============================================================ */

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

export type ImpactScoreCard = {
  materiality: number; // 0..1
  bindingLevel: number; // 0..1
  counterpartyQuality: number; // 0..1
  specificity: number; // 0..1
  corroboration: number; // 0..1
  executionRisk: number; // 0..1 (higher = lower risk)
  total: number; // weighted sum (see WEIGHTS)
};

export type Decision = "YES" | "SPECULATIVE" | "PASS";

export type LlmOut = {
  basics: Basics;
  est: LlmEstimation | null;
  blurb: string;
  details: string;
  strengthBucket: string;
  confidenceEmoji: string;
  decision: {
    invest: Decision;
    reasons: string[];
    gates: {
      isWire: boolean;
      hasNamedCounterparty: boolean;
      hasQuantDetails: boolean;
      hasIndependentCorroboration: boolean;
      tickerVerified: boolean;
      redFlagsDetected: boolean;
    };
    impact: ImpactScoreCard | null;
  };
  pros?: string[];
  cons?: string[];
  red_flags?: string[];
  sources?: {
    title: string;
    url: string;
    publishedISO?: string;
    publisher?: string;
    trust?: number;
  }[];
  debug?: { search_queries?: string[] };
};

/* ============================================================
   Config & constants
   ============================================================ */

const MODEL = "gpt-5" as const;
const REASONING_EFFORT: "low" | "medium" | "high" = "medium";
const MAX_OUT_TOKENS = 100_000;

// Recognized wires / IR patterns
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
];

// Domain trust hints
const DOMAIN_TRUST_HINTS: Array<[RegExp, number]> = [
  [/(\.|^)sec\.gov$/i, 1],
  [/(\.|^)sedar/i, 0.95],
  [/(\.|^)sam\.gov$/i, 0.95],
  [/(\.|^)usaspending\.gov$/i, 0.95],
  [/(\.|^)canada\.ca$/i, 0.9],
  [/(\.|^)europa\.eu$/i, 0.9],
  [/(\.|^)gov(\.|$)/i, 0.9],
  [/(\.|^)investors?\./i, 0.85],
  [/(\.|^)businesswire\.com$/i, 0.85],
  [/(\.|^)globenewswire\.com$/i, 0.85],
  [/(\.|^)prnewswire\.com$/i, 0.85],
];

/* ============================================================
   Utility helpers
   ============================================================ */

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
function isWirePR(url?: string, text?: string): boolean {
  const t = (text || "").toLowerCase();
  try {
    if (url) {
      const host = new URL(url).hostname.toLowerCase();
      if (WIRE_HOSTS.has(host)) return true;
      if (/^(ir|investors|newsroom)\./i.test(host)) return true;
    }
  } catch {}
  return WIRE_TOKENS.some((tok) => t.includes(tok.toLowerCase()));
}
function hasNamedCounterparty(text: string): boolean {
  return /\b(with|for|from|by|awarded by|contract with)\s+[A-Z][\w&.,’'()-]{2,}(?:\s+[A-Z][\w&.,’'()-]{2,})*/.test(
    text
  );
}
function hasQuantDetails(text: string): boolean {
  return (
    /\$(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s?(million|billion|bn|mm|m|b))?\b/i.test(
      text
    ) ||
    /\b(terms?:|duration|years?|units?|patients?|sites?|clinics?|stores?)\b/i.test(
      text
    ) ||
    /\b\d{2,}\s?(units?|orders?|sites?|clinics?|stores?)\b/i.test(text)
  );
}
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
function marketCapM(item: ClassifiedItem, basics: Basics): number | null {
  const mc = (item as any).marketCap ?? basics.marketCapUsd;
  if (typeof mc === "number" && isFinite(mc)) return mc / 1_000_000;
  return null;
}
function domainTrustHint(url: string | undefined): number | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [rx, score] of DOMAIN_TRUST_HINTS)
      if (rx.test(host)) return score;
  } catch {}
  return null;
}

/* ============================================================
   OTC calibration (applied only after gates pass)
   ============================================================ */

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

function calibrateWithOTCHeuristics(
  item: ClassifiedItem,
  basics: Basics,
  body: string,
  est: LlmEstimation
): LlmEstimation {
  const mcM = marketCapM(item, basics);
  const amtM = extractDollarsMillions(body) ?? 0;
  const isMicro = mcM != null ? mcM < 150 : true;
  const isNano = mcM != null ? mcM < 50 : true;
  const onWire = isWirePR((item as any).url, body);
  const ruleScore = Number((item as any).score ?? 0);
  const label = String(item.klass ?? est.label);

  const ratio = mcM && mcM > 0 ? amtM / mcM : 0;
  const hasProjectFinance =
    RX_PROJECT_FINANCE.test(body) || RX_ROYALTY_STREAM.test(body);
  const hasFullyFunded = RX_FULLY_FUNDED.test(body);
  const hasConstruction = RX_CONSTRUCTION_DECISION.test(body);
  const hasPermit = RX_PERMIT_APPROVAL.test(body);
  const hasProdStart = RX_PRODUCTION_START.test(body);
  const hasOfftake = RX_OFFTAKE.test(body);
  const isNonDilutive = RX_NON_DILUTIVE.test(body);

  let p50Floor = 0,
    p90Floor = 0;
  const add = (f50: number, f90: number) => {
    p50Floor = Math.max(p50Floor, f50);
    p90Floor = Math.max(p90Floor, f90);
  };
  const hiRule = ruleScore >= 0.58;

  switch (label) {
    case "RESTRUCTURING_OR_FINANCING": {
      if (hasProjectFinance) add(25, 70);
      if (hasFullyFunded) add(35, 100);
      if (hasConstruction) add(40, 120);
      if (hasPermit) add(30, 90);
      if (hasOfftake) add(25, 80);
      if (hasProdStart) add(45, 150);
      if (ratio >= 0.5) add(80, 200);
      else if (ratio >= 0.25) add(55, 160);
      else if (ratio >= 0.1) add(40, 110);
      else if (ratio >= 0.05) add(28, 80);
      if (isNano) {
        p50Floor += 12;
        p90Floor += 30;
      } else if (isMicro) {
        p50Floor += 6;
        p90Floor += 18;
      }
      if (onWire && isNonDilutive) {
        p50Floor += 6;
        p90Floor += 10;
      }
      const strongSignals =
        (hasProjectFinance ? 1 : 0) +
        (hasFullyFunded ? 1 : 0) +
        (hasConstruction ? 1 : 0) +
        (hasProdStart ? 1 : 0);
      if (strongSignals >= 2 && est.catalyst_strength < 0.72)
        est.catalyst_strength = 0.72;
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
      if (hiRule && isMicro) add(25, 70);
      break;
  }

  const p50 = Math.max(est.expected_move.p50, p50Floor);
  let p90 = Math.max(est.expected_move.p90, Math.max(p50 + 1, p90Floor));
  p90 = Math.min(1000, p90);
  const bucket = bucketFromP90(p90);

  let confidence = est.confidence;
  if (
    (p50 - est.expected_move.p50 >= 20 || p90 - est.expected_move.p90 >= 50) &&
    confidence === "low"
  )
    confidence = "medium";
  if (
    onWire &&
    (hasFullyFunded || hasConstruction || hasProdStart) &&
    confidence !== "high"
  )
    confidence = "medium";

  return { ...est, expected_move: { p50, p90, bucket }, confidence };
}

/* ============================================================
   Simple blurb fallback
   ============================================================ */

function makeSimpleBlurb(
  item: ClassifiedItem,
  basics: Basics,
  body: string,
  est: LlmEstimation
): string {
  const mcM = marketCapM(item, basics);
  const amtM = extractDollarsMillions(body) ?? 0;
  const ratioPct = mcM && mcM > 0 ? Math.round((amtM / mcM) * 100) : null;
  const bits: string[] = [];
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

  return [line1, line2, line3].join(" ").slice(0, 300);
}

/* ============================================================
   LLM Prompt + JSON Schema (Legitimacy-first, Impact-scored)
   ============================================================ */

function system_background() {
  return [
    "You are an event-driven equities analyst for OTC/micro-cap stocks.",
    "Act as a strict gatekeeper. PASS anything that is vague or unverified.",
    "Use web_search to verify the company/ticker, locate the press release on a credible wire or official IR page, and find independent corroboration (filings, gov portals, partner/customer newsroom).",
    "",
    "Classify binding level:",
    "- 1.00: definitive, priced, paid order, regulatory approval, production start.",
    "- 0.70: definitive but not yet funded/executed, awarded with named counterparty.",
    "- 0.40: LOI/MOU/pilot/POC; 'selected as' without purchase or defined rollout.",
    "- 0.15: intention/partnership discussions/marketing fluff.",
    "",
    "Compute an Impact Scorecard (0..1 each): materiality, bindingLevel, counterpartyQuality, specificity, corroboration, executionRisk (inverse of contingencies).",
    "Weighted total: { materiality:0.28, bindingLevel:0.22, counterpartyQuality:0.18, specificity:0.12, corroboration:0.14, executionRisk:0.06 }.",
    "",
    "Disqualify (gates fail → PASS): not on wire/IR; no named counterparty; no quantitative details; no independent corroboration; red flags (paid promo only, repeated vague PRs, non-binding language only).",
    "",
    "Estimate short-term upside (intraday to few days). For micro-caps, transformational PRs can reach 80–300%+. Ensure p90 > p50.",
    "",
    "STRICT JSON ONLY.",
  ].join("\n");
}

function response_schema() {
  // JSON Schema for Responses API structured outputs (strict)
  return {
    name: "neon_llmcheck_v2",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        est: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            catalyst_strength: { type: "number", minimum: 0, maximum: 1 },
            expected_move: {
              type: "object",
              additionalProperties: false,
              properties: {
                p50: { type: "number", minimum: 0, maximum: 1000 },
                p90: { type: "number", minimum: 0, maximum: 1000 },
                bucket: {
                  type: "string",
                  enum: [
                    "<5%",
                    "5-10%",
                    "10-20%",
                    "20-40%",
                    "40-80%",
                    "80-150%",
                    "150-300%",
                    "300-500%",
                    "500%+",
                  ],
                },
              },
              required: ["p50", "p90", "bucket"],
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            rationale_short: { type: "string", maxLength: 240 },
            blurb: { type: "string", maxLength: 300 },
          },
          required: [
            "label",
            "catalyst_strength",
            "expected_move",
            "confidence",
            "rationale_short",
            "blurb",
          ],
        },
        pros: { type: "array", items: { type: "string" }, maxItems: 8 },
        cons: { type: "array", items: { type: "string" }, maxItems: 8 },
        red_flags: { type: "array", items: { type: "string" }, maxItems: 8 },
        sources: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string", maxLength: 160 },
              url: { type: "string" },
              publishedISO: { type: "string" },
              publisher: { type: "string", maxLength: 80 },
              trust: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["title", "url"],
          },
        },
        basics: {
          type: "object",
          additionalProperties: false,
          properties: { price: { type: ["number", "null"] } },
          required: ["price"],
        },
        decision: {
          type: "object",
          additionalProperties: false,
          properties: {
            invest: { type: "string", enum: ["YES", "SPECULATIVE", "PASS"] },
            reasons: { type: "array", items: { type: "string" }, maxItems: 4 },
            gates: {
              type: "object",
              additionalProperties: false,
              properties: {
                isWire: { type: "boolean" },
                hasNamedCounterparty: { type: "boolean" },
                hasQuantDetails: { type: "boolean" },
                hasIndependentCorroboration: { type: "boolean" },
                tickerVerified: { type: "boolean" },
                redFlagsDetected: { type: "boolean" },
              },
              required: [
                "isWire",
                "hasNamedCounterparty",
                "hasQuantDetails",
                "hasIndependentCorroboration",
                "tickerVerified",
                "redFlagsDetected",
              ],
            },
            impact: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                materiality: { type: "number", minimum: 0, maximum: 1 },
                bindingLevel: { type: "number", minimum: 0, maximum: 1 },
                counterpartyQuality: { type: "number", minimum: 0, maximum: 1 },
                specificity: { type: "number", minimum: 0, maximum: 1 },
                corroboration: { type: "number", minimum: 0, maximum: 1 },
                executionRisk: { type: "number", minimum: 0, maximum: 1 },
                total: { type: "number", minimum: 0, maximum: 1 },
              },
              required: [
                "materiality",
                "bindingLevel",
                "counterpartyQuality",
                "specificity",
                "corroboration",
                "executionRisk",
                "total",
              ],
            },
          },
          required: ["invest", "reasons", "gates", "impact"],
        },
        debug: {
          type: "object",
          additionalProperties: false,
          properties: {
            search_queries: {
              type: "array",
              items: { type: "string" },
              maxItems: 10,
            },
          },
        },
      },
      required: ["est", "pros", "cons", "sources", "basics", "decision"],
    },
  };
}

/* ============================================================
   Main
   ============================================================ */

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

  // ---- Basics
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

  // ---- Canonical press release
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

  // ---- LLM call
  const apiKey = process.env.OPENAI_API_KEY || cfg.OPENAI_API_KEY;
  let modelRaw: any = null;

  if (apiKey) {
    const client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });

    // Built-in web search tool + strict JSON schema output.
    // The Responses API supports hosted tools like `web_search` and parallel tool calls. :contentReference[oaicite:2]{index=2}
    // Structured outputs for Responses should be defined under `text.format` (not `response_format`). :contentReference[oaicite:3]{index=3}
    const resp = await client.responses.create({
      model: MODEL,
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: REASONING_EFFORT },
      max_output_tokens: MAX_OUT_TOKENS,
      instructions: system_background(),
      text: { format: { type: "json_schema", ...response_schema() } },
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Analyze for legitimacy & short-term impact. Only YES/SPECULATIVE if all gates pass.\n\n" +
                "Canonical:\n" +
                JSON.stringify({
                  headline: canonical.headline,
                  url: canonical.url,
                  time_utc: canonical.time_utc,
                  wire: canonical.wire,
                }) +
                "\n\nPayload:\n" +
                JSON.stringify(payload),
            },
          ],
        },
      ],
      metadata: {
        purpose: "otc_move_estimate_legit_gate_v2",
        ticker: payload.ticker,
      },
    } as any);

    const text = extractOutputText(resp);
    try {
      modelRaw = JSON.parse(text);
    } catch (e) {
      log.warn("[LLM] parse error", e);
      const m = text?.match(/\{[\s\S]*\}$/m);
      if (m) {
        try {
          modelRaw = JSON.parse(m[0]);
        } catch {}
      }
    }
  }

  // ---- Fallback (conservative PASS)
  if (!modelRaw) {
    const gates = {
      isWire: isWirePR(canonical.url, body),
      hasNamedCounterparty: hasNamedCounterparty(body),
      hasQuantDetails: hasQuantDetails(body),
      hasIndependentCorroboration: false,
      tickerVerified: Boolean(symbol),
      redFlagsDetected: false,
    };
    const fallbackEst: LlmEstimation = {
      label: String(item.klass ?? "OTHER"),
      catalyst_strength: 0.3,
      expected_move: { p50: 10, p90: 30, bucket: "20-40%" },
      confidence: "low",
      rationale_short: "Insufficient verification. Defaulting to PASS.",
      blurb: "Verification weak; skipping recommendation.",
    };
    const details = formatDiscordDetail(symbol || "?", basics, fallbackEst);
    const sb = strengthToBucket(fallbackEst.catalyst_strength);
    return {
      basics,
      est: null,
      blurb: "Verification weak; skipping.",
      details,
      strengthBucket: `${sb.emoji} ${sb.name} (${Math.round(
        fallbackEst.catalyst_strength * 100
      )}%)`,
      confidenceEmoji: confidenceEmoji("low"),
      pros: [],
      cons: ["No independent corroboration found"],
      red_flags: [],
      sources: [
        {
          title: canonical.headline,
          url: canonical.url,
          publishedISO: String(canonical.time_utc || ""),
          publisher: "",
          trust: domainTrustHint(canonical.url) ?? undefined,
        },
      ],
      decision: {
        invest: "PASS",
        reasons: ["Model parse failure / insufficient data"],
        gates,
        impact: null,
      },
      debug: { search_queries: [] },
    };
  }

  // ---- Sanitize model output
  const norm = sanitizeModelJSON(modelRaw);

  // Recompute/augment gates locally to avoid model hallucinations
  const computedGates = {
    isWire: isWirePR(canonical.url, body) || !!norm.decision?.gates?.isWire,
    hasNamedCounterparty:
      hasNamedCounterparty(body) ||
      !!norm.decision?.gates?.hasNamedCounterparty,
    hasQuantDetails:
      hasQuantDetails(body) || !!norm.decision?.gates?.hasQuantDetails,
    hasIndependentCorroboration:
      !!norm.decision?.gates?.hasIndependentCorroboration,
    tickerVerified: !!norm.decision?.gates?.tickerVerified || Boolean(symbol),
    redFlagsDetected: !!norm.decision?.gates?.redFlagsDetected,
  };

  // If gates fail → force PASS
  const gatesPass =
    computedGates.isWire &&
    computedGates.hasNamedCounterparty &&
    computedGates.hasQuantDetails &&
    computedGates.hasIndependentCorroboration &&
    computedGates.tickerVerified &&
    !computedGates.redFlagsDetected;

  // Apply OTC calibration only if gatesPass
  let est: LlmEstimation | null = gatesPass ? norm.est : null;
  if (gatesPass && est)
    est = calibrateWithOTCHeuristics(item, basics, fullBody, est);

  // Final decision by local rules
  let finalInvest: Decision = "PASS";
  const cs = est?.catalyst_strength ?? 0;
  const conf = est?.confidence ?? "low";
  const p90 = est?.expected_move.p90 ?? 0;
  const impactTotal = norm.impact?.total ?? 0;

  if (gatesPass) {
    if (conf === "high" && cs >= 0.7 && p90 >= 80 && impactTotal >= 0.68)
      finalInvest = "YES";
    else if (
      (conf === "high" || conf === "medium") &&
      cs >= 0.5 &&
      p90 >= 40 &&
      impactTotal >= 0.5
    )
      finalInvest = "SPECULATIVE";
    else finalInvest = "PASS";
  }

  const blurb =
    est && norm.est?.blurb && norm.est.blurb.length >= 30
      ? norm.est.blurb
      : est
      ? makeSimpleBlurb(item, basics, fullBody, est)
      : "Verification or clarity gates failed; skipping.";

  const details = formatDiscordDetail(symbol || "?", basics, est);
  const sVal = est?.catalyst_strength ?? 0;
  const sb = strengthToBucket(sVal);
  const confEmoji = confidenceEmoji(est?.confidence);

  // Price passthrough
  if (norm.price != null && Number.isFinite(Number(norm.price)))
    basics.price = Number(norm.price);

  return {
    basics,
    est,
    blurb,
    details,
    strengthBucket: `${sb.emoji} ${sb.name} (${Math.round(sVal * 100)}%)`,
    confidenceEmoji: confEmoji,
    pros: (norm.pros || []).slice(0, 3),
    cons: (norm.cons || []).slice(0, 1),
    red_flags: (norm.red_flags || []).slice(0, 1),
    sources: (norm.sources || []).slice(
      0,
      Math.max(1, Math.min(8, opts?.maxSources ?? 5))
    ),
    decision: {
      invest: finalInvest,
      reasons:
        finalInvest === "PASS"
          ? [
              ...(gatesPass
                ? ["Upside/strength/confidence below thresholds"]
                : ["One or more verification gates failed"]),
            ]
          : [
              "All verification gates passed",
              `Confidence ${est?.confidence}`,
              `Catalyst strength ${Math.round(
                (est?.catalyst_strength ?? 0) * 100
              )}%`,
              `Near-term p90 ~${Math.round(est?.expected_move.p90 ?? 0)}%`,
              `Impact ${Math.round((impactTotal ?? 0) * 100)}%`,
            ],
      gates: computedGates,
      impact: norm.impact ?? null,
    },
    debug: { search_queries: norm.debug?.search_queries ?? [] },
  };
}

/* ============================================================
   Model output sanitizer
   ============================================================ */

function sanitizeModelJSON(raw: any) {
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
            publisher:
              typeof s?.publisher === "string"
                ? s.publisher.slice(0, 80)
                : undefined,
            trust: Number.isFinite(Number(s?.trust))
              ? Math.max(0, Math.min(1, Number(s?.trust)))
              : undefined,
          }))
          .filter((x) => x.title && x.url)
          .slice(0, 8)
      : [];

  const em = raw?.est?.expected_move ?? {};
  let p50 = parsePctAny(em?.p50);
  let p90 = parsePctAny(em?.p90);
  if (!isFinite(p50)) p50 = 0;
  if (!isFinite(p90)) p90 = p50;
  p50 = Math.max(0, Math.min(1000, p50));
  p90 = Math.max(p50 + 1, Math.min(1000, p90));
  const bucket = (() => {
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
    const b = em?.bucket as MoveBucket;
    return BUCKETS.includes(b) ? b : bucketFromP90(p90);
  })();
  const confRaw = String(raw?.est?.confidence ?? "").toLowerCase();
  const confidence: "low" | "medium" | "high" =
    confRaw === "high" ? "high" : confRaw === "medium" ? "medium" : "low";
  const csNum = Number(raw?.est?.catalyst_strength);
  const catalyst_strength = isFinite(csNum)
    ? Math.max(0, Math.min(1, csNum))
    : 0;

  const est: LlmEstimation = {
    label: String(raw?.est?.label ?? "OTHER"),
    catalyst_strength,
    expected_move: { p50, p90, bucket },
    confidence,
    rationale_short: String(raw?.est?.rationale_short ?? "").slice(0, 240),
    blurb: String(raw?.est?.blurb ?? "").slice(0, 300),
  };

  let price: number | undefined;
  if (raw?.basics?.price != null) {
    const pv = Number(raw.basics.price);
    if (isFinite(pv)) price = pv;
  }

  const decision = {
    invest: (raw?.decision?.invest as Decision) ?? "PASS",
    reasons: arr(raw?.decision?.reasons).slice(0, 4),
    gates: {
      isWire: !!raw?.decision?.gates?.isWire,
      hasNamedCounterparty: !!raw?.decision?.gates?.hasNamedCounterparty,
      hasQuantDetails: !!raw?.decision?.gates?.hasQuantDetails,
      hasIndependentCorroboration:
        !!raw?.decision?.gates?.hasIndependentCorroboration,
      tickerVerified: !!raw?.decision?.gates?.tickerVerified,
      redFlagsDetected: !!raw?.decision?.gates?.redFlagsDetected,
    },
  };

  const clamp01 = (n: any) =>
    Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : 0;
  const weights = {
    materiality: 0.28,
    bindingLevel: 0.22,
    counterpartyQuality: 0.18,
    specificity: 0.12,
    corroboration: 0.14,
    executionRisk: 0.06,
  };
  const impact = raw?.impact
    ? (() => {
        const materiality = clamp01(raw.impact.materiality);
        const bindingLevel = clamp01(raw.impact.bindingLevel);
        const counterpartyQuality = clamp01(raw.impact.counterpartyQuality);
        const specificity = clamp01(raw.impact.specificity);
        const corroboration = clamp01(raw.impact.corroboration);
        const executionRisk = clamp01(raw.impact.executionRisk);
        const total =
          materiality * weights.materiality +
          bindingLevel * weights.bindingLevel +
          counterpartyQuality * weights.counterpartyQuality +
          specificity * weights.specificity +
          corroboration * weights.corroboration +
          executionRisk * weights.executionRisk;
        return {
          materiality,
          bindingLevel,
          counterpartyQuality,
          specificity,
          corroboration,
          executionRisk,
          total: Math.min(1, Math.max(0, total)),
        };
      })()
    : null;

  const sources = srcs(raw?.sources).map((s) => ({
    ...s,
    trust:
      typeof s.trust === "number"
        ? s.trust
        : domainTrustHint(s.url) ?? undefined,
  }));

  return {
    est,
    pros: arr(raw?.pros).slice(0, 3),
    cons: arr(raw?.cons).slice(0, 1),
    red_flags: arr(raw?.red_flags).slice(0, 1),
    sources,
    decision,
    impact,
    price,
    debug: {
      search_queries: Array.isArray(raw?.debug?.search_queries)
        ? raw.debug.search_queries.slice(0, 10)
        : [],
    },
  };
}

/* ============================================================
   Response text extraction helper
   ============================================================ */

function extractOutputText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim())
    return resp.output_text.trim();
  if (Array.isArray(resp?.output)) {
    const texts: string[] = [];
    for (const blk of resp.output) {
      const maybe = (blk as any)?.content;
      if (Array.isArray(maybe)) {
        for (const c of maybe) {
          const t =
            (c as any)?.text ??
            (c as any)?.output_text ??
            (c as any)?.value ??
            "";
          if (typeof t === "string" && t.trim()) texts.push(t);
        }
      }
      const direct = (blk as any)?.text ?? (blk as any)?.output_text;
      if (typeof direct === "string" && direct.trim()) texts.push(direct);
    }
    const joined = texts.join("").trim();
    if (joined) return joined;
  }
  const c0 = (resp as any)?.choices?.[0];
  const legacy =
    c0?.message?.content ??
    c0?.delta?.content ??
    (resp as any)?.message?.content ??
    "";
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  const raw = typeof resp === "string" ? resp : JSON.stringify(resp);
  const fence =
    raw.match(/```json\s*([\s\S]*?)\s*```/i)?.[1] ||
    raw.match(/```\s*([\s\S]*?)\s*```/i)?.[1] ||
    "";
  return (fence || "").trim();
}
