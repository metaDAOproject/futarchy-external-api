import { logger } from '../../../utils/logger.js';
import type { DbRuntime } from './dbRuntime.js';

export function createSchemaManager(db: DbRuntime) {
  const manager = {
    async createTables(): Promise<void> {
      const pool = db.getPool();
      if (!pool) return;

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

      // Run migration to add new columns to existing tables
      await manager.migrateTables();
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

    async migrateTables(): Promise<void> {
      const pool = db.getPool();
      if (!pool) return;

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

        await pool.query(migrationSQL);
        logger.info('[Database] Migration completed - extended columns added if needed');
      } catch (error: any) {
        // Migration errors are non-fatal - tables might already have columns
        logger.info('[Database] Migration check completed (columns may already exist)');
      }
    },

    async createAggregationFunctions(): Promise<void> {
      const pool = db.getPool();
      if (!pool) return;

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

        await pool.query(functionsSQL);
        logger.info('[Database] Aggregation functions created/updated');
      } catch (error: any) {
        logger.error('[Database] Error creating aggregation functions:', error);
        throw error;
      }
    },
  };

  return manager;
}

export type SchemaManager = ReturnType<typeof createSchemaManager>;
