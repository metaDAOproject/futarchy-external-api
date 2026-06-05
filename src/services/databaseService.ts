import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';
import type { DbRuntime } from './database/internal/dbRuntime.js';
import { createSchemaManager } from './database/internal/schemaManager.js';
import { createDailyVolumesRepo } from './database/internal/repos/dailyVolumesRepo.js';
import { createMetricsRepo } from './database/internal/repos/metricsRepo.js';
import { createV06TradingActivityRepo } from './database/internal/repos/v06TradingActivityRepo.js';

// Force pg to serialize Date parameters as ISO-8601 UTC strings so PostgreSQL
// doesn't receive un-parseable local-timezone names like "GMT-0700".
pg.defaults.parseInputDatesAsUTC = true;

const { Pool } = pg;

export interface Rolling24hMetrics {
  token: string;
  base_volume_24h: string;
  target_volume_24h: string;
  high_24h: string;
  low_24h: string;
  trade_count_24h: number;
}

export interface DatabaseInitializeOptions {
  ensureSchema?: boolean;
}

export class DatabaseService {
  public pool: pg.Pool | null = null;
  private isConnected: boolean = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private consecutiveFailures: number = 0;
  private static readonly HEALTH_CHECK_INTERVAL_MS = 30_000;
  private static readonly MAX_FAILURES_BEFORE_RECONNECT = 3;

  private dbRuntime: DbRuntime = {
    getPool: () => this.pool,
    isConnected: () => this.isConnected,
  };

  private _schema = createSchemaManager(this.dbRuntime);
  private _dailyVolumes = createDailyVolumesRepo(this.dbRuntime);
  private _metrics = createMetricsRepo(this.dbRuntime);
  private _v06TradingActivity = createV06TradingActivityRepo(this.dbRuntime);

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
   * Initialize the database connection.
   */
  async initialize(options: DatabaseInitializeOptions = {}): Promise<boolean> {
    const { ensureSchema = true } = options;

    if (!this.pool) {
      logger.info('[Database] No database configuration provided, volume history will use in-memory cache only');
      return false;
    }

    try {
      // Test connection
      const client = await this.pool.connect();
      logger.info('[Database] Connected to PostgreSQL');
      client.release();

      if (ensureSchema) {
        await this._schema.createTables();
      }
      
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
   * Check if database is available
   */
  isAvailable(): boolean {
    return this.isConnected && this.pool !== null;
  }

  /**
   * Close database connection
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

  // ============================================
  // Daily volumes (delegated to DailyVolumesRepo)
  // ============================================

  async getV06Rolling24hMetrics(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
    return this._dailyVolumes.getV06Rolling24hMetrics(tokens);
  }

  // ============================================
  // Metrics (delegated to MetricsRepo)
  // ============================================

  async insertMetric(metricName: string, value: number, labels: Record<string, string> = {}): Promise<void> {
    return this._metrics.insertMetric(metricName, value, labels);
  }

  async insertMetricsBatch(metrics: Array<{ name: string; value: number; labels?: Record<string, string> }>): Promise<void> {
    return this._metrics.insertMetricsBatch(metrics);
  }

  async insertServiceHealthSnapshot(
    serviceName: string,
    isHealthy: boolean,
    lastRefreshTime?: Date,
    recordCount?: number,
    errorMessage?: string,
    metadata?: Record<string, any>
  ): Promise<void> {
    return this._metrics.insertServiceHealthSnapshot(serviceName, isHealthy, lastRefreshTime, recordCount, errorMessage, metadata);
  }

  async getRecentMetrics(
    metricName: string,
    hours: number = 24,
    labels?: Record<string, string>
  ): Promise<Array<{ timestamp: string; value: number; labels: Record<string, string> }>> {
    return this._metrics.getRecentMetrics(metricName, hours, labels);
  }

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
    return this._metrics.getServiceHealthHistory(serviceName, hours);
  }

  async pruneOldMetrics(keepDays: number = 30): Promise<{ metricsDeleted: number; healthDeleted: number }> {
    return this._metrics.pruneOldMetrics(keepDays);
  }

  // ============================================
  // V06 Trading Activity (delegated to V06TradingActivityRepo)
  // ============================================

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
    return this._v06TradingActivity.getDailyTradingActivity(options);
  }
}
