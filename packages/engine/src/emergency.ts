import type { ExchangeAdapter } from "@huper/core";
import { OrderType, Side } from "@huper/core";
import type { Engine } from "./framework/engine.js";

export class EmergencyStop {
  constructor(private engine: Engine, private exchange: ExchangeAdapter) {}

  async run(): Promise<{ stoppedBots: number; closedPositions: number }> {
    const positions = await this.exchange.openPositions();
    const stoppedBots = await this.engine.stopAll("emergency");
    let closed = 0;
    for (const p of positions) {
      try {
        await this.exchange.placeOrder({
          symbol: p.symbol, side: p.side === Side.Buy ? Side.Sell : Side.Buy,
          type: OrderType.Market, price: null, size: p.size, reduceOnly: true,
        });
        closed++;
      } catch (err) {
        this.engine.logHandle().error({ symbol: p.symbol, err: String(err) }, "emergency close failed");
      }
    }
    await this.engine.reconcileAllPositions();
    return { stoppedBots, closedPositions: closed };
  }
}