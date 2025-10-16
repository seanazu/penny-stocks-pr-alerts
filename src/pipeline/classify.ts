// src/pipeline/classify.ts
import type { RawItem, ClassifiedItem, EventClass } from "../types.js";

/** Events commonly behind ≥40–50% single-day pops, tuned for micro/OTC. */
export type HighImpactEvent =
  | "PIVOTAL_TRIAL_SUCCESS"
  | "FDA_MARKETING_AUTH"
  | "FDA_ADCOM_POSITIVE"
  | "REGULATORY_DESIGNATION"
  | "TIER1_PARTNERSHIP"
  | "MAJOR_GOV_CONTRACT"
  | "GOVERNMENT_EQUITY_OR_GRANT"
  | "ACQUISITION_BUYOUT"
  | "IPO_DEBUT_POP"
  | "COURT_WIN_INJUNCTION"
  | "MEME_OR_INFLUENCER"
  | "RESTRUCTURING_OR_FINANCING"
  | "POLICY_OR_POLITICS_TAILWIND"
  | "EARNINGS_BEAT_OR_GUIDE_UP"
  | "INDEX_INCLUSION"
  | "UPLISTING_TO_NASDAQ"
  // --- Penny/Micro-specific adds ---
  | "REVERSE_SPLIT_UPLIST_PATH" // RS explicitly tied to uplist/compliance plan
  | "CE_REMOVAL_OR_RESUME_TRADING" // OTC Caveat Emptor removed / resume trading
  | "GOING_CONCERN_REMOVED" // Auditor removes going-concern paragraph
  | "INSIDER_BUY_CLUSTER" // Multiple Form 4s / management buys
  | "TOXIC_FINANCING_TERMINATED" // SPA/convertible/ATM cancelled or reduced
  | "AUTHORIZED_SHARES_REDUCED" // A/S materially reduced
  | "DILUTION_FREE_INVESTMENT" // Equity at premium / no warrants / no RS
  | "LARGE_ORDER_RELATIVE" // PO/order/license material vs micro-cap scale
  | "DISTRIBUTION_AGREEMENT_MATERIAL" // new distributor covering regions/chains
  | "CRYPTO_OR_AI_TREASURY_PIVOT" // BTC/AI pivot w/ concrete treasury/action
  | "CUSTODIANSHIP_OR_RM_DEAL" // Custodianship win / reverse merger definitive
  | "AUDIT_COMPLETED_FILINGS_CURED" // Delinquency cured; trading status improved
  | "OTHER";

/** Tier-1 counterparties (expanded). */
const TIER1_COUNTERPARTIES: string[] = [
  "Nvidia",
  "Microsoft",
  "OpenAI",
  "Apple",
  "Amazon",
  "AWS",
  "Google",
  "Alphabet",
  "Meta",
  "Facebook",
  "Tesla",
  "Oracle",
  "Salesforce",
  "Adobe",
  "IBM",
  "Intel",
  "AMD",
  "Broadcom",
  "Qualcomm",
  "TSMC",
  "Samsung",
  "Cisco",
  "Dell",
  "HPE",
  "Supermicro",
  "Snowflake",
  "Palantir",
  "Siemens",
  "Sony",
  "Workday",
  "ServiceNow",
  "Shopify",
  "Twilio",
  "Atlassian",
  "Zoom",
  "Datadog",
  "CrowdStrike",
  "Okta",
  "MongoDB",
  "Cloudflare",
  "Stripe",
  "Block",
  "Square",
  "Walmart",
  "Target",
  "Costco",
  "Home Depot",
  "Lowe's",
  "Best Buy",
  "Alibaba",
  "Tencent",
  "JD.com",
  "ByteDance",
  "TikTok",
  "Lockheed Martin",
  "Raytheon",
  "RTX",
  "Boeing",
  "Northrop Grumman",
  "General Dynamics",
  "L3Harris",
  "BAE Systems",
  "Thales",
  "Airbus",
  "SpaceX",
  "NASA",
  "Space Force",
  "USSF",
  "DARPA",
  "Department of Defense",
  "DoD",
  "Army",
  "Navy",
  "Air Force",
  "Pfizer",
  "Merck",
  "Johnson & Johnson",
  "J&J",
  "Bristol-Myers",
  "BMS",
  "Eli Lilly",
  "Lilly",
  "Sanofi",
  "GSK",
  "AstraZeneca",
  "Novo Nordisk",
  "Roche",
  "Novartis",
  "Bayer",
  "Amgen",
  "AbbVie",
  "Takeda",
  "Gilead",
  "Biogen",
  "Regeneron",
  "Medtronic",
  "Boston Scientific",
  "Abbott",
  "GE Healthcare",
  "Philips",
  "Siemens Healthineers",
  "Intuitive Surgical",
  "BARDA",
  "HHS",
  "NIH",
  "CMS",
  "Medicare",
  "VA",
  "FDA",
  "EMA",
  "EC",
  "MHRA",
  "PMDA",
  "ExxonMobil",
  "Chevron",
  "BP",
  "Shell",
  "TotalEnergies",
  "Schlumberger",
  "Halliburton",
  "Caterpillar",
  "Deere",
  "GE",
  "Honeywell",
  "Disney",
  "Netflix",
  "Comcast",
  "NBCUniversal",
  "Warner Bros. Discovery",
  "Paramount",
  "Visa",
  "Mastercard",
  "PayPal",
  "American Express",
  "Verizon",
  "AT&T",
  "T-Mobile",
  "Uber",
  "Lyft",
  "DoorDash",
  "Instacart",
  "SAP",
  "Databricks",
  "Anthropic",
  "Cohere",
  "Epic Games",
  "Unity",
  "Nintendo",
  "Red Hat",
  "GitHub",
];

/* ---------- Utils ---------- */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (s: string) =>
  (s || "")
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\u2011|\u2013|\u2014/g, "-")
    .trim();

const TIER1_RX = new RegExp(
  `\\b(?:${TIER1_COUNTERPARTIES.map(esc).join("|")})(?:'s)?\\b`,
  "i"
);

/** “True PR” gate: major wire hosts or issuer IR. */
const WIRE_HOSTS = new Set([
  "www.prnewswire.com",
  "www.globenewswire.com",
  "www.businesswire.com",
  "www.accesswire.com",
  "www.newsfilecorp.com",
  // add microcap wires commonly used by OTC issuers
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
  // tokens used in body banners/footers
  "MCAP MediaWire",
  "PRISM MediaWire",
  "MCAP",
  "PRISM",
];
function isWirePR(url?: string, text?: string): boolean {
  const t = normalize(text || "");
  try {
    if (url) {
      const host = new URL(url).hostname.toLowerCase();
      if (WIRE_HOSTS.has(host)) return true;
      if (/^(ir|investors)\./i.test(host)) return true;
    }
  } catch {}
  return WIRE_TOKENS.some((tok) => t.includes(tok));
}

/* ---------- Extra helpers ---------- */
const HOT_DISEASE_RX =
  /\b(Alzheimer'?s|ALS|Parkinson'?s|Huntington'?s|multiple sclerosis|MS\b|glioblastoma|GBM|pancreatic cancer)\b/i;
const RECORD_SALES_RX = /\brecord\b[^.]{0,40}\b(revenue|sales)\b/i;

function hasBigPercentGrowth(x: string): boolean {
  const m = x.match(
    /\b(revenue|sales|eps|earnings|arr|bookings|net income)\b[^.%]{0,90}?\b(up|increase[sd]?|grow[n|th|s]?|jump(?:ed)?|soar(?:ed)?|surged)\b[^%]{0,25}?(\d{2,3})\s?%(\s*(y\/y|yoy|year[- ]over[- ]year|q\/q|qoq))?/i
  );
  if (m?.[3]) {
    const pct = parseInt(m[3], 10);
    if (!isNaN(pct) && pct >= 50) return true;
  }
  return RECORD_SALES_RX.test(x);
}
const swingToProfit = (x: string) =>
  /\b(returns?|returned|swing|swung|back)\s+to\s+(profit|profitability|positive (?:net )?income)\b/i.test(
    x
  );

const extractDollars = (x: string): number | null => {
  // returns dollar amount in millions if possible
  const mm = x.match(
    /\$?\s?(\d{1,3}(?:\.\d+)?)\s*(million|billion|bn|mm|m|b)\b/i
  );
  if (mm) {
    const val = parseFloat(mm[1]);
    const unit = mm[2].toLowerCase();
    if (["b", "billion", "bn"].includes(unit)) return val * 1000;
    return val; // already in millions
  }
  const plain = x.match(/\$\s?(\d{6,12})(?!\.)\b/); // raw dollars
  if (plain) {
    const n = parseInt(plain[1], 10);
    return n / 1_000_000;
  }
  return null;
};

// For micro caps, smaller checks matter: treat >=$1–3M as material, >=$7.5–10M as major.
const isMaterialMicroDollar = (
  x: string
): { material: boolean; major: boolean } => {
  const m = extractDollars(x);
  if (m == null) return { material: false, major: false };
  return { material: m >= 1, major: m >= 7.5 };
};

const TIER1_SMALL_VERBS =
  /\b(powered by|built (?:on|with)|integrat(?:es|ed)? with|adopt(?:s|ed)|selects?|standardiz(?:es|ed) on|deploys?|rolls out|invests? in|makes? (?:a )?strategic investment in|expands?|extends?|renews?)\b/i;

/* ---------- Patterns (expanded) ---------- */
const PAT = {
  // Bio / clinical
  pivotal:
    /\b(phase\s*(iii|3)|pivotal|registrational|late[- ]stage)\b.*\b(success|met (?:the )?primary endpoint|statistically significant|p<\s*0?\.\d+)\b/i,
  topline:
    /\b(top-?line)\b.*\b(positive|met (?:the )?primary endpoint|statistically significant|p<\s*0?\.\d+)\b/i,
  midStageWin:
    /\b(phase\s*(ii|2)|mid[- ]stage)\b.*\b(win|successful|success|met|achieved|statistically significant|primary endpoint)\b/i,
  adcom:
    /\b(advisory (committee|panel)|adcom)\b.*\b(vote|voted|recommends?)\b/i,
  approval:
    /\b(FDA|EMA|EC|MHRA|PMDA|NMPA|CFDA|ANVISA|Health Canada|HC|TGA|MFDS|CDSCO|SAHPRA)\b.*\b(approved?|approval|authorized|authori[sz]ation|clearance|clears|EUA|510\(k\)|De\s?Novo|IDE (?:approval|approved))\b/i,
  ukca: /\bukca\b.*\b(mark|certification|certificate)\b.*\b(approval|approved|granted|obtained)\b/i,
  designation:
    /\b(breakthrough (?:therapy|device)|BTD|fast[- ]track|orphan (drug )?designation|PRIME|RMAT)\b/i,
  ndaAcceptOrPriority:
    /\b(FDA|EMA|MHRA|PMDA|NMPA|ANVISA|Health Canada|HC|TGA)\b.*\b(accepts?|accepted|acceptance(?: of| for review)?)\b.*\b((re)?submission|resubmission|NDA|BLA|MAA)\b|\b(priority review)\b/i,
  clinicalHoldLift:
    /\b(FDA)\b.*\b(lifts?|lifted|removes?|removed)\b.*\b(clinical hold)\b/i,

  // *** NEW: generic acquisition announce (micro/OTC phrasing) ***
  mnaAnnounce:
    /\b(announce[sd]?|completes?|completed|closes?|closed)\b[^.]{0,40}\b(acquisition|acquire[sd]?|merger)\b/i,

  // Awards PR
  awardsPR: /\b(award(?:ed)?|honor(?:ed)?|recognition|prize|winner|winning)\b/i,

  strategicAltsOutcome:
    /\b(strategic alternatives|sale process|exploring options|review of alternatives|concluded|completed|outcome|result|sale|transaction)\b.*\b(concluded|completed|resulted|outcome|sale|transaction|agreement|deal)\b/i,
  typoErratum: /\b(typo|erratum|correction|corrects|amended release)\b/i,

  // Strong preclinical / cell model
  preclinNHP:
    /\b(non[- ]?human|nonhuman)\s+primate[s]?\b.*\b(well tolerated|tolerability|safety|safe)\b.*\b(higher than|exceed(?:s|ed)|above)\b.*\b(efficacious|effective)\b/i,
  cellModelEarly:
    /\b(patient[- ]derived|iPSC|neurons?|organoid[s]?)\b.*\b(early (signals?|evidence) of (benefit|efficacy)|signal(?:s)? of (benefit|efficacy)|improv(?:e|ed)|rescue)\b/i,
  singlePivotalPathway:
    /\b(single)\s+(pivotal)\b.*\b(phase\s*(iii|3)|trial|pathway)\b/i,

  // M&A
  mnaBinding:
    /\b(definitive (agreement|merger)|merger agreement (executed|signed)|enter(?:s|ed)? into (a )?definitive (agreement|merger)|business combination( agreement)?|amalgamation agreement|plan of merger)\b/i,
  mnaWillAcquire: /\b(will|to)\s+acquire\b|\bto be acquired\b/i,
  mnaPerShareOrValue:
    /\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share\b|(?:deal|transaction|enterprise|equity)\s+value(?:d)?\s+at\s+\$?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m)\b/i,
  mnaNonBinding: /\b(non[- ]binding|indicative|letter of intent|LOI)\b/i,
  mnaAdminOnly: /\b(extend(s|ed|ing)?|extension)\b.*\b(tender offer|offer)\b/i,
  mnaAssetOrProperty:
    /\b(divestiture|divests?|carve[- ]?out|spin[- ]?off|dispos(?:e|es|ed|al)|asset(?:s)?\s+(?:sale|disposition|purchase)|(?:completes?|closes?)\s+(?:the\s+)?(?:sale|disposition)\s+of|sale\s+of\s+(?:subsidiary|business|unit|division|assets?))\b/i,
  mnaUnsolicitedProposal:
    /\b(unsolicited|non[- ]binding|indicative)\b.*\b(proposal|offer)\b.*(?:\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share|valu(?:e|ed)\s+at\s+\$?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m))\b/i,
  mnaPremiumMention:
    /\brepresent(?:s|ed)?\s+(?:an?\s+)?(\d{2,3})\s?%\s+premium\b/i,

  // Spin / distribution
  spinOffDist:
    /\b(spin[- ]?off|separation|separate[sd]?|split[- ]?off)\b.*\b(record date|distribution date|when[- ]issued|Form\s*10)\b/i,

  // Partnerships / contracts / gov
  partnershipAny:
    /\b(partner(?:ship)?|strategic (?:alliance|partnership)|joint venture|JV|collaborat(?:e|ion)|co[- ]develop|co[- ]produce|distribution|licen[cs]e|supply|integration|deployment|offtake|off[- ]?take)\b/i, // ⭐ NEW: offtake key
  dealSigned:
    /\b(signed|signs|inks?|enter(?:s|ed)? into)\b.*\b(agreement|deal|contract|MOU|memorandum of understanding|term sheet)\b/i,
  contractAny:
    /\b(contract|award|task order|IDIQ|grant|funding|purchase order|PO|framework agreement|letter of award|LOA)\b/i,
  preferredVendor: /\b(preferred (vendor|supplier|partner)|approved vendor)\b/i,
  pilotAny:
    /\b(pilot|pilot program|trial deployment|proof[- ]of[- ]concept|POC)\b/i,

  govWords:
    /\b(NASA|USSF|Space Force|DoD|Department of Defense|Army|Navy|Air Force|DARPA|BARDA|HHS|NIH|CMS|Medicare|VA|DOE|Department of Energy|Loan Programs Office|LPO|MoD|NHS|European Commission|NIST|NSF)\b/i,
  govEquity:
    /\b(?:government|DoD|Department of Defense|HHS|BARDA|DOE|Department of Energy)\b.*\b(preferred (stock|equity)|equity|investment|warrants?)\b/i,
  govLoan:
    /\b(Department of Energy|DOE|Loan Programs Office|LPO)\b.*\b(loan|conditional commitment)\b.*\$\s?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m)\b/i,

  // Corporate / earnings
  earningsBeatGuideUp:
    /\b(raises?|increas(?:es|ed)|hikes?)\b.*\b(guidance|outlook|forecast)\b|\b(beat[s]?)\b.*\b(consensus|estimates|Street|expectations)\b/i,
  financialResultsOnly:
    /\b(financial results|first quarter|second quarter|third quarter|fourth quarter|first half|second half|H1|H2|fiscal (?:Q\d|year) results)\b/i,

  // Reimbursement / policy tailwinds
  reimbursementWin:
    /\b(CMS|Medicare)\b.*\b(NTAP|new (technology|tech) add[- ]on payment|transitional pass[- ]through|TPT|HCPCS(?:\s*code)?\s*[A-Z0-9]+|reimbursement (?:increase|raised|higher|set at))\b/i,

  indexInclusion:
    /\b(added|to be added|to join|inclusion|included)\b.*\b(Russell\s?(2000|3000|Microcap)|MSCI|S&P\s?(500|400|600)|S&P\/TSX(?:\sComposite)?|S&P Dow Jones Indices|FTSE)\b/i,
  uplist:
    /\b(uplisting|uplist|approved to list|approved for listing|to list on)\b.*\b(Nasdaq|NYSE|NYSE American)\b/i,
  listingCompliance:
    /\b(regain(?:ed|s)?|returns? to|back in)\b.*\b(compliance)\b.*\b(Nasdaq|NYSE|listing)\b/i,

  // Special cash dividend
  specialDividend:
    /\b(special (cash )?dividend)\b.*\$\s?\d+(?:\.\d+)?\s*(?:per|\/)\s*share|\b(special (cash )?dividend of)\s*\$\s?\d+(?:\.\d+)?\b/i,

  // Buybacks / debt / bankruptcy exit
  buyback:
    /\b(share repurchase|buyback|issuer tender offer|dutch auction)\b.*\b(authorized|authorization|increase|announc(?:es|ed)|commence(?:s|d)|launch(?:es|ed))\b/i,
  debtReduce:
    /\b(redeem(?:s|ed|ing)?|retire(?:s|d|ment)|repay(?:s|ment|s|ed)|extinguish(?:es|ment))\b.*\b(debt|notes?|debentures|convertible (?:notes|debentures)|term loan|credit facility)\b/i,
  ch11Exit:
    /\b(emerges?|emergence)\b.*\b(chapter\s*11|bankruptcy)\b|\b(plan of reorganization)\b.*\b(confirm(?:ed|ation))\b/i,

  // Legal / meme
  courtWin:
    /\b(court|judge|ITC|PTAB)\b.*\b(grants?|wins?|injunction|vacates?|stays?|exclusion order)\b/i,
  courtDismiss:
    /\b(dismiss(?:es|ed|al)|with prejudice|case (?:is|was)?\s*dismissed)\b/i,
  legalSettlementRoyalties:
    /\b(settlement|settles)\b.*\b(royalt(?:y|ies)|minimum payments?|licensing revenue|lump[- ]sum)\b/i,
  memeOrInfluencer:
    /\b(Roaring Kitty|Keith Gill|meme stock|wallstreetbets|WSB|Jensen Huang|Nvidia (blog|mention))\b/i,

  // Name-drop only (explicitly not partnerships)
  nameDropContext:
    /\b(mention(?:ed)?|blog|keynote|showcase|featured|ecosystem|catalog|marketplace|listing)\b/i,

  // Low-impact blocks
  proxyAdvisor:
    /\b(ISS|Institutional Shareholder Services|Glass Lewis)\b.*\b(recommend(s|ed)?|support(s|ed)?)\b.*\b(vote|proposal|deal|merger)\b/i,
  voteAdminOnly:
    /\b(definitive proxy|proxy (statement|materials)|special meeting|annual meeting|extraordinary general meeting|EGM|shareholder vote|record date)\b/i,
  lawFirmPR:
    /\b(class action|securities class action|investor (?:lawsuit|alert|reminder)|deadline alert|shareholder rights law firm|securities litigation|investigat(?:ion|ing)|Hagens Berman|Pomerantz|Rosen Law Firm|Glancy Prongay|Bronstein[, ]+Gewirtz|Kahn Swick|Saxena White|Kessler Topaz|Levi & Korsinsky)\b/i,
  securityIncidentUpdate:
    /\b(cyber(?:security)?|security|ransomware|data (?:breach|exposure)|cyber[- ]?attack)\b.*\b(update|updated|provid(?:e|es)d? an? update)\b/i,
  investorConfs:
    /\b(participat(e|es|ing)|to participate|will participate)\b.*\b(investor (?:conference|conferences)|conference|fireside chat|non-deal roadshow)\b/i,
  misinfo:
    /\b(misinformation|unauthorized (press )?release|retracts? (?:a )?press release|clarif(?:y|ies) misinformation)\b/i,

  analystMedia:
    /\b(analyst|media coverage|initiates? coverage|upgrades?|downgrades?|price target|research report|buy rating|sell rating|neutral rating)\b/i,

  // Financing / dilution guards
  shelfOrATM:
    /\b(Form\s*S-3|shelf registration|at[- ]the[- ]market|ATM (program|facility))\b/i,
  plainDilution:
    /\b(securities purchase agreement|registered direct|PIPE|private placement|unit financing|equity offering|warrants?)\b/i,
  antiDilutionPositive:
    /\b(terminates?|terminated|withdraws?|withdrawn|cancels?|cancelled|reduces?|downsized?)\b.*\b(offering|registered direct|ATM|at[- ]the[- ]market|public offering|securities purchase agreement)\b/i,

  // Crypto / treasury catalysts
  cryptoTreasuryBuy:
    /\b(buy|bought|purchase[sd]?|acquire[sd]?)\b.*\b(Bitcoin|BTC|Ethereum|ETH|Solana|SOL|LINK|Chainlink|crypto(?:currency)?|tokens?)\b/i,
  cryptoTreasuryDiscuss:
    /\b(treasury|reserve|policy|program|strategy)\b.*\b(discuss(?:ions?)?|approached|proposal|term sheet|non[- ]binding|indicative)\b.*\b(\$?\d+(?:\.\d+)?\s*(?:million|billion|bn|mm|m))\b/i,
  cryptoTreasuryInitiate:
    /\b(launch(?:es|ed)?|initiat(?:es|ed|ing)|adopt(?:s|ed|ing)|establish(?:es|ed|ing)|implement(?:s|ed|ing)|convert(?:s|ed|ing)\s+(?:a |portion of )?cash\s+(?:to|into))\b[^.]{0,120}\b(Bitcoin|BTC)\b[^.]{0,120}\b(treasury|reserve)\b[^.]{0,120}\b(strategy|program|policy|framework|asset)\b/i,

  patentGrant:
    /\b(U\.?S\.?|US)\s+patent\b.*\b(grant(?:ed)?|issued?|notice of allowance)\b/i,

  // IPO patterns
  ipoPrice: /\b(prices?|priced)\b.*\b(initial public offering|IPO)\b/i,
  ipoBeginTrade:
    /\b(begins?|commences?)\s+trading\b.*\b(Nasdaq|NYSE|NYSE American)\b/i,

  // --- Micro/OTC specific ---
  nameTickerChange:
    /\b(renam(?:e|ed|es)|name change|changes? (its )?name|ticker (?:symbol )?chang(?:e|es|ed)|to trade under)\b/i,
  reverseSplit: /\b(reverse(?: |-)?split|stock consolidation)\b/i,
  reverseSplitRatio: /\b(\d{1,3})\s*[-:\/]\s*1\b.*\breverse(?: |-)?split\b/i,
  rsWithUplist:
    /\breverse(?: |-)?split\b[^.]{0,120}\b(uplist|Nasdaq|NYSE|compliance plan|deficiency plan|hearing panel)\b/i,
  otcCERemoved:
    /\b(Caveat Emptor|CE)\b.*\b(removed|removal)\b|\b(resume(?:s|d)?\s+trading)\b.*\b(OTC|Pink|QB|QX)\b/i,
  goingConcernRemoved:
    /\b(going[- ]concern)\b.*\b(removed|no longer|eliminated|lifted)\b/i,
  auditCured:
    /\b(10-K|10-Q|annual report|quarterly report)\b.*\b(filed|re-filed|become[s]? current|brings? filings current|cures? delinquency)\b/i,
  insiderBuy:
    /\b(Form\s*4|purchases?|buys?)\b.*\b(director|officer|CEO|CFO|insider|management)\b/i,
  insiderCluster:
    /\b(multiple|several|numerous)\b.*\b(Form\s*4|insider purchases?)\b/i,
  toxicTerminated:
    /\b(terminat(?:es|ed)|cancels?|withdraws?|ends?)\b.*\b(Equity Line|ELOC|SEPA|S-3|ATM|convertible (notes?|debentures)|toxic|dilut(?:ive|ion))\b/i,
  asReduced:
    /\b(authori[sz]ed|authorized)\s+shares?\b.*\b(reduc(?:ed|es|tion)|cut|decrease)\b/i,
  noWarrantsNoRS:
    /\b(no (?:warrants?|pre[- ]funded warrants?|rights)|no reverse split|without (?:warrants|a reverse split))\b/i,
  distributionDeal:
    /\b(distribution|distributor|reseller|channel partner|wholesale)\b.*\b(agreement|deal|contract)\b/i,
  purchaseOrder:
    /\b(purchase order|PO)\b.*\b(received|secured|award(?:ed)?)\b/i,
  retailChains:
    /\b(Walmart|Target|Costco|Best Buy|Amazon|Home Depot|Lowe'?s|Walgreens|CVS|Kroger|Tesco|Carrefour)\b/i,
  custodianshipRM:
    /\b(custodianship|receiver|reverse merger|RTO|business combination)\b.*\b(granted|approved|definitive|agreement)\b/i,
  aiPivot:
    /\b(AI|artificial intelligence|LLM|GPT)\b.*\b(pivot|strategy|initiative|platform|integration|launch(?:es|ed)?)\b/i,
  cryptoPivot:
    /\b(Bitcoin|BTC|crypto|Web3|blockchain|Ethereum|ETH|Solana|SOL)\b.*\b(treasury|pivot|strategy|mining|hashrate|node|validator|reserve)\b/i,

  /* ⭐ NEW: Mining/OTC transformational financing & build */
  projectFinance:
    /\b(secures?|obtains?|arranges?|closes?|executes?|signs?)\b[^.]{0,60}\b(gold loan|loan|credit facility|project financing|project finance|debt financing|term loan|royalty(?:\s+financing)?|stream(?:ing)? (?:deal|agreement)|non[- ]dilutive (?:financing|funding))\b[^.]{0,120}\b(fully\s*fund|fund(?:ing)?|capex|capital (?:cost|expenditure)|construction|starter (?:operation|project)|heap[- ]?leach|mine (?:build|construction))\b/i,
  /* ⭐ NEW: Construction decision / FID / go-ahead */
  constructionDecision:
    /\b(board of directors )?approv(?:es|ed)\b[^.]{0,80}\b(construction|final investment decision|FID|go[- ]ahead|build)\b/i,
  /* ⭐ NEW: Commencement of production/operations */
  productionStart:
    /\b(commenc(?:es|ed|ing)|begin(?:s|ning)|starts?|started)\b[^.]{0,80}\b(production|processing|mining|operations?|heap[- ]?leach)\b/i,
  /* ⭐ NEW: Permitting / license milestones */
  permitGrant:
    /\b(permit|licen[cs]e|environmental|IBAMA|IBAMA\/SEMAS|EIA|EIS|concession)\b[^.]{0,60}\b(approved|granted|received|obtained|issued)\b/i,
  /* ⭐ NEW: Royalty/stream standalone (often funding) */
  royaltyStream:
    /\b(royalty|stream(?:ing)?)\b[^.]{0,60}\b(agreement|financing|facility|transaction|deal)\b/i,
  /* ⭐ NEW: Feasibility economics (signal for mining) */
  feasStudy:
    /\b(pre[- ]?feasibility|feasibility (?:study)?|PFS|DFS)\b[^.]{0,60}\b(released|updated|results?|positive|economics?)\b/i,
  econBuzz: /\b(NPV|IRR|payback|all[- ]in sustaining cost|AISC)\b/i,
};

/** Micro-cap dollar/scale helpers */
const LARGE_DOLLARS = /\$?\s?(?:\d{2,4})\s*(?:million|billion|bn|mm|m)\b/i;
const SCALE =
  /\b(multi[- ]year|nationwide|global|enterprise[- ]wide|rollout)\b/i;

type ScoreHit = { label: HighImpactEvent; w: number; why: string };

function classifyOne(it: RawItem): { event: HighImpactEvent; score: number } {
  const title = normalize(it.title || "");
  // ⭐ include .text too (some feeds omit summary)
  const body = normalize((it as any).summary || (it as any).text || "");
  const x = `${title}\n${body}`;
  const url = (it as any).url as string | undefined;

  // --- Hard guards / early exits ---
  if (PAT.misinfo.test(x)) return { event: "OTHER", score: 0 };
  if (PAT.securityIncidentUpdate.test(x)) return { event: "OTHER", score: 0 };
  if (PAT.awardsPR.test(x)) return { event: "OTHER", score: 0 };
  if (PAT.nameTickerChange.test(x)) return { event: "OTHER", score: 0 };
  if (
    (PAT.proxyAdvisor.test(x) || PAT.voteAdminOnly.test(x)) &&
    !PAT.mnaBinding.test(x)
  )
    return { event: "OTHER", score: 0 };
  if (PAT.investorConfs.test(x)) return { event: "OTHER", score: 0 };
  if (PAT.lawFirmPR.test(x)) return { event: "OTHER", score: 0 };
  if (PAT.analystMedia.test(x)) return { event: "OTHER", score: 0 };
  if (PAT.typoErratum?.test?.(x)) return { event: "OTHER", score: 0 };

  // Plain dilution: generally kill it, unless premium/no-warrant or RS-uplist path
  if (PAT.plainDilution.test(x)) {
    const premium = /premium|above[- ]market/i.test(x);
    const noDilutionKeys =
      PAT.noWarrantsNoRS.test(x) || PAT.antiDilutionPositive.test(x);
    const rsUplist = PAT.rsWithUplist.test(x);
    if (!(premium || noDilutionKeys || rsUplist))
      return { event: "OTHER", score: 0.1 };
  }

  const isPR = isWirePR(url, x);
  const hits: ScoreHit[] = [];
  const push = (
    ok: boolean,
    label: HighImpactEvent,
    w: number,
    why: string
  ) => {
    if (ok) hits.push({ label, w, why });
  };

  // --- Positive rules ---

  // Bio / regulatory (wire preferred)
  if (isPR) {
    push(
      PAT.approval.test(x) || PAT.ukca.test(x),
      "FDA_MARKETING_AUTH",
      10,
      "approval"
    );
    push(PAT.adcom.test(x), "FDA_ADCOM_POSITIVE", 8, "adcom_positive");
    push(
      PAT.pivotal.test(x) || PAT.topline.test(x) || PAT.midStageWin.test(x),
      "PIVOTAL_TRIAL_SUCCESS",
      9,
      "pivotal_or_topline"
    );
    push(PAT.designation.test(x), "REGULATORY_DESIGNATION", 6, "designation");
  }
  push(
    PAT.ndaAcceptOrPriority.test(x),
    "PIVOTAL_TRIAL_SUCCESS",
    6,
    "nda_priority"
  );
  push(PAT.clinicalHoldLift.test(x), "PIVOTAL_TRIAL_SUCCESS", 6, "hold_lift");

  // M&A (incl. announce phrasing)
  {
    const binding =
      PAT.mnaBinding.test(x) ||
      (PAT.mnaWillAcquire.test(x) && PAT.mnaPerShareOrValue.test(x));
    const announce = PAT.mnaAnnounce.test(x);
    const nonbind = PAT.mnaNonBinding.test(x);
    const admin = PAT.mnaAdminOnly.test(x);
    const asset = PAT.mnaAssetOrProperty.test(x);
    const unsolicited = PAT.mnaUnsolicitedProposal.test(x);
    const hasPremium = PAT.mnaPremiumMention.test(x);

    push(
      binding && !nonbind && !admin && !asset,
      "ACQUISITION_BUYOUT",
      9,
      "mna_binding"
    );
    push(announce && !asset, "ACQUISITION_BUYOUT", 7, "mna_announce");
    push(
      unsolicited && !admin && !asset,
      "ACQUISITION_BUYOUT",
      6,
      "mna_unsolicited_priced"
    );
    if (nonbind || admin || asset) push(true, "OTHER", 2, "mna_low_impact");
    push(
      PAT.strategicAltsOutcome?.test?.(x) || false,
      "ACQUISITION_BUYOUT",
      7,
      "alts_concluded_sale"
    );
    if (hasPremium) push(true, "ACQUISITION_BUYOUT", 2, "premium_mention");
  }

  // Spin-offs / distributions
  if (PAT.spinOffDist.test(x))
    push(true, "RESTRUCTURING_OR_FINANCING", 6, "spin_off_distribution");

  // Gov / partnerships (allow smaller $ for microcaps)
  {
    const govContract = PAT.govWords.test(x) && PAT.contractAny.test(x);
    const govEquity = PAT.govEquity.test(x);
    const govLoan = PAT.govLoan.test(x);
    const nameDropOnly =
      TIER1_RX.test(x) &&
      !(
        PAT.partnershipAny.test(x) ||
        PAT.contractAny.test(x) ||
        PAT.dealSigned.test(x) ||
        PAT.preferredVendor.test(x) ||
        PAT.pilotAny.test(x)
      ) &&
      PAT.nameDropContext.test(x);

    if (
      isPR &&
      govContract &&
      !/\b(continued production|follow[- ]on|option (exercise|exercised)|extension|renewal)\b/i.test(
        x
      )
    )
      push(true, "MAJOR_GOV_CONTRACT", 8, "gov_contract");
    else if (isPR && govContract) push(true, "OTHER", 2, "gov_routine");

    push(govEquity, "GOVERNMENT_EQUITY_OR_GRANT", 9, "gov_equity");
    push(govLoan, "MAJOR_GOV_CONTRACT", 8, "gov_loan");

    const isPartnership =
      PAT.partnershipAny.test(x) ||
      PAT.contractAny.test(x) ||
      PAT.dealSigned.test(x) ||
      PAT.preferredVendor.test(x) ||
      (TIER1_RX.test(x) && (TIER1_SMALL_VERBS.test(x) || PAT.pilotAny.test(x)));

    if (isPartnership && !nameDropOnly) {
      const { material, major } = isMaterialMicroDollar(x);
      push(
        true,
        "TIER1_PARTNERSHIP",
        (TIER1_RX.test(x) ? 7 : 5) + (major ? 1 : material ? 0 : 0),
        "partner_or_contract"
      );
    }
    if (!isPartnership && nameDropOnly)
      push(true, "MEME_OR_INFLUENCER", 4, "tier1_name_drop_only");
  }

  // Corporate (earnings require beat/raise OR big KPI spike)
  {
    const beatOrGuide = PAT.earningsBeatGuideUp.test(x);
    const bigKPI = swingToProfit(x) || hasBigPercentGrowth(x);
    push(
      beatOrGuide || bigKPI,
      "EARNINGS_BEAT_OR_GUIDE_UP",
      beatOrGuide ? 6 : 5,
      beatOrGuide ? "earnings" : "kpi_spike"
    );

    if (PAT.indexInclusion.test(x))
      push(true, "INDEX_INCLUSION", 3, "index_inclusion");
    push(PAT.uplist.test(x), "UPLISTING_TO_NASDAQ", 6, "uplist");
    push(
      PAT.listingCompliance.test(x),
      "UPLISTING_TO_NASDAQ",
      6,
      "compliance_regained"
    );
  }

  // Reimbursement / policy
  push(
    PAT.reimbursementWin.test(x),
    "POLICY_OR_POLITICS_TAILWIND",
    6,
    "reimbursement_win"
  );

  // Special dividend
  if (PAT.specialDividend.test(x))
    push(true, "RESTRUCTURING_OR_FINANCING", 7, "special_dividend");

  // Buybacks / debt / ch11 exit
  if (PAT.buyback.test(x)) {
    const dollars = extractDollars(x);
    const baseW = 6 + ((dollars ?? 0) >= 10 ? 1 : 0);
    push(true, "RESTRUCTURING_OR_FINANCING", baseW, "buyback_or_tender");
  }
  if (PAT.debtReduce.test(x))
    push(true, "RESTRUCTURING_OR_FINANCING", 5, "debt_reduction");
  if (PAT.ch11Exit.test(x))
    push(true, "RESTRUCTURING_OR_FINANCING", 6, "chapter11_exit");

  // Legal / meme
  push(PAT.courtWin.test(x), "COURT_WIN_INJUNCTION", 6, "court");
  push(PAT.courtDismiss.test(x), "COURT_WIN_INJUNCTION", 5, "court_dismissal");
  push(
    PAT.legalSettlementRoyalties.test(x),
    "COURT_WIN_INJUNCTION",
    5,
    "settlement_royalties"
  );
  push(PAT.memeOrInfluencer.test(x), "MEME_OR_INFLUENCER", 6, "influencer");

  // Crypto / treasury catalysts
  if (PAT.cryptoTreasuryBuy.test(x))
    push(true, "CRYPTO_OR_AI_TREASURY_PIVOT", 7, "crypto_treasury_buy");
  if (PAT.cryptoTreasuryDiscuss.test(x))
    push(true, "CRYPTO_OR_AI_TREASURY_PIVOT", 6, "crypto_treasury_discuss");
  if (PAT.cryptoTreasuryInitiate.test(x)) {
    const { major } = isMaterialMicroDollar(x);
    push(
      true,
      "CRYPTO_OR_AI_TREASURY_PIVOT",
      7 + (major ? 1 : 0),
      "crypto_treasury_initiate"
    );
  }

  // IPO
  if (isPR && (PAT.ipoPrice.test(x) || PAT.ipoBeginTrade.test(x)))
    push(true, "IPO_DEBUT_POP", 6, "ipo");

  // Positive financing exception
  if (PAT.antiDilutionPositive.test(x))
    push(true, "TOXIC_FINANCING_TERMINATED", 7, "anti_dilution_positive");
  if (PAT.noWarrantsNoRS.test(x))
    push(true, "DILUTION_FREE_INVESTMENT", 7, "no_warrants_no_rs");

  // Informational only
  if (PAT.patentGrant.test(x)) push(true, "OTHER", 1, "patent_grant_info");

  // --- Micro/OTC: additive positives ---
  if (PAT.rsWithUplist.test(x))
    push(true, "REVERSE_SPLIT_UPLIST_PATH", 7, "rs_with_uplist_plan");
  if (PAT.otcCERemoved.test(x))
    push(true, "CE_REMOVAL_OR_RESUME_TRADING", 8, "ce_removed_or_resume");
  if (PAT.goingConcernRemoved.test(x))
    push(true, "GOING_CONCERN_REMOVED", 6, "going_concern_removed");
  if (PAT.auditCured.test(x))
    push(true, "AUDIT_COMPLETED_FILINGS_CURED", 6, "filings_cured_current");
  if (PAT.custodianshipRM.test(x))
    push(
      true,
      "CUSTODIANSHIP_OR_RM_DEAL",
      7,
      "custodianship_or_reverse_merger"
    );

  if (PAT.insiderCluster.test(x))
    push(true, "INSIDER_BUY_CLUSTER", 7, "insider_buy_cluster");
  else if (PAT.insiderBuy.test(x))
    push(true, "INSIDER_BUY_CLUSTER", 5, "insider_buy_single");

  if (PAT.toxicTerminated.test(x))
    push(true, "TOXIC_FINANCING_TERMINATED", 7, "toxic_financing_terminated");
  if (PAT.asReduced.test(x))
    push(true, "AUTHORIZED_SHARES_REDUCED", 6, "authorized_shares_reduced");

  // Distribution / orders
  if (PAT.distributionDeal.test(x) || PAT.purchaseOrder.test(x)) {
    const { material, major } = isMaterialMicroDollar(x);
    const namedChains = PAT.retailChains.test(x);
    const w = 5 + (material ? 1 : 0) + (major ? 1 : 0) + (namedChains ? 1 : 0);
    push(
      true,
      namedChains ? "DISTRIBUTION_AGREEMENT_MATERIAL" : "LARGE_ORDER_RELATIVE",
      w,
      "distribution_or_po"
    );
  }

  // AI/crypto pivots (require concrete action words)
  if (
    PAT.aiPivot.test(x) &&
    /(launch|deploy|integrat|contract|order|revenue|customer|PO|purchase|binding)/i.test(
      x
    )
  )
    push(true, "CRYPTO_OR_AI_TREASURY_PIVOT", 6, "ai_pivot_action");

  // ⭐ NEW: Feasibility & economics (supporting boost for miners)
  if (PAT.feasStudy.test(x) && PAT.econBuzz.test(x)) {
    const dollars = isMaterialMicroDollar(x);
    push(
      true,
      "RESTRUCTURING_OR_FINANCING",
      5 + (dollars.material ? 1 : 0),
      "feas_economics"
    );
  }

  // ⭐ NEW: Royalty/stream standalone
  if (PAT.royaltyStream.test(x)) {
    const dollars = isMaterialMicroDollar(x);
    push(
      true,
      "RESTRUCTURING_OR_FINANCING",
      6 + (dollars.major ? 2 : dollars.material ? 1 : 0),
      "royalty_stream_funding"
    );
  }

  // ⭐ NEW: Project finance / construction / production / permits
  if (
    PAT.projectFinance.test(x) ||
    PAT.constructionDecision.test(x) ||
    PAT.productionStart.test(x) ||
    PAT.permitGrant.test(x)
  ) {
    const dollars = isMaterialMicroDollar(x);
    let w = 7 + (isPR ? 1 : 0) + (dollars.major ? 2 : dollars.material ? 1 : 0);
    if (PAT.projectFinance.test(x) && PAT.constructionDecision.test(x)) w += 1; // synergy
    if (PAT.productionStart.test(x)) w += 1; // production tends to pop
    w = Math.min(9, w);
    push(
      true,
      "RESTRUCTURING_OR_FINANCING",
      w,
      "project_finance_build_ops_permit"
    );
  }

  /* 🛟 SAFEGUARD: Great-PR heuristic so real wire PRs don’t fall to OTHER
     If it's a real wire PR, mentions big $, and uses strong action words,
     ensure we classify as a catalyst rather than OTHER. */
  if (hits.length === 0 && isPR) {
    const dollars = isMaterialMicroDollar(x);
    const strongAction =
      /\b(definitive|binding|execut(?:e|ed|ion)|close[sd]?|commenc(?:e|ed|ing)|approved|granted|awarded|contract|agreement|loan|facility|financing|offtake|royalty|stream)\b/i.test(
        x
      );
    if ((dollars.material || /fully\s*fund/i.test(x)) && strongAction) {
      // Default to restructuring/financing with moderate strength
      const base = 6 + (dollars.major ? 2 : dollars.material ? 1 : 0);
      push(
        true,
        "RESTRUCTURING_OR_FINANCING",
        Math.min(8, base),
        "safeguard_wire_material"
      );
    }
  }

  if (!hits.length) return { event: "OTHER", score: 0 };

  // Combine hits
  const by = new Map<HighImpactEvent, number>();
  for (const h of hits) by.set(h.label, (by.get(h.label) ?? 0) + h.w);

  // Synergies / boosters
  if (by.has("PIVOTAL_TRIAL_SUCCESS") && by.has("FDA_MARKETING_AUTH"))
    by.set("FDA_MARKETING_AUTH", (by.get("FDA_MARKETING_AUTH") ?? 0) + 3);

  const hasScaleMoney =
    LARGE_DOLLARS.test(x) || SCALE.test(x) || isMaterialMicroDollar(x).material;
  if (
    (by.has("TIER1_PARTNERSHIP") ||
      by.has("MAJOR_GOV_CONTRACT") ||
      by.has("GOVERNMENT_EQUITY_OR_GRANT")) &&
    hasScaleMoney
  ) {
    by.set("OTHER", (by.get("OTHER") ?? 0) + 2); // slight boost to total
  }

  // RS + Uplist gets a booster if filings cured or compliance regained
  if (
    by.has("REVERSE_SPLIT_UPLIST_PATH") &&
    (by.has("AUDIT_COMPLETED_FILINGS_CURED") ||
      /deficiency plan accepted|panel grants/i.test(x))
  ) {
    by.set(
      "REVERSE_SPLIT_UPLIST_PATH",
      (by.get("REVERSE_SPLIT_UPLIST_PATH") ?? 0) + 2
    );
  }

  // Large order + named retailer booster
  if (
    (by.has("LARGE_ORDER_RELATIVE") ||
      by.has("DISTRIBUTION_AGREEMENT_MATERIAL")) &&
    PAT.retailChains.test(x)
  ) {
    const key = by.has("DISTRIBUTION_AGREEMENT_MATERIAL")
      ? "DISTRIBUTION_AGREEMENT_MATERIAL"
      : "LARGE_ORDER_RELATIVE";
    by.set(key as HighImpactEvent, (by.get(key as HighImpactEvent) ?? 0) + 1);
  }

  const total = [...by.values()].reduce((a, b) => a + b, 0);
  const strongCatalyst =
    (by.get("ACQUISITION_BUYOUT") ?? 0) >= 8 ||
    (by.get("FDA_MARKETING_AUTH") ?? 0) >= 8 ||
    (by.get("PIVOTAL_TRIAL_SUCCESS") ?? 0) >= 8 ||
    (by.get("MAJOR_GOV_CONTRACT") ?? 0) >= 8 ||
    (by.get("RESTRUCTURING_OR_FINANCING") ?? 0) >= 7 ||
    (by.get("UPLISTING_TO_NASDAQ") ?? 0) >= 6 ||
    (by.get("REVERSE_SPLIT_UPLIST_PATH") ?? 0) >= 7 ||
    (by.get("CE_REMOVAL_OR_RESUME_TRADING") ?? 0) >= 7 ||
    (by.get("INSIDER_BUY_CLUSTER") ?? 0) >= 7 ||
    (by.get("TOXIC_FINANCING_TERMINATED") ?? 0) >= 7 ||
    (by.get("LARGE_ORDER_RELATIVE") ?? 0) >= 6 ||
    (by.get("DISTRIBUTION_AGREEMENT_MATERIAL") ?? 0) >= 6;

  if (total <= 0 && !strongCatalyst) return { event: "OTHER", score: 0 };

  const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  const event = top ? (top[0] as HighImpactEvent) : "OTHER";
  const score = top ? top[1] : 0;
  return { event, score };
}

/** Public API */
export function classify(items: RawItem[]): ClassifiedItem[] {
  return items.map((it) => {
    const { event, score } = classifyOne(it);
    return { ...it, klass: event as EventClass, score };
  });
}
