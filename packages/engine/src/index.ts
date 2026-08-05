import { loadConfig, createLogger } from "@huper/core";
import { PaperExchange } from "./exchange/paper.js";
import { LiveExchange } from "./exchange/live.js";
import { buildApp } from "./server.js";

async function main() {
  const cfg = loadConfig();
  const log = createLogger("engine");

  const exchange = cfg.mode === "paper"
    ? new PaperExchange({ initialBalance: cfg.paperBalance })
    : new LiveExchange({ privateKey: cfg.privateKey!, rpcUrl: cfg.rpcUrl, wsUrl: cfg.wsUrl });

  await exchange.connect();
  log.info({ mode: cfg.mode }, "exchange connected");

  const app = buildApp({ exchange });
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });
  log.info({ port }, "engine listening");

  const stop = async () => {
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
