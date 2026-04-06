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
 *   3. Fee volume daily spot — aggregate spot swaps by calendar day
 *   4. Fee volume daily conditional — winning-market-only swaps
 *   5. Fee volume daily aggregate — spot + conditional totals
 */
export class V06ReconciliationService {
  private scheduledTask: ScheduledTask | null = null;
  private static readonly RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly LOOKBACK_HOURS = 26; // re-touch recent window to catch late state changes

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
    await this.reconcileSpotOhlcv1d(windowStart);
    await this.reconcileFeeDailySpot(sinceISO, untilISO);
    await this.reconcileFeeDailyConditional(sinceISO, untilISO);
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

    await this.reconcileFeeDailySpot(sinceISO, untilISO);
    await this.reconcileFeeDailyConditional(sinceISO, untilISO);
    await this.reconcileFeeDailyAggregate(windowStart);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info(`[V06Reconciliation] Fee-only cycle complete in ${elapsed}s`);
  }

  // ------------------------------------------------------------------
  // 1) Spot OHLCV 1-minute
  // ------------------------------------------------------------------

  private async reconcileSpotOhlcv1m(since: string, until: string): Promise<void> {
    logger.info('[V06Reconciliation] Spot OHLCV 1m: querying aggregates...');
    const rows = await this.extDb.query(`
      SELECT
        d.base_mint_acct                                       AS token,
        date_trunc('minute', to_timestamp(s.unix_timestamp))   AS bucket,
        -- OHLC via first_value / last_value requires window; use subquery approach
        MIN(CASE WHEN s.swap_type = 'Buy'
              THEN s.input_amount::numeric / NULLIF(s.output_amount::numeric, 0)
              ELSE s.output_amount::numeric / NULLIF(s.input_amount::numeric, 0)
            END)                                               AS low,
        MAX(CASE WHEN s.swap_type = 'Buy'
              THEN s.input_amount::numeric / NULLIF(s.output_amount::numeric, 0)
              ELSE s.output_amount::numeric / NULLIF(s.input_amount::numeric, 0)
            END)                                               AS high,
        AVG(CASE WHEN s.swap_type = 'Buy'
              THEN s.input_amount::numeric / NULLIF(s.output_amount::numeric, 0)
              ELSE s.output_amount::numeric / NULLIF(s.input_amount::numeric, 0)
            END)                                               AS average_price,
        SUM(CASE WHEN s.swap_type = 'Buy' THEN s.output_amount::numeric ELSE s.input_amount::numeric END) AS base_volume,
        SUM(CASE WHEN s.swap_type = 'Buy' THEN s.input_amount::numeric  ELSE s.output_amount::numeric END) AS target_volume,
        SUM(CASE WHEN s.swap_type = 'Buy' THEN s.input_amount::numeric  ELSE 0 END) AS buy_volume,
        SUM(CASE WHEN s.swap_type = 'Sell' THEN s.input_amount::numeric ELSE 0 END) AS sell_volume,
        COUNT(*)::int                                          AS trade_count
      FROM v0_6_spot_swaps s
      JOIN v0_6_daos d ON d.dao_addr = s.dao_addr
      WHERE to_timestamp(s.unix_timestamp) >= $1
        AND to_timestamp(s.unix_timestamp) < $2
        AND s.input_amount > 0 AND s.output_amount > 0
        AND LOWER(TRIM(s.swap_type)) IN ('buy', 'sell')
      GROUP BY d.base_mint_acct, date_trunc('minute', to_timestamp(s.unix_timestamp))
    `, [since, until]);
    logger.info(`[V06Reconciliation] Spot OHLCV 1m: got ${rows.rows.length} aggregate rows`);

    if (rows.rows.length === 0) {
      logger.info('[V06Reconciliation] Spot OHLCV 1m: no rows');
      return;
    }

    // We need open/close per bucket. Fetch them separately (first/last price per bucket).
    logger.info('[V06Reconciliation] Spot OHLCV 1m: querying open prices...');
    const openClose = await this.extDb.query(`
      SELECT DISTINCT ON (d.base_mint_acct, date_trunc('minute', to_timestamp(s.unix_timestamp)))
        d.base_mint_acct AS token,
        date_trunc('minute', to_timestamp(s.unix_timestamp)) AS bucket,
        CASE WHEN s.swap_type = 'Buy'
          THEN s.input_amount::numeric / NULLIF(s.output_amount::numeric, 0)
          ELSE s.output_amount::numeric / NULLIF(s.input_amount::numeric, 0)
        END AS open_price
      FROM v0_6_spot_swaps s
      JOIN v0_6_daos d ON d.dao_addr = s.dao_addr
      WHERE to_timestamp(s.unix_timestamp) >= $1
        AND to_timestamp(s.unix_timestamp) < $2
        AND s.input_amount > 0 AND s.output_amount > 0
        AND LOWER(TRIM(s.swap_type)) IN ('buy', 'sell')
      ORDER BY d.base_mint_acct, date_trunc('minute', to_timestamp(s.unix_timestamp)), s.unix_timestamp ASC, s.id ASC
    `, [since, until]);

    logger.info('[V06Reconciliation] Spot OHLCV 1m: querying close prices...');
    const closeRows = await this.extDb.query(`
      SELECT DISTINCT ON (d.base_mint_acct, date_trunc('minute', to_timestamp(s.unix_timestamp)))
        d.base_mint_acct AS token,
        date_trunc('minute', to_timestamp(s.unix_timestamp)) AS bucket,
        CASE WHEN s.swap_type = 'Buy'
          THEN s.input_amount::numeric / NULLIF(s.output_amount::numeric, 0)
          ELSE s.output_amount::numeric / NULLIF(s.input_amount::numeric, 0)
        END AS close_price
      FROM v0_6_spot_swaps s
      JOIN v0_6_daos d ON d.dao_addr = s.dao_addr
      WHERE to_timestamp(s.unix_timestamp) >= $1
        AND to_timestamp(s.unix_timestamp) < $2
        AND s.input_amount > 0 AND s.output_amount > 0
        AND LOWER(TRIM(s.swap_type)) IN ('buy', 'sell')
      ORDER BY d.base_mint_acct, date_trunc('minute', to_timestamp(s.unix_timestamp)), s.unix_timestamp DESC, s.id DESC
    `, [since, until]);

    // Build lookup maps
    const openMap = new Map<string, number>();
    for (const r of openClose.rows) {
      openMap.set(`${r.token}|${new Date(r.bucket).toISOString()}`, Number(r.open_price));
    }
    const closeMap = new Map<string, number>();
    for (const r of closeRows.rows) {
      closeMap.set(`${r.token}|${new Date(r.bucket).toISOString()}`, Number(r.close_price));
    }

    // Batch upsert into app DB
    const pool = this.appDb.pool;
    if (!pool) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const row of rows.rows) {
        const key = `${row.token}|${new Date(row.bucket).toISOString()}`;
        const openPrice = openMap.get(key) ?? 0;
        const closePrice = closeMap.get(key) ?? 0;

        await client.query(`
          INSERT INTO v06_spot_ohlcv_1m
            (token, bucket, open, high, low, close, average_price,
             base_volume, target_volume, buy_volume, sell_volume, trade_count, is_complete, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, CURRENT_TIMESTAMP)
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
        `, [
          row.token, row.bucket,
          openPrice, Number(row.high), Number(row.low), closePrice,
          Number(row.average_price),
          Number(row.base_volume), Number(row.target_volume),
          Number(row.buy_volume), Number(row.sell_volume),
          row.trade_count,
        ]);
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
      WHERE to_timestamp(s.unix_timestamp) >= $1
        AND to_timestamp(s.unix_timestamp) < $2
        AND s.input_amount > 0 AND s.output_amount > 0
        AND LOWER(TRIM(s.swap_type)) IN ('buy', 'sell')
      GROUP BY d.base_mint_acct, date_trunc('day', to_timestamp(s.unix_timestamp))::date
    `, [since, until]);

    if (rows.rows.length === 0) {
      logger.info('[V06Reconciliation] Fee daily spot: no rows');
      return;
    }

    const pool = this.appDb.pool;
    if (!pool) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of rows.rows) {
        const buyVol = Number(r.buy_volume);
        const sellVol = Number(r.sell_volume);
        const sellOutputUsdc = Number(r.sell_output_usdc) || 0;
        const dateStr = r.swap_date instanceof Date
          ? r.swap_date.toISOString().slice(0, 10)
          : String(r.swap_date);

        await client.query(`
          INSERT INTO v06_fee_volume_daily_spot
            (token, date, buy_volume, sell_volume, base_volume, target_volume, trade_count,
             usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
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
        `, [
          r.token, dateStr,
          buyVol, sellVol,
          Number(r.base_volume), Number(r.target_volume),
          r.trade_count,
          buyVol * FEE_RATE,                   // usdc_fees
          sellVol * FEE_RATE,                  // token_fees
          sellOutputUsdc * FEE_RATE,           // token_fees_usdc
          sellOutputUsdc,                      // sell_volume_usdc
        ]);
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
      WHERE to_timestamp(c.unix_timestamp) >= $1
        AND to_timestamp(c.unix_timestamp) < $2
        AND c.input_amount > 0 AND c.output_amount > 0
        AND LOWER(TRIM(c.swap_type)) IN ('buy', 'sell')
        AND (
          (p.state = 'Passed' AND LOWER(TRIM(c.market)) = 'pass')
          OR
          (p.state = 'Failed' AND LOWER(TRIM(c.market)) = 'fail')
        )
      GROUP BY d.base_mint_acct, date_trunc('day', to_timestamp(c.unix_timestamp))::date
    `, [since, until]);

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
      WHERE to_timestamp(c.unix_timestamp) >= $1
        AND to_timestamp(c.unix_timestamp) < $2
        AND p.state NOT IN ('Passed', 'Failed')
      GROUP BY d.base_mint_acct, date_trunc('day', to_timestamp(c.unix_timestamp))::date
    `, [since, until]);

    // Normalise swap_date coming from pg (Date objects) into YYYY-MM-DD strings
    // so that Bun's Date.toString() (which emits un-parseable "GMT-0700") never
    // leaks into map keys or query parameters.
    const normDate = (d: unknown): string =>
      d instanceof Date ? d.toISOString().slice(0, 10) : String(d);

    const pendingMap = new Map<string, number>();
    for (const r of pendingRows.rows) {
      pendingMap.set(`${r.token}|${normDate(r.swap_date)}`, r.pending_count);
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

      for (const key of allKeys) {
        const [token, swapDateStr] = key.split('|');
        const winRow = rows.rows.find((r: any) => r.token === token && normDate(r.swap_date) === swapDateStr);
        const pendingCount = pendingMap.get(key) ?? 0;
        const reconciled = pendingCount === 0;

        if (winRow) {
          const buyVol = Number(winRow.buy_volume);
          const sellVol = Number(winRow.sell_volume);
          const sellOutputUsdc = Number(winRow.sell_output_usdc) || 0;

          await client.query(`
            INSERT INTO v06_fee_volume_daily_conditional
              (token, date, buy_volume, sell_volume, base_volume, target_volume, trade_count,
               usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc,
               conditional_reconciled, pending_open_proposals, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
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
          `, [
            token, swapDateStr,
            buyVol, sellVol,
            Number(winRow.base_volume), Number(winRow.target_volume),
            winRow.trade_count,
            buyVol * FEE_RATE,
            sellVol * FEE_RATE,
            sellOutputUsdc * FEE_RATE,
            sellOutputUsdc,
            reconciled, pendingCount,
          ]);
        } else {
          // Only pending swaps exist for this token-date, no winning-market volume yet
          await client.query(`
            INSERT INTO v06_fee_volume_daily_conditional
              (token, date, conditional_reconciled, pending_open_proposals, updated_at)
            VALUES ($1, $2, false, $3, CURRENT_TIMESTAMP)
            ON CONFLICT (token, date) DO UPDATE SET
              conditional_reconciled = false,
              pending_open_proposals = EXCLUDED.pending_open_proposals,
              updated_at = CURRENT_TIMESTAMP
          `, [token, swapDateStr, pendingCount]);
        }
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
