import Database from "better-sqlite3";
import { createHash } from "crypto";
import type { ClassifiedItem } from "../types.js";

/** SQLite persistence & duplicate prevention */
export class EventDB {
  private db: Database.Database;
  private qSeen: Database.Statement;
  private qInsert: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      hash TEXT UNIQUE,
      provider_id TEXT,
      source TEXT,
      title TEXT,
      url TEXT,
      symbols TEXT,
      klass TEXT,
      score REAL,
      published_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );`);
    this.qSeen = this.db.prepare("SELECT 1 FROM events WHERE hash=?");
    this.qInsert = this.db.prepare(`INSERT OR IGNORE INTO events
      (hash, provider_id, source, title, url, symbols, klass, score, published_at)
      VALUES (@hash, @provider_id, @source, @title, @url, @symbols, @klass, @score, @published_at)`);
  }

  makeHash(x: { title: string; url?: string; source: string }) {
    return createHash("sha256")
      .update(`${x.source}|${x.title}|${x.url ?? ""}`)
      .digest("hex");
  }

  seen(hash: string) {
    return !!this.qSeen.get(hash);
  }

  save(item: ClassifiedItem) {
    const row = {
      hash: this.makeHash({
        title: item.title,
        url: item.url,
        source: item.source,
      }),
      provider_id: item.id,
      source: item.source,
      title: item.title,
      url: item.url ?? "",
      symbols: item.symbols.join(","),
      klass: item.klass,
      score: item.score,
      published_at: item.publishedAt,
    };
    this.qInsert.run(row);
    return row.hash;
  }
}
