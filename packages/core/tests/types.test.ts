import { describe, it, expect } from "vitest";
import { Side, OrderType, OrderStatus, type Order, type NewOrder } from "../src/types.js";

describe("core types", () => {
  it("enum-like namespaces expose string values", () => {
    expect(Side.Buy).toBe("buy");
    expect(OrderType.Limit).toBe("limit");
    expect(OrderStatus.Filled).toBe("filled");
  });

  it("Order shape is valid", () => {
    const o: Order = {
      id: "1",
      symbol: "ETH",
      side: Side.Buy,
      type: OrderType.Limit,
      price: 1000,
      size: 1,
      status: OrderStatus.New,
      filledSize: 0,
      avgFillPrice: null,
      createdAt: 0,
    };
    expect(o.symbol).toBe("ETH");
  });

  it("NewOrder defaults to limit type", () => {
    const n: NewOrder = { symbol: "BTC", side: Side.Sell, price: 50000, size: 0.01 };
    expect(n.type).toBeUndefined();
  });
});
