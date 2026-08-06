# Phase 3b Implementation Plan: Panel "Adam Etme"

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paneli, varsayılan takip listesi + kullanıcı ekleme/çıkarma (SQLite kalıcılığı), boş-durum UX'i ve tam yeniden tasarımla kullanılabilir hale getirir.

**Architecture:** (1) Yeni `watchlist` tablosu + `Store.getWatchlist`/`setWatchlist` (upsert). (2) Server `GET`/`PUT /watchlist` endpoint'leri. (3) Panel `DEFAULT_WATCHLIST` ile başlar, kullanıcı ekle/çıkar; `poll()` fiyatları `watchlist ∪ (bots ∪ positions)` sembollerinden çeker. (4) `style.css` tam yeniden tasarım + boş-durum satırları.

**Tech Stack:** TypeScript (strict, ESM, `.js` import), vitest, better-sqlite3, Fastify, vanilla JS panel.

## Global Constraints

- Strict TS, ESM, `.js` import extension. `npm run typecheck` 0 hata.
- Koda YORUM eklenmez (plan dokümanları dışında).
- Yeni dependency EKLENMEZ.
- `@huper/core` `types.ts` değişmez.
- Her görev sonunda `npm run typecheck` + `npm test -w @huper/engine` yeşil.
- Doğrulama komutları: `npm run typecheck`, `npm test -w @huper/engine`.
- Dosya adları ve `describe`/`it` blok adları mevcut konvansiyona uyar.
- `escapeHtml` (Phase 3a) korunur; yeni dinamik değerler de escape edilir.

---

### Task 1: Store — `watchlist` tablosu + `getWatchlist`/`setWatchlist`

**Files:**
- Modify: `packages/engine/src/store/db.ts`
- Modify: `packages/engine/src/store/store.ts`
- Test: `packages/engine/tests/store.test.ts`

**Interfaces:**
- Consumes: mevcut `openStore(path)` (db.ts), `Store` sınıfı.
- Produces: `Store.getWatchlist(): string[]` (satır yoksa `[]`), `Store.setWatchlist(symbols: string[]): void` (upsert). Task 2 server bunları kullanır.

- [ ] **Step 1: Write the failing tests**

`packages/engine/tests/store.test.ts` — `describe("Store", ...)` bloğu İÇİNE, son `it`'ten sonra aynı girintide ekle:

```ts
it("getWatchlist returns empty when none saved", () => {
  expect(store.getWatchlist()).toEqual([]);
});

it("setWatchlist persists and getWatchlist reads back", () => {
  store.setWatchlist(["BTC", "ETH", "SOL"]);
  expect(store.getWatchlist()).toEqual(["BTC", "ETH", "SOL"]);
  store.setWatchlist(["XRP"]);
  expect(store.getWatchlist()).toEqual(["XRP"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @huper/engine -- store.test.ts`
Expected: FAIL — `store.getWatchlist is not a function` (2 failed).

- [ ] **Step 3: Implement**

`packages/engine/src/store/db.ts` — `db.exec(...)` bloğuna, `equity` tablosundan SONRA, indexlerden ÖNCE satır ekle:

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  symbols TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`packages/engine/src/store/store.ts` — `listEquity` ile `deleteBot` arasına metotlar:

```ts
getWatchlist(): string[] {
  const row = this.db.prepare(`SELECT symbols FROM watchlist WHERE id = 'default'`).get() as { symbols: string } | undefined;
  if (!row) return [];
  return JSON.parse(row.symbols) as string[];
}

setWatchlist(symbols: string[]): void {
  this.db.prepare(
    `INSERT INTO watchlist (id, symbols, updated_at) VALUES ('default', ?, ?)
     ON CONFLICT(id) DO UPDATE SET symbols = excluded.symbols, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(symbols), Date.now());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @huper/engine -- store.test.ts`
Expected: PASS — mevcut 6 + yeni 2 test.

Run: `npm run typecheck`
Expected: 0 hata.

Run: `npm test -w @huper/engine`
Expected: tüm testler geçer (10 dosya, 61 test).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/store/db.ts packages/engine/src/store/store.ts packages/engine/tests/store.test.ts
git commit -m "feat(store): persist watchlist symbols"
```

---

### Task 2: Server — `GET`/`PUT /watchlist`

**Files:**
- Modify: `packages/engine/src/server.ts`
- Test: `packages/engine/tests/server.test.ts`

**Interfaces:**
- Consumes: `Store.getWatchlist(): string[]`, `Store.setWatchlist(symbols: string[]): void` (Task 1).
- Produces: `GET /watchlist` → `{ symbols: string[] }`; `PUT /watchlist` body `{ symbols: string[] }` → 200 `{ ok: true }`; geçersiz body → 400 `{ error }`. Task 3 panel bunları kullanır.

- [ ] **Step 1: Write the failing tests**

`packages/engine/tests/server.test.ts` — `describe("server", ...)` bloğu İÇİNE, son `it`'ten sonra aynı girintide ekle:

```ts
it("get watchlist returns an array", async () => {
  const res = await app.inject({ method: "GET", url: "/watchlist" });
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.json().symbols)).toBe(true);
});

it("put watchlist persists and get reads back", async () => {
  const put = await app.inject({ method: "PUT", url: "/watchlist", payload: { symbols: ["BTC", "ETH"] } });
  expect(put.statusCode).toBe(200);
  const get = await app.inject({ method: "GET", url: "/watchlist" });
  expect(get.json().symbols).toEqual(["BTC", "ETH"]);
});

it("put watchlist rejects non-array body", async () => {
  const res = await app.inject({ method: "PUT", url: "/watchlist", payload: { symbols: "BTC" } });
  expect(res.statusCode).toBe(400);
});
```

Not: `buildApp` şu an `store`'u almıyor — `app` içinden Store'a erişmek için `buildApp` imzasına `store` eklenir (aşağıdaki adım 3) ve test `buildApp({ exchange, engine, store })` ile güncellenir.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @huper/engine -- server.test.ts`
Expected: FAIL — `buildApp` `store` tanımıyor + 3 yeni test fail (typecheck hatası veya 404). Test dosyasındaki `buildApp({ exchange, engine })` çağrısı da güncellenecek.

- [ ] **Step 3: Implement**

`packages/engine/src/server.ts`:

İmzayı değiştir (Store import'u ekle):

```ts
import type { Store } from "./store/store.js";

export function buildApp(opts: { exchange: ExchangeAdapter; engine: Engine; store: Store }): FastifyInstance {
```

`/equity` route'undan SONRA, static register'dan ÖNCE route'lar:

```ts
app.get("/watchlist", async () => ({ symbols: opts.store.getWatchlist() }));

app.put<{ Body: { symbols?: unknown } }>("/watchlist", async (req, reply) => {
  const raw = req.body?.symbols;
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
    return reply.code(400).send({ error: "symbols must be an array of strings" });
  }
  opts.store.setWatchlist(raw as string[]);
  return { ok: true };
});
```

`packages/engine/tests/server.test.ts` — `buildApp` çağrısını güncelle (satır `app = buildApp({ exchange, engine });`):

```ts
app = buildApp({ exchange, engine, store });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @huper/engine -- server.test.ts`
Expected: PASS — mevcut 9 + yeni 3 test (12).

Run: `npm run typecheck`
Expected: 0 hata.

Run: `npm test -w @huper/engine`
Expected: tüm testler geçer (10 dosya, 64 test).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/server.ts packages/engine/tests/server.test.ts
git commit -m "feat(server): add watchlist endpoints"
```

---

### Task 3: Panel — watchlist mantığı + boş-durum UX (`app.js`)

**Files:**
- Modify: `packages/engine/public/app.js`
- Test: `packages/engine/tests/server.test.ts`

**Interfaces:**
- Consumes: `GET /watchlist`, `PUT /watchlist` (Task 2).
- Produces: `DEFAULT_WATCHLIST` sabiti, `loadWatchlist()`/`addSymbol()`/`removeSymbol()`, `poll()`'un güncel `syms` mantığı, boş-durum satırları. Task 4 HTML/style bu isimlere bağlanır.

- [ ] **Step 1: Write the failing test**

`packages/engine/tests/server.test.ts` — `describe("server", ...)` bloğu İÇİNE ekle:

```ts
it("panel app.js defines a default watchlist", async () => {
  const res = await app.inject({ method: "GET", url: "/app.js" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("DEFAULT_WATCHLIST");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @huper/engine -- server.test.ts`
Expected: FAIL — `DEFAULT_WATCHLIST` app.js'te yok.

- [ ] **Step 3: Implement in `app.js`**

`packages/engine/public/app.js`:

`escapeHtml` fonksiyonundan SONRA sabit:

```js
const DEFAULT_WATCHLIST = ["BTC", "ETH", "SOL", "DOGE", "LINK", "AVAX", "XRP", "BNB"];
```

`api` fonksiyonundan SONRA watchlist yardımcıları:

```js
let watchlist = [];
async function loadWatchlist() {
  const res = await api("/watchlist");
  watchlist = res.symbols && res.symbols.length ? res.symbols : DEFAULT_WATCHLIST;
  if (!res.symbols || !res.symbols.length) await api("/watchlist", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols: watchlist }) });
  return watchlist;
}
async function addSymbol() {
  const raw = $("#watch-input").value.trim().toUpperCase();
  if (!raw) return;
  if (watchlist.includes(raw)) { toast(`${raw} zaten listede`); return; }
  watchlist.push(raw);
  try { await saveWatchlist(); } catch (e) { watchlist.pop(); toast(e.message); return; }
  $("#watch-input").value = "";
  toast(`${raw} eklendi`);
  poll();
}
async function removeSymbol(sym) {
  watchlist = watchlist.filter((s) => s !== sym);
  try { await saveWatchlist(); } catch (e) { toast(e.message); return; }
  toast(`${sym} kaldırıldı`);
  poll();
}
async function saveWatchlist() {
  await api("/watchlist", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbols: watchlist }) });
}
```

`poll()` içindeki fiyat sembolü mantığını değiştir (`const syms = [...]` satırı):

```js
    const syms = [...new Set([...watchlist, ...positions.map((p) => p.symbol), ...bots.map((b) => b.symbol)])];
```

`setTable("prices", ...)` satırından SONRA kaldır butonları için delegation (event delegation bloğunun yanına):

```js
    document.querySelectorAll("#prices [data-rm]").forEach((btn) => {
      btn.addEventListener("click", () => removeSymbol(btn.dataset.rm));
    });
```

`setTable("prices", ...)` cell callback'ini güncelle — kaldır butonu kolonu ekle (kolon listesi `["symbol", "bid", "ask", "mid"]` → `["symbol", "bid", "ask", "mid", ""]`):

```js
    setTable("prices", syms.map((s, i) => ({ symbol: s, tick: ticks[i].tick })), ["symbol", "bid", "ask", "mid", ""],
      (r, c) => {
        if (c === "") return `<button data-rm="${escapeHtml(r.symbol)}">Kaldır</button>`;
        if (c === "symbol") return escapeHtml(r.symbol);
        return r.tick ? Number(r.tick[c]).toFixed(2) : "—";
      });
```

`setTable` fonksiyonundan SONRA boş-durum yardımcısı:

```js
function emptyRow(tbodyId, columns, message) {
  const tbody = document.querySelector(`#${tbodyId} tbody`);
  if (tbody && tbody.childElementCount === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = columns.length;
    td.className = "empty";
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}
```

`poll()` sonunda, delegation bloklarından SONRA boş-durum çağrıları (fiyat tablosuna watchlist input yönlendirmesi, pozisyon ve botlar için açıklama):

```js
    emptyRow("positions", ["symbol", "side", "size", "avgEntry", "markPrice"], "Henüz açık pozisyon yok");
    emptyRow("prices", ["symbol", "bid", "ask", "mid", ""], "Sembol eklemek için yukarıdaki input'u kullanın");
    emptyRow("bots", ["name", "strategy", "symbol", "status", "actions"], "Bot eklemek için yeni bot formunu kullanın");
```

`showDetail` sonundaki üç `setTable` çağrısından SONRA:

```js
    emptyRow("detail-orders", ["id", "side", "price", "size", "status", "filled_size"], "Kayıt yok");
    emptyRow("detail-positions", ["symbol", "side", "size", "avg_entry", "closed_at"], "Kayıt yok");
    emptyRow("detail-runs", ["mode", "started_at", "stopped_at", "stop_reason"], "Kayıt yok");
```

`poll()`'un başında (ilk `api` çağrılarından önce) watchlist yükleme güvencesi — `poll()` async olduğu için `loadWatchlist`'i `poll()` içinde çağırmak yerine, dosya sonundaki başlatma satırını güncelle:

```js
poll();
setInterval(poll, 2000);
```

ile başlatma `loadWatchlist` beklenir — en basit: `poll()`'un en üstüne ekle (ama tekrar tekrar GET atmasın; `watchlist` doluysa atla):

```js
async function poll() {
  try {
    if (watchlist.length === 0) await loadWatchlist();
    const [balances, positions, bots, equity] = await Promise.all([...]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @huper/engine -- server.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: 0 hata.

Run: `npm test -w @huper/engine`
Expected: tüm testler geçer (10 dosya, 65 test).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/public/app.js packages/engine/tests/server.test.ts
git commit -m "feat(web): editable watchlist and empty-state rows"
```

---

### Task 4: Panel — watchlist widget + boş-durum ve tam yeniden tasarım (`index.html` + `style.css`)

**Files:**
- Modify: `packages/engine/public/index.html`
- Modify: `packages/engine/public/style.css`

**Interfaces:**
- Consumes: Task 3'ün `#watch-input`, `addSymbol`, `removeSymbol`, `.empty`, `data-rm` isimleri.
- Produces: görünüm/HTML değişiklikleri (test gerektirmez — doğrulama typecheck + manuel smoke).

- [ ] **Step 1: Add watchlist widget to `index.html`**

`packages/engine/public/index.html` — "Fiyatlar" kartında, tablo başlığından ÖNCE widget:

```html
    <div class="card wide">
      <h3>Fiyatlar</h3>
      <div class="watch-controls">
        <input id="watch-input" placeholder="Sembol (örn. BTC)" size="12">
        <button type="button" id="watch-add">Ekle</button>
      </div>
      <table id="prices">
        <thead><tr><th>Sembol</th><th>Bid</th><th>Ask</th><th>Mid</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
```

`</body>`'den ÖNCE, script tag'inden önce `#watch-add` tıklama bağlama — `app.js`'e değil, HTML inline script kullanma; bunun yerine `app.js` sonundaki init'e ekle:

`app.js` — dosya sonundaki `poll();` satırından ÖNCE:

```js
$("#watch-add").addEventListener("click", addSymbol);
```

- [ ] **Step 2: Add empty-state style to `style.css`**

`packages/engine/public/style.css` — mevcut dosyayı aşağıdaki TAM içerikle değiştir (yeniden tasarım + `.empty` + `.watch-controls`):

```css
:root {
  --bg: #0f172a; --card: #1e293b; --border: #334155;
  --text: #e2e8f0; --muted: #94a3b8; --accent: #22d3ee;
  --green: #10b981; --red: #ef4444; --yellow: #f59e0b;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 12px;
  padding: 14px 24px; background: #0b1220; border-bottom: 1px solid var(--border);
}
header h1 { margin: 0; font-size: 20px; letter-spacing: 1px; color: var(--accent); }
.badge { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #164e63; color: var(--accent); }
.header-right { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted); }
.tabs { display: flex; gap: 8px; padding: 12px 24px; border-bottom: 1px solid var(--border); }
.tabs button {
  padding: 8px 16px; border: 1px solid var(--border); border-radius: 8px;
  background: transparent; color: var(--text); cursor: pointer; font-size: 14px;
}
.tabs button.active { background: #164e63; border-color: var(--accent); color: #fff; }
.view { padding: 20px 24px 40px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 16px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.card h3 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); }
.card.wide { margin-bottom: 16px; }
#balance { font-size: 26px; font-weight: 700; margin: 0; color: var(--green); }
#equity-last { font-size: 20px; font-weight: 600; margin: 0; }
canvas#equity-chart { width: 100%; height: 200px; background: #0b1220; border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
thead th {
  position: sticky; top: 56px; text-align: left; padding: 8px 10px;
  background: #16233a; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 600;
}
tbody td { padding: 8px 10px; border-bottom: 1px solid #24344d; }
tbody tr:nth-child(even) { background: #17253c; }
tbody tr:hover { background: #1d2f4a; }
td.empty { text-align: center; color: var(--muted); font-style: italic; padding: 16px; }
.watch-controls { display: flex; gap: 8px; margin-bottom: 10px; }
.watch-controls input {
  flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: #0b1220; color: var(--text); font-size: 14px;
}
button {
  padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--card); color: var(--text); cursor: pointer; font-size: 13px;
}
button.primary, #watch-add, form button[type="submit"] { background: #0e7490; border-color: #0e7490; color: #fff; }
button:hover { border-color: var(--accent); }
button.danger { border-color: var(--red); color: var(--red); }
button.danger:hover { background: #450a0a; }
.status-running { color: var(--green); }
.status-stopped { color: var(--muted); }
.status-error { color: var(--red); }
form#new-bot { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
form#new-bot input, form#new-bot select {
  padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: #0b1220; color: var(--text); font-size: 14px;
}
#params label { margin-right: 12px; font-size: 12px; }
#params input { width: 80px; }
.error { color: var(--red); }
.toast {
  position: fixed; bottom: 20px; right: 20px; background: #164e63; color: #fff;
  padding: 12px 18px; border-radius: 8px; border-left: 3px solid var(--accent);
}
.hidden { display: none; }
@media (max-width: 720px) { .cards { grid-template-columns: 1fr; } }
```

- [ ] **Step 3: Verify no code impact**

Run: `npm run typecheck`
Expected: 0 hata (kod etkilenmez).

Run: `npm test -w @huper/engine`
Expected: tüm testler geçer (10 dosya, 65 test — değişiklik yok).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/public/index.html packages/engine/public/style.css packages/engine/public/app.js
git commit -m "feat(web): redesign panel with watchlist widget and empty states"
```

---

### Finalization

- [ ] **Full verification**

```bash
npm run typecheck
npm test
```

Expected: 0 typecheck hatası; core 7/7 + engine 65/65 test geçer.

- [ ] **Manual smoke test**

1. Kapat: port 3001'de stale process varsa durdur.
2. Başlat:
   ```bash
   $env:PORT="3001"; $env:HUPER_MODE="paper"; npm run dev -w @huper/engine
   ```
3. Fiyat tablosu: `http://localhost:3001` açılınca varsayılan liste (BTC, ETH, SOL, DOGE, LINK, AVAX, XRP, BNB) canlı fiyatlarla dolu görünür.
4. Ekle: "Fiyatlar" üstündeki input'a `ADA` yaz, Ekle → satır eklenir; `GET /watchlist` → `ADA` dahil. Sayfa yenile → `ADA` hâlâ listede (kalıcı).
5. Kaldır: bir satırın "Kaldır" butonu → satır gider; `GET /watchlist` güncellenir.
6. Boş-durum: tüm semboller kaldırılırsa fiyat tablosu "Sembol eklemek için yukarıdaki input'u kullanın" gösterir; bot yoksa "Bot eklemek için..." mesajı görünür.
7. XSS regresyon: ismi `<img src=x onerror=alert(1)>` olan bot oluştur → listede metin olarak görünür.
8. Kapat: Ctrl+C ile engine'i durdur.

## Task Order Rationale

1. **Task 1 (store)** — kalıcılık katmanı, en altta; izole test edilebilir.
2. **Task 2 (server)** — store'a bağımlı, API'yi açar; panel bundan beslenir.
3. **Task 3 (app.js)** — API'yi tüketir; assertion testi ile doğrulanır.
4. **Task 4 (tasarım)** — en üstte, Task 3'ün isimlerine bağlanır; görünüm işi.
