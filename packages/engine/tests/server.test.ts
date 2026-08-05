import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { PaperExchange } from "../src/exchange/paper.js";

describe("server", () => {
  const ex = new PaperExchange({ initialBalance: 1000 });
  ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });
  const app = buildApp({ exchange: ex });

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
});
