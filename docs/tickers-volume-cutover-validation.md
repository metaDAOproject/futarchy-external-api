# `/api/tickers` volume cutover

Status: **completed**. The Dune ticker pipeline and app-DB fallback have been
removed from the API runtime.

## Current Serving Contract

`/api/tickers` serves rolling 24h spot volume from the served ETL DB:

- table: `futarchy.user_pool_spot_ohlcv`
- filters: `source = 'futarchy_amm'`, `interval = '1m'`, `bucket_start >= now - 24h`
- key: `token` is the DAO base mint; the API maps base mint to DAO address for `pool_id`
- units: human token units for `base_volume`, USD/USDC units for `target_volume`

The served DB is a hard dependency. If it is unavailable, `/api/tickers` returns
`503` instead of reporting zero volume.

## Removed Paths

The following are no longer serving sources:

- Dune query fetchers, caches, and rollups
- `futarchy.trades` direct reads for ticker 24h volume
- app-DB `v06_spot_ohlcv_1m` ticker fallback

## Validation Expectations

Future changes to ticker volume should validate:

- every active DAO base mint has ETL coverage or an explicit zero-volume row absence
- rolling window aggregation matches the ETL table's human-unit contract
- served DB outage returns `503`
- `/api/health` reports the served ETL contract for the user_pool tables
