# Phase 2b Implementation Plan: Live-order Correctness, Bot Isolation, and Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 4 Important + 5 Minor items deferred from the Phase 2a whole-branch review, making the engine production-viable in live mode. Scope is hardening only: live `userFills` handling, store-order status correctness, bot-isolated position reads, runner re-entrancy guard, emergency-stop re-scan, reduce-only risk exemption, balance-refresh debounce, crash-recovery boot, and `deleteBot` cascade with indexes.

**Architecture:** No restructuring — targeted patches to existing files. Live fills now reach the engine through a `userFills` WebSocket subscription (in addition to the synchronous Ioc fill path); `Engine.routeFill` marks store orders `filled`; `Engine.positionsFor` reads bot-owned open positions from the store instead of the whole-account exchange aggregate; `BotRunner.evaluate` is guarded against overlap; `EmergencyStop` re-reads positions after stopping; `RiskManager` exempts reduce-only closes from position caps; `refreshMeta` is time-throttled; boot marks stale `running` bots as recovered.

**Tech Stack:** TypeScript (strict, ESM), npm workspaces (`@huper/core`, `@huper/engine`), vitest, fastify, zod, better-sqlite3, `@nktkas/hyperliquid` 0.33.3, viem. No new dependencies.

## Background

Phase 2a (`d96cb2e..c6a02dc`) was reviewed in full. It shipped the engine (tick-loop, `BotRunner`, `Strategy` registry, `RiskManager`, `Store`, `EmergencyStop`, paper + live exchanges, HTTP API) — but the review flagged correctness gaps that this phase closes:

- **CRITICAL (fixed in 2a as `ab31b8f`):** positions never persisted → risk notional caps were inert. Already resolved; not in scope here.
- **Important #1:** live `onFill` never fires (LiveExchange keeps `fillCbs` but nothing emits via the `userFills` subscription).
- **Important #2:** store order status never → `filled`; resting-limit fills leave the order row `open`.
- **Important #3:** `positionsFor` is symbol-scoped, not bot-scoped — two bots on one symbol each see the aggregate.
- **Important #4:** no in-flight mutex on `BotRunner.evaluate` → re-entrancy on overlapping ticks.
- **Minor:** EmergencyStop stale-snapshot race; reduce-only still hits position caps; `deleteBot` orphans children + no `bot_id` indexes; bots stuck `running` after crash; `refreshMeta` re-balances on every tick.

## Source of truth

- Design spec: `docs/superpowers/specs/2026-08-05-huper-phase2b-design.md`
- Core contract: `packages/core/src/types.ts` (fixed — no changes this phase)
- Phase 2a plan for conventions: `docs/superpowers/plans/2026-08-05-huper-phase2a.md`

---

### Task 6: Store cascade, indexes, crash recovery

**Files:**
- Edit: `packages/engine/src/store/store.ts` — `deleteBot` cascade
- Edit: `packages/engine/src/store/db.ts` — `bot_id` indexes
- Edit: `packages/engine/src/main.ts` — boot-time `recoverStaleBots`
- Create: `packages/engine/src/recover.ts` — exported `recoverStaleBots`
- Test: `packages/engine/tests/store.test.ts` (extend) + `packages/engine/tests/recover.test.ts` (new)

**Interfaces (produced):**
- `Store.deleteBot(id)` now also deletes child `runs`, `orders`, `positions`, `equity` rows before the bot row.
- `openStore(path)` adds idempotent indexes on `runs(bot_id)`, `orders(bot_id)`, `positions(bot_id)`, `equity(bot_id)`.
- `recoverStaleBots(store, log): void` — for every bot in `status='running'`, set it `stopped` and finish its open run with `'crash_recovered'`. It touches no orders/positions.

- [ ] **Step 1: write the failing store cascade test**

Extend `packages/engine/tests/store.test.ts`. Replace the existing final `"deletes a bot"` block semantics (keep it) but add a cascade test that seeds a run, order, position, and equity row for a bot, deletes it, and asserts all child rows are gone (count via `listRuns`/`listOrders`/`listPositions`/`equity` select). Note the store needs an `equity` reader or run queries against the raw `db` handle exposed for this test (the test has the `db` already).

```ts
it("deleteBot cascades children", () => {
  // seed bot b2 + run + order + position + equity row against db directly
  store.saveBot({ id: "b2", name: "C", strategy: "grid", symbol: "BTC", params: "{}", status: "stopped", state: "{}", created_at: 5, updated_at: 5 });
  store.createBotRun({ id: "r2", bot_id: "b2", mode: "paper", started_at: 6, stopped_at: null, stop_reason: null });
  store.createOrder({ id: "o2", bot_id: "b2", exchange_id: null, symbol: "BTC", side: "buy", price: 100, size: 0.1, status: "open", filled_size: 0, avg_price: null, created_at: 7, updated_at: 7 });
  store.createPosition({ id: "p2", bot_id: "b2", symbol: "BTC", side: "buy", size: 0.1, avg_entry: 100, mark_price: null, realized_pnl: 0, opened_at: 8, closed_at: null });
  db.prepare(`INSERT INTO equity (id,bot_id,ts,value) VALUES ('e2','b2',9,100)`).run();
  store.deleteBot("b2");
  expect(store.getBot("b2")).toBeUndefined();
  expect(store.listRuns()).not.toEqual([...])  // assert child run gone
  expect(store.listOrders()).toEqual([]);
  expect(store.listPositions()).toEqual([]);
  expect((db.prepare(`SELECT COUNT(*) c FROM equity`).get() as { c: number }).c).toBe(0);
});
```
Also assert the child tables still exist and `orders` row is absent post-delete.

- [ ] **Step 2: implement `deleteBot` cascade in `store.ts`**

```ts
deleteBot(id: string): void {
  this.db.prepare(`DELETE FROM runs WHERE bot_id = ?`).run(id);
  this.db.prepare(`DELETE FROM orders WHERE bot_id = ?`).run(id);
  this.db.prepare(`DELETE FROM positions WHERE bot_id = ?`).run(id);
  this.db.prepare(`DELETE FROM equity WHERE bot_id = ?`).run(id);
  this.db.prepare(`DELETE FROM bots WHERE id = ?`).run(id);
}
```

- [ ] **Step 3: add indexes in `db.ts`**

Append after the existing `db.exec` block (idempotent, inside the same exec string or a second exec):

```sql
CREATE INDEX IF NOT EXISTS idx_runs_bot ON runs(bot_id);
CREATE INDEX IF NOT EXISTS idx_orders_bot ON orders(bot_id);
CREATE INDEX IF NOT EXISTS idx_positions_bot ON positions(bot_id);
CREATE INDEX IF NOT EXISTS idx_equity_bot ON equity(bot_id);
```

- [ ] **Step 4: recover test + module**

Create `packages/engine/tests/recover.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { openStore } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { recoverStaleBots } from "../src/recover.js";

describe("recoverStaleBots", () => {
  it("marks running bots stopped and finishes their open run", () => {
    const store = new Store(openStore(":memory:"));
    store.saveBot({ id: "a", name: "A", strategy: "grid", symbol: "BTC", params: "{}", status: "running", state: "{}", created_at: 1, updated_at: 1 });
    store.saveBot({ id: "b", name: "B", strategy: "grid", symbol: "BTC", params: "{}", status: "stopped", state: "{}", created_at: 2, updated_at: 2 });
    store.createBotRun({ id: "ra", bot_id: "a", mode: "paper", started_at: 3, stopped_at: null, stop_reason: null });
    store.createBotRun({ id: "rb", bot_id: "b", mode: "paper", started_at: 4, stopped_at: null, stop_reason: null });
    recoverStaleBots(store, { info: () => {}, error: () => {}, warn: () => {} });
    expect(store.getBot("a")?.status).toBe("stopped");
    expect(store.listRuns("a")[0]?.stopped_at).not.toBeNull();
    expect(store.listRuns("a")[0]?.stop_reason).toBe("crash_recovered");
    expect(store.getBot("b")?.status).toBe("stopped"); // unchanged
  });
});
```

Create `packages/engine/src/recover.ts`:
```ts
import type { Store } from "./store/store.js";
import type { LoggerLike } from "./framework/engine.js"; // reuse the LoggerLike shape

export function recoverStaleBots(store: Store, log: LoggerLike): void {
  for (const bot of store.listBots()) {
    if (bot.status !== "running") continue;
    const open = store.listRuns(bot.id).find((r) => r.stopped_at === null);
    if (open) store.finishRun(open.id, "crash_recovered");
    store.updateBot(bot.id, { status: "stopped" });
    log.warn({ botId: bot.id }, "recovered stale running bot after crash");
  }
}
```

- [ ] **Step 5: wire into `main.ts`**

After `const store = new Store(openStore(dbPath));` and before engine construction add:
```ts
import { recoverStaleBots } from "./recover.js";
...
recoverStaleBots(store, log);
```

- [ ] **Step 6: typecheck + run `@huper/engine` suite**

```bash
npm run typecheck
npm test -w @huper/engine
```
Both must pass with 0 errors and no regressions.

---

### Task 7: LiveExchange userFills + engine order-status correctness

**Files:**
- Edit: `packages/engine/src/exchange/live.ts` — `userFills` subscription in `connect()`, emit fills into `fillCbs`
- Edit: `packages/engine/src/framework/engine.ts` — `executeOrder` writes `filled` status for market fills at once; `routeFill` updates store order to `filled`
- Create: `packages/engine/tests/live-orders.test.ts` — mocked SDK
- Test: `packages/engine/tests/engine.test.ts` — extend resting-fill store status

**Important #2 fix (engine store order status):** `executeOrder` currently writes `status: placed.status`. For a resting limit, `placed.status === "open"` (correct). For a market Ioc fill, `placed.status === "filled"` (already correct). The gap is that when a **resting** order later fills (paper sweep → `routeFill`, or live `userFills`), the store row is never updated. So the fix is in `routeFill`.

- [ ] **Step 1: update `routeFill` to mark the store order filled**

In `engine.ts` `routeFill` (currently lines 184-191), when owning runners exist, update the store row **before** reconciling. Use the `Order` payload's `status`, `filledSize`, `avgFillPrice`:

```ts
private routeFill(order: Order): void {
  if (order.status === "filled") {
    this.store.updateOrder(order.id, { status: "filled", filled_size: order.filledSize, avg_price: order.avgFillPrice });
  }
  for (const runner of this.runners.values()) {
    if (!runner.hasOrder(order.id)) continue;
    void runner.onOrderFilled(order)
      .catch((e) => this.markError(runner.botId, e))
      .then(() => this.reconcilePositions(runner.botId, order.symbol).catch((e) => this.log.warn({ botId: runner.botId, symbol: order.symbol, err: (e as Error).message }, "position reconcile failed")));
  }
}
```

- [ ] **Step 2: write the mocked `live-orders.test.ts`**

The live exchange is never unit-tested against a real key. Mock the `@nktkas/hyperliquid` module. `LiveExchange` imports `ExchangeClient`, `InfoClient`, `SubscriptionClient`, `HttpTransport`, `WebSocketTransport`, `ISubscription` from that package. Provide fakes via `vi.mock`.

Fake `SubscriptionClient` must expose:
- `allMids(listener)` → returns `{ unsubscribe: vi.fn(async () => {}) }`, and capture the listener so a tick can be pushed. Mirror the real `placeOrder` path which reads `ticks` cache (set via pushing an allMids event).
- `userFills({ user }, listener)` → capture the `listener` (the fill callback). Return the same fake subscription so `disconnect()` unsubscribes cleanly.

Mock `ExchangeClient` `order({ orders })`:
- For a market (Ioc) order, return `{ response: { data: { statuses: [{ filled: { oid: 1, totalSz: "0.1", avgPx: "100" } }] } } }`.
- For a resting limit order, return `{ response: { data: { statuses: [{ resting: { oid: 2 } }] } } }`.

Mock `InfoClient.clearinghouseState` to return `{ marginSummary: { accountValue: "10000" }, assetPositions: [] }`.

Mock transports are not strictly needed if `LiveExchange` constructs clients from the mocked classes; keep them as `{ apiUrl }` / `{ url }` no-ops. Because the constructor uses `privateKeyToAccount` (viem), pass a real private key for a test account (any valid 32-byte hex), e.g. `"0x" + "11".repeat(32)`.

Tests:
1. **Market Ioc fill** → `placeOrder` returns `status: filled` with `filledSize 0.1` and `avgFillPrice 100`.
2. **`userFills` emits a fill for a pending order** → after placing a resting buy limit (returns `open`, `oid 2`), capture the `userFills` listener, invoke `listener({ fills: [{ oid: 2, coin: "BTC", px: "99", sz: "0.1", side: "B", time: Date.now() }] })`, and assert the captured `onFill` callback fired with an order whose `status === "filled"`, `filledSize === 0.1`.
3. **`userFills` updates `orders` pending map marking resting orders filled** and does NOT leave a stale open order in `ordersPending` (delete after full fill).

Implementation in `live.ts`: in `connect()`, after the `allMids` subscription, add:

```ts
const fsub = await this.subs.userFills({ user: this.wallet.address }, (fevent) => {
  for (const f of fevent.fills ?? []) {
    const pending = this.ordersPending.get(String(f.oid));
    if (!pending) continue; // market Ioc already resolved, or foreign order
    const filled: Order = { ...pending, status: OrderStatus.Filled, filledSize: parseFloat(f.sz), avgFillPrice: parseFloat(f.px), filledAt: f.time };
    this.ordersPending.delete(String(f.oid));
    for (const cb of this.fillCbs) cb(filled);
  }
});
this.activeSubs.add(fsub);
```

Note: `UserFillsEvent.fills` is a `UserFillsResponse` (array). Guard against `fills` being undefined. Import `OrderStatus` from `@huper/core` (already in the mapping module; live.ts imports only `Side`, `OrderType` — add `OrderStatus`).

Update `ordersPending` delete: full-fill assumption is fine per design (partial fills → next event sees fewer remaining; this phase accepts best-effort full-fill match).

- [ ] **Step 3: extend `engine.test.ts` — resting fill status now `filled`**

Add a test (reusing the `RouteFillStrategy` the DOGE delayed-sweep test) that after the delayed fill occurs, `store.listOrders(bot.id)` shows the resting order's `status === "filled"` and `filled_size === 0.1`. Place on the existing DOGE test or a new test on a fresh symbol.

- [ ] **Step 4: typecheck + suite**

```bash
npm run typecheck
npm test -w @huper/engine
```

---

### Task 8: Runner re-entrancy mutex + bot-scoped `positionsFor`

**Files:**
- Edit: `packages/engine/src/framework/engine.ts` — `positionsFor(botId, symbol)` reads store; update callers
- Edit: `packages/engine/src/framework/runner.ts` — skip-on-overlap mutex in `evaluate`; ctx `getPositions` passes `botId`
- Test: `packages/engine/tests/engine.test.ts`

**Important #4 (mutex):** add a `busy` flag. On entering `evaluate`, if `busy` is true → return immediately (skip this tick). Set `busy = true` before the `try`, clear in `finally`.

- [ ] **Step 1: `BotRunner.evaluate` mutex (runner.ts)**

```ts
private busy = false;

async evaluate(tick: PriceTick): Promise<void> {
  if (!this.active || this.busy) return; // skip-on-overlap
  this.busy = true;
  try {
    await this.strategy.onTick(tick, this.ctx);
  } finally {
    this.busy = false;
    this.engine.saveBotState(this.botId, this.state);
  }
}
```

- [ ] **Step 2: `positionsFor` bot-scoped (engine.ts)**

Change the method (currently `positionsFor(symbol: string)` at ~line 53) to read the store:

```ts
async positionsFor(botId: string, symbol: string): Promise<Position[]> {
  return this.store.listPositions(botId)
    .filter((p) => p.symbol === symbol && p.closed_at === null)
    .map((p) => ({ symbol: p.symbol, side: (p.side as Side), size: p.size, avgEntry: p.avg_entry, markPrice: p.mark_price ?? undefined }));
}
```

Import `Side` and `Position` types from `@huper/core` (engine.ts currently imports `OrderType`, `ExchangeAdapter`, `NewOrder`, `Order`, `PriceTick`, `Position`, `RecentOrder` — `Position` is already imported).

- [ ] **Step 3: update ctx wiring (runner.ts)**

In the `ctx` object (line ~34), change `getPositions: () => engine.positionsFor(symbol)` to `getPositions: () => engine.positionsFor(this.botId, symbol)`.

- [ ] **Step 4: update all other callers of `positionsFor`**

Search the repo for `positionsFor(`, ensure every call site passes `(botId, symbol)`. Only `runner.ts` uses it today.

- [ ] **Step 5: tests — engine.test.ts**

1. **Bot-scoped positions:** two bots on the same symbol; start one, let it buy (position exists in store for bot A). `await engine.positionsFor(botA.id, "ETH")` returns 1 open; `await engine.positionsFor(botB.id, "ETH")` returns `[]`. Place a position for bot A only (reuse the "Persist" pattern).
2. **Mutex overlap skip:** a strategy whose `onTick` awaits a promise; push two ticks quickly; assert the strategy's `onTick` calls don't overlap (i.e., `tick` count does not exceed the number of completed runs). A simple determinable assertion: use a counter incremented at onTick entry and decremented at exit, assert max concurrent === 1. This is timing-sensitive; use a generous await and a bounded assertion (`maxConcurrent` never exceeded, not exact skip count).

- [ ] **Step 6: typecheck + suite**

```bash
npm run typecheck
npm test -w @huper/engine
```

---

### Task 9: EmergencyStop re-scan + RiskManager reduce-only exemption

**Files:**
- Edit: `packages/engine/src/emergency.ts` — re-scan after `stopAll`
- Edit: `packages/engine/src/risk/risk.ts` — skip position caps for `reduceOnly`
- Test: `packages/engine/tests/emergency.test.ts` (modify) + `packages/engine/tests/risk.test.ts` (extend)

**Minor (EmergencyStop race):** Currently `run()` reads positions *before* calling `stopAll`, then closes that (possibly stale) snapshot. Since `stopAll` orders `cancelAllOrders` which can only *reduce* positions, the stale snapshot risks closing the wrong size. Re-read after stop.

**Minor (reduce-only caps):** `validate()` skips only the drift guardrail for reduce-only. Position caps (`perBotMaxPositionPct`, `globalMaxPositionPct`) still bound a reduce-only market close — a closing order whose notional would push caps is wrongly rejected. Fix: for `reduceOnly === true`, skip the two position-cap checks but keep **min/max order size, order-notional cap, duplicate guard**.

- [ ] **Step 1: rewrite `emergency.ts` `run()`**

```ts
async run(): Promise<{ stoppedBots: number; closedPositions: number }> {
  const stoppedBots = await this.engine.stopAll("emergency");
  const positions = await this.exchange.openPositions(); // re-read AFTER stop
  let closed = 0;
  for (const p of positions) {
    try {
      await this.exchange.placeOrder({
        symbol: p.symbol, side: p.side === Side.Buy ? Side.Sell : Side.Buy,
        type: OrderType.Market, price: null, size: p.size, reduceOnly: true,
      });
      closed++;
    } catch (err) {
      this.engine.logHandle().error({ symbol: p.symbol, err: String(err) }, "emergency close failed");
    }
  }
  await this.engine.reconcileAllPositions();
  return { stoppedBots, closedPositions: closed };
}
```

- [ ] **Step 2: `risk.ts` reduce-only exemption**

In `validate`, guard the two position-cap checks so they are skipped when `attempt.reduceOnly` is truthy (keep the order-notional cap and size/duplicate checks unconditionally):

```ts
if (notional > s.balance * this.cfg.maxOrderNotionalPct) return { ok: false, reason: "exceeds order notional cap" };
if (!a.reduceOnly) {
  if (s.botPositionNotional + notional > s.balance * this.cfg.perBotMaxPositionPct) return { ok: false, reason: "exceeds per-bot position cap" };
  if (s.globalPositionNotional + notional > s.balance * this.cfg.globalMaxPositionPct) return { ok: false, reason: "exceeds global position cap" };
}
```

- [ ] **Step 3: test emergency re-scan (emergency.test.ts)**

Keep the existing test (already asserts re-read behavior once `run` re-reads). Strengthen: seed two positions (e.g., buy 0.1 in bot A, sell 0.05 in bot B) and assert every open exchange position is closed after `run`.

- [ ] **Step 4: extend risk.test.ts — reduce-only exempt while non-reduce is not**

```ts
it("allows reduce-only market close past position caps", () => {
  const r = new RiskManager(base).validate({ ...attempt, kind: "market", price: null, reduceOnly: true, size: 5 }, snap({ botPositionNotional: 4000, globalPositionNotional: 4000 }));
  expect(r).toEqual({ ok: true });
});

it("still applies order-notional cap to reduce-only", () => {
  const r = new RiskManager(base).validate({ ...attempt, kind: "market", price: null, reduceOnly: true, size: 1000 }, snap({ balance: 1000 }));
  expect(r).toEqual({ ok: false, reason: "exceeds order notional cap" });
});
```

`base.maxOrderNotionalPct` is 0.05 → balance 1000 allows up to 50 notional; size 1000 @ 100 = 100000 → rejects.

- [ ] **Step 5: typecheck + suite**

```bash
npm run typecheck
npm test -w @huper/engine
```

---

### Task 10: refreshMeta debounce (combines design SFD item 5)

**Files:**
- Edit: `packages/engine/src/framework/engine.ts` — throttle `refreshMeta`
- Test: `packages/engine/tests/engine.test.ts`

**Minor #5:** `refreshMeta` calls `exchange.balances()` on **every** tick (per `dispatch`), so N ticks = N REST round-trips. Add a `lastBalanceRefresh` timestamp; refresh only when `now - last > 1000ms`.

- [ ] **Step 1: add debounce field + gate**

`engine.ts` add `private lastBalanceRefresh = 0;` and in `refreshMeta`:

```ts
private async refreshMeta(symbol: string): Promise<void> {
  const now = Date.now();
  if (now - this.lastBalanceRefresh < 1000) return; // throttled per unique
  this.lastBalanceRefresh = now;
  try {
    const b = await this.exchange.balances();
    if (b.length > 0) this.bal = b[0].total;
  } catch (e) { this.log.warn({ symbol, err: (e as Error).message }, "balances refresh failed"); }
}
```

- [ ] **Step 2: test the throttle (engine.test.ts)**

Using the shared `engine`/`exchange`, record the number of `balances()` calls via a spy on `exchange` (wrap the paper exchange's `balances` with a counter before `engine.start()` — but the shared engine is shared across the file; instead spin a fresh engine in this one test to avoid cross-contamination). Demonstrate that 3 rapid ticks within <1000ms call `balances()` only once, and after a `>1000ms` gap it refreshes again.

Simplest: create a local `PaperExchange`, a counting wrapper that increments a counter, a fresh `Engine`, register a no-op strategy, `await engine.start()`, then `engine` tick the same symbol 3x synchronously and assert `count === 1` (within ms), then `await new Promise(r=>setTimeout(r,1100))`, tick once, assert `count === 2`.

- [ ] **Step 3: typecheck + suite**

```bash
npm run typecheck
npm test -w @huper/engine
```

---

### Finalization

- [ ] **Run full verification**
```bash
npm run typecheck       # 0 errors
npm test                # all pass (core + engine)
git status --short       # clean except intended files
```

- [ ] **Update SDD progress log** (`.superpowers/sdd/2026-08-06-huper-phase2b/progress.md`) with per-task brief/review/fix records, mirroring the Phase 2a ledger format.
- [ ] **Render the design doc** — confirm every SFD design item (§3.1–3.8, §5) is reflected in code + tests.

## Task Order Rationale

1. **Task 6 (store)** first — low-level, unblocked, independent.
2. **Task 7 (live correctness)** — builds on store; the trickiest (SDK mocking).
3. **Task 8 (isolation + mutex)** — engine-level, needs `positionsFor` working before bot-scoped tests.
4. **Task 9 (emergency + reduce-only)** — independent of 7/8.
5. **Task 10 (debounce)** — leaf, trivial.

Each task is independently testable and reviewable. Run `npm test -w @huper/engine` + `npm run typecheck` after each task and before moving to the next.