// src/pipeline/fetchBenzingaPressReleases.ts
import axios from "axios";
import { cfg } from "../config.js";
import type { RawItem } from "../types.js";
import { log } from "../logger.js";

/** Params for press-release fetch + market-cap filter. */
interface FetchBenzingaPressReleases {
  /** How many paginated PR pages to pull (logical pages for the provider). */
  maxPages?: number;
  /** Keep PRs whose issuer market cap is >= this (in USD). Omit to disable lower bound. */
  minMarketCap?: number;
  /** Keep PRs whose issuer market cap is <= this (in USD). Omit to disable upper bound. */
  maxMarketCap?: number;
  /**
   * If true, keep PRs when we *can’t* resolve a market cap for the symbol.
   * If false, drop those PRs. Defaults to false (be strict).
   */
  includeUnknownMktCap?: boolean;
  /** Only keep PRs published within the last N minutes. Set 0/undefined to skip time filter. */
  lookbackMinutes?: number;
}

/** --- Small helper: fetch market caps for a set of symbols (batched) --- */
async function fetchMarketCaps(
  symbols: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!symbols.length || !cfg.FMP_API_KEY) return out;

  // FMP supports comma-separated symbols on /api/v3/quote; chunk conservatively.
  const chunkSize = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }

  for (const chunk of chunks) {
    try {
      const { data } = await axios.get(
        "https://financialmodelingprep.com/api/v3/quote/" + chunk.join(","),
        { params: { apikey: cfg.FMP_API_KEY }, timeout: 8000 }
      );
      // Expected shape: [{ symbol: "AAPL", marketCap: 3.9e12, ... }, ...]
      if (Array.isArray(data)) {
        for (const row of data) {
          const sym = String(row?.symbol || "").trim();
          const cap = Number(row?.marketCap);
          if (sym) out.set(sym, Number.isFinite(cap) ? cap : NaN);
        }
      }
    } catch (e) {
      log.warn("[FMP] error fetching market caps", {
        symbols: chunk,
        error: e,
      });
    }
  }
  return out;
}

/** FMP Press Releases (paged “latest”), with the same market-cap filtering. */
export async function fetchFmpPressReleases(
  params: FetchBenzingaPressReleases = {}
): Promise<RawItem[]> {
  const {
    maxPages = 1,
    minMarketCap = 0,
    maxMarketCap = 30_000_000,
    includeUnknownMktCap = false,
  } = params;

  const out: RawItem[] = [];

  if (!cfg.FMP_API_KEY) {
    log.warn("[FMP] FMP_API_KEY missing — returning empty set");
    return out;
  }

  // Helper to normalize a single FMP PR row into RawItem
  const mapRow = (d: any): RawItem | null => {
    // FMP stable/legacy fields we’ve seen:
    // symbol | tickers[], date | publishedDate, title, text | content | description, url | link
    const symbolsArr: string[] = [];
    if (typeof d?.symbol === "string" && d.symbol.trim())
      symbolsArr.push(d.symbol.trim().toUpperCase());
    if (Array.isArray(d?.tickers)) {
      for (const t of d.tickers) {
        if (typeof t === "string" && t.trim())
          symbolsArr.push(t.trim().toUpperCase());
      }
    }
    const symbols = Array.from(new Set(symbolsArr));

    const published =
      (typeof d?.date === "string" && d.date) ||
      (typeof d?.publishedDate === "string" && d.publishedDate) ||
      null;

    const url = d?.url || d?.link || undefined;
    const title = d?.title || "";
    const body = d?.text || d?.content || d?.description || "";

    // Drop obviously empty
    if (!title && !body) return null;

    const firstSym = symbols[0] || "NA";
    const id = `${firstSym}|${published ?? ""}|${url ?? ""}`;

    const item: RawItem = {
      id,
      url,
      title,
      summary: body,
      source: "fmp_pr",
      publishedAt: published ?? null,
      symbols,
    };
    return item;
  };

  const stableBase =
    "https://financialmodelingprep.com/stable/news/press-releases-latest";
  const legacyBase = "https://financialmodelingprep.com/api/v3/press-releases";

  for (let page = 0; page < maxPages; page++) {
    // Try STABLE first; if it fails, fall back to LEGACY for this page
    let data: any = null;

    try {
      const { data: stableData } = await axios.get(stableBase, {
        params: { page, limit: 25, apikey: cfg.FMP_API_KEY },
        timeout: 8000,
      });
      data = stableData;
    } catch (e) {
      log.warn("[FMP] stable press-releases failed, falling back to legacy", {
        page,
        error: (e as any)?.message,
      });
      try {
        const { data: legacyData } = await axios.get(legacyBase, {
          params: { page, apikey: cfg.FMP_API_KEY },
          timeout: 8000,
        });
        data = legacyData;
      } catch (ee) {
        log.warn("[FMP] legacy press-releases failed", {
          page,
          error: (ee as any)?.message,
        });
        continue; // try next page
      }
    }

    const rows: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
      ? data.items
      : [];
    if (!rows.length) {
      // Likely end of feed
      if (page > 0) break;
      continue;
    }

    const mapped = rows.map(mapRow).filter((x): x is RawItem => !!x);

    out.push(...mapped);

    log.info("[FMP] fetched press releases page", {
      page,
      articles: mapped.length,
    });
  }

  log.info("[FMP] total raw PR items", { items: out.length });
  if (!out.length) return out;

  // --- Resolve caps, then filter (same logic as Benzinga) ---
  const uniqueSymbols = Array.from(
    new Set(out.flatMap((it) => (Array.isArray(it.symbols) ? it.symbols : [])))
  ).filter(Boolean);

  const capMap = await fetchMarketCaps(uniqueSymbols);

  const passesCapFilter = (item: RawItem): boolean => {
    const sym = item.symbols?.[0];
    if (!sym) return includeUnknownMktCap;

    const cap = capMap.get(sym);
    if (!Number.isFinite(cap)) return includeUnknownMktCap;

    if (typeof minMarketCap === "number" && (cap as number) < minMarketCap)
      return false;
    if (typeof maxMarketCap === "number" && (cap as number) > maxMarketCap)
      return false;
    return true;
  };

  const filtered = out.filter(passesCapFilter);

  return filtered;
}

const APIKEY = cfg.FMP_API_KEY; // <-- your FMP key (unchanged for functions below)

// Map FMP / vendor long names & odd variants to canonical short forms
const canonExchange = (raw = ""): string => {
  const u = raw.toUpperCase().trim();

  // --- OTC & grey/expert/pink variants → "OTC"
  const otcLike =
    u === "OTC" ||
    u === "OTCM" ||
    u.includes("OTC ") ||
    u.includes(" OTC") ||
    u.includes("OTCBB") ||
    u.includes("OTC MARKETS") ||
    u.includes("PINK") || // PINK OPEN MARKET / PINK CURRENT / PINK LIMITED / PINK NO INFORMATION
    u.includes("GREY") || // GREY MARKET / GREY SHEET
    u.includes("EXPERT"); // EXPERT MARKET

  if (otcLike) return "OTC";

  // --- NASDAQ tiers
  if (u === "NASDAQ") return "NASDAQ";
  if (u.includes("GLOBAL SELECT")) return "NASDAQGS";
  if (u.includes("GLOBAL MARKET")) return "NASDAQGM";
  if (u.includes("CAPITAL MARKET")) return "NASDAQCM";

  // --- NYSE families
  if (u === "NYSE" || u.includes("NEW YORK STOCK EXCHANGE")) return "NYSE";
  if (u.includes("ARCA")) return "NYSE ARCA";
  if (u.includes("AMERICAN")) return "NYSE AMERICAN";
  if (u === "AMEX") return "AMEX";

  // --- Cboe / BATS
  if (u === "BATS") return "BATS";
  if (u.includes("CBOE BZX")) return "CBOE BZX";
  if (u.includes("CBOE BYX")) return "CBOE BYX";
  if (u.includes("CBOE EDGA")) return "CBOE EDGA";
  if (u.includes("CBOE EDGX")) return "CBOE EDGX";

  // Fallback: return as-is for logging/visibility
  return raw;
};

export async function isExchangeOk(symbol: string): Promise<boolean> {
  try {
    const url = `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(
      symbol
    )}?apikey=${APIKEY}`;
    const r = await axios.get(url, { timeout: 8000 });
    const p = Array.isArray(r.data) && r.data[0] ? r.data[0] : null;
    if (!p) return false;

    // FMP fields seen in the wild:
    //   exchangeShortName: "OTC" | "NASDAQ" | "NYSE" | ...
    //   exchange: "OTC Markets" | "New York Stock Exchange" | "NASDAQ Global Select" | ...
    const exShort = String(p.exchangeShortName ?? "").trim();
    const exLong = String(p.exchange ?? "").trim();

    const exCanon =
      canonExchange(exShort) || canonExchange(exLong) || exShort || exLong;

    // ✅ PASS if it's any OTC flavor (OTC / Pink / Grey / Expert Market variants all normalize to "OTC")
    const isOtc = exCanon === "OTC";

    // Treat missing flag as active; only fail if explicitly false
    const activeOk = (p.isActivelyTrading ?? true) === true;

    // For penny stocks we do NOT gate by price here (you asked to ensure OTC passes in all forms)
    const result = isOtc && activeOk;

    log.info("[FMP] exchange check", {
      symbol,
      exchangeShortName: p.exchangeShortName,
      exchange: p.exchange,
      canonical: exCanon,
      isActivelyTrading: p.isActivelyTrading,
      pass: result,
    });

    return result;
  } catch (e) {
    log.warn("[FMP] exchange check error", {
      symbol,
      error: (e as any)?.message,
    });
    return false;
  }
}
