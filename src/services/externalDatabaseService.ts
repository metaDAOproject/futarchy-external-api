import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { Rolling24hMetrics } from './databaseService.js';

// Force pg to serialize Date parameters as ISO-8601 UTC strings so PostgreSQL
// doesn't receive un-parseable local-timezone names like "GMT-0700".
pg.defaults.parseInputDatesAsUTC = true;

const { Pool } = pg;

export interface ServedDataContractStatus {
  ok: boolean;
  checkedAt: string;
  missing: string[];
}

/**
 * Read-only connection pool to the served indexer database. ALL reads come from
 * the unified user_pool ETL output here: user_pool_daily (futarchy + meteora
 * daily), user_pool_spot_ohlcv (24h metrics), and user_pool_swaps (DEX Screener
 * per-swap events + post-swap reserves). Single source of truth — no raw v0_6_*,
 * no app-DB rollups, no futarchy.trades.
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
      logger.info('[ExternalDB] No EXTERNAL_DATABASE_URL or FRONTEND_READER_PG_URL configured');
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
   * Rolling 24h spot-market metrics per token, aggregated from the unified ETL's
   * 1-minute candles (`futarchy.user_pool_spot_ohlcv`, source='futarchy_amm') in
   * the served DB. These candles are already in HUMAN units (price = USD/token,
   * base_volume = token, target_volume = USD), so no decimal scaling is needed.
   *
   * Keyed by token (base mint); the /api/tickers caller maps token→dao. This is
   * the SINGLE source for 24h metrics — it replaces both the old futarchy.trades
   * read and the app-DB v06_spot_ohlcv_1m fallback. Everything now comes from the
   * user_pool ETL output.
   *
   * Returns an empty Map if no spot candles exist in the window. Throws if the
   * connection is down or the query fails (never masks a failure as empty).
   */
  async getSpotRolling24hMetrics(tokens: string[]): Promise<Map<string, Rolling24hMetrics>> {
    if (tokens.length === 0) {
      return new Map();
    }
    if (!this.pool || !this.isConnected) {
      throw new Error('External database not connected');
    }

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    try {
      const result = await this.pool.query(
        `SELECT
           token,
           SUM(base_volume)::text                        AS base_volume_24h,
           SUM(target_volume)::text                      AS target_volume_24h,
           MAX(high)::text                               AS high_24h,
           (MIN(low) FILTER (WHERE low > 0))::text       AS low_24h,
           SUM(trade_count)::int                         AS trade_count_24h
         FROM futarchy.user_pool_spot_ohlcv
         WHERE source = 'futarchy_amm'
           AND "interval" = '1m'
           AND bucket_start >= $1
           AND token = ANY($2::text[])
         GROUP BY token`,
        [cutoff, tokens]
      );

      const metricsMap = new Map<string, Rolling24hMetrics>();
      for (const row of result.rows) {
        metricsMap.set(row.token, {
          token: row.token,
          base_volume_24h: row.base_volume_24h ?? '0',
          target_volume_24h: row.target_volume_24h ?? '0',
          high_24h: row.high_24h ?? '0',
          low_24h: row.low_24h ?? '0',
          trade_count_24h: row.trade_count_24h ?? 0,
        });
      }
      return metricsMap;
    } catch (error: any) {
      // Surface query/schema failures (e.g. served-DB contract drift) instead of
      // masking them as an empty map — an empty map must mean "genuinely no spot
      // candles in the window", not "the query failed". The /api/tickers handler is
      // wrapped in asyncHandler, so this propagates to a clean 5xx.
      logger.error('[ExternalDB] Error getting spot rolling 24h metrics from user_pool_spot_ohlcv:', error);
      throw error;
    }
  }

  /**
   * Daily Meteora volumes from the unified `futarchy.user_pool_daily` (source=
   * 'meteora') in the served DB — the user_pool ETL output (a faithful, v0_6_daos-
   * filtered map of the meteora accounting ETL's meteora_daily view). Reading the
   * unified table (not meteora_daily directly) keeps every market-data read on the
   * one ETL output; validated row-exact vs meteora_daily.
   *
   * Returns the SAME column contract so /api/market-data consumers are unchanged:
   * token (base mint), date, base_volume, target_volume, buy_volume, sell_volume,
   * trade_count, average_price, usdc_fees, token_fees, token_fees_usdc,
   * token_per_usdc (derived = base_volume/target_volume = 1/average_price, since
   * user_pool_daily doesn't store it). Throws on connection or query failure.
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
      throw new Error('External database not connected');
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
    // source='meteora' is always applied; user-supplied filters are AND-ed after it.
    const whereClause = `WHERE source = 'meteora'${conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : ''}`;
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
           (base_volume / nullif(target_volume, 0))::text AS token_per_usdc
         FROM futarchy.user_pool_daily
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
      logger.error('[ExternalDB] Error getting daily Meteora volumes from user_pool_daily:', error);
      throw error;
    }
  }

  /**
   * Daily FutarchyAMM trading activity from `futarchy.user_pool_daily` (served DB) —
   * the unified, ON-CHAIN-derived table that replaces the flat-0.5%
   * `v06_fee_volume_daily_aggregate` (and the Dune-style `v06ReconciliationService`).
   *
   * user_pool_daily stores spot and conditional as SEPARATE rows (market_kind); we
   * pivot them into the same spot / conditional / total column shape the old app-DB
   * aggregate path returned, so /api/market-data consumers are unchanged.
   * Values are already USD / token-UI (no /1e6). ADDS the protocol/LP fee split
   * (collected-to-treasury vs retained), which the old flat-rate aggregate could not
   * provide. Throws on connection or query failure (never masks as empty for a
   * financial feed).
   */
  async getFutarchyAmmDailyActivity(options?: {
    token?: string;
    tokens?: string[];
    startDate?: string;
    endDate?: string;
  }): Promise<any[]> {
    if (!this.pool || !this.isConnected) {
      throw new Error('External database not connected');
    }
    const conditions: string[] = [`source = 'futarchy_amm'`];
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
    if (options?.startDate) { conditions.push(`date >= $${i}`); params.push(options.startDate); i++; }
    if (options?.endDate)   { conditions.push(`date <= $${i}`); params.push(options.endDate);   i++; }
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    try {
      const result = await this.pool.query(
        `WITH d AS (SELECT * FROM futarchy.user_pool_daily ${whereClause}),
              spot AS (SELECT * FROM d WHERE market_kind = 'spot'),
              cond AS (SELECT * FROM d WHERE market_kind = 'conditional')
         SELECT
           COALESCE(s.token, c.token)               AS token,
           COALESCE(s.date,  c.date)::text          AS date,
           (c.token IS NOT NULL)                    AS has_conditional_volume,
           -- spot
           COALESCE(s.buy_volume,0)::text           AS spot_buy_volume,
           COALESCE(s.sell_volume,0)::text          AS spot_sell_volume,
           COALESCE(s.base_volume,0)::text          AS spot_base_volume,
           COALESCE(s.target_volume,0)::text        AS spot_target_volume,
           COALESCE(s.trade_count,0)                AS spot_trade_count,
           COALESCE(s.usdc_fees,0)::text            AS spot_usdc_fees,
           COALESCE(s.token_fees,0)::text           AS spot_token_fees,
           COALESCE(s.token_fees_usdc,0)::text      AS spot_token_fees_usdc,
           COALESCE(s.futarchy_protocol_fee_usdc,0)::text AS spot_protocol_fee_usd,
           COALESCE(s.futarchy_lp_fee_usdc,0)::text       AS spot_lp_fee_usd,
           -- conditional (NULL when no conditional row for the day)
           c.buy_volume::text                       AS conditional_buy_volume,
           c.sell_volume::text                      AS conditional_sell_volume,
           c.base_volume::text                      AS conditional_base_volume,
           c.target_volume::text                    AS conditional_target_volume,
           c.trade_count                            AS conditional_trade_count,
           c.usdc_fees::text                        AS conditional_usdc_fees,
           c.token_fees::text                       AS conditional_token_fees,
           c.token_fees_usdc::text                  AS conditional_token_fees_usdc,
           c.futarchy_protocol_fee_usdc::text       AS conditional_protocol_fee_usd,
           c.futarchy_lp_fee_usdc::text             AS conditional_lp_fee_usd,
           -- total = spot + conditional
           (COALESCE(s.buy_volume,0)+COALESCE(c.buy_volume,0))::text       AS total_buy_volume,
           (COALESCE(s.sell_volume,0)+COALESCE(c.sell_volume,0))::text     AS total_sell_volume,
           (COALESCE(s.base_volume,0)+COALESCE(c.base_volume,0))::text     AS total_base_volume,
           (COALESCE(s.target_volume,0)+COALESCE(c.target_volume,0))::text AS total_target_volume,
           (COALESCE(s.trade_count,0)+COALESCE(c.trade_count,0))          AS total_trade_count,
           (COALESCE(s.usdc_fees,0)+COALESCE(c.usdc_fees,0))::text         AS total_usdc_fees,
           (COALESCE(s.token_fees,0)+COALESCE(c.token_fees,0))::text       AS total_token_fees,
           (COALESCE(s.token_fees_usdc,0)+COALESCE(c.token_fees_usdc,0))::text AS total_token_fees_usdc,
           (COALESCE(s.futarchy_protocol_fee_usdc,0)+COALESCE(c.futarchy_protocol_fee_usdc,0))::text AS total_protocol_fee_usd,
           (COALESCE(s.futarchy_lp_fee_usdc,0)+COALESCE(c.futarchy_lp_fee_usdc,0))::text             AS total_lp_fee_usd,
           COALESCE(c.conditional_reconciled, false) AS conditional_reconciled,
           COALESCE(c.pending_open_proposals, 0)     AS pending_open_proposals
         FROM spot s FULL OUTER JOIN cond c ON s.token = c.token AND s.date = c.date
         ORDER BY token, date ASC`,
        params
      );
      return result.rows;
    } catch (error: any) {
      logger.error('[ExternalDB] Error getting FutarchyAMM daily activity from user_pool_daily:', error);
      throw error;
    }
  }

  /**
   * First spot-trade date per token (base mint), from the unified ETL output
   * `futarchy.user_pool_daily` (source='futarchy_amm', spot) — MIN(date) per token.
   * Keeps every market-data read on the one ETL output. Returns
   * Map<token(base mint), 'YYYY-MM-DD'>. Throws on connection or query failure.
   */
  async getFirstTradeDates(): Promise<Map<string, string>> {
    if (!this.pool || !this.isConnected) {
      throw new Error('External database not connected');
    }
    try {
      const result = await this.pool.query(
        `SELECT token, MIN(date)::text AS first_date
           FROM futarchy.user_pool_daily
          WHERE source = 'futarchy_amm' AND market_kind = 'spot'
          GROUP BY token`
      );
      const m = new Map<string, string>();
      for (const row of result.rows) m.set(row.token, row.first_date);
      return m;
    } catch (error: any) {
      logger.error('[ExternalDB] Error getting first trade dates from user_pool_daily:', error);
      throw error;
    }
  }

  async checkServedDataContract(): Promise<ServedDataContractStatus> {
    const checkedAt = new Date().toISOString();
    if (!this.pool || !this.isConnected) {
      return {
        ok: false,
        checkedAt,
        missing: ['connection'],
      };
    }

    const requiredColumns = new Map<string, string[]>([
      ['user_pool_daily', [
        'source',
        'market_kind',
        'token',
        'date',
        'base_volume',
        'target_volume',
        'trade_count',
        'usdc_fees',
      ]],
      ['user_pool_spot_ohlcv', [
        'source',
        'interval',
        'token',
        'bucket_start',
        'base_volume',
        'target_volume',
        'high',
        'low',
        'trade_count',
      ]],
      ['user_pool_swaps', [
        'source',
        'market_kind',
        'dao_addr',
        'base_mint',
        'quote_mint',
        'slot',
        'block_time',
        'signature',
        'user_addr',
        'side',
        'base_amount',
        'quote_amount',
        'amm_base_reserves',
        'amm_quote_reserves',
        'inner_group',
        'inner_ix',
      ]],
    ]);

    try {
      const result = await this.pool.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'futarchy'
            AND table_name = ANY($1::text[])`,
        [Array.from(requiredColumns.keys())]
      );

      const observed = new Map<string, Set<string>>();
      for (const row of result.rows) {
        const tableName = row.table_name as string;
        if (!observed.has(tableName)) observed.set(tableName, new Set());
        observed.get(tableName)!.add(row.column_name as string);
      }

      const missing: string[] = [];
      for (const [tableName, columns] of requiredColumns.entries()) {
        const observedColumns = observed.get(tableName);
        if (!observedColumns) {
          missing.push(`futarchy.${tableName}`);
          continue;
        }
        for (const column of columns) {
          if (!observedColumns.has(column)) {
            missing.push(`futarchy.${tableName}.${column}`);
          }
        }
      }

      return {
        ok: missing.length === 0,
        checkedAt,
        missing,
      };
    } catch (error: any) {
      logger.error('[ExternalDB] Error checking served ETL contract:', error);
      return {
        ok: false,
        checkedAt,
        missing: ['contract-check-query'],
      };
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
