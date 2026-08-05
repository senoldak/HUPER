import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import {
  Side,
  OrderType,
  type ExchangeAdapter,
  type NewOrder,
  type Order,
  type PriceTick,
  type OrderBook,
  type Position,
  type Wallet,
} from "@huper/core";
import { midToTick, bookToTick, resultToOrder } from "./hyperliquid-mapping.js";
import type { ISubscription } from "@nktkas/hyperliquid";

export interface LiveOptions {
  privateKey: string;
  rpcUrl: string;
  wsUrl: string;
}

/** Market data read from clearinghouseState also exposes markPx at runtime,
 * but the SDK 0.33.3 position type omits it; declare the subset we rely on. */
interface SdkPosition {
  coin: string;
  szi: string;
  entryPx: string;
  markPx?: string;
}

export class LiveExchange implements ExchangeAdapter {
  readonly mode = "live" as const;

  private exchange!: ExchangeClient;
  private info!: InfoClient;
  private subs!: SubscriptionClient;
  private wallet: ReturnType<typeof privateKeyToAccount>;
  private ticks = new Map<string, PriceTick>();
  private tickCbs = new Set<(t: PriceTick) => void>();
  private fillCbs = new Set<(o: Order) => void>();
  private books = new Map<string, OrderBook>();
  private ordersPending = new Map<string, Order>();
  private activeSubs = new Set<ISubscription>();

  constructor(private opts: LiveOptions) {
    this.wallet = privateKeyToAccount(opts.privateKey as `0x${string}`);
  }

  async connect(): Promise<void> {
    this.exchange = new ExchangeClient({
      transport: new HttpTransport({ apiUrl: this.opts.rpcUrl }),
      wallet: this.wallet,
    });
    this.info = new InfoClient({
      transport: new HttpTransport({ apiUrl: this.opts.rpcUrl }),
    });
    this.subs = new SubscriptionClient({
      transport: new WebSocketTransport({ url: this.opts.wsUrl }),
    });

    const sub = await this.subs.allMids((data) => {
      for (const [coin, mid] of Object.entries(data.mids)) {
        this.pushTick(midToTick(coin, mid, Date.now()));
      }
    });
    this.activeSubs.add(sub);
  }

  async disconnect(): Promise<void> {
    const subs = [...this.activeSubs];
    this.activeSubs.clear();
    await Promise.all(subs.map((s) => s.unsubscribe()));
  }

  async tick(symbol: string): Promise<PriceTick | undefined> {
    return this.ticks.get(symbol);
  }

  async orderbook(symbol: string): Promise<OrderBook | undefined> {
    return this.books.get(symbol);
  }

  async balances(): Promise<Wallet[]> {
    const state = await this.info.clearinghouseState({ user: this.wallet.address });
    const value = Number(state.marginSummary.accountValue);
    return [{ asset: "USDC", available: value, total: value }];
  }

  async openPositions(): Promise<Position[]> {
    const state = await this.info.clearinghouseState({ user: this.wallet.address });
    return state.assetPositions.map((ap) => {
      const p = ap.position as SdkPosition;
      const size = Number(p.szi);
      return {
        symbol: p.coin,
        side: size >= 0 ? Side.Buy : Side.Sell,
        size: Math.abs(size),
        avgEntry: Number(p.entryPx),
        markPrice: p.markPx ? Number(p.markPx) : undefined,
      };
    });
  }

  async placeOrder(n: NewOrder): Promise<Order> {
    const refPrice = this.ticks.get(n.symbol)?.mid;
    if (n.type === OrderType.Market) {
      if (refPrice == null) throw new Error("live market order requires a cached tick price");
      const order = {
        a: 0, // NOTE: asset index 0 = BTC placeholder; Phase 2 maps symbol→index via exchange meta
        b: n.side === Side.Buy, p: refPrice.toFixed(6),
        s: String(n.size), r: !!n.reduceOnly, t: { limit: { tif: "Ioc" as const } },
      };
      return this.sendAndMap(n, order);
    }
    const order = {
      a: 0, b: n.side === Side.Buy, p: (n.price ?? refPrice ?? 0).toFixed(6),
      s: String(n.size), r: !!n.reduceOnly, t: { limit: { tif: "Gtc" as const } },
    };
    return this.sendAndMap(n, order);
  }

  private async sendAndMap(
    n: NewOrder,
    order: {
      a: number;
      b: boolean;
      p: string;
      s: string;
      r: boolean;
      t: { limit: { tif: "Gtc" | "Ioc" } };
    },
  ): Promise<Order> {
    const res = await this.exchange.order({ orders: [order], grouping: "na" });
    const status = res.response.data.statuses?.[0] as
      | { resting: { oid: number } }
      | { filled: { oid: number; totalSz: string; avgPx: string } }
      | { error: string }
      | undefined;

    if (!status) throw new Error("hyperliquid: empty order statuses");
    if ("error" in status) throw new Error(`hyperliquid order error: ${status.error}`);

    if ("resting" in status) {
      const o = resultToOrder(n, "resting", status.resting.oid);
      this.ordersPending.set(o.id, o);
      return o;
    }
    const f = status.filled;
    return resultToOrder(n, "filled", f.oid, f.totalSz, f.avgPx);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.ordersPending.has(orderId)) return false;
    await this.exchange.cancel({ cancels: [{ a: 0, o: Number(orderId) }] });
    this.ordersPending.delete(orderId);
    return true;
  }

  onTick(cb: (t: PriceTick) => void): () => void {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }

  onFill(cb: (o: Order) => void): () => void {
    this.fillCbs.add(cb);
    return () => this.fillCbs.delete(cb);
  }

  async subscribeBook(symbol: string): Promise<void> {
    const sub = await this.subs.l2Book({ coin: symbol }, (data) => {
      const bids = data.levels[0].map((l) => [l.px, l.sz] as [string, string]);
      const asks = data.levels[1].map((l) => [l.px, l.sz] as [string, string]);
      const t = bookToTick(symbol, { bids, asks }, Date.now());
      this.books.set(symbol, {
        symbol,
        bids: t.bid ? [[t.bid, 0]] : [],
        asks: t.ask ? [[t.ask, 0]] : [],
        timestamp: t.timestamp,
      });
      this.pushTick(t);
    });
    this.activeSubs.add(sub);
  }

  private pushTick(t: PriceTick): void {
    this.ticks.set(t.symbol, t);
    for (const cb of this.tickCbs) cb(t);
  }
}