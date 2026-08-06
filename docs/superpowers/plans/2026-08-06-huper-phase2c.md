# Phase 2c Implementation Plan: Web Panel (Static SPA)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a browser dashboard from the engine's Fastify server that lets the user manage bots (create/start/stop/delete), view balances/positions/ticker prices, and see a canvas equity chart fed by periodic equity snapshots persisted to SQLite.

**Architecture:** Extend the existing Fastify `server.ts` with `@fastify/static` (serving `packages/engine/public/` at `/`) and a `GET /equity` endpoint. Add an equity recorder: `Engine.recordEquity()` writes a `botId: null` row every 5s (interval owned by `main.ts`), and `Store.listEquity(botId?, limit?)` reads it back. The panel is a vanilla JS single-page app (no build step) that polls the existing + new endpoints every 2s.

**Tech Stack:** TypeScript (strict, ESM), Fastify 5, `@fastify/static`, better-sqlite3, vanilla HTML/CSS/JS (no framework). One new runtime dependency: `@fastify/static`.

## Global Constraints

- Strict TS, Node ESM (`"type": "module"`); relative imports use explicit `.js` extensions. `npm run typecheck` (root) 0 errors.
- New dependency ONLY: `@fastify/static` (runtime dep) in `@huper/engine`. No other deps.
- `public/` MUST live at `packages/engine/public/` (sibling of `src/`, NOT inside `src/`) so both `tsx` (dev) and compiled `dist/` resolve `../public` correctly at runtime.
- `@fastify/static` must be registered AFTER all API routes in `buildApp` so exact API routes win over the static catch-all.
- `server.ts` `buildApp(opts)` signature stays `{ exchange, engine }` — equity is exposed via `Engine.listEquity(limit?)` delegation, not by adding `store` to the opts.
- Equity rows are global: `bot_id = NULL` (one per snapshot). No per-bot equity this phase.
- Interval cadence: 5000ms for `recordEquity`; panel polling 2000ms. The 5s interval comfortably exceeds the 1s `refreshMeta` debounce.
- No auth, no WS push, no new strategies.

## Source of truth

- Spec: `docs/superpowers/specs/2026-08-06-huper-phase2c-design.md`
- Phase 2b plan for conventions: `docs/superpowers/plans/2026-08-06-huper-phase2b.md`

---

### Task 1: Store — `EquityRow` type + `listEquity` reader

**Files:**
- Modify: `packages/engine/src/store/types.ts` — add `EquityRow`
- Modify: `packages/engine/src/store/store.ts` — add `listEquity(botId?, limit?)`
- Test: `packages/engine/tests/store.test.ts`

**Interfaces (produced):**
- `export interface EquityRow { id: string; bot_id: string | null; ts: number; value: number }` (types.ts)
- `Store.listEquity(botId?: string, limit?: number): EquityRow[]` — `botId === undefined` returns only `bot_id IS NULL` rows (global); a string returns only that bot's rows. Rows returned newest-first is NOT required — return them OLDEST-first (ascending `ts`) because the chart plots left-to-right. `limit` caps the count (most recent `limit` kept).

- [x] **Step 1: Write the failing test**

Append to `packages/engine/tests/store.test.ts` (inside the existing `describe("Store", ...)`):

```ts
it("listEquity filters global rows and applies limit oldest-first", () => {
  store.appendEquity({ id: "e1", botId: null, ts: 100, value: 100 });
  store.appendEquity({ id: "e2", botId: null, ts: 200, value: 200 });
  store.appendEquity({ id: "e3", botId: "b9", ts: 150, value: 999 });

  const global = store.listEquity();
  expect(global.filter((r) => r.id === "e1").length).toBe(1);
  expect(global.filter((r) => r.id === "e2").length).toBe(1);
  expect(global.filter((r) => r.id === "e3").length).toBe(0); // bot-owned rows excluded from global

  const top = store.listEquity(undefined, 2);
  expect(top.length).toBeLessThanOrEqual(2);
  expect(top[top.length - 1].id).toBe("e2"); // most recent kept, oldest-first order

  const botRows = store.listEquity("b9");
  expect(botRows.map((r) => r.id)).toEqual(["e3"]);
});
```

Use the content-based assertions above (not exact whole-list equality): the file's shared in-memory DB accumulates rows from earlier `it` blocks, so whole-list equality would be brittle.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -w @huper/engine -- store.test.ts`
Expected: FAIL — `listEquity` does not exist (TypeError / property undefined).

- [x] **Step 3: Implement `EquityRow` + `listEquity`**

`packages/engine/src/store/types.ts` — append:

```ts
export interface EquityRow {
  id: string; bot_id: string | null; ts: number; value: number;
}
```

`packages/engine/src/store/store.ts` — append a method (the `equity` table has `(id, bot_id, ts, value)`):

```ts
listEquity(botId?: string, limit?: number): EquityRow[] {
  const where = botId === undefined ? "bot_id IS NULL" : "bot_id = ?";
  const params: (string | number)[] = botId === undefined ? [] : [botId];
  const sql = `SELECT * FROM equity WHERE ${where} ORDER BY ts DESC${limit != null ? " LIMIT ?" : ""}`;
  const rows = (limit != null
    ? this.db.prepare(sql).all(...params, limit)
    : this.db.prepare(sql).all(...params)) as EquityRow[];
  return rows.reverse(); // oldest-first for charting
}
```

Import `EquityRow` into `store.ts` (extend the existing `import type { BotRow, RunRow, PersistedOrder, PersistedPosition } from "./types.js"` line).

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -w @huper/engine`
Expected: all pass, including the new `listEquity` tests.

- [x] **Step 5: Commit**

```bash
git add packages/engine/src/store/types.ts packages/engine/src/store/store.ts packages/engine/tests/store.test.ts
git commit -m "feat(store): listEquity reader with global filter and limit"
```

---

### Task 2: Engine — `recordEquity` + `listEquity` delegation

**Files:**
- Modify: `packages/engine/src/framework/engine.ts`
- Test: `packages/engine/tests/engine.test.ts`

**Interfaces:**
- Consumes: `Store.listEquity(undefined, limit)`, `Store.appendEquity`, `EquityRow` (Task 1).
- Produces:
  - `Engine.recordEquity(): Promise<void>` — reads `exchange.balances()`, appends a global equity row `{ botId: null, value: balances[0].total }`.
  - `Engine.listEquity(limit?: number): EquityRow[]` — delegates to `store.listEquity(undefined, limit)`.

- [x] **Step 1: Write the failing test**

Append to `packages/engine/tests/engine.test.ts` a fresh, isolated test (do NOT reuse the module-scope shared `engine`/`store`):

```ts
it("records global equity snapshots and exposes them via listEquity", async () => {
  const ex = new PaperExchange({ initialBalance: 7777 });
  const st = new Store(openStore(":memory:"));
  const reg = new StrategyRegistry();
  const e = new Engine({ exchange: ex, store: st, risk: new RiskManager(DEFAULT_RISK), registry: reg, log: { info: () => {}, error: () => {}, warn: () => {} } });

  await e.recordEquity();
  await e.recordEquity();

  const rows = e.listEquity();
  expect(rows).toHaveLength(2);
  expect(rows[0].value).toBe(7777);
  expect(rows.every((r) => r.bot_id === null)).toBe(true);

  // limit keeps the most recent
  expect(e.listEquity(1)).toHaveLength(1);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -w @huper/engine -- engine.test.ts`
Expected: FAIL — `recordEquity` does not exist.

- [x] **Step 3: Implement in `engine.ts`**

Add `EquityRow` to the existing `import type { ... } from "../store/types.js"` line. Add two methods near the other public methods (e.g. after `balance()` / `orderIdsFor`):

```ts
async recordEquity(): Promise<void> {
  const b = await this.exchange.balances();
  if (b.length > 0) {
    this.store.appendEquity({ id: randomUUID(), botId: null, ts: Date.now(), value: b[0].total });
  }
}

listEquity(limit?: number): EquityRow[] {
  return this.store.listEquity(undefined, limit);
}
```

`randomUUID` is already imported from `node:crypto` in engine.ts.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -w @huper/engine`
Expected: all pass.

- [x] **Step 5: Commit**

```bash
git add packages/engine/src/framework/engine.ts packages/engine/tests/engine.test.ts
git commit -m "feat(engine): recordEquity snapshots and listEquity delegation"
```

---

### Task 3: `main.ts` — equity recording interval + cleanup

**Files:**
- Modify: `packages/engine/src/main.ts`

**Interfaces:**
- Consumes: `Engine.recordEquity()` (Task 2).
- Produces: a 5s `setInterval` in `main()` that records equity, and `clearInterval` on shutdown.

- [x] **Step 1: Add the interval and cleanup**

In `packages/engine/src/main.ts`:
- After `await engine.start();` and before the feed block, add:

```ts
const EQUITY_INTERVAL_MS = 5000;
const equityTimer = setInterval(() => {
  void engine.recordEquity().catch((e) => log.warn({ err: (e as Error).message }, "equity record failed"));
}, EQUITY_INTERVAL_MS);
```

- In the `stop` closure, add `clearInterval(equityTimer);` as the first line.

The complete `stop` becomes:

```ts
const stop = async () => {
  clearInterval(equityTimer);
  await engine.stop();
  if (feed) await feed.disconnect();
  await exchange.disconnect();
  await app.close();
  process.exit(0);
};
```

- [x] **Step 2: Verify typecheck + suite**

Run: `npm run typecheck`
Expected: 0 errors.

Run: `npm test -w @huper/engine`
Expected: all pass (no behavior change to tests).

- [x] **Step 3: Commit**

```bash
git add packages/engine/src/main.ts
git commit -m "feat(engine): periodic equity snapshot recording in main"
```

---

### Task 4: server — static serving + `/equity` endpoint

**Files:**
- Modify: `packages/engine/src/server.ts`
- Modify: `packages/engine/package.json` (add `@fastify/static` dep)
- Create: `packages/engine/public/index.html` (minimal placeholder — real panel is Task 5)
- Create: `packages/engine/public/app.js` (empty file — filled in Task 5)
- Create: `packages/engine/public/style.css` (empty file — filled in Task 5)
- Test: `packages/engine/tests/server.test.ts`

**Interfaces:**
- Consumes: `Engine.listEquity(limit?)` (Task 2).
- Produces: `GET /equity?limit=N` → array of `EquityRow` (oldest-first); `GET /` → `public/index.html`; `GET /app.js`, `GET /style.css` served.

- [x] **Step 1: Install the dependency**

```bash
npm i @fastify/static -w @huper/engine
```

Verify it lands in `packages/engine/package.json` `dependencies` (NOT devDependencies).

- [x] **Step 2: Create the placeholder static files**

`packages/engine/public/index.html`:
```html
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>HUPER</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>HUPER</h1>
  <div id="app"></div>
  <script src="/app.js"></script>
</body>
</html>
```

`packages/engine/public/app.js` and `packages/engine/public/style.css`: create as empty files (0 bytes is fine).

- [x] **Step 3: Write the failing server tests**

Append to `packages/engine/tests/server.test.ts` (inside the existing `describe("server", ...)` block):

```ts
it("serves the panel index at /", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toMatch(/text\/html/);
  expect(res.body).toContain("HUPER");
});

it("serves static assets", async () => {
  const res = await app.inject({ method: "GET", url: "/app.js" });
  expect(res.statusCode).toBe(200);
});

it("returns global equity series via /equity", async () => {
  await engine.recordEquity();
  const res = await app.inject({ method: "GET", url: "/equity?limit=5" });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { id: string; bot_id: string | null; ts: number; value: number }[];
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBeGreaterThanOrEqual(1);
  expect(body.every((r) => r.bot_id === null)).toBe(true);
});
```

- [x] **Step 4: Run tests to verify they fail**

Run: `npm test -w @huper/engine -- server.test.ts`
Expected: the three new tests fail (404s / no `/equity` route).

- [x] **Step 5: Implement in `server.ts`**

At the top add imports:

```ts
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
```

Register static AFTER all route definitions (last, before `return app;`):

```ts
void app.register(fastifyStatic, {
  root: fileURLToPath(new URL("../public", import.meta.url)),
  prefix: "/",
});
```

Add the `/equity` route (anywhere among the routes; static registration stays last):

```ts
app.get<{ Querystring: { limit?: string } }>("/equity", async (req) => {
  const raw = req.query.limit != null ? Number(req.query.limit) : 200;
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(1000, raw)) : 200;
  return opts.engine.listEquity(limit);
});
```

- [x] **Step 6: Run tests to verify they pass**

Run: `npm test -w @huper/engine`
Expected: all pass, including the three new server tests. Existing API routes (`/bots`, `/orders`, `/positions`, `/health`) still pass (no static shadowing).

- [x] **Step 7: Commit**

```bash
git add packages/engine/src/server.ts packages/engine/package.json packages/engine/public
git commit -m "feat(server): serve static panel and add /equity endpoint"
```

---

### Task 5: Panel UI (public/index.html + app.js + style.css)

**Files:**
- Modify: `packages/engine/public/index.html`
- Create: `packages/engine/public/app.js`
- Create: `packages/engine/public/style.css`
- Test: `packages/engine/tests/server.test.ts` (extend the `GET /` assertion)

**Interfaces:**
- Consumes (HTTP): `GET /balances` → `[{ asset, available, total }]`; `GET /positions` → `[{ symbol, side, size, avgEntry, markPrice? }]`; `GET /bots` → `[BotSummary]`; `GET /bots/:id` → `{ ...summary, orders[], positions[], runs[] }`; `GET /equity?limit=200` → `EquityRow[]`; `GET /ticks/:symbol` → `{ tick: PriceTick | null }`.
- BotSummary fields: `{ id, name, strategy, symbol, status, params, state, createdAt, updatedAt }`.
- Produces: the full dashboard UI.

- [x] **Step 1: Write `index.html`**

Single page, three tabs. Replace the Task 4 placeholder (keep `<title>HUPER</title>` and the `/style.css` / `/app.js` links):

```html
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>HUPER — Bot Engine</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>HUPER</h1>
    <span id="mode" class="badge">…</span>
  </header>

  <nav class="tabs">
    <button data-tab="overview" class="active">Genel Bakış</button>
    <button data-tab="bots">Botlar</button>
  </nav>

  <section id="overview" class="view">
    <div class="cards">
      <div class="card"><h3>Bakiye</h3><p id="balance">—</p></div>
      <div class="card"><h3>Son Equity</h3><p id="equity-last">—</p></div>
    </div>
    <div class="card wide">
      <h3>Equity</h3>
      <canvas id="equity-chart" height="200"></canvas>
    </div>
    <div class="card wide">
      <h3>Pozisyonlar</h3>
      <table id="positions">
        <thead><tr><th>Sembol</th><th>Taraf</th><th>Boyut</th><th>Ort. Giriş</th><th>Fiyat</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="card wide">
      <h3>Fiyatlar</h3>
      <table id="prices">
        <thead><tr><th>Sembol</th><th>Bid</th><th>Ask</th><th>Mid</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section id="bots" class="view hidden">
    <div class="card wide">
      <h3>Yeni Bot</h3>
      <form id="new-bot">
        <input name="name" placeholder="İsim" required>
        <input name="symbol" placeholder="Sembol (BTC)" required>
        <select name="strategy" id="strategy-select">
          <option value="grid">grid</option>
          <option value="dca">dca</option>
          <option value="trend">trend</option>
        </select>
        <div id="params"></div>
        <button type="submit">Oluştur</button>
      </form>
      <p id="form-error" class="error hidden"></p>
    </div>
    <div class="card wide">
      <h3>Botlar</h3>
      <table id="bots">
        <thead><tr><th>Ad</th><th>Strateji</th><th>Sembol</th><th>Durum</th><th>İşlemler</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section id="detail" class="view hidden">
    <button id="back">← Geri</button>
    <h2 id="detail-name">—</h2>
    <div class="card wide"><h3>Emirler</h3><table id="detail-orders"></table></div>
    <div class="card wide"><h3>Pozisyonlar</h3><table id="detail-positions"></table></div>
    <div class="card wide"><h3>Çalıştırmalar</h3><table id="detail-runs"></table></div>
  </section>

  <div id="toast" class="toast hidden"></div>
  <script src="/app.js"></script>
</body>
</html>
```

- [x] **Step 2: Write `style.css`**

Dark theme. Status colors: running → `#2ecc71`, stopped → `#95a5a6`, error → `#e74c3c`. Tabs, cards, tables, forms, toast, hidden class. Keep it simple (no external fonts):

```css
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: #121417; color: #e6e6e6; }
header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: #1b1e24; border-bottom: 1px solid #2a2e35; }
header h1 { margin: 0; font-size: 20px; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #2a2e35; }
.tabs { display: flex; gap: 8px; padding: 12px 20px; }
.tabs button { background: #1b1e24; color: #e6e6e6; border: 1px solid #2a2e35; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
.tabs button.active { background: #2ecc71; color: #0a0c0e; border-color: #2ecc71; }
.view { padding: 0 20px 40px; }
.hidden { display: none !important; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px; }
.card { background: #1b1e24; border: 1px solid #2a2e35; border-radius: 8px; padding: 16px; }
.card.wide { margin-bottom: 12px; }
.card h3 { margin: 0 0 12px; font-size: 14px; color: #9aa0a6; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #262a30; }
th { color: #9aa0a6; font-weight: 500; }
.status-running { color: #2ecc71; }
.status-stopped { color: #95a5a6; }
.status-error { color: #e74c3c; }
button { cursor: pointer; background: #2a2e35; color: #e6e6e6; border: 1px solid #3a3f47; border-radius: 6px; padding: 6px 12px; }
button:hover { background: #343943; }
button.danger:hover { background: #e74c3c; }
input, select { background: #121417; color: #e6e6e6; border: 1px solid #2a2e35; border-radius: 6px; padding: 6px 8px; margin-right: 8px; }
#params label { margin-right: 12px; font-size: 12px; }
#params input { width: 80px; }
.error { color: #e74c3c; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #e74c3c; color: #fff; padding: 10px 18px; border-radius: 6px; z-index: 10; }
canvas { width: 100%; background: #121417; border: 1px solid #2a2e35; border-radius: 6px; }
```

- [x] **Step 3: Write `app.js`**

Vanilla JS. Structure (all code, no placeholders):

```js
const $ = (sel) => document.querySelector(sel);
const paramsDefs = {
  grid: { levels: "number", spacingPct: "number", orderSize: "number" },
  dca: { stepPct: "number", takeProfitPct: "number", totalSteps: "number", baseSize: "number", sizeMultiplier: "number" },
  trend: { fastEma: "number", slowEma: "number", orderSize: "number", rsiPeriod: "number", oversold: "number", overbought: "number", stopLossPct: "number", takeProfitPct: "number" },
};
const STATUS_CLASS = { running: "status-running", stopped: "status-stopped", error: "status-error" };

let detailId = null;

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); setTimeout(() => t.classList.add("hidden"), 3000); }

// Tabs
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $(`#${btn.dataset.tab}`).classList.remove("hidden");
    detailId = null;
    poll();
  });
});

// Dynamic params form
function renderParams() {
  const strat = $("#strategy-select").value;
  $("#params").innerHTML = Object.keys(paramsDefs[strat])
    .map((k) => `<label>${k}<input name="params.${k}" type="number" step="any"></label>`)
    .join("");
}
$("#strategy-select").addEventListener("change", renderParams);
renderParams();

$("#new-bot").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const params = {};
  Object.keys(paramsDefs[$("#strategy-select").value]).forEach((k) => {
    const v = fd.get(`params.${k}`);
    if (v !== null && v !== "") params[k] = Number(v);
  });
  const body = { name: fd.get("name"), strategy: fd.get("strategy"), symbol: fd.get("symbol").toUpperCase(), params };
  try {
    const res = await fetch("/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || res.statusText); }
    ev.target.reset();
    toast("Bot oluşturuldu");
    poll();
  } catch (e) { toast(e.message); }
});

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function action(id, verb) {
  try { await api(`/bots/${id}/${verb}`, { method: "POST" }); poll(); }
  catch (e) { toast(e.message); }
}

async function del(id) {
  try { await api(`/bots/${id}`, { method: "DELETE" }); poll(); }
  catch (e) { toast(e.message); }
}

// Equity chart (canvas line)
function drawEquity(rows) {
  const canvas = $("#equity-chart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (rows.length < 2) { ctx.fillStyle = "#9aa0a6"; ctx.font = "13px sans-serif"; ctx.fillText("Yeterli veri yok", 8, 20); return; }
  const w = canvas.width, h = canvas.height;
  const xs = rows.map((r) => r.ts), ys = rows.map((r) => r.value);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  ctx.strokeStyle = "#2ecc71"; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < rows.length; i++) {
    const px = 8 + ((xs[i] - xs[0]) / (xs[xs.length - 1] - xs[0])) * (w - 16);
    const py = h - 8 - ((ys[i] - min) / span) * (h - 16);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.stroke();
  $("#equity-last").textContent = `$${ys[ys.length - 1].toFixed(2)}`;
}

function setTable(id, rows, columns, cell) {
  const tbody = document.querySelector(`#${id} tbody`);
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    columns.forEach((c, i) => { const td = document.createElement("td"); td.innerHTML = cell(row, c, i); tr.appendChild(td); });
    tbody.appendChild(tr);
  }
}

async function poll() {
  try {
    const [balances, positions, bots, equity] = await Promise.all([
      api("/balances"), api("/positions"), api("/bots"), api("/equity?limit=200"),
    ]);
    $("#mode").textContent = balances[0]?.asset || "—";
    $("#balance").textContent = `$${Number(balances[0]?.total ?? 0).toFixed(2)}`;
    drawEquity(equity);

    setTable("positions", positions, ["symbol", "side", "size", "avgEntry", "markPrice"],
      (r, c) => (r[c] ?? "—"));

    // Prices: unique symbols from bots + positions
    const syms = [...new Set([...positions.map((p) => p.symbol), ...bots.map((b) => b.symbol)])];
    const ticks = await Promise.all(syms.map((s) => api(`/ticks/${s}`)));
    setTable("prices", syms.map((s, i) => ({ symbol: s, tick: ticks[i].tick })), ["symbol", "bid", "ask", "mid"],
      (r, c) => c === "symbol" ? r.symbol : (r.tick ? Number(r.tick[c]).toFixed(2) : "—"));

    setTable("bots", bots, ["name", "strategy", "symbol", "status", "actions"],
      (r, c) => {
        if (c === "status") return `<span class="${STATUS_CLASS[r.status]}">${r.status}</span>`;
        if (c === "actions") {
          const stop = r.status === "running" ? `<button data-act="stop" data-id="${r.id}">Durdur</button>` : `<button data-act="start" data-id="${r.id}">Başlat</button>`;
          return `${stop} <button data-act="detail" data-id="${r.id}">Detay</button> <button data-act="del" data-id="${r.id}" class="danger">Sil</button>`;
        }
        return r[c] ?? "—";
      });

    // Delegated action buttons (event delegation)
    document.querySelectorAll("#bots [data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act, id = btn.dataset.id;
        if (act === "start" || act === "stop") return action(id, act);
        if (act === "del") return del(id);
        if (act === "detail") { detailId = id; await showDetail(id); }
      });
    });

    if (detailId) await showDetail(detailId);
  } catch { /* silent — next poll retries */ }
}

async function showDetail(id) {
  try {
    const d = await api(`/bots/${id}`);
    $("#detail").classList.remove("hidden");
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    $("#detail").classList.remove("hidden");
    $("#detail-name").textContent = `${d.name} (${d.status})`;
    setTable("detail-orders", d.orders || [], ["id", "side", "price", "size", "status", "filled_size"],
      (r, c) => (r[c] ?? "—"));
    setTable("detail-positions", d.positions || [], ["symbol", "side", "size", "avg_entry", "closed_at"],
      (r, c) => (c === "closed_at" ? (r[c] ? new Date(r[c]).toLocaleString() : "açık") : (r[c] ?? "—")));
    setTable("detail-runs", d.runs || [], ["mode", "started_at", "stopped_at", "stop_reason"],
      (r, c) => (c === "started_at" || c === "stopped_at") ? (r[c] ? new Date(r[c]).toLocaleString() : "—") : (r[c] ?? "—"));
  } catch (e) { toast(e.message); }
}

$("#back").addEventListener("click", () => { detailId = null; document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden")); $("#overview").classList.remove("hidden"); poll(); });

poll();
setInterval(poll, 2000);
```

- [x] **Step 4: Extend the server test for the real panel**

In `packages/engine/tests/server.test.ts`, strengthen the `GET /` test to assert the tab structure exists:

```ts
it("serves the panel index at /", async () => {
  const res = await app.inject({ method: "GET", url: "/" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toMatch(/text\/html/);
  expect(res.body).toContain("HUPER");
  expect(res.body).toContain("id=\"overview\"");
  expect(res.body).toContain("id=\"bots\"");
});
```

- [x] **Step 5: Verify**

Run: `npm test -w @huper/engine`
Expected: all pass.

Run: `npm run typecheck`
Expected: 0 errors.

- [x] **Step 6: Commit**

```bash
git add packages/engine/public packages/engine/tests/server.test.ts
git commit -m "feat(web): add HUPER dashboard panel"
```

---

### Finalization

- [x] **Full verification**

```bash
npm run typecheck
npm test
```
Expected: 0 typecheck errors; all core + engine tests pass.

- [x] **Manual smoke test**

1. Kill any stale engine on port 3001 (from the earlier manual run), then:
   ```bash
   $env:PORT="3001"; $env:HUPER_MODE="paper"; npm run dev -w @huper/engine
   ```
2. Open `http://localhost:3001` — the dashboard renders (dark theme).
3. Create a `grid` bot on BTC (levels 4, spacingPct 0.01, orderSize 0.01), start it.
4. Wait ~15s: equity chart has ≥2 points and grows; prices/positions/balance refresh every 2s.
5. Stop the bot; stop/delete it. Confirm status transitions in the UI.
6. Stop the engine (Ctrl+C) — confirm clean shutdown (`clearInterval`).

- [x] **Update SDD progress log** (`.superpowers/sdd/2026-08-06-huper-phase2c/progress.md`) mirroring the Phase 2b ledger format (per-task brief/review/fix records).

## Task Order Rationale

1. **Task 1 (store)** — low-level reader, unblocked, independent.
2. **Task 2 (engine)** — builds on Task 1's `listEquity`; the recorder core.
3. **Task 3 (main)** — trivially wires the interval; no new tests needed (behavior tested in Task 2).
4. **Task 4 (server)** — static serving + `/equity`; needs a `public/` stub, so it creates the placeholder files.
5. **Task 5 (panel)** — the full UI; depends on all endpoints from Tasks 1-4.

Each task is independently testable and reviewable. Run `npm test -w @huper/engine` + `npm run typecheck` after each task and before moving to the next.