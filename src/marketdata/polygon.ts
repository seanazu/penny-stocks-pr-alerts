import WebSocket from "ws";
import EventEmitter from "events";
import { cfg } from "../config.js";

export type TradeTick = {
  timestamp: number;
  price: number;
  size: number;
  exchangeId: number;
  symbol: string;
};
export type MinuteBar = {
  startTimestamp: number;
  endTimestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  symbol: string;
};

export class PolygonFeed extends EventEmitter {
  declare emit: EventEmitter["emit"];
  private socket?: WebSocket;
  private wsUrl: string;
  private apiKey: string;
  private subscribedSymbols: string[] = [];
  private pendingChannels: string[] = [];
  private isAuthenticated = false;

  override on<K extends "trade" | "agg1m" | "status" | "error">(
    eventName: K,
    listener: (
      ...args: K extends "trade"
        ? [TradeTick]
        : K extends "agg1m"
        ? [MinuteBar]
        : K extends "status"
        ? [any]
        : K extends "error"
        ? [Error]
        : any[]
    ) => void
  ): this {
    return super.on(eventName, listener);
  }

  constructor(apiKey: string = cfg.POLYGON_API_KEY || "") {
    super();
    this.apiKey = apiKey;
    this.wsUrl = "wss://socket.polygon.io/stocks";
  }

  /** Reconnect quickly using the current wsUrl and last symbols. */
  private reopen() {
    try {
      this.socket?.removeAllListeners();
      this.socket?.close();
    } catch {}
    this.isAuthenticated = false;
    setTimeout(() => this.connect(this.subscribedSymbols), 200);
  }

  /** Send JSON safely. */
  private send(obj: Record<string, unknown>) {
    try {
      this.socket?.send(JSON.stringify(obj));
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  /** Subscribe after we're authenticated (buffers if not). */
  private subscribeNow() {
    if (!this.isAuthenticated || !this.socket) return;
    if (!this.pendingChannels.length) return;
    const params = this.pendingChannels.join(",");
    this.send({ action: "subscribe", params });
    this.pendingChannels = [];
  }

  /** Connect and subscribe to AM.* and T.* for symbols (post-auth). */
  connect(symbols: string[]) {
    if (!this.apiKey) throw new Error("POLYGON_API_KEY missing");
    this.subscribedSymbols = symbols.slice();

    // Prepare channels but DON'T send yet.
    this.pendingChannels = [
      ...symbols.map((s) => `AM.${s}`),
      ...symbols.map((s) => `T.${s}`),
    ];

    this.socket = new WebSocket(this.wsUrl);

    this.socket.on("open", () => {
      this.emit("status", { message: `connecting to ${this.wsUrl}` });
      // 1) authenticate first
      this.send({ action: "auth", params: this.apiKey });
      // 2) wait for status: "authenticated" in onmessage, then subscribe
    });

    this.socket.on("message", (raw: WebSocket.RawData) => {
      let msgs: any[] = [];
      try {
        msgs = JSON.parse(raw.toString());
      } catch {
        return;
      }

      for (const msg of msgs) {
        if (msg.ev === "status") {
          const text = String(msg.message || msg.status || "").toLowerCase();
          this.emit("status", msg);

          // Mark authenticated and send subscriptions
          if (text.includes("authenticated")) {
            this.isAuthenticated = true;
            this.subscribeNow();
          }

          // Auto-fallback to delayed if real-time not authorized
          if (
            text.includes("not authorized") ||
            text.includes("access real-time")
          ) {
            if (!this.wsUrl.includes("delayed.polygon.io")) {
              this.wsUrl = "wss://delayed.polygon.io/stocks";
              this.reopen();
            }
          }
          continue;
        }

        if (msg.ev === "T") {
          this.emit("trade", {
            timestamp: msg.t,
            price: msg.p,
            size: msg.s,
            exchangeId: msg.x,
            symbol: msg.sym,
          } as TradeTick);
          continue;
        }

        if (msg.ev === "AM") {
          this.emit("agg1m", {
            startTimestamp: msg.s,
            endTimestamp: msg.e,
            open: msg.o,
            high: msg.h,
            low: msg.l,
            close: msg.c,
            volume: msg.v,
            vwap: msg.vw,
            symbol: msg.sym,
          } as MinuteBar);
          continue;
        }
      }
    });

    this.socket.on("error", (e) => this.emit("error", e));
    this.socket.on("close", () =>
      setTimeout(() => this.connect(this.subscribedSymbols), 2000)
    );
  }
}
