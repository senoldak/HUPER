# HUPER — Phase 2c Tasarımı: Web Paneli (Statik SPA)

**Tarih:** 2026-08-06
**Durum:** Onaylandı (brainstorming süreci)
**Üst doküman:** `docs/superpowers/specs/2026-08-05-huper-design.md`
**Öncül faz:** Phase 2b tamamlandı (commit 92ea40c)

## 1. Kapsam (2c)

Engine'in Fastify HTTP API'sinin üzerine, tarayıcıdan bot yönetimi ve durum izleme sağlayan bir web paneli eklenir. Yeni strateji, canlı WS push, auth, anahtar şifreleme YOKTUR — bunlar sonraki fazlara aittir.

**2c kapsamında:**
- Statik tek-sayfa panel (`public/`), Fastify `@fastify/static` ile root'tan servis edilir.
- Üç görünüm: **Genel Bakış** (bakiye, açık pozisyonlar, sembol fiyatları, equity grafiği), **Botlar** (oluştur/başlat/durdur/sil), **Bot Detay** (emir + pozisyon + run geçmişi).
- Equity zaman serisi kaydı: engine periyodik `recordEquity()` ile store'a yazar, panel canvas ile çizer.
- Panel verisi 2sn polling ile tazelenir (WS push yok).

**Kapsam dışı (2c):**
- WS push / SSE — polling 2sn bu bot için yeterli. → sonraki faz.
- Auth / çoklu kullanıcı — tek kullanıcılı lokal araç.
- Yeni stratejiler (Scalping, Breakout, vb.) → sonraki faz.
- Anahtar şifreleme → Phase 3.
- Canlı (live) modda uçtan uca doğrulama — canlı key mevcut değil; panel paper mod üzerinden test edilir.

## 2. Mimari

Mevcut düzene yalnızca eklemeler; hiçbir mevcut dosya davranışı değişmez.

```
packages/engine/src/
├─ server.ts                # + @fastify/static (public/) + GET /equity
├─ main.ts                  # + equity kayıt interval'i (5sn) + clearInterval(stop)
├─ framework/engine.ts      # + recordEquity()
├─ store/store.ts           # + listEquity(botId?, limit?)
├─ store/types.ts           # + EquityRow
├─ public/                  # YENİ: index.html + app.js + style.css
└─ tests/                   # server.test.ts uzantısı + store.test.ts uzantısı
```

### Veri akışı

- **Panel → engine (polling 2sn):** `fetch` ile `/bots`, `/balances`, `/positions`, `/ticks/:symbol`, `/equity?limit=200`.
- **Engine → store (interval 5sn):** `engine.recordEquity()` → `exchange.balances()` → `store.appendEquity({ botId: null, value: total })`.
- **Panel (tarayıcı):** tek `index.html`, vanilla JS, dark tema, canvas çizgi grafik.

## 3. Bileşen Açıklamaları

### 3.1 Store: `listEquity` (store.ts, types.ts)

`types.ts`'e eklenir:
```ts
export interface EquityRow {
  id: string; bot_id: string | null; ts: number; value: number;
}
```

`store.ts`'e eklenir (`appendEquity` zaten mevcut):
```ts
listEquity(botId?: string, limit?: number): EquityRow[] {
  // botId === undefined → global kayıtlar (bot_id IS NULL)
  // botId verildiyse → o botun kayıtları
  // ORDER BY ts DESC, limit varsa LIMIT ? ; sonucu ts ASC'e çevir (grafik için)
}
```

`limit` varsayılan olarak 200 (panel çağrısı `?limit=200`). İmza: `listEquity(botId?: string, limit?: number)` — `botId: undefined` global, `botId: "x"` bot-scoped.

### 3.2 Engine: `recordEquity` (engine.ts)

```ts
async recordEquity(): Promise<void> {
  const b = await this.exchange.balances();
  if (b.length > 0) this.store.appendEquity({ id: randomUUID(), botId: null, ts: Date.now(), value: b[0].total });
}
```

Not: `recordEquity` doğrudan `balances()` çağırır (refreshMeta debounce'undan bağımsız); interval 5sn > 1sn debounce olduğundan çakışma yok.

### 3.3 main.ts: equity interval

```ts
const equityTimer = setInterval(() => {
  void engine.recordEquity().catch((e) => log.warn({ err: (e as Error).message }, "equity record failed"));
}, 5000);
```
`stop()` içinde `clearInterval(equityTimer)` çağrılır. `engine.stop()`'a eklenebilir veya main'in stop closure'ında tutulur — main'de `stop` kapanışında temizlenir.

### 3.4 server.ts: statik + yeni uç

- `@fastify/static` bağımlılığı `@huper/engine`'e eklenir (yeni dev-dep değil, runtime dep).
- `public/` klasörü root'tan servis:
```ts
await app.register(fastifyStatic, { root: fileURLToPath(new URL("../public", import.meta.url)), prefix: "/" });
```
(register `async` olduğu için `buildApp` zaten `FastifyInstance` döner — register await edilebilir veya promise'li kalır; mevcut `buildApp` `await`'siz register kullanıyor, statik register da böyle bırakılabilir, fastify register'ları lazy'dir.)

- Yeni uç:
```ts
app.get<{ Querystring: { limit?: string } }>("/equity", async (req) => {
  const limit = req.query.limit ? Math.max(1, Math.min(1000, Number(req.query.limit) || 200)) : 200;
  return opts.engine.store.listEquity(undefined, limit);
});
```

`server.ts`'in `buildApp(opts)` imzasına `store`'u geçirmek gerekebilir — mevcut imza `{ exchange, engine }`. Seçenek A: `buildApp`'e `store` eklemek (`main.ts` çağrısı güncellenir, `server.test.ts` güncellenir). Seçenek B: `engine.listEquity(...)` delegasyon metodu. **Karar: B** — `Engine.listEquity` delegasyonu, `server.ts` imzası değişmez, testler minimal etkilenir.

`Engine`'e eklenecek:
```ts
listEquity(limit?: number): EquityRow[] { return this.store.listEquity(undefined, limit); }
```

### 3.5 Panel (public/)

Üç dosya, vanilla, hiç framework yok:

- **index.html:** header (başlık + mod etiketi), tab bar (Genel Bakış / Botlar), bölümler; canvas + tablolar; `app.js`/`style.css` referansları.
- **app.js:**
  - `poll()` → 2sn'de bir `Promise.all` ile `/balances`, `/positions`, `/bots`, `/equity?limit=200` çeker, DOM günceller. `/ticks/:symbol` botlardaki semboller için ayrıca çekilir.
  - Tab geçişleri, bot seçimi (detay görünümü `/bots/:id`), bot oluşturma formu (strateji seçici + dinamik parametre alanları: grid `levels/spacingPct/orderSize`, dca `stepPct/takeProfitPct/totalSteps/baseSize/sizeMultiplier`, trend `fastEma/slowEma/orderSize/rsiPeriod/oversold/overbought/stopLossPct/takeProfitPct`), start/stop/sil butonları.
  - Equity grafiği: canvas üzerine basit çizgi; son değer kartı serinin son noktasından.
- **style.css:** dark tema, kart yapısı, tablolar, buton durumları (running yeşil / stopped gri / error kırmızı).

Panel test edilmez (statik dosya), ancak `GET /` 200 + HTML DOM temel yapısı server testinde doğrulanır.

## 4. Hata Yönetimi

- Equity kayıt hatası → `log.warn`, interval ölmez (catch'li).
- Panel fetch hatası → sessiz, sonraki poll'da yeniden dener; boş veride "yükleniyor" durumu.
- `/bots` oluşturma hatası → backend `400` döner, panel toast (kırmızı metin) gösterir.
- `@fastify/static` 404'ü passthrough (API 404'leri etkilenmez).

## 5. Test & Doğrulama

- `store.test.ts`: `listEquity` — global (bot_id NULL) filtre, `limit` uygulaması, DESC sıralama, botId'li kayıtların global'den hariç tutulması.
- `server.test.ts`:
  - `GET /equity?limit=5` → 200, uzunluk + sıralama.
  - `GET /` → 200 (index.html servisi).
  - Mevcut API uçları hâlâ çalışıyor (statik passthrough çakışması yok).
- `recordEquity` birim testi: PaperExchange üzerinden çağır → `store.listEquity()` boş değil. (Interval kullanılmaz, doğrudan metod çağrısı — deterministik.)
- Doğrulama: `npm run typecheck` 0 hata, `npm test -w @huper/engine` yeşil.
- Manuel: `npm run dev -w @huper/engine` → `http://localhost:3001` panel görsel kontrol: bot oluştur/başlat/durdur, equity grafiği büyür, fiyatlar tazelenir.

## 6. Sıralama (Önerilen)

1. Store + types (`listEquity`, `EquityRow`) + test.
2. Engine (`recordEquity`, `listEquity` delegasyonu) + test.
3. main.ts interval + temizlik.
4. server.ts statik + `/equity` ucu + `@fastify/static` dep + test.
5. Panel (public/: html/js/css).

Her adım test + subagent review ile ilerler (`@huper/engine` içinde, strict TS, ESM `.js` import).