import { z } from "zod";
import { OrderType, Side } from "@huper/core";
import type { Strategy, StrategyCtx } from "../framework/strategy.js";

const params = z.object({
  fastEma: z.number().int().min(1).max(20),
  slowEma: z.number().int().min(2).max(100),
  orderSize: z.number().positive(),
  rsiPeriod: z.number().int().min(2).max(30),
  oversold: z.number().min(5).max(45),
  overbought: z.number().min(55).max(95),
  stopLossPct: z.number().positive().max(0.2),
  takeProfitPct: z.number().positive().max(0.5),
});

export class TrendStrategy implements Strategy {
  readonly name = "trend";
  readonly paramsSchema = params;
  readonly cadenceMs = 0;

  async onStart(): Promise<void> {}

  async onTick(tick: { mid: number }, ctx: StrategyCtx): Promise<void> {
    const p = ctx.params as z.infer<typeof params>;
    const closes = (ctx.state.closes as number[] | undefined) ?? [];
    closes.push(tick.mid);
    if (closes.length > 200) closes.shift();
    ctx.state.closes = closes;
    if (closes.length < p.slowEma + 1) return;

    const fast = ema(closes, p.fastEma);
    const slow = ema(closes, p.slowEma);
    const prevFast = ema(closes.slice(0, -1), p.fastEma);
    const prevSlow = ema(closes.slice(0, -1), p.slowEma);
    const rsi = calcRsi(closes, p.rsiPeriod);

    const positions = await ctx.getPositions();
    const pos = positions[0];

    if (pos) {
      const unrealized = pos.side === Side.Buy ? (tick.mid - pos.avgEntry) / pos.avgEntry : (pos.avgEntry - tick.mid) / pos.avgEntry;
      if (unrealized <= -p.stopLossPct || unrealized >= p.takeProfitPct) {
        const closeSide = pos.side === Side.Buy ? "sell" : "buy";
        await ctx.createOrder({ symbol: ctx.symbol, side: closeSide, type: OrderType.Market, price: null, size: pos.size, reduceOnly: true });
      }
      return;
    }

    const crossUp = prevFast <= prevSlow && fast > slow;
    const crossDown = prevFast >= prevSlow && fast < slow;
    if (crossUp && rsi > 50) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "buy", type: OrderType.Market, price: null, size: p.orderSize });
    } else if (crossDown && rsi < 50) {
      await ctx.createOrder({ symbol: ctx.symbol, side: "sell", type: OrderType.Market, price: null, size: p.orderSize });
    }
  }

  async onStop(_ctx: StrategyCtx): Promise<void> {
    // no-op: position flattening is owned solely by EmergencyStop
  }
}

function ema(closes: number[], period: number): number {
  if (closes.length <= period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function calcRsi(closes: number[], period: number): number {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}
