import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { scheduleWithoutPileup, type ScheduledTask } from '../utils/scheduling.js';
import type { DatabaseService } from './databaseService.js';
import type { ExternalDatabaseService } from './externalDatabaseService.js';

const FEE_RATE = config.fees.protocolFeeRate; // 0.005 = 0.5%

/**
 * Hourly reconciliation service for v0.6 data.
 *
 * Reads from the external indexer DB (v0_6_spot_swaps, v0_6_conditional_swaps,
 * v0_6_daos, v0_6_proposals) and upserts into the app DB's v06_* tables.
 *
 * Pipeline:
 *   1. Spot OHLCV 1m  — scan v0_6_spot_swaps JOIN v0_6_daos
 *   2. Spot OHLCV 1d  — rollup from 1m data
 *   3–4. Fee volume daily spot / conditional — aggregate by calendar day (when until defaults
 *        to now, two windows: completed UTC days then partial “today” to avoid mid-day truncation)
 *   5. Fee volume daily aggregate — spot + conditional totals
 */
export class V06ReconciliationService {
  private scheduledTask: ScheduledTask | null = null;
  private static readonly RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly LOOKBACK_HOURS = 72; // re-touch recent window to catch late state changes

  constructor(
    private readonly appDb: DatabaseService,
    private readonly extDb: ExternalDatabaseService,
  ) {}

  start(): void {
    if (!this.extDb.isAvailable()) {
      logger.info('[V06Reconciliation] External DB not available — service will not start');
      return;
    }

    this.scheduledTask = scheduleWithoutPileup(
      () => this.reconcile(),
      {
        name: 'V06Reconciliation',
        intervalMs: V06ReconciliationService.RECONCILIATION_INTERVAL_MS,
        immediate: true,
        onError: (err) => logger.error('[V06Reconciliation] Error during reconciliation', err),
      },
    );
    logger.info('[V06Reconciliation] Service started — hourly reconciliation enabled');
  }

  stop(): void {
    this.scheduledTask?.stop();
    this.scheduledTask = null;
    logger.info('[V06Reconciliation] Service stopped');
  }

  isRunning(): boolean {
    return this.scheduledTask?.isRunning() ?? false;
  }

  getLastRunTime(): Date | null {
    return this.scheduledTask?.getLastRunTime() ?? null;
  }

  // ------------------------------------------------------------------
  // Top-level reconciliation
  // ------------------------------------------------------------------

  /**
   * Run the full reconciliation pipeline.
   * @param since  Override the lookback window start (for backfills).
   *               Defaults to LOOKBACK_HOURS ago.
   * @param until  Upper bound for the window (exclusive). Defaults to now.
   *                When omitted, fee daily spot/conditional use a two-pass window: completed
   *                UTC days [since, startOfUtcDay(now)) then today [startOfUtcDay(now), now),
   *                so completed days are not overwritten with partial same-day aggregates.
   *                When set (e.g. chunked backfill), fees use a single [since, until) interval.
   */
  async reconcile(since?: Date, until?: Date): Promise<void> {
    const start = Date.now();
    const windowStart = since ?? new Date(Date.now() - V06ReconciliationService.LOOKBACK_HOURS * 3600_000);
    const windowEnd = until ?? new Date();
    // Pass ISO strings to sub-methods so the pg driver never calls Date.toString()
    // (which can produce un-parseable timezone names like "GMT-0700" under Bun).
    const sinceISO = windowStart.toISOString();
    const untilISO = windowEnd.toISOString();
    logger.info(`[V06Reconciliation] Starting reconciliation cycle (since ${sinceISO} until ${untilISO})`);

    await this.reconcileSpotOhlcv1m(sinceISO, untilISO);
    const feeWindows = this.feeDailyTimeWindows(
      sinceISO,
      untilISO,
      windowStart,
      windowEnd,
      until === undefined,
    );
    // 1d rollup (app DB) and fee spot / conditional (indexer → app DB) are independent — run in parallel.
    // Each fee stream applies the same UTC day split windows sequentially on its own table.
    await Promise.all([
      this.reconcileSpotOhlcv1d(windowStart),
      this.runFeeDailySpotWindows(feeWindows),
      this.runFeeDailyConditionalWindows(feeWindows),
    ]);
    await this.reconcileFeeDailyAggregate(windowStart);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`[V06Reconciliation] Cycle complete in ${elapsed}s`);
  }

  async reconcileFeesOnly(since?: Date, until?: Date): Promise<void> {
    const start = Date.now();
    const windowStart = since ?? new Date(Date.now() - V06ReconciliationService.LOOKBACK_HOURS * 3600_000);
    const windowEnd = until ?? new Date();
    const sinceISO = windowStart.toISOString();
    const untilISO = windowEnd.toISOString();
    logger.info(`[V06Reconciliation] Starting fee-only reconciliation (since ${sinceISO} until ${untilISO})`);

    const feeWindows = this.feeDailyTimeWindows(
      sinceISO,
      untilISO,
      windowStart,
      windowEnd,
      until === undefined,
    );
    await Promise.all([
      this.runFeeDailySpotWindows(feeWindows),
      this.runFeeDailyConditionalWindows(feeWindows),
    ]);
    await this.reconcileFeeDailyAggregate(windowStart);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`[V06Reconciliation] Fee-only cycle complete in ${elapsed}s`);
  }

  /** Start of the UTC calendar day containing `d` (00:00:00.000 UTC). */
  private static startOfUtcDay(d: Date): Date {
    const t = new Date(d.getTime());
    t.setUTCHours(0, 0, 0, 0);
    return t;
  }

  /** One or two time bounds for fee daily upserts (completed UTC days vs current day when splitting). */
  private feeDailyTimeWindows(
    sinceISO: string,
    untilISO: string,
    windowStart: Date,
    windowEnd: Date,
    splitAtUtcDay: boolean,
  ): { since: string; until: string; logLabel: string }[] {
    if (!splitAtUtcDay) {
      return [
        {
          since: sinceISO,
          until: untilISO,
          logLabel: `fee window [${sinceISO}, ${untilISO})`,
        },
      ];
    }

    const untilComplete = V06ReconciliationService.startOfUtcDay(windowEnd);
    const untilCompleteISO = untilComplete.toISOString();
    const out: { since: string; until: string; logLabel: string }[] = [];

    if (windowStart.getTime() < untilComplete.getTime()) {
      out.push({
        since: sinceISO,
        until: untilCompleteISO,
        logLabel: `completed UTC days [${sinceISO}, ${untilCompleteISO})`,
      });
    }

    out.push({
      since: untilCompleteISO,
      until: untilISO,
      logLabel: `current UTC day [${untilCompleteISO}, ${untilISO})`,
    });

    return out;
  }

  private async runFeeDailySpotWindows(windows: { since: string; until: string; logLabel: string }[]): Promise<void> {
    for (const w of windows) {
      logger.info(`[V06Reconciliation] Fee daily spot: ${w.logLabel}`);
      await this.reconcileFeeDailySpot(w.since, w.until);
    }
  }

  private async runFeeDailyConditionalWindows(
    windows: { since: string; until: string; logLabel: string }[],
  ): Promise<void> {
    for (const w of windows) {
      logger.info(`[V06Reconciliation] Fee daily conditional: ${w.logLabel}`);
      await this.reconcileFeeDailyConditional(w.since, w.until);
    }
  }

  // ------------------------------------------------------------------
  // 1) Spot OHLCV 1-minute
  // ------------------------------------------------------------------

  private async reconcileSpotOhlcv1m(since: string, until: string): Promise<void> {
    // #12: Single CTE query replaces 3 separate scans (aggregate + open + close).
    // #10: Compare unix_timestamp directly against epoch seconds to allow index use.
    const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);
    const untilEpoch = Math.floor(new Date(until).getTime() / 1000);

    logger.info('[V06Reconciliation] Spot OHLCV 1m: querying (single CTE)...');
    const rows = await this.extDb.query(`
      WITH priced AS (
        SELECT
          d.base_mint_acct                                       AS token,
          date_trunc('minute', to_timestamp(s.unix_timestamp))   AS bucket,
          s.unix_timestamp,
          s.id,
          CASE WHEN LOWER(TRIM(s.swap_type)) = 'buy'
            THEN s.input_amount::numeric / NULLIF(s.output_amount::numeric, 0)
            ELSE s.output_amount::numeric / NULLIF(s.input_amount::numeric, 0)
          END                                                    AS price,
          CASE WHEN LOWER(TRIM(s.swap_type)) = 'buy' THEN s.output_amount::numeric ELSE s.input_amount::numeric END AS base_amt,
          CASE WHEN LOWER(TRIM(s.swap_type)) = 'buy' THEN s.input_amount::numeric  ELSE s.output_amount::numeric END AS target_amt,
          CASE WHEN LOWER(TRIM(s.swap_type)) = 'buy' THEN s.input_amount::numeric  ELSE 0 END AS buy_amt,
          CASE WHEN LOWER(TRIM(s.swap_type)) = 'sell' THEN s.input_amount::numeric ELSE 0 END AS sell_amt
        FROM v0_6_spot_swaps s
        JOIN v0_6_daos d ON d.dao_addr = s.dao_addr
        WHERE s.unix_timestamp >= $1
          AND s.unix_timestamp < $2
          AND s.input_amount > 0 AND s.output_amount > 0
          AND LOWER(TRIM(s.swap_type)) IN ('buy', 'sell')
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY token, bucket ORDER BY unix_timestamp ASC,  id ASC)  AS rn_first,
          ROW_NUMBER() OVER (PARTITION BY token, bucket ORDER BY unix_timestamp DESC, id DESC) AS rn_last
        FROM priced
      )
      SELECT
        token,
        bucket,
        MAX(CASE WHEN rn_first = 1 THEN price END) AS open,
        MAX(price)                                  AS high,
        MIN(price)                                  AS low,
        MAX(CASE WHEN rn_last  = 1 THEN price END) AS close,
        AVG(price)                                  AS average_price,
        SUM(base_amt)                               AS base_volume,
        SUM(target_amt)                             AS target_volume,
        SUM(buy_amt)                                AS buy_volume,
        SUM(sell_amt)                               AS sell_volume,
        COUNT(*)::int                               AS trade_count
      FROM ranked
      GROUP BY token, bucket
    `, [sinceEpoch, untilEpoch]);
    logger.info(`[V06Reconciliation] Spot OHLCV 1m: got ${rows.rows.length} rows`);

    if (rows.rows.length === 0) {
      logger.info('[V06Reconciliation] Spot OHLCV 1m: no rows');
      return;
    }

    // Batch upsert into app DB using multi-value INSERT
    const pool = this.appDb.pool;
    if (!pool) return;

    const BATCH_SIZE = 500;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < rows.rows.length; i += BATCH_SIZE) {
        const batch = rows.rows.slice(i, i + BATCH_SIZE);
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((row: any, idx: number) => {
          const offset = idx * 12;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, true, CURRENT_TIMESTAMP)`
          );
          values.push(
            row.token, row.bucket,
            Number(row.open), Number(row.high), Number(row.low), Number(row.close),
            Number(row.average_price),
            Number(row.base_volume), Number(row.target_volume),
            Number(row.buy_volume), Number(row.sell_volume),
            row.trade_count,
          );
        });

        await client.query(`
          INSERT INTO v06_spot_ohlcv_1m
            (token, bucket, open, high, low, close, average_price,
             base_volume, target_volume, buy_volume, sell_volume, trade_count, is_complete, updated_at)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (token, bucket) DO UPDATE SET
            open = EXCLUDED.open,
            high = EXCLUDED.high,
            low = EXCLUDED.low,
            close = EXCLUDED.close,
            average_price = EXCLUDED.average_price,
            base_volume = EXCLUDED.base_volume,
            target_volume = EXCLUDED.target_volume,
            buy_volume = EXCLUDED.buy_volume,
            sell_volume = EXCLUDED.sell_volume,
            trade_count = EXCLUDED.trade_count,
            is_complete = true,
            updated_at = CURRENT_TIMESTAMP
        `, values);
      }

      await client.query('COMMIT');
      logger.info(`[V06Reconciliation] Spot OHLCV 1m: upserted ${rows.rows.length} buckets`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // 2) Spot OHLCV daily — rollup from 1m in app DB
  // ------------------------------------------------------------------

  private async reconcileSpotOhlcv1d(since: Date): Promise<void> {
    const pool = this.appDb.pool;
    if (!pool) return;

    const dayStart = new Date(since);
    dayStart.setUTCHours(0, 0, 0, 0);

    await pool.query(`
      INSERT INTO v06_spot_ohlcv_1d
        (token, bucket, open, high, low, close, average_price,
         base_volume, target_volume, buy_volume, sell_volume, trade_count, is_complete, updated_at)
      SELECT
        token,
        date_trunc('day', bucket) AS bucket,
        (array_agg(open ORDER BY bucket ASC))[1]   AS open,
        MAX(high)                                   AS high,
        MIN(CASE WHEN low > 0 THEN low END)         AS low,
        (array_agg(close ORDER BY bucket DESC))[1]  AS close,
        CASE WHEN SUM(base_volume) > 0
          THEN SUM(average_price * base_volume) / SUM(base_volume)
          ELSE 0 END                                AS average_price,
        SUM(base_volume)                            AS base_volume,
        SUM(target_volume)                          AS target_volume,
        SUM(buy_volume)                             AS buy_volume,
        SUM(sell_volume)                             AS sell_volume,
        SUM(trade_count)                             AS trade_count,
        -- A day is complete only if it's in the past
        CASE WHEN date_trunc('day', bucket) < date_trunc('day', NOW()) THEN true ELSE false END,
        CURRENT_TIMESTAMP
      FROM v06_spot_ohlcv_1m
      WHERE bucket >= $1
      GROUP BY token, date_trunc('day', bucket)
      ON CONFLICT (token, bucket) DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        average_price = EXCLUDED.average_price,
        base_volume = EXCLUDED.base_volume,
        target_volume = EXCLUDED.target_volume,
        buy_volume = EXCLUDED.buy_volume,
        sell_volume = EXCLUDED.sell_volume,
        trade_count = EXCLUDED.trade_count,
        is_complete = EXCLUDED.is_complete,
        updated_at = CURRENT_TIMESTAMP
    `, [dayStart]);

    logger.info('[V06Reconciliation] Spot OHLCV 1d: rollup complete');
  }

  // ------------------------------------------------------------------
  // 3) Fee volume daily — spot
  // ------------------------------------------------------------------

  private async reconcileFeeDailySpot(since: string, until: string): Promise<void> {
    // #10: Use epoch-second comparison for index-friendly WHERE.
    // #11: Compute fee columns in SQL to avoid JS numeric precision loss.
    const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);
    const untilEpoch = Math.floor(new Date(until).getTime() / 1000);

    logger.info('[V06Reconciliation] Fee daily spot: querying...');
    const rows = await this.extDb.query(`
      SELECT
        d.base_mint_acct                               AS token,
        date_trunc('day', to_timestamp(s.unix_timestamp))::date AS swap_date,
        SUM(CASE WHEN LOWER(TRIM(s.swap_type)) = 'buy' THEN s.input_amount::numeric  ELSE 0 END) AS buy_volume,
        SUM(CASE WHEN LOWER(TRIM(s.swap_type)) = 'sell' THEN s.input_amount::numeric ELSE 0 END) AS sell_volume,
        SUM(CASE WHEN LOWER(TRIM(s.swap_type)) = 'buy' THEN s.output_amount::numeric ELSE s.input_amount::numeric END) AS base_volume,
        SUM(CASE WHEN LOWER(TRIM(s.swap_type)) = 'buy' THEN s.input_amount::numeric  ELSE s.output_amount::numeric END) AS target_volume,
        COUNT(*)::int AS trade_count,
        SUM(CASE WHEN LOWER(TRIM(s.swap_type)) = 'sell' THEN s.output_amount::numeric ELSE 0 END) AS sell_output_usdc
      FROM v0_6_spot_swaps s
      JOIN v0_6_daos d ON d.dao_addr = s.dao_addr
      WHERE s.unix_timestamp >= $1
        AND s.unix_timestamp < $2
        AND s.input_amount > 0 AND s.output_amount > 0
        AND LOWER(TRIM(s.swap_type)) IN ('buy', 'sell')
      GROUP BY d.base_mint_acct, date_trunc('day', to_timestamp(s.unix_timestamp))::date
    `, [sinceEpoch, untilEpoch]);

    if (rows.rows.length === 0) {
      logger.info('[V06Reconciliation] Fee daily spot: no rows');
      return;
    }

    const pool = this.appDb.pool;
    if (!pool) return;

    const BATCH_SIZE = 500;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < rows.rows.length; i += BATCH_SIZE) {
        const batch = rows.rows.slice(i, i + BATCH_SIZE);
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((r: any, idx: number) => {
          const dateStr = r.swap_date instanceof Date
            ? r.swap_date.toISOString().slice(0, 10)
            : String(r.swap_date);
          const offset = idx * 8;
          // #11: Pass raw volumes + fee rate; compute fees in SQL as NUMERIC arithmetic
          placeholders.push(
            `($${offset + 1}, $${offset + 2}::date, $${offset + 3}::numeric, $${offset + 4}::numeric, $${offset + 5}::numeric, $${offset + 6}::numeric, $${offset + 7}::int, $${offset + 8}::numeric)`
          );
          values.push(
            r.token, dateStr,
            r.buy_volume, r.sell_volume,
            r.base_volume, r.target_volume,
            r.trade_count,
            r.sell_output_usdc,
          );
        });

        await client.query(`
          INSERT INTO v06_fee_volume_daily_spot
            (token, date, buy_volume, sell_volume, base_volume, target_volume, trade_count,
             usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc, updated_at)
          SELECT
            v.token, v.date, v.buy_volume, v.sell_volume, v.base_volume, v.target_volume, v.trade_count,
            v.buy_volume * ${FEE_RATE}::numeric   AS usdc_fees,
            v.sell_volume * ${FEE_RATE}::numeric  AS token_fees,
            v.sell_output_usdc * ${FEE_RATE}::numeric AS token_fees_usdc,
            v.sell_output_usdc,
            CURRENT_TIMESTAMP
          FROM (VALUES ${placeholders.join(', ')})
            AS v(token, date, buy_volume, sell_volume, base_volume, target_volume, trade_count, sell_output_usdc)
          ON CONFLICT (token, date) DO UPDATE SET
            buy_volume = EXCLUDED.buy_volume,
            sell_volume = EXCLUDED.sell_volume,
            base_volume = EXCLUDED.base_volume,
            target_volume = EXCLUDED.target_volume,
            trade_count = EXCLUDED.trade_count,
            usdc_fees = EXCLUDED.usdc_fees,
            token_fees = EXCLUDED.token_fees,
            token_fees_usdc = EXCLUDED.token_fees_usdc,
            sell_volume_usdc = EXCLUDED.sell_volume_usdc,
            updated_at = CURRENT_TIMESTAMP
        `, values);
      }

      await client.query('COMMIT');
      logger.info(`[V06Reconciliation] Fee daily spot: upserted ${rows.rows.length} rows`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // 4) Fee volume daily — conditional (winning market only)
  // ------------------------------------------------------------------

  private async reconcileFeeDailyConditional(since: string, until: string): Promise<void> {
    // #9:  Batch upserts (multi-value INSERT) instead of row-by-row.
    // #10: Use epoch-second comparison for index-friendly WHERE.
    // #11: Compute fee columns in SQL to avoid JS numeric precision loss.
    const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);
    const untilEpoch = Math.floor(new Date(until).getTime() / 1000);

    // Only include swaps where:
    //   - proposal is Passed → keep market = 'pass'
    //   - proposal is Failed → keep market = 'fail'
    logger.info('[V06Reconciliation] Fee daily conditional: querying winning-market swaps...');
    const rows = await this.extDb.query(`
      SELECT
        d.base_mint_acct                                             AS token,
        date_trunc('day', to_timestamp(c.unix_timestamp))::date      AS swap_date,
        SUM(CASE WHEN LOWER(TRIM(c.swap_type)) = 'buy' THEN c.input_amount::numeric  ELSE 0 END) AS buy_volume,
        SUM(CASE WHEN LOWER(TRIM(c.swap_type)) = 'sell' THEN c.input_amount::numeric ELSE 0 END) AS sell_volume,
        SUM(CASE WHEN LOWER(TRIM(c.swap_type)) = 'buy' THEN c.output_amount::numeric ELSE c.input_amount::numeric END) AS base_volume,
        SUM(CASE WHEN LOWER(TRIM(c.swap_type)) = 'buy' THEN c.input_amount::numeric  ELSE c.output_amount::numeric END) AS target_volume,
        COUNT(*)::int AS trade_count,
        SUM(CASE WHEN LOWER(TRIM(c.swap_type)) = 'sell' THEN c.output_amount::numeric ELSE 0 END) AS sell_output_usdc
      FROM v0_6_conditional_swaps c
      JOIN v0_6_proposals p ON p.proposal_addr = c.proposal_addr
      JOIN v0_6_daos d ON d.dao_addr = p.dao_addr
      WHERE c.unix_timestamp >= $1
        AND c.unix_timestamp < $2
        AND c.input_amount > 0 AND c.output_amount > 0
        AND LOWER(TRIM(c.swap_type)) IN ('buy', 'sell')
        AND (
          (p.state = 'Passed' AND LOWER(TRIM(c.market)) = 'pass')
          OR
          (p.state = 'Failed' AND LOWER(TRIM(c.market)) = 'fail')
        )
      GROUP BY d.base_mint_acct, date_trunc('day', to_timestamp(c.unix_timestamp))::date
    `, [sinceEpoch, untilEpoch]);

    // Also count how many open (non-terminal) proposals have swaps in this window
    logger.info('[V06Reconciliation] Fee daily conditional: querying pending proposals...');
    const pendingRows = await this.extDb.query(`
      SELECT
        d.base_mint_acct                                           AS token,
        date_trunc('day', to_timestamp(c.unix_timestamp))::date    AS swap_date,
        COUNT(DISTINCT p.proposal_addr)::int                       AS pending_count
      FROM v0_6_conditional_swaps c
      JOIN v0_6_proposals p ON p.proposal_addr = c.proposal_addr
      JOIN v0_6_daos d ON d.dao_addr = p.dao_addr
      WHERE c.unix_timestamp >= $1
        AND c.unix_timestamp < $2
        AND p.state NOT IN ('Passed', 'Failed')
      GROUP BY d.base_mint_acct, date_trunc('day', to_timestamp(c.unix_timestamp))::date
    `, [sinceEpoch, untilEpoch]);

    // Normalise swap_date coming from pg (Date objects) into YYYY-MM-DD strings
    // so that Bun's Date.toString() (which emits un-parseable "GMT-0700") never
    // leaks into map keys or query parameters.
    const normDate = (d: unknown): string =>
      d instanceof Date ? d.toISOString().slice(0, 10) : String(d);

    const pendingMap = new Map<string, number>();
    for (const r of pendingRows.rows) {
      pendingMap.set(`${r.token}|${normDate(r.swap_date)}`, r.pending_count);
    }

    // Build a lookup map for winning-market rows (avoids O(n×m) find inside loop)
    const winRowMap = new Map<string, any>();
    for (const r of rows.rows) {
      winRowMap.set(`${r.token}|${normDate(r.swap_date)}`, r);
    }

    const pool = this.appDb.pool;
    if (!pool) return;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Collect all token-date keys that need a row
      const allKeys = new Set<string>();
      for (const r of rows.rows) allKeys.add(`${r.token}|${normDate(r.swap_date)}`);
      for (const key of pendingMap.keys()) allKeys.add(key);

      // Split into rows that have winning-market data vs pending-only
      const winEntries: { token: string; date: string; row: any; pending: number; reconciled: boolean }[] = [];
      const pendingOnlyEntries: { token: string; date: string; pending: number }[] = [];

      for (const key of allKeys) {
        const separatorIdx = key.indexOf('|');
        const token = key.slice(0, separatorIdx);
        const swapDateStr = key.slice(separatorIdx + 1);
        const winRow = winRowMap.get(key);
        const pendingCount = pendingMap.get(key) ?? 0;
        if (winRow) {
          winEntries.push({ token, date: swapDateStr, row: winRow, pending: pendingCount, reconciled: pendingCount === 0 });
        } else {
          pendingOnlyEntries.push({ token, date: swapDateStr, pending: pendingCount });
        }
      }

      // Batch upsert winning-market rows with fee math in SQL
      const BATCH_SIZE = 500;
      for (let i = 0; i < winEntries.length; i += BATCH_SIZE) {
        const batch = winEntries.slice(i, i + BATCH_SIZE);
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((entry, idx) => {
          const offset = idx * 10;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}::date, $${offset + 3}::numeric, $${offset + 4}::numeric, $${offset + 5}::numeric, $${offset + 6}::numeric, $${offset + 7}::int, $${offset + 8}::numeric, $${offset + 9}::boolean, $${offset + 10}::int)`
          );
          values.push(
            entry.token, entry.date,
            entry.row.buy_volume, entry.row.sell_volume,
            entry.row.base_volume, entry.row.target_volume,
            entry.row.trade_count,
            entry.row.sell_output_usdc,
            entry.reconciled, entry.pending,
          );
        });

        await client.query(`
          INSERT INTO v06_fee_volume_daily_conditional
            (token, date, buy_volume, sell_volume, base_volume, target_volume, trade_count,
             usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc,
             conditional_reconciled, pending_open_proposals, updated_at)
          SELECT
            v.token, v.date, v.buy_volume, v.sell_volume, v.base_volume, v.target_volume, v.trade_count,
            v.buy_volume * ${FEE_RATE}::numeric       AS usdc_fees,
            v.sell_volume * ${FEE_RATE}::numeric      AS token_fees,
            v.sell_output_usdc * ${FEE_RATE}::numeric AS token_fees_usdc,
            v.sell_output_usdc,
            v.reconciled, v.pending,
            CURRENT_TIMESTAMP
          FROM (VALUES ${placeholders.join(', ')})
            AS v(token, date, buy_volume, sell_volume, base_volume, target_volume, trade_count, sell_output_usdc, reconciled, pending)
          ON CONFLICT (token, date) DO UPDATE SET
            buy_volume = EXCLUDED.buy_volume,
            sell_volume = EXCLUDED.sell_volume,
            base_volume = EXCLUDED.base_volume,
            target_volume = EXCLUDED.target_volume,
            trade_count = EXCLUDED.trade_count,
            usdc_fees = EXCLUDED.usdc_fees,
            token_fees = EXCLUDED.token_fees,
            token_fees_usdc = EXCLUDED.token_fees_usdc,
            sell_volume_usdc = EXCLUDED.sell_volume_usdc,
            conditional_reconciled = EXCLUDED.conditional_reconciled,
            pending_open_proposals = EXCLUDED.pending_open_proposals,
            updated_at = CURRENT_TIMESTAMP
        `, values);
      }

      // Batch upsert pending-only rows (no winning-market volume yet)
      for (let i = 0; i < pendingOnlyEntries.length; i += BATCH_SIZE) {
        const batch = pendingOnlyEntries.slice(i, i + BATCH_SIZE);
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((entry, idx) => {
          const offset = idx * 3;
          placeholders.push(`($${offset + 1}, $${offset + 2}::date, $${offset + 3}::int)`);
          values.push(entry.token, entry.date, entry.pending);
        });

        await client.query(`
          INSERT INTO v06_fee_volume_daily_conditional
            (token, date, conditional_reconciled, pending_open_proposals, updated_at)
          SELECT v.token, v.date, false, v.pending, CURRENT_TIMESTAMP
          FROM (VALUES ${placeholders.join(', ')})
            AS v(token, date, pending)
          ON CONFLICT (token, date) DO UPDATE SET
            conditional_reconciled = false,
            pending_open_proposals = EXCLUDED.pending_open_proposals,
            updated_at = CURRENT_TIMESTAMP
        `, values);
      }

      await client.query('COMMIT');
      logger.info(`[V06Reconciliation] Fee daily conditional: upserted ${allKeys.size} rows`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------
  // 5) Fee volume daily aggregate — join spot + conditional from app DB
  // ------------------------------------------------------------------

  private async reconcileFeeDailyAggregate(since: Date): Promise<void> {
    const pool = this.appDb.pool;
    if (!pool) return;

    const dayStart = new Date(since);
    dayStart.setUTCHours(0, 0, 0, 0);

    await pool.query(`
      INSERT INTO v06_fee_volume_daily_aggregate
        (token, date,
         spot_buy_volume, spot_sell_volume, spot_base_volume, spot_target_volume,
         spot_trade_count, spot_usdc_fees, spot_token_fees, spot_token_fees_usdc,
         conditional_buy_volume, conditional_sell_volume, conditional_base_volume, conditional_target_volume,
         conditional_trade_count, conditional_usdc_fees, conditional_token_fees, conditional_token_fees_usdc,
         total_buy_volume, total_sell_volume, total_base_volume, total_target_volume,
         total_trade_count, total_usdc_fees, total_token_fees, total_token_fees_usdc,
         conditional_reconciled, pending_open_proposals, updated_at)
      SELECT
        COALESCE(s.token, c.token)         AS token,
        COALESCE(s.date, c.date)           AS date,
        -- spot
        COALESCE(s.buy_volume, 0),
        COALESCE(s.sell_volume, 0),
        COALESCE(s.base_volume, 0),
        COALESCE(s.target_volume, 0),
        COALESCE(s.trade_count, 0),
        COALESCE(s.usdc_fees, 0),
        COALESCE(s.token_fees, 0),
        COALESCE(s.token_fees_usdc, 0),
        -- conditional (nullable)
        c.buy_volume,
        c.sell_volume,
        c.base_volume,
        c.target_volume,
        c.trade_count,
        c.usdc_fees,
        c.token_fees,
        c.token_fees_usdc,
        -- totals
        COALESCE(s.buy_volume, 0)    + COALESCE(c.buy_volume, 0),
        COALESCE(s.sell_volume, 0)   + COALESCE(c.sell_volume, 0),
        COALESCE(s.base_volume, 0)   + COALESCE(c.base_volume, 0),
        COALESCE(s.target_volume, 0) + COALESCE(c.target_volume, 0),
        COALESCE(s.trade_count, 0)   + COALESCE(c.trade_count, 0),
        COALESCE(s.usdc_fees, 0)     + COALESCE(c.usdc_fees, 0),
        COALESCE(s.token_fees, 0)    + COALESCE(c.token_fees, 0),
        COALESCE(s.token_fees_usdc, 0) + COALESCE(c.token_fees_usdc, 0),
        -- reconciliation
        COALESCE(c.conditional_reconciled, true),
        COALESCE(c.pending_open_proposals, 0),
        CURRENT_TIMESTAMP
      FROM v06_fee_volume_daily_spot s
      FULL OUTER JOIN v06_fee_volume_daily_conditional c
        ON s.token = c.token AND s.date = c.date
      WHERE COALESCE(s.date, c.date) >= $1::date
      ON CONFLICT (token, date) DO UPDATE SET
        spot_buy_volume     = EXCLUDED.spot_buy_volume,
        spot_sell_volume    = EXCLUDED.spot_sell_volume,
        spot_base_volume    = EXCLUDED.spot_base_volume,
        spot_target_volume  = EXCLUDED.spot_target_volume,
        spot_trade_count    = EXCLUDED.spot_trade_count,
        spot_usdc_fees      = EXCLUDED.spot_usdc_fees,
        spot_token_fees     = EXCLUDED.spot_token_fees,
        spot_token_fees_usdc = EXCLUDED.spot_token_fees_usdc,
        conditional_buy_volume     = EXCLUDED.conditional_buy_volume,
        conditional_sell_volume    = EXCLUDED.conditional_sell_volume,
        conditional_base_volume    = EXCLUDED.conditional_base_volume,
        conditional_target_volume  = EXCLUDED.conditional_target_volume,
        conditional_trade_count    = EXCLUDED.conditional_trade_count,
        conditional_usdc_fees      = EXCLUDED.conditional_usdc_fees,
        conditional_token_fees     = EXCLUDED.conditional_token_fees,
        conditional_token_fees_usdc = EXCLUDED.conditional_token_fees_usdc,
        total_buy_volume     = EXCLUDED.total_buy_volume,
        total_sell_volume    = EXCLUDED.total_sell_volume,
        total_base_volume    = EXCLUDED.total_base_volume,
        total_target_volume  = EXCLUDED.total_target_volume,
        total_trade_count    = EXCLUDED.total_trade_count,
        total_usdc_fees      = EXCLUDED.total_usdc_fees,
        total_token_fees     = EXCLUDED.total_token_fees,
        total_token_fees_usdc = EXCLUDED.total_token_fees_usdc,
        conditional_reconciled  = EXCLUDED.conditional_reconciled,
        pending_open_proposals  = EXCLUDED.pending_open_proposals,
        updated_at = CURRENT_TIMESTAMP
    `, [dayStart]);

    logger.info('[V06Reconciliation] Fee daily aggregate: upsert complete');
  }
}
