import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// Force pg to serialize Date parameters as ISO-8601 UTC strings so PostgreSQL
// doesn't receive un-parseable local-timezone names like "GMT-0700".
pg.defaults.parseInputDatesAsUTC = true;

const { Pool } = pg;

/**
 * Read-only connection pool to the external indexer database.
 * Used by v0.6 reconciliation to query v0_6_spot_swaps,
 * v0_6_conditional_swaps, v0_6_daos, and v0_6_proposals.
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
   * Earliest unix_timestamp (seconds) that the v0.6 reconciliation pipeline can import:
   * spot swaps joined to DAOs, and conditional swaps joined through proposals to DAOs.
   * Used by backfill scripts to start from true historical beginning instead of a fixed date.
   */
  async getEarliestReconcilableSwapUnixTimestamp(): Promise<number | null> {
    const result = await this.query(`
      SELECT MIN(ts) AS min_ts
      FROM (
        SELECT s.unix_timestamp AS ts
        FROM v0_6_spot_swaps s
        INNER JOIN v0_6_daos d ON d.dao_addr = s.dao_addr
        UNION ALL
        SELECT c.unix_timestamp AS ts
        FROM v0_6_conditional_swaps c
        INNER JOIN v0_6_proposals p ON p.proposal_addr = c.proposal_addr
        INNER JOIN v0_6_daos d ON d.dao_addr = p.dao_addr
      ) u
    `);
    const raw = result.rows[0]?.min_ts;
    if (raw === null || raw === undefined) return null;
    const n = typeof raw === 'string' ? parseInt(raw, 10) : Math.trunc(Number(raw));
    return Number.isFinite(n) ? n : null;
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
