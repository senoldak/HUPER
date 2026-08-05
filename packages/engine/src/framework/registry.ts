import type { Strategy } from "./strategy.js";

export class StrategyRegistry {
  private map = new Map<string, Strategy>();
  register(s: Strategy): void { this.map.set(s.name, s); }
  get(name: string): Strategy | undefined { return this.map.get(name); }
  list(): Strategy[] { return [...this.map.values()]; }
}
