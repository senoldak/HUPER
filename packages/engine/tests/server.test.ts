import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { PaperExchange } from "../src/exchange/paper.js";
import { openStore } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { RiskManager } from "../src/risk/risk.js";
import { DEFAULT_RISK } from "@huper/core";
import { Engine } from "../src/framework/engine.js";
import { buildRegistry } from "../src/strategies/index.js";

describe("server", () => {
  const exchange = new PaperExchange({ initialBalance: 1000 });
  const store = new Store(openStore(":memory:"));
  const engine = new Engine({ exchange, store, risk: new RiskManager(DEFAULT_RISK), registry: buildRegistry(), log: { info: () => {}, error: () => {}, warn: () => {} } });
  let app: FastifyInstance;

  beforeAll(async () => {
    await engine.start();
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });
    app = buildApp({ exchange, engine });
  });

  afterAll(async () => { await app.close(); });

  it("health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("place order via HTTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { symbol: "BTC", side: "buy", price: null, size: 0.1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("filled");
  });

  it("returns positions", async () => {
    const res = await app.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it("creates and starts a bot via HTTP", async () => {
    exchange.pushTick({ symbol: "BTC", bid: 100, ask: 100, mid: 100, timestamp: 0 });
    const created = await app.inject({ method: "POST", url: "/bots", payload: { name: "HTTP Grid", strategy: "grid", symbol: "BTC", params: { levels: 2, spacingPct: 0.01, orderSize: 0.1 } } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const started = await app.inject({ method: "POST", url: `/bots/${id}/start` });
    expect(started.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/bots" });
    expect(list.json()).toHaveLength(1);

    const stopped = await app.inject({ method: "POST", url: `/bots/${id}/stop` });
    expect(stopped.json()).toEqual({ ok: true });
  });

  it("rejects bad bot params", async () => {
    const res = await app.inject({ method: "POST", url: "/bots", payload: { name: "Bad", strategy: "grid", symbol: "BTC", params: { levels: -1 } } });
    expect(res.statusCode).toBe(400);
  });

  it("serves the panel index at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("HUPER");
  });

  it("serves static assets", async () => {
    const res = await app.inject({ method: "GET", url: "/app.js" });
    expect(res.statusCode).toBe(200);
  });

  it("returns global equity series via /equity", async () => {
    await engine.recordEquity();
    const res = await app.inject({ method: "GET", url: "/equity?limit=5" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; bot_id: string | null; ts: number; value: number }[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.every((r) => r.bot_id === null)).toBe(true);
  });
});
