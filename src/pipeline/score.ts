// src/pipeline/score.ts
import type { ClassifiedItem } from "../types.js";

/** Baseline impact by classified event (higher = more likely to cause large pops). */
const BASELINE: Record<string, number> = {
  // Core
  PIVOTAL_TRIAL_SUCCESS: 0.74,
  FDA_MARKETING_AUTH: 0.72,
  FDA_ADCOM_POSITIVE: 0.68,
  REGULATORY_DESIGNATION: 0.54,
  TIER1_PARTNERSHIP: 0.62,
  MAJOR_GOV_CONTRACT: 0.62,
  GOVERNMENT_EQUITY_OR_GRANT: 0.61,
  ACQUISITION_BUYOUT: 0.66,
  IPO_DEBUT_POP: 0.56,
  COURT_WIN_INJUNCTION: 0.56,
  MEME_OR_INFLUENCER: 0.5,
  // ⭐ OTC-weighted: financing/build/production deserve more than generic earnings
  RESTRUCTURING_OR_FINANCING: 0.6,
  POLICY_OR_POLITICS_TAILWIND: 0.44,
  EARNINGS_BEAT_OR_GUIDE_UP: 0.52,
  INDEX_INCLUSION: 0.5,
  UPLISTING_TO_NASDAQ: 0.48,

  // Micro/OTC labels
  REVERSE_SPLIT_UPLIST_PATH: 0.58,
  CE_REMOVAL_OR_RESUME_TRADING: 0.67,
  GOING_CONCERN_REMOVED: 0.56,
  INSIDER_BUY_CLUSTER: 0.6,
  TOXIC_FINANCING_TERMINATED: 0.64,
  AUTHORIZED_SHARES_REDUCED: 0.56,
  DILUTION_FREE_INVESTMENT: 0.6,
  LARGE_ORDER_RELATIVE: 0.57,
  DISTRIBUTION_AGREEMENT_MATERIAL: 0.6,
  CRYPTO_OR_AI_TREASURY_PIVOT: 0.55,
  CUSTODIANSHIP_OR_RM_DEAL: 0.6,
  AUDIT_COMPLETED_FILINGS_CURED: 0.56,

  OTHER: 0.2,
};

/* --- Lightweight cues --- */
const LARGE_DOLLAR_AMOUNT =
  /\$?\s?(?:\d{2,4})\s*(?:million|billion|bn|mm|m)\b/i;
const SUPERLATIVE_WORDS =
  /\b(record|unprecedented|all-time|exclusive|breakthrough|pivotal)\b/i;
const BIG_MOVE_WORDS = /\b(double|doubled|triple|tripled)\b/i;

/** Wire gating */
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

/** Hardened low-impact guards (noise) */
const RX_PROXY_ADVISOR =
  /\b(ISS|Institutional Shareholder Services|Glass Lewis)\b.*\b(recommend(s|ed)?|support(s|ed)?)\b.*\b(vote|proposal|deal|merger)\b/i;
const RX_VOTE_ADMIN_ONLY =
  /\b(definitive proxy|proxy (statement|materials)|special meeting|annual meeting|extraordinary general meeting|EGM|shareholder vote|record date)\b/i;
const RX_LAWFIRM =
  /\b(class action|securities class action|investor (?:lawsuit|alert|reminder)|deadline alert|shareholder rights law firm|securities litigation|investigat(?:ion|ing)|Hagens Berman|Pomerantz|Rosen Law Firm|Glancy Prongay|Bronstein[, ]+Gewirtz|Kahn Swick|Saxena White|Kessler Topaz|Levi & Korsinsky)\b/i;
const RX_SECURITY_UPDATE =
  /\b(cyber(?:security)?|security|ransomware|data (?:breach|exposure)|cyber[- ]?attack)\b.*\b(update|updated|provid(?:e|es)d? an? update)\b/i;
const RX_INVESTOR_CONFS =
  /\b(participat(e|es|ing)|to participate|will participate)\b.*\b(investor (?:conference|conferences)|conference|fireside chat|non-deal roadshow)\b/i;
const RX_AWARDS =
  /\b(award|awards|winner|wins|finalist|recipient|honoree|recognized|recognition|named (?:as|to) (?:the )?(?:list|index|ranking)|anniversary|celebrat(es|ing|ion))\b/i;
const RX_NAME_TICKER_CHANGE =
  /\b(renam(?:e|ed|es)|name change|changes? (its )?name|ticker (?:symbol )?chang(?:e|es|ed)|to trade under)\b/i;

/** Results and earnings */
const RX_FIN_RESULTS =
  /\b(financial results|first quarter|second quarter|third quarter|fourth quarter|first half|second half|H1|H2|fiscal (?:Q\d|year) results)\b/i;
const RX_EARNINGS_BEAT =
  /\b(raises?|increas(?:es|ed)|hikes?)\b.*\b(guidance|outlook|forecast)\b|\b(beat[s]?)\b.*\b(consensus|estimates|Street|expectations)\b/i;

/** Bio trial/strong-topline cues */
const RX_PIVOTAL = /\b(phase\s*(iii|3)|late-?stage|pivotal|registrational)\b/i;
const RX_MID_STAGE_WIN =
  /\b(phase\s*(ii|2)|mid[- ]stage)\b.*\b(win|successful|success|met|achieved|statistically significant|primary endpoint)\b/i;
const RX_TOPLINE_STRONG =
  /\b(top-?line|primary endpoint (met|achieved)|statistically significant|p<\s*0?\.\d+)\b/i;

/** M&A — definitive + announce handling */
const RX_MNA_DEFINITIVE =
  /\b(definitive (merger|agreement|deal)|merger agreement (executed|signed)|enter(?:s|ed)? into (a )?definitive (agreement|merger)|business combination( agreement)?|amalgamation agreement|plan of merger)\b/i;
const RX_MNA_WILL_ACQUIRE = /\b(will|to)\s+acquire\b|\bto be acquired\b/i;
const RX_MNA_PERPRICE =
  /\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share\b|(?:deal|transaction|enterprise|equity)\s+value(?:d)?\s+at\s+\$?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m)\b/i;
const RX_MNA_LOI_ANY = /\b(letter of intent|LOI|non[- ]binding|indicative)\b/i;
const RX_MNA_ADMIN =
  /\b(extend(s|ed|ing)?|extension)\b.*\b(expiration|expiry)\b.*\b(tender offer|offer)\b/i;
const RX_ASSET_SALE =
  /\b(divestiture|divests?|carve[- ]?out|spin[- ]?off|dispos(?:e|al|es|ed))\b.*\b(stake|interest|asset|assets|business|subsidiary|equity position)\b/i;
const RX_ASSET_SALE_TITLELIKE =
  /\b((completes?|closes?)\s+(the\s+)?(sale|disposition)\s+of|sale\s+of\s+(subsidiary|business|unit|division|assets?))\b/i;
const RX_PROPERTY_ACQ =
  /\b(acquires?|acquisition of)\b.*\b(property|properties|facility|facilities|building|real estate|inpatient rehabilitation)\b/i;
const RX_MNA_ANNOUNCE =
  /\b(announce[sd]?|completes?|completed|closes?|closed)\b[^.]{0,40}\b(acquisition|acquire[sd]?|merger)\b/i;

/** ⭐ OTC Mining/Resources: transformational financing & build/ops */
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

/** Dilutive financing (suppression unless clear positives present) */
const RX_PLAIN_DILUTIVE =
  /\b(securities purchase agreement|SPA|registered direct|PIPE|private placement|warrants?|convertible (notes?|debentures?|securities?)|ATM|at[- ]the[- ]market|equity (offering|raise)|unit (offering|financing)|pricing of (an )?offering)\b/i;
const RX_DILUTION_POSITIVE = /\b(premium|above[- ]market|priced at)\b.*\$\d/i;

/** Dollar extraction + materiality */
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
function mcMillions(it: ClassifiedItem): number | null {
  const mc = (it as any).marketCap;
  if (typeof mc === "number" && isFinite(mc)) return mc / 1_000_000;
  return null;
}
function microMaterialityBoost(
  text: string,
  it: ClassifiedItem
): { material: boolean; major: boolean; relBoost: number } {
  const amt = extractDollarsMillions(text) ?? 0;
  const mc = mcMillions(it);
  const material = amt >= 1;
  const major = amt >= 7.5;
  let relBoost = 0;
  if (mc && mc > 0) {
    const ratio = amt / mc;
    if (ratio >= 0.5) relBoost += 0.12;
    else if (ratio >= 0.25) relBoost += 0.08;
    else if (ratio >= 0.1) relBoost += 0.05;
    else if (ratio >= 0.05) relBoost += 0.03;
  }
  return { material, major, relBoost };
}

export function score(items: ClassifiedItem[]): ClassifiedItem[] {
  return items.map((it) => {
    const blob = `${it.title ?? ""} ${
      (it as any).summary ?? (it as any).text ?? ""
    }`;
    const label = String(it.klass);
    const isWire = isWirePR((it as any).url, blob);

    // 0) Kill switch: misinformation
    if (
      /\b(misinformation|unauthorized (press )?release|retracts? (?:a )?press release|clarif(?:y|ies) misinformation)\b/i.test(
        blob
      )
    )
      return { ...it, score: 0 };

    // 1) Baseline by label
    let s = BASELINE[label] ?? BASELINE.OTHER;

    // 2) Noise caps
    if (RX_PROXY_ADVISOR.test(blob) || RX_VOTE_ADMIN_ONLY.test(blob))
      s = Math.min(s, 0.2);
    if (RX_LAWFIRM.test(blob)) s = Math.min(s, 0.12);
    if (RX_AWARDS.test(blob)) s = Math.min(s, 0.18);
    if (RX_SECURITY_UPDATE.test(blob)) s = Math.min(s, 0.16);
    if (RX_INVESTOR_CONFS.test(blob)) s = Math.min(s, 0.16);
    if (RX_NAME_TICKER_CHANGE.test(blob)) s = Math.min(s, 0.16);

    // Analyst/media noise
    if (
      /\b(initiates?|reiterates?|maintains?|upgrades?|downgrades?)\b.*\b(coverage|rating|price target|pt|target)\b/i.test(
        blob
      )
    )
      s = Math.min(s, 0.16);

    // Shelf/ATM cap
    if (
      /\b(Form\s*S-3|shelf registration|at[- ]the[- ]market|ATM (program|facility))\b/i.test(
        blob
      )
    )
      s = Math.min(s, 0.18);

    // Dividend/buyback generic cap unless special dividend
    const isSpecialDiv =
      /\b(special (cash )?dividend)\b.*\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share|\b(special (cash )?dividend of)\s*\$\s?\d+(?:\.\d+)?\b/i.test(
        blob
      );
    if (
      !isSpecialDiv &&
      /\b(share repurchase|buyback|issuer tender offer|dutch auction|dividend (declaration|increase|initiation))\b/i.test(
        blob
      )
    )
      s = Math.min(s, 0.2);

    // Strategic alternatives (until outcome)
    if (
      /\b(strategic alternatives?|exploring (alternatives|options)|review of strategic alternatives|considering strategic alternatives)\b/i.test(
        blob
      )
    )
      s = Math.min(s, 0.3);

    // 3) Dilutive financing suppression (unless positives)
    const isPlainDilutive =
      RX_PLAIN_DILUTIVE.test(blob) &&
      !(
        RX_DILUTION_POSITIVE.test(blob) ||
        RX_NON_DILUTIVE.test(blob) ||
        /\b(going[- ]concern (removed|resolved)|debt (extinguished|retired|repaid|eliminated|paid (down|off))|default (cured|resolved))\b/i.test(
          blob
        )
      );
    if (isPlainDilutive) s = Math.min(s, 0.18);

    // 4) Bio nuance: real topline/pivotal gets extra
    if (label === "PIVOTAL_TRIAL_SUCCESS") {
      if (RX_PIVOTAL.test(blob) && RX_TOPLINE_STRONG.test(blob)) s += 0.06;
      else if (RX_MID_STAGE_WIN.test(blob)) s += 0.03;
    }

    // 5) M&A specifics + announce handling
    if (label === "ACQUISITION_BUYOUT") {
      const definitive =
        RX_MNA_DEFINITIVE.test(blob) ||
        (RX_MNA_WILL_ACQUIRE.test(blob) && RX_MNA_PERPRICE.test(blob));
      if (definitive) s += 0.06;
      if (RX_MNA_PERPRICE.test(blob)) s += 0.02;
      if (RX_MNA_ANNOUNCE.test(blob)) s += 0.04; // announced/closed headlines move OTC
      if (RX_MNA_LOI_ANY.test(blob)) s -= 0.06;
      if (RX_MNA_ADMIN.test(blob)) s = Math.min(s, 0.4);
      if (
        RX_ASSET_SALE.test(blob) ||
        RX_ASSET_SALE_TITLELIKE.test(blob) ||
        RX_PROPERTY_ACQ.test(blob)
      )
        s = Math.min(s, 0.4);
    }

    // 6) ⭐ OTC Mining/Resources — transformational finance/build/ops
    if (label === "RESTRUCTURING_OR_FINANCING") {
      let tfBoost = 0;
      if (RX_PROJECT_FINANCE.test(blob)) tfBoost += 0.1; // project finance / credit facility / debt
      if (RX_FULLY_FUNDED.test(blob)) tfBoost += 0.06; // “fully fund(s) capex”
      if (RX_CONSTRUCTION_DECISION.test(blob)) tfBoost += 0.06;
      if (RX_ROYALTY_STREAM.test(blob)) tfBoost += 0.06;
      if (RX_OFFTAKE.test(blob)) tfBoost += 0.04;
      if (RX_PERMIT_APPROVAL.test(blob)) tfBoost += 0.05;
      if (RX_PRODUCTION_START.test(blob)) tfBoost += 0.06;
      // synergy: finance + construction decision together gets an extra nudge
      if (RX_PROJECT_FINANCE.test(blob) && RX_CONSTRUCTION_DECISION.test(blob))
        tfBoost += 0.02;
      tfBoost = Math.min(0.2, tfBoost);
      s += tfBoost;

      // Non-dilutive language + wire → good signal
      if (isWire && RX_NON_DILUTIVE.test(blob)) s += 0.03;
    }

    // 7) Wire presence modulation
    const wireSensitive =
      label === "PIVOTAL_TRIAL_SUCCESS" ||
      label === "FDA_MARKETING_AUTH" ||
      label === "FDA_ADCOM_POSITIVE" ||
      label === "TIER1_PARTNERSHIP" ||
      label === "MAJOR_GOV_CONTRACT" ||
      label === "GOVERNMENT_EQUITY_OR_GRANT" ||
      label === "ACQUISITION_BUYOUT" ||
      label === "EARNINGS_BEAT_OR_GUIDE_UP" ||
      label === "INDEX_INCLUSION" ||
      label === "UPLISTING_TO_NASDAQ" ||
      label === "IPO_DEBUT_POP";
    if (wireSensitive) {
      const mc = mcMillions(it) ?? Infinity;
      const isMicro = mc < 50; // relax for sub-$50M caps
      const allowOffWire =
        label === "ACQUISITION_BUYOUT" && isMicro && RX_MNA_ANNOUNCE.test(blob);

      if (isWire) s += 0.04;
      else if (!allowOffWire) s = Math.min(s, 0.48);
    } else {
      // Non-wire-sensitive labels still get a small wire nudge
      if (isWire) s += 0.02;
    }

    // 8) Materiality vs market cap (works great for OTC)
    const { material, major, relBoost } = microMaterialityBoost(blob, it);
    s += relBoost;
    if (material) s += 0.02;
    if (major) s += 0.03;

    // 9) Generic size-sensitive bump (OTC pop potential)
    const mc = mcMillions(it);
    const isSub100M = !!mc && mc < 100;
    const isSub25M = !!mc && mc < 25;
    const isSub10M = !!mc && mc < 10;
    if (isSub10M) s += 0.18;
    else if (isSub25M) s += 0.14;
    else if (isSub100M) s += 0.1;
    else {
      const isSmallCap =
        (it.marketCap ?? 0) > 0 && (it.marketCap as number) < 1_000_000_000;
      if (isSmallCap) s += 0.14;
    }

    // 10) Textual nudges
    if (SUPERLATIVE_WORDS.test(blob)) s += 0.04;
    if (LARGE_DOLLAR_AMOUNT.test(blob)) s += 0.06;
    if (BIG_MOVE_WORDS.test(blob)) s += 0.06;
    if ((it.symbols?.length || 0) === 1) s += 0.03;

    // 11) Earnings guardrails: require beat/raise or strong KPIs
    if (label === "EARNINGS_BEAT_OR_GUIDE_UP") {
      if (!RX_EARNINGS_BEAT.test(blob) && !RX_FIN_RESULTS.test(blob)) {
        // if misclassified earnings without beats/raise, cap it
        s = Math.min(s, 0.4);
      }
    }

    // Bound [0,1]
    s = Math.max(0, Math.min(1, s));
    return { ...it, score: s };
  });
}
