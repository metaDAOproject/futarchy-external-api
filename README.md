# Futarchy External API

A multi-aggregator DEX API for the Futarchy protocol that automatically discovers all DAOs, providing real-time pricing, volume, and trading data to CoinGecko, DexScreener, and other consumers.

## Public API Documentation

**Base URL:** `https://your-api-domain.com`

---

### CoinGecko Endpoints

#### GET `/api/tickers`

Returns all DAO tickers with pricing, volume, and liquidity information. Automatically discovers all DAOs from the Futarchy protocol.

**Response:**
```json
[
  {
    "ticker_id": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "base_currency": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "target_currency": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "base_symbol": "ZKFG",
    "base_name": "ZKFG",
    "target_symbol": "USDC",
    "target_name": "USD Coin",
    "pool_id": "5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE",
    "last_price": "0.081340728222",
    "base_volume": "30024.81040000",
    "target_volume": "2441.23456789",
    "liquidity_in_usd": "180138.45",
    "bid": "0.080934024581",
    "ask": "0.081747431863",
    "high_24h": "0.085000000000",
    "low_24h": "0.078000000000",
    "startDate": "2025-01-15"
  }
]
```

**Fields:**
| Field | Description |
|-------|-------------|
| `ticker_id` | Format `{BASE_MINT}_{QUOTE_MINT}` |
| `base_currency` | Base token mint address |
| `target_currency` | Quote token mint address (usually USDC) |
| `base_symbol` / `base_name` | Base token symbol and name (from on-chain metadata) |
| `target_symbol` / `target_name` | Quote token symbol and name |
| `pool_id` | DAO address |
| `last_price` | Current price (quote/base) from spot pool reserves |
| `base_volume` / `target_volume` | Rolling 24h trading volume |
| `liquidity_in_usd` | Total liquidity in USD |
| `bid` / `ask` | Spread-adjusted bid/ask prices |
| `high_24h` / `low_24h` | 24h high/low (when available) |
| `startDate` | First trade date for the token |

**Volume source**: `futarchy.user_pool_spot_ohlcv` in the served ETL DB. If the
served DB is unavailable, the endpoint returns `503` instead of reporting zero volume.

---

### CoinMarketCap Endpoints

Implements the DEX endpoints from [Section C] of CoinMarketCap's integration
requirements. Served under `/cmc/`. The shapes mirror the CoinGecko adapter —
CMC's DEX spec is field-for-field close — and both feeds are built from the same
on-chain DAO discovery and rolling-24h ETL metrics.

`/cmc/summary` and `/cmc/ticker` carry 24h volume, so they require
`DATABASE_PG_URL` and return `503` (never zero volume) if the served DB is
unavailable. `/cmc/assets` is pure on-chain metadata and does not require it.

No dedicated auth: like every route, CMC reuses the shared rate-limit tiers —
anonymous by IP, or the elevated per-key bucket when a trusted `X-API-Key`
(`TRUSTED_API_KEYS`) is sent.

Set `CMC_ALLOWED_MINTS` (comma-separated base mints) to restrict the CMC feed to
a specific set of tokens; empty (the default) serves every discovered DAO.

#### GET `/cmc/summary`

24h overview of every tradeable pair.

**Response:**
```json
[
  {
    "trading_pairs": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "base_currency": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "quote_currency": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "last_price": 0.081340728222,
    "lowest_ask": 0.081747431863,
    "highest_bid": 0.080934024581,
    "base_volume": 30024.8104,
    "quote_volume": 2441.23456789,
    "highest_price_24h": 0.085,
    "lowest_price_24h": 0.078
  }
]
```

`highest_price_24h` / `lowest_price_24h` are omitted when the ETL window has no
real high/low. `price_change_percent_24h` is intentionally not reported — there
is no reliable 24h-ago open, and a fabricated `0%` would be worse than omitting.

#### GET `/cmc/ticker`

24h price and volume keyed by the `BASE_QUOTE` trading pair.

**Response:**
```json
{
  "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
    "base_id": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "quote_id": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "last_price": 0.081340728222,
    "base_volume": 30024.8104,
    "quote_volume": 2441.23456789,
    "isFrozen": 0
  }
}
```

#### GET `/cmc/assets`

Token identity keyed by mint address (both base and quote of every pair).

**Response:**
```json
{
  "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta": {
    "name": "ZKFG",
    "symbol": "ZKFG",
    "contractAddress": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "can_withdraw": "true",
    "can_deposit": "true",
    "maker_fee": 0.005,
    "taker_fee": 0.005
  }
}
```

---

### DexScreener Adapter Endpoints

Implements the [DexScreener Adapter Spec v1.1](https://dexscreener.notion.site/DEX-Screener-Adapter-Specs-cc1223cdf6e74a7799599106b65dcd0e). All endpoints are served under `/dexscreener/`. Requires `DATABASE_PG_URL` to be configured for the served DB.

#### GET `/dexscreener/latest-block`

Returns the latest Solana slot for which swap data is available.

**Response:**
```json
{
  "block": {
    "blockNumber": 312345678,
    "blockTimestamp": 1719500000
  }
}
```

#### GET `/dexscreener/asset?id=:mintAddress`

Returns token metadata for a given Solana mint address. Fetched from on-chain Metaplex Token Metadata.

**Response:**
```json
{
  "asset": {
    "id": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "name": "ZKFG",
    "symbol": "ZKFG",
    "metadata": {
      "decimals": "6"
    }
  }
}
```

#### GET `/dexscreener/pair?id=:daoAddress`

Returns immutable pair info for a DAO. Pair id is the `dao_addr` from the v0.6 indexer.

**Response:**
```json
{
  "pair": {
    "id": "5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE",
    "dexKey": "futarchy",
    "asset0Id": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "asset1Id": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "feeBps": 50,
    "createdAtBlockNumber": 290000000,
    "createdAtBlockTimestamp": 1710000000,
    "createdAtTxnId": "5xYz..."
  }
}
```

#### GET `/dexscreener/events?fromBlock=:slot&toBlock=:slot`

Returns swap events in the given Solana slot range (both inclusive). Events are queried from `v0_6_spot_swaps` in the external indexer DB.

**Response:**
```json
{
  "events": [
    {
      "block": { "blockNumber": 312345678, "blockTimestamp": 1719500000 },
      "eventType": "swap",
      "txnId": "5xYz...",
      "txnIndex": 0,
      "eventIndex": 0,
      "maker": "UserWalletAddress...",
      "pairId": "5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE",
      "asset1In": 100.5,
      "asset0Out": 1234.56,
      "priceNative": 0.08134
    }
  ]
}
```

**Event mapping:**
- **Buy** (user sends USDC → receives token): `asset1In` + `asset0Out`
- **Sell** (user sends token → receives USDC): `asset0In` + `asset1Out`
- `priceNative` = price of asset0 (base token) in asset1 (USDC)
- All amounts are decimalized (divided by `10^6`)

---

### Market Data

#### GET `/api/market-data?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&tokens=TOKEN1,TOKEN2`

Returns daily market data for the given date range, split by Futarchy AMM and Meteora sources.

**Data source**: both FutarchyAMM and Meteora data come from the unified
`futarchy.user_pool_daily` ETL table in the served DB. The served DB is a hard
dependency: if it's unreachable the endpoint returns `503` rather than reporting
a DB outage as zero volume.

- **FutarchyAMM** — `source = 'futarchy_amm'`, pivoted into spot, conditional, and total daily columns. Response `futarchyAMM.source` is `"etl-user-pool-daily"`.
- **Meteora** — `source = 'meteora'`, with the same daily accounting contract. Response `meteora.source` is `"etl-meteora-daily"`.

---

### Supply Endpoints

#### GET `/api/supply/:mintAddress`

Returns complete supply breakdown with allocation details for launchpad tokens.

#### GET `/api/supply/:mintAddress/total`

Returns total supply only (plain text number).

#### GET `/api/supply/:mintAddress/circulating`

Returns circulating supply — total minus team performance package.

---

### Health & Admin

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness: process status and uptime (no dependency checks) |
| `GET /api/health` | Readiness: served DB connectivity, ETL data contract, and data freshness |
| `GET /metrics` | Prometheus metrics (HTTP, served-DB health gauges, heartbeat) |

`/api/health` reports `status: "degraded"` (with a `message`) when the served DB
is unreachable, the served-data contract check fails, or the freshness query fails.

**Heartbeat**: a background self-check runs every `HEARTBEAT_INTERVAL_MS` (default
1 min). It verifies served-DB connectivity, alerts when the newest swap is older
than `HEARTBEAT_MAX_DATA_AGE_SECONDS` (default 6h — a stalled ETL with a healthy
connection is still an outage), and re-checks the data contract every 10th tick.
Failures push webhook alerts (with cooldowns) and update the
`futarchy_served_db_connected` / `futarchy_served_contract_ok` /
`futarchy_served_data_age_seconds` Prometheus gauges.

---

## Installation

```bash
# Install dependencies
bun install

# Build the project
bun run build

# Start the server (runs build first)
bun run start

# Development with hot reload
bun run dev
```

## Configuration

Create a `.env` file in the root directory (see `example.env` for reference):

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| **Solana** | | |
| `SOLANA_RPC_URL` / `RPCPOOL_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `SOLANA_WS_URL` / `RPCPOOL_WS_URL` | Solana WebSocket endpoint | `wss://api.mainnet-beta.solana.com` |
| **Server** | | |
| `PORT` | Server port | `3000` |
| `SERVER_REQUEST_TIMEOUT` | Request timeout (ms) | `300000` |
| `TRUST_PROXY_HOPS` | Reverse-proxy hops in front of the API (needed for per-IP rate limiting behind a LB) | `0` |
| `TRUSTED_API_KEYS` | Comma-separated allowlist of trusted partner keys | — |
| `TRUSTED_RATE_LIMIT_MAX` | Per-bucket request count per minute for trusted keys | `600` |
| `CACHE_TICKERS_TTL` | On-chain data cache TTL (ms) | `55000` |
| **Served indexer DB (required — the only database this API uses)** | | |
| `DATABASE_PG_URL` | Read-only connection to the served indexer DB (Meteora, tickers, DexScreener, first-trade-dates). **Required** — `/api/market-data` returns 503 without it. | — |
| `DATABASE_PG_SSL` | Enable SSL (server cert verified against system CAs) | `false` |
| `DATABASE_PG_CA_CERT` | PEM CA cert content for private-CA verification | — |
| `DATABASE_PG_SSL_NO_VERIFY` | Explicit opt-out of TLS verification (stopgap only) | `false` |
| **Heartbeat** | | |
| `HEARTBEAT_INTERVAL_MS` | Background self-check cadence (0 disables) | `60000` |
| `HEARTBEAT_MAX_DATA_AGE_SECONDS` | Stale-data alert threshold (0 disables) | `21600` |
| **Protocol** | | |
| `PROTOCOL_FEE_RATE` | Protocol fee rate | `0.005` (0.5%) |
| `EXCLUDED_DAOS` | Comma-separated DAO addresses to exclude | — |
| **Alerts** | | |
| `ALERT_WEBHOOK_URL` | Telegram alert webhook URL | — |
| `ALERT_WEBHOOK_SECRET` | Webhook secret | — |

## Architecture

```
src/
├── app.ts                        # Express app setup & middleware
├── main.ts                       # API entry point (serves routes, no indexing workers)
├── runtime/
│   ├── services.ts               # API service composition
│   └── heartbeat.ts              # Background self-check (served DB, freshness, contract)
├── config.ts                     # Environment variables & configuration
├── routes/
│   ├── index.ts                  # Route registration
│   ├── coingecko.ts              # GET /api/tickers
│   ├── coinmarketcap.ts          # CoinMarketCap DEX adapter (summary/ticker/assets)
│   ├── dexscreener.ts            # DexScreener adapter (4 endpoints)
│   ├── market.ts                 # GET /api/market-data (user_pool ETL)
│   ├── supply.ts                 # GET /api/supply/*
│   ├── health.ts                 # Liveness + readiness checks
│   ├── metrics.ts                # Prometheus metrics
│   └── root.ts                   # GET / (API info)
├── services/
│   ├── futarchyService.ts        # On-chain DAO/pool/token data
│   ├── priceService.ts           # Price, spread, liquidity calculations
│   ├── externalDatabaseService.ts # Read-only served ETL DB connection (the only DB)
│   ├── solanaService.ts          # SPL token supply queries
│   ├── launchpadService.ts       # Token allocation breakdown
│   └── metricsService.ts         # Prometheus counters/histograms
├── types/
│   ├── coingecko.ts              # CoinGecko response types
│   ├── coinmarketcap.ts          # CoinMarketCap response types
│   └── dexscreener.ts            # DexScreener response types
├── middleware/
│   ├── errorHandler.ts           # Error handling & asyncHandler
│   └── requestId.ts              # Request ID injection
└── utils/                        # Logger, alerts, validation, scheduling
```

## Data Pipeline

### Sources (Dune fully removed)
The API process serves market data from the read-only served ETL DB:

- `/api/tickers` reads rolling 24h metrics from `futarchy.user_pool_spot_ohlcv`.
- `/api/market-data` reads FutarchyAMM and Meteora daily rows from `futarchy.user_pool_daily`.
- DexScreener routes read raw indexed v0.6 swap/DAO tables from the same served DB.

The served ETL DB is the **only** database this API connects to (the legacy app DB
is fully removed). The API does not start indexing, fetchers, rollups, or any
schema setup — it is serve-only.

### DexScreener Pipeline
The DexScreener adapter reads **directly from the external indexer DB** (`v0_6_spot_swaps` + `v0_6_daos`) and serves real-time swap events indexed by Solana slot. No intermediate aggregation — raw swap data mapped to the DexScreener schema.

## Rate Limiting

- **Anonymous (default):** 60 requests per minute per IP. Returns `429 Too Many Requests` when exceeded.
  - **Behind a proxy/load balancer, set `TRUST_PROXY_HOPS`** to the real hop count — otherwise every anonymous client resolves to the proxy's IP and shares a single bucket.
- **Trusted partners:** 600 requests per minute per key (configurable via `TRUSTED_RATE_LIMIT_MAX`). Send the issued key in the `X-API-Key` header. Each key has its own bucket — partners do not share quota.
- Requests sent with an `X-API-Key` header that does not match the server-side allowlist receive `401 Unauthorized` with `code: "INVALID_API_KEY"`.
- Keys are issued out-of-band by the team. Contact us if you need elevated access.

## Error Handling

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "requestId": "uuid"
}
```

| Code | Description |
|------|-------------|
| `400` | Bad Request (missing/invalid parameters) |
| `401` | Unauthorized (invalid `X-API-Key`) |
| `404` | Not Found |
| `429` | Rate limit exceeded |
| `503` | Service unavailable (DB not connected) |
| `500` | Internal server error |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
