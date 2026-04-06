import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';
import type { DbRuntime } from './database/internal/dbRuntime.js';
import { createSchemaManager } from './database/internal/schemaManager.js';
import { createDailyVolumesRepo } from './database/internal/repos/dailyVolumesRepo.js';
import { createIntervalVolumesRepo } from './database/internal/repos/intervalVolumesRepo.js';
import { createDailyBuySellVolumesRepo } from './database/internal/repos/dailyBuySellVolumesRepo.js';
import { createDailyFeesVolumesRepo } from './database/internal/repos/dailyFeesVolumesRepo.js';
import { createDailyMeteoraVolumesRepo } from './database/internal/repos/dailyMeteoraVolumesRepo.js';
import { createMetricsRepo } from './database/internal/repos/metricsRepo.js';
import { createV06TradingActivityRepo } from './database/internal/repos/v06TradingActivityRepo.js';

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

  private dbRuntime: DbRuntime = {
    getPool: () => this.pool,
    isConnected: () => this.isConnected,
  };

  private _schema = createSchemaManager(this.dbRuntime);
  private _dailyVolumes = createDailyVolumesRepo(this.dbRuntime);
  private _intervalVolumes = createIntervalVolumesRepo(this.dbRuntime);
  private _dailyBuySellVolumes = createDailyBuySellVolumesRepo(this.dbRuntime);
  private _dailyFeesVolumes = createDailyFeesVolumesRepo(this.dbRuntime);
  private _dailyMeteoraVolumes = createDailyMeteoraVolumesRepo(this.dbRuntime);
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
      await this._schema.createTables();
      
      // Create aggregation functions
      await this._schema.createAggregationFunctions();
      
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
  // Schema management (delegated to SchemaManager)
  // ============================================

  async createAggregationFunctions(): Promise<void> {
    return this._schema.createAggregationFunctions();
  }

  // ============================================
  // Daily volumes (delegated to DailyVolumesRepo)
  // ============================================

  async getLatestDate(): Promise<string | null> {
    return this._dailyVolumes.getLatestDate();
  }

  async getLatestDateForToken(token: string): Promise<string | null> {
    return this._dailyVolumes.getLatestDateForToken(token);
  }

  async upsertDailyVolumes(records: DailyVolumeRecord[]): Promise<number> {
    return this._dailyVolumes.upsertDailyVolumes(records);
  }

  async getDailyVolumesForToken(token: string): Promise<DailyVolumeRecord[]> {
    return this._dailyVolumes.getDailyVolumesForToken(token);
  }

  async getDailyVolumesForTokens(tokens: string[]): Promise<Map<string, DailyVolumeRecord[]>> {
    return this._dailyVolumes.getDailyVolumesForTokens(tokens);
  }

  async getAggregatedVolumes(tokens?: string[]): Promise<TokenVolumeAggregate[]> {
    return this._dailyVolumes.getAggregatedVolumes(tokens);
  }

  async get24hVolumes(tokens?: string[]): Promise<Map<string, { base_volume: string; target_volume: string; high: string; low: string }>> {
    return this._dailyVolumes.get24hVolumes(tokens);
  }

  async getRecordCount(): Promise<number> {
    return this._dailyVolumes.getDailyRecordCount();
  }

  async getDailyRecordCount(): Promise<number> {
    return this._dailyVolumes.getDailyRecordCount();
  }

  async getTokenCount(): Promise<number> {
    return this._dailyVolumes.getTokenCount();
  }

  async getV06Rolling24hMetrics(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
    return this._dailyVolumes.getV06Rolling24hMetrics(tokens);
  }

  // ============================================
  // Interval volumes (delegated to IntervalVolumesRepo)
  // ============================================

  async setSyncMetadata(key: string, value: string): Promise<void> {
    return this._intervalVolumes.setSyncMetadata(key, value);
  }

  async getSyncMetadata(key: string): Promise<string | null> {
    return this._intervalVolumes.getSyncMetadata(key);
  }

  async getLatestHour(): Promise<string | null> {
    return this._intervalVolumes.getLatestHour();
  }

  async getLatestCompleteHour(): Promise<string | null> {
    return this._intervalVolumes.getLatestCompleteHour();
  }

  async upsertHourlyVolumes(records: HourlyVolumeRecord[], markComplete: boolean = false): Promise<number> {
    return this._intervalVolumes.upsertHourlyVolumes(records, markComplete);
  }

  async markHoursComplete(beforeHour: string): Promise<void> {
    return this._intervalVolumes.markHoursComplete(beforeHour);
  }

  async getRolling24hMetrics(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
    return this._intervalVolumes.getRolling24hMetrics(tokens);
  }

  async getHourlyVolumes(startHour: string, endHour?: string, tokens?: string[]): Promise<HourlyVolumeRecord[]> {
    return this._intervalVolumes.getHourlyVolumes(startHour, endHour, tokens);
  }

  async getHourlyRecordCount(): Promise<number> {
    return this._intervalVolumes.getHourlyRecordCount();
  }

  async getHourlyTokenCount(): Promise<number> {
    return this._intervalVolumes.getHourlyTokenCount();
  }

  async pruneOldHourlyData(keepHours: number = 48): Promise<number> {
    return this._intervalVolumes.pruneOldHourlyData(keepHours);
  }

  async upsertTenMinuteVolumes(records: TenMinuteVolumeRecord[], markComplete: boolean = false): Promise<number> {
    return this._intervalVolumes.upsertTenMinuteVolumes(records, markComplete);
  }

  async markTenMinuteBucketsComplete(beforeBucket: string): Promise<void> {
    return this._intervalVolumes.markTenMinuteBucketsComplete(beforeBucket);
  }

  async backfillMissingFields(): Promise<{
    tenMinuteUpdated: number;
    hourlyUpdated: number;
    dailyUpdated: number;
  }> {
    return this._intervalVolumes.backfillMissingFields();
  }

  async getRolling24hFromTenMinute(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
    return this._intervalVolumes.getRolling24hFromTenMinute(tokens);
  }

  async aggregate10MinToHourly(token?: string, hour?: string): Promise<number> {
    return this._intervalVolumes.aggregate10MinToHourly(token, hour);
  }

  async aggregateHourlyToDaily(token?: string, date?: string): Promise<number> {
    return this._intervalVolumes.aggregateHourlyToDaily(token, date);
  }

  async getLatestTenMinuteBucket(): Promise<string | null> {
    return this._intervalVolumes.getLatestTenMinuteBucket();
  }

  async getTenMinuteRecordCount(): Promise<number> {
    return this._intervalVolumes.getTenMinuteRecordCount();
  }

  async pruneOldTenMinuteData(keepHours: number = 25): Promise<number> {
    return this._intervalVolumes.pruneOldTenMinuteData(keepHours);
  }

  // ============================================
  // Daily buy/sell volumes (delegated to DailyBuySellVolumesRepo)
  // ============================================

  async getLatestBuySellDate(): Promise<string | null> {
    return this._dailyBuySellVolumes.getLatestBuySellDate();
  }

  async upsertDailyBuySellVolumes(records: DailyBuySellVolumeRecord[], markComplete: boolean = false): Promise<number> {
    return this._dailyBuySellVolumes.upsertDailyBuySellVolumes(records, markComplete);
  }

  async getDailyBuySellVolumesWithCumulative(token?: string): Promise<CumulativeVolumeData[]> {
    return this._dailyBuySellVolumes.getDailyBuySellVolumesWithCumulative(token);
  }

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
    return this._dailyBuySellVolumes.getDailyBuySellVolumes(options);
  }

  async getBuySellAggregates(tokens?: string[]): Promise<Map<string, {
    total_buy_usdc: string;
    total_sell_token: string;
    total_base_volume: string;
    total_target_volume: string;
    first_date: string;
    last_date: string;
    trading_days: number;
  }>> {
    return this._dailyBuySellVolumes.getBuySellAggregates(tokens);
  }

  async getFirstTradeDates(): Promise<Map<string, string>> {
    return this._dailyBuySellVolumes.getFirstTradeDates();
  }

  async getBuySellRecordCount(): Promise<number> {
    return this._dailyBuySellVolumes.getBuySellRecordCount();
  }

  async markBuySellDaysComplete(beforeDate: string): Promise<void> {
    return this._dailyBuySellVolumes.markBuySellDaysComplete(beforeDate);
  }

  // ============================================
  // Daily fees volumes (delegated to DailyFeesVolumesRepo)
  // ============================================

  async getLatestFeesDate(): Promise<string | null> {
    return this._dailyFeesVolumes.getLatestFeesDate();
  }

  async upsertDailyFeesVolumes(records: DailyFeesVolumeRecord[], markComplete: boolean = false): Promise<number> {
    return this._dailyFeesVolumes.upsertDailyFeesVolumes(records, markComplete);
  }

  async getDailyFeesVolumes(options?: {
    token?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<DailyFeesVolumeRecord[]> {
    return this._dailyFeesVolumes.getDailyFeesVolumes(options);
  }

  async markFeesDaysComplete(beforeDate: string): Promise<void> {
    return this._dailyFeesVolumes.markFeesDaysComplete(beforeDate);
  }

  async getFeesRecordCount(): Promise<number> {
    return this._dailyFeesVolumes.getFeesRecordCount();
  }

  // ============================================
  // Daily Meteora volumes (delegated to DailyMeteoraVolumesRepo)
  // ============================================

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
    return this._dailyMeteoraVolumes.getDailyMeteoraVolumes(options);
  }

  async getLatestMeteoraDate(): Promise<string | null> {
    return this._dailyMeteoraVolumes.getLatestMeteoraDate();
  }

  async upsertDailyMeteoraVolumes(records: DailyMeteoraVolumeRecord[], markComplete: boolean = false): Promise<number> {
    return this._dailyMeteoraVolumes.upsertDailyMeteoraVolumes(records, markComplete);
  }

  async markMeteoraDaysComplete(beforeDate: string): Promise<void> {
    return this._dailyMeteoraVolumes.markMeteoraDaysComplete(beforeDate);
  }

  async getMeteoraRecordCount(): Promise<number> {
    return this._dailyMeteoraVolumes.getMeteoraRecordCount();
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
