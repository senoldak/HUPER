import Fastify from "fastify";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import type { ExchangeAdapter, NewOrder } from "@huper/core";

export function buildApp(opts: { exchange: ExchangeAdapter }): FastifyInstance {
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

  return app;
}
