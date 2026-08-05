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
