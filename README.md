# HUPER

Hyperliquid bot platform — monorepo.

## Workspaces

- `packages/core` — shared types, config, and utilities (`@huper/core`)
- `packages/engine` — bot engine / Hyperliquid exchange layer (`@huper/engine`)

## Scripts (root)

- `npm run typecheck` — type-check all workspaces
- `npm test` — run all workspace tests
- `npm run build` — build all workspaces

## Environment

Copy `.env.example` to `.env` and fill in the values.
