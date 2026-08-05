# HUPER Foundation — Monorepo & Exchange Katmanı Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HUPER Hyperliquid bot platformunun temelini atmak: npm workspaces monorepo iskeleti, `core` paketi (tipler/config/logger) ve `engine` exchange katmanı (`paper` + `live` adaptörleri).

**Architecture:** Monorepo = `packages/core` (paylaşılan tipler & config) + `packages/engine` (bot motoru; bu planda exchange katmanı) + `packages/web` (sonraki planda). İki ayrı çalışan: engine (arka plan) ve web (panel). `ExchangeAdapter` arayüzü `paper` ve `live` modlarını aynı sözleşmeyle gerçekler; strateji kodu mod farkını görmez. SQLite durum deposu bot motoru planında (Phase 2) eklenir.

**Tech Stack:** TypeScript 5.6+, **npm workspaces** (pnpm sisteme kurulu DEĞİL), Vitest (test), `@nktkas/hyperliquid` (Hyperliquid SDK), `viem` (ed25519 anahtar → wallet), Zod (config), Pino (log), Fastify (HTTP köprüsü). Docker dosyaları VPS taşınabilirlik için dahil; lokal doğrulama `npm` ile.

## Global Constraints

- Node ≥ 22 (ortam: v24.12.0). Tüm paketler `"type": "module"` (ESM).
- Paket yöneticisi: **npm workspaces**; monorepo bağımlılığı `"@huper/core": "*"` biçiminde (npm, `workspace:*` tanımaz).
- Tüm testler Vitest (**^3.0.5**, tutarlı versiyon) ile, TDD sırasıyla.
- Ortak tipler yalnızca `packages/core`'dan import edilir; `engine` kendi domain tiplerini tanımlamaz.
- Tip/saha adları bu plandaki şemalarla **birebir** aynı kalacak (sonraki planlar bunları import eder).
- Hyperliquid private key asla düz metin loglanmaz/commit edilmez; `.env` + `.env.example`.
- `@types/node` her iki pakette de devDependency olarak kurulur (tsconfig `types: ["node"]`).
- Canlı emir gerçek anahtarla test edilmez; SDK'dan bağımsız saf fonksiyonlar test edilir.

---

## Task 1: Monorepo İskeleti (npm workspaces)

**Files:**
- Create: `package.json`, `.gitignore`, `tsconfig.base.json`, `.env.example`, `README.md`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/src/index.ts`

**Interfaces:**
- Consumes: Node/npm ortamı.
- Produces: workspace root scriptleri `npm run typecheck`, `npm test`; `@huper/core` ve `@huper/engine` paketleri `npm install` sonrası resolvable.

- [ ] **Step 1: git repo başlat ve .gitignore yaz**

```bash
git init -b main
```

`.gitignore`:
```gitignore
node_modules/
dist/
coverage/
.env
.env.local
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 2: Kök package.json yaz**

```json
{
  "name": "huper",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^3.0.5",
    "tsx": "^4.19.2",
    "@types/node": "^22.10.0"
  }
}
```

- [ ] **Step 3: tsconfig.base.json yaz**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 4: core ve engine paketlerini yaz**

`packages/core/package.json`:
```json
{
  "name": "@huper/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.8", "pino": "^9.5.0" },
  "devDependencies": { "typescript": "^5.6.3", "vitest": "^3.0.5", "@types/node": "^22.10.0" }
}
```

`packages/engine/package.json`:
```json
{
  "name": "@huper/engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@huper/core": "*",
    "@nktkas/hyperliquid": "^0.33.3",
    "viem": "^2.21.0",
    "fastify": "^5.2.0",
    "@fastify/cors": "^10.0.1"
  },
  "devDependencies": { "typescript": "^5.6.3", "vitest": "^3.0.5", "@types/node": "^22.10.0", "tsx": "^4.19.2" }
}
```

Her paket için `tsconfig.json` (test dosyaları Vitest tarafından derlenir; `tsc` sadece `src`'i görür — böylece `rootDir: "src"` ile build/typecheck temiz kalır):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

> Not: Task 1 commit'inde bu tsconfig'ler `include: ["src", "test"]` ile yazılmıştı (plan revizyonu). Task 2 bunları `["src"]`'e çevirir — aksi halde `npm run build` TS6059 ile kırılır.

Geçici entry dosyaları:
`packages/core/src/index.ts` ve `packages/engine/src/index.ts`:
```ts
export {};
```

- [ ] **Step 5: `.env.example` yaz**

```
# Live mod için: Hyperliquid API'de üretilen ed25519 private key (0x + 64 hex)
HUPER_HYPERLIQUID_PRIVATE_KEY=
HUPER_MODE=paper
HUPER_PAPER_BALANCE=10000
PORT=3001
```

- [ ] **Step 6: bağımlılıkları kur ve doğrula**

Run: `npm install`
Run: `npm run typecheck`
Expected: 0 hata

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm workspaces monorepo (core, engine)"
```

---

## Task 2: Core — Ortak Domain Tipleri

**Files:**
- Create: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/types.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `Side`, `OrderType`, `OrderStatus` (const object + union tip), `NewOrder`, `Order`, `Position`, `PriceTick`, `PriceLevel`, `OrderBook`, `Wallet`, `ExchangeAdapter`. Sonraki tüm görevler bunları import eder: `import type { Order } from "@huper/core"`.

- [ ] **Step 1: Failing test yaz**

`packages/core/tests/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Side, OrderType, OrderStatus, type Order, type NewOrder } from "../src/types.js";

describe("core types", () => {
  it("enum-like namespaces expose string values", () => {
    expect(Side.Buy).toBe("buy");
    expect(OrderType.Limit).toBe("limit");
    expect(OrderStatus.Filled).toBe("filled");
  });

  it("Order shape is valid", () => {
    const o: Order = {
      id: "1",
      symbol: "ETH",
      side: Side.Buy,
      type: OrderType.Limit,
      price: 1000,
      size: 1,
      status: OrderStatus.New,
      filledSize: 0,
      avgFillPrice: null,
      createdAt: 0,
    };
    expect(o.symbol).toBe("ETH");
  });

  it("NewOrder defaults to limit type", () => {
    const n: NewOrder = { symbol: "BTC", side: Side.Sell, price: 50000, size: 0.01 };
    expect(n.type).toBeUndefined();
  });
});
```

- [ ] **Step 2: Testi çalıştır (fail beklenir)**

Run: `npm run test -w @huper/core`
Expected: FAIL — `../src/types.js` bulunamaz / tipler yok

- [ ] **Step 3: types.ts yaz**

`packages/core/src/types.ts`:
```ts
export const Side = { Buy: "buy", Sell: "sell" } as const;
export type Side = (typeof Side)[keyof typeof Side];

export const OrderType = { Limit: "limit", Market: "market" } as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const OrderStatus = {
  New: "new",
  Open: "open",
  Filled: "filled",
  PartiallyFilled: "partially_filled",
  Cancelled: "cancelled",
  Rejected: "rejected",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export interface NewOrder {
  symbol: string;
  side: Side;
  type?: OrderType;
  price: number | null;
  size: number;
  reduceOnly?: boolean;
  cloid?: string;
}

export interface Order extends NewOrder {
  id: string;
  status: OrderStatus;
  filledSize: number;
  avgFillPrice: number | null;
  createdAt: number;
  filledAt?: number;
  error?: string;
}

export interface Position {
  symbol: string;
  side: Side;
  size: number;
  avgEntry: number;
  markPrice?: number;
}

export interface PriceTick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: number;
}

export type PriceLevel = [price: number, size: number];

export interface OrderBook {
  symbol: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
}

export interface Wallet {
  asset: string;
  available: number;
  total: number;
}

export interface ExchangeAdapter {
  readonly mode: "paper" | "live";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  tick(symbol: string): Promise<PriceTick | undefined>;
  orderbook(symbol: string): Promise<OrderBook | undefined>;
  balances(): Promise<Wallet[]>;
  openPositions(): Promise<Position[]>;
  placeOrder(order: NewOrder): Promise<Order>;
  cancelOrder(orderId: string): Promise<boolean>;
  onTick(cb: (tick: PriceTick) => void): () => void;
  onFill(cb: (order: Order) => void): () => void;
}
```

- [ ] **Step 4: index.ts'te dışa aktar**

`packages/core/src/index.ts`:
```ts
export * from "./types.js";
```

- [ ] **Step 5: Testi çalıştır (geçmeli)**

Run: `npm run test -w @huper/core`
Expected: PASS (3 it)

- [ ] **Step 6: typecheck**

Run: `npm run typecheck -w @huper/core`
Expected: 0 hata

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add shared domain types (Side, NewOrder, Order, ExchangeAdapter)"
```

---

## Task 3: Core — Config ve Logger

**Files:**
- Create: `packages/core/src/config.ts`
- Create: `packages/core/src/logger.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/config.test.ts`

**Interfaces:**
- Consumes: Task 1, 2.
- Produces:
  - `interface AppConfig { mode: "paper" | "live"; privateKey?: string; paperBalance: number; rpcUrl: string; wsUrl: string }`
  - `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` — Zod doğrulamalı; geçersiz config'te `Error` fırlatır.
  - `createLogger(name: string): Logger` (pino).

- [ ] **Step 1: Failing test yaz**

`packages/core/tests/config.test.ts`:
```ts
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
```

- [ ] **Step 2: Testi çalıştır (fail)**

Run: `npm run test -w @huper/core`
Expected: FAIL — `loadConfig` undefined

- [ ] **Step 3: config.ts yaz**

`packages/core/src/config.ts`:
```ts
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
```

- [ ] **Step 4: logger.ts yaz**

`packages/core/src/logger.ts`:
```ts
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
```

- [ ] **Step 5: index.ts'te yeni modülleri dışa aktar**

```ts
export * from "./types.js";
export * from "./config.js";
export * from "./logger.js";
```

- [ ] **Step 6: test + typecheck**

Run: `npm run test -w @huper/core`
Run: `npm run typecheck -w @huper/core`
Expected: PASS (4 it) + 0 hata

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): add zod config loader and pino logger"
```

---

## Task 4: PaperExchange — Paper Mod Adaptörü

**Files:**
- Create: `packages/engine/src/exchange/paper.ts`
- Test: `packages/engine/tests/paper.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ExchangeAdapter`, `NewOrder`, `Order`, `PriceTick`, `OrderBook`, `Position`, `Wallet`, `Side`, `OrderStatus`, `OrderType`), Task 3 (`createLogger` — bu görevde kullanılmaz, ileride).
- Produces: `class PaperExchange implements ExchangeAdapter`:
  - `constructor(opts: { initialBalance: number })`
  - `pushTick(tick: PriceTick): void` — fiyat günceller, bekleyen limit emirlerini tarar (sweep), `onTick` callback'lerini tetikler.
  - `orderById(id: string): Order | undefined` — test/izleme yardımcısı.
  - Dolum kuralları: market → anlık fill (ask/bid'den); limit buy → `ask <= price` olunca `price`'tan fill; limit sell → `bid >= price` olunca `price`'tan fill. Kısmi fill bu planda yok (Phase 2 motoru ekler).
  - Bakiye: `available` = kasa (cash); `total` = kasa + açık pozisyon mark değeri.

- [ ] **Step 1: Failing test yaz**

`packages/engine/tests/paper.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PaperExchange } from "../src/exchange/paper.js";
import { Side, OrderStatus } from "@huper/core";

describe("PaperExchange", () => {
  it("market buy fills immediately at ask price", async () => {
    const ex = new PaperExchange({ initialBalance: 10000 });
    ex.pushTick({ symbol: "ETH", bid: 999, ask: 1001, mid: 1000, timestamp: 1 });

    const o = await ex.placeOrder({ symbol: "ETH", side: Side.Buy, price: null, size: 1 });
    expect(o.status).toBe(OrderStatus.Filled);
    expect(o.avgFillPrice).toBe(1001);
    expect(o.filledSize).toBe(1);
  });

  it("limit buy stays open until tick crosses", async () => {
    const ex = new PaperExchange({ initialBalance: 10000 });
    ex.pushTick({ symbol: "ETH", bid: 1100, ask: 1102, mid: 1101, timestamp: 1 });
    const o = await ex.placeOrder({ symbol: "ETH", side: Side.Buy, price: 1000, size: 1 });
    expect(o.status).toBe(OrderStatus.Open);

    ex.pushTick({ symbol: "ETH", bid: 995, ask: 999, mid: 997, timestamp: 2 });
    const updated = ex.orderById(o.id)!;
    expect(updated.status).toBe(OrderStatus.Filled);
    expect(updated.avgFillPrice).toBe(1000);
  });

  it("buy reduces available cash, total includes mark value", async () => {
    const ex = new PaperExchange({ initialBalance: 1000 });
    ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });
    await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 1 });

    const bal = (await ex.balances())[0];
    expect(bal.available).toBeCloseTo(1000 - 101, 6); // 899
    expect(bal.total).toBeCloseTo(1000 - 101 + 100, 6); // 999, mark = bid
  });

  it("sells reduce position and restore cash", async () => {
    const ex = new PaperExchange({ initialBalance: 1000 });
    ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });
    await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 1 }); // cash 899
    ex.pushTick({ symbol: "BTC", bid: 110, ask: 112, mid: 111, timestamp: 2 });
    await ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 1 }); // +112

    const bal = (await ex.balances())[0];
    expect(bal.available).toBeCloseTo(899 + 112, 6);
    expect((await ex.openPositions())).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Testi çalıştır (fail)**

Run: `npm run test -w @huper/engine`
Expected: FAIL — `../src/exchange/paper.js` bulunamaz / `PaperExchange` yok

- [ ] **Step 3: paper.ts yaz**

`packages/engine/src/exchange/paper.ts`:
```ts
import {
  Side,
  OrderType,
  OrderStatus,
  type ExchangeAdapter,
  type NewOrder,
  type Order,
  type PriceTick,
  type OrderBook,
  type Position,
  type Wallet,
} from "@huper/core";

let seq = 0;
const now = () => Date.now();

export interface PaperOptions {
  initialBalance: number;
}

interface PaperPosition {
  side: Side;
  size: number;
  avgEntry: number;
}

export class PaperExchange implements ExchangeAdapter {
  readonly mode = "paper" as const;

  private cash: number;
  private positions = new Map<string, PaperPosition>();
  private orders = new Map<string, Order>();
  private ticks = new Map<string, PriceTick>();
  private tickCbs = new Set<(t: PriceTick) => void>();
  private fillCbs = new Set<(o: Order) => void>();

  constructor(opts: PaperOptions) {
    this.cash = opts.initialBalance;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async tick(symbol: string): Promise<PriceTick | undefined> {
    return this.ticks.get(symbol);
  }

  async orderbook(symbol: string): Promise<OrderBook | undefined> {
    const t = this.ticks.get(symbol);
    return t
      ? { symbol, bids: [[t.bid, 0]], asks: [[t.ask, 0]], timestamp: t.timestamp }
      : undefined;
  }

  async balances(): Promise<Wallet[]> {
    let equity = this.cash;
    for (const [symbol, p] of this.positions) {
      const t = this.ticks.get(symbol);
      const mark = t ? (p.side === Side.Buy ? t.bid : t.ask) : p.avgEntry;
      equity += p.size * mark;
    }
    return [{ asset: "USDC", available: this.cash, total: equity }];
  }

  async openPositions(): Promise<Position[]> {
    const out: Position[] = [];
    for (const [symbol, p] of this.positions) {
      const t = this.ticks.get(symbol);
      out.push({
        symbol,
        side: p.side,
        size: p.size,
        avgEntry: p.avgEntry,
        markPrice: t ? (p.side === Side.Buy ? t.bid : t.ask) : p.avgEntry,
      });
    }
    return out;
  }

  onTick(cb: (t: PriceTick) => void): () => void {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }

  onFill(cb: (o: Order) => void): () => void {
    this.fillCbs.add(cb);
    return () => this.fillCbs.delete(cb);
  }

  pushTick(tick: PriceTick): void {
    this.ticks.set(tick.symbol, tick);
    this.sweep(tick.symbol);
    for (const cb of this.tickCbs) cb(tick);
  }

  orderById(id: string): Order | undefined {
    return this.orders.get(id);
  }

  async placeOrder(n: NewOrder): Promise<Order> {
    const id = `pp-${++seq}`;
    const type = n.type ?? OrderType.Limit;
    const fillPrice = this.fillPriceFor(n, type);

    let order: Order;
    if (fillPrice !== null) {
      order = this.buildOrder(n, id, OrderStatus.Filled, fillPrice, Math.abs(n.size));
      this.applyFill(n, fillPrice, Math.abs(n.size));
      for (const cb of this.fillCbs) cb(order);
    } else {
      order = this.buildOrder(n, id, OrderStatus.Open, null, 0);
    }
    this.orders.set(id, order);
    return order;
  }

  async cancelOrder(id: string): Promise<boolean> {
    const o = this.orders.get(id);
    if (!o || o.status !== OrderStatus.Open) return false;
    this.orders.set(id, { ...o, status: OrderStatus.Cancelled });
    return true;
  }

  private fillPriceFor(n: NewOrder, type: OrderType): number | null {
    const t = this.ticks.get(n.symbol);
    if (!t) return null;
    if (type === OrderType.Market) return n.side === Side.Buy ? t.ask : t.bid;
    if (n.price === null) return null;
    return n.side === Side.Buy ? (t.ask <= n.price ? n.price : null)
                               : (t.bid >= n.price ? n.price : null);
  }

  private buildOrder(n: NewOrder, id: string, status: OrderStatus, avgFillPrice: number | null, filledSize: number): Order {
    return {
      id,
      symbol: n.symbol,
      side: n.side,
      type: n.type ?? OrderType.Limit,
      price: n.price,
      size: n.size,
      status,
      filledSize,
      avgFillPrice,
      createdAt: now(),
      filledAt: status === OrderStatus.Filled ? now() : undefined,
    };
  }

  private sweep(symbol: string): void {
    const t = this.ticks.get(symbol);
    if (!t) return;
    for (const [id, o] of this.orders) {
      if (o.status !== OrderStatus.Open || o.symbol !== symbol || o.price === null) continue;
      const px = o.side === Side.Buy ? t.ask : t.bid;
      const crossed = o.side === Side.Buy ? px <= o.price : px >= o.price;
      if (!crossed) continue;
      const filled: Order = { ...o, status: OrderStatus.Filled, avgFillPrice: o.price, filledSize: o.size, filledAt: now() };
      this.orders.set(id, filled);
      this.applyFill(o, o.price, Math.abs(o.size));
      for (const cb of this.fillCbs) cb(filled);
    }
  }

  private applyFill(n: NewOrder, px: number, size: number): void {
    if (n.side === Side.Buy) {
      this.cash -= px * size;
      this.addPosition(n.symbol, size, px);
    } else {
      this.cash += px * size;
      this.reducePosition(n.symbol, size);
    }
  }

  private addPosition(symbol: string, size: number, px: number): void {
    const cur = this.positions.get(symbol);
    if (!cur || cur.size === 0 || cur.side === Side.Buy) {
      const total = (cur?.size ?? 0) + size;
      const avg = cur && cur.size > 0 ? (cur.avgEntry * cur.size + px * size) / total : px;
      this.positions.set(symbol, { side: Side.Buy, size: total, avgEntry: avg });
      return;
    }
    const remaining = cur.size - size;
    if (remaining > 0) {
      this.positions.set(symbol, { side: Side.Sell, size: remaining, avgEntry: cur.avgEntry });
    } else if (remaining === 0) {
      this.positions.delete(symbol);
    } else {
      this.positions.set(symbol, { side: Side.Buy, size: Math.abs(remaining), avgEntry: px });
    }
  }

  private reducePosition(symbol: string, size: number): void {
    const cur = this.positions.get(symbol);
    if (!cur || cur.size === 0) {
      this.positions.set(symbol, { side: Side.Sell, size, avgEntry: 0 });
      return;
    }
    if (cur.side === Side.Sell) {
      this.positions.set(symbol, { side: Side.Sell, size: cur.size + size, avgEntry: cur.avgEntry });
      return;
    }
    const remaining = cur.size - size;
    if (remaining > 0) {
      this.positions.set(symbol, { side: Side.Buy, size: remaining, avgEntry: cur.avgEntry });
    } else if (remaining === 0) {
      this.positions.delete(symbol);
    } else {
      this.positions.set(symbol, { side: Side.Sell, size: Math.abs(remaining), avgEntry: 0 });
    }
  }
}
```

- [ ] **Step 4: Testi çalıştır (geçmeli)**

Run: `npm run test -w @huper/engine`
Expected: PASS (4 it)

- [ ] **Step 5: typecheck**

Run: `npm run typecheck -w @huper/engine`
Expected: 0 hata

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(engine): add PaperExchange adapter (paper trading)"
```

---

## Task 5: Hyperliquid Saf Eşleme Fonksiyonları + LiveExchange

**Files:**
- Create: `packages/engine/src/exchange/hyperliquid-mapping.ts`
- Create: `packages/engine/src/exchange/live.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/tests/hyperliquid-mapping.test.ts`

**Interfaces:**
- Consumes: Task 2 (`NewOrder`, `Order`, `PriceTick`, `Side`, `OrderType`, `OrderStatus`), `@nktkas/hyperliquid`, `viem`.
- Produces:
  - `midToTick(symbol: string, mid: string, timestamp: number): PriceTick`
  - `bookToTick(symbol: string, levels: { bids: [string, string][]; asks: [string, string][] }, timestamp: number): PriceTick`
  - `resultToOrder(n: NewOrder, status: string, oid: string | number, totFilled?: string, avgPx?: string): Order`
  - `class LiveExchange implements ExchangeAdapter` — SDK'dan gelen veriyi yukarıdaki fonksiyonlarla kendi tiplerine çevirir.

> Bu yaklaşım SDK'ya bağımlı tüm saf dönüşüm mantığını ağdan/anahtardan bağımsız test edilebilir kılar; canlı bağlantı Phase 2 entegrasyonunda manuel key ile doğrulanır.

- [ ] **Step 1: Failing test yaz**

`packages/engine/tests/hyperliquid-mapping.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { midToTick, bookToTick, resultToOrder } from "../src/exchange/hyperliquid-mapping.js";
import { Side, OrderStatus } from "@huper/core";

describe("hyperliquid mapping", () => {
  it("midToTick maps string mid to bid/ask/mid", () => {
    const t = midToTick("ETH", "3000.5", 123);
    expect(t.mid).toBe(3000.5);
    expect(t.bid).toBe(3000.5);
    expect(t.ask).toBe(3000.5);
  });

  it("bookToTick computes spread from top levels", () => {
    const t = bookToTick(
      "ETH",
      { bids: [["2999", "1"]], asks: [["3001", "1"]] },
      1,
    );
    expect(t.bid).toBe(2999);
    expect(t.ask).toBe(3001);
    expect(t.mid).toBe(3000);
  });

  it("resultToOrder maps a filled result", () => {
    const o = resultToOrder(
      { symbol: "ETH", side: Side.Sell, price: 3000, size: 1 },
      "filled",
      42,
      "1",
      "3000",
    );
    expect(o.status).toBe(OrderStatus.Filled);
    expect(o.filledSize).toBe(1);
    expect(o.id).toBe("42");
  });

  it("resultToOrder maps a resting result to open", () => {
    const o = resultToOrder(
      { symbol: "ETH", side: Side.Buy, price: 2900, size: 1 },
      "resting",
      7,
    );
    expect(o.status).toBe(OrderStatus.Open);
    expect(o.filledSize).toBe(0);
    expect(o.avgFillPrice).toBeNull();
  });
});
```

- [ ] **Step 2: Testi çalıştır (fail)**

Run: `npm run test -w @huper/engine`
Expected: FAIL — `hyperliquid-mapping.js` bulunamaz

- [ ] **Step 3: hyperliquid-mapping.ts yaz**

`packages/engine/src/exchange/hyperliquid-mapping.ts`:
```ts
import {
  Side,
  OrderType,
  OrderStatus,
  type NewOrder,
  type Order,
  type PriceTick,
} from "@huper/core";

export function midToTick(symbol: string, mid: string, timestamp: number): PriceTick {
  const m = parseFloat(mid);
  return { symbol, bid: m, ask: m, mid: m, timestamp };
}

export interface BookLevels {
  bids: [string, string][];
  asks: [string, string][];
}

export function bookToTick(symbol: string, levels: BookLevels, timestamp: number): PriceTick {
  const bid = parseFloat(levels.bids[0]?.[0] ?? "0");
  const ask = parseFloat(levels.asks[0]?.[0] ?? "0");
  return { symbol, bid, ask, mid: (bid + ask) / 2, timestamp };
}

export function resultToOrder(
  n: NewOrder,
  status: string,
  oid: string | number,
  totFilled?: string,
  avgPx?: string,
): Order {
  const filled = status === "filled";
  return {
    id: String(oid),
    symbol: n.symbol,
    side: n.side,
    type: n.type ?? OrderType.Limit,
    price: n.price,
    size: n.size,
    status: filled ? OrderStatus.Filled : OrderStatus.Open,
    filledSize: totFilled ? parseFloat(totFilled) : 0,
    avgFillPrice: avgPx ? parseFloat(avgPx) : null,
    createdAt: Date.now(),
  };
}
```

- [ ] **Step 4: Testi çalıştır (geçmeli)**

Run: `npm run test -w @huper/engine`
Expected: PASS (4 it)

- [ ] **Step 5: live.ts yaz**

`packages/engine/src/exchange/live.ts`:
```ts
import {
  ExchangeClient,
  HttpTransport,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import {
  Side,
  OrderType,
  type ExchangeAdapter,
  type NewOrder,
  type Order,
  type PriceTick,
  type OrderBook,
  type Position,
  type Wallet,
} from "@huper/core";
import { midToTick, bookToTick, resultToOrder } from "./hyperliquid-mapping.js";

export interface LiveOptions {
  privateKey: string;
  rpcUrl: string;
  wsUrl: string;
}

export class LiveExchange implements ExchangeAdapter {
  readonly mode = "live" as const;

  private exchange!: ExchangeClient;
  private subs!: SubscriptionClient;
  private wallet: ReturnType<typeof privateKeyToAccount>;
  private ticks = new Map<string, PriceTick>();
  private tickCbs = new Set<(t: PriceTick) => void>();
  private fillCbs = new Set<(o: Order) => void>();
  private books = new Map<string, OrderBook>();

  constructor(private opts: LiveOptions) {
    this.wallet = privateKeyToAccount(opts.privateKey as `0x${string}`);
  }

  async connect(): Promise<void> {
    this.exchange = new ExchangeClient({
      transport: new HttpTransport({ url: this.opts.rpcUrl }),
      wallet: this.wallet,
    });

    this.subs = new SubscriptionClient({
      transport: new WebSocketTransport(this.opts.wsUrl),
    });

    await this.subs.allMids((data) => {
      for (const [coin, mid] of Object.entries(data.mids)) {
        this.pushTick(midToTick(coin, mid, Date.now()));
      }
    });
  }

  async disconnect(): Promise<void> {
    await this.subs?.disconnect();
  }

  async tick(symbol: string): Promise<PriceTick | undefined> {
    return this.ticks.get(symbol);
  }

  async orderbook(symbol: string): Promise<OrderBook | undefined> {
    return this.books.get(symbol);
  }

  async balances(): Promise<Wallet[]> {
    const state = await this.exchange.info.userState({ user: this.wallet.address });
    const margin = state.marginSummary;
    return [{ asset: "USDC", available: Number(margin.accountValue), total: Number(margin.accountValue) }];
  }

  async openPositions(): Promise<Position[]> {
    const state = await this.exchange.info.userState({ user: this.wallet.address });
    return state.assetPositions.map((ap) => {
      const p = ap.position;
      const size = Number(p.szi);
      return {
        symbol: p.coin,
        side: size >= 0 ? Side.Buy : Side.Sell,
        size: Math.abs(size),
        avgEntry: Number(p.entryPx),
        markPrice: Number(p.markPx),
      };
    });
  }

  async placeOrder(n: NewOrder): Promise<Order> {
    const order = {
      a: 0,
      b: n.side === Side.Buy,
      p: n.type === OrderType.Market ? "" : (n.price ?? 0).toFixed(2),
      s: String(n.size),
      r: !!n.reduceOnly,
      t: { limit: { tif: "Gtc" as const } },
    };
    const res = await this.exchange.order({ orders: [order], grouping: "na" });
    const status = res.response.data.statuses?.[0] as
      | { resting: { oid: number } }
      | { filled: { oid: number; totFilled: string; avgPx: string } }
      | { error: string }
      | undefined;

    if (!status) throw new Error("hyperliquid: empty order statuses");
    if ("error" in status) throw new Error(`hyperliquid order error: ${status.error}`);

    if ("resting" in status) {
      const o = resultToOrder(n, "resting", status.resting.oid);
      this.ordersPending.set(o.id, o);
      return o;
    }
    const f = status.filled;
    return resultToOrder(n, "filled", f.oid, f.totFilled, f.avgPx);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    const o = this.ordersPending.get(orderId);
    if (!o) return false;
    await this.exchange.cancel({ cancels: [{ oid: Number(orderId) }] });
    this.ordersPending.delete(orderId);
    return true;
  }

  onTick(cb: (t: PriceTick) => void): () => void {
    this.tickCbs.add(cb);
    return () => this.tickCbs.delete(cb);
  }

  onFill(cb: (o: Order) => void): () => void {
    this.fillCbs.add(cb);
    return () => this.fillCbs.delete(cb);
  }

  async subscribeBook(symbol: string): Promise<void> {
    await this.subs.l2Book({ coin: symbol }, (data) => {
      const t = bookToTick(symbol, {
        bids: data.levelBid as [string, string][],
        asks: data.levelAsk as [string, string][],
      }, Date.now());
      this.books.set(symbol, { symbol, bids: t.bid ? [[t.bid, 0]] : [], asks: t.ask ? [[t.ask, 0]] : [], timestamp: t.timestamp });
      this.pushTick(t);
    });
  }

  private ordersPending = new Map<string, Order>();

  private pushTick(t: PriceTick): void {
    this.ticks.set(t.symbol, t);
    for (const cb of this.tickCbs) cb(t);
  }
}
```

> Not: `data.mids` (allMids) tipi `Record<string, string>` değilse `Object.entries` kullanmadan önce plan uygulayıcısı SDK tipini kontrol edip gerekirse cast etsin (SDK `mids` alanına sahiptir). `exchange.info.userState` SDK InfoClient üzerinden erişilir; `ExchangeClient.info` alanı varsa kullan, yoksa `new InfoClient(...)` oluşturup `userState` çağır.

- [ ] **Step 6: index.ts'te dışa aktar**

`packages/engine/src/index.ts`:
```ts
export * from "./exchange/paper.js";
export * from "./exchange/live.js";
export * from "./exchange/hyperliquid-mapping.js";
```

- [ ] **Step 7: typecheck**

Run: `npm run typecheck -w @huper/engine`
Expected: 0 hata (SDK tip adlarına göre gerekli minik uyarlamalar yapılabilir)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(engine): add LiveExchange Hyperliquid adapter and pure mapping helpers"
```

---

## Task 6: Engine Bootstrap — HTTP/WS Köprüsü (localhost)

**Files:**
- Create: `packages/engine/src/server.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/tests/server.test.ts`

**Interfaces:**
- Consumes: Task 4 (`PaperExchange`), Task 3 (`loadConfig`, `createLogger`), `fastify`.
- Produces:
  - `buildApp(opts: { exchange: ExchangeAdapter }): FastifyInstance` — REST rotaları:
    - `GET /health` → `{ ok: true }`
    - `GET /ticks/:symbol` → `{ tick: PriceTick | null }`
    - `POST /orders` (body `NewOrder`) → `Order` (201) / `{ error }` (400)
    - `GET /balances` → `Wallet[]`
    - `GET /positions` → `Position[]`
  - `main()` entry: config yükle → mode'a göre exchange kur → `connect()` → `buildApp` → `0.0.0.0:PORT` dinle; `SIGINT`/`SIGTERM`'de temiz kapan.

- [ ] **Step 1: Failing test yaz**

`packages/engine/tests/server.test.ts`:
```ts
import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { PaperExchange } from "../src/exchange/paper.js";

describe("server", () => {
  const ex = new PaperExchange({ initialBalance: 1000 });
  ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });
  const app = buildApp({ exchange: ex });

  afterAll(async () => { await app.close(); });

  it("health returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("place order via HTTP", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { symbol: "BTC", side: "buy", price: null, size: 0.1 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("filled");
  });

  it("returns positions", async () => {
    const res = await app.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
```

- [ ] **Step 2: Testi çalıştır (fail)**

Run: `npm run test -w @huper/engine`
Expected: FAIL — `buildApp` bulunamaz

- [ ] **Step 3: server.ts yaz**

`packages/engine/src/server.ts`:
```ts
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
```

- [ ] **Step 4: index.ts bootstrap**

`packages/engine/src/index.ts`:
```ts
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
```

- [ ] **Step 5: test + typecheck**

Run: `npm run test -w @huper/engine`
Run: `npm run typecheck -w @huper/engine`
Expected: PASS (3 it) + 0 hata

- [ ] **Step 6: Lokal canlı doğrulama (paper)**

Run: `npm run dev -w @huper/engine` (yeni terminalde)
Beklenen: `engine listening` logu.
Başka terminalde:
```powershell
Invoke-RestMethod http://localhost:3001/health
```
Sonuç: `ok: True`. `Ctrl+C` ile durdur (SIGINT → temiz kapanma).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(engine): bootstrap server with HTTP bridge (paper/live)"
```

---

## Task 7: Docker & Taşınabilirlik (VPS Hazırlık)

**Files:**
- Create: `packages/engine/Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Modify: `README.md`

**Interfaces:**
- Produces: `docker compose build engine` Docker kurulu ortamda geçerli imaj üretir; `engine` servisi `HUPER_MODE` env'ine göre paper/live başlar. Docker bu makinede kurulu olmadığından build zorunlu doğrulama değildir; lokal doğrulama Task 6'dadır.

- [ ] **Step 1: engine Dockerfile yaz**

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/engine/package.json packages/engine/
RUN npm install --workspaces

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build -w @huper/core && npm run build -w @huper/engine

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
EXPOSE 3001
CMD ["node", "packages/engine/dist/index.js"]
```

- [ ] **Step 2: docker-compose.yml yaz**

```yaml
services:
  engine:
    build: .
    env_file: .env
    ports:
      - "3001:3001"
    environment:
      HUPER_MODE: ${HUPER_MODE:-paper}
```

- [ ] **Step 3: .dockerignore yaz**

```gitignore
node_modules
dist
.git
.env
```

- [ ] **Step 4: README.md yaz**

```markdown
# HUPER — Hyperliquid Bot Platform

Tek kullanıcılı Hyperliquid perp trading bot platformu. `paper` (simülasyon) ve `live` (gerçek emir) modlarını destekler.

## Geliştirme (lokal)

    npm install
    npm run dev -w @huper/engine   # paper mod, http://localhost:3001
    npm run typecheck
    npm test

Canlı mod: `.env` içine `HUPER_MODE=live` ve `HUPER_HYPERLIQUID_PRIVATE_KEY=0x...` koy.

## Docker (VPS)

    docker compose up --build engine
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: docker compose and engine Dockerfile for VPS portability"
```

---

## Self-Review (uygulayıcı öncesi)

**Spec kapsamı (Faz 0-1):**
- Monorepo iskeleti → Task 1
- Ortak domain tipleri → Task 2
- Config + logger → Task 3
- Paper adaptör (simüle dolum) → Task 4
- Live adaptör (Hyperliquid SDK, saf eşleme fonksiyonları) → Task 5
- Engine bootstrap + HTTP köprüsü → Task 6
- Docker taşınabilirlik + lokal çalıştırma → Task 7

**Kapsam dışı (ayrı planlarla):**
- Bot çerçevesi, strateji kütüphanesi (8 bot), risk filtreleri, SQLite durum deposu, acil durdurma → **Phase 2 planı**
- Web paneli (Next.js), canlı grafikler, WebSocket push → **Phase 3-4 planı**
- Uçtan uca entegrasyon testi + canlı kurulum rehberi → **Phase 5 planı**

Her yeni plan, bu planda üretilen `ExchangeAdapter`, `NewOrder`, `Order`, `PriceTick` sözleşmelerini import eder.
