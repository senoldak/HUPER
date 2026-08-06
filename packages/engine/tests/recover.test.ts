import { describe, it, expect } from "vitest";
import { openStore } from "../src/store/db.js";
import { Store } from "../src/store/store.js";
import { recoverStaleBots } from "../src/recover.js";

function makeLogger() {
  const calls: string[] = [];
  return {
    calls,
    log: {
      info: () => {},
      error: () => {},
      warn: (obj: unknown, msg: string) => calls.push(msg),
    },
  };
}

describe("recoverStaleBots", () => {
  it("finishes open runs and stops running bots after a crash", () => {
    const store = new Store(openStore(":memory:"));
    store.saveBot({ id: "b1", name: "Crashed", strategy: "grid", symbol: "BTC", params: "{}", status: "running", state: "{}", created_at: 1, updated_at: 1 });
    store.createBotRun({ id: "r1", bot_id: "b1", mode: "paper", started_at: 2, stopped_at: null, stop_reason: null });

    const { calls, log } = makeLogger();
    recoverStaleBots(store, log);

    expect(store.getBot("b1")?.status).toBe("stopped");
    const [run] = store.listRuns("b1");
    expect(run.stopped_at).not.toBeNull();
    expect(run.stop_reason).toBe("crash_recovered");
    expect(calls).toContain("recovered stale running bot after crash");
  });

  it("leaves non-running and already-finished bots untouched", () => {
    const store = new Store(openStore(":memory:"));
    store.saveBot({ id: "b2", name: "Idle", strategy: "grid", symbol: "BTC", params: "{}", status: "stopped", state: "{}", created_at: 1, updated_at: 1 });
    store.saveBot({ id: "b3", name: "Done", strategy: "grid", symbol: "BTC", params: "{}", status: "running", state: "{}", created_at: 1, updated_at: 1 });
    store.createBotRun({ id: "r2", bot_id: "b3", mode: "paper", started_at: 2, stopped_at: 9, stop_reason: "stopped" });

    const { log } = makeLogger();
    recoverStaleBots(store, log);

    expect(store.getBot("b2")?.status).toBe("stopped");
    const [run] = store.listRuns("b3");
    expect(run.stop_reason).toBe("stopped");
  });

  it("stops a running bot even when it has no open run", () => {
    const store = new Store(openStore(":memory:"));
    store.saveBot({ id: "b4", name: "NoRun", strategy: "grid", symbol: "BTC", params: "{}", status: "running", state: "{}", created_at: 1, updated_at: 1 });

    const { log } = makeLogger();
    recoverStaleBots(store, log);

    expect(store.getBot("b4")?.status).toBe("stopped");
  });
});