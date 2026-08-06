# HUPER — Hyperliquid Trading Engine & Bot Platform

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0-green.svg)](https://nodejs.org/)
[![Test Status](https://img.shields.io/badge/Tests-66%20passing-brightgreen.svg)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**HUPER** is a lightweight, high-performance, single-user automated trading engine and algorithmic bot platform designed specifically for **Hyperliquid Perpetual Futures**. Built with TypeScript and Node.js in an npm workspace monorepo, HUPER offers seamless dual-mode execution (`paper` simulation and `live` DEX trading), pre-trade risk controls, automated crash recovery, SQLite WAL state persistence, a REST API, and a built-in real-time Web Dashboard.

---

## Table of Contents

- [Key Features](#key-features)
- [Architecture Overview](#architecture-overview)
- [Monorepo Package Structure](#monorepo-package-structure)
- [Built-In Trading Strategies](#built-in-trading-strategies)
- [Risk Management & Safety Controls](#risk-management--safety-controls)
- [Web Dashboard & REST API](#web-dashboard--rest-api)
- [Configuration & Environment Variables](#configuration--environment-variables)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Local Installation](#local-installation)
  - [Running in Paper Mode](#running-in-paper-mode)
  - [Running in Live Mode](#running-in-live-mode)
  - [Running Tests & Typechecks](#running-tests--typechecks)
- [REST API Reference](#rest-api-reference)
- [Docker & VPS Deployment](#docker--vps-deployment)
- [Emergency Procedures](#emergency-procedures)
- [License & Disclaimer](#license--disclaimer)

---

## Key Features

- **Dual Execution Modes**:
  - `paper`: Complete local exchange simulation with synthetic market data feed, orderbook matching, price sweeps, and position PnL tracking.
  - `live`: Direct, high-speed WebSocket and HTTP integration with Hyperliquid L1 using `@nktkas/hyperliquid` SDK and Viem private key signing.
- **Built-In Strategy Engine**: Out-of-the-box support for Grid Trading, Dollar-Cost Averaging (DCA), and Trend Following (EMA Crossover + RSI).
- **Pre-Trade Risk Management**: Strict risk gate protecting against over-leverage, size drift, excessive order notional, duplicate orders, and bad limit pricing.
- **State Persistence & Crash Recovery**: SQLite database using Write-Ahead Logging (`WAL` mode) preserving bot instances, order history, fill execution details, positions, and equity balance over time. Automatically detects ungraceful crashes on boot and safely updates stale state.
- **Panic Emergency Stop**: One-click REST/UI trigger that immediately stops all active strategies, cancels pending open orders, and market-flattens all active exchange positions with `reduceOnly` orders.
- **Real-Time Web Dashboard**: Built-in dark-themed UI hosted directly by the engine for visual monitoring of equity curves, live ticks, bot status, active positions, and manual controls.

---

## Architecture Overview

```
                          ┌──────────────────────────┐
                          │   Browser Dashboard UI   │
                          └────────────┬─────────────┘
                                       │ HTTP / REST
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             HUPER ENGINE SERVER                             │
│                                                                             │
│  ┌───────────────────┐     ┌───────────────────┐     ┌───────────────────┐  │
│  │   Fastify REST    │     │  Strategy Engine  │     │   Risk Manager    │  │
│  │   API & Dashboard │────►│   & Bot Runners   │────►│  (Pre-Trade Gate) │  │
│  └───────────────────┘     └─────────┬─────────┘     └───────────────────┘  │
│                                      │                                      │
│                                      ▼                                      │
│                            ┌───────────────────┐                            │
│                            │   SQLite Store    │                            │
│                            │    (WAL Mode)     │                            │
│                            └───────────────────┘                            │
│                                      │                                      │
│                                      ▼                                      │
│                         ┌─────────────────────────┐                         │
│                         │ Exchange Adapter Interface│                       │
│                         └────────────┬────────────┘                         │
└──────────────────────────────────────┼──────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │     PaperExchange     │             │     LiveExchange      │
        │ (Local Simulation &   │             │ (Hyperliquid DEX L1   │
        │  WebSocket Feed)      │             │  WS/HTTP + Viem Sign) │
        └───────────────────────┘             └───────────────────────┘
```

---

## Monorepo Package Structure

The repository is structured as an npm monorepo (`workspaces: ["packages/*"]`):

```
.
├── packages/
│   ├── core/                  # Base type definitions, schema validation, logger, risk config
│   │   ├── src/
│   │   │   ├── config.ts      # Zod env schema parser & environment validator
│   │   │   ├── logger.ts      # Structured Pino logger factory
│   │   │   ├── types.ts       # Shared domain models (Order, Position, Tick, ExchangeAdapter, RiskConfig)
│   │   │   └── index.ts       # Core entry exports
│   │   └── tests/             # Core unit tests
│   │
│   └── engine/                # Execution engine, REST server, exchange adapters, strategies
│       ├── src/
│       │   ├── exchange/      # PaperExchange & LiveExchange adapters, Hyperliquid mappings
│       │   ├── framework/     # Strategy lifecycle engine, BotRunner, StrategyRegistry
│       │   ├── market/        # WebSocket market data feed (Paper mode tick emitter)
│       │   ├── risk/          # Pre-trade RiskManager validator
│       │   ├── store/         # SQLite DB schemas & queries (bots, runs, orders, positions, equity)
│       │   ├── strategies/    # Grid, DCA, and Trend strategy implementations
│       │   ├── emergency.ts   # Emergency panic handler (stops bots & flattens positions)
│       │   ├── server.ts      # Fastify web server & endpoint routes
│       │   ├── recover.ts     # Startup crash recovery logic for stale bot states
│       │   └── main.ts        # Primary engine daemon entrypoint
│       ├── public/            # HTML/CSS/JS frontend dashboard
│       ├── Dockerfile         # Production container build definition
│       └── tests/             # Engine unit & integration tests
├── docker-compose.yml         # Containerized production stack configuration
├── package.json               # Root workspace manifest
└── tsconfig.base.json         # Base TypeScript configuration
```

---

## Built-In Trading Strategies

HUPER comes pre-packaged with three customizable strategy modules registered in the `StrategyRegistry`:

### 1. Grid Strategy (`grid`)
- **Concept**: Places symmetric buy and sell limit orders around a central price baseline across predefined percentage grid levels.
- **Execution**: On fill of a buy order, it automatically places a take-profit sell order at the higher level, and vice-versa.
- **Parameters**:
  - `levels` *(number, 1..50)*: Number of grid levels above and below baseline.
  - `spacingPct` *(number, max 0.1)*: Percentage gap between adjacent grid levels (e.g. `0.01` = 1%).
  - `orderSize` *(number)*: Order quantity per level.

### 2. Dollar-Cost Averaging Strategy (`dca`)
- **Concept**: Establishes an initial market position and scales in with multiplied size as price drops by a configured percentage, exiting via target profit levels.
- **Execution**: Automatically steps down order entry pricing on price pullbacks up to a maximum step count.
- **Parameters**:
  - `stepPct` *(number, max 0.2)*: Percentage dip required to trigger next DCA tier.
  - `takeProfitPct` *(number, max 0.5)*: Target unrealized profit percentage to close position.
  - `totalSteps` *(number, 1..20)*: Maximum number of averaging scale-in orders.
  - `baseSize` *(number)*: Initial order size.
  - `sizeMultiplier` *(number, 1..5)*: Multiplier applied to size on subsequent steps.

### 3. Trend Following Strategy (`trend`)
- **Concept**: Technical indicator strategy utilizing Exponential Moving Average (EMA) crossovers combined with Relative Strength Index (RSI) momentum filters.
- **Execution**: Long on bullish EMA cross with RSI > 50; Short on bearish EMA cross with RSI < 50. Manages dynamic stop-loss and take-profit thresholds.
- **Parameters**:
  - `fastEma` *(number, 1..20)*: Fast EMA period length.
  - `slowEma` *(number, 2..100)*: Slow EMA period length.
  - `rsiPeriod` *(number, 2..30)*: RSI calculation period.
  - `oversold` / `overbought` *(numbers)*: Momentum boundaries.
  - `stopLossPct` / `takeProfitPct` *(numbers)*: Maximum allowed drawdown and profit exit caps.
  - `orderSize` *(number)*: Order execution quantity.

---

## Risk Management & Safety Controls

Every order requested by a strategy must pass through the `RiskManager` prior to being dispatched to the exchange adapter. The default risk configuration (`DEFAULT_RISK`) enforces strict capital protection boundaries:

| Parameter | Default Value | Description |
|---|---|---|
| `maxOrderNotionalPct` | `0.05` (5%) | Maximum notional value of a single order relative to total account equity. |
| `perBotMaxPositionPct` | `0.20` (20%) | Maximum combined position size allocated to any single bot instance. |
| `globalMaxPositionPct` | `0.50` (50%) | Maximum total position exposure across all bots on the account. |
| `maxPriceDriftPct` | `0.05` (5%) | Maximum allowed limit price deviation from current market price. |
| `duplicateGuardMs` | `2000` (2s) | Time window to reject identical duplicate orders submitted by the same bot. |
| `minOrderSize` | `0.001` | Minimum allowable order quantity. |
| `maxOrderSize` | `null` (Unlimited) | Optional upper bound ceiling for individual order size. |

> **Example Calculation**:
> With a $10,000 USDC balance, `maxOrderNotionalPct` (5%) limits any single BTC order to **$500 notional**. At a $65,000 BTC price, your order size must not exceed ~`0.00769 BTC`. Orders exceeding this bound will be rejected before submission.

---

## Web Dashboard & REST API

HUPER runs an integrated web interface served directly from the engine at `http://localhost:3001`.

- **Overview Tab**: Real-time display of total USDC account balance, dynamic equity curve graph, current active positions, and live price tickers.
- **Bots Tab**: Interactive control panel to create new bots, select strategies, configure custom parameters, start/stop execution, or delete bots.
- **Bot Detail View**: Drill down into specific bot instances to inspect past order logs, closed/open position histories, and runtime execution logs.

---

## Configuration & Environment Variables

Environment variables are defined in `.env` (refer to `.env.example`):

```bash
# Execution mode: "paper" (simulation) or "live" (real Hyperliquid DEX)
HUPER_MODE=paper

# Required in live mode: Hyperliquid wallet ed25519 private key (0x + 64 hex characters)
HUPER_HYPERLIQUID_PRIVATE_KEY=

# Initial simulated USDC balance for paper mode (default: 10000)
HUPER_PAPER_BALANCE=10000

# Hyperliquid API RPC endpoint (default: https://api.hyperliquid.xyz)
HUPER_RPC_URL=https://api.hyperliquid.xyz

# Hyperliquid WebSocket endpoint (default: wss://api.hyperliquid.xyz/ws)
HUPER_WS_URL=wss://api.hyperliquid.xyz/ws

# Database storage file path (default: data/huper.db, or ":memory:" for tests)
HUPER_DB_PATH=data/huper.db

# Web server listening port (default: 3001)
PORT=3001
```

---

## Getting Started

### Prerequisites

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Docker & Docker Compose** *(optional for containerized deployment)*

### Local Installation

Clone the repository and install all monorepo dependencies:

```bash
git clone https://github.com/your-org/huper.git
cd huper
npm install
```

### Running in Paper Mode

Paper mode creates a simulated environment with $10,000 in virtual USDC and connects to Hyperliquid WebSocket price feeds:

```bash
# Build core workspace and start engine daemon
npm run dev -w @huper/engine
```

Open your browser and navigate to `http://localhost:3001` to access the Dashboard.

### Running in Live Mode

To operate on live Hyperliquid mainnet:

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Set `HUPER_MODE=live` and populate `HUPER_HYPERLIQUID_PRIVATE_KEY=0x...` with your wallet private key.
3. Start the engine:
   ```bash
   npm run dev -w @huper/engine
   ```

### Running Tests & Typechecks

Run the full suite of unit & integration tests across all packages:

```bash
# Run Vitest test suite across workspaces
npm test

# Run TypeScript type checker across workspaces
npm run typecheck
```

---

## REST API Reference

The engine exposes a Fastify REST API on port `3001`:

### Health & Account
- `GET /health` — Check server status (`{ "ok": true }`).
- `GET /balances` — Fetch wallet balance and available margin.
- `GET /positions` — Fetch active exchange open positions.
- `GET /ticks/:symbol` — Get latest cached price tick for a symbol.
- `GET /equity?limit=200` — Retrieve historical equity curve series data points.

### Orders & Emergency
- `POST /orders` — Manually place an order on the exchange.
- `POST /emergency-stop` — Emergency trigger to stop all bots, cancel open orders, and flatten all positions via market `reduceOnly`.

### Bot Lifecycle Management
- `GET /bots` — List all registered bot summaries.
- `POST /bots` — Create a new bot instance (`{ name, strategy, symbol, params }`).
- `GET /bots/:id` — Get detailed bot metadata, orders, positions, and run histories.
- `POST /bots/:id/start` — Start bot execution loop.
- `POST /bots/:id/stop` — Stop bot execution loop.
- `DELETE /bots/:id` — Remove bot instance and associated historical records.

---

## Docker & VPS Deployment

For automated containerized deployment on a Linux VPS:

1. Create your production environment file:
   ```bash
   cp .env.example .env
   ```
2. Build and launch the container via Docker Compose:
   ```bash
   docker compose up --build -d engine
   ```
3. Inspect runtime logs:
   ```bash
   docker compose logs -f engine
   ```

---

## Emergency Procedures

In case of extreme market volatility or unexpected strategy behavior, you can trigger an emergency panic shutdown through multiple mechanisms:

1. **Via Dashboard UI**: Click the **Emergency Stop** control in the header.
2. **Via cURL Command**:
   ```bash
   curl -X POST http://localhost:3001/emergency-stop
   ```
3. **Behavior**:
   - Immediately stops all running `BotRunner` loops.
   - Updates bot runtime statuses to `stopped`.
   - Fetches active positions from the exchange.
   - Dispatches market `reduceOnly` orders to close all positions.
   - Reconciles local position store with exchange state.

---

## License & Disclaimer

### License
This project is open-source under the **MIT License**.

### Risk Disclaimer
> **WARNING**: Trading cryptocurrency perpetual futures involves significant financial risk. HUPER is provided "as is" without warranty of any kind. Always test strategies thoroughly in `paper` mode before committing real funds. The authors and maintainers assume no liability for financial losses incurred through the use of this software.
