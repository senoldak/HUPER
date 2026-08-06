# Phase 3b Design Spec: Panel "Adam Etme"

Tarih: 2026-08-06
Önceki: Phase 2c (panel), Phase 3a (güvenlik & borç kapanışı)

## 1. Özet

Panel API sağlıklı çalışıyor ama bot/pozisyon yokken tamamen boş görünüyor. Bu spec dört şeyi ekler: (1) sabit varsayılan takip listesi + kullanıcı ekleme/çıkarma (SQLite kalıcılığı), (2) boş-durum UX, (3) tam yeniden tasarım, (4) canlı fiyatların panelde görünmesi (feed zaten tüm coin'leri `allMids` ile alıyor, panel sadece göstermiyor).

## 2. Amaçlar & Başarı Kriterleri

- Panel açılışında "Fiyatlar" tablosu varsayılan listeyle dolu görünür (boş değil).
- Kullanıcı sembol ekleyip çıkarabilir; değişiklik sayfa yenilense de kalıcıdır.
- Hiç içerik yokken tablolar açıklayıcı boş-durum mesajları gösterir.
- Panel görünümü tutarlı koyu temayla yeniden tasarlanır.
- Mevcut işlevsellik bozulmaz (bot CRUD, detail, equity grafiği, reduceOnly/XSS koruması).
- Doğrulama: `npm run typecheck` 0 hata; core 7/7 + engine testleri geçer; manuel smoke PASS.

## 3. Kapsam

### 3.1 Watchlist (kalıcı)

**`db.ts`** — yeni tablo (bot'tan bağımsız, tek satırlık key-value):

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,      -- sabit 'default'
  symbols TEXT NOT NULL,    -- JSON string array
  updated_at INTEGER NOT NULL
);
```

**`store.ts`**:
- `getWatchlist(): string[]` — satır yoksa boş dizi döner (panel varsayılanı uygular).
- `setWatchlist(symbols: string[]): void` — upsert (`INSERT ... ON CONFLICT(id) DO UPDATE`).

**`server.ts`**:
- `GET /watchlist` → `{ symbols: string[] }`.
- `PUT /watchlist` body `{ symbols: string[] }` → 200 `{ ok: true }`.
  - Doğrulama: body bir nesne, `symbols` array, her öğe string; boş array kabul edilir; normalizasyon server'da yapılmaz (panel trim/uppercase yapar), ancak non-string → 400.

### 3.2 Panel (public/)

**`index.html`** — mevcut yapı korunur, "Fiyatlar" kartının başlık satırına watchlist widget'ı:
- Sembol ekleme input'u (`#watch-input`) + "Ekle" butonu.
- Fiyat tablosu kolonları aynı kalır (Sembol, Bid, Ask, Mid) + her satırda "Kaldır" butonu kolonu.

**`app.js`**:
- `DEFAULT_WATCHLIST = ["BTC","ETH","SOL","DOGE","LINK","AVAX","XRP","BNB"]`.
- `loadWatchlist()`: `GET /watchlist`; boşsa varsayılanı `PUT` ile kaydedip döner.
- `addSymbol()`, `removeSymbol()`: `trim().toUpperCase()` normalizasyon, tekrarları önle, `PUT` sonrası `poll()`.
- `poll()`: `syms = watchlist ∪ (bots ∪ positions sembolleri)`; her sembol için `GET /ticks/:symbol` → canlı satır.
- Boş-durum: `setTable` sonrası tbody boşsa tek `.empty` satırı (`<td colspan="N">mesaj</td>`):
  - pozisyonlar: "Henüz açık pozisyon yok"
  - fiyatlar: "Sembol eklemek için yukarıdaki input'u kullanın"
  - botlar: "Bot eklemek için yeni bot formunu kullanın"
  - detail tabloları: "Kayıt yok"
- "Kaldır" butonları event delegation: `#prices [data-rm]`.
- `escapeHtml` (Phase 3a) korunur; yeni dinamik değerler de escape edilir.

**`style.css` (tam yeniden tasarım)**:
- Palet: zemin `#0f172a`, kart `#1e293b`, kenarlık `#334155`, metin `#e2e8f0`, vurgu cyan `#22d3ee` / emerald `#10b981` / danger `#ef4444`.
- System font stack; `border-radius: 12px`; kart gölgeleri.
- Sticky header: logo + mod badge'i + bakiye.
- Tablolar: zebra, hover, sticky başlık.
- Tutarlı buton stilleri (primary/ghost/danger); durum badge'leri.
- Boş-durum `.empty` stili.
- Form grid; responsive (≥2 kolon, mobilde 1).

## 4. Hata Yönetimi

- `PUT /watchlist` geçersiz body → `400 { error }`.
- Coin yok / tick null → panel "—" gösterir (mevcut davranış).
- Panel fetch hataları sessiz `catch` + toast (mevcut desen).
- Duplicate sembol ekleme sessizce yok sayılır (toast bilgisi ile).

## 5. Testler

- `store.test.ts` +2: `getWatchlist` boşken `[]`; `setWatchlist` yazar + okur.
- `server.test.ts` +2: `GET /watchlist` → 200 array; `PUT` → ok + sonraki GET aynısı; geçersiz body → 400.
- Panel testi (string assertion, `server.test.ts`): `GET /app.js` body `DEFAULT_WATCHLIST` içerir.
- Doğrulama: `npm run typecheck` 0 hata; `npm test` core + engine; manuel smoke.

## 6. Değişen Dosyalar

- `packages/engine/src/store/db.ts`
- `packages/engine/src/store/store.ts`
- `packages/engine/src/server.ts`
- `packages/engine/tests/store.test.ts`
- `packages/engine/tests/server.test.ts`
- `packages/engine/public/app.js`
- `packages/engine/public/index.html`
- `packages/engine/public/style.css`

## 7. Sıralama (SDD Görevleri)

1. Store: tablo + `getWatchlist`/`setWatchlist` (TDD).
2. Server: `GET`/`PUT /watchlist` + doğrulama (TDD).
3. Panel: `app.js` watchlist + boş-durum UX (TDD — assertion test).
4. Tasarım: `style.css` + `index.html` (görünüm, test yok).

## 8. Kapsam Dışı (bilinçli)

- Sembol başına ayrı grafik / detay fiyat sayfası.
- Fiyat tablosuna % değişim / oklar (24s verisi yok).
- Çoklu kullanıcı / auth.
