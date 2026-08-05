import { z } from "zod";

const schema = z.object({
  mode: z.enum(["paper", "live"]),
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "private key must be 0x + 64 hex").optional(),
  paperBalance: z.number().positive().default(10000),
  rpcUrl: z.string().url().default("https://api.hyperliquid.xyz"),
  wsUrl: z.string().default("wss://api.hyperliquid.xyz/ws"),
});

export interface AppConfig {
  mode: "paper" | "live";
  privateKey?: string;
  paperBalance: number;
  rpcUrl: string;
  wsUrl: string;
}

function envToNum(v?: string): number | undefined {
  return v === undefined ? undefined : Number(v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse({
    mode: env.HUPER_MODE ?? "paper",
    privateKey: env.HUPER_HYPERLIQUID_PRIVATE_KEY,
    paperBalance: envToNum(env.HUPER_PAPER_BALANCE),
    rpcUrl: env.HUPER_RPC_URL,
    wsUrl: env.HUPER_WS_URL,
  });
  if (!parsed.success) {
    throw new Error(`config invalid: ${JSON.stringify(parsed.error.flatten())}`);
  }
  const cfg = parsed.data;
  if (cfg.mode === "live" && !cfg.privateKey) {
    throw new Error("config invalid: HUPER_HYPERLIQUID_PRIVATE_KEY required in live mode");
  }
  return cfg;
}
