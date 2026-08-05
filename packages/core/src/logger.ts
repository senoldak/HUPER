import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
