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

  async initialize(): Promise<boolean> {
    if (!config.externalDatabase.connectionString) {
      logger.info('[ExternalDB] No EXTERNAL_DATABASE_URL configured — v0.6 reconciliation disabled');
      return false;
    }

    try {
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

      const client = await this.pool.connect();
      client.release();
      this.isConnected = true;
      logger.info('[ExternalDB] Connected to external indexer database (read-only)');
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

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      logger.info('[ExternalDB] Connection closed');
    }
  }
}
