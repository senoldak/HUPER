import type { Order, PriceTick, NewOrder } from "@huper/core";
import type { Engine } from "./engine.js";
import type { Strategy, StrategyCtx, BotState } from "./strategy.js";

export class BotRunner {
  readonly botId: string;
  readonly name: string;
  readonly symbol: string;
  readonly cadenceMs: number;
  lastEval = 0;
  private ctx: StrategyCtx;
  private state: BotState;
  private fillCbs = new Set<(o: Order) => void>();
  active = true;

  constructor(
    private engine: Engine,
    private strategy: Strategy,
    params: Record<string, unknown>,
    state: string,
    botId: string, name: string, symbol: string,
  ) {
    this.botId = botId;
    this.name = name;
    this.symbol = symbol;
    this.cadenceMs = strategy.cadenceMs;
    this.state = safeParse(state);
    this.ctx = {
      botId, name, symbol,
      mode: engine.mode(),
      params,
      state: this.state,
      getTick: () => engine.latestTick(symbol),
      getPositions: () => engine.positionsFor(symbol),
      getBalance: () => engine.balance(),
      createOrder: (o: NewOrder) => engine.executeOrder(botId, symbol, o),
      cancelOrder: (orderId: string) => engine.cancelOrder(botId, orderId),
      onFill: (cb: (o: Order) => void) => { this.fillCbs.add(cb); return () => this.fillCbs.delete(cb); },
      log: (msg: string, meta?: unknown) => engine.logHandle().info({ botId, ...(meta as object) }, msg),
    };
  }

  async start(): Promise<void> {
    await this.strategy.onStart(this.ctx);
    this.lastEval = 0;
  }

  async evaluate(tick: PriceTick): Promise<void> {
    if (!this.active) return;
    try {
      await this.strategy.onTick(tick, this.ctx);
    } finally {
      this.engine.saveBotState(this.botId, this.state);
    }
  }

  async onOrderFilled(order: Order): Promise<void> {
    if (!this.active) return;
    await this.strategy.onOrderFilled?.(order, this.ctx);
    for (const cb of this.fillCbs) cb(order);
    this.engine.saveBotState(this.botId, this.state);
  }

  hasOrder(id: string): boolean { return this.myOrderIds().has(id); }

  private myOrderIds(): Set<string> { return this.engine.orderIdsFor(this.botId); }

  async stop(reason: string): Promise<void> {
    this.active = false;
    await this.engine.cancelAllOrders(this.botId);
    try { await this.strategy.onStop(this.ctx, reason); } finally { this.engine.saveBotState(this.botId, this.state); }
  }
}

function safeParse(s: string): BotState {
  try { return JSON.parse(s) as BotState; } catch { return {}; }
}
