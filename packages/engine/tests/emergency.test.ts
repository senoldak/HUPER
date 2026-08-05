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
    await new Promise((r) => setTimeout(r, 100));
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 1 });
    await new Promise((r) => setTimeout(r, 100));

    expect((await exchange.openPositions()).length).toBeGreaterThan(0);

    const result = await new EmergencyStop(engine, exchange).run();
    expect(result.closedPositions).toBeGreaterThan(0);
    expect((await exchange.openPositions())).toHaveLength(0);
    expect(store.getBot(bot.id)?.status).toBe("stopped");
  });
});