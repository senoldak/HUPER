# Phase 3a Design: Güvenlik & Teknik Borç Kapanışı

**Tarih:** 2026-08-06
**Durum:** Onaylandı (brainstorming süreci)

## 1. Özet

Phase 2 boyunca bilinçli olarak ertelenen güvenlik ve teknik borç öğelerini kapatır. Üç değişiklik grubundan oluşur: (1) paper exchange `reduceOnly` flip koruması, (2) panel XSS fix'i, (3) risk limitleri dokümantasyonu. Kod davranışını değiştirmeden gerçek borsa tutarlılığını ve güvenliği sağlar, kullanıcıya emir boyutu seçiminde rehberlik eder.

## 2. Amaçlar & Başarı Kriterleri

- Paper exchange `reduceOnly` emirleri asla pozisyonu ters tarafa döndüremez (gerçek borsa davranışıyla tutarlı).
- Panel, kullanıcı tarafından üretilen bot adları/parametrelerini HTML olarak yorumlamaz (XSS kapatılır).
- Kullanıcı, risk limitleri nedeniyle emirlerin neden reddedildiğini dokümantasyondan anlar.

## 3. Kapsam

### 3.1 Paper exchange `reduceOnly` flip koruması

**Dosya:** `packages/engine/src/exchange/paper.ts`

**Davranış:** `reduceOnly: true` emirler, emrin yönüyle **ters yönde açık pozisyon** yoksa doldurulmaz (reddedilir). Ayrıca emir boyutu karşı pozisyondan büyük olsa bile dolum **pozisyon boyutuyla sınırlanır** — pozisyon asla ters tarafa dönmez.

- `placeOrder()` başında kontrol: emir `sell` ise `Buy` pozisyonu aranır; emir `buy` ise `Sell` pozisyonu aranır. Karşı yön pozisyon yoksa `throw new Error("reduce-only order rejected: no opposing position")`.
- Karşı yön pozisyon **varsa** ama emir boyutu pozisyondan büyükse, dolum yalnızca pozisyon boyutu kadar gerçekleşir (kalan kısım dolmaz — emir boyutu `filledSize`'e yansır, pozisyon kapanır, flip olmaz).
- Reddedilen emir oluşturulmaz (emir kaydı tutulmaz). Hata `Engine.executeOrder` üzerinden çağıran tarafa iletilir (strateji/HTTP 400).

**Neden throw:** Emir doldurulmadan no-op Order dönmek, stratejinin "emir yerleşti" sanarak state'i yanlış kurmasına yol açar. Throw gerçek borsa reddini simüle eder ve mevcut hata akışına oturur.

**Uygulama notu:** `applyFill`'te reduceOnly emirler için kullanılan `size`, karşı pozisyonun mevcut boyutuyla `Math.min` ile sınırlanır. Bu sayede hem `addPosition`/`reducePosition`'daki `remaining < 0` dalı tetiklenmez hem de kısmi dolum mantığı korunur.

### 3.2 Panel XSS fix (A2 — HTML üreten hücreler kendi escape eder)

**Dosya:** `packages/engine/public/app.js`

**İlke (A2):** `setTable` her hücre çıktısını escape eder (güvenli varsayılan); HTML üreten hücreler (status, actions) kendi statik HTML'lerini inline bırakır, dinamik değerleri `escapeHtml`'den geçirir.

`setTable`:
```js
td.innerHTML = escapeHtml(cell(row, c, i));
```

`escapeHtml` yardımcısı (app.js'e eklenir):
```js
function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
```

`status` hücresi:
```js
if (c === "status") return `<span class="${escapeHtml(STATUS_CLASS[r.status] || "")}">${escapeHtml(r.status)}</span>`;
```

`actions` hücresi:
```js
if (c === "actions") {
  const verb = r.status === "running" ? "stop" : "start";
  const label = r.status === "running" ? "Durdur" : "Başlat";
  return `<button data-act="${verb}" data-id="${escapeHtml(r.id)}">${label}</button>
          <button data-act="detail" data-id="${escapeHtml(r.id)}">Detay</button>
          <button data-act="del" data-id="${escapeHtml(r.id)}" class="danger">Sil</button>`;
}
```

`detail-orders`/`detail-positions`/`detail-runs` tabloları aynı `setTable`'dan geçtiği için otomatik escape edilir. `detail-name` zaten `textContent` ile yazılır (güvenli). `detailId` gibi JS değişkenleri `innerHTML`'e girmez.

### 3.3 Risk dokümantasyon notu

**Dosya:** `README.md` — "Geliştirme" bölümünden sonra yeni "Risk limitleri" bölümü:

```markdown
## Risk limitleri

Varsayılan risk yapılandırması `packages/core/src/types.ts` içindeki `DEFAULT_RISK`'tir:

- `maxOrderNotionalPct: 0.05` — tek emrin notional değeri, bakiye'nin %5'ini aşamaz.
- `perBotMaxPositionPct: 0.2` / `globalMaxPositionPct: 0.5` — pozisyon büyüklüğü bakiye'nin %20/%50'sini aşamaz.
- `maxPriceDriftPct: 0.05` — limit emir fiyatı son fiyattan %5'ten fazla sapamaz.

Örnek: 10.000 USDC bakiyeyle BTC'de grid botu kurarken `orderSize`'ı `0.05 × 10000 / BTC_fiyatı` olarak hesapla (yaklaşık 0.0077 BTC @ $65k). Daha büyük boyutlar emir reddine ("exceeds order notional cap") yol açar.
```

## 4. Kapsam Dışı (bilinçli)

- `LiveExchange`'e ek reduceOnly koruması — gerçek borsa zaten `r: true` bayrağına göre uygular; kod API'ye bayrağı gönderiyor.
- Risk config varsayılan değişikliği — mevcut değerler geçerli, sadece dokümante edilir.
- Diğer güvenlik öğeleri (auth, secrets, vb.) — ayrı ilerideki phase'lere.

## 5. Testler

### 5.1 Paper reduceOnly (`packages/engine/tests/paper.test.ts`)
- `reduceOnly` sell emir, `Buy` pozisyon yokken → `rejects` ("no opposing position").
- `reduceOnly` buy emir, `Sell` pozisyon yokken → `rejects`.
- `reduceOnly` sell emir, `Buy` pozisyon varken ve emir ≤ pozisyon → dolar, pozisyonu azaltır, taraf flip olmaz.
- `reduceOnly` emit, pozisyon büyük (emir > pozisyon) → pozisyon kapanır, taraf değişmez (clamp).
- `reduceOnly: false` normal emirler etkilenmez (ters yönde pozisyon olmasa da dolar) — regresyon.
- `reduceOnly` aynı yön pozisyon (ör. `sell` ile `Sell` pozisyonu) → karşı yön pozisyon olmadığı için `rejects`.

### 5.2 Panel escape (string assertion + manuel smoke)
- `packages/engine/tests/server.test.ts` içine `/app.js` içinde `escapeHtml` fonksiyonu var olduğunu string-assert eden bir test eklenir (yeni mantık değil, varlık doğrulaması).
- Manuel smoke: tarayıcıda XSS payload'ı içeren bot adı oluşturup panelde metin olarak göründüğü (HTML olarak yorumlanmadığı) doğrulanır.

## 6. Değişen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `packages/engine/src/exchange/paper.ts` | `reduceOnly` koruması |
| `packages/engine/tests/paper.test.ts` | 5 yeni test |
| `packages/engine/public/app.js` | `escapeHtml` + A2 escape |
| `packages/engine/tests/server.test.ts` | `/app.js` varlık assertion'u |
| `README.md` | Risk limitleri bölümü |

## 7. Doğrulama

- `npm run typecheck` → 0 hata.
- `npm test -w @huper/engine` → mevcut 54 + ~6 yeni test geçer.
- Manuel smoke: XSS payload isimli bot oluştur → panelde metin olarak görünür; reduceOnly ters-pozisyonsuz senaryo reddedilir.

## 8. SDD Görevleri

Plan 3 görev olarak yazılacak: (1) paper reduceOnly + testler, (2) app.js escape + assertion, (3) README. Her biri kendi brief/review döngüsüyle.
