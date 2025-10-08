import type { RawItem } from "../types.js";
import { fetchBenzingaPressReleases } from "./fmp.js";
import { fetchFDA } from "./fda.js";
import { log } from "../logger.js";

/** Run provider fetches concurrently with error isolation. */
export async function fetchAllProviders(): Promise<RawItem[]> {
  const jobs = [fetchBenzingaPressReleases(), fetchFDA()];
  const results = await Promise.allSettled(jobs);
  const out: RawItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value);
    else log.warn("provider error", r.reason);
  }
  return out;
}
