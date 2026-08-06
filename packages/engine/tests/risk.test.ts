import { describe, it, expect } from "vitest";
import { RiskManager, type OrderAttempt } from "../src/risk/risk.js";
import type { RiskSnapshot } from "@huper/core";

const base = {
  globalMaxPositionPct: 0.5, perBotMaxPositionPct: 0.2, maxOrderNotionalPct: 0.05,
  maxPriceDriftPct: 0.05, minOrderSize: 0.001, maxOrderSize: null, duplicateGuardMs: 2000,
};

const attempt: OrderAttempt = { botId: "b1", symbol: "BTC", side: "buy", price: 100, size: 0.1, kind: "limit", reduceOnly: false };

function snap(over: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return { botId: "b1", symbol: "BTC", balance: 10000, lastPrice: 100, botPositionNotional: 0, globalPositionNotional: 0, recentOrders: [], ...over };
}

describe("RiskManager", () => {
  it("allows a safe limit order", () => {
    expect(new RiskManager(base).validate(attempt, snap())).toEqual({ ok: true });
  });

  it("rejects order exceeding per-bot position cap (20% of balance)", () => {
    const r = new RiskManager(base).validate({ ...attempt, size: 0.1 }, snap({ botPositionNotional: 2000 }));
    expect(r).toEqual({ ok: false, reason: "exceeds per-bot position cap" });
  });

  it("rejects duplicate order within guard window", () => {
    const r = new RiskManager(base).validate(attempt, snap({ recentOrders: [{ id: "x", botId: "b1", symbol: "BTC", side: "buy", price: 100, size: 0.1, createdAt: Date.now() }] }));
    expect(r).toEqual({ ok: false, reason: "duplicate order" });
  });

  it("rejects limit order beyond price drift", () => {
    const r = new RiskManager(base).validate({ ...attempt, price: 110 }, snap({ lastPrice: 100 }));
    expect(r).toEqual({ ok: false, reason: "price drift beyond limit" });
  });

  it("rejects size below minimum", () => {
    const r = new RiskManager(base).validate({ ...attempt, size: 0.0001 }, snap());
    expect(r).toEqual({ ok: false, reason: "size below minimum" });
  });

  it("allows reduce-only market close regardless of drift", () => {
    const r = new RiskManager(base).validate({ ...attempt, kind: "market", price: null, reduceOnly: true }, snap({ lastPrice: 100 }));
    expect(r).toEqual({ ok: true });
  });

  it("allows reduce-only market close past position caps", () => {
    const r = new RiskManager(base).validate({ ...attempt, kind: "market", price: null, reduceOnly: true, size: 5 }, snap({ botPositionNotional: 4000, globalPositionNotional: 4000 }));
    expect(r).toEqual({ ok: true });
  });

  it("still applies order-notional cap to reduce-only", () => {
    const r = new RiskManager(base).validate({ ...attempt, kind: "market", price: null, reduceOnly: true, size: 1000 }, snap({ balance: 1000 }));
    expect(r).toEqual({ ok: false, reason: "exceeds order notional cap" });
  });

  it("still applies size-minimum to reduce-only", () => {
    const r = new RiskManager(base).validate({ ...attempt, kind: "market", price: null, reduceOnly: true, size: 0.0001 }, snap());
    expect(r).toEqual({ ok: false, reason: "size below minimum" });
  });
});
