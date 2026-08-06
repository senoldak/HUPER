import type { Store } from "./store/store.js";
import type { LoggerLike } from "./framework/engine.js";

export function recoverStaleBots(store: Store, log: LoggerLike): void {
  const stale = store.listBots().filter((b) => b.status === "running");
  for (const bot of stale) {
    const open = store.listRuns(bot.id).find((r) => r.stopped_at === null);
    if (open) store.finishRun(open.id, "crash_recovered");
    store.updateBot(bot.id, { status: "stopped" });
    log.warn({ botId: bot.id }, "recovered stale running bot after crash");
  }
}