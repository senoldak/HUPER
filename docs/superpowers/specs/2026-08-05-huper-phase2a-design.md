# HUPER — Phase 2a Tasarımı: Bot Çerçevesi, Risk, Durum Deposu, Acil Durdurma

**Tarih:** 2026-08-05
**Durum:** Onaylandı (brainstorming süreci)
**Üst doküman:** `docs/superpowers/specs/2026-08-05-huper-design.md`
**Öncül faz:** Faz 0-1 (monorepo + exchange katmanı) tamamlandı (commit 742523e)

## 1. Kapsam (2a)

Phase 2a, bot motorunun çekirdeğini kurar. Kapsam dışı (2b): kalan 5 strateji (Scalping, Breakout, Mean Reversion, Arbitraj, DCA-Kart).

**2a kapsamında:**
- Bot çerçevesi: `Strategy` arayüzü, `BotRunner`, paylaşılan tick-loop `Engine`, `StrategyRegistry`, `EngineRuntime`/`StrategyCtx`.
- `MarketDataFeed`: Hyperliquid WS (allMids/l2Book) → paper dolum + engine tick dağıtımı.
- `RiskManager`: emir öncesi güvenlik kapısı.
- `StateStore`: better-sqlite3 tabanlı durum deposu (botlar, oturumlar, emirler, pozisyonlar, equity).
- `EmergencyStop`: tüm botları durdur + emirleri iptal + pozisyonları market kapat.
- Kanıt stratejileri: **Grid**, **DCA/Martingale**, **Trend (EMA/RSI/MACD + SL/TP)**.
- LiveExchange market emir düzeltmesi: acil kapanış ve strateji market kapanışları için `Ioc` + referans fiyat kodlaması (Faz 0-1'deki `p:""` sorununu çözer).
- Genişletilmiş REST API: bot CRUD, başlat/durdur/sil, acil durdurma.

**Kapsam dışı (2a):**
- Kalan 5 strateji → Phase 2b planı.
- Web paneli (Next.js), canlı grafikler, WS push → Phase 3-4.
- API anahtarı şifreleme (dokunmatik parola + NaCl) → Phase 3 ayarlar. 2a'da anahtar env'den okunmaya devam eder (`HUPER_HYPERLIQUID_PRIVATE_KEY`).
- Backtest → sonraki sürüm.

## 2. Mimari

```
packages/engine/src/
├─ framework/
│  ├─ strategy.ts      # Strategy arayüzü + StrategyCtx
│  ├─ runner.ts        # BotRunner — yaşam döngüsü, cadence, hata yakalama, persist
│  ├─ engine.ts        # Engine — MarketData, BotManager, RiskManager, StateStore, tick-loop
│  └─ registry.ts      # StrategyRegistry — isim → strateji sınıfı + params şeması
├─ risk/
│  └─ risk.ts          # RiskManager — validate() emir öncesi
├─ store/
│  ├─ db.ts            # better-sqlite3 bağlantısı + idempotent şema
│  └─ store.ts         # StateStore — bots/runs/orders/positions/equity repository'leri
├─ market/
│  └─ feed.ts          # MarketDataFeed — HL WS aboneliği, tick haritası
├─ emergency.ts        # EmergencyStop
├─ strategies/
│  ├─ grid.ts
│  ├─ dca.ts
│  └─ trend.ts
├─ exchange/           # Faz 0-1'den; live.ts market emir düzeltmesi dahil
├─ server.ts           # genişletilmiş REST
└─ main.ts             # bootstrap: store → exchange → feed → engine → server
```

**Bağımlılıklar:** mevcutlara ek olarak `better-sqlite3` (+ `@types/better-sqlite3` dev). Başka ek bağımlılık yok.

## 3. Strateji Arayüzü (framework/strategy.ts)

```ts
interface Strategy {
  readonly name: string;                       // registry anahtarı (örn. "grid")
  readonly paramsSchema: z.ZodType;            // doğrulanmış parametre şeması
  readonly cadenceMs: number;                  // bu bot için onTick sıklığı
  onStart(ctx: StrategyCtx): Promise<void>;
  onTick(tick: PriceTick, ctx: StrategyCtx): Promise<void>;
  onStop(ctx: StrategyCtx): Promise<void>;     // cleanup / açık emir iptali
}
```

```ts
interface StrategyCtx {
  readonly botId: string;
  readonly symbol: string;
  readonly params: Record<string, unknown>;    // şemadan doğrulanmış
  readonly getTick(): PriceTick;
  readonly createOrder(o: NewOrder): Promise<Order>;   // RiskManager kapısından geçer
  readonly cancelOrder(orderId: string): Promise<void>;
  readonly getPositions(): Position[];
  readonly getBalance(): number;
  readonly state: BotState;                    // kalıcı JSON blob (bot başına)
  readonly log(msg: string, meta?: unknown): void;
}
```

- `BotState`: stratejinin her onTick sonunda atomik yazılan kalıcı bir `Record<string, unknown>` — Grid seviyeleri, DCA basamakları, Trend son sinyal durumu burada tutulur.
- Yeni bot = yeni `Strategy` alt sınıfı + `registry.ts`'e bir satır. Motor değişmez.

## 4. Engine Döngüsü (paylaşılan tick-loop)

- `MarketDataFeed`, yapılandırılmış semboller için HL WS'den `allMids` (ve istersen `l2Book`) aboneliği tutar, `Map<symbol, PriceTick>` günceller.
- Her tick'te:
  - **paper mod:** tick, `PaperExchange.pushTick`'e verilir (limit dolum eşleşmesi için).
  - **tüm modlar:** engine, sembolü bu botun sembolüyle eşleşen ve `now - lastEval >= cadenceMs` olan her çalışan bot için `runner.evaluate(tick)` çağırır.
- `BotRunner.evaluate`: tick'i stratejinin `onTick`'ine verir; istisna yakalar → botu `error` durumuna alır, durumu persist eder, emir bırakmaz. Sonra `BotState`'i persist eder.
- Trend indikatörleri (EMA, RSI, MACD) strateji içinde, bot başına akümüle edilmiş kapanış fiyatları üzerinden hesaplanır (2a'da ek indikatör kütüphanesi yok).

## 5. RiskManager (risk/risk.ts)

`validate(attempt)` çağrısı, `createOrder`'ın ExchangeAdapter'e ulaşmadan önce geçtiği tek kapı:

```ts
interface OrderAttempt {
  botId: string;
  symbol: string;
  side: Side;
  price: number | null;       // limit fiyat; null = market
  size: number;
  kind: "limit" | "market";
  reduceOnly?: boolean;       // pozisyon kapatan emirler
}
```

Kurallar (tümü config'ten; varsayılanlar parantezde):
1. **Maks. pozisyon:** yeni toplam boyut (notional) ≤ küresel üst sınır (hesap değerinin `%50`'si) VE ≤ bot-başına üst sınır (hesap değerinin `%20`'si).
2. **Emir başına sermaye %:** `notional = price × size` ≤ `balance × cfg.maxOrderNotionalPct` (`%5`).
3. **Kopya emir engeli:** aynı `symbol+side+price(±0)+size` emir `2000ms` içinde tekrar gönderilmez (son emirler ring tamponu).
4. **Fiyat sıçraması koruması:** limit emri, son işlem fiyatının `cfg.maxPriceDriftPct` (`%5`) ötesindeyse reddedilir; `reduceOnly` market emirleri muaf.
5. **Min/max boyut:** `cfg.minOrderSize` (`0.001`, sembole göre yapılandırılabilir) / `cfg.maxOrderSize` (yok = `%5` sermaye kuralı sınırlar).

Dönüş: `{ ok: true } | { ok: false, reason: string }`.

## 6. SQLite Durum Deposu (store/)

better-sqlite3 (senkron, prebuild binary'ler win32/alpine-musl). Şema (idempotent, `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, strategy TEXT NOT NULL,
  symbol TEXT NOT NULL, params TEXT NOT NULL,        -- JSON
  status TEXT NOT NULL,                              -- running | stopped | error
  state TEXT NOT NULL DEFAULT '{}',                  -- JSON (BotState)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, mode TEXT NOT NULL,
  started_at INTEGER NOT NULL, stopped_at INTEGER, stop_reason TEXT
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, bot_id TEXT, exchange_id TEXT, symbol TEXT NOT NULL,
  side TEXT NOT NULL, price REAL, size REAL NOT NULL, status TEXT NOT NULL,
  filled_size REAL NOT NULL DEFAULT 0, avg_price REAL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE positions (
  id TEXT PRIMARY KEY, bot_id TEXT, symbol TEXT NOT NULL, side TEXT NOT NULL,
  size REAL NOT NULL, avg_entry REAL NOT NULL, mark_price REAL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE TABLE equity (
  id TEXT PRIMARY KEY, bot_id TEXT, ts INTEGER NOT NULL, value REAL NOT NULL
);
```

- `StateStore`: satır repository'leri + `bots.state` atomik güncelleme + `runs` oturum aç/kapa. Senkron; tüm engine yazımları tek process'te (paylaşılan tick-loop → tek yazar).
- Pozisyon kapandığında `closed_at` set edilir, `realized_pnl` güncellenir, pozisyon satırı tutulur (geçmiş için).

## 7. Acil Durdurma (emergency.ts)

`POST /emergency-stop` veya otomatik (private-key/auth hatasında) tetiklenir:
1. Tüm botları `stopped` yap (runs'ı `emergency` sebebiyle kapat).
2. Tüm açık emirleri iptal et (live: `cancel`; paper: kaldır).
3. Tüm açık pozisyonları market kapat (Ioc).
4. Durumu persist et, sonucu özet olarak döndür.
5. Idempotent: ikinci çağrı hiçbir işlem yapmazsa `{ ok: true, changed: false }`.

## 8. LiveExchange Market Emir Düzeltmesi

Faz 0-1'de market emri `p: ""` gönderiyordu (SDK validator reddi). 2a'da `placeOrder` market türünü `{ t: { limit: { px: <ref>, sz, tif: "Ioc" } } }` olarak kodlar; `ref` = tick cache'teki son mid (yoksa hata fırlatır). Acil kapanış ve strateji market kapanışları bu yolu kullanır.

## 9. Genişletilmiş REST API (server.ts)

Mevcut `/health`, `/ticks/:symbol`, `/orders`, `/balances`, `/positions` korunur. Ekler:
- `POST /bots` — body `{ name, strategy, symbol, params, mode }` → 201
- `GET /bots` → bot listesi (state + özet)
- `GET /bots/:id` → bot detayı (son emirler, açık pozisyonlar, run'lar)
- `POST /bots/:id/start` → botu başlat (yeni run)
- `POST /bots/:id/stop` → botu durdur
- `DELETE /bots/:id` → botu sil (çalışıyorsa önce durdur)
- `POST /emergency-stop` → acil durdurma özeti

## 10. Hata Yönetimi

- Strateji istisnası → logla, botu `error` yap, durumu persist et, emir bırakma.
- WS kopması → `MarketDataFeed` yeniden bağlanır + yeniden abone olur (üstel geri dönme).
- API hatası → üstel geri dönme ile yeniden dene; kalıcıysa bot `error`, panelle raporlanır (Phase 3).
- Bilinmeyen istisna → bot durdurulur, emir bırakılmaz, durum SQLite'a yazılır.
- Acil durum → §7.

## 11. Test Stratejisi

- **Unit:** RiskManager kuralları (≥5 senaryo); StateStore CRUD roundtrip; registry kaydı.
- **Strateji:** Grid/DCA/Trend sentetik tick sekanslarıyla `PaperExchange` üzerinden deterministik (network'süz) — beklenen emirlerin açılışı/iptali, seviye/yeniden yerleşim davranışı doğrulanır.
- **Entegrasyon:** engine + paper + enjekte edilmiş tick'ler → bot başlat → emirler store'da; `emergency-stop` pozisyonları kapatır ve özet döndürür.
- **Manuel:** `npm run dev -w @huper/engine` paper; `POST /bots` + başlat/durdur + `POST /emergency-stop` REST çağrıları.

## 12. Doğrulama Kriterleri (2a)

- `npm run typecheck` (root) 0 hata; `npm test` tümü geçer.
- Yeni unit + strateji + entegrasyon testleri yeşil.
- Paper modda Grid/DCA/Trend botları sentetik fiyat akışında açık pozisyon + emir geçmişi üretir ve store'da okunur.
- `POST /emergency-stop` açık pozisyonları kapatır, botları durdurur, store güncellenir.

## 13. Phase 2b (sonraki plan)

Kalan stratejiler: Scalping, Breakout/Sinyal, Mean Reversion, Arbitraj tespiti, DCA-Kart. 2b spec+plan, 2a çerçevesi üzerine kurulur.
