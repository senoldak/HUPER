import Database from "better-sqlite3";

export function openStore(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, strategy TEXT NOT NULL,
      symbol TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, mode TEXT NOT NULL,
      started_at INTEGER NOT NULL, stopped_at INTEGER, stop_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, bot_id TEXT, exchange_id TEXT, symbol TEXT NOT NULL,
      side TEXT NOT NULL, price REAL, size REAL NOT NULL, status TEXT NOT NULL,
      filled_size REAL NOT NULL DEFAULT 0, avg_price REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY, bot_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL,
      size REAL NOT NULL, avg_entry REAL NOT NULL, mark_price REAL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      opened_at INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS equity (
      id TEXT PRIMARY KEY, bot_id TEXT, ts INTEGER NOT NULL, value REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watchlist (
      id TEXT PRIMARY KEY,
      symbols TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_bot_id ON runs(bot_id);
    CREATE INDEX IF NOT EXISTS idx_orders_bot_id ON orders(bot_id);
    CREATE INDEX IF NOT EXISTS idx_positions_bot_id ON positions(bot_id);
    CREATE INDEX IF NOT EXISTS idx_equity_bot_id ON equity(bot_id);
  `);
  return db;
}