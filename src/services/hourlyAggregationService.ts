import { DatabaseService, HourlyVolumeRecord, Rolling24hMetrics } from './databaseService.js';
import { DuneService } from './duneService.js';
import { FutarchyService } from './futarchyService.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// The timestamp when Futarchy trading data begins
const FUTARCHY_START_TIME = '2025-10-09 00:00:00';

export interface HourlyAggregationStatus {
  isInitialized: boolean;
  databaseConnected: boolean;
  latestHour: string | null;
  latestCompleteHour: string | null;
  tokenCount: number;
  recordCount: number;
  lastRefreshTime: Date | null;
  isRefreshing: boolean;
  hourlyQueryId: number | null;
  schedule: {
    hourlyRefresh: string;  // ":01 past each hour"
    tenMinRefresh: string;  // "every 10 minutes"
    queriesPerDay: number;  // 24 + 144 = 168
  };
}

export class HourlyAggregationService {
  private databaseService: DatabaseService;
  private duneService: DuneService;
  private futarchyService: FutarchyService;
  private _isInitialized: boolean = false;
  private isRefreshing: boolean = false;
  private lastRefreshTime: Date | null = null;
  
  // Scheduled timers
  private hourlyTimer: ReturnType<typeof setTimeout> | null = null;
  private tenMinTimer: ReturnType<typeof setTimeout> | null = null;

  // In-memory cache for when DB is unavailable
  private inMemoryHourlyCache: Map<string, HourlyVolumeRecord[]> = new Map();

  constructor(databaseService: DatabaseService, duneService: DuneService, futarchyService: FutarchyService) {
    this.databaseService = databaseService;
    this.duneService = duneService;
    this.futarchyService = futarchyService;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  isDatabaseConnected(): boolean {
    return this.databaseService.isAvailable();
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    logger.info('[HourlyAggregation] Initializing service...');

    if (this.databaseService.isAvailable()) {
      const recordCount = await this.databaseService.getHourlyRecordCount();
      const latestHour = await this.databaseService.getLatestHour();

      if (recordCount > 0) {
        logger.info(`[HourlyAggregation] Found ${recordCount} existing hourly records, latest: ${latestHour}`);
      } else {
        logger.info('[HourlyAggregation] No existing hourly data, will backfill on first refresh');
      }
    } else {
      logger.info('[HourlyAggregation] Database not available, will use in-memory cache');
    }

    this._isInitialized = true;
    logger.info('[HourlyAggregation] Service initialized');
  }

  /**
   * Start the scheduled refresh jobs
   * - Hourly: runs at :01 past each hour (fetches complete hours)
   * - 10-min: runs at :00, :10, :20, :30, :40, :50 (fetches current incomplete hour)
   */
  async start(): Promise<void> {
    if (!this._isInitialized) {
      await this.initialize();
    }

    if (this.databaseService.isAvailable()) {
      const recordCount = await this.databaseService.getHourlyRecordCount();
      if (recordCount > 0) {
        logger.info(`[HourlyAggregation] Ready to serve ${recordCount} cached hourly records`);
      }
    }

    logger.info('[HourlyAggregation] Starting scheduled refresh jobs...');
    logger.info('[HourlyAggregation] - Hourly refresh: :01 past each hour (24 queries/day)');
    logger.info('[HourlyAggregation] - 10-min refresh: every 10 minutes (144 queries/day)');

    this.scheduleHourlyRefresh();
    this.scheduleTenMinRefresh();

    logger.info('[HourlyAggregation] Scheduled refresh jobs started');

    logger.info('[HourlyAggregation] Starting background refresh...');
    this.refresh().catch(err => {
      logger.error('[HourlyAggregation] Background refresh failed', err);
    });
  }

  /**
   * Schedule the next hourly refresh at :01 past the hour
   */
  private scheduleHourlyRefresh(): void {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1);
    nextHour.setMinutes(1, 0, 0); // :01:00

    // If we're past :01, schedule for next hour
    if (now.getMinutes() >= 1) {
      // Already past :01, next run is in the calculated time
    } else {
      // Before :01, run at :01 this hour
      nextHour.setHours(now.getHours());
    }

    const msUntilNext = nextHour.getTime() - now.getTime();
    logger.info(`[HourlyAggregation] Next hourly refresh at ${nextHour.toISOString()} (in ${Math.round(msUntilNext / 1000)}s)`);

    this.hourlyTimer = setTimeout(async () => {
      await this.refreshCompleteHours();
      this.scheduleHourlyRefresh(); // Schedule next
    }, msUntilNext);
  }

  /**
   * Schedule the next 10-minute refresh at the next 10-minute mark
   */
  private scheduleTenMinRefresh(): void {
    const now = new Date();
    const currentMinute = now.getMinutes();
    const nextTenMin = Math.ceil((currentMinute + 1) / 10) * 10;
    
    const nextRun = new Date(now);
    if (nextTenMin >= 60) {
      nextRun.setHours(nextRun.getHours() + 1);
      nextRun.setMinutes(0, 30, 0); // :00:30 of next hour (30 sec buffer)
    } else {
      nextRun.setMinutes(nextTenMin, 30, 0); // 30 sec buffer after the mark
    }

    const msUntilNext = nextRun.getTime() - now.getTime();
    logger.info(`[HourlyAggregation] Next 10-min refresh at ${nextRun.toISOString()} (in ${Math.round(msUntilNext / 1000)}s)`);

    this.tenMinTimer = setTimeout(async () => {
      await this.refreshCurrentHour();
      this.scheduleTenMinRefresh(); // Schedule next
    }, msUntilNext);
  }

  /**
   * Stop the scheduled refresh jobs
   */
  stop(): void {
    if (this.hourlyTimer) {
      clearTimeout(this.hourlyTimer);
      this.hourlyTimer = null;
    }
    if (this.tenMinTimer) {
      clearTimeout(this.tenMinTimer);
      this.tenMinTimer = null;
    }
    logger.info('[HourlyAggregation] Scheduled refresh jobs stopped');
  }

  /**
   * Refresh only complete hours (called at :01 past each hour)
   * Aggregates from 10-minute data using database function
   */
  private async refreshCompleteHours(): Promise<void> {
    if (this.isRefreshing) {
      logger.info('[HourlyAggregation] Refresh already in progress, skipping hourly refresh');
      return;
    }

    this.isRefreshing = true;
    logger.info('[HourlyAggregation] Hourly refresh - aggregating last complete hour from 10-min data...');

    try {
      if (!this.databaseService.isAvailable()) {
        logger.info('[HourlyAggregation] Database not available, skipping aggregation');
        return;
      }

      const lastCompleteHour = new Date();
      lastCompleteHour.setMinutes(0, 0, 0);
      lastCompleteHour.setHours(lastCompleteHour.getHours() - 1);
      const hourISO = lastCompleteHour.toISOString();

      const recordsAggregated = await this.databaseService.aggregate10MinToHourly(undefined, hourISO);

      if (recordsAggregated > 0) {
        logger.info(`[HourlyAggregation] Hourly refresh complete - aggregated ${recordsAggregated} hourly records from 10-min data`);
      } else {
        logger.info('[HourlyAggregation] No 10-minute data available for aggregation');
      }

      this.lastRefreshTime = new Date();
    } catch (error: any) {
      logger.error('[HourlyAggregation] Error in hourly refresh', error);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Refresh only the current incomplete hour (called every 10 minutes)
   * Aggregates from 10-minute data using database function
   */
  private async refreshCurrentHour(): Promise<void> {
    if (this.isRefreshing) {
      logger.info('[HourlyAggregation] Refresh already in progress, skipping 10-min refresh');
      return;
    }

    this.isRefreshing = true;
    logger.info('[HourlyAggregation] 10-min refresh - aggregating current hour from 10-min data...');

    try {
      if (!this.databaseService.isAvailable()) {
        logger.info('[HourlyAggregation] Database not available, skipping aggregation');
        return;
      }

      const currentHourStart = new Date();
      currentHourStart.setMinutes(0, 0, 0);
      const hourISO = currentHourStart.toISOString();

      const recordsAggregated = await this.databaseService.aggregate10MinToHourly(undefined, hourISO);

      if (recordsAggregated > 0) {
        await this.databaseService.pool?.query(
          `UPDATE hourly_volumes SET is_complete = false WHERE hour = $1`,
          [hourISO]
        );
        logger.info(`[HourlyAggregation] 10-min refresh complete - aggregated ${recordsAggregated} hourly records (incomplete)`);
      } else {
        logger.info('[HourlyAggregation] No 10-minute data available for current hour aggregation');
      }

      this.lastRefreshTime = new Date();
    } catch (error: any) {
      logger.error('[HourlyAggregation] Error in 10-min refresh', error);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Full refresh / backfill hourly data by aggregating from 10-minute data
   * Used for:
   * - Initial backfill when no data exists
   * - Manual force refresh
   * Strategy:
   * - Aggregates all incomplete hours from 10-minute data
   */
  async refresh(): Promise<void> {
    if (this.isRefreshing) {
      logger.info('[HourlyAggregation] Refresh already in progress, skipping');
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();
    logger.info('[HourlyAggregation] Starting full refresh/backfill from 10-min data...');

    try {
      if (!this.databaseService.isAvailable()) {
        logger.info('[HourlyAggregation] Database not available, skipping aggregation');
        return;
      }

      const currentHourStart = this.getCurrentHourStart();
      await this.databaseService.markHoursComplete(currentHourStart);

      const recordsAggregated = await this.databaseService.aggregate10MinToHourly();

      if (recordsAggregated > 0) {
        await this.databaseService.pool?.query(
          `UPDATE hourly_volumes SET is_complete = true 
           WHERE hour < $1 AND is_complete = false`,
          [currentHourStart]
        );
        logger.info(`[HourlyAggregation] Aggregated ${recordsAggregated} hourly records from 10-min data`);
      } else {
        logger.info('[HourlyAggregation] No 10-minute data available for aggregation');
      }

      this.lastRefreshTime = new Date();
      const duration = Date.now() - startTime;
      logger.info(`[HourlyAggregation] Refresh completed in ${duration}ms`);
    } catch (error: any) {
      logger.error('[HourlyAggregation] Error during refresh', error);
    } finally {
      this.isRefreshing = false;
    }
  }


  /**
   * Normalize hour timestamp to consistent ISO format
   */
  private normalizeHourTimestamp(hour: string): string {
    // Dune may return different formats, normalize to ISO
    const date = new Date(hour);
    return date.toISOString();
  }

  /**
   * Get the start of the current hour as ISO string
   */
  private getCurrentHourStart(): string {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return now.toISOString();
  }

  /**
   * Update in-memory cache with hourly data
   */
  private updateInMemoryCache(records: HourlyVolumeRecord[]): void {
    for (const record of records) {
      let tokenRecords = this.inMemoryHourlyCache.get(record.token);
      
      if (!tokenRecords) {
        tokenRecords = [];
        this.inMemoryHourlyCache.set(record.token, tokenRecords);
      }

      // Find and update or add
      const existingIndex = tokenRecords.findIndex(r => r.hour === record.hour);
      if (existingIndex >= 0) {
        tokenRecords[existingIndex] = record;
      } else {
        tokenRecords.push(record);
      }
    }

    // Prune old data from in-memory cache (keep 48 hours)
    const cutoffTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    for (const [token, records] of this.inMemoryHourlyCache.entries()) {
      const filtered = records.filter(r => r.hour >= cutoffTime);
      this.inMemoryHourlyCache.set(token, filtered);
    }
  }

  /**
   * Get rolling 24h metrics for tokens
   * Primary method for serving /api/tickers
   */
  async getRolling24hMetrics(tokens?: string[]): Promise<Map<string, Rolling24hMetrics>> {
    // Try database first
    if (this.databaseService.isAvailable()) {
      const dbMetrics = await this.databaseService.getRolling24hMetrics(tokens);
      if (dbMetrics.size > 0) {
        return dbMetrics;
      }
    }

    // Fall back to in-memory cache
    return this.calculateRolling24hFromCache(tokens);
  }

  /**
   * Calculate rolling 24h from in-memory cache
   */
  private calculateRolling24hFromCache(tokens?: string[]): Map<string, Rolling24hMetrics> {
    const metricsMap = new Map<string, Rolling24hMetrics>();
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const tokensToCheck = tokens
      ? tokens
      : Array.from(this.inMemoryHourlyCache.keys());

    for (const tokenLower of tokensToCheck) {
      const records = this.inMemoryHourlyCache.get(tokenLower);
      if (!records) continue;

      const recent = records.filter(r => r.hour >= cutoffTime);
      if (recent.length === 0) continue;

      let baseVolume = 0;
      let targetVolume = 0;
      let high = 0;
      let low = Infinity;
      let tradeCount = 0;

      for (const record of recent) {
        baseVolume += parseFloat(record.base_volume) || 0;
        targetVolume += parseFloat(record.target_volume) || 0;
        const recordHigh = parseFloat(record.high) || 0;
        const recordLow = parseFloat(record.low) || Infinity;
        if (recordHigh > high) high = recordHigh;
        if (recordLow > 0 && recordLow < low) low = recordLow;
        tradeCount += record.trade_count || 0;
      }

      metricsMap.set(tokenLower, {
        token: tokenLower,
        base_volume_24h: baseVolume.toFixed(8),
        target_volume_24h: targetVolume.toFixed(8),
        high_24h: high > 0 ? high.toFixed(12) : '0',
        low_24h: low < Infinity ? low.toFixed(12) : '0',
        trade_count_24h: tradeCount,
      });
    }

    return metricsMap;
  }

  /**
   * Force an immediate refresh
   */
  async forceRefresh(): Promise<void> {
    logger.info('[HourlyAggregation] Force refresh requested');
    await this.refresh();
  }

  /**
   * Get service status
   */
  async getStatus(): Promise<HourlyAggregationStatus> {
    const latestHour = this.databaseService.isAvailable()
      ? await this.databaseService.getLatestHour()
      : null;
    const latestCompleteHour = this.databaseService.isAvailable()
      ? await this.databaseService.getLatestCompleteHour()
      : null;
    const tokenCount = this.databaseService.isAvailable()
      ? await this.databaseService.getHourlyTokenCount()
      : this.inMemoryHourlyCache.size;
    const recordCount = this.databaseService.isAvailable()
      ? await this.databaseService.getHourlyRecordCount()
      : Array.from(this.inMemoryHourlyCache.values()).reduce((sum, records) => sum + records.length, 0);

    return {
      isInitialized: this._isInitialized,
      databaseConnected: this.databaseService.isAvailable(),
      latestHour,
      latestCompleteHour,
      tokenCount,
      recordCount,
      lastRefreshTime: this.lastRefreshTime,
      isRefreshing: this.isRefreshing,
      hourlyQueryId: null, // Deprecated - now uses DB aggregation from 10-minute data
      schedule: {
        hourlyRefresh: ':01 past each hour',
        tenMinRefresh: 'every 10 minutes (:00, :10, :20, :30, :40, :50)',
        queriesPerDay: 24 + 144, // 168 queries/day
      },
    };
  }
}
