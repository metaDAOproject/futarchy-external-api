import { DuneService, DunePoolMetrics } from './duneService.js';
import { FutarchyService } from './futarchyService.js';
import { DatabaseService } from './databaseService.js';
import { scheduleWithoutPileup, type ScheduledTask } from '../utils/scheduling.js';
import { logger } from '../utils/logger.js';

export interface CachedDuneData {
  poolMetrics: Map<string, DunePoolMetrics>;
  lastUpdated: Date;
  isRefreshing: boolean;
}

export class DuneCacheService {
  private duneService: DuneService;
  private databaseService: DatabaseService;
  private futarchyService: FutarchyService;
  private cache: CachedDuneData;
  private refreshTask: ScheduledTask | null = null;
  private refreshIntervalMs: number;
  private isInitialized: boolean = false;

  constructor(duneService: DuneService, databaseService: DatabaseService, futarchyService: FutarchyService) {
    this.duneService = duneService;
    this.databaseService = databaseService;
    this.futarchyService = futarchyService;
    
    // Default to 1 hour refresh interval, configurable via environment
    this.refreshIntervalMs = parseInt(process.env.DUNE_CACHE_REFRESH_INTERVAL || '3600') * 1000;
    
    // Initialize empty cache
    this.cache = {
      poolMetrics: new Map(),
      lastUpdated: new Date(0), // Epoch - indicates never updated
      isRefreshing: false,
    };
  }

  /**
   * Start the cache refresh cron job
   * Should be called when the server starts
   */
  async start(): Promise<void> {
    logger.info(`[DuneCache] Starting cache service with ${this.refreshIntervalMs / 1000}s refresh interval`);
    
    this.isInitialized = true;
    
    this.refreshTask = scheduleWithoutPileup(
      () => this.refreshCache(),
      {
        name: 'DuneCache',
        intervalMs: this.refreshIntervalMs,
        immediate: true,
        onError: (error) => logger.error('[DuneCache] Refresh failed', error),
      }
    );
    
    logger.info(`[DuneCache] Cache service started with ${this.refreshIntervalMs / 1000}s interval`);
  }

  /**
   * Stop the cache refresh cron job
   */
  stop(): void {
    if (this.refreshTask) {
      this.refreshTask.stop();
      this.refreshTask = null;
    }
  }

  /**
   * Refresh the cache by fetching fresh data from Dune
   */
  async refreshCache(): Promise<void> {
    if (this.cache.isRefreshing) {
      logger.info('[DuneCache] Refresh already in progress, skipping');
      return;
    }

    this.cache.isRefreshing = true;
    logger.info('[DuneCache] Starting cache refresh...');
    const startTime = Date.now();

    try {
      const allDaos = await this.futarchyService.getAllDaos();
      const baseMintAddresses = allDaos.map(dao => dao.baseMint.toString());
      
      logger.info(`[DuneCache] Refreshing data for ${baseMintAddresses.length} tokens`);

      try {
        if (!this.databaseService.isAvailable()) {
          logger.info('[DuneCache] Database not available, skipping 24h metrics refresh');
        } else {
          const rolling24hMetrics = await this.databaseService.getRolling24hFromTenMinute(baseMintAddresses);
          
          const tokenToDaoMap = new Map<string, string>();
          for (const dao of allDaos) {
            tokenToDaoMap.set(dao.baseMint.toString(), dao.daoAddress.toString());
          }

          const daoMetricsMap = new Map<string, DunePoolMetrics>();
          for (const [tokenAddress, metrics] of rolling24hMetrics.entries()) {
            const daoAddress = tokenToDaoMap.get(tokenAddress);
            if (daoAddress) {
              daoMetricsMap.set(daoAddress, {
                pool_id: daoAddress,
                base_volume_24h: metrics.base_volume_24h,
                target_volume_24h: metrics.target_volume_24h,
                high_24h: metrics.high_24h,
                low_24h: metrics.low_24h,
              });
            }
          }

          this.cache.poolMetrics = daoMetricsMap;
          logger.info(`[DuneCache] Refreshed pool metrics from DB aggregation for ${daoMetricsMap.size} DAOs`);
        }
      } catch (error: any) {
        logger.error('[DuneCache] Error refreshing pool metrics', error);
      }


      this.cache.lastUpdated = new Date();
      const duration = Date.now() - startTime;
      logger.info(`[DuneCache] Cache refresh completed in ${duration}ms`);
    } catch (error: any) {
      logger.error('[DuneCache] Error during cache refresh', error);
    } finally {
      this.cache.isRefreshing = false;
    }
  }

  /**
   * Force an immediate cache refresh
   */
  async forceRefresh(): Promise<void> {
    logger.info('[DuneCache] Force refresh requested');
    await this.refreshCache();
  }

  /**
   * Get cached pool metrics
   * Returns null if cache is empty and not yet initialized
   */
  getPoolMetrics(): Map<string, DunePoolMetrics> | null {
    if (!this.isInitialized && this.cache.poolMetrics.size === 0) {
      return null;
    }
    return this.cache.poolMetrics;
  }

  /**
   * Get cache status information
   */
  getCacheStatus(): {
    lastUpdated: Date;
    isRefreshing: boolean;
    poolMetricsCount: number;
    cacheAgeMs: number;
    isInitialized: boolean;
  } {
    return {
      lastUpdated: this.cache.lastUpdated,
      isRefreshing: this.cache.isRefreshing,
      poolMetricsCount: this.cache.poolMetrics.size,
      cacheAgeMs: Date.now() - this.cache.lastUpdated.getTime(),
      isInitialized: this.isInitialized,
    };
  }

  /**
   * Check if cache has data
   */
  hasData(): boolean {
    return this.cache.poolMetrics.size > 0;
  }
}

