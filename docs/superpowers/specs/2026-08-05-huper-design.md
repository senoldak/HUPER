# HUPER — Hyperliquid Bot Platformu Tasarım Dokümanı

**Tarih:** 2026-08-05
**Durum:** Onaylandı (brainstorming süreci)

## 1. Özet

Tek kullanıcılı, kişisel Hyperliquid perp trading bot platformu. Kullanıcı, çeşitli hazır stratejileri (grid, DCA, trend, scalping vb.) bir web panelinden oluşturup çalıştırır. Platform `paper` (simülasyon) ve `live` (gerçek emir) modlarını destekler. TypeScript/Node.js tabanlıdır, Docker ile paketlenir ve Windows(lokal) ile VPS'te birebir aynı çalışır.

## 2. Amaçlar & Başarı Kriterleri

- Çok çeşitli ve **genişletilebilir** bot kütüphanesi (yeni bot = yeni strateji sınıfı).
- Canlı Hyperliquid işlem yapabilme (sadece paper değil, gerçek para).
- Paper mod ile strateji test edip tek tuşla live ortamı geçme.
- Panel üzerinden canlı istatistikler, grafikler, P&L, pozisyon ve emir geçmişi.
- Windows'ta çalışır ve VPS'e kolayca taşınabilir (Docker).

## 3. Kapsam (v1)

### 3.1 Bot strateji kütüphanesi (8 çekirdek)
1. **Grid** — üst/alt bant arası N seviyeli al-sat; kademe adedi/aralık ayarlanabilir.
2. **DCA / Martingale** — düşüşte katmanlı alım, hedef kârda satış, kademe çarpanı.
3. **Trend Takip (EMA/RSI/MACD)** — indikatör sinyalleriyle long/short; stop-loss & take-profit.
4. **Scalping** — dar kâr hedefi, hızlı aç-kapa, mikro zaman dilimleri.
5. **Breakout / Sinyal** — fiyat seviyesi kırılmasında tetiklenen tek emir; SL/TP.
6. **Mean Reversion** — aşırı sapmada ortalamaya dönüş bahsi (RSI + Bollinger).
7. **Arbitraj tespiti** — fiyat farkı takibi; otomatik alım opsiyonel.
8. **DCA-Kart** — kullanıcının parametreleriyle esnek, açık uçlu DCA.

**Genişletilebilirlik:** `/strategies` klasörüne strateji sınıfı ekle, `registry.ts`'e kaydet → panelde form/parametre şeması otomatik görünür. Motor değişmez.

### 3.2 Trading modları
- **Paper:** Canlı Hyperliquid fiyat akışına karşı simüle dolum (limit eşleşmesi, kısmi dolum). Sanal bakiye, gerçek fiyatlar.
- **Live:** ed25519 API anahtarı (Hyperliquid API) ile gerçek emir gönderimi.

### 3.3 Emir güvenlik katmanı
- **Maks. pozisyon** limiti (küresel & bot başına).
- **Emir başına sermaye** limiti (hesabın %'si).
- **Kopya emir engeli:** aynı fiyat+boyutta emir 2 saniye içinde tekrar gönderilmez.
- **Fiyat sıçraması koruması:** son işlem fiyatının belirli % ötesinde limit emri gönderilmez.
- **Acil durdurma:** tüm botları durdur + tüm pozisyonları kapat (tek tuş / API anahtarı hatasında otomatik).

### 3.4 Web paneli
1. Dashboard (toplam P&L, pozisyon, aktif bot, günlük performans, canlı grafik)
2. Bot Listesi (kartlar: durum, P&L, başlat/durdur/kapat)
3. Bot Oluşturma sihirbazı (tür → form → paper/live → önizleme → çalıştır)
4. Bot Detay (grafik, pozisyonlar, emir geçmişi, getiri eğrisi)
5. Ayarlar (API anahtarı kurulumu — dokunmatik şifreli; risk limitleri; exchange yapılandırma)
6. Pozisyonlar (tüm açık pozisyonlar, tek tek kapat)
7. Acil durdur butonu (her zaman görünür)

## 4. Mimari

**Monorepo (npm workspaces):**

```
HUPER/
├─ packages/
│  ├─ core/          # Ortak tip, config, loglama
│  ├─ engine/        # Bot motoru (Node/TypeScript)
│  └─ web/           # Kontrol paneli (Next.js)
├─ docs/superpowers/specs/
├─ docker-compose.yml
```

**İki çalışan:**
- `engine`: sürekli arka planda; exchange bağlantısı, strateji loop'ları, emir yürütme, risk, durum.
- `web`: kullanıcı arayüzü; `engine` ile REST (komut) + WebSocket (canlı push).

**Durum deposu:** SQLite (bot, dönem, pozisyon, emir geçmişi, P&L). İki servisçe okunur.

**Exchange katmanı:** Hyperliquid WS (canlı fiyat/emir defteri) + REST (emir). `live` ve `paper` adaptörleri aynı `Exchange` arayüzü gerçekler; strateji kodu iki modda da aynıdır.

## 5. Veri Akışı

```
Hyperliquid WS ─► Exchange adaptörü ─► Canlı fiyat/defter (mem)
                        │
                        ▼
                Strateji motoru (her bot kendi loop'u)
                        │ sinyal üretin
                        ▼
              Emir kuyruğu → Risk filtreleri → REST emir (live)
                                          veya sahte dolum (paper)
```

## 6. Hata Yönetimi

- API hatası → üstel geri dönme (backoff) ile yeniden dene; kalıcıysa botu `hata` durumuna al, panelle raporla.
- WS kopması → otomatik yeniden bağlanma + yeniden al.
- Bilinmeyen istisna → bot durdurulur, emir bırakılmaz, durum SQLite'a yazılır.
- Acil durum → tüm bot kapat + pozisyon kapat.

## 7. Güvenlik

- Hyperliquid API anahtarı dokunmatik şifreleme (kullanıcı parolası, NaCl/ed25519 uyumlu kütüphane) ile saklanır; sadece `engine` tarafından çözülür. Düz metin dosyada tutulmaz. Panel ekranında anahtar gösterilmez.

## 8. Test

- Birim test: strateji mantığı, risk filtreleri, adaptör arayüzü (mock).
- Entegrasyon test: paper modunda uçtan uca bot çalıştırma (canlı fiyat veya test verisi).
- Manuel doğrulama: Docker komutlarıyla makine üzerinde canlı olmayan (paper) doğrulama.

## 9. Deployment

- `docker compose up` ile hem `engine` hem `web` ayağa kalkar.
- Windows geliştirme → aynı imaj VPS'e deploy edilir.
- Canlı kurulum için Hyperliquid API anahtarı kurulum adımları kullanıcıya rehberle anlatılır (hesap, anahtar üretme, signature ekleme).

## 10. Out of Scope (v1)

- Çok kullanıcılı kayıt/abonelik.
- Telegram bildirimi (isteğe bağlı gelecek).
- Tam backtest arayüzü (v1'de paper simülasyonu vardır; backtest sonraki sürüm).