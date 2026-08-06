# Phase 3a Implementation Plan: Güvenlik & Teknik Borç Kapanışı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2'de ertelenen üç güvenlik/teknik borç öğesini kapat: paper exchange `reduceOnly` flip koruması, panel XSS fix'i, risk limitleri dokümantasyonu.

**Architecture:** (1) `PaperExchange.placeOrder` ters yönde pozisyon yoksa reduceOnly emri reddeder ve dolum boyutunu pozisyon boyutuna clamp eder (flip imkânsız). (2) Panel `app.js` her dinamik hücre değerini `escapeHtml`'den geçirir (XSS kapanır). (3) README'ye risk limitleri bölümü eklenir.

**Tech Stack:** TypeScript (strict, ESM, `.js` import), vitest, better-sqlite3, Fastify, vanilla JS panel.

## Global Constraints

- Strict TS, ESM, `.js` import extension. `npm run typecheck` 0 hata.
- Koda YORUM eklenmez (plan dokümanları dışında).
- Yeni dependency EKLENMEZ.
- `@huper/core` `types.ts` değişmez.
- Her görev sonunda `npm run typecheck` + `npm test -w @huper/engine` yeşil.
- Doğrulama komutları: `npm run typecheck`, `npm test -w @huper/engine`.
- Dosya adları ve `describe`/`it` blok adları mevcut konvansiyona uyar.

---

### Task 1: Paper exchange `reduceOnly` flip koruması

**Files:**
- Modify: `packages/engine/src/exchange/paper.ts`
- Test: `packages/engine/tests/paper.test.ts`

**Interfaces:**
- Consumes: `NewOrder.reduceOnly?: boolean` (`@huper/core`), `Order` (`extends NewOrder`), mevcut `placeOrder`/`applyFill`/`addPosition`/`reducePosition`.
- Produces: `placeOrder()` davranışı — `reduceOnly` emirler ters pozisyon yoksa `throw new Error("reduce-only order rejected: no opposing position")`; ters pozisyon varsa dolum `Math.min(emirBoyutu, pozisyonBoyutu)` ile sınırlanır. Emir kaydı (`Order.reduceOnly`) artık sweep güvenliği için flag taşır.

- [ ] **Step 1: Write the failing tests**

`packages/engine/tests/paper.test.ts` — `describe("PaperExchange", ...)` bloğu İÇİNE, son `it`'ten sonra aynı girintide ekle:

```ts
it("rejects reduce-only sell when no opposing position", async () => {
  const ex = new PaperExchange({ initialBalance: 1000 });
  ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });

  await expect(ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 1 })).resolves.toBeDefined();
  await expect(ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 2, reduceOnly: true }))
    .rejects.toThrow("no opposing position");
  expect(await ex.openPositions()).toHaveLength(0);
});

it("rejects reduce-only when position is same direction", async () => {
  const ex = new PaperExchange({ initialBalance: 1000 });
  ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });

  await ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 1 }); // short
  await expect(ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 1, reduceOnly: true }))
    .rejects.toThrow("no opposing position");
});

it("fills reduce-only within position size and never flips", async () => {
  const ex = new PaperExchange({ initialBalance: 1000 });
  ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });

  await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 1 }); // long 1
  const o = await ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 2, reduceOnly: true });

  expect(o.filledSize).toBe(1); // clamped to position
  const pos = await ex.openPositions();
  expect(pos).toHaveLength(0); // position closed, NOT flipped to short
});

it("leaves non-reduce-only orders unaffected", async () => {
  const ex = new PaperExchange({ initialBalance: 1000 });
  ex.pushTick({ symbol: "BTC", bid: 100, ask: 101, mid: 100.5, timestamp: 1 });

  await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 1 }); // long 1
  await ex.placeOrder({ symbol: "BTC", side: Side.Sell, price: null, size: 2 }); // no reduceOnly -> flips to short 1
  const pos = (await ex.openPositions())[0];
  expect(pos.side).toBe(Side.Sell);
  expect(pos.size).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @huper/engine -- paper.test.ts`
Expected: FAIL — 4 yeni test: 2'si `rejects.toThrow` beklerken mevcut kod emri doldurup çözümlüyor; `fills reduce-only within position size` testinde `filledSize` 2 olup `toHaveLength(0)` başarısız (pozisyon short'a döner); non-reduceOnly testi zaten geçer (regresyon).

- [ ] **Step 3: Implement in `paper.ts`**

`packages/engine/src/exchange/paper.ts` — `applyFill`'ten ÖNCE yeni özel metot:

```ts
private opposingSize(n: NewOrder): number {
  const p = this.positions.get(n.symbol);
  if (!p || p.size === 0) return 0;
  if (n.side === Side.Sell && p.side === Side.Buy) return p.size;
  if (n.side === Side.Buy && p.side === Side.Sell) return p.size;
  return 0;
}
```

`placeOrder`'ı değiştir — başına guard, fill dalında clamp, `buildOrder`'a flag:

```ts
async placeOrder(n: NewOrder): Promise<Order> {
  const id = `pp-${++seq}`;
  const type = n.type ?? OrderType.Limit;
  if (n.reduceOnly && this.opposingSize(n) === 0) {
    throw new Error("reduce-only order rejected: no opposing position");
  }
  const fillPrice = this.fillPriceFor(n, type);

  let order: Order;
  if (fillPrice !== null) {
    const requested = Math.abs(n.size);
    const fillSize = n.reduceOnly ? Math.min(requested, this.opposingSize(n)) : requested;
    order = this.buildOrder(n, id, OrderStatus.Filled, fillPrice, fillSize);
    this.orders.set(id, order);
    this.applyFill(n, fillPrice, fillSize);
    for (const cb of this.fillCbs) cb(order);
  } else {
    order = this.buildOrder(n, id, OrderStatus.Open, null, 0);
    this.orders.set(id, order);
  }
  return order;
}
```

`buildOrder` içinde dönen nesneye flag ekle (sweep güvenliği — `Order extends NewOrder`):

```ts
return {
  id, symbol: n.symbol, side: n.side, type: n.type ?? OrderType.Limit,
  price: n.price, size: n.size, reduceOnly: n.reduceOnly, status, filledSize,
  avgFillPrice, createdAt: now(), filledAt: status === OrderStatus.Filled ? now() : undefined,
};
```

`applyFill` içinde reduceOnly için güvenlik clamp'i (hem placeOrder hem sweep yolu):

```ts
private applyFill(n: NewOrder, px: number, size: number): void {
  let fillSize = size;
  if (n.reduceOnly) {
    const opposing = this.opposingSize(n);
    if (opposing === 0) return;
    fillSize = Math.min(size, opposing);
  }
  if (n.side === Side.Buy) {
    this.cash -= px * fillSize;
    this.addPosition(n.symbol, fillSize, px);
  } else {
    this.cash += px * fillSize;
    this.reducePosition(n.symbol, fillSize, px);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @huper/engine -- paper.test.ts`
Expected: PASS — mevcut 5 + yeni 4 test.

Run: `npm test -w @huper/engine`
Expected: tüm testler geçer (10 dosya, 58 test).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/exchange/paper.ts packages/engine/tests/paper.test.ts
git commit -m "fix(paper): reject and clamp reduce-only fills to prevent position flips"
```

---

### Task 2: Panel XSS fix (escapeHtml)

**Files:**
- Modify: `packages/engine/public/app.js`
- Test: `packages/engine/tests/server.test.ts`

**Interfaces:**
- Consumes: mevcut `setTable(id, rows, columns, cell)` ve tüm `cell` callback'leri.
- Produces: `escapeHtml(v)` yardımcı fonksiyonu (app.js). Kullanıcı tarafından üretilen değerlerin hiçbiri `innerHTML`'e escape edilmeden girmez.

- [ ] **Step 1: Write the failing test**

`packages/engine/tests/server.test.ts` — `describe("server", ...)` bloğu İÇİNE ekle:

```ts
it("panel app.js escapes dynamic cell values", async () => {
  const res = await app.inject({ method: "GET", url: "/app.js" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain("function escapeHtml");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @huper/engine -- server.test.ts`
Expected: FAIL — `"function escapeHtml"` mevcut `app.js`'te yok.

- [ ] **Step 3: Implement in `app.js`**

`packages/engine/public/app.js` — `const $ = ...` satırından sonra yardımcıyı ekle:

```js
function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
```

**`setTable` DEĞİŞMEZ** (`td.innerHTML = cell(row, c, i);` kalır). XSS koruması, her `cell` callback'inin kendi dinamik değerini escape etmesiyle sağlanır:

`poll()` içindeki `setTable("positions", ...)` → tüm değerleri escape et:
```js
setTable("positions", positions, ["symbol", "side", "size", "avgEntry", "markPrice"],
  (r, c) => escapeHtml(r[c] ?? "—"));
```

`setTable("prices", ...)` → symbol dinamik, sayılar güvenli ama yine de escape:
```js
setTable("prices", syms.map((s, i) => ({ symbol: s, tick: ticks[i].tick })), ["symbol", "bid", "ask", "mid"],
  (r, c) => c === "symbol" ? escapeHtml(r.symbol) : (r.tick ? Number(r.tick[c]).toFixed(2) : "—"));
```

`setTable("bots", ...)` → name/strategy/symbol escape; status/actions HTML üretir ama dinamik değerlerini escape eder:
```js
setTable("bots", bots, ["name", "strategy", "symbol", "status", "actions"],
  (r, c) => {
    if (c === "status") return `<span class="${escapeHtml(STATUS_CLASS[r.status] || "")}">${escapeHtml(r.status)}</span>`;
    if (c === "actions") {
      const verb = r.status === "running" ? "stop" : "start";
      const label = r.status === "running" ? "Durdur" : "Başlat";
      return `<button data-act="${verb}" data-id="${escapeHtml(r.id)}">${label}</button>
              <button data-act="detail" data-id="${escapeHtml(r.id)}">Detay</button>
              <button data-act="del" data-id="${escapeHtml(r.id)}" class="danger">Sil</button>`;
    }
    return escapeHtml(r[c] ?? "—");
  });
```

`showDetail()` içindeki üç tablo (detail-orders, detail-positions, detail-runs) → dinamik değerleri escape et; tarih formatları da escape ile sarılır:
```js
setTable("detail-orders", d.orders || [], ["id", "side", "price", "size", "status", "filled_size"],
  (r, c) => escapeHtml(r[c] ?? "—"));
setTable("detail-positions", d.positions || [], ["symbol", "side", "size", "avg_entry", "closed_at"],
  (r, c) => (c === "closed_at" ? escapeHtml(r[c] ? new Date(r[c]).toLocaleString() : "açık") : escapeHtml(r[c] ?? "—")));
setTable("detail-runs", d.runs || [], ["mode", "started_at", "stopped_at", "stop_reason"],
  (r, c) => (c === "started_at" || c === "stopped_at") ? escapeHtml(r[c] ? new Date(r[c]).toLocaleString() : "—") : escapeHtml(r[c] ?? "—"));
```

Not: `detail-name` zaten `textContent` ile yazılır — güvenli. `drawEquity`'nin `$("#equity-last").textContent = ...` satırı güvenli (textContent).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @huper/engine -- server.test.ts`
Expected: PASS.

Run: `npm test -w @huper/engine`
Expected: tüm testler geçer (10 dosya, 59 test).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/public/app.js packages/engine/tests/server.test.ts
git commit -m "fix(web): escape dynamic panel cell values against XSS"
```

---

### Task 3: README — risk limitleri dokümantasyonu

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `DEFAULT_RISK` değerleri (`packages/core/src/types.ts`: `maxOrderNotionalPct: 0.05`, `perBotMaxPositionPct: 0.2`, `globalMaxPositionPct: 0.5`, `maxPriceDriftPct: 0.05`).
- Produces: README'de "Risk limitleri" bölümü — kullanıcı rehberi.

- [ ] **Step 1: Add the section**

`README.md` — "Geliştirme (lokal)" bölümünden SONRA, "Docker (VPS)" bölümünden ÖNCE ekle:

```markdown
## Risk limitleri

Varsayılan risk yapılandırması `packages/core/src/types.ts` içindeki `DEFAULT_RISK`'tir:

- `maxOrderNotionalPct: 0.05` — tek emrin notional değeri, bakiye'nin %5'ini aşamaz.
- `perBotMaxPositionPct: 0.2` / `globalMaxPositionPct: 0.5` — pozisyon büyüklüğü bakiye'nin %20/%50'sini aşamaz.
- `maxPriceDriftPct: 0.05` — limit emir fiyatı son fiyattan %5'ten fazla sapamaz.

Örnek: 10.000 USDC bakiyeyle BTC'de grid botu kurarken `orderSize`'ı `0.05 × 10000 / BTC_fiyatı` olarak hesapla (yaklaşık 0.0077 BTC @ $65k). Daha büyük boyutlar emir reddine ("exceeds order notional cap") yol açar.
```

- [ ] **Step 2: Verify no code impact**

Run: `npm run typecheck`
Expected: 0 hata (sadece md değişikliği, kod etkilenmez).

Run: `npm test -w @huper/engine`
Expected: tüm testler geçer (10 dosya, 59 test — değişiklik yok).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document DEFAULT_RISK order size guidance"
```

---

### Finalization

- [ ] **Full verification**

```bash
npm run typecheck
npm test
```
Expected: 0 typecheck hatası; core 7/7 + engine 59/59 test geçer.

- [ ] **Manual smoke test**

1. Kapat: port 3001'de stale process varsa durdur.
2. Başlat:
   ```bash
   $env:PORT="3001"; $env:HUPER_MODE="paper"; npm run dev -w @huper/engine
   ```
3. XSS doğrulama: ismi `<img src=x onerror=alert(1)>` olan bir bot oluştur (POST `/bots`). `http://localhost:3001`'de bot listesinde isim **metin** olarak görünür, resim/alert yüklenmez.
4. reduceOnly doğrulama (konsolda direkt test yerine): `POST /orders` ile BTC `buy` market 0.001; ardından `sell` market 0.01 + `reduceOnly: true` → paper exchange `400` "reduce-only order rejected: no opposing position" dönmez (pozisyon varken dolar, clamp olur). Ters senaryo: önce `sell` market 0.001 ile short aç, `buy` market `reduceOnly: true` ile kapat.
5. Kapat: Ctrl+C ile engine'i durdur.

## Task Order Rationale

1. **Task 1 (paper)** — kod davranışı, en kritik güvenlik öğesi; izole test edilebilir.
2. **Task 2 (app.js)** — panel güvenliği; Task 1'den bağımsız.
3. **Task 3 (README)** — saf dokümantasyon; son.
