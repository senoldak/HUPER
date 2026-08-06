# HUPER — Hyperliquid Bot Platform

Tek kullanıcılı Hyperliquid perp trading bot platformu. `paper` (simülasyon) ve `live` (gerçek emir) modlarını destekler.

## Geliştirme (lokal)

    npm install
    npm run dev -w @huper/engine   # paper mod, http://localhost:3001
    npm run typecheck
    npm test

Canlı mod: repo kökündeki `.env` dosyasına `HUPER_MODE=live` ve `HUPER_HYPERLIQUID_PRIVATE_KEY=0x...` koy (engine başlarken `.env` otomatik okunur; `HUPER_MODE` boşsa varsayılan `paper`).

## Risk limitleri

Varsayılan risk yapılandırması `packages/core/src/types.ts` içindeki `DEFAULT_RISK`'tir:

- `maxOrderNotionalPct: 0.05` — tek emrin notional değeri, bakiye'nin %5'ini aşamaz.
- `perBotMaxPositionPct: 0.2` / `globalMaxPositionPct: 0.5` — pozisyon büyüklüğü bakiye'nin %20/%50'sini aşamaz.
- `maxPriceDriftPct: 0.05` — limit emir fiyatı son fiyattan %5'ten fazla sapamaz.

Örnek: 10.000 USDC bakiyeyle BTC'de grid botu kurarken `orderSize`'ı `0.05 × 10000 / BTC_fiyatı` olarak hesapla (yaklaşık 0.0077 BTC @ $65k). Daha büyük boyutlar emir reddine ("exceeds order notional cap") yol açar.

## Docker (VPS)

    cp .env.example .env
    docker compose up --build engine
