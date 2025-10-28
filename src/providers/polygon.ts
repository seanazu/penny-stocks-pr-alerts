// src/providers/polygonNews.ts
// Requires Node 18+ (global fetch). If you're on older Node, `npm i undici` and import its fetch.
// Assumes you already have `cfg` (with POLYGON_API_KEY) and `log`, and a `RawItem` type.
import { cfg } from "../config.js";
import { log } from "../logger.js";
import type { RawItem } from "../types.js";

export type FetchPolygonNewsParams = {
  /** How many pages of `next_url` to follow (each page returns up to `limit` items). */
  maxPages?: number;
  /**
   * Optional extra query params to append to Polygon's endpoint.
   * Defaults already include: order=desc, limit=10, sort=published_utc
   * Useful keys: "ticker", "published_utc.gte", "published_utc.lte", "q", "publisher"
   */
  query?: Record<string, string | number | undefined | null>;
};

/**
 * Fetch latest news from Polygon Reference News API and map to RawItem[].
 * Uses: /v2/reference/news?order=desc&limit=10&sort=published_utc&apiKey=...
 * Returns items shaped like fetchFmpPressReleases() -> RawItem[].
 */
export async function fetchPolygonReferenceNews(
  params: FetchPolygonNewsParams = {}
): Promise<RawItem[]> {
  const { maxPages = 1, query = {} } = params;
  const out: RawItem[] = [];

  if (!cfg?.POLYGON_API_KEY) {
    log?.warn?.("[POLYGON] POLYGON_API_KEY missing — returning empty set");
    return out;
  }

  const base = "https://api.polygon.io/v2/reference/news";
  const defaults: Record<string, string> = {
    order: "desc",
    limit: "10",
    sort: "published_utc",
  };

  const qs = new URLSearchParams(defaults);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      qs.set(k, String(v));
    }
  }
  qs.set("apiKey", cfg.POLYGON_API_KEY);

  let url = `${base}?${qs.toString()}`;
  let pagesFetched = 0;

  // De-dupe on our synthesized id to avoid repeats across pages
  const seen = new Set<string>();

  while (url && pagesFetched < maxPages) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log?.warn?.("[POLYGON] non-200 response", {
          status: res.status,
          body: text.slice(0, 200),
        });
        if (res.status === 429) break; // rate limited; bail early
      }

      const data: any = await res.json().catch(() => ({}));
      const rows: any[] = Array.isArray(data?.results) ? data.results : [];

      for (const d of rows) {
        const mapped = mapPolygonRowToRawItem(d);
        if (mapped && !seen.has(mapped.id)) {
          seen.add(mapped.id);
          out.push(mapped);
        }
      }

      pagesFetched += 1;

      const next = (data?.next_url as string | undefined) || "";
      if (next) {
        const u = new URL(next);
        // Polygon sometimes omits apiKey on next_url; ensure it’s present
        if (!u.searchParams.get("apiKey")) {
          u.searchParams.set("apiKey", cfg.POLYGON_API_KEY);
        }
        url = u.toString();
      } else {
        break;
      }
    } catch (err: any) {
      log?.error?.("[POLYGON] fetch error", {
        err: String(err?.message ?? err),
      });
      break;
    }
  }

  return out;
}

/** Normalize a single Polygon news row into your RawItem shape. */
function mapPolygonRowToRawItem(d: any): RawItem | null {
  // Polygon fields (example):
  // id, publisher{...}, title, author, published_utc, article_url, tickers[], amp_url, image_url, description, keywords[], insights[]
  const symbolsArr: string[] = [];
  if (Array.isArray(d?.tickers)) {
    for (const t of d.tickers) {
      if (typeof t === "string" && t.trim()) {
        symbolsArr.push(t.trim().toUpperCase());
      }
    }
  }
  const symbols = Array.from(new Set(symbolsArr));

  const published =
    (typeof d?.published_utc === "string" && d.published_utc) || null;

  const url: string | undefined =
    (typeof d?.article_url === "string" && d.article_url) ||
    (typeof d?.amp_url === "string" && d.amp_url) ||
    undefined;

  const title: string = (typeof d?.title === "string" && d.title) || "";
  const body: string =
    (typeof d?.description === "string" && d.description) || "";

  // Drop obviously empty
  if (!title && !body) return null;

  const firstSym = symbols[0] || "NA";
  const id = `${firstSym}|${published ?? ""}|${url ?? ""}`;

  const item: RawItem = {
    id,
    url,
    title,
    summary: body,
    source: "polygon_news",
    publishedAt: published,
    symbols,
  };
  return item;
}
