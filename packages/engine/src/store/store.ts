import type { Database } from "better-sqlite3";
import type { BotRow, RunRow, PersistedOrder, PersistedPosition, EquityRow } from "./types.js";

export class Store {
  constructor(private db: Database) {}

  saveBot(r: BotRow): void {
    this.db.prepare(
      `INSERT INTO bots (id,name,strategy,symbol,params,status,state,created_at,updated_at)
       VALUES (@id,@name,@strategy,@symbol,@params,@status,@state,@created_at,@updated_at)`,
    ).run(r);
  }

  updateBot(id: string, patch: Partial<BotRow>): void {
    const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE bots SET ${sets}, updated_at = @now WHERE id = @id`).run({ ...patch, id, now: Date.now() });
  }

  getBot(id: string): BotRow | undefined {
    return this.db.prepare(`SELECT * FROM bots WHERE id = ?`).get(id) as BotRow | undefined;
  }

  listBots(): BotRow[] {
    return this.db.prepare(`SELECT * FROM bots ORDER BY created_at ASC`).all() as BotRow[];
  }

  createBotRun(r: RunRow): void {
    this.db.prepare(
      `INSERT INTO runs (id,bot_id,mode,started_at,stopped_at,stop_reason)
       VALUES (@id,@bot_id,@mode,@started_at,@stopped_at,@stop_reason)`,
    ).run(r);
  }

  finishRun(id: string, reason: string): void {
    this.db.prepare(`UPDATE runs SET stopped_at = ?, stop_reason = ? WHERE id = ?`).run(Date.now(), reason, id);
  }

  listRuns(botId?: string): RunRow[] {
    const sql = `SELECT * FROM runs ${botId ? "WHERE bot_id = ?" : ""} ORDER BY started_at DESC`;
    return (botId ? this.db.prepare(sql).all(botId) : this.db.prepare(sql).all()) as RunRow[];
  }

  createOrder(o: PersistedOrder): void {
    this.db.prepare(
      `INSERT INTO orders (id,bot_id,exchange_id,symbol,side,price,size,status,filled_size,avg_price,created_at,updated_at)
       VALUES (@id,@bot_id,@exchange_id,@symbol,@side,@price,@size,@status,@filled_size,@avg_price,@created_at,@updated_at)`,
    ).run(o);
  }

  updateOrder(id: string, patch: Partial<PersistedOrder>): void {
    const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE orders SET ${sets}, updated_at = @now WHERE id = @id`).run({ ...patch, id, now: Date.now() });
  }

  listOrders(botId?: string): PersistedOrder[] {
    const sql = `SELECT * FROM orders ${botId ? "WHERE bot_id = ?" : ""} ORDER BY created_at DESC`;
    return (botId ? this.db.prepare(sql).all(botId) : this.db.prepare(sql).all()) as PersistedOrder[];
  }

  createPosition(p: PersistedPosition): void {
    this.db.prepare(
      `INSERT INTO positions (id,bot_id,symbol,side,size,avg_entry,mark_price,realized_pnl,opened_at,closed_at)
       VALUES (@id,@bot_id,@symbol,@side,@size,@avg_entry,@mark_price,@realized_pnl,@opened_at,@closed_at)`,
    ).run(p);
  }

  closePosition(id: string, realizedPnl: number, markPrice?: number): void {
    this.db.prepare(`UPDATE positions SET closed_at = ?, realized_pnl = ?, mark_price = COALESCE(?, mark_price) WHERE id = ?`)
      .run(Date.now(), realizedPnl, markPrice ?? null, id);
  }

  listOpenPositions(): PersistedPosition[] {
    return this.db.prepare(`SELECT * FROM positions WHERE closed_at IS NULL`).all() as PersistedPosition[];
  }

  listPositions(botId?: string): PersistedPosition[] {
    const sql = `SELECT * FROM positions ${botId ? "WHERE bot_id = ?" : ""} ORDER BY opened_at DESC`;
    return (botId ? this.db.prepare(sql).all(botId) : this.db.prepare(sql).all()) as PersistedPosition[];
  }

  appendEquity(r: { id: string; botId: string | null; ts: number; value: number }): void {
    this.db.prepare(`INSERT INTO equity (id,bot_id,ts,value) VALUES (?,?,?,?)`).run(r.id, r.botId, r.ts, r.value);
  }

  listEquity(botId?: string, limit?: number): EquityRow[] {
    const where = botId === undefined ? "bot_id IS NULL" : "bot_id = ?";
    const params: (string | number)[] = botId === undefined ? [] : [botId];
    const sql = `SELECT * FROM equity WHERE ${where} ORDER BY ts DESC${limit != null ? " LIMIT ?" : ""}`;
    const rows = (limit != null
      ? this.db.prepare(sql).all(...params, limit)
      : this.db.prepare(sql).all(...params)) as EquityRow[];
    return rows.reverse(); // oldest-first for charting
  }

  getWatchlist(): string[] {
    const row = this.db.prepare(`SELECT symbols FROM watchlist WHERE id = 'default'`).get() as { symbols: string } | undefined;
    if (!row) return [];
    return JSON.parse(row.symbols) as string[];
  }

  setWatchlist(symbols: string[]): void {
    this.db.prepare(
      `INSERT INTO watchlist (id, symbols, updated_at) VALUES ('default', ?, ?)
       ON CONFLICT(id) DO UPDATE SET symbols = excluded.symbols, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(symbols), Date.now());
  }

  deleteBot(id: string): void {
    this.db.prepare(`DELETE FROM runs WHERE bot_id = ?`).run(id);
    this.db.prepare(`DELETE FROM orders WHERE bot_id = ?`).run(id);
    this.db.prepare(`DELETE FROM positions WHERE bot_id = ?`).run(id);
    this.db.prepare(`DELETE FROM equity WHERE bot_id = ?`).run(id);
    this.db.prepare(`DELETE FROM bots WHERE id = ?`).run(id);
  }
}
