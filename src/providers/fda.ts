// src/providers/fda.ts
import axios from "axios";
import * as cheerio from "cheerio";
import type { RawItem } from "../types.js";

/** Canonical FDA pages (update 510(k) URL yearly if it rolls). */
const FDA_URLS = {
  DRUGS_WHATS_NEW:
    "https://www.fda.gov/drugs/news-events-human-drugs/whats-new-related-drugs",
  PRESS_ANNOUNCEMENTS:
    "https://www.fda.gov/news-events/fda-newsroom/press-announcements",
  DEVICES_510K_CLEARANCES_2025:
    "https://www.fda.gov/vaccines-blood-biologics/substantially-equivalent-510k-device-information/cleared-510k-submissions-supporting-documents-2025",
} as const;

const httpClient = axios.create({
  timeout: 10000,
  headers: { "User-Agent": "news-surge-bot/1.0" },
});

const toAbsoluteUrl = (href: string) =>
  href?.startsWith("http") ? href : `https://www.fda.gov${href}`;

/** Extract a "Month DD, YYYY" date from nearby text; fallback = now. */
function extractIsoDateFromContext(text: string): string {
  const m = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/
  );
  return new Date(m ? m[0] : Date.now()).toISOString();
}

/** Very light symbol resolver: cache → FMP fallback (optional). */
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
// You can preload this map at startup from your own issuer list if you want:
let NAME_TO_TICKER: Record<string, string> = {};
export function loadFdaIssuerCache(map: Record<string, string>) {
  NAME_TO_TICKER = map || {};
}

async function resolveSymbolsFromText(text: string): Promise<string[]> {
  const candidates = [
    ...new Set(
      (text.match(/[A-Z][A-Za-z&.,'() -]{2,60}/g) || []).map(normalize)
    ),
  ];
  const fromCache = candidates.map((c) => NAME_TO_TICKER[c]).filter(Boolean);
  if (fromCache.length) return [...new Set(fromCache)];

  // Optional API fallback (FinancialModelingPrep). Skip if no key.
  const key = process.env.FMP_API_KEY;
  if (!key) return [];
  try {
    const q = encodeURIComponent(text.slice(0, 200));
    const url = `https://financialmodelingprep.com/api/v3/search?query=${q}&limit=5&exchange=NASDAQ,NYSE,AMEX&apikey=${key}`;
    const { data } = await axios.get<{ symbol: string }[]>(url, {
      timeout: 2500,
    });
    const syms = (data || []).map((d) => d.symbol).filter(Boolean);
    return [...new Set(syms)];
  } catch {
    return [];
  }
}

/** 1) Drugs: “What’s New Related to Drugs” (approvals & notable updates). */
async function fetchDrugUpdates(): Promise<RawItem[]> {
  const { data: pageHtml } = await httpClient.get(FDA_URLS.DRUGS_WHATS_NEW);
  const $ = cheerio.load(pageHtml);
  const items: RawItem[] = [];

  $("a[href]").each((_, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr("href") || "";
    if (!title) return;

    const isCandidate =
      /Approves|accelerated approval|Drug Trials Snapshots|Notable Approval/i.test(
        title
      );
    if (!isCandidate) return;

    const contextText = $(el).closest("li, p, div").text();
    const url = toAbsoluteUrl(href);

    items.push({
      id: url,
      url,
      title,
      summary: "",
      source: "fda_drugs",
      publishedAt: extractIsoDateFromContext(contextText),
      symbols: [], // resolved below (optionally)
    });
  });

  // Optional: resolve symbols for each item (skip if none found)
  for (const it of items) {
    const syms = await resolveSymbolsFromText(`${it.title}`);
    if (syms.length) it.symbols = syms;
  }
  return items;
}

/** 2) Agency-wide press announcements (often approvals/authorizations/clearances). */
async function fetchPressAnnouncements(): Promise<RawItem[]> {
  const { data: pageHtml } = await httpClient.get(FDA_URLS.PRESS_ANNOUNCEMENTS);
  const $ = cheerio.load(pageHtml);
  const items: RawItem[] = [];

  $("a[href]").each((_, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr("href") || "";
    if (!title || !/FDA (Approves|Authorizes|Clears|Grants)/i.test(title))
      return;

    const contextText = $(el).closest("article, li, div").text();
    const url = toAbsoluteUrl(href);

    items.push({
      id: url,
      url,
      title,
      summary: "",
      source: "fda_press",
      publishedAt: extractIsoDateFromContext(contextText),
      symbols: [],
    });
  });

  for (const it of items) {
    const syms = await resolveSymbolsFromText(`${it.title}`);
    if (syms.length) it.symbols = syms;
  }
  return items;
}

/** 3) Devices: 510(k) cleared submissions (tends to be lower impact; still useful). */
async function fetchDeviceClearances(): Promise<RawItem[]> {
  const { data: pageHtml } = await httpClient.get(
    FDA_URLS.DEVICES_510K_CLEARANCES_2025
  );
  const $ = cheerio.load(pageHtml);
  const items: RawItem[] = [];

  $("a[href*='510k']").each((_, el) => {
    const title = $(el).text().trim();
    const href = $(el).attr("href") || "";
    if (!title) return;

    const contextText = $(el).closest("li, p, div").text();
    const url = toAbsoluteUrl(href);

    items.push({
      id: url,
      url,
      title,
      summary: "",
      source: "fda_510k",
      publishedAt: extractIsoDateFromContext(contextText),
      symbols: [],
    });
  });

  // Usually these don't name the sponsor in the link text; resolution will be sparse.
  for (const it of items) {
    const syms = await resolveSymbolsFromText(`${it.title}`);
    if (syms.length) it.symbols = syms;
  }
  return items;
}

/** Single entry point that aggregates all FDA sources. */
export async function fetchFDA(): Promise<RawItem[]> {
  const [drugs, press, devices] = await Promise.allSettled([
    fetchDrugUpdates(),
    fetchPressAnnouncements(),
    fetchDeviceClearances(),
  ]);

  const results: RawItem[] = [];
  if (drugs.status === "fulfilled") results.push(...drugs.value);
  if (press.status === "fulfilled") results.push(...press.value);
  if (devices.status === "fulfilled") results.push(...devices.value);

  // If you only want actionable items, keep ones with ≥1 symbol:
  // return results.filter(it => it.symbols.length);

  return results;
}
