import { logger } from '../../../../utils/logger.js';
import type { DbRuntime } from '../dbRuntime.js';

export function createMetricsRepo(db: DbRuntime) {
  return {
    /**
     * Insert a metrics snapshot
     */
    async insertMetric(metricName: string, value: number, labels: Record<string, string> = {}): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
          `INSERT INTO metrics_history (metric_name, metric_value, labels)
         VALUES ($1, $2, $3)
         ON CONFLICT (timestamp, metric_name, labels) DO UPDATE SET metric_value = $2`,
          [metricName, value, JSON.stringify(labels)]
        );
      } catch (error: any) {
        // Silently ignore metrics insert errors to not affect main operations
        logger.error('[Database] Error inserting metric:', error);
      }
    },

    /**
     * Insert multiple metrics at once
     */
    async insertMetricsBatch(metrics: Array<{ name: string; value: number; labels?: Record<string, string> }>): Promise<void> {
      const pool = db.getPool();
      if (!pool || !db.isConnected() || metrics.length === 0) return;

      try {
        const client = await pool.connect();
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
    },

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
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return;

      try {
        await pool.query(
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
    },

    /**
     * Get recent metrics for a specific metric name
     */
    async getRecentMetrics(
      metricName: string,
      hours: number = 24,
      labels?: Record<string, string>
    ): Promise<Array<{ timestamp: string; value: number; labels: Record<string, string> }>> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

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

        const result = await pool.query(query, params);
        return result.rows.map(row => ({
          timestamp: row.timestamp,
          value: parseFloat(row.value),
          labels: row.labels,
        }));
      } catch (error: any) {
        logger.error('[Database] Error getting recent metrics:', error);
        return [];
      }
    },

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
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return [];

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

        const result = await pool.query(query, params);
        return result.rows;
      } catch (error: any) {
        logger.error('[Database] Error getting service health history:', error);
        return [];
      }
    },

    /**
     * Prune old metrics data (keep last N days)
     */
    async pruneOldMetrics(keepDays: number = 30): Promise<{ metricsDeleted: number; healthDeleted: number }> {
      const pool = db.getPool();
      if (!pool || !db.isConnected()) return { metricsDeleted: 0, healthDeleted: 0 };

      try {
        const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();

        const metricsResult = await pool.query(
          'DELETE FROM metrics_history WHERE timestamp < $1 RETURNING id',
          [cutoff]
        );

        const healthResult = await pool.query(
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
    },
  };
}

export type MetricsRepo = ReturnType<typeof createMetricsRepo>;
