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

**Volume sources** (priority order): 10-minute DB → hourly DB → Dune cache.

---

### DexScreener Adapter Endpoints

Implements the [DexScreener Adapter Spec v1.1](https://dexscreener.notion.site/DEX-Screener-Adapter-Specs-cc1223cdf6e74a7799599106b65dcd0e). All endpoints are served under `/dexscreener/`. Requires `EXTERNAL_DATABASE_URL` to be configured (v0.6 indexer DB).

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

**Data source** is controlled by the `USE_DUNE_DATA` environment variable:
- `USE_DUNE_DATA=false` — reads from `v06_fee_volume_daily_aggregate` (v0.6 indexer), providing spot + conditional volume breakdown with fee calculations and reconciliation status
- `USE_DUNE_DATA=true` (default) — reads from `daily_volumes` (Dune pipeline)

The response includes a `source` field (`"v06-indexer"` or `"dune"`) indicating which pipeline served the data.

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
| `GET /health` | Basic health check (status, uptime, cache status) |
| `GET /api/health` | Comprehensive health with DB, volume services, and data freshness |
| `GET /metrics` | Prometheus metrics |

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
| **Database (App DB)** | | |
| `COINGECKO_PG_URL` / `DATABASE_URL` | PostgreSQL connection string | — |
| `DATABASE_SSL` | Enable SSL | `false` |
| **External DB (v0.6 Indexer)** | | |
| `EXTERNAL_DATABASE_URL` | Read-only connection to indexer DB | — |
| `EXTERNAL_DATABASE_SSL` | Enable SSL | `false` |
| **Dune** | | |
| `DUNE_API_KEY` | Dune Analytics API key | — |
| `DUNE_TEN_MINUTE_VOLUME_QUERY_ID` | 10-minute volume query ID | — |
| `DUNE_METEORA_VOLUME_QUERY_ID` | Meteora volume query ID | — |
| **Protocol** | | |
| `USE_DUNE_DATA` | Use Dune pipeline for volume data (`true`/`false`) | `true` |
| `PROTOCOL_FEE_RATE` | Protocol fee rate | `0.005` (0.5%) |
| `EXCLUDED_DAOS` | Comma-separated DAO addresses to exclude | — |
| **Alerts** | | |
| `ALERT_WEBHOOK_URL` | Telegram alert webhook URL | — |
| `ALERT_WEBHOOK_SECRET` | Webhook secret | — |

## Architecture

```
src/
├── app.ts                        # Express app setup & middleware
├── main.ts                       # Entry point, service wiring, scheduled tasks
├── config.ts                     # Environment variables & configuration
├── routes/
│   ├── index.ts                  # Route registration
│   ├── coingecko.ts              # GET /api/tickers
│   ├── dexscreener.ts            # DexScreener adapter (4 endpoints)
│   ├── market.ts                 # GET /api/market-data (v0.6 or Dune via USE_DUNE_DATA)
│   ├── supply.ts                 # GET /api/supply/*
│   ├── health.ts                 # Health checks
│   ├── metrics.ts                # Prometheus metrics
│   └── root.ts                   # GET / (API info)
├── services/
│   ├── futarchyService.ts        # On-chain DAO/pool/token data
│   ├── priceService.ts           # Price, spread, liquidity calculations
│   ├── databaseService.ts        # App DB (volumes, OHLCV, fees, metrics)
│   ├── externalDatabaseService.ts # Read-only indexer DB connection
│   ├── v06ReconciliationService.ts # Hourly v0.6 data reconciliation
│   ├── tenMinuteVolumeFetcherService.ts # 10-min volume from Dune
│   ├── hourlyAggregationService.ts     # Hourly rollups
│   ├── dailyAggregationService.ts      # Daily rollups
│   ├── meteoraVolumeFetcherService.ts  # Meteora pool volumes
│   ├── duneCacheService.ts       # Dune API cache layer
│   ├── duneService.ts            # Dune API client
│   ├── solanaService.ts          # SPL token supply queries
│   ├── launchpadService.ts       # Token allocation breakdown
│   └── metricsService.ts         # Prometheus counters/histograms
├── types/
│   ├── coingecko.ts              # CoinGecko response types
│   └── dexscreener.ts            # DexScreener response types
├── middleware/
│   ├── errorHandler.ts           # Error handling & asyncHandler
│   └── requestId.ts              # Request ID injection
├── utils/                        # Logger, alerts, validation, scheduling
└── schema/                       # Dune SQL queries, v0.6 DDL reference
```

## Data Pipeline

### Volume Sources (priority order)
1. **10-minute volumes** — from Dune, stored in `ten_minute_volumes`, rolled up to hourly/daily
2. **v0.6 Reconciliation** — hourly job reads `v0_6_spot_swaps` + `v0_6_conditional_swaps` from the external indexer DB, writes OHLCV and fee breakdowns to app DB
3. **Dune cache** — fallback for 24h metrics when DB sources unavailable

### DexScreener Pipeline
The DexScreener adapter reads **directly from the external indexer DB** (`v0_6_spot_swaps` + `v0_6_daos`) and serves real-time swap events indexed by Solana slot. No intermediate aggregation — raw swap data mapped to the DexScreener schema.

## Backfill Scripts

```bash
# Full v0.6 backfill (since 2025-01-01)
bun run backfill:v06

# With custom range
bun run backfill:v06 -- --since 2025-06-01

# Chunked for large ranges
bun run backfill:v06 -- --since 2025-01-01 --chunk-days 30

# Legacy Dune-based backfills
bun run backfill:daily
bun run backfill:hourly
bun run backfill:ten-minute
```

## Rate Limiting

- **60 requests per minute** per IP address
- Returns `429 Too Many Requests` when exceeded

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
| `404` | Not Found |
| `429` | Rate limit exceeded |
| `503` | Service unavailable (DB not connected) |
| `500` | Internal server error |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
