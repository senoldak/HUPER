import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, createLogger, DEFAULT_RISK } from "@huper/core";
import { PaperExchange } from "./exchange/paper.js";
import { LiveExchange } from "./exchange/live.js";
import { openStore } from "./store/db.js";
import { Store } from "./store/store.js";
import { RiskManager } from "./risk/risk.js";
import { Engine } from "./framework/engine.js";
import { buildRegistry } from "./strategies/index.js";
import { MarketDataFeed } from "./market/feed.js";
import { buildApp } from "./server.js";
import { EmergencyStop } from "./emergency.js";
import { recoverStaleBots } from "./recover.js";
import type { ExchangeAdapter } from "@huper/core";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

async function main() {
  const cfg = loadConfig();
  const log = createLogger("engine");

  const dbPath = process.env.HUPER_DB_PATH ?? "data/huper.db";
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const store = new Store(openStore(dbPath));
  recoverStaleBots(store, log);
  const exchange: ExchangeAdapter = cfg.mode === "paper"
    ? new PaperExchange({ initialBalance: cfg.paperBalance })
    : new LiveExchange({ privateKey: cfg.privateKey!, rpcUrl: cfg.rpcUrl, wsUrl: cfg.wsUrl });
  await exchange.connect();
  log.info({ mode: cfg.mode }, "exchange connected");

  const engine = new Engine({ exchange, store, risk: new RiskManager(DEFAULT_RISK), registry: buildRegistry(), log });
  await engine.start();

  const EQUITY_INTERVAL_MS = 5000;
  const equityTimer = setInterval(() => {
    void engine.recordEquity().catch((e) => log.warn({ err: (e as Error).message }, "equity record failed"));
  }, EQUITY_INTERVAL_MS);

  let feed: MarketDataFeed | undefined;
  if (cfg.mode === "paper") {
    feed = new MarketDataFeed(cfg.wsUrl);
    feed.onTick((t) => (exchange as PaperExchange).pushTick(t));
    await feed.connect();
    log.info("market data feed connected (paper)");
  }

  const app = buildApp({ exchange, engine, store });
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  log.info({ port }, "engine listening");

  const stop = async () => {
    clearInterval(equityTimer);
    await engine.stop();
    if (feed) await feed.disconnect();
    await exchange.disconnect();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
