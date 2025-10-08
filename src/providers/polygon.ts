// unusualVolume.ts
// npm i axios luxon
import axios, { AxiosError } from "axios";
import { DateTime } from "luxon";

const POLYGON_BASE_URL = "https://api.polygon.io";
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || "";

/** A single 1-minute bar from Polygon aggregates. */
type OneMinuteBar = { t: number; v: number };

export type UnusualVolumeOptions = {
  /** Number of recent sessions to build the intraday volume profile. */
  lookbackSessionCount?: number;
  /** "Very unusual" if today's live volume is at least this many times expected. */
  ratioThreshold?: number;
  /** "Very unusual" if today's live volume is at least this many standard deviations above expected. */
  zScoreThreshold?: number;
  /** Max retry attempts for network / 429 / 5xx responses. */
  maxRetryAttempts?: number;
};

/** Sleep helper for simple backoff. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET JSON with basic retry & backoff (429, 5xx, ECONNRESET). */
async function getJsonWithRetry<T>(
  url: string,
  maxRetryAttempts = 3
): Promise<T> {
  let attemptIndex = 0;
  while (true) {
    try {
      const { data } = await axios.get<T>(url, { timeout: 20000 });
      return data;
    } catch (error) {
      const err = error as AxiosError;
      const statusCode = err.response?.status ?? 0;
      const isRetriable =
        statusCode === 429 ||
        (statusCode >= 500 && statusCode < 600) ||
        err.code === "ECONNRESET";

      attemptIndex++;
      console.warn(
        `[UnusualVolume] HTTP error ${statusCode} on GET ${url}${
          isRetriable ? ` (attempt ${attemptIndex}/${maxRetryAttempts})` : ""
        }`
      );

      if (!isRetriable || attemptIndex >= maxRetryAttempts) {
        throw err;
      }
      await delay(400 * attemptIndex); // linear backoff
    }
  }
}

/** Fetch all 1-minute aggregate bars between epoch-millisecond bounds (inclusive), following pagination. */
async function fetchAllOneMinuteBars(
  symbol: string,
  startEpochMs: number,
  endEpochMs: number,
  maxRetryAttempts: number
): Promise<OneMinuteBar[]> {
  let nextUrl =
    `${POLYGON_BASE_URL}/v2/aggs/ticker/${encodeURIComponent(
      symbol
    )}/range/1/minute/` +
    `${startEpochMs}/${endEpochMs}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`;

  const bars: OneMinuteBar[] = [];

  while (nextUrl) {
    const response = await getJsonWithRetry<any>(nextUrl, maxRetryAttempts);
    const results: any[] = response?.results ?? [];
    for (const r of results) {
      bars.push({ t: r.t, v: r.v || 0 });
    }

    if (response?.next_url) {
      nextUrl = `${response.next_url}&apiKey=${POLYGON_API_KEY}`;
      console.log(
        "[UnusualVolume] Aggregates pagination → requesting next page…"
      );
    } else {
      nextUrl = "";
    }
  }

  return bars;
}

/**
 * Decide if a stock has *very unusual* volume **right now**.
 * Returns a boolean only; logs show the reasoning (liveVol, expectedByNow, ratio, z-score).
 *
 * Heuristic:
 * - Compare today's live cumulative volume (snapshot.day.v) to an expected-by-now value
 *   derived from the last N sessions' 1-minute cumulative profiles across 04:00–20:00 ET.
 * - "Very unusual" if ratio >= ratioThreshold OR zScore >= zScoreThreshold.
 */
export async function hasVeryUnusualVolume(
  symbol: string,
  options: UnusualVolumeOptions = {}
): Promise<boolean> {
  const {
    lookbackSessionCount = 20,
    ratioThreshold = 3.0,
    zScoreThreshold = 3.5,
    maxRetryAttempts = 3,
  } = options;

  if (!POLYGON_API_KEY) {
    console.error(
      "[UnusualVolume] Missing POLYGON_API_KEY environment variable."
    );
    return false;
  }

  try {
    const marketTimezone = "America/New_York";
    const nowInMarketTz = DateTime.now().setZone(marketTimezone);

    // ---------- 1) Get live cumulative volume (includes pre, RTH, post so far today) ----------
    const snapshotUrl = `${POLYGON_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(
      symbol
    )}?apiKey=${POLYGON_API_KEY}`;
    console.log(`[UnusualVolume] Fetching snapshot for ${symbol}…`);
    const snapshot = await getJsonWithRetry<any>(snapshotUrl, maxRetryAttempts);

    const liveCumulativeVolume: number = snapshot?.ticker?.day?.v ?? 0;
    console.log(
      `[UnusualVolume] Live cumulative volume: ${liveCumulativeVolume.toLocaleString()}`
    );

    if (!Number.isFinite(liveCumulativeVolume) || liveCumulativeVolume <= 0) {
      console.warn(
        "[UnusualVolume] No live volume available yet. Returning false."
      );
      return false;
    }

    // ---------- 2) Fetch recent minute bars to build expected-by-now profile ----------
    const startEpochMs = nowInMarketTz
      .minus({ days: lookbackSessionCount + 10 })
      .startOf("day")
      .toUTC()
      .toMillis();
    const endEpochMs = nowInMarketTz.endOf("day").toUTC().toMillis();

    console.log(
      `[UnusualVolume] Fetching minute bars from ${new Date(
        startEpochMs
      ).toISOString()} to ${new Date(endEpochMs).toISOString()}`
    );
    const allOneMinuteBars = await fetchAllOneMinuteBars(
      symbol,
      startEpochMs,
      endEpochMs,
      maxRetryAttempts
    );
    console.log(
      `[UnusualVolume] Total minute bars fetched: ${allOneMinuteBars.length}`
    );

    // ---------- 3) Build cumulative fraction curve for 04:00–20:00 ET ----------
    const sessionStartInTz = (d: DateTime) =>
      d.set({ hour: 4, minute: 0, second: 0, millisecond: 0 });
    const sessionEndInTz = (d: DateTime) =>
      d.set({ hour: 20, minute: 0, second: 0, millisecond: 0 });

    const MINUTES_PER_EXTENDED_SESSION = 16 * 60; // 04:00–20:00 = 960 mins

    // Group minute bars by local trading date, keeping only bars within 04:00–20:00
    const byLocalDate = new Map<string, OneMinuteBar[]>();
    for (const bar of allOneMinuteBars) {
      const barTimeInTz = DateTime.fromMillis(bar.t, { zone: marketTimezone });
      if (
        barTimeInTz < sessionStartInTz(barTimeInTz) ||
        barTimeInTz >= sessionEndInTz(barTimeInTz)
      ) {
        continue;
      }
      const dateKey = barTimeInTz.toISODate();
      if (dateKey) {
        const barsForDay = byLocalDate.get(dateKey) ?? [];
        barsForDay.push({ t: barTimeInTz.toMillis(), v: bar.v || 0 });
        byLocalDate.set(dateKey, barsForDay);
      }
    }

    const sortedDateKeys = [...byLocalDate.keys()]
      .sort()
      .slice(-lookbackSessionCount);

    // Average cumulative fraction curve across the lookback sessions
    const averageCumulativeFractionByMinute = new Array<number>(
      MINUTES_PER_EXTENDED_SESSION
    ).fill(0);
    let sessionsUsedCount = 0;
    let sumOfDailyTotalsAcrossSessions = 0;

    for (const dateKey of sortedDateKeys) {
      const barsForDay = (byLocalDate.get(dateKey) ?? []).sort(
        (a, b) => a.t - b.t
      );
      if (barsForDay.length < 120) continue; // skip thin/partial days

      sessionsUsedCount++;

      const volumeAtMinuteIndex: number[] = new Array(
        MINUTES_PER_EXTENDED_SESSION
      ).fill(0);
      for (const bar of barsForDay) {
        const barTimeInTz = DateTime.fromMillis(bar.t, {
          zone: marketTimezone,
        });
        const minuteIndexFromStart = Math.floor(
          barTimeInTz.diff(sessionStartInTz(barTimeInTz), "minutes").minutes
        );
        if (
          minuteIndexFromStart >= 0 &&
          minuteIndexFromStart < MINUTES_PER_EXTENDED_SESSION
        ) {
          volumeAtMinuteIndex[minuteIndexFromStart] += bar.v || 0;
        }
      }

      // Build cumulative for the day in O(n)
      const cumulativeForDay = new Array<number>(MINUTES_PER_EXTENDED_SESSION);
      let runningDayTotal = 0;
      for (let i = 0; i < MINUTES_PER_EXTENDED_SESSION; i++) {
        runningDayTotal += volumeAtMinuteIndex[i];
        cumulativeForDay[i] = runningDayTotal;
      }

      const dayTotalVolume = Math.max(
        1,
        cumulativeForDay[MINUTES_PER_EXTENDED_SESSION - 1]
      );
      sumOfDailyTotalsAcrossSessions += dayTotalVolume;

      for (let i = 0; i < MINUTES_PER_EXTENDED_SESSION; i++) {
        averageCumulativeFractionByMinute[i] +=
          cumulativeForDay[i] / dayTotalVolume;
      }
    }

    if (sessionsUsedCount > 0) {
      // Convert sums into averages
      for (let i = 0; i < MINUTES_PER_EXTENDED_SESSION; i++) {
        averageCumulativeFractionByMinute[i] /= sessionsUsedCount;
      }
    }

    const averageDailyVolumeAcrossSessions =
      sessionsUsedCount > 0
        ? Math.max(
            1,
            Math.round(sumOfDailyTotalsAcrossSessions / sessionsUsedCount)
          )
        : 0;

    // ---------- 4) Compute expected-by-now in today's session ----------
    const minuteIndexNow = Math.max(
      0,
      Math.min(
        MINUTES_PER_EXTENDED_SESSION - 1,
        Math.floor(
          nowInMarketTz.diff(sessionStartInTz(nowInMarketTz), "minutes").minutes
        )
      )
    );

    let expectedCumulativeVolumeByNow: number;
    if (sessionsUsedCount > 0) {
      const expectedFractionByNow = Math.max(
        0.0001,
        averageCumulativeFractionByMinute[minuteIndexNow] ??
          averageCumulativeFractionByMinute[MINUTES_PER_EXTENDED_SESSION - 1] ??
          0.0001
      );
      expectedCumulativeVolumeByNow = Math.max(
        1,
        Math.round(averageDailyVolumeAcrossSessions * expectedFractionByNow)
      );
    } else {
      // Fallback when we could not build a profile: scale yesterday's volume by elapsed fraction of 04:00–20:00
      const previousDayTotalVolume =
        (snapshot?.ticker?.prevDay?.v as number) || 0;
      const elapsedFractionOfExtendedSession = Math.max(
        0.02,
        Math.min(1, (minuteIndexNow + 1) / MINUTES_PER_EXTENDED_SESSION)
      );
      expectedCumulativeVolumeByNow = Math.max(
        1,
        Math.round(
          (previousDayTotalVolume || 1) * elapsedFractionOfExtendedSession
        )
      );
    }

    const volumeRatio =
      liveCumulativeVolume / Math.max(1, expectedCumulativeVolumeByNow);
    console.log(
      `[UnusualVolume] Expected-by-now: ${expectedCumulativeVolumeByNow.toLocaleString()} | Ratio: ${volumeRatio.toFixed(
        2
      )}`
    );

    // ---------- 5) Optional z-score vs historical "partial-to-this-minute" cumulative ----------
    let zScoreRelativeToHistory = 0;
    if (sessionsUsedCount > 0) {
      const historicalPartialsToThisMinute: number[] = [];

      for (const dateKey of sortedDateKeys) {
        const barsForDay = (byLocalDate.get(dateKey) ?? []).sort(
          (a, b) => a.t - b.t
        );
        let runningPartial = 0;

        for (const bar of barsForDay) {
          const barTimeInTz = DateTime.fromMillis(bar.t, {
            zone: marketTimezone,
          });
          const minuteIndexFromStart = Math.floor(
            barTimeInTz.diff(sessionStartInTz(barTimeInTz), "minutes").minutes
          );
          if (minuteIndexFromStart < 0) continue;
          if (minuteIndexFromStart > minuteIndexNow) break;
          runningPartial += bar.v || 0;
        }
        if (runningPartial > 0)
          historicalPartialsToThisMinute.push(runningPartial);
      }

      if (historicalPartialsToThisMinute.length >= 5) {
        const meanPartial =
          historicalPartialsToThisMinute.reduce((sum, x) => sum + x, 0) /
          historicalPartialsToThisMinute.length;
        const variance =
          historicalPartialsToThisMinute.reduce(
            (sum, x) => sum + (x - meanPartial) ** 2,
            0
          ) / historicalPartialsToThisMinute.length || 1;
        const stdDevPartial = Math.sqrt(variance) || 1;
        zScoreRelativeToHistory =
          (liveCumulativeVolume - meanPartial) / stdDevPartial;
      }
    }
    console.log(
      `[UnusualVolume] zScore: ${zScoreRelativeToHistory.toFixed(2)}`
    );

    // ---------- 6) Final boolean decision ----------
    const isVeryUnusual =
      volumeRatio >= ratioThreshold ||
      zScoreRelativeToHistory >= zScoreThreshold;

    console.log(
      `[UnusualVolume] ${symbol} very unusual volume? ${isVeryUnusual}`
    );
    return isVeryUnusual;
  } catch (error) {
    const err = error as AxiosError;
    console.error(
      "[UnusualVolume] ERROR:",
      err?.response?.status
        ? `HTTP ${err.response.status}`
        : err?.message || err
    );
    return false;
  }
}

// Example:
// const flag = await hasVeryUnusualVolume("AAPL");
// console.log("Unusual?", flag);
