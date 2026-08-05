import { z } from "zod";
import { OrderType } from "@huper/core";
import type { Strategy, StrategyCtx } from "../framework/strategy.js";

const params = z.object({
  levels: z.number().int().min(1).max(50),
  spacingPct: z.number().positive().max(0.1),
  orderSize: z.number().positive(),
});

export class GridStrategy implements Strategy {
  readonly name = "grid";
  readonly paramsSchema = params;
  readonly cadenceMs = 0;

  async onStart(ctx: StrategyCtx): Promise<void> {
    const tick = ctx.getTick();
    if (!tick) throw new Error("grid: no price yet");
    const { levels, spacingPct, orderSize } = ctx.params as z.infer<typeof params>;
    ctx.state.base = tick.mid;
    for (let i = 1; i <= levels; i++) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Limit, price: round2(tick.mid * (1 - i * spacingPct)), size: orderSize });
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Limit, price: round2(tick.mid * (1 + i * spacingPct)), size: orderSize });
    }
  }

  async onTick(): Promise<void> { /* fills drive re-hedging */ }

  async onOrderFilled(order: { side: string; price: number | null }, ctx: StrategyCtx): Promise<void> {
    if (order.price == null) return;
    const spacingPct = (ctx.params as { spacingPct: number }).spacingPct;
    const orderSize = (ctx.params as { orderSize: number }).orderSize;
    if (order.side === "buy") {
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Limit, price: round2(order.price * (1 + spacingPct)), size: orderSize });
    } else {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Limit, price: round2(order.price * (1 - spacingPct)), size: orderSize });
    }
  }

  async onStop(): Promise<void> {}
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
