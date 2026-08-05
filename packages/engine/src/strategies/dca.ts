import { z } from "zod";
import { OrderType, Side } from "@huper/core";
import type { Strategy, StrategyCtx } from "../framework/strategy.js";

const params = z.object({
  stepPct: z.number().positive().max(0.2),
  takeProfitPct: z.number().positive().max(0.5),
  totalSteps: z.number().int().min(1).max(20),
  baseSize: z.number().positive(),
  sizeMultiplier: z.number().min(1).max(5),
});

export class DcaStrategy implements Strategy {
  readonly name = "dca";
  readonly paramsSchema = params;
  readonly cadenceMs = 0;

  async onStart(ctx: StrategyCtx): Promise<void> {
    const p = ctx.params as z.infer<typeof params>;
    await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size: p.baseSize });
    ctx.state.entered = true;
    ctx.state.steps = 0;
  }

  async onTick(tick: { mid: number }, ctx: StrategyCtx): Promise<void> {
    const p = ctx.params as z.infer<typeof params>;
    const positions = await ctx.getPositions();
    const pos = positions[0];
    if (!pos) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size: p.baseSize });
      ctx.state.steps = 0;
      return;
    }
    const lastEntry = (ctx.state.lastEntry as number) ?? pos.avgEntry;
    if (pos.side === Side.Buy && tick.mid <= lastEntry * (1 - p.stepPct) && (ctx.state.steps as number) < p.totalSteps) {
      ctx.state.steps = (ctx.state.steps as number) + 1;
      const size = p.baseSize * Math.pow(p.sizeMultiplier, ctx.state.steps as number);
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size });
    }
    ctx.state.lastEntry = tick.mid;

    const unrealized = (tick.mid - pos.avgEntry) / pos.avgEntry;
    if (unrealized >= p.takeProfitPct) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Market, price: null, size: pos.size, reduceOnly: true });
    }
  }

  async onStop(ctx: StrategyCtx): Promise<void> {
    const pos = (await ctx.getPositions())[0];
    if (pos) await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Market, price: null, size: pos.size, reduceOnly: true });
  }
}
