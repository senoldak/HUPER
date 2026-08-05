import { SubscriptionClient, WebSocketTransport } from "@nktkas/hyperliquid";
import { midToTick } from "../exchange/hyperliquid-mapping.js";
import type { PriceTick } from "@huper/core";

export class MarketDataFeed {
  private subs: SubscriptionClient | undefined;
  private sub: { unsubscribe(): Promise<void> } | undefined;
  private cbs = new Set<(t: PriceTick) => void>();

  constructor(private wsUrl: string) {}

  async connect(): Promise<void> {
    this.subs = new SubscriptionClient({ transport: new WebSocketTransport({ url: this.wsUrl }) });
    this.sub = await this.subs.allMids((data) => {
      const now = Date.now();
      for (const [coin, mid] of Object.entries(data.mids)) {
        const t = midToTick(coin, mid, now);
        for (const cb of this.cbs) cb(t);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.sub) await this.sub.unsubscribe();
    this.sub = undefined;
  }

  onTick(cb: (t: PriceTick) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
}