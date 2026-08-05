import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { ExchangeAdapter, NewOrder } from "@huper/core";
import type { Engine } from "./framework/engine.js";
import { EmergencyStop } from "./emergency.js";

export function buildApp(opts: { exchange: ExchangeAdapter; engine: Engine }): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { symbol: string } }>("/ticks/:symbol", async (req) => {
    const t = await opts.exchange.tick(req.params.symbol);
    return { tick: t ?? null };
  });

  app.post<{ Body: NewOrder }>("/orders", async (req, reply) => {
    try {
      const order = await opts.exchange.placeOrder(req.body);
      return reply.code(201).send(order);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/balances", async () => opts.exchange.balances());
  app.get("/positions", async () => opts.exchange.openPositions());

  app.post<{ Body: { name: string; strategy: string; symbol: string; params: Record<string, unknown> } }>("/bots", async (req, reply) => {
    try {
      const bot = await opts.engine.createBot(req.body);
      return reply.code(201).send(bot);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get("/bots", async () => opts.engine.listBots());

  app.get<{ Params: { id: string } }>("/bots/:id", async (req, reply) => {
    const detail = await opts.engine.getBotDetail(req.params.id);
    if (!detail) return reply.code(404).send({ error: "bot not found" });
    return detail;
  });

  app.post<{ Params: { id: string } }>("/bots/:id/start", async (req, reply) => {
    try { await opts.engine.startBot(req.params.id); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post<{ Params: { id: string } }>("/bots/:id/stop", async (req, reply) => {
    try { await opts.engine.stopBot(req.params.id); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.delete<{ Params: { id: string } }>("/bots/:id", async (req, reply) => {
    try { await opts.engine.deleteBot(req.params.id); return { ok: true }; }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.post("/emergency-stop", async () => {
    return new EmergencyStop(opts.engine, opts.exchange).run();
  });

  return app;
}
