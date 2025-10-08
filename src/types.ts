/**
 * Shared types across the pipeline
 */
export type RawItem = {
  /** Provider-unique ID or URL */
  id: string;
  url?: string;
  title: string;
  summary?: string;
  source: string; // provider name
  publishedAt: string; // ISO
  symbols: string[]; // mapped tickers if known
};

export type EventClass =
  | "FDA_APPROVAL"
  | "EARNINGS_BEAT_GUIDE_UP"
  | "MAJOR_DEAL_PARTNERSHIP"
  | "ACQUISITION_MNA"
  | "CONTRACT_AWARD"
  | "REGULATORY_CLEARANCE"
  | "INFLUENCER_MENTION"
  | "OTHER";

export interface ClassifiedItem extends RawItem {
  klass: EventClass;
  /** 0..1 likelihood that news can trigger a large right-tail move */
  score: number;
  marketCap?: number; // optional filter (<$1B typical)
}

export type ConfirmSignal = {
  symbol: string;
  ts: number; // ms
  price: number;
  volZ: number; // 1m volume z-score
  ret1m: number; // 1m return since ref
  vwapDev: number; // pct above VWAP
  pass: boolean; // passes price/volume gate
};
