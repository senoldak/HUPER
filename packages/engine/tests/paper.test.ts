import { describe, it, expect } from "vitest";
import { PaperExchange } from "../src/exchange/paper.js";
import { Side, OrderStatus } from "@huper/core";

describe("PaperExchange", () => {
  it("market buy fills immediately at ask price", async () => {
    const ex = new PaperExchange({ initialBalance: 10000 });
    ex.pushTick({ symbol: "ETH", bid: 999, ask: 1001, mid: 1000, timestamp: 1 });

    const o = await ex.placeOrder({ symbol: "ETH", side: Side.Buy, price: null, size: 1 });
    expect(o.status).toBe(OrderStatus.Filled);
    expect(o.avgFillPrice).toBe(1001);
    expect(o.filledSize).toBe(1);
  });

  it("limit buy stays open until tick crosses", async () => {
    const ex = new PaperExchange({ initialBalance: 10000 });
    ex.pushTick({ symbol: "ETH", bid: 1100, ask: 1102, mid: 1101, timestamp: 1 });
    const o = await ex.placeOrder({ symbol: "ETH", side: Side.Buy, price: 1000, size: 1 });
    expect(o.status).toBe(OrderStatus.Open);

    ex.pushTick({ symbol: "ETH", bid: 995, ask: 999, mid: 997, timestamp: 2 });
    const updated = ex.orderById(o.id)!;
    expect(updated.status).toBe(OrderStatus.Filled);
    expect(updated.avgFillPrice).toBe(1000);
  });

  it("buy reduces available cash, total includes mark value", async () => {
    const ex = new PaperExchange({ initialBalance: 1000 });
    ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });
    await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 1 });

    const bal = (await ex.balances())[0];
    expect(bal.available).toBeCloseTo(1000 - 101, 6); // 899
    expect(bal.total).toBeCloseTo(1000 - 101 + 100, 6); // 999, mark = bid
  });

  it("sells reduce position and restore cash", async () => {
    const ex = new PaperExchange({ initialBalance: 1000 });
    ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });
    await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 1 }); // cash 899
    ex.pushTick({ symbol: "BTC", bid: 110, ask: 112, mid: 111, timestamp: 2 });
    await ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 1 }); // +110 (bid)

    const bal = (await ex.balances())[0];
    expect(bal.available).toBeCloseTo(899 + 110, 6);
    expect((await ex.openPositions())).toHaveLength(0);
  });

  it("short equity rises when price falls", async () => {
    const ex = new PaperExchange({ initialBalance: 1000 });
    ex.pushTick({ symbol: "BTC", bid: 110, ask: 112, mid: 111, timestamp: 1 });
    await ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 1 }); // opens short at bid 110
    ex.pushTick({ symbol: "BTC", bid: 100, ask: 102, mid: 101, timestamp: 2 });   // price falls

    const bal = (await ex.balances())[0];
    expect(bal.available).toBeCloseTo(1000 + 110, 6);        // cash holds sale proceeds
    expect(bal.total).toBeCloseTo(1000 + (110 - 100), 6);    // equity = cash - size*mark = 1110 - 100
    const pos = (await ex.openPositions())[0];
    expect(pos.side).toBe(Side.Sell);
    expect(pos.avgEntry).toBe(110);
  });
});
