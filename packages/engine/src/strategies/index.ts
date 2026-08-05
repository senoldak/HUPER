import { StrategyRegistry } from "../framework/registry.js";
import { GridStrategy } from "./grid.js";
import { DcaStrategy } from "./dca.js";
import { TrendStrategy } from "./trend.js";

export function buildRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();
  registry.register(new GridStrategy());
  registry.register(new DcaStrategy());
  registry.register(new TrendStrategy());
  return registry;
}

export { GridStrategy, DcaStrategy, TrendStrategy };
