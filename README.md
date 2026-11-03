# Futarchy External API

A multi-aggregator DEX API for the Futarchy protocol that automatically discovers all DAOs, providing real-time pricing, volume, and trading data to CoinGecko, DexScreener, and other consumers.

## Public API Documentation

**Base URL:** `https://your-api-domain.com`

**Reference:** `GET /docs` renders the full API reference, and `GET /openapi.json`
serves the machine-readable OpenAPI 3.1 contract (`src/openapi.ts`). A test
fails if the spec documents a route the app doesn't serve.

### Versioning

Every data endpoint is served under a version prefix: `/v1/api/tickers`,
`/v1/cmc/summary`, `/v1/dexscreener/events`, `/v1/api/launches/live`, and so on.
New integrations should use the versioned URLs.

- **Unversioned paths** (`/api/tickers`, `/cmc/summary`, …) are a frozen alias
  of v1, kept so existing partner integrations keep working. The paths below
  are written unversioned; prefix them with `/v1`.
- **Not versioned:** health, probe, metrics and docs endpoints (`/health*`,
  `/api/health`, `/metrics`, `/docs`, `/openapi.json`, `/`). They are operational, not part of the API
  contract.
- **Breaking changes** ship as a new version (`/v2/...`). Earlier versions are
  left unchanged.
- **Deprecation:** a deprecated version (or the unversioned alias) answers
  every request with `Deprecation` ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)),
  `Sunset` ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) and
  `Link: <…>; rel="successor-version"` headers. It is removed after its sunset date.

Versions and their deprecation status are configured in one place,
`API_VERSIONS` and `UNVERSIONED_ALIAS` in `src/routes/index.ts`.

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
served DB is unavailable, the endpoint returns `503 SERVED_DB_UNAVAILABLE` instead of
reporting zero volume.

**Stale data**: if the newest FutarchyAMM spot swap is older than `SERVED_DATA_MAX_AGE_SECONDS`
(default 6h), `/api/tickers`, `/cmc/summary` and `/cmc/ticker` return
`503 SERVED_DATA_STALE`. A stalled ETL would otherwise serve rolling-24h volume that
drains toward zero while looking healthy; with a 503, pollers keep their last good
data and the alert fires.

---

### CoinMarketCap Endpoints

Implements the DEX endpoints from [Section C] of CoinMarketCap's integration
requirements. Served under `/cmc/`. The shapes mirror the CoinGecko adapter —
CMC's DEX spec is field-for-field close — and both feeds are built from the same
on-chain DAO discovery and rolling-24h ETL metrics.

**API versioning.** At CMC's request, every endpoint is also served under an
explicit version prefix: `/cmc/v1/summary`, `/cmc/v1/ticker`, `/cmc/v1/assets`.
The unversioned paths remain published as-is and are treated as the current (v1)
contract — the two are URL aliases for the same handler, so they never diverge.
A future breaking change would land under `/cmc/v2/…` while the existing paths
keep serving v1.

`/cmc/summary` and `/cmc/ticker` carry 24h volume, so they require
`DATABASE_PG_URL` and return `503` (never zero volume) if the served DB is
unavailable. `/cmc/assets` is pure on-chain metadata and does not require it.

No dedicated auth: like every route, CMC reuses the shared rate-limit tiers —
anonymous by IP, or the elevated per-key bucket when a trusted `X-API-Key`
(`TRUSTED_API_KEYS`) is sent.

Set `CMC_ALLOWED_MINTS` (comma-separated base mints) to restrict the CMC feed to
a specific set of tokens; empty (the default) serves every discovered DAO.

Every CMC feed keys its per-token data (24h volume/high/low, the 24h-ago
reference reserves, and the `/cmc/assets` identity entry) by **base mint**, and
the served-ETL tables carry no per-pool dimension. If two discovered markets ever
share a base mint the numbers can't be attributed to the right pair, so all three
endpoints **fail closed** with `503` (`CMC_DUPLICATE_BASE_MINT`) rather than serve
one market's volume/price for another. The check runs after `CMC_ALLOWED_MINTS`,
so narrowing the allowlist to a single side of a collision serves normally. In the
futarchy model each DAO launches its own token, so this is an anomaly guard, not
an expected path.

#### GET `/cmc/summary`

24h overview of every tradeable pair.

**Response:**
```json
[
  {
    "trading_pairs": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "base_currency": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "quote_currency": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "type": "spot",
    "last_price": 0.081340728222,
    "lowest_ask": 0.081747431863,
    "highest_bid": 0.080934024581,
    "base_volume": 30024.8104,
    "quote_volume": 2441.23456789,
    "highest_price_24h": 0.085,
    "lowest_price_24h": 0.078,
    "price_change_percent_24h": 4.28
  }
]
```

`base_currency` / `quote_currency` are Solana mint (contract) addresses — the
same ids `/cmc/assets` is keyed by, so CMC maps pairs → assets consistently.

`highest_price_24h` / `lowest_price_24h` are omitted when the ETL window has no
real high/low.

`price_change_percent_24h` is the 24h price change in percent, computed from the
AMM's **exact** price 24h ago. The FutarchyAMM price is a pure function of pool
reserves, and reserves only change on a swap, so the reserves of the last swap
≥24h ago (`futarchy.user_pool_swaps`) are the pool's exact state 24h ago — priced
through the same formula as `last_price` (a true mid-vs-mid comparison). It is
**omitted** for a market younger than 24h (no swap before the cutoff), where the
change is undefined — never fabricated as `0%`. If the swaps source is briefly
unavailable, the field is omitted for that response but price/volume still serve
(unlike the volume source, whose absence returns `503`).

#### GET `/cmc/ticker`

24h price and volume keyed by the `BASE_QUOTE` trading pair.

**Response:**
```json
{
  "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
    "base_id": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "quote_id": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "base_name": "ZKFG",
    "base_symbol": "ZKFG",
    "quote_name": "USD Coin",
    "quote_symbol": "USDC",
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

Returns token metadata and supply for a given Solana mint address. Supply is
calculated from one confirmed mint/allocation snapshot. If supply cannot be
verified, the endpoint returns `503` with code `SUPPLY_UNAVAILABLE`.

**Response:**
```json
{
  "asset": {
    "id": "ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta",
    "name": "ZKFG",
    "symbol": "ZKFG",
    "totalSupply": 1000000000,
    "circulatingSupply": 412500000,
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
- Swap amounts and reserves are divided by `10^decimals` for their respective base or quote mint; tokens are not assumed to share six decimals. `priceNative` is quote tokens per base token after normalization.
- Mint decimals use cached on-chain metadata, resolved once per distinct mint per request in batches of at most eight lookups. If metadata cannot be loaded, the events request returns 5xx instead of defaulting to a decimal count or returning partial data.

---

### Market Data

#### GET `/api/market-data?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&tokens=TOKEN1,TOKEN2`

Returns daily market data for the given date range, split by Futarchy AMM and Meteora sources.

Both dates are required, must be real calendar dates, and `startDate` must be on
or before `endDate`, and the range may span at most `MARKET_DATA_MAX_RANGE_DAYS`
(default 366) days, so fetch longer histories in several requests. `tokens` is
optional: up to 100 comma-separated base-token mint addresses. Anything else is a `400 INVALID_QUERY_PARAMETER` naming the
`field`, returned before the database is touched.

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

Returns circulating supply — total minus non-circulating allocations: the team
performance package, the additional-token allocation, DAO treasury holdings, and any
operator-configured **excluded holders** (external/vesting/encumbered wallets listed
in `EXCLUDED_CIRCULATING_WALLETS`). Each excluded holder's on-chain balance is read
with the other live non-circulating balances at one confirmed slot, cached for
`CACHE_TICKERS_TTL` (55 seconds by default), subtracted, and echoed back under
`allocation.excludedHolders`. The shared slot is returned as
`allocation.balanceSnapshotSlot`. This excludes direct SPL token balances only; it
does not decode fractional ownership of DAMM pool positions.

---

### Launch Endpoints

#### GET `/api/launches/live`

Launches still accepting commitments across launchpad v0.6, v0.7 and v0.8 —
on-chain state `live` with a close time in the future — read directly from Solana and cached for `CACHE_LIVE_LAUNCHES_TTL`
(default 5 minutes). RPC failures return 5xx, never an empty list.

```json
{
  "count": 1,
  "updatedAt": "2026-10-09T17:00:00.000Z",
  "launches": [
    {
      "launchAddress": "…",
      "version": "v0.7",
      "tokenAddress": "…",
      "quoteMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "quoteDecimals": 6,
      "committerCount": 412,
      "totalCommitted": "251.5",
      "totalCommittedRaw": "251500000",
      "minimumRaise": "500000",
      "minimumRaiseRaw": "500000000000",
      "closeTime": 1760345600,
      "tokenName": "The Syndicate",
      "tokenSymbol": "GANG"
    }
  ]
}
```

- `tokenAddress` — mint of the token being launched; `tokenName` / `tokenSymbol`
  come from its Metaplex metadata (`null` if it has none).
- `committerCount` / `totalCommitted` — count and sum of the launch's funding
  records with a non-zero `committedAmount` (one record per funder).
- `minimumRaise` — the launch's on-chain `minimumRaiseAmount`.
- `closeTime` — unix seconds, `unixTimestampStarted + secondsForLaunch`. Launches
  past this time stay `live` on-chain until someone calls `closeLaunch` (many
  never are); they are excluded at request time, even within a cache window.

---

### Health & Admin

| Endpoint | Description |
|----------|-------------|
| `GET /health/startup` | Startup probe: 200 once the served DB connected at boot, else 503 |
| `GET /health/ready` | Readiness probe: 200 while the served DB answers `SELECT 1` within 2s, else 503 |
| `GET /health/live` | Liveness probe: 200 whenever the process can respond (no dependency checks) |
| `GET /health` | Process status and uptime (no dependency checks) |
| `GET /api/health` | Detailed status: served DB connectivity, ETL data contract, and data freshness |
| `GET /metrics` | Prometheus metrics (HTTP, served-DB health gauges, heartbeat). Requires `Authorization: Bearer <METRICS_TOKEN>` when `METRICS_TOKEN` is set |

`/api/health` returns `200` when healthy and `503` with `status: "degraded"`
(and a `message`) when the served DB is unreachable, the served-data contract
check fails, or the freshness query fails. Use it for dashboards and uptime
monitors, not container probes. Don't point a Northflank liveness probe at it:
a 503 there would restart containers during a DB outage.

#### Container probes (Northflank)

The `/health/{startup,ready,live}` probes skip the rate limiter and request
metrics. Probes run inside the container and all share the 127.0.0.1 rate-limit
bucket, and a 429 on liveness would restart a healthy container.

| Probe | Path | Initial delay | Interval | Timeout | Max failures | Success threshold |
|-------|------|---------------|----------|---------|--------------|-------------------|
| Startup | `/health/startup` | 2s | 5s | 3s | 12 (~60s to start) | 1 |
| Readiness | `/health/ready` | 1s | 10s | 3s | 3 (~30s to leave the LB) | 1 |
| Liveness | `/health/live` | 1s | 15s | 3s | 4 (~60s unresponsive → restart) | 1 |

All three use HTTP on port `3000` (`PORT`). Why these values:

- **Startup.** Boot usually takes 1–3s. The initial DB connect can take up to its
  10s connection timeout. If the DB never connects, the startup probe fails and
  the container restarts. Without that, the container would never recover,
  because the DB reconnect loop only starts after a successful first connect.
- **Readiness.** The probe gives up on the DB ping at 2s, under the 3s probe
  timeout, so a hung DB returns a clean 503. Three failures in a row tolerate a
  single blip.
- **Liveness.** It has no dependencies, so a DB or RPC outage never causes
  restart loops. The settings are lenient because a restart costs more than a
  brief event-loop stall.

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
| `SERVER_REQUEST_TIMEOUT` | Max time (ms) to respond; slower requests get `503 REQUEST_TIMEOUT` | `30000` |
| `METRICS_TOKEN` | Bearer token required by `GET /metrics` (open, with a startup warning, when unset) | — |
| `TRUST_PROXY_HOPS` | Reverse-proxy hops in front of the API (needed for per-IP rate limiting behind a LB) | `0` |
| `TRUSTED_API_KEYS` | Comma-separated allowlist of trusted partner keys | — |
| `TRUSTED_RATE_LIMIT_MAX` | Per-bucket request count per minute for trusted keys | `600` |
| `CACHE_TICKERS_TTL` | On-chain DAO/pool snapshot TTL (ms); older snapshots refresh in the background | `55000` |
| `CACHE_TICKERS_MAX_STALE` | Max age (ms) of a snapshot served while refreshing; past it requests wait and fail (5xx) if the RPC is down | `300000` |
| `RPC_TIMEOUT_MS` | Per-request Solana RPC timeout (ms) | `20000` |
| `CACHE_CONTROL_MAX_AGE` | `Cache-Control` max-age (seconds) on successful data responses | `30` |
| `SHUTDOWN_DRAIN_MS` | On SIGTERM, report not-ready and keep serving this long before closing. Keep it + 15s under the container's termination grace period | `10000` |
| `CACHE_LIVE_LAUNCHES_TTL` | `/api/launches/live` snapshot TTL (ms) | `300000` |
| `CACHE_SERVED_METRICS_TTL` | Reuse window (ms) for the served-DB aggregates behind `/api/tickers` and `/cmc/*` (24h volume, 24h-ago reserves, first-trade dates). Concurrent requests share one query; failures are never cached. `0` only coalesces concurrent queries | `30000` |
| `RATE_LIMIT_REDIS_URL` | `redis://` / `rediss://` URL for rate-limit counters shared by every replica. Unset: each replica counts on its own (N replicas allow N× the limits). If Redis becomes unreachable or slow (>250ms), requests fall back to per-process counting and it reconnects automatically | — |
| `SERVED_DATA_MAX_AGE_SECONDS` | `/api/tickers` and `/cmc/summary`/`/cmc/ticker` return `503 SERVED_DATA_STALE` when the newest FutarchyAMM spot swap is older than this. `0` disables | `21600` |
| `MARKET_DATA_MAX_RANGE_DAYS` | Max inclusive days per `/api/market-data` request. `0` disables | `366` |
| `LOG_LEVEL` | `DEBUG`, `INFO`, `WARN` or `ERROR`. `INFO` writes one structured access-log line per request (probes and `/metrics` excluded) | `INFO` |
| **Served indexer DB (required — the only database this API uses)** | | |
| `DATABASE_PG_URL` | Read-only connection to the served indexer DB (Meteora, tickers, DexScreener, first-trade-dates). **Required** — `/api/market-data`, `/api/tickers`, `/cmc/summary`, `/cmc/ticker`, and the DexScreener routes return 503 without it. | — |
| `DATABASE_PG_SSL` | Enable SSL (server cert verified against system CAs) | `false` |
| `DATABASE_PG_CA_CERT` | PEM CA cert content for private-CA verification | — |
| `DATABASE_PG_SSL_NO_VERIFY` | Explicit opt-out of TLS verification (stopgap only) | `false` |
| `DATABASE_PG_STATEMENT_TIMEOUT_MS` | Postgres cancels statements running longer than this (ms), so a slow query can't hold a pool connection after its request timed out. `0` disables | `25000` |
| **Heartbeat** | | |
| `HEARTBEAT_INTERVAL_MS` | Background self-check cadence (0 disables) | `60000` |
| `HEARTBEAT_MAX_DATA_AGE_SECONDS` | Stale-data alert threshold (0 disables) | `21600` |
| **Protocol** | | |
| `PROTOCOL_FEE_RATE` | Protocol fee rate | `0.005` (0.5%) |
| `EXCLUDED_DAOS` | Comma-separated DAO addresses to exclude | — |
| `EXCLUDED_CIRCULATING_WALLETS` | Non-circulating direct SPL token holders, comma-separated `mint:wallet` or `mint:wallet:label` (external/vesting/encumbered); each wallet's live balance of that mint is subtracted from circulating supply. DAMM pool-position ownership is not decoded. | — |
| `CMC_ALLOWED_MINTS` | Comma-separated base-mint allowlist for the `/cmc/*` routes; empty serves all. Validated at startup; if set but matching zero discovered DAOs, the CMC routes fail closed with 503. | — |
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
│   ├── index.ts                  # Route registration + API versions (/v1, unversioned alias)
│   ├── coingecko.ts              # GET /api/tickers
│   ├── coinmarketcap.ts          # CoinMarketCap DEX adapter (summary/ticker/assets)
│   ├── dexscreener.ts            # DexScreener adapter (4 endpoints)
│   ├── market.ts                 # GET /api/market-data (user_pool ETL)
│   ├── supply.ts                 # GET /api/supply/*
│   ├── launches.ts               # GET /api/launches/live
│   ├── health.ts                 # Liveness + readiness checks
│   ├── metrics.ts                # Prometheus metrics
│   └── root.ts                   # GET / (API info)
├── services/
│   ├── futarchyService.ts        # On-chain DAO/pool/token data
│   ├── priceService.ts           # Price, spread, liquidity calculations
│   ├── externalDatabaseService.ts # Read-only served ETL DB connection (the only DB)
│   ├── solanaService.ts          # SPL token supply queries
│   ├── launchpadService.ts       # Token allocation breakdown + live launches
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
- Every rate-limited response carries `RateLimit-Limit`, `RateLimit-Remaining`
  and `RateLimit-Reset` (seconds) headers; a `429` also carries `Retry-After`.
- If requests arrive with `X-Forwarded-For` while `TRUST_PROXY_HOPS=0`, the API
  logs a one-time warning, since every client then shares the proxy's bucket.
- **Multiple replicas:** set `RATE_LIMIT_REDIS_URL` so the limits above hold for
  the whole deployment. Without it, each replica counts on its own. Trusted
  keys are stored in Redis only as SHA-256 hashes. Rate limiting never takes the
  API down: if Redis is unreachable or slow, each replica counts on its own until
  Redis recovers.

## Caching, Compression and CORS

- Successful data responses send `Cache-Control: private, max-age=30`
  (`CACHE_CONTROL_MAX_AGE`), so a client can reuse a response for 30s. It's
  `private`, not `public`, because responses carry per-caller headers
  (`RateLimit-*`, `X-Request-Id`) that a shared cache would replay to other
  callers. Errors, health, probe and metrics responses send `no-store`.
- Responses over 1 KB are compressed (`br`, `gzip` or `deflate`) when the client
  sends `Accept-Encoding` (`Vary: Accept-Encoding` is set). JSON feeds shrink
  about 85% (the OpenAPI spec goes from 68 KB to 10 KB).
- CORS is open for read-only use: any origin, `GET`/`OPTIONS`, and the
  `X-API-Key` and `X-Request-Id` request headers. Preflight `OPTIONS` requests
  are answered directly with `204` and don't count toward the rate limit.

Numeric settings are validated at startup; an invalid value (e.g. `PORT=30s`)
exits with an error instead of silently becoming `NaN`.

## Error Handling

Every error, on every endpoint, uses one JSON shape:

```json
{
  "error": "startDate must be on or before endDate",
  "code": "INVALID_QUERY_PARAMETER",
  "field": "startDate",
  "requestId": "uuid"
}
```

Branch on `code` (stable); `error` is a human-readable message and may change.
`field` appears on a 400 and names the rejected parameter. `requestId` matches
the `X-Request-Id` response header and the server's access log, so quote it when
reporting a problem.

| Code | Description |
|------|-------------|
| `400` | `INVALID_QUERY_PARAMETER` (missing, malformed or repeated query parameter) or `INVALID_MINT_ADDRESS` |
| `401` | Unauthorized (invalid `X-API-Key`) |
| `404` | Not Found (unknown routes also answer in this JSON shape, `code: "NOT_FOUND"`) |
| `429` | Rate limit exceeded |
| `503` | `code: "REQUEST_TIMEOUT"` when the response took longer than `SERVER_REQUEST_TIMEOUT` |
| `503` | `SERVED_DB_UNAVAILABLE` (served DB not connected), `SERVED_DATA_STALE` (ETL stalled) and other dependency outages |
| `500` | `INTERNAL_ERROR` (unexpected server or upstream RPC/DB failure); retry later |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
