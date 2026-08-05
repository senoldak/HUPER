import { describe, it, expect } from "vitest";
import { midToTick, bookToTick, resultToOrder } from "../src/exchange/hyperliquid-mapping.js";
import { Side, OrderStatus } from "@huper/core";

describe("hyperliquid mapping", () => {
  it("midToTick maps string mid to bid/ask/mid", () => {
    const t = midToTick("ETH", "3000.5", 123);
    expect(t.mid).toBe(3000.5);
    expect(t.bid).toBe(3000.5);
    expect(t.ask).toBe(3000.5);
  });

  it("bookToTick computes spread from top levels", () => {
    const t = bookToTick(
      "ETH",
      { bids: [["2999", "1"]], asks: [["3001", "1"]] },
      1,
    );
    expect(t.bid).toBe(2999);
    expect(t.ask).toBe(3001);
    expect(t.mid).toBe(3000);
  });

  it("resultToOrder maps a filled result", () => {
    const o = resultToOrder(
      { symbol: "ETH", side: Side.Sell, price: 3000, size: 1 },
      "filled",
      42,
      "1",
      "3000",
    );
    expect(o.status).toBe(OrderStatus.Filled);
    expect(o.filledSize).toBe(1);
    expect(o.id).toBe("42");
  });

  it("resultToOrder maps a resting result to open", () => {
    const o = resultToOrder(
      { symbol: "ETH", side: Side.Buy, price: 2900, size: 1 },
      "resting",
      7,
    );
    expect(o.status).toBe(OrderStatus.Open);
    expect(o.filledSize).toBe(0);
    expect(o.avgFillPrice).toBeNull();
  });
});
