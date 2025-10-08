// src/pipeline/score.ts
import type { ClassifiedItem } from "../types.js";

/** Baseline impact by classified event (higher = more likely to cause large pops). */
const BASELINE: Record<string, number> = {
  // --- existing ---
  PIVOTAL_TRIAL_SUCCESS: 0.72,
  FDA_MARKETING_AUTH: 0.7,
  FDA_ADCOM_POSITIVE: 0.66,
  REGULATORY_DESIGNATION: 0.54,
  TIER1_PARTNERSHIP: 0.6,
  MAJOR_GOV_CONTRACT: 0.6,
  GOVERNMENT_EQUITY_OR_GRANT: 0.58,
  ACQUISITION_BUYOUT: 0.64,
  IPO_DEBUT_POP: 0.55,
  COURT_WIN_INJUNCTION: 0.56,
  MEME_OR_INFLUENCER: 0.5,
  RESTRUCTURING_OR_FINANCING: 0.5, // spin-offs / PRV sale / buybacks get handled below
  POLICY_OR_POLITICS_TAILWIND: 0.44,
  EARNINGS_BEAT_OR_GUIDE_UP: 0.52,
  INDEX_INCLUSION: 0.5,
  UPLISTING_TO_NASDAQ: 0.46,

  // --- new micro/OTC labels ---
  REVERSE_SPLIT_UPLIST_PATH: 0.58, // RS explicitly tied to uplist/compliance
  CE_REMOVAL_OR_RESUME_TRADING: 0.67, // CE removed / resume trading tends to pop hard
  GOING_CONCERN_REMOVED: 0.56, // auditor going-concern paragraph removed
  INSIDER_BUY_CLUSTER: 0.6, // multiple Form-4s / mgmt buys
  TOXIC_FINANCING_TERMINATED: 0.62, // SPA/convertible/ATM cancelled or reduced
  AUTHORIZED_SHARES_REDUCED: 0.54, // A/S materially cut
  DILUTION_FREE_INVESTMENT: 0.58, // premium/no-warrant, no RS
  LARGE_ORDER_RELATIVE: 0.57, // PO/order material vs micro scale
  DISTRIBUTION_AGREEMENT_MATERIAL: 0.6, // named chains/regions
  CRYPTO_OR_AI_TREASURY_PIVOT: 0.55, // concrete BTC/AI treasury/action
  CUSTODIANSHIP_OR_RM_DEAL: 0.6, // custodianship win / reverse merger definitive
  AUDIT_COMPLETED_FILINGS_CURED: 0.56, // filings current / delinquency cured

  OTHER: 0.2,
};

/* --- Lightweight cues --- */
const LARGE_DOLLAR_AMOUNT =
  /\$?\s?(?:\d{2,4})\s*(?:million|billion|bn|mm|m)\b/i;
const SUPERLATIVE_WORDS =
  /\b(record|unprecedented|all-time|exclusive|breakthrough|pivotal)\b/i;
const BIG_MOVE_WORDS = /\b(double|doubled|triple|tripled)\b/i;

/** Wire gating (no external deps) */
const WIRE_HOSTS = new Set([
  "www.prnewswire.com",
  "www.globenewswire.com",
  "www.businesswire.com",
  "www.accesswire.com",
  "www.newsfilecorp.com",
]);
const WIRE_TOKENS = [
  "PR Newswire",
  "GlobeNewswire",
  "Business Wire",
  "ACCESSWIRE",
  "Newsfile",
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

/** Regulatory variants & process */
const RX_CE_MARK =
  /\b(CE[- ]mark(?:ing)?|CE[- ]certificate)\b.*\b(approval|approved|granted|obtained)\b/i;
const RX_510K = /\b(FDA)\b.*\b(510\(k\)|510k)\b.*\b(clearance|clears?)\b/i;
const RX_SUPPLEMENTAL =
  /\b(expanded indication|label (expansion|extension)|supplemental (s?NDA|s?BLA)|sNDA|sBLA)\b/i;
const RX_REG_PROCESS =
  /\b(Type\s*(A|B|C)\s*meeting|End of Phase\s*(2|II)|EOP2|pre[- ](IND|NDA|BLA)|meeting (minutes|with FDA))\b/i;
const RX_JOURNAL =
  /\b(published (in|on)|publication (in|on))\b.*\b(NEJM|New England Journal of Medicine|Lancet|JAMA|Nature|Science)\b/i;
const RX_CONFERENCE =
  /\b(presents?|presented|to present|poster|abstract|oral presentation)\b.*\b(conference|congress|symposium|meeting)\b/i;

/** Process: NDA/BLA acceptance / Priority Review + Clinical hold lift */
const RX_NDA_ACCEPT_PRIORITY =
  /\b(FDA|EMA|MHRA|PMDA|NMPA|ANVISA|Health Canada|HC|TGA)\b.*\b(accepts?|accepted)\b.*\b(NDA|BLA|MAA)\b|\b(priority review)\b/i;
const RX_CLINICAL_HOLD_LIFT =
  /\b(FDA)\b.*\b(lifts?|lifted|removes?|removed)\b.*\b(clinical hold)\b/i;

/** M&A specifics */
const RX_MNA_DEFINITIVE =
  /\b(definitive (merger|agreement|deal)|merger agreement (executed|signed)|enter(?:s|ed)? into (a )?definitive (agreement|merger)|business combination( agreement)?|amalgamation agreement|plan of merger)\b/i;
const RX_MNA_WILL_ACQUIRE = /\b(will|to)\s+acquire\b|\bto be acquired\b/i;
const RX_MNA_PERPRICE =
  /\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share\b|(?:deal|transaction|enterprise|equity)\s+value(?:d)?\s+at\s+\$?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m)\b/i;
const RX_MNA_TENDER =
  /\b(tender offer|exchange offer|commence(s|d)? (an )?offer)\b/i;
const RX_MNA_REVISED =
  /\b(revise[sd]?|increase[sd]?|raise[sd]?|sweeten(?:s|ed)?)\b.*\b(offer|bid|proposal|consideration|purchase price)\b/i;
const RX_MNA_CASHSTOCK =
  /\b(cash[- ]and[- ]stock|cash\s*(?:&|and|\/)\s*stock)\b/i;
const RX_MNA_LOI_ANY = /\b(letter of intent|LOI|non[- ]binding|indicative)\b/i;
const RX_MNA_ADMIN =
  /\b(extend(s|ed|ing)?|extension)\b.*\b(expiration|expiry)\b.*\b(tender offer|offer)\b/i;
const RX_ASSET_SALE =
  /\b(divestiture|divests?|carve[- ]?out|spin[- ]?off|dispos(?:e|al|es|ed))\b.*\b(stake|interest|asset|assets|business|subsidiary|equity position)\b/i;
const RX_ASSET_SALE_TITLELIKE =
  /\b((completes?|closes?)\s+(the\s+)?(sale|disposition)\s+of|sale\s+of\s+(subsidiary|business|unit|division|assets?))\b/i;
const RX_PROPERTY_ACQ =
  /\b(acquires?|acquisition of)\b.*\b(property|properties|facility|facilities|building|real estate|inpatient rehabilitation)\b/i;
const RX_MNA_PREMIUM_MENTION =
  /\brepresent(?:s|ed)?\s+(\d{2,3})\s?%\s+premium\b/i;
const RX_MNA_UNSOL_PRICED =
  /\b(unsolicited|non[- ]binding|indicative)\b.*\b(proposal|offer)\b.*(?:\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share|valu(?:e|ed)\s+at\s+\$?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m))\b/i;

/** Financing (bearish) + exceptions */
const RX_SHELF_ATM =
  /\b(Form\s*S-3|shelf registration|universal shelf|at[- ]the[- ]market|ATM (program|facility))\b/i;
const RX_FINANCING_DILUTIVE =
  /\b(securities purchase agreement|SPA|registered direct|PIPE|private placement|warrants?|convertible (notes?|debentures?|securities?)|at[- ]the[- ]market|ATM (offering|program|facility)?|equity (offering|raise)|unit (offering|financing)|pricing of (an )?offering)\b/i;
const RX_FINANCING_PREMIUM =
  /\b(premium|above[- ]market|priced at)\b.*\$\d+(?:\.\d+)?/i;
const RX_FINANCING_STRATEGIC =
  /\b(strategic (investment|investor|partner|partnership|financing))\b/i;
const RX_FINANCING_GOING =
  /\b(going[- ]concern (removed|resolved)|debt (extinguished|retired|repaid|eliminated|paid (down|off))|default (cured|resolved))\b/i;
const RX_ANTI_DILUTION_POS =
  /\b(terminates?|terminated|withdraws?|withdrawn|cancels?|cancelled|reduces?|downsized?)\b.*\b(offering|registered direct|ATM|at[- ]the[- ]market|public offering|securities purchase agreement)\b/i;

/** Crypto / treasury */
const RX_CRYPTO_TREASURY_BUY =
  /\b(buy|bought|purchase[sd]?|acquire[sd]?)\b.*\b(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|LINK|Chainlink|crypto(?:currency)?|tokens?)\b/i;
const RX_CRYPTO_TREASURY_DISCUSS =
  /\b(treasury|reserve|policy|program|strategy)\b.*\b(discuss(?:ions?)?|approached|proposal|term sheet|non[- ]binding|indicative)\b.*\b(\$?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m))\b/i;
const RX_CRYPTO_TREASURY_INITIATE =
  /\b(launch(?:es|ed)?|initiat(?:es|ed|ing)|adopt(?:s|ed|ing)|establish(?:es|ed|ing)|implement(?:s|ed|ing)|convert(?:s|ed|ing)\s+(?:a |portion of )?cash\s+(?:to|into))\b[^.]{0,120}\b(Bitcoin|BTC)\b[^.]{0,120}\b(treasury|reserve)\b[^.]{0,120}\b(strategy|program|policy|framework|asset)\b/i;

/** Reimbursement / policy tailwinds */
const RX_REIMBURSEMENT =
  /\b(CMS|Medicare)\b.*\b(NTAP|new (technology|tech) add[- ]on payment|transitional pass[- ]through|TPT|HCPCS(?:\s*code)?\s*[A-Z0-9]+)\b/i;

/** Index inclusion (major vs minor) */
const RX_INDEX_MAJOR = /\b(S&P\s?(500|400|600)|MSCI|FTSE|Nasdaq[- ]?100)\b/i;
const RX_INDEX_MINOR =
  /\b(Russell\s?(2000|3000|Microcap)|S&P\/?TSX(?:\sComposite)?|TSX Composite|TSX Venture|TSXV|CSE Composite)\b/i;

/** Other ≤5% cohort noise */
const RX_ANALYST =
  /\b(initiates?|reiterates?|maintains?|upgrades?|downgrades?)\b.*\b(coverage|rating|price target|pt|target)\b/i;
const RX_MEDIA_INTERVIEW =
  /\b(says|tells|told|said)\b.*\b(CNBC|Yahoo Finance|Bloomberg|Fox Business|Barron'?s)\b/i;
const RX_BUYBACK_DIV =
  /\b(share repurchase|buyback|issuer tender offer|dutch auction|dividend (declaration|increase|initiation))\b/i;

/** Strategic alternatives */
const RX_STRAT_ALTS =
  /\b(strategic alternatives?|exploring (alternatives|options)|review of strategic alternatives|considering strategic alternatives)\b/i;
const RX_STRAT_ALTS_OUTCOME =
  /\b(concludes?|concluded|completed|complete[s]?)\b.*\b(strategic alternatives|strategic review)\b.*\b(with|result(?:ed|s)? in)\b.*\b(sale|merger|business combination|divestiture)\b/i;

/** Tier-1 powered-by verbs and Tier-1 names */
const RX_TIER1_VERBS =
  /\b(powered by|built (?:on|with)|integrat(?:es|ed)? with|adopt(?:s|ed)|selects?|standardiz(?:es|ed) on|deploys?|rolls out|invests? in|makes? (?:a )?strategic investment in|expands?|extends?|renews?)\b/i;
const TIER1_RX = new RegExp(
  "\\b(?:Nvidia|Microsoft|OpenAI|Apple|Amazon|AWS|Google|Alphabet|Meta|Facebook|Tesla|Oracle|Salesforce|Adobe|IBM|Intel|AMD|Broadcom|Qualcomm|TSMC|Samsung|Cisco|Dell|HPE|Supermicro|Snowflake|Palantir|Siemens|Sony|Workday|ServiceNow|Shopify|Twilio|Atlassian|Zoom|Datadog|CrowdStrike|Okta|MongoDB|Cloudflare|Stripe|Block|Square|Walmart|Target|Costco|Home Depot|Lowe's|Best Buy|Alibaba|Tencent|JD.com|ByteDance|TikTok|Lockheed Martin|Raytheon|RTX|Boeing|Northrop Grumman|General Dynamics|L3Harris|BAE Systems|Thales|Airbus|SpaceX|NASA|Space Force|USSF|DARPA|Department of Defense|DoD|Army|Navy|Air Force|Pfizer|Merck|Johnson & Johnson|J&J|Bristol-Myers|BMS|Eli Lilly|Lilly|Sanofi|GSK|AstraZeneca|Novo Nordisk|Roche|Novartis|Bayer|Amgen|AbbVie|Takeda|Gilead|Biogen|Regeneron|Medtronic|Boston Scientific|Abbott|GE Healthcare|Philips|Siemens Healthineers|Intuitive Surgical|BARDA|HHS|NIH|CMS|Medicare|VA|FDA|EMA|EC|MHRA|PMDA|ExxonMobil|Chevron|BP|Shell|TotalEnergies|Schlumberger|Halliburton|Caterpillar|Deere|GE|Honeywell)(?:'s)?\\b",
  "i"
);

/** Listing compliance regained */
const RX_LISTING_COMPLIANCE =
  /\b(regain(?:ed|s)?|returns? to|back in)\b.*\b(compliance)\b.*\b(Nasdaq|NYSE|listing)\b/i;

/** Preclinical signals */
const RX_PRECLIN_NHP =
  /\b(non[- ]?human|nonhuman)\s+primate[s]?\b.*\b(well tolerated|tolerability|safety|safe)\b.*\b(higher than|exceed(?:s|ed)|above)\b.*\b(efficacious|effective)\b/i;
const RX_CELL_MODEL =
  /\b(patient[- ]derived|iPSC|neurons?|organoid[s]?)\b.*\b(early (signals?|evidence) of (benefit|efficacy)|signal(?:s)? of (benefit|efficacy)|improv(?:e|ed)|rescue)\b/i;
const RX_HOT_DISEASE =
  /\b(Alzheimer'?s|ALS|Parkinson'?s|Huntington'?s|multiple sclerosis|MS\b|glioblastoma|GBM|pancreatic cancer)\b/i;

/** Special dividend (explicit amount) */
const RX_SPECIAL_DIVIDEND =
  /\b(special (cash )?dividend)\b.*\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share|\b(special (cash )?dividend of)\s*\$\s?\d+(?:\.\d+)?\b/i;

/** Misinformation / unauthorized PR */
const RX_MISINFO =
  /\b(misinformation|unauthorized (press )?release|retracts? (?:a )?press release|clarif(?:y|ies) misinformation)\b/i;

/** New: purchase orders and legal settlements with royalties */
const RX_PURCHASE_ORDER = /\b(purchase order|PO)\b/i;
const RX_LEGAL_SETTLEMENT_ROYALTIES =
  /\b(settlement|settles)\b.*\b(royalt(?:y|ies)|minimum payments?|licensing revenue|lump[- ]sum)\b/i;

/** Spin-offs / distributions (record & distribution dates / Form 10) */
const RX_SPINOFF_DIST =
  /\b(spin[- ]?off|separation|separate[sd]?|split[- ]?off)\b.*\b(record date|distribution date|when[- ]issued|Form\s*10)\b/i;

/** PRV grant / PRV sale */
const RX_PRV = /\b(priority review voucher|PRV)\b/i;
const RX_PRV_GRANT = /\b(granted|awarded|receives?)\b/i;
const RX_PRV_SALE = /\b(sell|sold|sale)\b/i;

/** DOE/LPO loan (gov loans with big $ amounts) */
const RX_GOV_LOAN =
  /\b(Department of Energy|DOE|Loan Programs Office|LPO)\b.*\b(loan|conditional commitment)\b/i;

/** IPO pricing / first-day trading */
const RX_IPO_PRICE = /\b(prices?|priced)\b.*\b(initial public offering|IPO)\b/i;
const RX_IPO_BEGIN_TRADE =
  /\b(begins?|commences?)\s+trading\b.*\b(Nasdaq|NYSE|NYSE American)\b/i;

/** Micro/OTC specific text cues (match classifier semantics loosely) */
const RX_REVERSE_SPLIT = /\b(reverse(?: |-)?split|stock consolidation)\b/i;
const RX_RS_UPLIST =
  /\breverse(?: |-)?split\b[^.]{0,120}\b(uplist|Nasdaq|NYSE|compliance plan|deficiency plan|hearing panel)\b/i;
const RX_CE_REMOVED =
  /\b(Caveat Emptor|CE)\b.*\b(removed|removal)\b|\b(resume(?:s|d)?\s+trading)\b.*\b(OTC|Pink|QB|QX)\b/i;
const RX_GOING_CONCERN_REMOVED =
  /\b(going[- ]concern)\b.*\b(removed|no longer|eliminated|lifted)\b/i;
const RX_AUDIT_CURED =
  /\b(10-K|10-Q|annual report|quarterly report)\b.*\b(filed|re-filed|become[s]? current|brings? filings current|cures? delinquency)\b/i;
const RX_CUSTODIANSHIP_RM =
  /\b(custodianship|receiver|reverse merger|RTO|business combination)\b.*\b(granted|approved|definitive|agreement)\b/i;
const RX_INSIDER_FORM4 =
  /\b(Form\s*4|purchases?|buys?)\b.*\b(director|officer|CEO|CFO|insider|management)\b/i;
const RX_INSIDER_CLUSTER =
  /\b(multiple|several|numerous)\b.*\b(Form\s*4|insider purchases?)\b/i;
const RX_TOXIC_TERM =
  /\b(terminat(?:es|ed)|cancels?|withdraws?|ends?)\b.*\b(Equity Line|ELOC|SEPA|S-3|ATM|convertible (notes?|debentures)|toxic|dilut(?:ive|ion))\b/i;
const RX_AS_REDUCED =
  /\b(authori[sz]ed|authorized)\s+shares?\b.*\b(reduc(?:ed|es|tion)|cut|decrease)\b/i;
const RX_NO_WARRANTS_NO_RS =
  /\b(no (?:warrants?|pre[- ]funded warrants?|rights)|no reverse split|without (?:warrants|a reverse split))\b/i;
const RX_DISTRIBUTION =
  /\b(distribution|distributor|reseller|channel partner|wholesale)\b.*\b(agreement|deal|contract)\b/i;
const RX_RETAIL_CHAINS =
  /\b(Walmart|Target|Costco|Best Buy|Amazon|Home Depot|Lowe'?s|Walgreens|CVS|Kroger|Tesco|Carrefour)\b/i;
const RX_AI_PIVOT_ACTION =
  /\b(AI|artificial intelligence|LLM|GPT)\b.*\b(launch|deploy|integrat|contract|order|revenue|customer|PO|purchase|binding)\b/i;

/** Dollar extraction and micro materiality */
function extractDollarsMillions(x: string): number | null {
  const mm = x.match(
    /\$?\s?(\d{1,3}(?:\.\d+)?)\s*(million|billion|bn|mm|m|b)\b/i
  );
  if (mm) {
    const val = parseFloat(mm[1]);
    const unit = mm[2].toLowerCase();
    if (unit === "b" || unit === "billion" || unit === "bn") return val * 1000;
    return val; // in millions
  }
  const raw = x.match(/\$\s?(\d{6,9})(?!\.)\b/); // $100,000..$999,999,999
  if (raw) {
    const n = parseInt(raw[1], 10);
    return n / 1_000_000;
  }
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
  const material = amt >= 1; // ≥$1M matters for micros
  const major = amt >= 7.5; // ≥$7.5M is major
  let relBoost = 0;
  if (mc && mc > 0) {
    const ratio = amt / mc; // e.g., $5M on $20M cap = 25%
    if (ratio >= 0.25) relBoost += 0.08;
    else if (ratio >= 0.1) relBoost += 0.05;
    else if (ratio >= 0.05) relBoost += 0.03;
  }
  return { material, major, relBoost };
}

export function score(items: ClassifiedItem[]): ClassifiedItem[] {
  return items.map((it) => {
    const blob = `${it.title ?? ""} ${it.summary ?? ""}`;
    const label = String(it.klass);
    const isWire = isWirePR((it as any).url, blob);

    // 0) Hard suppress misinformation
    if (RX_MISINFO.test(blob)) return { ...it, score: 0 };

    // 1) Baseline
    let s = BASELINE[label] ?? BASELINE.OTHER;

    // 2) Early caps for frequent non-catalysts
    if (RX_PROXY_ADVISOR.test(blob) || RX_VOTE_ADMIN_ONLY.test(blob))
      s = Math.min(s, 0.2);
    if (RX_LAWFIRM.test(blob)) s = Math.min(s, 0.12);
    if (RX_AWARDS.test(blob)) s = Math.min(s, 0.18);
    if (RX_SECURITY_UPDATE.test(blob)) s = Math.min(s, 0.16);
    if (RX_INVESTOR_CONFS.test(blob)) s = Math.min(s, 0.16);
    if (RX_NAME_TICKER_CHANGE.test(blob)) s = Math.min(s, 0.16);

    // Generic ≤5% noise caps
    if (RX_ANALYST.test(blob) || RX_MEDIA_INTERVIEW.test(blob))
      s = Math.min(s, 0.16);
    if (RX_SHELF_ATM.test(blob)) s = Math.min(s, 0.18);

    // IMPORTANT: don't cap when it's a SPECIAL dividend
    const isSpecialDividend = RX_SPECIAL_DIVIDEND.test(blob);
    if (!isSpecialDividend && RX_BUYBACK_DIV.test(blob)) s = Math.min(s, 0.2);

    if (RX_STRAT_ALTS.test(blob)) s = Math.min(s, 0.3);

    // 3) Dilutive financing suppression (unless clear positives)
    const isPlainDilutive =
      RX_FINANCING_DILUTIVE.test(blob) &&
      !(
        RX_FINANCING_PREMIUM.test(blob) ||
        RX_FINANCING_STRATEGIC.test(blob) ||
        RX_FINANCING_GOING.test(blob)
      );
    if (isPlainDilutive) s = Math.min(s, 0.18);

    // 4) Bio nuance
    if (label === "PIVOTAL_TRIAL_SUCCESS") {
      if (RX_PIVOTAL.test(blob)) s += 0.05;
      else if (RX_MID_STAGE_WIN.test(blob)) s += 0.05;
      if (!RX_TOPLINE_STRONG.test(blob)) s -= 0.05;

      if (RX_PRECLIN_NHP.test(blob)) s += 0.06;
      if (RX_CELL_MODEL.test(blob))
        s += RX_HOT_DISEASE.test(blob) ? 0.06 : 0.04;

      const journalStrong =
        RX_JOURNAL.test(blob) && RX_TOPLINE_STRONG.test(blob);
      if (journalStrong) s += 0.04;

      if (RX_NDA_ACCEPT_PRIORITY.test(blob)) s += 0.04;
      if (RX_CLINICAL_HOLD_LIFT.test(blob)) s += 0.05;
    }

    // 5) Approvals split (cap lighter EU/510k/supplemental)
    if (label === "FDA_MARKETING_AUTH") {
      if (RX_CE_MARK.test(blob)) s = Math.min(s, 0.46);
      if (RX_510K.test(blob)) s = Math.min(s, 0.46);
      if (RX_SUPPLEMENTAL.test(blob)) s = Math.min(s, 0.58);
    }

    // 6) Process/journal/conference guards (unless strong outcomes)
    const hasStrongOutcome =
      RX_TOPLINE_STRONG.test(blob) ||
      RX_PIVOTAL.test(blob) ||
      RX_MID_STAGE_WIN.test(blob);
    if (!hasStrongOutcome) {
      if (RX_REG_PROCESS.test(blob)) s = Math.min(s, 0.42);
      if (RX_JOURNAL.test(blob)) s = Math.min(s, 0.42);
      if (RX_CONFERENCE.test(blob)) s = Math.min(s, 0.38);
    }

    // 7) M&A specifics
    if (label === "ACQUISITION_BUYOUT") {
      const definitive =
        RX_MNA_DEFINITIVE.test(blob) ||
        (RX_MNA_WILL_ACQUIRE.test(blob) && RX_MNA_PERPRICE.test(blob));
      if (definitive) s += 0.06;
      if (RX_MNA_TENDER.test(blob)) s += 0.04;
      if (RX_MNA_REVISED.test(blob)) s += 0.06;
      if (RX_MNA_CASHSTOCK.test(blob)) s += 0.02;
      if (RX_MNA_PERPRICE.test(blob)) s += 0.02;
      if (RX_MNA_UNSOL_PRICED.test(blob)) s += 0.06;
      const prem = blob.match(RX_MNA_PREMIUM_MENTION);
      if (prem && Number(prem[1]) >= 40) s += 0.04;
      if (RX_MNA_LOI_ANY.test(blob)) s -= 0.06;
      if (RX_MNA_ADMIN.test(blob)) s = Math.min(s, 0.4);
      if (
        RX_ASSET_SALE.test(blob) ||
        RX_ASSET_SALE_TITLELIKE.test(blob) ||
        RX_PROPERTY_ACQ.test(blob)
      )
        s = Math.min(s, 0.4);
      if (RX_STRAT_ALTS_OUTCOME.test(blob)) s += 0.06;
    }

    // 8) Gov contracts
    if (label === "MAJOR_GOV_CONTRACT") {
      if (
        /\b(continued production|follow[- ]on|followon|option (exercise|exercised)|extension|renewal)\b/i.test(
          blob
        )
      )
        s = Math.min(s, 0.48);
      if (RX_GOV_LOAN.test(blob) && LARGE_DOLLAR_AMOUNT.test(blob)) s += 0.08;
    }

    // 9) Index inclusion: major vs minor
    if (label === "INDEX_INCLUSION") {
      if (RX_INDEX_MAJOR.test(blob)) s += 0.04;
      if (RX_INDEX_MINOR.test(blob)) s = Math.min(s, 0.4);
    }

    // 10) Wire presence modulation for catalyst-y labels
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
      label === "UPLISTING_TO_NASDAQ";
    const tier1Powered = TIER1_RX.test(blob) && RX_TIER1_VERBS.test(blob);
    if (wireSensitive) {
      const definitiveMnaOffWire =
        label === "ACQUISITION_BUYOUT" &&
        !isWire &&
        (RX_MNA_DEFINITIVE.test(blob) ||
          (RX_MNA_WILL_ACQUIRE.test(blob) && RX_MNA_PERPRICE.test(blob)));
      if (!(definitiveMnaOffWire || tier1Powered)) {
        if (isWire) s += 0.04;
        else s = Math.min(s, 0.48);
      }
    }

    // 11) Crypto treasury — buy/discuss/initiate (legacy path)
    const isCryptoBuy = RX_CRYPTO_TREASURY_BUY.test(blob);
    const isCryptoDiscuss = RX_CRYPTO_TREASURY_DISCUSS.test(blob);
    const isCryptoInitiate = RX_CRYPTO_TREASURY_INITIATE.test(blob);
    if (
      label === "RESTRUCTURING_OR_FINANCING" ||
      isCryptoBuy ||
      isCryptoDiscuss ||
      isCryptoInitiate
    ) {
      if (isCryptoBuy) s += 0.14;
      if (isCryptoInitiate) s += 0.12;
      if (isCryptoDiscuss) s += 0.1;
      if (LARGE_DOLLAR_AMOUNT.test(blob)) s += 0.04;
    }

    // 12) Reimbursement / policy tailwinds boost
    if (label === "POLICY_OR_POLITICS_TAILWIND" && RX_REIMBURSEMENT.test(blob))
      s += 0.06;

    // 13) Listing compliance bump
    if (RX_LISTING_COMPLIANCE.test(blob)) s += 0.12;

    // 14) Earnings: cap generic results unless beat/raise OR big KPI spike
    const pctMatch = blob.match(
      /\b(revenue|sales|eps|earnings|arr|bookings|net income)\b[^.%]{0,90}?\b(up|increase[sd]?|grow[n|th|s]?|jump(?:ed)?|soar(?:ed)?|surged)\b[^%]{0,25}?(\d{2,3})\s?%(\s*(y\/y|yoy|year[- ]over[- ]year|q\/q|qoq))?/i
    );
    const hasBigPct = pctMatch?.[3]
      ? !isNaN(parseInt(pctMatch[3], 10)) && parseInt(pctMatch[3], 10) >= 50
      : false;
    const swingProfit =
      /\b(returns?|returned|swing|swung|back)\s+to\s+(profit|profitability|positive (?:net )?income)\b/i.test(
        blob
      );
    if (RX_FIN_RESULTS.test(blob) && !RX_EARNINGS_BEAT.test(blob)) {
      if (hasBigPct || swingProfit) s += swingProfit ? 0.1 : 0.08;
      else s = Math.min(s, 0.32);
    }

    // 15) Positive financing exception
    if (RX_ANTI_DILUTION_POS.test(blob)) s += 0.12;

    // 16) Special cash dividend
    if (isSpecialDividend) s += 0.14;

    // 17) Legal settlement with royalties / minimum payments
    if (
      label === "COURT_WIN_INJUNCTION" &&
      RX_LEGAL_SETTLEMENT_ROYALTIES.test(blob)
    )
      s += 0.06;

    // 18) PO (purchase order) – small bump when meaningful scale or Tier-1 context
    if (
      (label === "TIER1_PARTNERSHIP" || label === "MAJOR_GOV_CONTRACT") &&
      RX_PURCHASE_ORDER.test(blob)
    ) {
      if (LARGE_DOLLAR_AMOUNT.test(blob) || TIER1_RX.test(blob)) s += 0.04;
    }

    // 19) Spin-offs / distributions
    if (label === "RESTRUCTURING_OR_FINANCING" && RX_SPINOFF_DIST.test(blob))
      s += 0.12;

    // 20) PRV grant / PRV sale
    if (RX_PRV.test(blob)) {
      if (RX_PRV_GRANT.test(blob)) s += 0.08;
      if (RX_PRV_SALE.test(blob) && LARGE_DOLLAR_AMOUNT.test(blob)) s += 0.12;
    }

    // 21) IPO pricing / begin trading (wire/IR)
    if (
      label === "IPO_DEBUT_POP" &&
      (RX_IPO_PRICE.test(blob) || RX_IPO_BEGIN_TRADE.test(blob))
    ) {
      if (isWire) s += 0.06;
      else s = Math.min(s, 0.48);
    }

    // 22) Buybacks / debt reduction / Ch.11 exit
    if (label === "RESTRUCTURING_OR_FINANCING") {
      if (RX_BUYBACK_DIV.test(blob)) {
        const buybackHit =
          /\b(share repurchase|buyback|issuer tender offer|dutch auction)\b/i.test(
            blob
          );
        if (buybackHit) s += 0.08 + (LARGE_DOLLAR_AMOUNT.test(blob) ? 0.02 : 0);
      }
      if (RX_FINANCING_GOING.test(blob)) s += 0.08; // debt extinguished / going-concern removed
      if (
        /\b(emerges?|emergence)\b.*\b(chapter\s*11|bankruptcy)\b|\b(plan of reorganization)\b.*\b(confirm(?:ed|ation))\b/i.test(
          blob
        )
      )
        s += 0.1;
    }

    /* ================================
       MICRO / OTC — NEW BOOSTERS
       ================================ */

    // A) Reverse split specifically tied to uplist/compliance (RS alone is not bullish)
    if (label === "REVERSE_SPLIT_UPLIST_PATH" || RX_RS_UPLIST.test(blob)) {
      s += 0.08;
      if (RX_AUDIT_CURED.test(blob) || RX_LISTING_COMPLIANCE.test(blob))
        s += 0.04;
      // If only generic RS mention, keep conservative
      if (label !== "REVERSE_SPLIT_UPLIST_PATH" && RX_REVERSE_SPLIT.test(blob))
        s = Math.min(s, Math.max(s, 0.5));
    }

    // B) CE removal / resume trading
    if (label === "CE_REMOVAL_OR_RESUME_TRADING" || RX_CE_REMOVED.test(blob)) {
      s += 0.1; // big mechanical pops common
    }

    // C) Going-concern removed + audit cured
    if (
      label === "GOING_CONCERN_REMOVED" ||
      RX_GOING_CONCERN_REMOVED.test(blob)
    )
      s += 0.08;
    if (label === "AUDIT_COMPLETED_FILINGS_CURED" || RX_AUDIT_CURED.test(blob))
      s += 0.06;

    // D) Custodianship / Reverse Merger definitive
    if (label === "CUSTODIANSHIP_OR_RM_DEAL" || RX_CUSTODIANSHIP_RM.test(blob))
      s += 0.08;

    // E) Insider buy clusters
    if (label === "INSIDER_BUY_CLUSTER" || RX_INSIDER_CLUSTER.test(blob))
      s += 0.1;
    else if (RX_INSIDER_FORM4.test(blob)) s += 0.06;

    // F) Toxic financing terminated / A/S reduced / dilution-free investment
    if (label === "TOXIC_FINANCING_TERMINATED" || RX_TOXIC_TERM.test(blob))
      s += 0.1;
    if (label === "AUTHORIZED_SHARES_REDUCED" || RX_AS_REDUCED.test(blob))
      s += 0.06;
    if (label === "DILUTION_FREE_INVESTMENT" || RX_NO_WARRANTS_NO_RS.test(blob))
      s += 0.08;

    // G) Distribution agreements / purchase orders relative to market cap
    const { material, major, relBoost } = microMaterialityBoost(blob, it);
    if (
      label === "DISTRIBUTION_AGREEMENT_MATERIAL" ||
      label === "LARGE_ORDER_RELATIVE" ||
      RX_DISTRIBUTION.test(blob) ||
      RX_PURCHASE_ORDER.test(blob)
    ) {
      s += relBoost;
      if (material) s += 0.04;
      if (major) s += 0.06;
      if (RX_RETAIL_CHAINS.test(blob)) s += 0.04; // named retailers (Walmart, etc.)
    }

    // H) Concrete AI/crypto pivots (avoid buzz-only)
    if (
      label === "CRYPTO_OR_AI_TREASURY_PIVOT" ||
      RX_AI_PIVOT_ACTION.test(blob)
    ) {
      s += 0.06;
      const rel = microMaterialityBoost(blob, it);
      s += rel.relBoost; // scale by $ vs cap if any
    }

    // I) Wire presence: for micro-labels, allow off-wire (OTC issuers often PR on Accesswire/Newsfile/IR)
    // -> no extra penalty beyond the generic wireSensitive block above.

    // 23) Generic boosters
    const mc = mcMillions(it);
    const isSub100M = !!mc && mc < 100;
    const isSub25M = !!mc && mc < 25;
    const isSub10M = !!mc && mc < 10;

    // size-sensitive bump (smaller cap → larger pop propensity)
    if (isSub10M) s += 0.18;
    else if (isSub25M) s += 0.14;
    else if (isSub100M) s += 0.1;
    else {
      // legacy small-cap bump (<$1B)
      const isSmallCap =
        (it.marketCap ?? 0) > 0 && (it.marketCap as number) < 1_000_000_000;
      if (isSmallCap) s += 0.14;
    }

    if (SUPERLATIVE_WORDS.test(blob)) s += 0.04;
    if (LARGE_DOLLAR_AMOUNT.test(blob)) s += 0.06;
    if (BIG_MOVE_WORDS.test(blob)) s += 0.06;
    if ((it.symbols?.length || 0) === 1) s += 0.03;

    // Bound [0,1]
    s = Math.max(0, Math.min(1, s));
    return { ...it, score: s };
  });
}
