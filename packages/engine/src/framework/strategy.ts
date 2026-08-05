import type { z } from "zod";
import type { NewOrder, Order, Position, PriceTick } from "@huper/core";

export interface BotState { [key: string]: unknown }

export interface StrategyCtx {
  readonly botId: string;
  readonly name: string;
  readonly symbol: string;
  readonly mode: "paper" | "live";
  readonly params: Record<string, unknown>;
  readonly state: BotState;
  getTick(): PriceTick | undefined;
  getPositions(): Promise<Position[]>;
  getBalance(): Promise<number>;
  createOrder(o: NewOrder): Promise<Order>;
  cancelOrder(orderId: string): Promise<void>;
  onFill(cb: (o: Order) => void): () => void;
  log(msg: string, meta?: unknown): void;
}

export interface Strategy {
  readonly name: string;
  readonly paramsSchema: z.ZodType;
  readonly cadenceMs: number;
  onStart(ctx: StrategyCtx): Promise<void>;
  onTick(tick: PriceTick, ctx: StrategyCtx): Promise<void>;
  onOrderFilled?(order: Order, ctx: StrategyCtx): Promise<void>;
  onStop(ctx: StrategyCtx, reason: string): Promise<void>;
}
