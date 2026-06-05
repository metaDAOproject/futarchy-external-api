import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Rolling24hMetrics } from './databaseService.js';

// Force pg to serialize Date parameters as ISO-8601 UTC strings so PostgreSQL
// doesn't receive un-parseable local-timezone names like "GMT-0700".
pg.defaults.parseInputDatesAsUTC = true;

const { Pool } = pg;

/**
 * Read-only connection pool to the external indexer database.
 * Used by v0.6 reconciliation to query v0_6_spot_swaps,
 * v0_6_conditional_swaps, v0_6_daos, and v0_6_proposals, and by /api/tickers to
 * read rolling-24h spot metrics directly from futarchy.trades.
 */
export class ExternalDatabaseService {
  private pool: pg.Pool | null = null;
  private isConnected: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;

  private static readonly HEALTH_CHECK_INTERVAL_MS = 60_000;
  private static readonly MAX_FAILURES_BEFORE_RECONNECT = 3;

  async initialize(): Promise<boolean> {
    if (!config.externalDatabase.connectionString) {
      logger.info('[ExternalDB] No EXTERNAL_DATABASE_URL configured — v0.6 reconciliation disabled');
      return false;
    }

    try {
      this.createPool();

      const client = await this.pool!.connect();
      client.release();
      this.isConnected = true;
      logger.info('[ExternalDB] Connected to external indexer database (read-only)');
      this.startHealthCheck();
      return true;
    } catch (error: any) {
      logger.error('[ExternalDB] Failed to connect:', error);
      this.isConnected = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.isConnected && this.pool !== null;
  }

  async query(text: string, params?: any[]): Promise<pg.QueryResult> {
    if (!this.pool || !this.isConnected) {
      throw new Error('External database not connected');
    }
    return this.pool.query(text, params);
  }

  /**
   * Rolling 24h spot-market volume metrics per DAO, read directly from the
   * indexer's per-swap futarchy.trades table (no Dune, no app-DB rollup).
   *
   * Keyed by dao_addr (= the ticker's pool_id), so the caller needs no
   * token→dao remap. Amounts are raw on-chain integers, so base/quote volume
   * are scaled by each side's real decimals (futarchy.tokens.decimals, default
   * 6) and price (raw quote/base) is rescaled to human units by
   * 10^(baseDecimals − quoteDecimals) — matching the decimal-aware last_price.
   *
   * Returns an empty Map if the connection is down or no spot trades exist in
   * the window (caller treats that as "fall back to another source").
   */
  async getSpotRolling24hMetrics(daoAddrs: string[]): Promise<Map<string, Rolling24hMetrics>> {
    if (!this.pool || !this.isConnected || daoAddrs.length === 0) {
      return new Map();
    }

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const result = await this.pool.query(
        `SELECT
           t.dao_addr,
           (SUM(t.base_amount)  / power(10::numeric, COALESCE(bt.decimals, 6)))::text  AS base_volume_24h,
           (SUM(t.quote_amount) / power(10::numeric, COALESCE(qt.decimals, 6)))::text  AS target_volume_24h,
           (MAX(t.price) * power(10::numeric, COALESCE(bt.decimals, 6) - COALESCE(qt.decimals, 6)))::text AS high_24h,
           (MIN(t.price) FILTER (WHERE t.price > 0) * power(10::numeric, COALESCE(bt.decimals, 6) - COALESCE(qt.decimals, 6)))::text AS low_24h,
           COUNT(*)::int AS trade_count_24h
         FROM futarchy.trades t
         JOIN futarchy.daos d ON d.dao_addr = t.dao_addr
         LEFT JOIN futarchy.tokens bt ON bt.mint = d.base_mint
         LEFT JOIN futarchy.tokens qt ON qt.mint = d.quote_mint
         WHERE t.market_kind = 'spot'
           AND t.block_time >= $1
           AND t.dao_addr = ANY($2::text[])
         GROUP BY t.dao_addr, bt.decimals, qt.decimals`,
        [cutoff, daoAddrs]
      );

      const metricsMap = new Map<string, Rolling24hMetrics>();
      for (const row of result.rows) {
        metricsMap.set(row.dao_addr, {
          token: row.dao_addr,
          base_volume_24h: row.base_volume_24h ?? '0',
          target_volume_24h: row.target_volume_24h ?? '0',
          high_24h: row.high_24h ?? '0',
          low_24h: row.low_24h ?? '0',
          trade_count_24h: row.trade_count_24h ?? 0,
        });
      }
      return metricsMap;
    } catch (error: any) {
      logger.error('[ExternalDB] Error getting spot rolling 24h metrics from futarchy.trades:', error);
      return new Map();
    }
  }

  /**
   * Daily Meteora volumes read DIRECTLY from the meteora accounting ETL's
   * `futarchy.meteora_daily` view in our served DB — the source of truth that
   * replaces the Dune-sourced `daily_meteora_volumes` app-DB table.
   *
   * Returns the SAME column contract as the old (Dune) path so /api/market-data
   * consumers are unchanged: token (base mint), date, base_volume, target_volume,
   * buy_volume, sell_volume, trade_count, average_price, usdc_fees, token_fees,
   * token_fees_usdc, token_per_usdc. Returns an empty array if the connection is
   * down (the route serves an empty meteora list in that case).
   */
  async getDailyMeteoraVolumes(options?: {
    token?: string;
    tokens?: string[];
    startDate?: string;
    endDate?: string;
  }): Promise<Array<{
    token: string; date: string; base_volume: string; target_volume: string;
    buy_volume: string; sell_volume: string; trade_count: number; average_price: string;
    usdc_fees: string; token_fees: string; token_fees_usdc: string; token_per_usdc: string;
  }>> {
    if (!this.pool || !this.isConnected) {
      return [];
    }
    const conditions: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (options?.tokens && options.tokens.length > 0) {
      conditions.push(`token = ANY($${i}::text[])`);
      params.push(options.tokens);
      i++;
    } else if (options?.token) {
      conditions.push(`token = $${i}`);
      params.push(options.token);
      i++;
    }
    if (options?.startDate) {
      conditions.push(`date >= $${i}`);
      params.push(options.startDate);
      i++;
    }
    if (options?.endDate) {
      conditions.push(`date <= $${i}`);
      params.push(options.endDate);
      i++;
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
      const result = await this.pool.query(
        `SELECT
           token,
           date::text,
           base_volume::text,
           target_volume::text,
           buy_volume::text,
           sell_volume::text,
           trade_count,
           average_price::text,
           usdc_fees::text,
           token_fees::text,
           token_fees_usdc::text,
           token_per_usdc::text
         FROM futarchy.meteora_daily
         ${whereClause}
         ORDER BY token, date ASC`,
        params
      );
      return result.rows;
    } catch (error: any) {
      // Surface query/schema failures — do NOT mask as empty. For a financial endpoint,
      // an empty array must mean "genuinely no rows", never "the query failed". The caller
      // (market route) guards `isAvailable()` for the connection-down case and lets a real
      // failure propagate to a 5xx instead of returning 200 with zero volume.
      logger.error('[ExternalDB] Error getting daily Meteora volumes from futarchy.meteora_daily:', error);
      throw error;
    }
  }

  /**
   * First spot-trade date per token (base mint), from the v0.6 indexer's per-swap
   * v0_6_spot_swaps in the served DB (replaces the frozen Dune buy/sell volumes table).
   * Returns Map<token(base mint), 'YYYY-MM-DD'>. Empty map if the connection is down.
   */
  async getFirstTradeDates(): Promise<Map<string, string>> {
    if (!this.pool || !this.isConnected) {
      return new Map();
    }
    try {
      const result = await this.pool.query(
        `SELECT d.base_mint_acct AS token,
                MIN((to_timestamp(s.unix_timestamp) AT TIME ZONE 'UTC')::date)::text AS first_date
           FROM v0_6_spot_swaps s
           JOIN v0_6_daos d ON d.dao_addr = s.dao_addr
          GROUP BY d.base_mint_acct`
      );
      const m = new Map<string, string>();
      for (const row of result.rows) m.set(row.token, row.first_date);
      return m;
    } catch (error: any) {
      logger.error('[ExternalDB] Error getting first trade dates from v0_6_spot_swaps:', error);
      return new Map();
    }
  }

  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      logger.info('[ExternalDB] Connection closed');
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.pool!.query('SELECT 1');
        if (!this.isConnected) {
          logger.info('[ExternalDB] Connection recovered');
        }
        this.isConnected = true;
        this.consecutiveFailures = 0;
      } catch (error: any) {
        this.consecutiveFailures++;
        this.isConnected = false;
        logger.error(
          `[ExternalDB] Health check failed (${this.consecutiveFailures}/${ExternalDatabaseService.MAX_FAILURES_BEFORE_RECONNECT})`,
          error
        );

        if (this.consecutiveFailures >= ExternalDatabaseService.MAX_FAILURES_BEFORE_RECONNECT) {
          logger.error('[ExternalDB] Max consecutive failures reached — recreating connection pool');
          await this.reconnect();
        }
      }
    }, ExternalDatabaseService.HEALTH_CHECK_INTERVAL_MS);
  }

  private async reconnect(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.end().catch(() => {});
      }
    } catch {
      // ignore — pool may already be dead
    }

    this.createPool();

    try {
      await this.pool!.query('SELECT 1');
      this.isConnected = true;
      this.consecutiveFailures = 0;
      logger.info('[ExternalDB] Reconnected successfully after pool recreation');
    } catch (error: any) {
      logger.error('[ExternalDB] Reconnection attempt failed — will retry on next health check', error);
    }
  }

  private createPool(): void {
    this.pool = new Pool({
      connectionString: config.externalDatabase.connectionString,
      ssl: config.externalDatabase.ssl ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    this.pool.on('error', (err: Error) => {
      logger.error('[ExternalDB] Pool error', err);
      this.isConnected = false;
    });
  }
}
