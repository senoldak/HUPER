import {
  Side,
  OrderType,
  OrderStatus,
  type NewOrder,
  type Order,
  type PriceTick,
} from "@huper/core";

export function midToTick(symbol: string, mid: string, timestamp: number): PriceTick {
  const m = parseFloat(mid);
  return { symbol, bid: m, ask: m, mid: m, timestamp };
}

export interface BookLevels {
  bids: [string, string][];
  asks: [string, string][];
}

export function bookToTick(symbol: string, levels: BookLevels, timestamp: number): PriceTick {
  const bid = parseFloat(levels.bids[0]?.[0] ?? "0");
  const ask = parseFloat(levels.asks[0]?.[0] ?? "0");
  return { symbol, bid, ask, mid: (bid + ask) / 2, timestamp };
}

export function resultToOrder(
  n: NewOrder,
  status: string,
  oid: string | number,
  totFilled?: string,
  avgPx?: string,
): Order {
  const filled = status === "filled";
  return {
    id: String(oid),
    symbol: n.symbol,
    side: n.side,
    type: n.type ?? OrderType.Limit,
    price: n.price,
    size: n.size,
    status: filled ? OrderStatus.Filled : OrderStatus.Open,
    filledSize: totFilled ? parseFloat(totFilled) : 0,
    avgFillPrice: avgPx ? parseFloat(avgPx) : null,
    createdAt: Date.now(),
  };
}
