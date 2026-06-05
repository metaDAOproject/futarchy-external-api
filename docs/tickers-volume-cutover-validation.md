# `/api/tickers` volume cutover — validation plan

Status: **design / pre-cutover**. This is the checkable contract we validate against
before deleting the Dune tickers pipeline.

## 0. Goal & scope

`/api/tickers` now serves 24h volume metrics from the indexer DB's `futarchy.trades`
(read-through via `ExternalDatabaseService.getSpotRolling24hMetrics`), with the v0.6
reconciliation OHLCV (`v06_spot_ohlcv_1m`) as a Dune-free fallback. The Dune pipeline
(10-minute / hourly / daily fetchers + Dune cache) is **superseded but not yet
deleted**. This plan defines how we prove the new source is correct — equal to, or
correctly-better-than, what we serve today — before tearing the Dune pipeline out.

**In scope** — the per-DAO 24h spot fields tickers exposes:
`base_volume` (base-token), `target_volume` (USDC), `high_24h`, `low_24h`, `trade_count`.

**Out of scope** — `last_price`, `bid`/`ask`/spread, `liquidity_in_usd`: computed live
from on-chain reserves, unchanged by this cutover. `startDate` (`getFirstTradeDates`,
still Dune-sourced `daily_buy_sell_volumes`) — tracked as a separate follow-up.

## 1. What we're validating against (baselines, increasing authority)

| baseline | source | role |
|---|---|---|
| **Live API** | prod `GET /api/tickers` (today: Dune-sourced volume) | the incumbent served truth — what consumers see now |
| **New** | `futarchy.trades` rolling-24h (local/staging ETL DB) | the candidate |
| **v0.6 OHLCV** | `v06_spot_ohlcv_1m` (reconciliation, already non-Dune, live in prod) | independent same-chain cross-check |
| **On-chain** | raw swap txs / `futarchy.trades` rows | adjudicator — final tie-breaker |

Principle (mirrors the Meteora/v0.6 parity work): the live API / Dune is the
**incumbent**, not infallible. A divergence is **adjudicated against chain**, not
assumed to be an ETL bug. A Dune-side error is a pass-with-note.

## 2. The core challenge: rolling window vs closed window

The tickers metric is a **rolling last-24h** number. Comparing it live across two
systems is inherently noisy:

- **Clock skew** — both sides must evaluate `now()` at the same instant.
- **Freshness lag** — Dune refreshes on a delay (10-min query batched hourly); the
  real-time ETL includes the most recent ~hour Dune hasn't ingested yet. So the new
  source reads **higher** on recently-active DAOs. *Expected, not a bug.*
- **Coverage** — the two pipelines may not cover the identical swap set at the edge.

Therefore the **rigorous gate is a closed-UTC-day backtest** (stable, complete
windows — no moving edge, no freshness noise). The live rolling comparison is a
valuable **end-to-end sanity check**, run with a looser tolerance that accounts for
the open-window lag.

## 3. Validation methods

### A. Closed-day backtest — DB↔DB (primary gate)
For each **completed** UTC day over a fixed window (target **≥30 days**), per DAO,
aggregate from each source and compare every in-scope field:
- New: `Σ` over `futarchy.trades` (spot) for that day, decimal-aware.
- Dune: the day's `daily_volumes` / hourly rollup.
- v0.6: `v06_spot_ohlcv_1d` (or `1m` summed).

Full set, **no sampling**. Tolerances per §4. Days present in one source but not
another are reported as **coverage gaps** (investigate), not silently dropped.
Tool: `scripts/compareTickersVolume.ts` (§5).

### B. v0.6 ↔ `futarchy.trades` cross-check (strongest, lowest-noise)
Both derive from the **same** indexer chain data (legacy `v0_6_spot_swaps` vs new
`futarchy.trades`) — no third-party, no Dune. If these two agree, the new source is
validated against the path already trusted in prod under `USE_DUNE_DATA=false`.
This is the highest-signal check because the only differences can come from
derivation logic, not data provenance. Expect **tight** agreement; any gap is a
real logic difference to root-cause.

### C. Live API ↔ local ETL — end-to-end rolling spot-check (the E2E proof)
The user-requested axis. Capture prod `GET /api/tickers` and, at the same instant,
compute the new rolling-24h from the local/staging ETL DB; diff per DAO.
- Captures the **actual served path**, not just DB aggregates.
- Looser tolerance (§4) absorbing the open-window freshness lag.
- A large, *unexplained-by-lag* gap (esp. on a closed-history DAO with no recent
  trades) is a real finding → adjudicate via D.
Tool: `scripts/compareTickersLiveVsLocal.ts` (§5).

### D. On-chain adjudication (tie-breaker)
For any divergence beyond tolerance in A/B/C, pull the underlying swaps for that
`(dao, window)` on-chain, recompute by hand, and record which side is right. This is
the guard against *both* the ETL and the incumbent being wrong.

## 4. Tolerances & expected (non-failing) divergences

| field class | tolerance | notes |
|---|---|---|
| `trade_count` | **exact** (closed-day) | integer; rolling allows freshness slack |
| `base_volume` / `target_volume` (closed-day, 6-dec token) | **≤ 0.5%** rel. | mechanical aggregation |
| `high_24h` / `low_24h` (closed-day) | **≤ 0.5%** rel. | price extremes; watch unit (§ decimals) |
| any field (live rolling, method C) | **≤ ~5%** rel. | absorbs open-window freshness lag |
| v0.6 ↔ trades (method B) | **≤ 0.5%** rel. | same chain data; tighter is better |

**Expected divergences — treat as pass-with-note, NOT failures:**
1. **Decimals correction.** The new source scales by each token's real
   `futarchy.tokens.decimals`; Dune/v0.6 assume `÷1e6`. For a **non-6-decimal base
   token**, `base_volume` (and `high/low`, scaled by `10^(baseDec−quoteDec)`) will
   legitimately differ — the new value is *more correct*. The harness must flag the
   token's decimals so a decimals-driven delta is recognised, not chased as a bug.
2. **Freshness lag** on the open rolling window (method C only) — new ≥ incumbent on
   recently-active DAOs.
3. **Coverage:** DAOs the new source has but Dune doesn't → **new coverage** (good).
   DAOs Dune has but the new source is **missing** → **failure** (investigate).

Note: tickers uses only base/target **totals**, not a buy/sell split, so the
direction-label inversion that affected Meteora does **not** affect these fields.

## 5. Tooling to build

1. **`scripts/compareTickersVolume.ts`** — DB↔DB harness (methods A & B). Reads the
   `dao_addr → base_mint` map from `futarchy.daos` (no RPC), then lines up the three
   sources through the *actual serving functions* (`getSpotRolling24hMetrics`,
   `getV06Rolling24hMetrics`, `getRolling24hFromTenMinute`/`getRolling24hMetrics`)
   and/or closed-day aggregates. Per-DAO field deltas + Δ%, tolerance flags, coverage
   gaps, per-token decimals column. Modeled on `scripts/compareDuneVsV06.ts`.
2. **`scripts/compareTickersLiveVsLocal.ts`** — E2E (method C). `fetch(<API_BASE>/api/tickers)`
   (prod, incumbent) vs the local new-source rolling-24h for the same DAOs at one
   instant; per-DAO diff of base/target/high/low with the looser rolling tolerance,
   annotating likely freshness-lag rows. `API_BASE` via env/arg.
3. **Flag-gate** — `ENABLE_LEGACY_DUNE_TICKERS` (default off). The serving path is
   already cut over; this flag keeps the Dune **fetchers** runnable in the comparison
   env so `daily_volumes`/hourly stay populated as the method-A incumbent. Off in
   clean/serve-only deploys; **on** wherever we run the backtest.

## 6. Cutover gate (delete the Dune tickers pipeline when ALL hold)

- **B** (v0.6 ↔ trades): within 0.5% across the full DAO set on the shared window.
- **A** (closed-day vs Dune): within tolerance over ≥30 complete days, every
  out-of-tolerance day adjudicated by **D** (and decimals-deltas accounted).
- **C** (live vs local): agreement within the rolling tolerance, residual gaps fully
  explained by freshness/decimals — no unexplained divergence on a closed-history DAO.
- **No missing-DAO failures** (new source covers every DAO Dune serves today).

On pass: delete `TenMinuteVolumeFetcherService`, `HourlyAggregationService`,
`DailyAggregationService`, `DuneCacheService`, the Dune SQL, the tickers-only tables
(`ten_minute_volumes`/`hourly_volumes`/`daily_volumes`) + repos, and the
`ENABLE_LEGACY_DUNE_TICKERS` flag. Keep v0.6 reconciliation (feeds `/api/market-data`).

## 7. Rollback

The new source and the v0.6 fallback are both Dune-free and the fallback is live in
prod today, so the serving path degrades safely (new → v0.6) even pre-cutover. If a
blocking issue is found post-cutover, re-enabling Dune requires reverting the
teardown PR — which is why teardown is gated on this plan passing, and is a separate
PR from the read-through change.
