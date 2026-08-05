# HUPER — Hyperliquid Bot Platform

Tek kullanıcılı Hyperliquid perp trading bot platformu. `paper` (simülasyon) ve `live` (gerçek emir) modlarını destekler.

## Geliştirme (lokal)

    npm install
    npm run dev -w @huper/engine   # paper mod, http://localhost:3001
    npm run typecheck
    npm test

Canlı mod: `.env` içine `HUPER_MODE=live` ve `HUPER_HYPERLIQUID_PRIVATE_KEY=0x...` koy.

## Docker (VPS)

    docker compose up --build engine
