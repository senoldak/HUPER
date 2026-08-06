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

class SlowStrategy implements Strategy {
  readonly name = "slow";
  readonly paramsSchema = z.object({});
  readonly cadenceMs = 0;
  concurrent = 0;
  maxConcurrent = 0;
  onStart() { return Promise.resolve(); }
  async onTick() {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await new Promise((r) => setTimeout(r, 80));
    this.concurrent--;
  }
  onOrderFilled() { return Promise.resolve(); }
  onStop() { return Promise.resolve(); }
}

class RouteFillStrategy implements Strategy {
  readonly name = "route-fill";
  readonly paramsSchema = z.object({});
  readonly cadenceMs = 0;
  async onStart(ctx: StrategyCtx) {
    // Resting buy limit at 99: current ask is 100 so it does NOT cross at placement
    // (and nothing fills, so executeOrder's own reconcile creates no store row).
    // It can only fill later when a pushed tick drops the ask to <= 99, at which point
    // PaperExchange.sweep → routeFill is the ONLY path that can create the row.
    await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: "limit", price: 99, size: 0.1 });
  }
  onTick() { return Promise.resolve(); }
  onOrderFilled() { return Promise.resolve(); }
  onStop() { return Promise.resolve(); }
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
    await new Promise((r) => setTimeout(r, 20));
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 101, timestamp: 2 });
    await new Promise((r) => setTimeout(r, 20));

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

  it("persists a position from the strategy order flow", async () => {
    const bot = await engine.createBot({ name: "Persist", strategy: "fake", symbol: "ETH", params: { threshold: 99 } });
    await engine.startBot(bot.id);
    exchange.pushTick({ symbol: "ETH", bid: 100, ask: 100, mid: 101, timestamp: 3 });
    await new Promise((r) => setTimeout(r, 10));

    const open = store.listPositions(bot.id).find((p) => p.closed_at === null);
    expect(open).toBeDefined();
    expect(open?.side).toBe("buy");
    expect(open?.size).toBe(0.1);
    const detail = await engine.getBotDetail(bot.id);
    expect(detail?.positions.length ?? 0).toBeGreaterThan(0);

    await engine.stopBot(bot.id, "stopped");
  });

  it("binds per-bot position caps from persisted positions", async () => {
    const bot = await engine.createBot({ name: "Caps", strategy: "fake", symbol: "SOL", params: { threshold: 99 } });
    await engine.startBot(bot.id);
    exchange.pushTick({ symbol: "SOL", bid: 100, ask: 100, mid: 100, timestamp: 4 });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.listPositions(bot.id).some((p) => p.closed_at === null && p.side === "buy" && p.size === 0.1)).toBe(true);

    for (let i = 0; i < 10; i++) {
      await engine.executeOrder(bot.id, "SOL", { symbol: "SOL", side: "buy", price: null, size: 1.1 + i * 0.1, type: "market" });
    }
    await expect(engine.executeOrder(bot.id, "SOL", { symbol: "SOL", side: "buy", price: null, size: 5, type: "market" }))
      .rejects.toThrow("exceeds per-bot position cap");

    await engine.stopBot(bot.id, "stopped");
  });

  it("reconciles a resting limit filled by a later price move into the store via routeFill", async () => {
    await started;
    registry.register(new RouteFillStrategy());
    // Fresh symbol, no pre-existing exchange position. onStart places a resting buy limit
    // (99) that does NOT cross the first tick's ask (100), so nothing fills at placement and
    // executeOrder:151's reconcile creates nothing. Only the SECOND tick (ask 98.5 <= 99)
    // crosses it, filling via PaperExchange.sweep and reaching routeFill — the only path
    // that can create the store row. Guarantees the delayed-sweep fill is reconciled.
    exchange.pushTick({ symbol: "DOGE", bid: 100, ask: 100, mid: 100, timestamp: 5 });
    const bot = await engine.createBot({ name: "RouteFillAsync", strategy: "route-fill", symbol: "DOGE", params: {} });
    await engine.startBot(bot.id);

    expect(store.listPositions(bot.id).some((p) => p.closed_at === null)).toBe(false);

    exchange.pushTick({ symbol: "DOGE", bid: 98, ask: 98.5, mid: 98.25, timestamp: 6 });
    await new Promise((r) => setTimeout(r, 20));

    const open = store.listPositions(bot.id).find((p) => p.closed_at === null);
    expect(open).toBeDefined();
    expect(open?.side).toBe("buy");
    expect(open?.size).toBe(0.1);

    const resting = store.listOrders(bot.id).find((o) => o.side === "buy");
    expect(resting).toBeDefined();
    expect(resting?.status).toBe("filled");
    expect(resting?.filled_size).toBe(0.1);

    await engine.stopBot(bot.id, "stopped");
  });

  it("does not attribute a phantom position to a bot that never traded on its symbol", async () => {
    const active = await engine.createBot({ name: "PhantomActive", strategy: "fake", symbol: "BTC", params: { threshold: 99 } });
    const inactive = await engine.createBot({ name: "PhantomInactive", strategy: "fake", symbol: "BTC", params: { threshold: 99 } });
    await engine.startBot(active.id);

    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 7 });
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 101, timestamp: 8 });
    await new Promise((r) => setTimeout(r, 10));

    expect(store.listOrders(inactive.id)).toEqual([]);
    expect(store.listPositions(active.id).some((p) => p.closed_at === null)).toBe(true);

    await engine.reconcileAllPositions();

    expect(store.listPositions(inactive.id)).toEqual([]);

    await engine.stopBot(active.id, "stopped");
  });

  it("scopes positionsFor to the requesting bot on a shared symbol", async () => {
    const botA = await engine.createBot({ name: "ScopedA", strategy: "fake", symbol: "XRP", params: { threshold: 99 } });
    const botB = await engine.createBot({ name: "ScopedB", strategy: "fake", symbol: "XRP", params: { threshold: 99 } });
    await engine.startBot(botA.id);

    exchange.pushTick({ symbol: "XRP", bid: 100, ask: 100, mid: 101, timestamp: 13 });
    await new Promise((r) => setTimeout(r, 10));

    expect(await engine.positionsFor(botA.id, "XRP")).toHaveLength(1);
    expect(await engine.positionsFor(botB.id, "XRP")).toEqual([]);

    await engine.stopBot(botA.id, "stopped");
  });

  it("skips overlapping evaluate calls via the busy mutex", async () => {
    const slow = new SlowStrategy();
    registry.register(slow);
    const bot = await engine.createBot({ name: "Slow", strategy: "slow", symbol: "ADA", params: {} });
    await engine.startBot(bot.id);

    exchange.pushTick({ symbol: "ADA", bid: 100, ask: 100, mid: 100, timestamp: 14 });
    exchange.pushTick({ symbol: "ADA", bid: 100, ask: 100, mid: 100, timestamp: 15 });
    await new Promise((r) => setTimeout(r, 250));

    expect(slow.maxConcurrent).toBeLessThanOrEqual(1);

    await engine.stopBot(bot.id, "stopped");
  });
});
