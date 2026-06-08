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
    },
  };

  return manager;
}

export type SchemaManager = ReturnType<typeof createSchemaManager>;
