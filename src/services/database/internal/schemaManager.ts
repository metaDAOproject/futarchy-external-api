import { logger } from '../../../utils/logger.js';
import type { DbRuntime } from './dbRuntime.js';

export function createSchemaManager(db: DbRuntime) {
  const manager = {
    async createTables(): Promise<void> {
      const pool = db.getPool();
      if (!pool) return;

      const createTableSQL = `
      -- Metadata table to track sync status
      CREATE TABLE IF NOT EXISTS sync_metadata (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

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

      await pool.query(createTableSQL);
      logger.info('[Database] Tables created/verified');

      // Create v0.6 OHLCV + fee volume tables
      await manager.createV06Tables();
    },

    async createV06Tables(): Promise<void> {
      const pool = db.getPool();
      if (!pool) return;

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
      CREATE INDEX IF NOT EXISTS idx_v06_fee_spot_date ON v06_fee_volume_daily_spot(date DESC);

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
      CREATE INDEX IF NOT EXISTS idx_v06_fee_cond_date ON v06_fee_volume_daily_conditional(date DESC);

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
      CREATE INDEX IF NOT EXISTS idx_v06_fee_agg_date ON v06_fee_volume_daily_aggregate(date DESC);
    `;

      await pool.query(sql);
      logger.info('[Database] v0.6 tables created/verified');
    },
  };

  return manager;
}

export type SchemaManager = ReturnType<typeof createSchemaManager>;
