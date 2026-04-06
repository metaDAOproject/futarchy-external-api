import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';

// Force pg to serialize Date parameters as ISO-8601 UTC strings so PostgreSQL
// doesn't receive un-parseable local-timezone names like "GMT-0700".
pg.defaults.parseInputDatesAsUTC = true;

const { Pool } = pg;

export interface DailyVolumeRecord {
  token: string;
  date: string; // YYYY-MM-DD
  base_volume: string;
  target_volume: string;
  buy_volume?: string;
  sell_volume?: string;
  high: string;
  low: string;
  average_price?: string;
  trade_count?: number;
  usdc_fees?: string;
  token_fees?: string;
  token_fees_usdc?: string;
  sell_volume_usdc?: string;
  cumulative_usdc_fees?: string;
  cumulative_token_in_usdc_fees?: string;
  cumulative_target_volume?: string;
  cumulative_token_volume?: string;
}

export interface HourlyVolumeRecord {
  token: string;
  hour: string; // ISO timestamp (YYYY-MM-DD HH:00:00)
  base_volume: string;
  target_volume: string;
  buy_volume?: string;
  sell_volume?: string;
  high: string;
  low: string;
  average_price?: string;
  trade_count: number;
  usdc_fees?: string;
  token_fees?: string;
  token_fees_usdc?: string;
  sell_volume_usdc?: string;
}

export interface TenMinuteVolumeRecord {
  token: string;
  bucket: string; // ISO timestamp (YYYY-MM-DD HH:M0:00 where M is 0,1,2,3,4,5)
  base_volume: string;
  target_volume: string;
  buy_volume?: string;
  sell_volume?: string;
  high: string;
  low: string;
  average_price?: string;
  trade_count: number;
  usdc_fees?: string;
  token_fees?: string;
  token_fees_usdc?: string;
  sell_volume_usdc?: string;
}

export interface DailyBuySellVolumeRecord {
  token: string;
  date: string; // YYYY-MM-DD
  base_volume: string;
  target_volume: string;
  buy_usdc_volume: string;
  sell_token_volume: string;
  high: string;
  low: string;
  trade_count: number;
  average_price: string;
  usdc_fees: string;
  token_fees: string;
  token_fees_usdc: string;
  sell_volume_usdc: string;
  sell_volume: string;
  buy_volume: string;
}

export interface DailyFeesVolumeRecord {
  token: string;
  trading_date: string; // YYYY-MM-DD
  base_volume: string;
  target_volume: string;
  usdc_fees: string;
  token_fees_usdc: string;
  token_fees: string;
  buy_volume: string;
  sell_volume: string;
  sell_volume_usdc: string;
  cumulative_usdc_fees: string;
  cumulative_token_in_usdc_fees: string;
  cumulative_target_volume: string;
  cumulative_token_volume: string;
  high: string;
  average_price: string;
  low: string;
}

export interface DailyMeteoraVolumeRecord {
  token: string;  // mapped from owner
  date: string;    // YYYY-MM-DD
  base_volume: string;  // volume_usd_approx
  target_volume: string;  // calculated from buy_volume + sell_volume
  trade_count: number;  // num_swaps
  buy_volume: string;
  sell_volume: string;
  usdc_fees: string;  // lp_fee_usdc
  token_fees: string;  // lp_fee_token
  token_fees_usdc: string;  // lp_fee_token_usdc
  token_per_usdc: string;  // token_per_usdc_raw
  average_price: string;  // token_price_usdc
  ownership_share: string;  // ownership_share
  earned_fee_usdc: string;  // earned_fee_usdc
  is_complete: boolean;
}

export interface CumulativeVolumeData {
  token: string;
  date: string;
  base_volume: string;
  target_volume: string;
  buy_usdc_volume: string;
  sell_token_volume: string;
  cumulative_target_volume: string;
  cumulative_base_volume: string;
  cumulative_buy_usdc_volume: string;
  cumulative_sell_token_volume: string;
  high: string;
  low: string;
}

export interface Rolling24hMetrics {
  token: string;
  base_volume_24h: string;
  target_volume_24h: string;
  high_24h: string;
  low_24h: string;
  trade_count_24h: number;
}

export interface TokenVolumeAggregate {
  token: string;
  first_trade_date: string;
  last_trade_date: string;
  total_base_volume: string;
  total_target_volume: string;
  all_time_high: string;
  all_time_low: string;
  trading_days: number;
  daily_data: DailyVolumeRecord[];
}

export class DatabaseService {
  public pool: pg.Pool | null = null;
  private isConnected: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30_000;
  private static readonly MAX_FAILURES_BEFORE_RECONNECT = 3;

  constructor() {
    // Only initialize if database config is provided
    if (config.database.connectionString || config.database.host) {
      this.createPool();
    }
  }

  private getPoolConfig(): pg.PoolConfig {
    return {
      connectionString: config.database.connectionString,
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };
  }

  private createPool(): void {
    this.pool = new Pool(this.getPoolConfig());

    this.pool.on('error', (err: Error) => {
      logger.error('[Database] Pool error — marking connection unhealthy', err);
      this.isConnected = false;
      sendAlert(
        `DB Pool Error: ${err.message}`,
        { cooldownKey: 'db-pool-error', cooldownMs: 5 * 60 * 1000 }
      );
    });
  }

  /**
   * Initialize the database connection and create tables if needed
   */
  async initialize(): Promise<boolean> {
    if (!this.pool) {
      logger.info('[Database] No database configuration provided, volume history will use in-memory cache only');
      return false;
    }

    try {
      // Test connection
      const client = await this.pool.connect();
      logger.info('[Database] Connected to PostgreSQL');
      client.release();

      // Create tables
      await this.createTables();
      
      // Create aggregation functions
      await this.createAggregationFunctions();
      
      this.isConnected = true;
      this.consecutiveFailures = 0;
      this.startHealthCheck();
      return true;
    } catch (error: any) {
      logger.error('[Database] Failed to connect:', error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Periodic health check that pings the DB and manages connection state.
   * If consecutive failures exceed threshold, destroys and recreates the pool.
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.pool!.query('SELECT 1');
        if (!this.isConnected) {
          logger.info('[Database] Connection recovered');
        }
        this.isConnected = true;
        this.consecutiveFailures = 0;
      } catch (error: any) {
        this.consecutiveFailures++;
        this.isConnected = false;
        logger.error(`[Database] Health check failed (${this.consecutiveFailures}/${DatabaseService.MAX_FAILURES_BEFORE_RECONNECT})`, error);

        sendAlert(
          `DB Health Check Failed (${this.consecutiveFailures}/${DatabaseService.MAX_FAILURES_BEFORE_RECONNECT}): ${error.message || error}`,
          { cooldownKey: 'db-health-check', cooldownMs: 5 * 60 * 1000 }
        );

        if (this.consecutiveFailures >= DatabaseService.MAX_FAILURES_BEFORE_RECONNECT) {
          logger.error('[Database] Max consecutive failures reached — recreating connection pool');
          await this.reconnect();
        }
      }
    }, DatabaseService.HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Destroy the current pool and create a fresh one.
   */
  private async reconnect(): Promise<void> {
    try {
      if (this.pool) {
        await this.pool.end().catch(() => {}); // best-effort cleanup
      }
    } catch {
      // ignore — pool may already be dead
    }

    this.createPool();

    try {
      await this.pool!.query('SELECT 1');
      this.isConnected = true;
      this.consecutiveFailures = 0;
      logger.info('[Database] Reconnected successfully after pool recreation');
      sendAlert('DB Reconnected — pool recreated, connection healthy', { cooldownKey: 'db-reconnected' });
    } catch (error: any) {
      logger.error('[Database] Reconnection attempt failed — will retry on next health check', error);
      sendAlert(
        `DB Reconnection Failed — pool recreated but still can't connect: ${error.message || error}`,
        { cooldownKey: 'db-reconnect-failed', cooldownMs: 5 * 60 * 1000 }
      );
    }
  }

  /**
   * Create required tables if they don't exist
   */
  private async createTables(): Promise<void> {
    if (!this.pool) return;

    const createTableSQL = `
      -- Daily volumes table (aggregated from hourly/10-min data, includes cumulative values)
      CREATE TABLE IF NOT EXISTS daily_volumes (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        date DATE NOT NULL,
        base_volume NUMERIC(40, 12) NOT NULL,
        target_volume NUMERIC(40, 12) NOT NULL,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        high NUMERIC(40, 12) NOT NULL,
        low NUMERIC(40, 12) NOT NULL,
        average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_token_in_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_token_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, date)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_volumes_token ON daily_volumes(token);
      CREATE INDEX IF NOT EXISTS idx_daily_volumes_date ON daily_volumes(date);
      CREATE INDEX IF NOT EXISTS idx_daily_volumes_token_date ON daily_volumes(token, date);

      -- Hourly volumes table for hourly aggregates (aggregated from 10-min data)
      CREATE TABLE IF NOT EXISTS hourly_volumes (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        hour TIMESTAMPTZ NOT NULL,
        base_volume NUMERIC(40, 12) NOT NULL,
        target_volume NUMERIC(40, 12) NOT NULL,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        high NUMERIC(40, 12) NOT NULL,
        low NUMERIC(40, 12) NOT NULL,
        average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, hour)
      );

      CREATE INDEX IF NOT EXISTS idx_hourly_volumes_token ON hourly_volumes(token);
      CREATE INDEX IF NOT EXISTS idx_hourly_volumes_hour ON hourly_volumes(hour);
      CREATE INDEX IF NOT EXISTS idx_hourly_volumes_token_hour ON hourly_volumes(token, hour);
      CREATE INDEX IF NOT EXISTS idx_hourly_volumes_recent ON hourly_volumes(hour DESC);

      -- 10-minute volumes table for accurate rolling 24h calculations
      -- Extended with buy/sell volumes and fees (single source of truth)
      CREATE TABLE IF NOT EXISTS ten_minute_volumes (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        base_volume NUMERIC(40, 12) NOT NULL,
        target_volume NUMERIC(40, 12) NOT NULL,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        high NUMERIC(40, 12) NOT NULL,
        low NUMERIC(40, 12) NOT NULL,
        average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, bucket)
      );

      CREATE INDEX IF NOT EXISTS idx_ten_minute_volumes_token ON ten_minute_volumes(token);
      CREATE INDEX IF NOT EXISTS idx_ten_minute_volumes_bucket ON ten_minute_volumes(bucket);
      CREATE INDEX IF NOT EXISTS idx_ten_minute_volumes_token_bucket ON ten_minute_volumes(token, bucket);
      CREATE INDEX IF NOT EXISTS idx_ten_minute_volumes_recent ON ten_minute_volumes(bucket DESC);

      -- Metadata table to track sync status
      CREATE TABLE IF NOT EXISTS sync_metadata (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      -- Daily buy/sell volumes table for tracking directional volume
      CREATE TABLE IF NOT EXISTS daily_buy_sell_volumes (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        date DATE NOT NULL,
        base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        buy_usdc_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_token_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        high NUMERIC(40, 12) NOT NULL DEFAULT 0,
        low NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, date)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_buy_sell_volumes_token ON daily_buy_sell_volumes(token);
      CREATE INDEX IF NOT EXISTS idx_daily_buy_sell_volumes_date ON daily_buy_sell_volumes(date);
      CREATE INDEX IF NOT EXISTS idx_daily_buy_sell_volumes_token_date ON daily_buy_sell_volumes(token, date);

      -- Daily fees volumes table for tracking fees and comprehensive volume metrics
      CREATE TABLE IF NOT EXISTS daily_fees_volumes (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        trading_date DATE NOT NULL,
        base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_token_in_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        cumulative_token_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        high NUMERIC(40, 12) NOT NULL DEFAULT 0,
        average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
        low NUMERIC(40, 12) NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, trading_date)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_fees_volumes_token ON daily_fees_volumes(token);
      CREATE INDEX IF NOT EXISTS idx_daily_fees_volumes_date ON daily_fees_volumes(trading_date);
      CREATE INDEX IF NOT EXISTS idx_daily_fees_volumes_token_date ON daily_fees_volumes(token, trading_date);

      -- Daily Meteora volumes table for tracking Meteora pool fees and volumes per owner
      CREATE TABLE IF NOT EXISTS daily_meteora_volumes (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        date DATE NOT NULL,
        base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_per_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
        ownership_share NUMERIC(40, 12) NOT NULL DEFAULT 0,
        earned_fee_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, date)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_meteora_volumes_token ON daily_meteora_volumes(token);
      CREATE INDEX IF NOT EXISTS idx_daily_meteora_volumes_date ON daily_meteora_volumes(date);
      CREATE INDEX IF NOT EXISTS idx_daily_meteora_volumes_token_date ON daily_meteora_volumes(token, date);

      -- Metrics history table for storing periodic snapshots of system metrics
      CREATE TABLE IF NOT EXISTS metrics_history (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metric_name VARCHAR(128) NOT NULL,
        metric_value NUMERIC(40, 12) NOT NULL,
        labels JSONB DEFAULT '{}',
        UNIQUE(timestamp, metric_name, labels)
      );

      CREATE INDEX IF NOT EXISTS idx_metrics_history_timestamp ON metrics_history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_metrics_history_name ON metrics_history(metric_name);
      CREATE INDEX IF NOT EXISTS idx_metrics_history_name_time ON metrics_history(metric_name, timestamp DESC);

      -- Service health snapshots for historical analysis
      CREATE TABLE IF NOT EXISTS service_health_snapshots (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        service_name VARCHAR(64) NOT NULL,
        is_healthy BOOLEAN NOT NULL,
        last_refresh_time TIMESTAMPTZ,
        record_count INT,
        error_message TEXT,
        metadata JSONB DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_service_health_timestamp ON service_health_snapshots(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_service_health_service ON service_health_snapshots(service_name);
      CREATE INDEX IF NOT EXISTS idx_service_health_service_time ON service_health_snapshots(service_name, timestamp DESC);
    `;

    await this.pool.query(createTableSQL);
    logger.info('[Database] Tables created/verified');

    // Create v0.6 OHLCV + fee volume tables
    await this.createV06Tables();
    
    // Run migration to add new columns to existing tables
    await this.migrateTables();
  }

  /**
   * Create v0.6 OHLCV and fee volume tables (app DB).
   * Mirrors src/schema/v06-ohlcv-tables.sql.
   */
  private async createV06Tables(): Promise<void> {
    if (!this.pool) return;

    const sql = `
      -- Spot OHLCV 1-minute
      CREATE TABLE IF NOT EXISTS v06_spot_ohlcv_1m (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        open NUMERIC(40, 12) NOT NULL DEFAULT 0,
        high NUMERIC(40, 12) NOT NULL DEFAULT 0,
        low NUMERIC(40, 12) NOT NULL DEFAULT 0,
        close NUMERIC(40, 12) NOT NULL DEFAULT 0,
        average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
        base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1m_token_bucket ON v06_spot_ohlcv_1m(token, bucket DESC);
      CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1m_bucket ON v06_spot_ohlcv_1m(bucket DESC);

      -- Spot OHLCV daily
      CREATE TABLE IF NOT EXISTS v06_spot_ohlcv_1d (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        bucket TIMESTAMPTZ NOT NULL,
        open NUMERIC(40, 12) NOT NULL DEFAULT 0,
        high NUMERIC(40, 12) NOT NULL DEFAULT 0,
        low NUMERIC(40, 12) NOT NULL DEFAULT 0,
        close NUMERIC(40, 12) NOT NULL DEFAULT 0,
        average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
        base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        is_complete BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1d_token_bucket ON v06_spot_ohlcv_1d(token, bucket DESC);
      CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1d_bucket ON v06_spot_ohlcv_1d(bucket DESC);

      -- Fee breakdown: spot daily
      CREATE TABLE IF NOT EXISTS v06_fee_volume_daily_spot (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        date DATE NOT NULL,
        buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        trade_count INT NOT NULL DEFAULT 0,
        usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, date)
      );
      CREATE INDEX IF NOT EXISTS idx_v06_fee_spot_token_date ON v06_fee_volume_daily_spot(token, date DESC);

      -- Fee breakdown: conditional daily (nullable until reconciled)
      CREATE TABLE IF NOT EXISTS v06_fee_volume_daily_conditional (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        date DATE NOT NULL,
        buy_volume NUMERIC(40, 12),
        sell_volume NUMERIC(40, 12),
        base_volume NUMERIC(40, 12),
        target_volume NUMERIC(40, 12),
        trade_count INT,
        usdc_fees NUMERIC(40, 12),
        token_fees NUMERIC(40, 12),
        token_fees_usdc NUMERIC(40, 12),
        sell_volume_usdc NUMERIC(40, 12),
        conditional_reconciled BOOLEAN NOT NULL DEFAULT false,
        pending_open_proposals INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, date)
      );
      CREATE INDEX IF NOT EXISTS idx_v06_fee_cond_token_date ON v06_fee_volume_daily_conditional(token, date DESC);

      -- Fee aggregate (accountant primary)
      CREATE TABLE IF NOT EXISTS v06_fee_volume_daily_aggregate (
        id SERIAL PRIMARY KEY,
        token VARCHAR(64) NOT NULL,
        date DATE NOT NULL,
        spot_buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        spot_sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        spot_base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        spot_target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        spot_trade_count INT NOT NULL DEFAULT 0,
        spot_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        spot_token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        spot_token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        conditional_buy_volume NUMERIC(40, 12),
        conditional_sell_volume NUMERIC(40, 12),
        conditional_base_volume NUMERIC(40, 12),
        conditional_target_volume NUMERIC(40, 12),
        conditional_trade_count INT,
        conditional_usdc_fees NUMERIC(40, 12),
        conditional_token_fees NUMERIC(40, 12),
        conditional_token_fees_usdc NUMERIC(40, 12),
        total_buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        total_sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        total_base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        total_target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
        total_trade_count INT NOT NULL DEFAULT 0,
        total_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        total_token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
        total_token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
        conditional_reconciled BOOLEAN NOT NULL DEFAULT false,
        pending_open_proposals INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(token, date)
      );
      CREATE INDEX IF NOT EXISTS idx_v06_fee_agg_token_date ON v06_fee_volume_daily_aggregate(token, date DESC);
    `;

    await this.pool.query(sql);
    logger.info('[Database] v0.6 tables created/verified');
  }

  /**
   * Migrate existing tables to add new columns for extended fields
   * This is safe to run multiple times (uses IF NOT EXISTS logic)
   */
  private async migrateTables(): Promise<void> {
    if (!this.pool) return;

    try {
      const migrationSQL = `
        -- Add extended columns to ten_minute_volumes
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name = 'ten_minute_volumes' AND column_name = 'buy_volume') THEN
            ALTER TABLE ten_minute_volumes 
            ADD COLUMN buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0;
            RAISE NOTICE 'Added extended columns to ten_minute_volumes';
          END IF;
        END $$;

        -- Add extended columns to hourly_volumes
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name = 'hourly_volumes' AND column_name = 'buy_volume') THEN
            ALTER TABLE hourly_volumes 
            ADD COLUMN buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0;
            RAISE NOTICE 'Added extended columns to hourly_volumes';
          END IF;
        END $$;

        -- Add extended columns to daily_volumes
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                         WHERE table_name = 'daily_volumes' AND column_name = 'buy_volume') THEN
            ALTER TABLE daily_volumes 
            ADD COLUMN buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN trade_count INT NOT NULL DEFAULT 0,
            ADD COLUMN usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN cumulative_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN cumulative_token_in_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN cumulative_target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN cumulative_token_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
            ADD COLUMN is_complete BOOLEAN NOT NULL DEFAULT false;
            RAISE NOTICE 'Added extended columns to daily_volumes';
          END IF;
        END $$;
      `;

      await this.pool.query(migrationSQL);
      logger.info('[Database] Migration completed - extended columns added if needed');
    } catch (error: any) {
      // Migration errors are non-fatal - tables might already have columns
      logger.info('[Database] Migration check completed (columns may already exist)');
    }
  }

  /**
   * Create database aggregation functions for 10-min → hourly → daily
   */
  async createAggregationFunctions(): Promise<void> {
    if (!this.pool) return;

    try {
      const functionsSQL = `
        -- Function to aggregate 10-minute buckets into hourly records
        CREATE OR REPLACE FUNCTION aggregate_10min_to_hourly(
          p_token VARCHAR DEFAULT NULL,
          p_hour TIMESTAMPTZ DEFAULT NULL
        )
        RETURNS TABLE (
          token VARCHAR,
          hour TIMESTAMPTZ,
          base_volume NUMERIC,
          target_volume NUMERIC,
          buy_volume NUMERIC,
          sell_volume NUMERIC,
          high NUMERIC,
          low NUMERIC,
          average_price NUMERIC,
          trade_count INT,
          usdc_fees NUMERIC,
          token_fees NUMERIC,
          token_fees_usdc NUMERIC,
          sell_volume_usdc NUMERIC
        ) AS $$
        BEGIN
          RETURN QUERY
          SELECT
            tmv.token,
            date_trunc('hour', tmv.bucket) AS hour,
            SUM(tmv.base_volume)::NUMERIC AS base_volume,
            SUM(tmv.target_volume)::NUMERIC AS target_volume,
            SUM(tmv.buy_volume)::NUMERIC AS buy_volume,
            SUM(tmv.sell_volume)::NUMERIC AS sell_volume,
            MAX(tmv.high)::NUMERIC AS high,
            MIN(CASE WHEN tmv.low > 0 THEN tmv.low END)::NUMERIC AS low,
            -- Weighted average price by volume
            CASE 
              WHEN SUM(tmv.base_volume) > 0 
              THEN SUM(tmv.average_price * tmv.base_volume) / SUM(tmv.base_volume)
              ELSE AVG(tmv.average_price)
            END::NUMERIC AS average_price,
            SUM(tmv.trade_count)::INT AS trade_count,
            SUM(tmv.usdc_fees)::NUMERIC AS usdc_fees,
            SUM(tmv.token_fees)::NUMERIC AS token_fees,
            SUM(tmv.token_fees_usdc)::NUMERIC AS token_fees_usdc,
            SUM(tmv.sell_volume_usdc)::NUMERIC AS sell_volume_usdc
          FROM ten_minute_volumes tmv
          WHERE 
            (p_token IS NULL OR tmv.token = p_token)
            AND (p_hour IS NULL OR date_trunc('hour', tmv.bucket) = p_hour)
          GROUP BY tmv.token, date_trunc('hour', tmv.bucket)
          ORDER BY tmv.token, hour;
        END;
        $$ LANGUAGE plpgsql;

        -- Function to aggregate hourly records into daily records with cumulative values
        CREATE OR REPLACE FUNCTION aggregate_hourly_to_daily(
          p_token VARCHAR DEFAULT NULL,
          p_date DATE DEFAULT NULL
        )
        RETURNS TABLE (
          token VARCHAR,
          date DATE,
          base_volume NUMERIC,
          target_volume NUMERIC,
          buy_volume NUMERIC,
          sell_volume NUMERIC,
          high NUMERIC,
          low NUMERIC,
          average_price NUMERIC,
          trade_count INT,
          usdc_fees NUMERIC,
          token_fees NUMERIC,
          token_fees_usdc NUMERIC,
          sell_volume_usdc NUMERIC,
          cumulative_usdc_fees NUMERIC,
          cumulative_token_in_usdc_fees NUMERIC,
          cumulative_target_volume NUMERIC,
          cumulative_token_volume NUMERIC
        ) AS $$
        BEGIN
          RETURN QUERY
          WITH daily_agg AS (
            SELECT
              hv.token,
              date_trunc('day', hv.hour)::DATE AS date,
              SUM(hv.base_volume)::NUMERIC AS base_volume,
              SUM(hv.target_volume)::NUMERIC AS target_volume,
              SUM(hv.buy_volume)::NUMERIC AS buy_volume,
              SUM(hv.sell_volume)::NUMERIC AS sell_volume,
              MAX(hv.high)::NUMERIC AS high,
              MIN(CASE WHEN hv.low > 0 THEN hv.low END)::NUMERIC AS low,
              -- Weighted average price by volume
              CASE 
                WHEN SUM(hv.base_volume) > 0 
                THEN SUM(hv.average_price * hv.base_volume) / SUM(hv.base_volume)
                ELSE AVG(hv.average_price)
              END::NUMERIC AS average_price,
              SUM(hv.trade_count)::INT AS trade_count,
              SUM(hv.usdc_fees)::NUMERIC AS usdc_fees,
              SUM(hv.token_fees)::NUMERIC AS token_fees,
              SUM(hv.token_fees_usdc)::NUMERIC AS token_fees_usdc,
              SUM(hv.sell_volume_usdc)::NUMERIC AS sell_volume_usdc
            FROM hourly_volumes hv
            WHERE 
              (p_token IS NULL OR hv.token = p_token)
              AND (p_date IS NULL OR date_trunc('day', hv.hour)::DATE = p_date)
            GROUP BY hv.token, date_trunc('day', hv.hour)::DATE
          )
          SELECT
            da.token,
            da.date,
            da.base_volume,
            da.target_volume,
            da.buy_volume,
            da.sell_volume,
            da.high,
            da.low,
            da.average_price,
            da.trade_count,
            da.usdc_fees,
            da.token_fees,
            da.token_fees_usdc,
            da.sell_volume_usdc,
            SUM(da.usdc_fees) OVER (
              PARTITION BY da.token
              ORDER BY da.date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::NUMERIC AS cumulative_usdc_fees,
            SUM(da.token_fees_usdc) OVER (
              PARTITION BY da.token
              ORDER BY da.date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::NUMERIC AS cumulative_token_in_usdc_fees,
            SUM(da.target_volume) OVER (
              PARTITION BY da.token
              ORDER BY da.date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::NUMERIC AS cumulative_target_volume,
            SUM(da.base_volume) OVER (
              PARTITION BY da.token
              ORDER BY da.date
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )::NUMERIC AS cumulative_token_volume
          FROM daily_agg da
          ORDER BY da.token, da.date;
        END;
        $$ LANGUAGE plpgsql;

        -- Function to calculate rolling 24h metrics from 10-minute data
        CREATE OR REPLACE FUNCTION calculate_rolling_24h(
          p_token VARCHAR DEFAULT NULL
        )
        RETURNS TABLE (
          token VARCHAR,
          base_volume_24h NUMERIC,
          target_volume_24h NUMERIC,
          buy_volume_24h NUMERIC,
          sell_volume_24h NUMERIC,
          high_24h NUMERIC,
          low_24h NUMERIC,
          average_price_24h NUMERIC,
          trade_count_24h INT,
          usdc_fees_24h NUMERIC,
          token_fees_24h NUMERIC,
          token_fees_usdc_24h NUMERIC,
          sell_volume_usdc_24h NUMERIC
        ) AS $$
        BEGIN
          RETURN QUERY
          SELECT
            tmv.token,
            SUM(tmv.base_volume)::NUMERIC AS base_volume_24h,
            SUM(tmv.target_volume)::NUMERIC AS target_volume_24h,
            SUM(tmv.buy_volume)::NUMERIC AS buy_volume_24h,
            SUM(tmv.sell_volume)::NUMERIC AS sell_volume_24h,
            MAX(tmv.high)::NUMERIC AS high_24h,
            MIN(CASE WHEN tmv.low > 0 THEN tmv.low END)::NUMERIC AS low_24h,
            -- Weighted average price by volume
            CASE 
              WHEN SUM(tmv.base_volume) > 0 
              THEN SUM(tmv.average_price * tmv.base_volume) / SUM(tmv.base_volume)
              ELSE AVG(tmv.average_price)
            END::NUMERIC AS average_price_24h,
            SUM(tmv.trade_count)::INT AS trade_count_24h,
            SUM(tmv.usdc_fees)::NUMERIC AS usdc_fees_24h,
            SUM(tmv.token_fees)::NUMERIC AS token_fees_24h,
            SUM(tmv.token_fees_usdc)::NUMERIC AS token_fees_usdc_24h,
            SUM(tmv.sell_volume_usdc)::NUMERIC AS sell_volume_usdc_24h
          FROM ten_minute_volumes tmv
          WHERE 
            tmv.bucket >= (CURRENT_TIMESTAMP - INTERVAL '24 hours')
            AND (p_token IS NULL OR tmv.token = p_token)
          GROUP BY tmv.token
          ORDER BY tmv.token;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await this.pool.query(functionsSQL);
      logger.info('[Database] Aggregation functions created/updated');
    } catch (error: any) {
      logger.error('[Database] Error creating aggregation functions:', error);
      throw error;
    }
  }

  /**
   * Check if database is available
   */
  isAvailable(): boolean {
    return this.isConnected && this.pool !== null;
  }

  /**
   * Get the latest date we have data for (across all tokens)
   */
  async getLatestDate(): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(date) as latest_date FROM daily_volumes'
      );
      return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest date:', error);
      return null;
    }
  }

  /**
   * Get the latest date for a specific token
   */
  async getLatestDateForToken(token: string): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(date) as latest_date FROM daily_volumes WHERE LOWER(token) = LOWER($1)',
        [token]
      );
      return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest date for token:', error);
      return null;
    }
  }

  /**
   * Upsert daily volume records using batched inserts for performance
   */
  async upsertDailyVolumes(records: DailyVolumeRecord[]): Promise<number> {
    if (!this.pool || !this.isConnected || records.length === 0) return 0;

    const BATCH_SIZE = 500; // Insert 500 records per batch
    let totalUpserted = 0;

    try {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        // Process in batches
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, i + BATCH_SIZE);
          
          // Build multi-value INSERT statement
          const values: any[] = [];
          const valuePlaceholders: string[] = [];
          
          batch.forEach((record, idx) => {
            const offset = idx * 6; // 6 parameters per record
            valuePlaceholders.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, CURRENT_TIMESTAMP)`
            );
            values.push(
              record.token,
              record.date,
              record.base_volume,
              record.target_volume,
              record.high,
              record.low
            );
          });

          const batchSQL = `
            INSERT INTO daily_volumes (token, date, base_volume, target_volume, high, low, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, date) 
            DO UPDATE SET 
              -- Only update if existing values are NULL or 0 (preserve existing data)
              base_volume = COALESCE(NULLIF(daily_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(daily_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(daily_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN daily_volumes.low > 0 THEN daily_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE daily_volumes.low END
              ),
              updated_at = CURRENT_TIMESTAMP
          `;

          await client.query(batchSQL, values);
          totalUpserted += batch.length;
          
          // Log progress for large batches
          if (records.length > BATCH_SIZE) {
            logger.info(`[Database] Daily volume batch progress: ${totalUpserted}/${records.length}`);
          }
        }

        await client.query('COMMIT');
        logger.info(`[Database] Upserted ${totalUpserted} daily volume records`);
        return totalUpserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error upserting daily volumes:', error);
      return 0;
    }
  }

  /**
   * Get all daily volumes for a token
   */
  async getDailyVolumesForToken(token: string): Promise<DailyVolumeRecord[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const result = await this.pool.query(
        `SELECT token, date::text, 
                base_volume::text, target_volume::text, 
                high::text, low::text
         FROM daily_volumes 
         WHERE LOWER(token) = LOWER($1) 
         ORDER BY date ASC`,
        [token]
      );
      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting daily volumes for token:', error);
      return [];
    }
  }

  /**
   * Get daily volumes for multiple tokens
   */
  async getDailyVolumesForTokens(tokens: string[]): Promise<Map<string, DailyVolumeRecord[]>> {
    if (!this.pool || !this.isConnected || tokens.length === 0) {
      return new Map();
    }

    try {
      const placeholders = tokens.map((_, i) => `LOWER($${i + 1})`).join(', ');
      const result = await this.pool.query(
        `SELECT token, date::text, 
                base_volume::text, target_volume::text, 
                high::text, low::text
         FROM daily_volumes 
         WHERE LOWER(token) IN (${placeholders})
         ORDER BY token, date ASC`,
        tokens.map(t => t.toLowerCase())
      );

      const tokenMap = new Map<string, DailyVolumeRecord[]>();
      for (const row of result.rows) {
        const tokenLower = row.token.toLowerCase();
        if (!tokenMap.has(tokenLower)) {
          tokenMap.set(tokenLower, []);
        }
        tokenMap.get(tokenLower)!.push(row);
      }
      return tokenMap;
    } catch (error: any) {
      logger.error('[Database] Error getting daily volumes for tokens:', error);
      return new Map();
    }
  }

  /**
   * Get aggregated volume data for all tokens (for API responses)
   */
  async getAggregatedVolumes(tokens?: string[]): Promise<TokenVolumeAggregate[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      let whereClause = '';
      let params: string[] = [];

      if (tokens && tokens.length > 0) {
        const placeholders = tokens.map((_, i) => `LOWER($${i + 1})`).join(', ');
        whereClause = `WHERE LOWER(token) IN (${placeholders})`;
        params = tokens.map(t => t.toLowerCase());
      }

      // Get aggregates
      const aggregateResult = await this.pool.query(
        `SELECT 
          token,
          MIN(date)::text as first_trade_date,
          MAX(date)::text as last_trade_date,
          SUM(base_volume)::text as total_base_volume,
          SUM(target_volume)::text as total_target_volume,
          MAX(high)::text as all_time_high,
          MIN(CASE WHEN low > 0 THEN low END)::text as all_time_low,
          COUNT(*)::int as trading_days
         FROM daily_volumes
         ${whereClause}
         GROUP BY token
         ORDER BY SUM(base_volume) DESC`,
        params
      );

      // Get daily data for each token
      const dailyDataMap = await this.getDailyVolumesForTokens(
        aggregateResult.rows.map(r => r.token)
      );

      return aggregateResult.rows.map(row => ({
        token: row.token,
        first_trade_date: row.first_trade_date,
        last_trade_date: row.last_trade_date,
        total_base_volume: row.total_base_volume || '0',
        total_target_volume: row.total_target_volume || '0',
        all_time_high: row.all_time_high || '0',
        all_time_low: row.all_time_low || '0',
        trading_days: row.trading_days,
        daily_data: dailyDataMap.get(row.token.toLowerCase()) || [],
      }));
    } catch (error: any) {
      logger.error('[Database] Error getting aggregated volumes:', error);
      return [];
    }
  }

  /**
   * Get 24h rolling volume data (last 24 hours from current time)
   * This queries data from today and yesterday to cover the 24h window
   */
  async get24hVolumes(tokens?: string[]): Promise<Map<string, { base_volume: string; target_volume: string; high: string; low: string }>> {
    if (!this.pool || !this.isConnected) return new Map();

    try {
      // Get today and yesterday's date
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      let whereClause = 'WHERE date >= $1';
      let params: any[] = [yesterday];

      if (tokens && tokens.length > 0) {
        const placeholders = tokens.map((_, i) => `LOWER($${i + 2})`).join(', ');
        whereClause += ` AND LOWER(token) IN (${placeholders})`;
        params = [yesterday, ...tokens.map(t => t.toLowerCase())];
      }

      const result = await this.pool.query(
        `SELECT 
          token,
          SUM(base_volume)::text as base_volume,
          SUM(target_volume)::text as target_volume,
          MAX(high)::text as high,
          MIN(CASE WHEN low > 0 THEN low END)::text as low
         FROM daily_volumes
         ${whereClause}
         GROUP BY token`,
        params
      );

      const volumeMap = new Map();
      for (const row of result.rows) {
        volumeMap.set(row.token.toLowerCase(), {
          base_volume: row.base_volume || '0',
          target_volume: row.target_volume || '0',
          high: row.high || '0',
          low: row.low || '0',
        });
      }
      return volumeMap;
    } catch (error: any) {
      logger.error('[Database] Error getting 24h volumes:', error);
      return new Map();
    }
  }

  /**
   * Set sync metadata
   */
  async setSyncMetadata(key: string, value: string): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `INSERT INTO sync_metadata (key, value, updated_at)
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
        [key, value]
      );
    } catch (error: any) {
      logger.error('[Database] Error setting sync metadata:', error);
    }
  }

  /**
   * Get sync metadata
   */
  async getSyncMetadata(key: string): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT value FROM sync_metadata WHERE key = $1',
        [key]
      );
      return result.rows[0]?.value || null;
    } catch (error: any) {
      logger.error('[Database] Error getting sync metadata:', error);
      return null;
    }
  }

  /**
   * Get total daily volume record count
   */
  async getRecordCount(): Promise<number> {
    return this.getDailyRecordCount();
  }

  /**
   * Get total daily volume record count
   */
  async getDailyRecordCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(*) as count FROM daily_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting daily record count:', error);
      return 0;
    }
  }

  /**
   * Get unique token count
   */
  async getTokenCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(DISTINCT token) as count FROM daily_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting token count:', error);
      return 0;
    }
  }

  // ============================================
  // HOURLY VOLUME METHODS
  // ============================================

  /**
   * Get the latest hour we have data for (across all tokens)
   */
  async getLatestHour(): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(hour) as latest_hour FROM hourly_volumes'
      );
      return result.rows[0]?.latest_hour?.toISOString() || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest hour:', error);
      return null;
    }
  }

  /**
   * Get the latest complete hour (where is_complete = true)
   */
  async getLatestCompleteHour(): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(hour) as latest_hour FROM hourly_volumes WHERE is_complete = true'
      );
      return result.rows[0]?.latest_hour?.toISOString() || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest complete hour:', error);
      return null;
    }
  }

  /**
   * Upsert hourly volume records using batched inserts for performance
   * @param records Array of hourly volume records
   * @param markComplete If true, marks these hours as complete (for historical data)
   */
  async upsertHourlyVolumes(records: HourlyVolumeRecord[], markComplete: boolean = false): Promise<number> {
    if (!this.pool || !this.isConnected || records.length === 0) return 0;

    const BATCH_SIZE = 500; // Insert 500 records per batch
    let totalUpserted = 0;

    try {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        // Process in batches
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, i + BATCH_SIZE);
          
          // Build multi-value INSERT statement
          const values: any[] = [];
          const valuePlaceholders: string[] = [];
          
          batch.forEach((record, idx) => {
            const offset = idx * 14; // 14 parameters per record (extended fields)
            valuePlaceholders.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, ${markComplete}, CURRENT_TIMESTAMP)`
            );
            values.push(
              record.token,
              record.hour,
              record.base_volume,
              record.target_volume,
              record.buy_volume || '0',
              record.sell_volume || '0',
              record.high,
              record.low,
              record.average_price || '0',
              record.trade_count || 0,
              record.usdc_fees || '0',
              record.token_fees || '0',
              record.token_fees_usdc || '0',
              record.sell_volume_usdc || '0'
            );
          });

          const batchSQL = `
            INSERT INTO hourly_volumes (token, hour, base_volume, target_volume, buy_volume, sell_volume, high, low, average_price, trade_count, usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc, is_complete, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, hour) 
            DO UPDATE SET 
              -- Only update core fields if they're missing (NULL or 0) or if new data is better
              base_volume = COALESCE(NULLIF(hourly_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(hourly_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(hourly_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN hourly_volumes.low > 0 THEN hourly_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE hourly_volumes.low END
              ),
              trade_count = GREATEST(COALESCE(hourly_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              -- Only update extended fields if they're missing (NULL or 0)
              buy_volume = COALESCE(NULLIF(hourly_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(hourly_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(hourly_volumes.average_price, 0), EXCLUDED.average_price),
              usdc_fees = COALESCE(NULLIF(hourly_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(hourly_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(hourly_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(hourly_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE hourly_volumes.is_complete END,
              updated_at = CURRENT_TIMESTAMP
          `;

          await client.query(batchSQL, values);
          totalUpserted += batch.length;
          
          // Log progress for large batches
          if (records.length > BATCH_SIZE) {
            logger.info(`[Database] Hourly volume batch progress: ${totalUpserted}/${records.length}`);
          }
        }

        await client.query('COMMIT');
        logger.info(`[Database] Upserted ${totalUpserted} hourly volume records (complete: ${markComplete})`);
        return totalUpserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error upserting hourly volumes:', error);
      return 0;
    }
  }

  /**
   * Mark hours as complete (called when hour boundary passes)
   */
  async markHoursComplete(beforeHour: string): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `UPDATE hourly_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
         WHERE hour < $1 AND is_complete = false`,
        [beforeHour]
      );
      logger.info(`[Database] Marked hours before ${beforeHour} as complete`);
    } catch (error: any) {
      logger.error('[Database] Error marking hours complete:', error);
    }
  }

  /**
   * Get rolling 24h metrics for all tokens from hourly data
   * This is the primary method for serving /api/tickers
   */
  async getRolling24hMetrics(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
    if (!this.pool || !this.isConnected) return new Map();

    try {
      // Get data from the last 24 hours
      const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      let whereClause = 'WHERE hour >= $1';
      let params: any[] = [cutoffTime];

      if (tokens && tokens.length > 0) {
        const placeholders = tokens.map((_, i) => `LOWER($${i + 2})`).join(', ');
        whereClause += ` AND LOWER(token) IN (${placeholders})`;
        params = [cutoffTime, ...tokens.map(t => t.toLowerCase())];
      }

      const result = await this.pool.query(
        `SELECT 
          token,
          SUM(base_volume)::text as base_volume_24h,
          SUM(target_volume)::text as target_volume_24h,
          MAX(high)::text as high_24h,
          MIN(CASE WHEN low > 0 THEN low END)::text as low_24h,
          SUM(trade_count)::int as trade_count_24h
         FROM hourly_volumes
         ${whereClause}
         GROUP BY token`,
        params
      );

      const metricsMap = new Map<string, Rolling24hMetrics>();
      for (const row of result.rows) {
        metricsMap.set(row.token.toLowerCase(), {
          token: row.token,
          base_volume_24h: row.base_volume_24h || '0',
          target_volume_24h: row.target_volume_24h || '0',
          high_24h: row.high_24h || '0',
          low_24h: row.low_24h || '0',
          trade_count_24h: row.trade_count_24h || 0,
        });
      }
      return metricsMap;
    } catch (error: any) {
      logger.error('[Database] Error getting rolling 24h metrics:', error);
      return new Map();
    }
  }

  /**
   * Get hourly data for a specific time range
   */
  async getHourlyVolumes(startHour: string, endHour?: string, tokens?: string[]): Promise<HourlyVolumeRecord[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      let whereClause = 'WHERE hour >= $1';
      let params: any[] = [startHour];
      let paramIndex = 2;

      if (endHour) {
        whereClause += ` AND hour <= $${paramIndex}`;
        params.push(endHour);
        paramIndex++;
      }

      if (tokens && tokens.length > 0) {
        const placeholders = tokens.map((_, i) => `LOWER($${paramIndex + i})`).join(', ');
        whereClause += ` AND LOWER(token) IN (${placeholders})`;
        params = [...params, ...tokens.map(t => t.toLowerCase())];
      }

      const result = await this.pool.query(
        `SELECT 
          token,
          hour::text,
          base_volume::text,
          target_volume::text,
          high::text,
          low::text,
          trade_count
         FROM hourly_volumes
         ${whereClause}
         ORDER BY token, hour ASC`,
        params
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting hourly volumes:', error);
      return [];
    }
  }

  /**
   * Get hourly record count
   */
  async getHourlyRecordCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(*) as count FROM hourly_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting hourly record count:', error);
      return 0;
    }
  }

  /**
   * Get unique token count from hourly table
   */
  async getHourlyTokenCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(DISTINCT token) as count FROM hourly_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting hourly token count:', error);
      return 0;
    }
  }

  /**
   * Delete old hourly data to prevent table from growing indefinitely
   * Keeps data for the specified number of hours
   */
  async pruneOldHourlyData(keepHours: number = 48): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const cutoffTime = new Date(Date.now() - keepHours * 60 * 60 * 1000).toISOString();
      const result = await this.pool.query(
        'DELETE FROM hourly_volumes WHERE hour < $1 RETURNING id',
        [cutoffTime]
      );
      const deletedCount = result.rowCount || 0;
      if (deletedCount > 0) {
        logger.info(`[Database] Pruned ${deletedCount} hourly records older than ${keepHours} hours`);
      }
      return deletedCount;
    } catch (error: any) {
      logger.error('[Database] Error pruning old hourly data:', error);
      return 0;
    }
  }

  // ============================================
  // 10-MINUTE VOLUME METHODS
  // ============================================

  /**
   * Upsert 10-minute volume records using batched inserts
   */
  async upsertTenMinuteVolumes(records: TenMinuteVolumeRecord[], markComplete: boolean = false): Promise<number> {
    if (!this.pool || !this.isConnected || records.length === 0) return 0;

    const BATCH_SIZE = 500;
    let totalUpserted = 0;

    try {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, i + BATCH_SIZE);
          
          const values: any[] = [];
          const valuePlaceholders: string[] = [];
          
          batch.forEach((record, idx) => {
            const offset = idx * 14; // 14 parameters per record (extended fields)
            valuePlaceholders.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, ${markComplete}, CURRENT_TIMESTAMP)`
            );
            values.push(
              record.token,
              record.bucket,
              record.base_volume,
              record.target_volume,
              record.buy_volume || '0',
              record.sell_volume || '0',
              record.high,
              record.low,
              record.average_price || '0',
              record.trade_count || 0,
              record.usdc_fees || '0',
              record.token_fees || '0',
              record.token_fees_usdc || '0',
              record.sell_volume_usdc || '0'
            );
          });

          const batchSQL = `
            INSERT INTO ten_minute_volumes (token, bucket, base_volume, target_volume, buy_volume, sell_volume, high, low, average_price, trade_count, usdc_fees, token_fees, token_fees_usdc, sell_volume_usdc, is_complete, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, bucket) 
            DO UPDATE SET 
              -- Only update core fields if they're missing (NULL or 0) or if new data is better
              base_volume = COALESCE(NULLIF(ten_minute_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(ten_minute_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(ten_minute_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN ten_minute_volumes.low > 0 THEN ten_minute_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE ten_minute_volumes.low END
              ),
              -- Only update extended fields if they're missing (NULL or 0)
              buy_volume = COALESCE(NULLIF(ten_minute_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(ten_minute_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(ten_minute_volumes.average_price, 0), EXCLUDED.average_price),
              trade_count = GREATEST(COALESCE(ten_minute_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              usdc_fees = COALESCE(NULLIF(ten_minute_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(ten_minute_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(ten_minute_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(ten_minute_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE ten_minute_volumes.is_complete END,
              updated_at = CURRENT_TIMESTAMP
          `;

          await client.query(batchSQL, values);
          totalUpserted += batch.length;
          
          if (records.length > BATCH_SIZE) {
            logger.info(`[Database] 10-min volume batch progress: ${totalUpserted}/${records.length}`);
          }
        }

        await client.query('COMMIT');
        logger.info(`[Database] Upserted ${totalUpserted} 10-minute volume records (complete: ${markComplete})`);
        return totalUpserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error upserting 10-minute volumes:', error);
      return 0;
    }
  }

  /**
   * Mark 10-minute buckets as complete
   */
  async markTenMinuteBucketsComplete(beforeBucket: string): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `UPDATE ten_minute_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
         WHERE bucket < $1 AND is_complete = false`,
        [beforeBucket]
      );
    } catch (error: any) {
      logger.error('[Database] Error marking 10-min buckets complete:', error);
    }
  }

  /**
   * Backfill missing extended fields in existing records
   * This is safe to run on existing data - only fills in NULL or 0 values
   */
  async backfillMissingFields(): Promise<{
    tenMinuteUpdated: number;
    hourlyUpdated: number;
    dailyUpdated: number;
  }> {
    if (!this.pool || !this.isConnected) {
      return { tenMinuteUpdated: 0, hourlyUpdated: 0, dailyUpdated: 0 };
    }

    logger.info('[Database] Starting backfill of missing extended fields using DB aggregation functions...');
    const results = {
      tenMinuteUpdated: 0,
      hourlyUpdated: 0,
      dailyUpdated: 0,
    };

    try {
      // 1. Find all hours that have 10-minute data but missing/zero extended fields
      logger.info('[Database] Finding hours with missing extended fields that have 10-minute data...');
      const hoursToUpdate = await this.pool.query(`
        SELECT DISTINCT 
          hv.token,
          hv.hour
        FROM hourly_volumes hv
        WHERE EXISTS (
          SELECT 1 
          FROM ten_minute_volumes tmv 
          WHERE tmv.token = hv.token 
            AND date_trunc('hour', tmv.bucket) = hv.hour
        )
        AND (
          hv.average_price IS NULL OR hv.average_price = 0 OR
          hv.usdc_fees IS NULL OR hv.usdc_fees = 0 OR
          hv.sell_volume_usdc IS NULL OR hv.sell_volume_usdc = 0 OR
          hv.buy_volume IS NULL OR hv.buy_volume = 0 OR
          hv.sell_volume IS NULL OR hv.sell_volume = 0 OR
          hv.token_fees IS NULL OR hv.token_fees = 0 OR
          hv.token_fees_usdc IS NULL OR hv.token_fees_usdc = 0
        )
        ORDER BY hv.token, hv.hour
      `);

      logger.info(`[Database] Found ${hoursToUpdate.rows.length} hours to update from 10-minute data`);

      // Process each hour using the DB aggregation function
      if (hoursToUpdate.rows.length > 0) {
        logger.info('[Database] Backfilling hourly records from 10-minute data using aggregate_10min_to_hourly function...');
        
        for (const row of hoursToUpdate.rows) {
          // Call the DB function for this specific hour
          // PostgreSQL has issues with parameter type inference for function calls,
          // so we construct the SQL with properly escaped values
          // Declare outside try block so they're accessible in catch block
          const tokenValue = String(row.token);
          const hourValue = row.hour instanceof Date ? row.hour.toISOString() : String(row.hour);
          
          try {
            
            // Use pg's escapeLiteral for safe SQL construction
            const client = await this.pool.connect();
            try {
              const escapedToken = client.escapeLiteral(tokenValue);
              const escapedHour = client.escapeLiteral(hourValue);
              
              const aggregated = await client.query(
                `SELECT * FROM aggregate_10min_to_hourly(${escapedToken}::VARCHAR, ${escapedHour}::TIMESTAMPTZ)`
              );
              
              if (aggregated.rows.length > 0) {
                const agg = aggregated.rows[0];
                
                // Only update if we have valid aggregated data (not all NULL)
                if (agg.average_price != null || agg.usdc_fees != null || agg.sell_volume_usdc != null) {
                  // Convert all numeric values to proper types (null or number)
                  // PostgreSQL can't determine parameter types when values are undefined
                  const buyVolume = agg.buy_volume != null ? Number(agg.buy_volume) : null;
                  const sellVolume = agg.sell_volume != null ? Number(agg.sell_volume) : null;
                  const averagePrice = agg.average_price != null ? Number(agg.average_price) : null;
                  const usdcFees = agg.usdc_fees != null ? Number(agg.usdc_fees) : null;
                  const tokenFees = agg.token_fees != null ? Number(agg.token_fees) : null;
                  const tokenFeesUsdc = agg.token_fees_usdc != null ? Number(agg.token_fees_usdc) : null;
                  const sellVolumeUsdc = agg.sell_volume_usdc != null ? Number(agg.sell_volume_usdc) : null;
                  
                  // Log parameter values for debugging
                  logger.debug(`[Database] Updating hour ${hourValue} for token ${tokenValue}`, {
                    buyVolume,
                    sellVolume,
                    averagePrice,
                    usdcFees,
                    tokenFees,
                    tokenFeesUsdc,
                    sellVolumeUsdc,
                    tokenValue,
                    hourValue,
                    rawAgg: agg
                  });
                  
                  // Update the hourly record with aggregated values, only updating fields that are 0 or NULL
                  await client.query(
                    `UPDATE hourly_volumes
                    SET 
                      buy_volume = CASE WHEN $1::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(buy_volume, 0), $1::NUMERIC) ELSE buy_volume END,
                      sell_volume = CASE WHEN $2::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume, 0), $2::NUMERIC) ELSE sell_volume END,
                      average_price = CASE WHEN $3::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(average_price, 0), $3::NUMERIC) ELSE average_price END,
                      usdc_fees = CASE WHEN $4::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(usdc_fees, 0), $4::NUMERIC) ELSE usdc_fees END,
                      token_fees = CASE WHEN $5::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees, 0), $5::NUMERIC) ELSE token_fees END,
                      token_fees_usdc = CASE WHEN $6::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees_usdc, 0), $6::NUMERIC) ELSE token_fees_usdc END,
                      sell_volume_usdc = CASE WHEN $7::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume_usdc, 0), $7::NUMERIC) ELSE sell_volume_usdc END,
                      updated_at = CURRENT_TIMESTAMP
                    WHERE token = $8::VARCHAR AND hour = $9::TIMESTAMPTZ
                      AND (
                        average_price IS NULL OR average_price = 0 OR
                        usdc_fees IS NULL OR usdc_fees = 0 OR
                        sell_volume_usdc IS NULL OR sell_volume_usdc = 0 OR
                        buy_volume IS NULL OR buy_volume = 0 OR
                        sell_volume IS NULL OR sell_volume = 0 OR
                        token_fees IS NULL OR token_fees = 0 OR
                        token_fees_usdc IS NULL OR token_fees_usdc = 0
                      )`,
                    [
                      buyVolume,
                      sellVolume,
                      averagePrice,
                      usdcFees,
                      tokenFees,
                      tokenFeesUsdc,
                      sellVolumeUsdc,
                      tokenValue,
                      hourValue,
                    ]
                  );
                  results.hourlyUpdated++;
                }
              }
            } finally {
              client.release();
            }
          } catch (error: any) {
            logger.error(`[Database] Error updating hour ${row.hour} for token ${row.token}:`, {
              error: error.message,
              stack: error.stack,
              token: row.token,
              hour: row.hour,
              tokenValue,
              hourValue,
              tokenType: typeof row.token,
              hourType: typeof row.hour,
              hourIsDate: row.hour instanceof Date,
              hourRawValue: row.hour,
            });
          }
        }
        logger.info(`[Database] Updated ${results.hourlyUpdated} hourly records with missing fields`);
      }

      // 2. Find all days that have hourly data but missing/zero extended fields
      logger.info('[Database] Finding days with missing extended fields that have hourly data...');
      const daysToUpdate = await this.pool.query(`
        SELECT DISTINCT 
          dv.token,
          dv.date
        FROM daily_volumes dv
        WHERE EXISTS (
          SELECT 1 
          FROM hourly_volumes hv 
          WHERE hv.token = dv.token 
            AND date_trunc('day', hv.hour)::DATE = dv.date
        )
        AND (
          dv.average_price IS NULL OR dv.average_price = 0 OR
          dv.usdc_fees IS NULL OR dv.usdc_fees = 0 OR
          dv.sell_volume_usdc IS NULL OR dv.sell_volume_usdc = 0 OR
          dv.buy_volume IS NULL OR dv.buy_volume = 0 OR
          dv.sell_volume IS NULL OR dv.sell_volume = 0 OR
          dv.token_fees IS NULL OR dv.token_fees = 0 OR
          dv.token_fees_usdc IS NULL OR dv.token_fees_usdc = 0
        )
        ORDER BY dv.token, dv.date
      `);

      logger.info(`[Database] Found ${daysToUpdate.rows.length} days to update from hourly data`);

      // Process each day using the DB aggregation function
      if (daysToUpdate.rows.length > 0) {
        logger.info('[Database] Backfilling daily records from hourly data using aggregate_hourly_to_daily function...');
        
        for (const row of daysToUpdate.rows) {
          // Call the DB function for this specific day
          // PostgreSQL has issues with parameter type inference for function calls,
          // so we construct the SQL with properly escaped values
          // Declare outside try block so they're accessible in catch block
          const tokenValue = String(row.token);
          const dateValue = row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date);
          
          try {
            
            // Use pg's escapeLiteral for safe SQL construction
            const client = await this.pool.connect();
            try {
              const escapedToken = client.escapeLiteral(tokenValue);
              const escapedDate = client.escapeLiteral(dateValue);
              
              const aggregated = await client.query(
                `SELECT * FROM aggregate_hourly_to_daily(${escapedToken}::VARCHAR, ${escapedDate}::DATE)`
              );
              
              if (aggregated.rows.length > 0) {
                const agg = aggregated.rows[0];
                
                // Only update if we have valid aggregated data (not all NULL)
                if (agg.average_price != null || agg.usdc_fees != null || agg.sell_volume_usdc != null) {
                  // Convert all numeric values to proper types (null or number)
                  // PostgreSQL can't determine parameter types when values are undefined
                  const buyVolume = agg.buy_volume != null ? Number(agg.buy_volume) : null;
                  const sellVolume = agg.sell_volume != null ? Number(agg.sell_volume) : null;
                  const averagePrice = agg.average_price != null ? Number(agg.average_price) : null;
                  const tradeCount = agg.trade_count != null ? Number(agg.trade_count) : null;
                  const usdcFees = agg.usdc_fees != null ? Number(agg.usdc_fees) : null;
                  const tokenFees = agg.token_fees != null ? Number(agg.token_fees) : null;
                  const tokenFeesUsdc = agg.token_fees_usdc != null ? Number(agg.token_fees_usdc) : null;
                  const sellVolumeUsdc = agg.sell_volume_usdc != null ? Number(agg.sell_volume_usdc) : null;
                  const cumulativeUsdcFees = agg.cumulative_usdc_fees != null ? Number(agg.cumulative_usdc_fees) : null;
                  const cumulativeTokenInUsdcFees = agg.cumulative_token_in_usdc_fees != null ? Number(agg.cumulative_token_in_usdc_fees) : null;
                  const cumulativeTargetVolume = agg.cumulative_target_volume != null ? Number(agg.cumulative_target_volume) : null;
                  const cumulativeTokenVolume = agg.cumulative_token_volume != null ? Number(agg.cumulative_token_volume) : null;
                  
                  // Log parameter values for debugging
                  logger.debug(`[Database] Updating day ${dateValue} for token ${tokenValue}`, {
                    buyVolume,
                    sellVolume,
                    averagePrice,
                    tradeCount,
                    usdcFees,
                    tokenFees,
                    tokenFeesUsdc,
                    sellVolumeUsdc,
                    cumulativeUsdcFees,
                    cumulativeTokenInUsdcFees,
                    cumulativeTargetVolume,
                    cumulativeTokenVolume,
                    tokenValue,
                    dateValue,
                    rawAgg: agg
                  });
                  
                  // Update the daily record with aggregated values, only updating fields that are 0 or NULL
                  await client.query(
                    `UPDATE daily_volumes
                    SET 
                      buy_volume = CASE WHEN $1::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(buy_volume, 0), $1::NUMERIC) ELSE buy_volume END,
                      sell_volume = CASE WHEN $2::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume, 0), $2::NUMERIC) ELSE sell_volume END,
                      average_price = CASE WHEN $3::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(average_price, 0), $3::NUMERIC) ELSE average_price END,
                      trade_count = CASE WHEN $4::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(trade_count, 0), $4::NUMERIC) ELSE trade_count END,
                      usdc_fees = CASE WHEN $5::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(usdc_fees, 0), $5::NUMERIC) ELSE usdc_fees END,
                      token_fees = CASE WHEN $6::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees, 0), $6::NUMERIC) ELSE token_fees END,
                      token_fees_usdc = CASE WHEN $7::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(token_fees_usdc, 0), $7::NUMERIC) ELSE token_fees_usdc END,
                      sell_volume_usdc = CASE WHEN $8::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(sell_volume_usdc, 0), $8::NUMERIC) ELSE sell_volume_usdc END,
                      cumulative_usdc_fees = CASE WHEN $9::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_usdc_fees, 0), $9::NUMERIC) ELSE cumulative_usdc_fees END,
                      cumulative_token_in_usdc_fees = CASE WHEN $10::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_token_in_usdc_fees, 0), $10::NUMERIC) ELSE cumulative_token_in_usdc_fees END,
                      cumulative_target_volume = CASE WHEN $11::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_target_volume, 0), $11::NUMERIC) ELSE cumulative_target_volume END,
                      cumulative_token_volume = CASE WHEN $12::NUMERIC IS NOT NULL THEN COALESCE(NULLIF(cumulative_token_volume, 0), $12::NUMERIC) ELSE cumulative_token_volume END,
                      updated_at = CURRENT_TIMESTAMP
                    WHERE token = $13::VARCHAR AND date = $14::DATE
                      AND (
                        average_price IS NULL OR average_price = 0 OR
                        usdc_fees IS NULL OR usdc_fees = 0 OR
                        sell_volume_usdc IS NULL OR sell_volume_usdc = 0 OR
                        buy_volume IS NULL OR buy_volume = 0 OR
                        sell_volume IS NULL OR sell_volume = 0 OR
                        token_fees IS NULL OR token_fees = 0 OR
                        token_fees_usdc IS NULL OR token_fees_usdc = 0
                      )`,
                    [
                      buyVolume,
                      sellVolume,
                      averagePrice,
                      tradeCount,
                      usdcFees,
                      tokenFees,
                      tokenFeesUsdc,
                      sellVolumeUsdc,
                      cumulativeUsdcFees,
                      cumulativeTokenInUsdcFees,
                      cumulativeTargetVolume,
                      cumulativeTokenVolume,
                      tokenValue,
                      dateValue,
                    ]
                  );
                  results.dailyUpdated++;
                }
              }
            } finally {
              client.release();
            }
          } catch (error: any) {
            logger.error(`[Database] Error updating day ${row.date} for token ${row.token}:`, {
              error: error.message,
              stack: error.stack,
              token: row.token,
              date: row.date,
              tokenValue,
              dateValue,
              tokenType: typeof row.token,
              dateType: typeof row.date,
              dateIsDate: row.date instanceof Date,
              dateRawValue: row.date,
            });
          }
        }
        logger.info(`[Database] Updated ${results.dailyUpdated} daily records with missing fields`);
      }

      logger.info('[Database] Backfill completed:', { results });
      return results;
    } catch (error: any) {
      logger.error('[Database] Error during backfill:', error);
      return results;
    }
  }

  /**
   * Get rolling 24h metrics from 10-minute data (most accurate)
   * This uses the calculate_rolling_24h function
   */
  async getRolling24hFromTenMinute(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
    if (!this.pool || !this.isConnected) return new Map();

    try {
      const metricsMap = new Map<string, Rolling24hMetrics>();
      
      if (tokens && tokens.length > 0) {
        // Get metrics for specific tokens
        for (const token of tokens) {
          const result = await this.pool.query(
            `SELECT * FROM calculate_rolling_24h($1)`,
            [token]
          );
          
          for (const row of result.rows) {
            metricsMap.set(row.token.toLowerCase(), {
              token: row.token,
              base_volume_24h: row.base_volume_24h?.toString() || '0',
              target_volume_24h: row.target_volume_24h?.toString() || '0',
              high_24h: row.high_24h?.toString() || '0',
              low_24h: row.low_24h?.toString() || '0',
              trade_count_24h: row.trade_count_24h || 0,
            });
          }
        }
      } else {
        // Get metrics for all tokens
        const result = await this.pool.query(
          `SELECT * FROM calculate_rolling_24h(NULL)`
        );
        
        for (const row of result.rows) {
          metricsMap.set(row.token.toLowerCase(), {
            token: row.token,
            base_volume_24h: row.base_volume_24h?.toString() || '0',
            target_volume_24h: row.target_volume_24h?.toString() || '0',
            high_24h: row.high_24h?.toString() || '0',
            low_24h: row.low_24h?.toString() || '0',
            trade_count_24h: row.trade_count_24h || 0,
          });
        }
      }
      
      return metricsMap;
    } catch (error: any) {
      logger.error('[Database] Error getting rolling 24h from 10-min data:', error);
      return new Map();
    }
  }

  /**
   * Aggregate 10-minute buckets into hourly records and upsert to hourly_volumes
   * @param token Optional token to aggregate (if null, aggregates all tokens)
   * @param hour Optional hour to aggregate (if null, aggregates all incomplete hours)
   * @returns Number of hourly records created/updated
   */
  async aggregate10MinToHourly(token?: string, hour?: string): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query(
        `SELECT * FROM aggregate_10min_to_hourly(CAST($1 AS VARCHAR), CAST($2 AS TIMESTAMPTZ))`,
        [token || null, hour || null]
      );

      if (result.rows.length === 0) {
        return 0;
      }

      // Upsert aggregated data into hourly_volumes
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        for (const row of result.rows) {
          await client.query(
            `INSERT INTO hourly_volumes (
              token, hour, base_volume, target_volume, buy_volume, sell_volume,
              high, low, average_price, trade_count, usdc_fees, token_fees,
              token_fees_usdc, sell_volume_usdc, is_complete, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, CURRENT_TIMESTAMP)
            ON CONFLICT (token, hour) DO UPDATE SET
              -- Only update core fields if missing or if new data is better
              base_volume = COALESCE(NULLIF(hourly_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(hourly_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(hourly_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN hourly_volumes.low > 0 THEN hourly_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE hourly_volumes.low END
              ),
              trade_count = GREATEST(COALESCE(hourly_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              -- Only update extended fields if missing
              buy_volume = COALESCE(NULLIF(hourly_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(hourly_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(hourly_volumes.average_price, 0), EXCLUDED.average_price),
              usdc_fees = COALESCE(NULLIF(hourly_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(hourly_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(hourly_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(hourly_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              is_complete = true,
              updated_at = CURRENT_TIMESTAMP`,
            [
              row.token,
              row.hour,
              row.base_volume,
              row.target_volume,
              row.buy_volume,
              row.sell_volume,
              row.high,
              row.low,
              row.average_price,
              row.trade_count,
              row.usdc_fees,
              row.token_fees,
              row.token_fees_usdc,
              row.sell_volume_usdc,
            ]
          );
        }

        await client.query('COMMIT');
        logger.info(`[Database] Aggregated ${result.rows.length} hourly records from 10-minute data`);
        return result.rows.length;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error aggregating 10-min to hourly:', error);
      return 0;
    }
  }

  /**
   * Aggregate hourly records into daily records with cumulative values and upsert to daily_volumes
   * @param token Optional token to aggregate (if null, aggregates all tokens)
   * @param date Optional date to aggregate (if null, aggregates all incomplete days)
   * @returns Number of daily records created/updated
   */
  async aggregateHourlyToDaily(token?: string, date?: string): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query(
        `SELECT * FROM aggregate_hourly_to_daily(CAST($1 AS VARCHAR), CAST($2 AS DATE))`,
        [token || null, date || null]
      );

      if (result.rows.length === 0) {
        return 0;
      }

      // Upsert aggregated data into daily_volumes
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        for (const row of result.rows) {
          await client.query(
            `INSERT INTO daily_volumes (
              token, date, base_volume, target_volume, buy_volume, sell_volume,
              high, low, average_price, trade_count, usdc_fees, token_fees,
              token_fees_usdc, sell_volume_usdc, cumulative_usdc_fees,
              cumulative_token_in_usdc_fees, cumulative_target_volume,
              cumulative_token_volume, is_complete, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, true, CURRENT_TIMESTAMP)
            ON CONFLICT (token, date) DO UPDATE SET
              -- Only update core fields if missing or if new data is better
              base_volume = COALESCE(NULLIF(daily_volumes.base_volume, 0), EXCLUDED.base_volume),
              target_volume = COALESCE(NULLIF(daily_volumes.target_volume, 0), EXCLUDED.target_volume),
              high = GREATEST(COALESCE(daily_volumes.high, 0), COALESCE(EXCLUDED.high, 0)),
              low = LEAST(
                CASE WHEN daily_volumes.low > 0 THEN daily_volumes.low ELSE EXCLUDED.low END,
                CASE WHEN EXCLUDED.low > 0 THEN EXCLUDED.low ELSE daily_volumes.low END
              ),
              trade_count = GREATEST(COALESCE(daily_volumes.trade_count, 0), COALESCE(EXCLUDED.trade_count, 0)),
              -- Only update extended fields if missing
              buy_volume = COALESCE(NULLIF(daily_volumes.buy_volume, 0), EXCLUDED.buy_volume),
              sell_volume = COALESCE(NULLIF(daily_volumes.sell_volume, 0), EXCLUDED.sell_volume),
              average_price = COALESCE(NULLIF(daily_volumes.average_price, 0), EXCLUDED.average_price),
              usdc_fees = COALESCE(NULLIF(daily_volumes.usdc_fees, 0), EXCLUDED.usdc_fees),
              token_fees = COALESCE(NULLIF(daily_volumes.token_fees, 0), EXCLUDED.token_fees),
              token_fees_usdc = COALESCE(NULLIF(daily_volumes.token_fees_usdc, 0), EXCLUDED.token_fees_usdc),
              sell_volume_usdc = COALESCE(NULLIF(daily_volumes.sell_volume_usdc, 0), EXCLUDED.sell_volume_usdc),
              -- Cumulative values should be recalculated, but preserve if already set
              cumulative_usdc_fees = COALESCE(NULLIF(daily_volumes.cumulative_usdc_fees, 0), EXCLUDED.cumulative_usdc_fees),
              cumulative_token_in_usdc_fees = COALESCE(NULLIF(daily_volumes.cumulative_token_in_usdc_fees, 0), EXCLUDED.cumulative_token_in_usdc_fees),
              cumulative_target_volume = COALESCE(NULLIF(daily_volumes.cumulative_target_volume, 0), EXCLUDED.cumulative_target_volume),
              cumulative_token_volume = COALESCE(NULLIF(daily_volumes.cumulative_token_volume, 0), EXCLUDED.cumulative_token_volume),
              is_complete = true,
              updated_at = CURRENT_TIMESTAMP`,
            [
              row.token,
              row.date,
              row.base_volume,
              row.target_volume,
              row.buy_volume,
              row.sell_volume,
              row.high,
              row.low,
              row.average_price,
              row.trade_count,
              row.usdc_fees,
              row.token_fees,
              row.token_fees_usdc,
              row.sell_volume_usdc,
              row.cumulative_usdc_fees,
              row.cumulative_token_in_usdc_fees,
              row.cumulative_target_volume,
              row.cumulative_token_volume,
            ]
          );
        }

        await client.query('COMMIT');
        logger.info(`[Database] Aggregated ${result.rows.length} daily records from hourly data`);
        return result.rows.length;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error aggregating hourly to daily:', error);
      return 0;
    }
  }

  /**
   * Get latest 10-minute bucket
   */
  async getLatestTenMinuteBucket(): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(bucket) as latest_bucket FROM ten_minute_volumes'
      );
      return result.rows[0]?.latest_bucket?.toISOString() || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest 10-min bucket:', error);
      return null;
    }
  }

  /**
   * Get 10-minute record count
   */
  async getTenMinuteRecordCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(*) as count FROM ten_minute_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting 10-min record count:', error);
      return 0;
    }
  }

  /**
   * Prune old 10-minute data (keep 25 hours for safety margin)
   */
  async pruneOldTenMinuteData(keepHours: number = 25): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const cutoffTime = new Date(Date.now() - keepHours * 60 * 60 * 1000).toISOString();
      const result = await this.pool.query(
        'DELETE FROM ten_minute_volumes WHERE bucket < $1 RETURNING id',
        [cutoffTime]
      );
      const deletedCount = result.rowCount || 0;
      if (deletedCount > 0) {
        logger.info(`[Database] Pruned ${deletedCount} 10-minute records older than ${keepHours} hours`);
      }
      return deletedCount;
    } catch (error: any) {
      logger.error('[Database] Error pruning old 10-min data:', error);
      return 0;
    }
  }

  // ============================================
  // DAILY BUY/SELL VOLUME METHODS
  // ============================================

  /**
   * Get the latest date we have buy/sell data for
   */
  async getLatestBuySellDate(): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(date) as latest_date FROM daily_buy_sell_volumes WHERE is_complete = true'
      );
      return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest buy/sell date:', error);
      return null;
    }
  }

  /**
   * Upsert daily buy/sell volume records using batched inserts
   * @param records Array of daily buy/sell volume records
   * @param markComplete If true, marks these days as complete (for historical data)
   */
  async upsertDailyBuySellVolumes(records: DailyBuySellVolumeRecord[], markComplete: boolean = false): Promise<number> {
    if (!this.pool || !this.isConnected || records.length === 0) {
      return 0;
    }

    const BATCH_SIZE = 500;
    let totalUpserted = 0;

    try {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, i + BATCH_SIZE);
          
          const values: any[] = [];
          const valuePlaceholders: string[] = [];
          
          batch.forEach((record, idx) => {
            const offset = idx * 9; // 9 parameters per record
            valuePlaceholders.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, ${markComplete}, CURRENT_TIMESTAMP)`
            );
            values.push(
              record.token,
              record.date,
              record.base_volume,
              record.target_volume,
              record.buy_usdc_volume,
              record.sell_token_volume,
              record.high,
              record.low,
              record.trade_count || 0
            );
          });

          const batchSQL = `
            INSERT INTO daily_buy_sell_volumes (token, date, base_volume, target_volume, buy_usdc_volume, sell_token_volume, high, low, trade_count, is_complete, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, date) 
            DO UPDATE SET 
              base_volume = EXCLUDED.base_volume,
              target_volume = EXCLUDED.target_volume,
              buy_usdc_volume = EXCLUDED.buy_usdc_volume,
              sell_token_volume = EXCLUDED.sell_token_volume,
              high = EXCLUDED.high,
              low = EXCLUDED.low,
              trade_count = EXCLUDED.trade_count,
              is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE daily_buy_sell_volumes.is_complete END,
              updated_at = CURRENT_TIMESTAMP
          `;

          await client.query(batchSQL, values);
          totalUpserted += batch.length;
          
          if (records.length > BATCH_SIZE) {
            logger.info(`[Database] Buy/sell volume batch progress: ${totalUpserted}/${records.length}`);
          }
        }

        await client.query('COMMIT');
        logger.info(`[Database] Upserted ${totalUpserted} daily buy/sell volume records`);
        return totalUpserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error upserting daily buy/sell volumes:', error);
      return 0;
    }
  }

  /**
   * Get daily buy/sell volumes with cumulative totals calculated from DB
   * Cumulative values are computed on-the-fly using window functions
   */
  async getDailyBuySellVolumesWithCumulative(token?: string): Promise<CumulativeVolumeData[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      let whereClause = '';
      let params: any[] = [];

      if (token) {
        whereClause = 'WHERE LOWER(token) = LOWER($1)';
        params = [token];
      }

      const result = await this.pool.query(
        `SELECT 
          token,
          date::text,
          base_volume::text,
          target_volume::text,
          buy_usdc_volume::text,
          sell_token_volume::text,
          SUM(target_volume) OVER (
            PARTITION BY token
            ORDER BY date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )::text AS cumulative_target_volume,
          SUM(base_volume) OVER (
            PARTITION BY token
            ORDER BY date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )::text AS cumulative_base_volume,
          SUM(buy_usdc_volume) OVER (
            PARTITION BY token
            ORDER BY date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )::text AS cumulative_buy_usdc_volume,
          SUM(sell_token_volume) OVER (
            PARTITION BY token
            ORDER BY date
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )::text AS cumulative_sell_token_volume,
          high::text,
          low::text
         FROM daily_buy_sell_volumes
         ${whereClause}
         ORDER BY token, date ASC`,
        params
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting cumulative volumes:', error);
      return [];
    }
  }

  /**
   * Get daily buy/sell volumes with date range filtering
   * @param options.token Filter by specific token
   * @param options.startDate Start date (inclusive) in YYYY-MM-DD format
   * @param options.endDate End date (inclusive) in YYYY-MM-DD format
   */
  async getDailyBuySellVolumes(options?: {
    token?: string;
    tokens?: string[];
    startDate?: string;
    endDate?: string;
  }): Promise<{
    token: string;
    date: string;
    base_volume: string;
    target_volume: string;
    buy_usdc_volume: string;
    sell_token_volume: string;
    high: string;
    low: string;
    trade_count: number;
    average_price: string;
    usdc_fees: string;
    token_fees: string;
    token_fees_usdc: string;
    sell_volume_usdc: string;
    sell_volume: string;
    buy_volume: string;
  }[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      // Support both single token and array of tokens
      if (options?.tokens && options.tokens.length > 0) {
        const placeholders = options.tokens.map((_, i) => `LOWER($${paramIndex + i})`).join(', ');
        conditions.push(`LOWER(token) IN (${placeholders})`);
        params.push(...options.tokens);
        paramIndex += options.tokens.length;
      } else if (options?.token) {
        conditions.push(`LOWER(token) = LOWER($${paramIndex})`);
        params.push(options.token);
        paramIndex++;
      }

      if (options?.startDate) {
        conditions.push(`date >= $${paramIndex}`);
        params.push(options.startDate);
        paramIndex++;
      }

      if (options?.endDate) {
        conditions.push(`date <= $${paramIndex}`);
        params.push(options.endDate);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await this.pool.query(
        `SELECT 
          token,
          date::text,
          base_volume::text,
          target_volume::text,
          buy_volume::text,
          buy_volume::text as buy_usdc_volume,
          sell_volume::text,
          sell_volume::text as sell_token_volume,
          high::text,
          low::text,
          trade_count,
          average_price::text,
          usdc_fees::text,
          token_fees::text,
          token_fees_usdc::text,
          sell_volume_usdc::text
         FROM daily_volumes
         ${whereClause}
         ORDER BY token, date ASC`,
        params
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting daily buy/sell volumes:', error);
      return [];
    }
  }

  /**
   * Get daily Meteora volumes with date range filtering
   * @param options.token Filter by specific token
   * @param options.tokens Filter by array of tokens
   * @param options.startDate Start date (inclusive) in YYYY-MM-DD format
   * @param options.endDate End date (inclusive) in YYYY-MM-DD format
   */
  async getDailyMeteoraVolumes(options?: {
    token?: string;
    tokens?: string[];
    startDate?: string;
    endDate?: string;
  }): Promise<{
    token: string;
    date: string;
    base_volume: string;
    target_volume: string;
    buy_volume: string;
    sell_volume: string;
    trade_count: number;
    average_price: string;
    usdc_fees: string;
    token_fees: string;
    token_fees_usdc: string;
    token_per_usdc: string;
  }[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      // Support both single token and array of tokens
      if (options?.tokens && options.tokens.length > 0) {
        const placeholders = options.tokens.map((_, i) => `LOWER($${paramIndex + i})`).join(', ');
        conditions.push(`LOWER(token) IN (${placeholders})`);
        params.push(...options.tokens);
        paramIndex += options.tokens.length;
      } else if (options?.token) {
        conditions.push(`LOWER(token) = LOWER($${paramIndex})`);
        params.push(options.token);
        paramIndex++;
      }

      if (options?.startDate) {
        conditions.push(`date >= $${paramIndex}`);
        params.push(options.startDate);
        paramIndex++;
      }

      if (options?.endDate) {
        conditions.push(`date <= $${paramIndex}`);
        params.push(options.endDate);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
         FROM daily_meteora_volumes
         ${whereClause}
         ORDER BY token, date ASC`,
        params
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting daily Meteora volumes:', error);
      return [];
    }
  }

  /**
   * Get aggregated buy/sell stats for all tokens
   */
  async getBuySellAggregates(tokens?: string[]): Promise<Map<string, {
    total_buy_usdc: string;
    total_sell_token: string;
    total_base_volume: string;
    total_target_volume: string;
    first_date: string;
    last_date: string;
    trading_days: number;
  }>> {
    if (!this.pool || !this.isConnected) return new Map();

    try {
      let whereClause = '';
      let params: any[] = [];

      if (tokens && tokens.length > 0) {
        const placeholders = tokens.map((_, i) => `LOWER($${i + 1})`).join(', ');
        whereClause = `WHERE LOWER(token) IN (${placeholders})`;
        params = tokens.map(t => t.toLowerCase());
      }

      const result = await this.pool.query(
        `SELECT 
          token,
          SUM(buy_usdc_volume)::text AS total_buy_usdc,
          SUM(sell_token_volume)::text AS total_sell_token,
          SUM(base_volume)::text AS total_base_volume,
          SUM(target_volume)::text AS total_target_volume,
          MIN(date)::text AS first_date,
          MAX(date)::text AS last_date,
          COUNT(*)::int AS trading_days
         FROM daily_buy_sell_volumes
         ${whereClause}
         GROUP BY token
         ORDER BY SUM(target_volume) DESC`,
        params
      );

      const aggregates = new Map();
      for (const row of result.rows) {
        aggregates.set(row.token.toLowerCase(), {
          total_buy_usdc: row.total_buy_usdc || '0',
          total_sell_token: row.total_sell_token || '0',
          total_base_volume: row.total_base_volume || '0',
          total_target_volume: row.total_target_volume || '0',
          first_date: row.first_date,
          last_date: row.last_date,
          trading_days: row.trading_days || 0,
        });
      }
      return aggregates;
    } catch (error: any) {
      logger.error('[Database] Error getting buy/sell aggregates:', error);
      return new Map();
    }
  }

  /**
   * Get the first trade date for each token (when trading started)
   * Returns a Map of token address -> first trade date (YYYY-MM-DD)
   */
  async getFirstTradeDates(): Promise<Map<string, string>> {
    if (!this.pool || !this.isConnected) return new Map();

    try {
      const result = await this.pool.query(
        `SELECT token, MIN(date)::text AS first_date
         FROM daily_buy_sell_volumes
         GROUP BY token`
      );

      const map = new Map<string, string>();
      for (const row of result.rows) {
        map.set(row.token.toLowerCase(), row.first_date);
      }
      return map;
    } catch (error: any) {
      logger.error('[Database] Error getting first trade dates:', error);
      return new Map();
    }
  }

  /**
   * Get buy/sell volume record count
   */
  async getBuySellRecordCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(*) as count FROM daily_buy_sell_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting buy/sell record count:', error);
      return 0;
    }
  }

  /**
   * Mark days as complete (called when day boundary passes)
   */
  async markBuySellDaysComplete(beforeDate: string): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `UPDATE daily_buy_sell_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
         WHERE date < $1 AND is_complete = false`,
        [beforeDate]
      );
      logger.info(`[Database] Marked buy/sell days before ${beforeDate} as complete`);
    } catch (error: any) {
      logger.error('[Database] Error marking buy/sell days complete:', error);
    }
  }

  // ============================================
  // DAILY FEES VOLUME METHODS
  // ============================================

  /**
   * Get the latest date we have fees data for
   */
  async getLatestFeesDate(): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(trading_date) as latest_date FROM daily_fees_volumes WHERE is_complete = true'
      );
      return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest fees date:', error);
      return null;
    }
  }

  /**
   * Upsert daily fees volume records using batched inserts
   * @param records Array of daily fees volume records
   * @param markComplete If true, marks these days as complete (for historical data)
   */
  async upsertDailyFeesVolumes(records: DailyFeesVolumeRecord[], markComplete: boolean = false): Promise<number> {
    if (!this.pool || !this.isConnected || records.length === 0) {
      return 0;
    }

    const BATCH_SIZE = 500;
    let totalUpserted = 0;

    try {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, i + BATCH_SIZE);
          
          const values: any[] = [];
          const valuePlaceholders: string[] = [];
          
          batch.forEach((record, idx) => {
            const offset = idx * 17; // 17 parameters per record
            valuePlaceholders.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, ${markComplete}, CURRENT_TIMESTAMP)`
            );
            values.push(
              record.token,
              record.trading_date,
              record.base_volume,
              record.target_volume,
              record.usdc_fees,
              record.token_fees_usdc,
              record.token_fees,
              record.buy_volume,
              record.sell_volume,
              record.sell_volume_usdc,
              record.cumulative_usdc_fees,
              record.cumulative_token_in_usdc_fees,
              record.cumulative_target_volume,
              record.cumulative_token_volume,
              record.high,
              record.average_price,
              record.low
            );
          });

          const batchSQL = `
            INSERT INTO daily_fees_volumes (token, trading_date, base_volume, target_volume, usdc_fees, token_fees_usdc, token_fees, buy_volume, sell_volume, sell_volume_usdc, cumulative_usdc_fees, cumulative_token_in_usdc_fees, cumulative_target_volume, cumulative_token_volume, high, average_price, low, is_complete, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, trading_date) 
            DO UPDATE SET 
              base_volume = EXCLUDED.base_volume,
              target_volume = EXCLUDED.target_volume,
              usdc_fees = EXCLUDED.usdc_fees,
              token_fees_usdc = EXCLUDED.token_fees_usdc,
              token_fees = EXCLUDED.token_fees,
              buy_volume = EXCLUDED.buy_volume,
              sell_volume = EXCLUDED.sell_volume,
              sell_volume_usdc = EXCLUDED.sell_volume_usdc,
              cumulative_usdc_fees = EXCLUDED.cumulative_usdc_fees,
              cumulative_token_in_usdc_fees = EXCLUDED.cumulative_token_in_usdc_fees,
              cumulative_target_volume = EXCLUDED.cumulative_target_volume,
              cumulative_token_volume = EXCLUDED.cumulative_token_volume,
              high = EXCLUDED.high,
              average_price = EXCLUDED.average_price,
              low = EXCLUDED.low,
              is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE daily_fees_volumes.is_complete END,
              updated_at = CURRENT_TIMESTAMP
          `;

          await client.query(batchSQL, values);
          totalUpserted += batch.length;
          
          if (records.length > BATCH_SIZE) {
            logger.info(`[Database] Fees volume batch progress: ${totalUpserted}/${records.length}`);
          }
        }

        await client.query('COMMIT');
        logger.info(`[Database] Upserted ${totalUpserted} daily fees volume records`);
        return totalUpserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error upserting daily fees volumes:', error);
      return 0;
    }
  }

  /**
   * Get daily fees volumes with date range filtering
   * @param options.token Filter by specific token
   * @param options.startDate Start date (inclusive) in YYYY-MM-DD format
   * @param options.endDate End date (inclusive) in YYYY-MM-DD format
   */
  async getDailyFeesVolumes(options?: {
    token?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<DailyFeesVolumeRecord[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (options?.token) {
        conditions.push(`LOWER(token) = LOWER($${paramIndex})`);
        params.push(options.token);
        paramIndex++;
      }

      if (options?.startDate) {
        conditions.push(`trading_date >= $${paramIndex}`);
        params.push(options.startDate);
        paramIndex++;
      }

      if (options?.endDate) {
        conditions.push(`trading_date <= $${paramIndex}`);
        params.push(options.endDate);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await this.pool.query(
        `SELECT 
          token,
          trading_date::text,
          base_volume::text,
          target_volume::text,
          usdc_fees::text,
          token_fees_usdc::text,
          token_fees::text,
          buy_volume::text,
          sell_volume::text,
          sell_volume_usdc::text,
          cumulative_usdc_fees::text,
          cumulative_token_in_usdc_fees::text,
          cumulative_target_volume::text,
          cumulative_token_volume::text,
          high::text,
          average_price::text,
          low::text
         FROM daily_fees_volumes
         ${whereClause}
         ORDER BY token, trading_date ASC`,
        params
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting daily fees volumes:', error);
      return [];
    }
  }

  /**
   * Mark days as complete (called when day boundary passes)
   */
  async markFeesDaysComplete(beforeDate: string): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `UPDATE daily_fees_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
         WHERE trading_date < $1 AND is_complete = false`,
        [beforeDate]
      );
      logger.info(`[Database] Marked fees days before ${beforeDate} as complete`);
    } catch (error: any) {
      logger.error('[Database] Error marking fees days complete:', error);
    }
  }

  /**
   * Get fees volume record count
   */
  async getFeesRecordCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(*) as count FROM daily_fees_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting fees record count:', error);
      return 0;
    }
  }

  // ============================================
  // METEORA VOLUMES METHODS
  // ============================================

  /**
   * Get the latest complete date from daily_meteora_volumes table
   */
  async getLatestMeteoraDate(): Promise<string | null> {
    if (!this.pool || !this.isConnected) return null;

    try {
      const result = await this.pool.query(
        'SELECT MAX(date) as latest_date FROM daily_meteora_volumes WHERE is_complete = true'
      );
      return result.rows[0]?.latest_date?.toISOString().split('T')[0] || null;
    } catch (error: any) {
      logger.error('[Database] Error getting latest Meteora date:', error);
      return null;
    }
  }

  /**
   * Upsert daily Meteora volume records using batched inserts
   * @param records Array of daily Meteora volume records
   * @param markComplete Whether to mark records as complete
   * @returns Number of records upserted
   */
  async upsertDailyMeteoraVolumes(records: DailyMeteoraVolumeRecord[], markComplete: boolean = false): Promise<number> {
    if (!this.pool || !this.isConnected || records.length === 0) {
      return 0;
    }

    const BATCH_SIZE = 500;
    let totalUpserted = 0;

    try {
      const client = await this.pool.connect();

      try {
        await client.query('BEGIN');

        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, i + BATCH_SIZE);
          
          const values: any[] = [];
          const valuePlaceholders: string[] = [];
          
          batch.forEach((record, idx) => {
            const offset = idx * 15; // 15 parameters per record (14 data fields + is_complete)
            valuePlaceholders.push(
              `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, CURRENT_TIMESTAMP)`
            );
            values.push(
              record.token,
              record.date,
              record.base_volume,
              record.target_volume,
              record.trade_count,
              record.buy_volume,
              record.sell_volume,
              record.usdc_fees,
              record.token_fees,
              record.token_fees_usdc,
              record.token_per_usdc,
              record.average_price,
              record.ownership_share,
              record.earned_fee_usdc,
              markComplete ? true : (record.is_complete ?? false)
            );
          });

          const batchSQL = `
            INSERT INTO daily_meteora_volumes (token, date, base_volume, target_volume, trade_count, buy_volume, sell_volume, usdc_fees, token_fees, token_fees_usdc, token_per_usdc, average_price, ownership_share, earned_fee_usdc, is_complete, updated_at)
            VALUES ${valuePlaceholders.join(', ')}
            ON CONFLICT (token, date) 
            DO UPDATE SET 
              base_volume = EXCLUDED.base_volume,
              target_volume = EXCLUDED.target_volume,
              trade_count = EXCLUDED.trade_count,
              buy_volume = EXCLUDED.buy_volume,
              sell_volume = EXCLUDED.sell_volume,
              usdc_fees = EXCLUDED.usdc_fees,
              token_fees = EXCLUDED.token_fees,
              token_fees_usdc = EXCLUDED.token_fees_usdc,
              token_per_usdc = EXCLUDED.token_per_usdc,
              average_price = EXCLUDED.average_price,
              ownership_share = EXCLUDED.ownership_share,
              earned_fee_usdc = EXCLUDED.earned_fee_usdc,
              is_complete = CASE WHEN EXCLUDED.is_complete THEN true ELSE daily_meteora_volumes.is_complete END,
              updated_at = CURRENT_TIMESTAMP
          `;

          await client.query(batchSQL, values);
          totalUpserted += batch.length;
          
          if (records.length > BATCH_SIZE) {
            logger.info(`[Database] Meteora volume batch progress: ${totalUpserted}/${records.length}`);
          }
        }

        await client.query('COMMIT');
        logger.info(`[Database] Upserted ${totalUpserted} daily Meteora volume records`);
        return totalUpserted;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error upserting daily Meteora volumes:', error);
      return 0;
    }
  }

  /**
   * Mark Meteora volume days as complete before a given date
   */
  async markMeteoraDaysComplete(beforeDate: string): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `UPDATE daily_meteora_volumes SET is_complete = true, updated_at = CURRENT_TIMESTAMP
         WHERE date < $1 AND is_complete = false`,
        [beforeDate]
      );
      logger.info(`[Database] Marked Meteora days before ${beforeDate} as complete`);
    } catch (error: any) {
      logger.error('[Database] Error marking Meteora days complete:', error);
    }
  }

  /**
   * Get count of Meteora volume records
   */
  async getMeteoraRecordCount(): Promise<number> {
    if (!this.pool || !this.isConnected) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(*) as count FROM daily_meteora_volumes');
      return parseInt(result.rows[0]?.count || '0');
    } catch (error: any) {
      logger.error('[Database] Error getting Meteora record count:', error);
      return 0;
    }
  }

  // ============================================
  // METRICS HISTORY METHODS
  // ============================================

  /**
   * Insert a metrics snapshot
   */
  async insertMetric(metricName: string, value: number, labels: Record<string, string> = {}): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `INSERT INTO metrics_history (metric_name, metric_value, labels)
         VALUES ($1, $2, $3)
         ON CONFLICT (timestamp, metric_name, labels) DO UPDATE SET metric_value = $2`,
        [metricName, value, JSON.stringify(labels)]
      );
    } catch (error: any) {
      // Silently ignore metrics insert errors to not affect main operations
      logger.error('[Database] Error inserting metric:', error);
    }
  }

  /**
   * Insert multiple metrics at once
   */
  async insertMetricsBatch(metrics: Array<{ name: string; value: number; labels?: Record<string, string> }>): Promise<void> {
    if (!this.pool || !this.isConnected || metrics.length === 0) return;

    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        
        for (const metric of metrics) {
          await client.query(
            `INSERT INTO metrics_history (metric_name, metric_value, labels)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [metric.name, metric.value, JSON.stringify(metric.labels || {})]
          );
        }
        
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error: any) {
      logger.error('[Database] Error inserting metrics batch:', error);
    }
  }

  /**
   * Insert a service health snapshot
   */
  async insertServiceHealthSnapshot(
    serviceName: string,
    isHealthy: boolean,
    lastRefreshTime?: Date,
    recordCount?: number,
    errorMessage?: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    if (!this.pool || !this.isConnected) return;

    try {
      await this.pool.query(
        `INSERT INTO service_health_snapshots 
         (service_name, is_healthy, last_refresh_time, record_count, error_message, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          serviceName,
          isHealthy,
          lastRefreshTime || null,
          recordCount || null,
          errorMessage || null,
          JSON.stringify(metadata || {})
        ]
      );
    } catch (error: any) {
      logger.error('[Database] Error inserting service health snapshot:', error);
    }
  }

  /**
   * Get recent metrics for a specific metric name
   */
  async getRecentMetrics(
    metricName: string,
    hours: number = 24,
    labels?: Record<string, string>
  ): Promise<Array<{ timestamp: string; value: number; labels: Record<string, string> }>> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      
      let query = `
        SELECT timestamp::text, metric_value::numeric as value, labels
        FROM metrics_history
        WHERE metric_name = $1 AND timestamp >= $2
      `;
      const params: any[] = [metricName, cutoff];

      if (labels && Object.keys(labels).length > 0) {
        query += ' AND labels @> $3';
        params.push(JSON.stringify(labels));
      }

      query += ' ORDER BY timestamp DESC LIMIT 1000';

      const result = await this.pool.query(query, params);
      return result.rows.map(row => ({
        timestamp: row.timestamp,
        value: parseFloat(row.value),
        labels: row.labels,
      }));
    } catch (error: any) {
      logger.error('[Database] Error getting recent metrics:', error);
      return [];
    }
  }

  /**
   * Get service health history
   */
  async getServiceHealthHistory(
    serviceName?: string,
    hours: number = 24
  ): Promise<Array<{
    timestamp: string;
    service_name: string;
    is_healthy: boolean;
    last_refresh_time: string | null;
    record_count: number | null;
    error_message: string | null;
    metadata: Record<string, any>;
  }>> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      
      let query = `
        SELECT 
          timestamp::text,
          service_name,
          is_healthy,
          last_refresh_time::text,
          record_count,
          error_message,
          metadata
        FROM service_health_snapshots
        WHERE timestamp >= $1
      `;
      const params: any[] = [cutoff];

      if (serviceName) {
        query += ' AND service_name = $2';
        params.push(serviceName);
      }

      query += ' ORDER BY timestamp DESC LIMIT 1000';

      const result = await this.pool.query(query, params);
      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting service health history:', error);
      return [];
    }
  }

  /**
   * Prune old metrics data (keep last N days)
   */
  async pruneOldMetrics(keepDays: number = 30): Promise<{ metricsDeleted: number; healthDeleted: number }> {
    if (!this.pool || !this.isConnected) return { metricsDeleted: 0, healthDeleted: 0 };

    try {
      const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
      
      const metricsResult = await this.pool.query(
        'DELETE FROM metrics_history WHERE timestamp < $1 RETURNING id',
        [cutoff]
      );
      
      const healthResult = await this.pool.query(
        'DELETE FROM service_health_snapshots WHERE timestamp < $1 RETURNING id',
        [cutoff]
      );

      const metricsDeleted = metricsResult.rowCount || 0;
      const healthDeleted = healthResult.rowCount || 0;

      if (metricsDeleted > 0 || healthDeleted > 0) {
        logger.info(`[Database] Pruned ${metricsDeleted} metrics and ${healthDeleted} health snapshots older than ${keepDays} days`);
      }

      return { metricsDeleted, healthDeleted };
    } catch (error: any) {
      logger.error('[Database] Error pruning old metrics:', error);
      return { metricsDeleted: 0, healthDeleted: 0 };
    }
  }

  /**
   * Get daily trading activity from the v06_fee_volume_daily_aggregate table.
   * Returns spot + conditional breakdown with a has_conditional_volume flag per row.
   */
  async getDailyTradingActivity(options?: {
    token?: string;
    tokens?: string[];
    startDate?: string;
    endDate?: string;
  }): Promise<{
    token: string;
    date: string;
    has_conditional_volume: boolean;
    spot_buy_volume: string;
    spot_sell_volume: string;
    spot_base_volume: string;
    spot_target_volume: string;
    spot_trade_count: number;
    spot_usdc_fees: string;
    spot_token_fees: string;
    spot_token_fees_usdc: string;
    conditional_buy_volume: string | null;
    conditional_sell_volume: string | null;
    conditional_base_volume: string | null;
    conditional_target_volume: string | null;
    conditional_trade_count: number | null;
    conditional_usdc_fees: string | null;
    conditional_token_fees: string | null;
    conditional_token_fees_usdc: string | null;
    total_buy_volume: string;
    total_sell_volume: string;
    total_base_volume: string;
    total_target_volume: string;
    total_trade_count: number;
    total_usdc_fees: string;
    total_token_fees: string;
    total_token_fees_usdc: string;
    conditional_reconciled: boolean;
    pending_open_proposals: number;
  }[]> {
    if (!this.pool || !this.isConnected) return [];

    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      if (options?.tokens && options.tokens.length > 0) {
        const placeholders = options.tokens.map((_, i) => `LOWER($${paramIndex + i})`).join(', ');
        conditions.push(`LOWER(token) IN (${placeholders})`);
        params.push(...options.tokens);
        paramIndex += options.tokens.length;
      } else if (options?.token) {
        conditions.push(`LOWER(token) = LOWER($${paramIndex})`);
        params.push(options.token);
        paramIndex++;
      }

      if (options?.startDate) {
        conditions.push(`date >= $${paramIndex}`);
        params.push(options.startDate);
        paramIndex++;
      }

      if (options?.endDate) {
        conditions.push(`date <= $${paramIndex}`);
        params.push(options.endDate);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await this.pool.query(
        `SELECT
          token,
          date::text,
          (conditional_buy_volume IS NOT NULL) AS has_conditional_volume,
          (spot_buy_volume / 1e6)::text AS spot_buy_volume,
          (spot_sell_volume / 1e6)::text AS spot_sell_volume,
          (spot_base_volume / 1e6)::text AS spot_base_volume,
          (spot_target_volume / 1e6)::text AS spot_target_volume,
          spot_trade_count,
          (spot_usdc_fees / 1e6)::text AS spot_usdc_fees,
          (spot_token_fees / 1e6)::text AS spot_token_fees,
          (spot_token_fees_usdc / 1e6)::text AS spot_token_fees_usdc,
          (conditional_buy_volume / 1e6)::text AS conditional_buy_volume,
          (conditional_sell_volume / 1e6)::text AS conditional_sell_volume,
          (conditional_base_volume / 1e6)::text AS conditional_base_volume,
          (conditional_target_volume / 1e6)::text AS conditional_target_volume,
          conditional_trade_count,
          (conditional_usdc_fees / 1e6)::text AS conditional_usdc_fees,
          (conditional_token_fees / 1e6)::text AS conditional_token_fees,
          (conditional_token_fees_usdc / 1e6)::text AS conditional_token_fees_usdc,
          (total_buy_volume / 1e6)::text AS total_buy_volume,
          (total_sell_volume / 1e6)::text AS total_sell_volume,
          (total_base_volume / 1e6)::text AS total_base_volume,
          (total_target_volume / 1e6)::text AS total_target_volume,
          total_trade_count,
          (total_usdc_fees / 1e6)::text AS total_usdc_fees,
          (total_token_fees / 1e6)::text AS total_token_fees,
          (total_token_fees_usdc / 1e6)::text AS total_token_fees_usdc,
          conditional_reconciled,
          pending_open_proposals
         FROM v06_fee_volume_daily_aggregate
         ${whereClause}
         ORDER BY token, date ASC`,
        params
      );

      return result.rows;
    } catch (error: any) {
      logger.error('[Database] Error getting daily trading activity:', error);
      return [];
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.pool) {
      this.isConnected = false;
      await this.pool.end();
      this.pool = null;
      logger.info('[Database] Connection closed');
    }
  }
}

