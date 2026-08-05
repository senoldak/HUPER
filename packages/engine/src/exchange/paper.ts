import {
  Side,
  OrderType,
  OrderStatus,
  type ExchangeAdapter,
  type NewOrder,
  type Order,
  type PriceTick,
  type OrderBook,
  type Position,
  type Wallet,
} from "@huper/core";

let seq = 0;
const now = () => Date.now();

export interface PaperOptions {
  initialBalance: number;
}

interface PaperPosition {
  side: Side;
  size: number;
  avgEntry: number;
}

export class PaperExchange implements ExchangeAdapter {
  readonly mode = "paper" as const;

  private cash: number;
  private positions = new Map<string, PaperPosition>();
  private orders = new Map<string, Order>();
  private ticks = new Map<string, PriceTick>();
  private tickCbs = new Set<(t: PriceTick) => void>();
  private fillCbs = new Set<(o: Order) => void>();

  constructor(opts: PaperOptions) {
    this.cash = opts.initialBalance;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async tick(symbol: string): Promise<PriceTick | undefined> {
    return this.ticks.get(symbol);
  }

  async orderbook(symbol: string): Promise<OrderBook | undefined> {
    const t = this.ticks.get(symbol);
    return t
      ? { symbol, bids: [[t.bid, 0]], asks: [[t.ask, 0]], timestamp: t.timestamp }
      : undefined;
  }

  async balances(): Promise<Wallet[]> {
    let equity = this.cash;
    for (const [symbol, p] of this.positions) {
      const t = this.ticks.get(symbol);
      const mark = t ? (p.side === Side.Buy ? t.bid : t.ask) : p.avgEntry;
      equity += p.size * mark;
    }
    return [{ asset: "USDC", available: this.cash, total: equity }];
  }

  async openPositions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const [symbol, p] of this.positions) {
      const t = this.ticks.get(symbol);
      out.push({
        symbol,
        side: p.side,
        size: p.size,
        avgEntry: p.avgEntry,
        markPrice: t ? (p.side === Side.Buy ? t.bid : t.ask) : p.avgEntry,
      });
    }
    return out;
  }

  onTick(cb: (t: PriceTick) => void): () => void {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }

  onFill(cb: (o: Order) => void): () => void {
    this.fillCbs.add(cb);
    return () => this.fillCbs.delete(cb);
  }

  pushTick(tick: PriceTick): void {
    this.ticks.set(tick.symbol, tick);
    this.sweep(tick.symbol);
    for (const cb of this.tickCbs) cb(tick);
  }

  orderById(id: string): Order | undefined {
    return this.orders.get(id);
  }

  async placeOrder(n: NewOrder): Promise<Order> {
    const id = `pp-${++seq}`;
    const type = n.type ?? OrderType.Limit;
    const fillPrice = this.fillPriceFor(n, type);

    let order: Order;
    if (fillPrice !== null) {
      order = this.buildOrder(n, id, OrderStatus.Filled, fillPrice, Math.abs(n.size));
      this.applyFill(n, fillPrice, Math.abs(n.size));
      for (const cb of this.fillCbs) cb(order);
    } else {
      order = this.buildOrder(n, id, OrderStatus.Open, null, 0);
    }
    this.orders.set(id, order);
    return order;
  }

  async cancelOrder(id: string): Promise<boolean> {
    const o = this.orders.get(id);
    if (!o || o.status !== OrderStatus.Open) return false;
    this.orders.set(id, { ...o, status: OrderStatus.Cancelled });
    return true;
  }

  private fillPriceFor(n: NewOrder, type: OrderType): number | null {
    const t = this.ticks.get(n.symbol);
    if (!t) return null;
    if (type === OrderType.Market || n.price === null) {
      return n.side === Side.Buy ? t.ask : t.bid;
    }
    return n.side === Side.Buy ? (t.ask <= n.price ? n.price : null)
                               : (t.bid >= n.price ? n.price : null);
  }

  private buildOrder(n: NewOrder, id: string, status: OrderStatus, avgFillPrice: number | null, filledSize: number): Order {
    return {
      id,
      symbol: n.symbol,
      side: n.side,
      type: n.type ?? OrderType.Limit,
      price: n.price,
      size: n.size,
      status,
      filledSize,
      avgFillPrice,
      createdAt: now(),
      filledAt: status === OrderStatus.Filled ? now() : undefined,
    };
  }

  private sweep(symbol: string): void {
    const t = this.ticks.get(symbol);
    if (!t) return;
    for (const [id, o] of this.orders) {
      if (o.status !== OrderStatus.Open || o.symbol !== symbol || o.price === null) continue;
      const px = o.side === Side.Buy ? t.ask : t.bid;
      const crossed = o.side === Side.Buy ? px <= o.price : px >= o.price;
      if (!crossed) continue;
      const filled: Order = { ...o, status: OrderStatus.Filled, avgFillPrice: o.price, filledSize: o.size, filledAt: now() };
      this.orders.set(id, filled);
      this.applyFill(o, o.price, Math.abs(o.size));
      for (const cb of this.fillCbs) cb(filled);
    }
  }

  private applyFill(n: NewOrder, px: number, size: number): void {
    if (n.side === Side.Buy) {
      this.cash -= px * size;
      this.addPosition(n.symbol, size, px);
    } else {
      this.cash += px * size;
      this.reducePosition(n.symbol, size);
    }
  }

  private addPosition(symbol: string, size: number, px: number): void {
    const cur = this.positions.get(symbol);
    if (!cur || cur.size === 0 || cur.side === Side.Buy) {
      const total = (cur?.size ?? 0) + size;
      const avg = cur && cur.size > 0 ? (cur.avgEntry * cur.size + px * size) / total : px;
      this.positions.set(symbol, { side: Side.Buy, size: total, avgEntry: avg });
      return;
    }
    const remaining = cur.size - size;
    if (remaining > 0) {
      this.positions.set(symbol, { side: Side.Sell, size: remaining, avgEntry: cur.avgEntry });
    } else if (remaining === 0) {
      this.positions.delete(symbol);
    } else {
      this.positions.set(symbol, { side: Side.Buy, size: Math.abs(remaining), avgEntry: px });
    }
  }

  private reducePosition(symbol: string, size: number): void {
    const cur = this.positions.get(symbol);
    if (!cur || cur.size === 0) {
      this.positions.set(symbol, { side: Side.Sell, size, avgEntry: 0 });
      return;
    }
    if (cur.side === Side.Sell) {
      this.positions.set(symbol, { side: Side.Sell, size: cur.size + size, avgEntry: cur.avgEntry });
      return;
    }
    const remaining = cur.size - size;
    if (remaining > 0) {
      this.positions.set(symbol, { side: Side.Buy, size: remaining, avgEntry: cur.avgEntry });
    } else if (remaining === 0) {
      this.positions.delete(symbol);
    } else {
      this.positions.set(symbol, { side: Side.Sell, size: Math.abs(remaining), avgEntry: 0 });
    }
  }
}