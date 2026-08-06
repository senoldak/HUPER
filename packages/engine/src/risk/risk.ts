import type { RiskConfig, OrderAttempt, RiskSnapshot } from "@huper/core";

export class RiskManager {
  constructor(private cfg: RiskConfig) {}

  validate(a: OrderAttempt, s: RiskSnapshot): { ok: true } | { ok: false; reason: string } {
    if (Math.abs(a.size) < this.cfg.minOrderSize) return { ok: false, reason: "size below minimum" };
    if (this.cfg.maxOrderSize != null && Math.abs(a.size) > this.cfg.maxOrderSize) return { ok: false, reason: "size above maximum" };

    const dup = s.recentOrders.find(
      (o) => o.botId === a.botId && o.symbol === a.symbol && o.side === a.side &&
             o.price === a.price && o.size === a.size &&
             Date.now() - o.createdAt < this.cfg.duplicateGuardMs,
    );
    if (dup) return { ok: false, reason: "duplicate order" };

    const ref = a.price ?? s.lastPrice;
    if (ref == null) return { ok: false, reason: "no price reference" };
    const notional = ref * Math.abs(a.size);

    if (notional > s.balance * this.cfg.maxOrderNotionalPct) return { ok: false, reason: "exceeds order notional cap" };
    if (!a.reduceOnly) {
      if (s.botPositionNotional + notional > s.balance * this.cfg.perBotMaxPositionPct) return { ok: false, reason: "exceeds per-bot position cap" };
      if (s.globalPositionNotional + notional > s.balance * this.cfg.globalMaxPositionPct) return { ok: false, reason: "exceeds global position cap" };
    }

    if (a.kind === "limit" && !a.reduceOnly && a.price != null && s.lastPrice != null) {
      const drift = Math.abs(a.price - s.lastPrice) / s.lastPrice;
      if (drift > this.cfg.maxPriceDriftPct) return { ok: false, reason: "price drift beyond limit" };
    }
    return { ok: true };
  }
}
