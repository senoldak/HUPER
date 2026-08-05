# Phase 2a Implementation Plan: Bot Framework, Risk, SQLite Store, Emergency Stop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the bot engine core: a strategy framework (Grid / DCA-Martingale / Trend proof strategies), a risk manager, a better-sqlite3 state store, and emergency stop, exposed through an extended HTTP API.

**Architecture:** A shared tick-loop (`Engine`) subscribes to the active `ExchangeAdapter`'s `onTick`. Each running bot has a `BotRunner` that owns a `Strategy` instance, a per-bot persisted `state` blob, and a cadence gate. Strategy order requests flow through `RiskManager` before reaching `exchange.placeOrder`. All state (bots, runs, orders, positions) persists via `Store` (better-sqlite3). `EmergencyStop` halts bots, cancels orders, and market-closes positions.

**Tech Stack:** TypeScript (strict, ESM), npm workspaces (`@huper/core`, `@huper/engine`), vitest, fastify, zod, better-sqlite3, `@nktkas/hyperliquid` 0.33.3, viem.

## Global Constraints

- Strict TS, Node ESM (`"type": "module"`); relative imports use explicit `.js` extensions.
- `npm run typecheck` (root) 0 errors; `npm test` passes.
- New deps ONLY: `better-sqlite3` + `@types/better-sqlite3` (dev), both in `@huper/engine`.
- `@huper/core` gains ONLY data-bearing types: `BotStatus`, `RiskConfig`, `DEFAULT_RISK`, `RecentOrder`, `OrderAttempt`, `RiskSnapshot`. No SQLite/HTTP/strategy logic in core.
- The existing `ExchangeAdapter`, `NewOrder`, `Order`, `PriceTick`, `Position`, `Wallet` contract (packages/core/src/types.ts) is fixed.
- Market orders MUST be sent in `LiveExchange.placeOrder` as `{ t: { limit: { px: <ref>, sz, tif: "Ioc" } } }` where `ref` is the latest cached tick mid; throw if no tick. Remove the `p: ""` branch.
- DB path from `HUPER_DB_PATH` (default `data/huper.db`); tests use `:memory:`.
- No Phase 2b+/3/4 scope (remaining strategies, web panel, WS push, key encryption).

## Source of truth

- Spec: `docs/superpowers/specs/2026-08-05-huper-phase2a-design.md`
- Core contract: `packages/core/src/types.ts`

---

### Task 1: SQLite DB Layer + State Store

**Files:**
- Create: `packages/engine/src/store/db.ts`
- Create: `packages/engine/src/store/types.ts`
- Create: `packages/engine/src/store/store.ts`
- Test: `packages/engine/tests/store.test.ts`

**Interfaces (produced):**
- `openStore(path: string): Database.Database` — better-sqlite3 connection (`:memory:` allowed), WAL pragma, idempotent schema.
- `class Store` with: `saveBot`, `updateBot(id, patch)`, `getBot(id)`, `listBots()`, `deleteBot(id)`, `createBotRun`, `finishRun(id, reason)`, `listRuns(botId?)`, `createOrder`, `updateOrder(id, patch)`, `listOrders(botId?)`, `createPosition`, `closePosition(id, realizedPnl, markPrice?)`, `listOpenPositions()`, `listPositions(botId?)`, `appendEquity`.
- Row types: `BotRow`, `RunRow`, `PersistedOrder`, `PersistedPosition` (fields match the table columns in db.ts).

- [ ] **Step 1: install deps**

```bash
npm i better-sqlite3 -w @huper/engine
npm i -D @types/better-sqlite3 -w @huper/engine
```

- [ ] **Step 2: runtime check**

```bash
node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"
```
Expected: prints `better-sqlite3 OK`. If this fails with a build/gyp error, STOP and report (do not change the plan).

- [ ] **Step 3: write the failing test**

`packages/engine/tests/store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { openStore } from "../src/store/db.js";
import { Store } from "../src/store/store.js";

describe("Store", () => {
  const db = openStore(":memory:");
  const store = new Store(db);

  it("persists, reads, updates a bot", () => {
    store.saveBot({ id: "b1", name: "My Grid", strategy: "grid", symbol: "BTC", params: "{}", status: "stopped", state: "{}", created_at: 1, updated_at: 1 });
    expect(store.getBot("b1")?.name).toBe("My Grid");
    expect(store.listBots()).toHaveLength(1);
    store.updateBot("b1", { status: "running" });
    expect(store.getBot("b1")?.status).toBe("running");
  });

  it("runs start and finish", () => {
    store.createBotRun({ id: "r1", bot_id: "b1", mode: "paper", started_at: 2, stopped_at: null, stop_reason: null });
    store.finishRun("r1", "stopped");
    const [run] = store.listRuns("b1");
    expect(run?.stopped_at).not.toBeNull();
    expect(run?.stop_reason).toBe("stopped");
  });

  it("orders roundtrip", () => {
    store.createOrder({ id: "o1", bot_id: "b1", exchange_id: null, symbol: "BTC", side: "buy", price: 100, size: 0.1, status: "open", filled_size: 0, avg_price: null, created_at: 3, updated_at: 3 });
    store.updateOrder("o1", { status: "filled", filled_size: 0.1, avg_price: 100 });
    expect(store.listOrders("b1")[0]?.status).toBe("filled");
  });

  it("positions open/close with realized pnl", () => {
    store.createPosition({ id: "p1", bot_id: "b1", symbol: "BTC", side: "buy", size: 0.1, avg_entry: 100, mark_price: null, realized_pnl: 0, opened_at: 4, closed_at: null });
    expect(store.listOpenPositions()).toHaveLength(1);
    store.closePosition("p1", 2.5, 105);
    expect(store.listOpenPositions()).toHaveLength(0);
    expect(store.listPositions("b1")[0]?.realized_pnl).toBe(2.5);
  });

  it("deletes a bot", () => {
    store.deleteBot("b1");
    expect(store.getBot("b1")).toBeUndefined();
  });
});
```

- [ ] **Step 4: run test to verify it fails**

Run: `npm run test -w @huper/engine tests/store.test.ts`
Expected: FAIL — module `./src/store/store.js` not found.

- [ ] **Step 5: implement `store/db.ts`**

```ts
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
  `);
  return db;
}
```

- [ ] **Step 6: implement `store/types.ts`**

```ts
export interface BotRow {
  id: string; name: string; strategy: string; symbol: string;
  params: string; status: string; state: string;
  created_at: number; updated_at: number;
}
export interface RunRow {
  id: string; bot_id: string; mode: string;
  started_at: number; stopped_at: number | null; stop_reason: string | null;
}
export interface PersistedOrder {
  id: string; bot_id: string; exchange_id: string | null; symbol: string;
  side: string; price: number | null; size: number; status: string;
  filled_size: number; avg_price: number | null; created_at: number; updated_at: number;
}
export interface PersistedPosition {
  id: string; bot_id: string; symbol: string; side: string; size: number;
  avg_entry: number; mark_price: number | null; realized_pnl: number;
  opened_at: number; closed_at: number | null;
}
```

- [ ] **Step 7: implement `store/store.ts`**

```ts
import type { Database } from "better-sqlite3";
import type { BotRow, RunRow, PersistedOrder, PersistedPosition } from "./types.js";

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

  deleteBot(id: string): void {
    this.db.prepare(`DELETE FROM bots WHERE id = ?`).run(id);
  }
}
```

- [ ] **Step 8: run test to verify it passes**

Run: `npm run test -w @huper/engine tests/store.test.ts`
Expected: PASS (5 it).

- [ ] **Step 9: typecheck + commit**

Run: `npm run typecheck -w @huper/engine`
Commit:
```bash
git add packages/engine/src/store packages/engine/tests/store.test.ts packages/engine/package.json
git commit -m "feat(engine): add better-sqlite3 state store (bots/runs/orders/positions)"
```

---

### Task 2: Core Bot/Risk Types + RiskManager

**Files:**
- Modify: `packages/core/src/types.ts` (append the block below)
- Create: `packages/engine/src/risk/risk.ts`
- Test: `packages/engine/tests/risk.test.ts`

**Interfaces (consumed/produced):**
- Consumes: core `Position`, `Side`, `NewOrder`, `Order`, `PriceTick` (already present).
- Produces (core `types.ts`): `BotStatus`, `RiskConfig`, `DEFAULT_RISK`, `RecentOrder`, `OrderAttempt`, `RiskSnapshot` (exact names used by engine + later tasks).
- Produces (engine): `class RiskManager` with `constructor(cfg: RiskConfig)` and `validate(attempt: OrderAttempt, snapshot: RiskSnapshot): { ok: true } | { ok: false; reason: string }`.

- [ ] **Step 1: write the failing test**

`packages/engine/tests/risk.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RiskManager, type OrderAttempt } from "../src/risk/risk.js";
import type { RiskSnapshot } from "@huper/core";

const base = {
  globalMaxPositionPct: 0.5, perBotMaxPositionPct: 0.2, maxOrderNotionalPct: 0.05,
  maxPriceDriftPct: 0.05, minOrderSize: 0.001, maxOrderSize: null, duplicateGuardMs: 2000,
};

const attempt: OrderAttempt = { botId: "b1", symbol: "BTC", side: "buy", price: 100, size: 0.1, kind: "limit", reduceOnly: false };

function snap(over: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return { botId: "b1", symbol: "BTC", balance: 10000, lastPrice: 100, botPositionNotional: 0, globalPositionNotional: 0, recentOrders: [], ...over };
}

describe("RiskManager", () => {
  it("allows a safe limit order", () => {
    expect(new RiskManager(base).validate(attempt, snap())).toEqual({ ok: true });
  });

  it("rejects order exceeding per-bot position cap (20% of balance)", () => {
    const r = new RiskManager(base).validate({ ...attempt, size: 0.1 }, snap({ botPositionNotional: 2000 }));
    expect(r).toEqual({ ok: false, reason: "exceeds per-bot position cap" });
  });

  it("rejects duplicate order within guard window", () => {
    const r = new RiskManager(base).validate(attempt, snap({ recentOrders: [{ id: "x", botId: "b1", symbol: "BTC", side: "buy", price: 100, size: 0.1, createdAt: Date.now() }] }));
    expect(r).toEqual({ ok: false, reason: "duplicate order" });
  });

  it("rejects limit order beyond price drift", () => {
    const r = new RiskManager(base).validate({ ...attempt, price: 110 }, snap({ lastPrice: 100 }));
    expect(r).toEqual({ ok: false, reason: "price drift beyond limit" });
  });

  it("rejects size below minimum", () => {
    const r = new RiskManager(base).validate({ ...attempt, size: 0.0001 }, snap());
    expect(r).toEqual({ ok: false, reason: "size below minimum" });
  });

  it("allows reduce-only market close regardless of drift", () => {
    const r = new RiskManager(base).validate({ ...attempt, kind: "market", price: null, reduceOnly: true }, snap({ lastPrice: 100 }));
    expect(r).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: run test to verify it fails**

Run: `npm run test -w @huper/engine tests/risk.test.ts`
Expected: FAIL — `RiskManager` not found.

- [ ] **Step 3: append types to `packages/core/src/types.ts`**

Append at the end of the file:
```ts
export const BotStatus = { Running: "running", Stopped: "stopped", Error: "error" } as const;
export type BotStatus = (typeof BotStatus)[keyof typeof BotStatus];

export interface RiskConfig {
  globalMaxPositionPct: number;
  perBotMaxPositionPct: number;
  maxOrderNotionalPct: number;
  maxPriceDriftPct: number;
  minOrderSize: number;
  maxOrderSize: number | null;
  duplicateGuardMs: number;
}

export const DEFAULT_RISK: RiskConfig = {
  globalMaxPositionPct: 0.5,
  perBotMaxPositionPct: 0.2,
  maxOrderNotionalPct: 0.05,
  maxPriceDriftPct: 0.05,
  minOrderSize: 0.001,
  maxOrderSize: null,
  duplicateGuardMs: 2000,
};

export interface RecentOrder {
  id: string;
  botId: string;
  symbol: string;
  side: Side;
  price: number | null;
  size: number;
  createdAt: number;
}

export interface OrderAttempt {
  botId: string;
  symbol: string;
  side: Side;
  price: number | null;
  size: number;
  kind: "limit" | "market";
  reduceOnly?: boolean;
}

export interface RiskSnapshot {
  botId: string;
  symbol: string;
  balance: number;
  lastPrice: number | null;
  botPositionNotional: number;
  globalPositionNotional: number;
  recentOrders: RecentOrder[];
}
```

- [ ] **Step 4: implement `risk/risk.ts`**

```ts
import type { RiskConfig, OrderAttempt, RiskSnapshot } from "@huper/core";

export class RiskManager {
  constructor(private cfg: RiskConfig) {}

  validate(a: OrderAttempt, s: RiskSnapshot): { ok: true } | { ok: false; reason: string } {
    if (Math.abs(a.size) < this.cfg.minOrderSize) return { ok: false, reason: "size below minimum" };
    if (this.cfg.maxOrderSize != null && Math.abs(a.size) > this.cfg.maxOrderSize) return { ok: false, reason: "size above maximum" };

    const dup = s.recentOrders.find(
      (o) => o.botId === a.botId && o.symbol === a.symbol && o.side === a.side &&
             o.price === a.price && o.size === a.size &&
             Date.now() - o.createdAt < this.cfg.duplicateGuardMs,
    );
    if (dup) return { ok: false, reason: "duplicate order" };

    const ref = a.price ?? s.lastPrice;
    if (ref == null) return { ok: false, reason: "no price reference" };
    const notional = ref * Math.abs(a.size);

    if (notional > s.balance * this.cfg.maxOrderNotionalPct) return { ok: false, reason: "exceeds order notional cap" };
    if (s.botPositionNotional + notional > s.balance * this.cfg.perBotMaxPositionPct) return { ok: false, reason: "exceeds per-bot position cap" };
    if (s.globalPositionNotional + notional > s.balance * this.cfg.globalMaxPositionPct) return { ok: false, reason: "exceeds global position cap" };

    if (a.kind === "limit" && !a.reduceOnly && a.price != null && s.lastPrice != null) {
      const drift = Math.abs(a.price - s.lastPrice) / s.lastPrice;
      if (drift > this.cfg.maxPriceDriftPct) return { ok: false, reason: "price drift beyond limit" };
    }
    return { ok: true };
  }
}
```

- [ ] **Step 5: run test to verify it passes**

Run: `npm run test -w @huper/engine tests/risk.test.ts`
Expected: PASS (6 it).

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck` (root — also verifies core additions compile)
Commit:
```bash
git add packages/core/src/types.ts packages/engine/src/risk packages/engine/tests/risk.test.ts
git commit -m "feat(core,engine): bot/risk types and RiskManager gate"
```

---

### Task 3: Strategy Framework — Strategy, Registry, Runner, Engine

**Files:**
- Create: `packages/engine/src/framework/strategy.ts`
- Create: `packages/engine/src/framework/registry.ts`
- Create: `packages/engine/src/framework/runner.ts`
- Create: `packages/engine/src/framework/engine.ts`
- Test: `packages/engine/tests/engine.test.ts`

**Interfaces (produced — used by every later task; exact names required):**

From `framework/strategy.ts`:
```ts
export interface BotState { [key: string]: unknown }

export interface StrategyCtx {
  readonly botId: string;
  readonly name: string;
  readonly symbol: string;
  readonly mode: "paper" | "live";
  readonly params: Record<string, unknown>;
  readonly state: BotState;
  getTick(): PriceTick | undefined;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<number>;
  createOrder(o: NewOrder): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  onFill(cb: (o: Order) => void): () => void;
  log(msg: string, meta?: unknown): void;
}

export interface Strategy {
  readonly name: string;
  readonly paramsSchema: z.ZodType;
  readonly cadenceMs: number;
  onStart(ctx: StrategyCtx): Promise<void>;
  onTick(tick: PriceTick, ctx: StrategyCtx): Promise<void>;
  onOrderFilled?(order: Order, ctx: StrategyCtx): Promise<void>;
  onStop(ctx: StrategyCtx, reason: string): Promise<void>;
}
```

From `framework/registry.ts`:
```ts
export class StrategyRegistry {
  register(s: Strategy): void;
  get(name: string): Strategy | undefined;
  list(): Strategy[];
}
```

From `framework/engine.ts`:
```ts
export interface BotSummary { id: string; name: string; strategy: string; symbol: string; status: string; params: Record<string, unknown>; state: BotState; createdAt: number; updatedAt: number }
export interface BotDetail extends BotSummary { orders: PersistedOrder[]; positions: PersistedPosition[]; runs: RunRow[] }
export interface EngineOptions { exchange: ExchangeAdapter; store: Store; risk: RiskManager; registry: StrategyRegistry; log: LoggerLike }
export class Engine {
  constructor(opts: EngineOptions);
  start(): Promise<void>;
  stop(): Promise<void>;
  createBot(input: { name: string; strategy: string; symbol: string; params: Record<string, unknown> }): Promise<BotSummary>;
  startBot(id: string): Promise<void>;
  stopBot(id: string, reason?: string): Promise<void>;
  deleteBot(id: string): Promise<void>;
  listBots(): BotSummary[];
  getBotDetail(id: string): Promise<BotDetail | undefined>;
  latestTick(symbol: string): PriceTick | undefined;
  stopAll(reason: string): Promise<number>;
}
```

`LoggerLike` = `{ info(obj: unknown, msg: string): void; error(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void }` (pino satisfies it).

- [ ] **Step 1: write the failing test**

`packages/engine/tests/engine.test.ts` (uses a real `PaperExchange`, real `Store` on `:memory:`, real `RiskManager`, and a registry with a fake strategy):
```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { PaperExchange } from "../src/exchange/paper.js";
import { openStore } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { RiskManager } from "../src/risk/risk.js";
import { DEFAULT_RISK } from "@huper/core";
import { StrategyRegistry } from "../src/framework/registry.js";
import { Engine } from "../src/framework/engine.js";
import type { Strategy, StrategyCtx } from "../src/framework/strategy.js";

class FakeStrategy implements Strategy {
  readonly name = "fake";
  readonly paramsSchema = z.object({ threshold: z.number().default(99) });
  readonly cadenceMs = 0;
  calls = { start: 0, tick: 0, stop: 0 };
  startedWith: StrategyCtx | undefined;
  onStart(ctx: StrategyCtx) { this.calls.start++; this.startedWith = ctx; }
  async onTick(t: { mid: number }, ctx: StrategyCtx) {
    this.calls.tick++;
    if (t.mid > (ctx.params.threshold as number) && !ctx.state.bought) {
      ctx.state.bought = true;
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", price: null, size: 0.1, type: "market" });
    }
  }
  async onStop(ctx: StrategyCtx) { this.calls.stop++; }
}

describe("Engine", () => {
  const exchange = new PaperExchange({ initialBalance: 10000 });
  const store = new Store(openStore(":memory:"));
  const registry = new StrategyRegistry();
  const strategy = new FakeStrategy();
  registry.register(strategy);
  const engine = new Engine({ exchange, store, risk: new RiskManager(DEFAULT_RISK), registry, log: { info: () => {}, error: () => {}, warn: () => {} } });
  const started = (async () => { await engine.start(); })();

  it("creates and starts a bot, dispatch ticks, and records an order", async () => {
    await started;
    const bot = await engine.createBot({ name: "Fake", strategy: "fake", symbol: "BTC", params: { threshold: 99 } });
    expect(bot.status).toBe("stopped");
    await engine.startBot(bot.id);
    expect(store.getBot(bot.id)?.status).toBe("running");

    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 1 });
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 101, timestamp: 2 });
    await new Promise((r) => setTimeout(r, 10));

    expect(strategy.calls.tick).toBeGreaterThanOrEqual(2);
    expect(strategy.calls.start).toBe(1);
    const orders = store.listOrders(bot.id);
    expect(orders.some((o) => o.side === "buy" && o.status === "filled")).toBe(true);

    await engine.stopBot(bot.id, "stopped");
    expect(strategy.calls.stop).toBe(1);
    expect(store.getBot(bot.id)?.status).toBe("stopped");
  });

  it("deletes a bot", async () => {
    const bot = await engine.createBot({ name: "Gone", strategy: "fake", symbol: "BTC", params: { threshold: 99 } });
    await engine.deleteBot(bot.id);
    expect(store.getBot(bot.id)).toBeUndefined();
  });

  it("rejects unknown strategy", async () => {
    await expect(engine.createBot({ name: "Nope", strategy: "nope", symbol: "BTC", params: {} })).rejects.toThrow("unknown strategy");
  });

  it("marks a bot error when a strategy throws", async () => {
    class Boom implements Strategy {
      readonly name = "boom"; readonly paramsSchema = z.object({}); readonly cadenceMs = 0;
      onStart() { throw new Error("boom"); }
      onTick() { return Promise.resolve(); }
      onStop() { return Promise.resolve(); }
    }
    registry.register(new Boom());
    const bot = await engine.createBot({ name: "Boom", strategy: "boom", symbol: "BTC", params: {} });
    await expect(engine.startBot(bot.id)).rejects.toThrow("boom");
    expect(store.getBot(bot.id)?.status).toBe("error");
  });
});
```

- [ ] **Step 2: run test to verify it fails**

Run: `npm run test -w @huper/engine tests/engine.test.ts`
Expected: FAIL — cannot find `../src/framework/registry.js`.

- [ ] **Step 3: implement `framework/strategy.ts`**

```ts
import type { z } from "zod";
import type { NewOrder, Order, Position, PriceTick } from "@huper/core";

export interface BotState { [key: string]: unknown }

export interface StrategyCtx {
  readonly botId: string;
  readonly name: string;
  readonly symbol: string;
  readonly mode: "paper" | "live";
  readonly params: Record<string, unknown>;
  readonly state: BotState;
  getTick(): PriceTick | undefined;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<number>;
  createOrder(o: NewOrder): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  onFill(cb: (o: Order) => void): () => void;
  log(msg: string, meta?: unknown): void;
}

export interface Strategy {
  readonly name: string;
  readonly paramsSchema: z.ZodType;
  readonly cadenceMs: number;
  onStart(ctx: StrategyCtx): Promise<void>;
  onTick(tick: PriceTick, ctx: StrategyCtx): Promise<void>;
  onOrderFilled?(order: Order, ctx: StrategyCtx): Promise<void>;
  onStop(ctx: StrategyCtx, reason: string): Promise<void>;
}
```

- [ ] **Step 4: implement `framework/registry.ts`**

```ts
import type { Strategy } from "./strategy.js";

export class StrategyRegistry {
  private map = new Map<string, Strategy>();
  register(s: Strategy): void { this.map.set(s.name, s); }
  get(name: string): Strategy | undefined { return this.map.get(name); }
  list(): Strategy[] { return [...this.map.values()]; }
}
```

- [ ] **Step 5: implement `framework/runner.ts`**

```ts
import type { Order, PriceTick, NewOrder } from "@huper/core";
import type { Engine } from "./engine.js";
import type { Strategy, StrategyCtx, BotState } from "./strategy.js";

export class BotRunner {
  readonly botId: string;
  readonly name: string;
  readonly symbol: string;
  readonly cadenceMs: number;
  lastEval = 0;
  private ctx: StrategyCtx;
  private state: BotState;
  private fillCbs = new Set<(o: Order) => void>();
  active = true;

  constructor(
    private engine: Engine,
    private strategy: Strategy,
    params: Record<string, unknown>,
    state: string,
    botId: string, name: string, symbol: string,
  ) {
    this.botId = botId;
    this.name = name;
    this.symbol = symbol;
    this.cadenceMs = strategy.cadenceMs;
    this.state = safeParse(state);
    this.ctx = {
      botId, name, symbol,
      mode: engine.mode(),
      params,
      state: this.state,
      getTick: () => engine.latestTick(symbol),
      getPositions: () => engine.positionsFor(symbol),
      getBalance: () => engine.balance(),
      createOrder: (o: NewOrder) => engine.executeOrder(botId, symbol, o),
      cancelOrder: (orderId: string) => engine.cancelOrder(botId, orderId),
      onFill: (cb: (o: Order) => void) => { this.fillCbs.add(cb); return () => this.fillCbs.delete(cb); },
      log: (msg: string, meta?: unknown) => engine.logHandle().info({ botId, ...(meta as object) }, msg),
    };
  }

  async start(): Promise<void> {
    await this.strategy.onStart(this.ctx);
    this.lastEval = 0;
  }

  async evaluate(tick: PriceTick): Promise<void> {
    if (!this.active) return;
    try {
      await this.strategy.onTick(tick, this.ctx);
    } finally {
      this.engine.saveBotState(this.botId, this.state);
    }
  }

  async onOrderFilled(order: Order): Promise<void> {
    if (!this.active) return;
    await this.strategy.onOrderFilled?.(order, this.ctx);
    this.engine.saveBotState(this.botId, this.state);
  }

  hasOrder(id: string): boolean { return this.myOrderIds().has(id); }

  private myOrderIds(): Set<string> { return this.engine.orderIdsFor(this.botId); }

  async stop(reason: string): Promise<void> {
    this.active = false;
    await this.engine.cancelAllOrders(this.botId);
    try { await this.strategy.onStop(this.ctx, reason); } finally { this.engine.saveBotState(this.botId, this.state); }
  }
}

function safeParse(s: string): BotState {
  try { return JSON.parse(s) as BotState; } catch { return {}; }
}
```

- [ ] **Step 6: implement `framework/engine.ts`**

```ts
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
```

- [ ] **Step 7: run test to verify it passes**

Run: `npm run test -w @huper/engine tests/engine.test.ts`
Expected: PASS (4 it).

- [ ] **Step 8: typecheck + commit**

Run: `npm run typecheck -w @huper/engine`
Commit:
```bash
git add packages/engine/src/framework packages/engine/tests/engine.test.ts
git commit -m "feat(engine): strategy framework with runner and shared tick-loop engine"
```

---

### Task 4: Proof Strategies — Grid, DCA-Martingale, Trend

**Files:**
- Create: `packages/engine/src/strategies/grid.ts`
- Create: `packages/engine/src/strategies/dca.ts`
- Create: `packages/engine/src/strategies/trend.ts`
- Modify: `packages/engine/src/strategies/index.ts` (new — registers all three; exports `buildRegistry()`)
- Test: `packages/engine/tests/strategies.test.ts`

**Interfaces (produced):**
- `export function buildRegistry(): StrategyRegistry` — registers `grid`, `dca`, `trend` (exact names Task 5/6 rely on).

- [ ] **Step 1: write the failing tests**

`packages/engine/tests/strategies.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PaperExchange } from "../src/exchange/paper.js";
import { openStore } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { RiskManager } from "../src/risk/risk.js";
import { DEFAULT_RISK } from "@huper/core";
import { Engine } from "../src/framework/engine.js";
import { buildRegistry } from "../src/strategies/index.js";

const log = { info: () => {}, error: () => {}, warn: () => {} };

function setup(balance = 10000) {
  const exchange = new PaperExchange({ initialBalance: balance });
  const store = new Store(openStore(":memory:"));
  const engine = new Engine({ exchange, store, risk: new RiskManager(DEFAULT_RISK), registry: buildRegistry(), log });
  return { exchange, store, engine };
}

async function push(exchange: PaperExchange, mid: number, i: number) {
  exchange.pushTick({ symbol: "BTC", bid: mid, ask: mid, mid, timestamp: i });
  await new Promise((r) => setTimeout(r, 5));
}

describe("Grid strategy", () => {
  it("places 2*levels initial ladder orders, then re-hedges on a fill", async () => {
    const { exchange, store, engine } = setup();
    await engine.start();
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 0 });
    const bot = await engine.createBot({ name: "G", strategy: "grid", symbol: "BTC", params: { levels: 2, spacingPct: 0.01, orderSize: 0.1 } });
    await engine.startBot(bot.id);

    expect(store.listOrders(bot.id).filter((o) => o.status === "open")).toHaveLength(4);

    await push(exchange, 99, 1); // fills the buy at 99
    await push(exchange, 99, 2);

    const orders = store.listOrders(bot.id);
    const reHedged = orders.filter((o) => o.price !== null && o.price >= 99.9 && o.side === "sell" && o.status === "open");
    expect(reHedged.length).toBeGreaterThan(0);
  });
});

describe("DCA strategy", () => {
  it("averages down on drops and closes on take-profit", async () => {
    const { exchange, store, engine } = setup();
    await engine.start();
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 0 });
    const bot = await engine.createBot({ name: "D", strategy: "dca", symbol: "BTC", params: { stepPct: 0.02, takeProfitPct: 0.05, totalSteps: 3, baseSize: 0.1, sizeMultiplier: 2 } });
    await engine.startBot(bot.id);

    await push(exchange, 100, 1); // initial market buy at 100
    expect(store.listOrders(bot.id).some((o) => o.side === "buy" && o.status === "filled")).toBe(true);

    await push(exchange, 98, 2);   // -2% → second buy
    await push(exchange, 96, 3);   // -2% → third buy
    const pos = await exchange.openPositions();
    expect(pos[0]?.size).toBeGreaterThan(0.2);

    await push(exchange, 103, 4);  // >5% above avg → take profit close
    const after = await exchange.openPositions();
    expect(after).toHaveLength(0);
  });
});

describe("Trend strategy", () => {
  it("opens a long after a rising EMA cross with RSI confirmation", async () => {
    const { exchange, store, engine } = setup();
    await engine.start();
    const bot = await engine.createBot({ name: "T", strategy: "trend", symbol: "BTC", params: { fastEma: 2, slowEma: 5, orderSize: 0.1, rsiPeriod: 5, oversold: 30, overbought: 70, stopLossPct: 0.05, takeProfitPct: 0.1 } });
    await engine.startBot(bot.id);

    for (let i = 1; i <= 20; i++) await push(exchange, 100 + i, i); // strong uptrend

    const buys = store.listOrders(bot.id).filter((o) => o.side === "buy" && o.status === "filled");
    expect(buys.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: run test to verify it fails**

Run: `npm run test -w @huper/engine tests/strategies.test.ts`
Expected: FAIL — cannot find `./strategies/index.js`.

- [ ] **Step 3: implement `strategies/grid.ts`**

```ts
import { z } from "zod";
import { OrderType } from "@huper/core";
import type { Strategy, StrategyCtx } from "../framework/strategy.js";

const params = z.object({
  levels: z.number().int().min(1).max(50),
  spacingPct: z.number().positive().max(0.1),
  orderSize: z.number().positive(),
});

export class GridStrategy implements Strategy {
  readonly name = "grid";
  readonly paramsSchema = params;
  readonly cadenceMs = 0;

  async onStart(ctx: StrategyCtx): Promise<void> {
    const tick = ctx.getTick();
    if (!tick) throw new Error("grid: no price yet");
    const { levels, spacingPct, orderSize } = ctx.params as z.infer<typeof params>;
    ctx.state.base = tick.mid;
    for (let i = 1; i <= levels; i++) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Limit, price: round2(tick.mid * (1 - i * spacingPct)), size: orderSize });
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Limit, price: round2(tick.mid * (1 + i * spacingPct)), size: orderSize });
    }
  }

  async onTick(): Promise<void> { /* fills drive re-hedging */ }

  async onOrderFilled(order: { side: string; price: number | null }, ctx: StrategyCtx): Promise<void> {
    if (order.price == null) return;
    const spacingPct = (ctx.params as { spacingPct: number }).spacingPct;
    const orderSize = (ctx.params as { orderSize: number }).orderSize;
    if (order.side === "buy") {
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Limit, price: round2(order.price * (1 + spacingPct)), size: orderSize });
    } else {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Limit, price: round2(order.price * (1 - spacingPct)), size: orderSize });
    }
  }

  async onStop(): Promise<void> {}
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
```

- [ ] **Step 4: implement `strategies/dca.ts`**

```ts
import { z } from "zod";
import { OrderType, Side } from "@huper/core";
import type { Strategy, StrategyCtx } from "../framework/strategy.js";

const params = z.object({
  stepPct: z.number().positive().max(0.2),
  takeProfitPct: z.number().positive().max(0.5),
  totalSteps: z.number().int().min(1).max(20),
  baseSize: z.number().positive(),
  sizeMultiplier: z.number().min(1).max(5),
});

export class DcaStrategy implements Strategy {
  readonly name = "dca";
  readonly paramsSchema = params;
  readonly cadenceMs = 0;

  async onStart(ctx: StrategyCtx): Promise<void> {
    const p = ctx.params as z.infer<typeof params>;
    await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size: p.baseSize });
    ctx.state.entered = true;
    ctx.state.steps = 0;
  }

  async onTick(tick: { mid: number }, ctx: StrategyCtx): Promise<void> {
    const p = ctx.params as z.infer<typeof params>;
    const positions = await ctx.getPositions();
    const pos = positions[0];
    if (!pos) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size: p.baseSize });
      ctx.state.steps = 0;
      return;
    }
    const lastEntry = (ctx.state.lastEntry as number) ?? pos.avgEntry;
    if (pos.side === Side.Buy && tick.mid <= lastEntry * (1 - p.stepPct) && (ctx.state.steps as number) < p.totalSteps) {
      ctx.state.steps = (ctx.state.steps as number) + 1;
      const size = p.baseSize * Math.pow(p.sizeMultiplier, ctx.state.steps as number);
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size });
    }
    ctx.state.lastEntry = tick.mid;

    const unrealized = (tick.mid - pos.avgEntry) / pos.avgEntry;
    if (unrealized >= p.takeProfitPct) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Market, price: null, size: pos.size, reduceOnly: true });
    }
  }

  async onStop(_ctx: StrategyCtx): Promise<void> {
    // no-op: position flattening is owned solely by EmergencyStop (human decision, Task 5)
  }
}
```

- [ ] **Step 5: implement `strategies/trend.ts`**

```ts
import { z } from "zod";
import { OrderType, Side } from "@huper/core";
import type { Strategy, StrategyCtx } from "../framework/strategy.js";

const params = z.object({
  fastEma: z.number().int().min(1).max(20),
  slowEma: z.number().int().min(2).max(100),
  orderSize: z.number().positive(),
  rsiPeriod: z.number().int().min(2).max(30),
  oversold: z.number().min(5).max(45),
  overbought: z.number().min(55).max(95),
  stopLossPct: z.number().positive().max(0.2),
  takeProfitPct: z.number().positive().max(0.5),
});

export class TrendStrategy implements Strategy {
  readonly name = "trend";
  readonly paramsSchema = params;
  readonly cadenceMs = 0;

  async onStart(): Promise<void> {}

  async onTick(tick: { mid: number }, ctx: StrategyCtx): Promise<void> {
    const p = ctx.params as z.infer<typeof params>;
    const closes = (ctx.state.closes as number[] | undefined) ?? [];
    closes.push(tick.mid);
    if (closes.length > 200) closes.shift();
    ctx.state.closes = closes;
    if (closes.length < p.slowEma + 1) return;

    const fast = ema(closes, p.fastEma);
    const slow = ema(closes, p.slowEma);
    const prevFast = ema(closes.slice(0, -1), p.fastEma);
    const prevSlow = ema(closes.slice(0, -1), p.slowEma);
    const rsi = calcRsi(closes, p.rsiPeriod);

    const positions = await ctx.getPositions();
    const pos = positions[0];

    if (pos) {
      const unrealized = pos.side === Side.Buy ? (tick.mid - pos.avgEntry) / pos.avgEntry : (pos.avgEntry - tick.mid) / pos.avgEntry;
      if (unrealized <= -p.stopLossPct || unrealized >= p.takeProfitPct) {
        const closeSide = pos.side === Side.Buy ? "sell" : "buy";
        await ctx.createOrder({ symbol: ctx.symbol, side: closeSide, type: OrderType.Market, price: null, size: pos.size, reduceOnly: true });
      }
      return;
    }

    const crossUp = prevFast <= prevSlow && fast > slow;
    const crossDown = prevFast >= prevSlow && fast < slow;
    if (crossUp && rsi > 50) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size: p.orderSize });
    } else if (crossDown && rsi < 50) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Market, price: null, size: p.orderSize });
    }
  }

  async onStop(_ctx: StrategyCtx): Promise<void> {
    // no-op: position flattening is owned solely by EmergencyStop (human decision, Task 5)
  }
}

function ema(closes: number[], period: number): number {
  if (closes.length <= period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function calcRsi(closes: number[], period: number): number {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}
```

- [ ] **Step 6: implement `strategies/index.ts`**

```ts
import { StrategyRegistry } from "../framework/registry.js";
import { GridStrategy } from "./grid.js";
import { DcaStrategy } from "./dca.js";
import { TrendStrategy } from "./trend.js";

export function buildRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();
  registry.register(new GridStrategy());
  registry.register(new DcaStrategy());
  registry.register(new TrendStrategy());
  return registry;
}

export { GridStrategy, DcaStrategy, TrendStrategy };
```

- [ ] **Step 7: run test to verify it passes**

Run: `npm run test -w @huper/engine tests/strategies.test.ts`
Expected: PASS (3 it). If a strategy assertion fails, debug the strategy's math (tick cadence uses `cadenceMs`; PaperExchange ticks trigger engine dispatch synchronously via `onTick`).

- [ ] **Step 8: typecheck + commit**

Run: `npm run typecheck -w @huper/engine`
Commit:
```bash
git add packages/engine/src/strategies packages/engine/tests/strategies.test.ts
git commit -m "feat(engine): grid, dca and trend proof strategies"
```

---

### Task 5: Market Data Feed + Emergency Stop + Live Market-Order Fix

**Files:**
- Create: `packages/engine/src/market/feed.ts`
- Create: `packages/engine/src/emergency.ts`
- Modify: `packages/engine/src/exchange/live.ts` (placeOrder market branch → Ioc encoding)
- Test: `packages/engine/tests/emergency.test.ts`

**Interfaces (produced):**
- `class MarketDataFeed` with `constructor(wsUrl: string)`, `async connect()`, `async disconnect()`, `onTick(cb: (t: PriceTick) => void): () => void` (subscribes HL `allMids`; maps each coin via `midToTick`).
- `class EmergencyStop` with `constructor(engine: Engine, exchange: ExchangeAdapter)` and `async run(): Promise<{ stoppedBots: number; closedPositions: number }>`.

> `Store.deleteBot` and `Engine.deleteBot` are already specified in Task 1 (store) and Task 3 (engine). No further store/engine edits needed here.

- [ ] **Step 1: implement `market/feed.ts`**

```ts
import { SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";
import { midToTick } from "../exchange/hyperliquid-mapping.js";
import type { PriceTick } from "@huper/core";

export class MarketDataFeed {
  private subs: SubscriptionClient | undefined;
  private sub: { unsubscribe(): Promise<void> } | undefined;
  private cbs = new Set<(t: PriceTick) => void>();

  constructor(private wsUrl: string) {}

  async connect(): Promise<void> {
    this.subs = new SubscriptionClient({ transport: new WebSocketTransport({ url: this.wsUrl }) });
    this.sub = await this.subs.allMids((data) => {
      const now = Date.now();
      for (const [coin, mid] of Object.entries(data.mids)) {
        const t = midToTick(coin, mid, now);
        for (const cb of this.cbs) cb(t);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.sub) await this.sub.unsubscribe();
    this.sub = undefined;
  }

  onTick(cb: (t: PriceTick) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
}
```

- [ ] **Step 2: fix `LiveExchange.placeOrder` market encoding**

In `live.ts`, replace the `order` construction:
```ts
const refPrice = this.ticks.get(n.symbol)?.mid;
if (n.type === OrderType.Market) {
  if (refPrice == null) throw new Error("live market order requires a cached tick price");
  const order = {
    a: 0, b: n.side === Side.Buy, p: refPrice.toFixed(6),
    s: String(n.size), r: !!n.reduceOnly, t: { limit: { tif: "Ioc" as const } },
  };
  return this.sendAndMap(n, order);
}
const order = {
  a: 0, b: n.side === Side.Buy, p: (n.price ?? refPrice ?? 0).toFixed(6),
  s: String(n.size), r: !!n.reduceOnly, t: { limit: { tif: "Gtc" as const } },
};
return this.sendAndMap(n, order);
```
And factor the send+status handling into a private helper `sendAndMap(n, order)` that contains the existing `this.exchange.order(...)` + status mapping logic. Keep the `// NOTE: a:0 asset index` comment (known Phase 2b concern). Typecheck must stay clean.

- [ ] **Step 3: implement `emergency.ts`**

```ts
import type { ExchangeAdapter, Position } from "@huper/core";
import { OrderType, Side } from "@huper/core";
import type { Engine } from "./framework/engine.js";

export class EmergencyStop {
  constructor(private engine: Engine, private exchange: ExchangeAdapter) {}

  async run(): Promise<{ stoppedBots: number; closedPositions: number }> {
    const positions = await this.exchange.openPositions();
    const stoppedBots = await this.engine.stopAll("emergency");
    let closed = 0;
    for (const p of positions) {
      try {
        await this.exchange.placeOrder({
          symbol: p.symbol, side: p.side === Side.Buy ? Side.Sell : Side.Buy,
          type: OrderType.Market, price: null, size: p.size, reduceOnly: true,
        });
        closed++;
      } catch { /* log and continue closing the rest */ }
    }
    return { stoppedBots, closedPositions: closed };
  }
}
```

- [ ] **Step 4: write the failing test**

`packages/engine/tests/emergency.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PaperExchange } from "../src/exchange/paper.js";
import { openStore } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { RiskManager } from "../src/risk/risk.js";
import { DEFAULT_RISK } from "@huper/core";
import { Engine } from "../src/framework/engine.js";
import { buildRegistry } from "../src/strategies/index.js";
import { EmergencyStop } from "../src/emergency.js";

describe("EmergencyStop", () => {
  it("closes open positions and stops bots", async () => {
    const exchange = new PaperExchange({ initialBalance: 10000 });
    const store = new Store(openStore(":memory:"));
    const engine = new Engine({ exchange, store, risk: new RiskManager(DEFAULT_RISK), registry: buildRegistry(), log: { info: () => {}, error: () => {}, warn: () => {} } });
    await engine.start();
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 0 });
    const bot = await engine.createBot({ name: "D", strategy: "dca", symbol: "BTC", params: { stepPct: 0.02, takeProfitPct: 0.1, totalSteps: 2, baseSize: 0.1, sizeMultiplier: 2 } });
    await engine.startBot(bot.id);
    await new Promise((r) => setTimeout(r, 5));
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 1 });
    await new Promise((r) => setTimeout(r, 5));

    expect((await exchange.openPositions()).length).toBeGreaterThan(0);

    const result = await new EmergencyStop(engine, exchange).run();
    expect(result.closedPositions).toBeGreaterThan(0);
    expect((await exchange.openPositions())).toHaveLength(0);
    expect(store.getBot(bot.id)?.status).toBe("stopped");
  });
});
```

- [ ] **Step 5: run test to verify it passes**

Run: `npm run test -w @huper/engine tests/emergency.test.ts`
Expected: PASS (1 it).

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck -w @huper/engine`
Commit:
```bash
git add packages/engine/src/market packages/engine/src/emergency.ts packages/engine/src/exchange/live.ts packages/engine/tests/emergency.test.ts
git commit -m "feat(engine): market data feed, emergency stop, Ioc market orders"
```

---

### Task 6: HTTP API Extension + Bootstrap Wiring + Integration Verification

**Files:**
- Modify: `packages/engine/src/server.ts` (bot CRUD + emergency routes)
- Modify: `packages/engine/src/main.ts` (wire store/engine/feed)
- Modify: `packages/engine/tests/server.test.ts` (existing tests get an engine)
- Modify: `packages/engine/src/index.ts` (re-export new API)
- Test: `packages/engine/tests/server.test.ts` (extended)

**Interfaces (produced):**
- `buildApp(opts: { exchange: ExchangeAdapter; engine: Engine }): FastifyInstance` — all existing routes plus:
  - `POST /bots` → 201 `BotSummary`
  - `GET /bots` → `BotSummary[]`
  - `GET /bots/:id` → `BotDetail`
  - `POST /bots/:id/start` → `{ ok: true }`
  - `POST /bots/:id/stop` → `{ ok: true }`
  - `DELETE /bots/:id` → `{ ok: true }`
  - `POST /emergency-stop` → `{ stoppedBots, closedPositions }`
- `packages/engine/src/index.ts` re-exports: `Engine`, `StrategyRegistry`, `buildRegistry`, `EmergencyStop`, `MarketDataFeed`, `Store`, `openStore`, `BotSummary`, `BotDetail`, `RiskManager`.

- [ ] **Step 1: extend `server.ts`**

```ts
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { ExchangeAdapter, NewOrder } from "@huper/core";
import type { Engine } from "./framework/engine.js";
import { EmergencyStop } from "./emergency.js";

export function buildApp(opts: { exchange: ExchangeAdapter; engine: Engine }): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { symbol: string } }>("/ticks/:symbol", async (req) => {
    const t = await opts.exchange.tick(req.params.symbol);
    return { tick: t ?? null };
  });

  app.post<{ Body: NewOrder }>("/orders", async (req, reply) => {
    try {
      const order = await opts.exchange.placeOrder(req.body);
      return reply.code(201).send(order);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/balances", async () => opts.exchange.balances());
  app.get("/positions", async () => opts.exchange.openPositions());

  app.post<{ Body: { name: string; strategy: string; symbol: string; params: Record<string, unknown> } }>("/bots", async (req, reply) => {
    try {
      const bot = await opts.engine.createBot(req.body);
      return reply.code(201).send(bot);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/bots", async () => opts.engine.listBots());

  app.get<{ Params: { id: string } }>("/bots/:id", async (req, reply) => {
    const detail = await opts.engine.getBotDetail(req.params.id);
    if (!detail) return reply.code(404).send({ error: "bot not found" });
    return detail;
  });

  app.post<{ Params: { id: string } }>("/bots/:id/start", async (req, reply) => {
    try { await opts.engine.startBot(req.params.id); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Params: { id: string } }>("/bots/:id/stop", async (req, reply) => {
    try { await opts.engine.stopBot(req.params.id); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.delete<{ Params: { id: string } }>("/bots/:id", async (req, reply) => {
    try { await opts.engine.deleteBot(req.params.id); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post("/emergency-stop", async () => {
    return new EmergencyStop(opts.engine, opts.exchange).run();
  });

  return app;
}
```

- [ ] **Step 2: update `main.ts` bootstrap**

```ts
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, createLogger, DEFAULT_RISK } from "@huper/core";
import { PaperExchange } from "./exchange/paper.js";
import { LiveExchange } from "./exchange/live.js";
import { openStore } from "./store/db.js";
import { Store } from "./store/store.js";
import { RiskManager } from "./risk/risk.js";
import { Engine } from "./framework/engine.js";
import { buildRegistry } from "./strategies/index.js";
import { MarketDataFeed } from "./market/feed.js";
import { buildApp } from "./server.js";
import { EmergencyStop } from "./emergency.js";
import type { ExchangeAdapter } from "@huper/core";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main() {
  const cfg = loadConfig();
  const log = createLogger("engine");

  const dbPath = process.env.HUPER_DB_PATH ?? "data/huper.db";
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true }); // human decision: boot crash fix (better-sqlite3 needs existing dir)
  const store = new Store(openStore(dbPath));
  const exchange: ExchangeAdapter = cfg.mode === "paper"
    ? new PaperExchange({ initialBalance: cfg.paperBalance })
    : new LiveExchange({ privateKey: cfg.privateKey!, rpcUrl: cfg.rpcUrl, wsUrl: cfg.wsUrl });
  await exchange.connect();
  log.info({ mode: cfg.mode }, "exchange connected");

  const engine = new Engine({ exchange, store, risk: new RiskManager(DEFAULT_RISK), registry: buildRegistry(), log });
  await engine.start();

  let feed: MarketDataFeed | undefined;
  if (cfg.mode === "paper") {
    feed = new MarketDataFeed(cfg.wsUrl);
    feed.onTick((t) => (exchange as PaperExchange).pushTick(t));
    await feed.connect();
    log.info("market data feed connected (paper)");
  }

  const app = buildApp({ exchange, engine });
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  log.info({ port }, "engine listening");

  const stop = async () => {
    await engine.stop();
    if (feed) await feed.disconnect();
    await exchange.disconnect();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: update existing `server.test.ts` (add engine to `buildApp`)**

Keep the 3 existing assertions. Build the engine inside the test setup:
```ts
const exchange = new PaperExchange({ initialBalance: 1000 });
const store = new Store(openStore(":memory:"));
const engine = new Engine({ exchange, store, risk: new RiskManager(DEFAULT_RISK), registry: buildRegistry(), log: { info: () => {}, error: () => {}, warn: () => {} } });
await engine.start();
const app = buildApp({ exchange, engine });
```
Then add these cases at the end of the file:
```ts
it("creates and starts a bot via HTTP", async () => {
  exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 0 });
  const created = await app.inject({ method: "POST", url: "/bots", payload: { name: "HTTP Grid", strategy: "grid", symbol: "BTC", params: { levels: 2, spacingPct: 0.01, orderSize: 0.1 } } });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;

  const started = await app.inject({ method: "POST", url: `/bots/${id}/start` });
  expect(started.statusCode).toBe(200);

  const list = await app.inject({ method: "GET", url: "/bots" });
  expect(list.json()).toHaveLength(1);

  const stopped = await app.inject({ method: "POST", url: `/bots/${id}/stop` });
  expect(stopped.json()).toEqual({ ok: true });
});

it("rejects bad bot params", async () => {
  const res = await app.inject({ method: "POST", url: "/bots", payload: { name: "Bad", strategy: "grid", symbol: "BTC", params: { levels: -1 } } });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 4: update `index.ts` re-exports**

```ts
export { PaperExchange } from "./exchange/paper.js";
export { LiveExchange } from "./exchange/live.js";
export * from "./exchange/hyperliquid-mapping.js";
export { buildApp } from "./server.js";
export { Engine, type BotSummary, type BotDetail } from "./framework/engine.js";
export { StrategyRegistry } from "./framework/registry.js";
export type { Strategy, StrategyCtx } from "./framework/strategy.js";
export { buildRegistry, GridStrategy, DcaStrategy, TrendStrategy } from "./strategies/index.js";
export { RiskManager } from "./risk/risk.js";
export { Store } from "./store/store.js";
export { openStore } from "./store/db.js";
export { EmergencyStop } from "./emergency.js";
export { MarketDataFeed } from "./market/feed.js";
```

- [ ] **Step 5: run full engine test suite**

Run: `npm run test -w @huper/engine`
Expected: ALL PASS (store 5, risk 6, engine 4, strategies 3, emergency 1, server 5 = 24 tests).

- [ ] **Step 6: typecheck all workspaces + commit**

Run: `npm run typecheck`
Commit:
```bash
git add packages/engine
git commit -m "feat(engine): HTTP bot management API, bootstrap wiring, engine exports"
```

- [ ] **Step 7: manual smoke (paper)**

Run: `npm run dev -w @huper/engine` in a terminal.
In another:
```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3001/bots -ContentType application/json -Body '{"name":"Smoke Grid","strategy":"grid","symbol":"BTC","params":{"levels":2,"spacingPct":0.01,"orderSize":0.1}}'
Invoke-RestMethod -Method Post -Uri http://localhost:3001/bots/<id>/start
Invoke-RestMethod http://localhost:3001/health
```
Expected: bot created, started, health ok. Stop with Ctrl+C.

---

## Self-Review Notes

- All `Strategy` names in tests (`grid`, `dca`, `trend`, `fake`, `boom`) must be unique in a single registry instance per test file — each test file builds its own registry.
- `Engine.executeOrder` throws `RiskManager` rejection reasons as plain `Error`s — HTTP maps them to 400.
- Live market orders now require a cached tick; in `main.ts` live mode the `LiveExchange` subscribes `allMids` itself on `connect()`, so a tick is present before any strategy runs.
- The `a: 0` asset-index placeholder is a known Phase 2b concern (symbol→index via `info.meta()`); not fixed here.
