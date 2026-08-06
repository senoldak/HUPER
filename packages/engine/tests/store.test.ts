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

  it("deletes a bot and cascades its child rows", () => {
    store.createBotRun({ id: "r_c", bot_id: "b1", mode: "paper", started_at: 5, stopped_at: null, stop_reason: null });
    store.createOrder({ id: "o_c", bot_id: "b1", exchange_id: null, symbol: "BTC", side: "buy", price: 100, size: 0.1, status: "open", filled_size: 0, avg_price: null, created_at: 6, updated_at: 6 });
    store.createPosition({ id: "p_c", bot_id: "b1", symbol: "BTC", side: "buy", size: 0.1, avg_entry: 100, mark_price: null, realized_pnl: 0, opened_at: 7, closed_at: null });
    store.appendEquity({ id: "e_c", botId: "b1", ts: 8, value: 1000 });

    store.deleteBot("b1");
    expect(store.getBot("b1")).toBeUndefined();
    expect(store.listRuns("b1")).toHaveLength(0);
    expect(store.listOrders("b1")).toHaveLength(0);
    expect(store.listPositions("b1")).toHaveLength(0);
    expect((db.prepare(`SELECT COUNT(*) c FROM equity`).get() as { c: number }).c).toBe(0);
  });
});