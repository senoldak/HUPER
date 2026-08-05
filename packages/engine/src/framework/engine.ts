import { randomUUID } from "node:crypto";
import { OrderType, type ExchangeAdapter, type NewOrder, type Order, type PriceTick, type Position, type RecentOrder } from "@huper/core";
import type { Store } from "../store/store.js";
import type { PersistedOrder, PersistedPosition, RunRow, BotRow } from "../store/types.js";
import type { RiskManager } from "../risk/risk.js";
import type { StrategyRegistry } from "./registry.js";
import { BotRunner } from "./runner.js";
import type { BotState } from "./strategy.js";

export interface LoggerLike { info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void }

export interface BotSummary { id: string; name: string; strategy: string; symbol: string; status: string; params: Record<string, unknown>; state: BotState; createdAt: number; updatedAt: number }
export interface BotDetail extends BotSummary { orders: PersistedOrder[]; positions: PersistedPosition[]; runs: RunRow[] }

export interface EngineOptions { exchange: ExchangeAdapter; store: Store; risk: RiskManager; registry: StrategyRegistry; log: LoggerLike }

export class Engine {
  private exchange: ExchangeAdapter;
  private store: Store;
  private risk: RiskManager;
  private registry: StrategyRegistry;
  private log: LoggerLike;
  private runners = new Map<string, BotRunner>();
  private ticks = new Map<string, PriceTick>();
  private bal = 0;
  private orderIds = new Map<string, Set<string>>();
  private recentOrders: RecentOrder[] = [];
  private unsubs: Array<() => void> = [];

  constructor(opts: EngineOptions) { this.exchange = opts.exchange; this.store = opts.store; this.risk = opts.risk; this.registry = opts.registry; this.log = opts.log; }

  mode(): "paper" | "live" { return this.exchange.mode; }
  latestTick(symbol: string): PriceTick | undefined { return this.ticks.get(symbol); }
  balance(): Promise<number> { return Promise.resolve(this.bal); }
  logHandle(): LoggerLike { return this.log; }
  orderIdsFor(botId: string): Set<string> { return this.orderIds.get(botId) ?? new Set(); }

  async start(): Promise<void> {
    this.unsubs.push(this.exchange.onTick((t) => { this.ticks.set(t.symbol, t); this.dispatch(t); }));
    this.unsubs.push(this.exchange.onFill((o) => this.routeFill(o)));
    try {
      const b = await this.exchange.balances();
      if (b.length > 0) this.bal = b[0].total;
    } catch { /* balance refresh optional at boot */ }
  }

  async stop(): Promise<void> {
    this.unsubs.forEach((u) => u());
    this.unsubs = [];
    await this.stopAll("shutdown");
  }

  async positionsFor(symbol: string): Promise<Position[]> {
    const all = await this.exchange.openPositions();
    return all.filter((p) => p.symbol === symbol);
  }

  async createBot(input: { name: string; strategy: string; symbol: string; params: Record<string, unknown> }): Promise<BotSummary> {
    const def = this.registry.get(input.strategy);
    if (!def) throw new Error("unknown strategy: " + input.strategy);
    const parsed = def.paramsSchema.safeParse(input.params);
    if (!parsed.success) throw new Error(`invalid params: ${JSON.stringify(parsed.error.flatten())}`);
    const now = Date.now();
    const row: BotRow = {
      id: randomUUID(), name: input.name, strategy: input.strategy, symbol: input.symbol,
      params: JSON.stringify(parsed.data), status: "stopped", state: "{}", created_at: now, updated_at: now,
    };
    this.store.saveBot(row);
    return this.toSummary(row);
  }

  async startBot(id: string): Promise<void> {
    const row = this.store.getBot(id);
    if (!row) throw new Error("bot not found");
    const def = this.registry.get(row.strategy);
    if (!def) throw new Error("unknown strategy: " + row.strategy);
    if (this.runners.has(id)) throw new Error("bot already running");
    const runner = new BotRunner(this, def, JSON.parse(row.params), row.state, row.id, row.name, row.symbol);
    this.orderIds.set(id, new Set());
    this.store.createBotRun({ id: randomUUID(), bot_id: id, mode: this.exchange.mode, started_at: Date.now(), stopped_at: null, stop_reason: null });
    this.runners.set(id, runner);
    try {
      await runner.start();
      this.store.updateBot(id, { status: "running" });
    } catch (e) {
      this.runners.delete(id);
      this.store.updateBot(id, { status: "error" });
      throw e;
    }
  }

  async stopBot(id: string, reason = "stopped"): Promise<void> {
    const runner = this.runners.get(id);
    if (runner) {
      await runner.stop(reason);
      this.runners.delete(id);
      this.orderIds.delete(id);
    }
    const runs = this.store.listRuns(id);
    const open = runs.find((r) => r.stopped_at === null);
    if (open) this.store.finishRun(open.id, reason);
    this.store.updateBot(id, { status: "stopped" });
  }

  async deleteBot(id: string): Promise<void> {
    if (this.runners.has(id)) await this.stopBot(id, "deleted");
    this.store.deleteBot(id);
  }

  listBots(): BotSummary[] { return this.store.listBots().map((r) => this.toSummary(r)); }

  async getBotDetail(id: string): Promise<BotDetail | undefined> {
    const row = this.store.getBot(id);
    if (!row) return undefined;
    return { ...this.toSummary(row), orders: this.store.listOrders(id), positions: this.store.listPositions(id), runs: this.store.listRuns(id) };
  }

  async stopAll(reason: string): Promise<number> {
    const ids = [...this.runners.keys()];
    for (const id of ids) await this.stopBot(id, reason);
    return ids.length;
  }

  async executeOrder(botId: string, symbol: string, o: NewOrder): Promise<Order> {
    const lastPrice = this.ticks.get(symbol)?.mid ?? null;
    const snapshot = {
      botId, symbol, balance: this.bal, lastPrice,
      botPositionNotional: await this.notionalFor(botId),
      globalPositionNotional: await this.notionalForAll(),
      recentOrders: this.recentOrders,
    };
    const attempt = { botId, symbol, side: o.side, price: o.price, size: o.size, kind: (o.type === OrderType.Market || o.price == null ? "market" : "limit") as "limit" | "market", reduceOnly: o.reduceOnly };
    const verdict = this.risk.validate(attempt, snapshot);
    if (!verdict.ok) throw new Error(verdict.reason);

    const placed = await this.exchange.placeOrder(o);
    this.store.createOrder({
      id: placed.id, bot_id: botId, exchange_id: null, symbol, side: placed.side,
      price: placed.price, size: placed.size, status: placed.status,
      filled_size: placed.filledSize, avg_price: placed.avgFillPrice,
      created_at: placed.createdAt, updated_at: Date.now(),
    });
    if (!this.orderIds.has(botId)) this.orderIds.set(botId, new Set());
    this.orderIds.get(botId)!.add(placed.id);
    this.recentOrders.push({ id: placed.id, botId, symbol, side: placed.side, price: placed.price, size: placed.size, createdAt: Date.now() });
    if (this.recentOrders.length > 50) this.recentOrders.shift();
    return placed;
  }

  async cancelOrder(botId: string, orderId: string): Promise<void> {
    const ok = await this.exchange.cancelOrder(orderId);
    if (ok) this.store.updateOrder(orderId, { status: "cancelled" });
  }

  async cancelAllOrders(botId: string): Promise<void> {
    const ids = this.orderIds.get(botId);
    if (!ids) return;
    for (const id of [...ids]) { try { await this.cancelOrder(botId, id); } catch { /* ignore */ } }
    this.orderIds.set(botId, new Set());
  }

  saveBotState(botId: string, state: BotState): void {
    this.store.updateBot(botId, { state: JSON.stringify(state) });
  }

  private dispatch(tick: PriceTick): void {
    void this.refreshMeta(tick.symbol).then(() => {
      const now = Date.now();
      for (const runner of this.runners.values()) {
        if (runner.symbol !== tick.symbol) continue;
        if (now - runner.lastEval >= runner.cadenceMs) {
          runner.lastEval = now;
          void runner.evaluate(tick).catch((e) => this.markError(runner.botId, e));
        }
      }
    });
  }

  private routeFill(order: Order): void {
    for (const runner of this.runners.values()) {
      if (runner.hasOrder(order.id)) void runner.onOrderFilled(order).catch((e) => this.markError(runner.botId, e));
    }
  }

  private async refreshMeta(symbol: string): Promise<void> {
    try {
      const b = await this.exchange.balances();
      if (b.length > 0) this.bal = b[0].total;
    } catch (e) { this.log.warn({ symbol, err: (e as Error).message }, "balances refresh failed"); }
  }

  private async notionalFor(botId: string): Promise<number> {
    let n = 0;
    for (const p of this.store.listPositions(botId)) if (p.closed_at === null) n += Math.abs(p.size) * p.avg_entry;
    return n;
  }

  private async notionalForAll(): Promise<number> {
    let n = 0;
    for (const p of this.store.listOpenPositions()) n += Math.abs(p.size) * p.avg_entry;
    return n;
  }

  private markError(botId: string, e: unknown): void {
    this.log.error({ botId, err: (e as Error).message }, "bot error");
    this.store.updateBot(botId, { status: "error" });
  }

  private toSummary(row: BotRow): BotSummary {
    return {
      id: row.id, name: row.name, strategy: row.strategy, symbol: row.symbol,
      status: row.status, params: safeParse(row.params), state: safeParse(row.state),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

function safeParse(s: string): Record<string, unknown> { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } }
