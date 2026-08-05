import { describe, it, expect } from "vitest";
import { loadConfig, createLogger } from "../src/index.js";

describe("loadConfig", () => {
  it("paper mode default with balance", () => {
    const cfg = loadConfig({
      HUPER_MODE: "paper",
      HUPER_PAPER_BALANCE: "5000",
    } as NodeJS.ProcessEnv);
    expect(cfg.mode).toBe("paper");
    expect(cfg.paperBalance).toBe(5000);
  });

  it("live mode requires private key", () => {
    const cfg = loadConfig({
      HUPER_MODE: "live",
      HUPER_HYPERLIQUID_PRIVATE_KEY: "0x" + "ab".repeat(32),
    } as NodeJS.ProcessEnv);
    expect(cfg.mode).toBe("live");
    expect(cfg.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("unknown mode throws", () => {
    expect(() => loadConfig({ HUPER_MODE: "nope" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("live mode without key throws", () => {
    expect(() => loadConfig({ HUPER_MODE: "live" } as NodeJS.ProcessEnv)).toThrow();
  });
});
