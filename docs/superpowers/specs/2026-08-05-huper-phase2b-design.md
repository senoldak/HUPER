# HUPER — Phase 2b Tasarımı: Sağlamlaştırma (Hardening)

**Tarih:** 2026-08-06
**Durum:** Onaylandı (brainstorming süreci)
**Üst doküman:** `docs/superpowers/specs/2026-08-05-huper-design.md`
**Öncül faz:** Phase 2a tamamlandı (commit c6a02dc)

## 1. Kapsam (2b)

Phase 2b, Phase 2a tüm-dal incelemesinden ertelenen 4 Important + 5 Minor kalemi kapatır ve engine'i canlı (live) modda üretim-uygulanabilir hale getirir. **Yeni strateji, web paneli, WS push, anahtar şifreleme YOKTUR** — bunlar sonraki fazlara aittir.

**2b kapsamında:**
- **Canlılık (live doğruluk):** LiveExchange `userFills` aboneliği; store emir durumunun dolum olaylarında `filled` olması; bekleyen (resting) limit dolgularının engine tarafında doğru statü + position reconcile ile işlenmesi.
- **Bot izolasyonu:** `Engine.positionsFor` → store'dan bot-scoped okuma (exchange aggregate yerine); `BotRunner` in-flight mutex (re-entrancy).
- **Kapatma / exit akışı:** EmergencyStop'un `stopAll` sonrası pozisyonları yeniden okuması (stale-snapshot race); RiskManager'ın reduce-only kapanışlarını pozisyon/kap gate'lerinden muaf tutması.
- **Performans / dayanıklılık:** refreshMeta zaman-tabanlı debounce; kaza sonrası boot recovery; `deleteBot` cascade silme; `bot_id` index'leri.

**Kapsam dışı (2b):**
- Kalan stratejiler (Scalping, Breakout, Mean Reversion, Arbitraj, DCA-Kart) → Phase 2c.
- Web paneli, grafikler, WS push → Phase 3-4.
- Anahtar şifreleme → Phase 3.
- Canlı gerçek WS/private key ile uçtan uca e2e → bu fazda YOKTUR; canlı kod mocked unit testlerle doğrulanır (canlı key mevcut değil).

## 2. Mimari

Mevcut düzen aynan; değişiklikler yalnızca mevcut dosyalardaki hedefli kod yamaları. Değişen dosyalar:

```
packages/engine/src/
├─ exchange/live.ts        # userFills aboneliği + dolum statü bildirimi
├─ framework/engine.ts     # positionsFor(botId, symbol) store kaynağı; routeFill→order status filled; refreshMeta debounce; market-fill statü yazımı
├─ framework/runner.ts     # in-flight mutex (skip-on-overlap)
├─ risk/risk.ts            # reduceOnly → pozisyon/kap gate'lerinden muaf
├─ emergency.ts            # stopAll sonrası pozisyon re-scan + kapanış
├─ store/store.ts          # deleteBot cascade
├─ store/db.ts             # bot_id index'leri
├─ main.ts                 # boot crash recovery (recoverStaleBots)
├─ tests/                  # live-orders.test.ts (yeni) + mevcut testlerin uzantıları
```

## 3. Veri akışı ve Bileşen Açıklamaları

### 3.1 LiveExchange.userFills (live.ts)
- `connect()` içinde `userFills` aboneliği: `subs.subscribe({ type: "userFills", user: <walletAddress> }, cb)`.
- Callback ile ortak işlemler:
  - `ordersPending` map'inde eşleşen resting order'ları bul ve dolgu bilgisiyle (`filledSize`, `avgFillPrice`, `status: Filled`) güncelle.
  - `fillCbs`'i dolan emir ile tetikle (best-effort; eşleşme emir ID üzerinden).
  - Aboneliği `activeSubs`'a kaydet; `disconnect()` temizler.
- `placeOrder` market dolgu (Ioc) gerçekleşir; `ordersPending` doğru güncellenir.

### 3.2 Engine — emir statüsü, positionsFor, debounce (engine.ts)
- **Store emir statüsü:** `executeOrder` içinde market-dolan emirler store'a baştan `filled` durumuyla yazılır; bekleyen limit `open` durumuyla. `routeFill` içinde gelen dolgularda `store.updateOrder(order.id, { status: "filled", filled_size, avg_price })` çalıştırılır — bekleyen limit dolgusunun statüsü artık doğru ilerler.
- **positionsFor:** imzası `positionsFor(botId: string, symbol: string)` olur; artık `exchange.openPositions()` (aggregate) DEĞİI, `store.listPositions(botId)` açık satırlarını `symbol` ile filtreleyen. Böylece her strateji yalnız kendi botunun pozisyonunu görür. `BotRunner` ctx.getPositions → `engine.positionsFor(botId, symbol)` çağırır.
- **refreshMeta debounce:** `lastBalanceRefresh` timestamp; bakiyer yalnızca `now - last > 1000ms` olduğunda yenilenir (her tick'te atlanır). Bot evaluate'daki risk snapshot'ı cadence ile uyumlu, güncel bakiyeye yakın kalır.

### 3.3 BotRunner in-flight mutex (runner.ts)
- `BotRunner.evaluate` başında `this.busy` bayrağı; `busy` ise o tik atlanır — **skip-on-overlap** (ürün kararı, cadence proof stratejiler için yeterli). `finally` içinde `busy = false`.

### 3.4 RiskManager reduce-only muafiyeti (risk.ts)
- `validate()`: `attempt.reduceOnly === true` olduğunda **per-bot pozisyon kapısı** (`perBotMaxPositionPct`) ve **global pozisyon kapısı** (`globalMaxPositionPct`) hesaplamaları atlanır — kapanış azaltıcıdır.
- **Order-notional kapısı** (`maxOrderNotionalPct`), **minOrderSize**, **maxOrderSize** ve **duplicate guard** reduce-only için DE GEÇERLİ kalır (kapanış yine de mantıksız boyutta olmamalı). Drift guardrail reduce-only için 2a'dan muafiu.
- `RiskSnapshot` değişmez; karar `attempt.reduceOnly` + `snapshot` ile verilir.

### 3.5 EmergencyStop re-scan (emergency.ts)
- Akış: `stopAll("emergency")` → (stratejiler no-op onStop, sistem durur) → **`exchange.openPositions()` yeniden oku** → kalan pozisyonları market ile kapat. StopAll öncesi ilk snapshot kaldırılır; kapanış güncel pozisyonlar üzerinden yürür → stale-snapshot race kapanılır.

### 3.6 Store: deleteBot cascade + index'ler (store.ts, db.ts)
- `deleteBot(id)`: `runs`, `orders`, `positions`, `equity` satırlarını da siler (cascade), sonra `bots` satırını.
- `db.ts` şemasına `bot_id` index'leri: `runs(bot_id)`, `orders(bot_id)`, `positions(bot_id)`, `equity(bot_id)` — idempotent (`CREATE INDEX IF NOT EXISTS`).

### 3.7 Crash recovery (main.ts)
- `recoverStaleBots(store, log)`: boot'ta `store.listBots()` içinde `status='running'` olanları `store.updateBot(id, {status:'stopped'})` + `finishRun(openRunId, 'crash_recovered')` ile kapatır. Emir/pozisyon dokunmz — yalnız durum uyumu. Ayrı test edilebilir şekilde export edilir.

### 3.8 Async-fill reconcile tamamlama (engine.ts)
- `routeFill` Phase 2a (`c6a02dc`)'da her owning runner için reconcile çağırır; bu fazın işi emir statüsünün `filled` olması (3.2) ve canlı `userFills` desteğidir (3.1).

## 4. Hata Yönetimi

Mevcut model sürer: strateji hataları `markError`; emir redleri `Error.message` → HTTP 400. Yeni durumlar:
- `userFills` aboneliği başarısızlığı: log.warn, engine çalışmaya devam eder (fill bilgisi yoksa store statüsü gecikir).
- `recoverStaleBots` hataları: log.error ama sonraki satırlar tamamlanır.
- Live testlerde SDK mock hatası → test çöker (kasıtlı — controller doğrulama).

## 5. Test & Doğrulama

Canlı mod: mock uyarlanmış SDK `SubscriptionClient`/`ISubscription` ile unit testler (canlı key yok). **PaperExchange**: gerçek, paper mod testlerde çalışır.

**Yeni / uzatılan testler:**
- `tests/live-orders.test.ts` (yeni): mocked `SubscriptionClient`; market Ioc fill + `userFills` dolgu → emir/store `filled` statüsü ve `fillCbs` olayı; bekleyen limit `ordersPending` güncellenmesi.
- `engine.test.ts`: iki bot aynı simbol → her birinin `positionsFor` store'dan bot-scoped (diğerinin pozisyonunu görmüyor); runner mutex overlap skip; refreshMeta 1s'de tek.
- `risk.test.ts`: reduce-only kapanış pozisyon/cap'a takılmıyor, aynı boyutta normal emir reddediliyor.
- `emergency.test.ts`: stopAll sonrası re-scan kapanış.
- `store.test.ts`: deleteBot cascade + index varlığı.
- `recoverStaleBots` birim testi: `running → stopped` + `finishRun('crash_recovered')`.

**Doğrulama:** `npm run test -w @huper/engine` (tam suite), `npm run typecheck` 0 hata; canlı kod mock testlerle, gerçek WS yok.

## 6. Sıralama (Önerilen)

1. Store katmanı (3.6 + 3.7) — bağımsız, altta.
2. LiveExchange userFills + engine emir/dolgu (3.1, 3.2, 3.8).
3. Runner mutex + positionsFor (3.3, 3.2).
4. EmergencyStop + reduce-only (3.4, 3.5).
5. refreshMeta debounce (3.2).

Her adım test + subagent review ile ilerler (`@huper/engine` içinde, strict TS, ESM `.js` import).