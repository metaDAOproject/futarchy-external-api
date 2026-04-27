/**
 * Prometheus Metrics Service
 * 
 * Exports metrics for monitoring service health, performance, and cache status.
 * Accessible via GET /metrics endpoint.
 */

import client from 'prom-client';
import { logger } from '../utils/logger.js';

// Create a Registry to hold all metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({ register });

// ============================================
// SERVICE HEALTH METRICS
// ============================================

// Service status gauges (1 = healthy, 0 = unhealthy)
export const serviceStatus = new client.Gauge({
  name: 'futarchy_service_status',
  help: 'Service status (1 = initialized/healthy, 0 = not initialized)',
  labelNames: ['service'],
  registers: [register],
});

// Last refresh timestamp for each service
export const lastRefreshTime = new client.Gauge({
  name: 'futarchy_last_refresh_timestamp_seconds',
  help: 'Unix timestamp of the last successful refresh for each service',
  labelNames: ['service'],
  registers: [register],
});

// Time since last refresh (useful for alerting on stale data)
export const timeSinceLastRefresh = new client.Gauge({
  name: 'futarchy_time_since_last_refresh_seconds',
  help: 'Seconds since the last successful refresh for each service',
  labelNames: ['service'],
  registers: [register],
});

// Refresh in progress
export const refreshInProgress = new client.Gauge({
  name: 'futarchy_refresh_in_progress',
  help: 'Whether a refresh is currently in progress (1 = yes, 0 = no)',
  labelNames: ['service'],
  registers: [register],
});

// ============================================
// DATABASE METRICS
// ============================================

export const databaseConnected = new client.Gauge({
  name: 'futarchy_database_connected',
  help: 'Database connection status (1 = connected, 0 = disconnected)',
  registers: [register],
});

export const databaseRecordCount = new client.Gauge({
  name: 'futarchy_database_record_count',
  help: 'Number of records in each database table',
  labelNames: ['table'],
  registers: [register],
});

export const databaseTokenCount = new client.Gauge({
  name: 'futarchy_database_token_count',
  help: 'Number of unique tokens in each database table',
  labelNames: ['table'],
  registers: [register],
});

export const databaseLatestDate = new client.Gauge({
  name: 'futarchy_database_latest_date_timestamp_seconds',
  help: 'Unix timestamp of the latest date/time in each table',
  labelNames: ['table'],
  registers: [register],
});

// ============================================
// CACHE METRICS
// ============================================

export const cacheSize = new client.Gauge({
  name: 'futarchy_cache_size',
  help: 'Number of items in each cache',
  labelNames: ['cache'],
  registers: [register],
});

export const cacheHits = new client.Counter({
  name: 'futarchy_cache_hits_total',
  help: 'Total number of cache hits',
  labelNames: ['cache'],
  registers: [register],
});

export const cacheMisses = new client.Counter({
  name: 'futarchy_cache_misses_total',
  help: 'Total number of cache misses',
  labelNames: ['cache'],
  registers: [register],
});

// ============================================
// API METRICS
// ============================================

export const httpRequestsTotal = new client.Counter({
  name: 'futarchy_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status', 'client_tier'],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'futarchy_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status', 'client_tier'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const httpRequestsInFlight = new client.Gauge({
  name: 'futarchy_http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [register],
});

// ============================================
// DUNE API METRICS
// ============================================

export const duneQueriesTotal = new client.Counter({
  name: 'futarchy_dune_queries_total',
  help: 'Total number of Dune API queries executed',
  labelNames: ['query_type', 'status'],
  registers: [register],
});

export const duneQueryDuration = new client.Histogram({
  name: 'futarchy_dune_query_duration_seconds',
  help: 'Dune query execution duration in seconds',
  labelNames: ['query_type'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [register],
});

export const duneCreditsUsed = new client.Counter({
  name: 'futarchy_dune_credits_used_total',
  help: 'Total Dune API credits used',
  registers: [register],
});

export const duneRowsFetched = new client.Counter({
  name: 'futarchy_dune_rows_fetched_total',
  help: 'Total number of rows fetched from Dune',
  labelNames: ['query_type'],
  registers: [register],
});

// ============================================
// SOLANA RPC METRICS
// ============================================

export const solanaRpcCallsTotal = new client.Counter({
  name: 'futarchy_solana_rpc_calls_total',
  help: 'Total number of Solana RPC calls',
  labelNames: ['method', 'status'],
  registers: [register],
});

export const solanaRpcDuration = new client.Histogram({
  name: 'futarchy_solana_rpc_duration_seconds',
  help: 'Solana RPC call duration in seconds',
  labelNames: ['method'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// ============================================
// BUSINESS METRICS
// ============================================

export const activeDaosCount = new client.Gauge({
  name: 'futarchy_active_daos_count',
  help: 'Number of active DAOs being tracked',
  registers: [register],
});

export const totalVolumeUsd = new client.Gauge({
  name: 'futarchy_total_volume_usd',
  help: 'Total 24h volume in USD across all pools',
  registers: [register],
});

// ============================================
// METRICS SERVICE CLASS
// ============================================

export class MetricsService {
  private updateInterval: NodeJS.Timeout | null = null;
  private lastUpdateTime: number = 0;

  /**
   * Get the Prometheus registry
   */
  getRegistry(): client.Registry {
    return register;
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    return register.metrics();
  }

  /**
   * Get content type for metrics response
   */
  getContentType(): string {
    return register.contentType;
  }

  /**
   * Update service status metric
   */
  setServiceStatus(service: string, isHealthy: boolean): void {
    serviceStatus.labels(service).set(isHealthy ? 1 : 0);
  }

  /**
   * Update last refresh time for a service
   */
  setLastRefreshTime(service: string, timestamp?: Date): void {
    const ts = timestamp || new Date();
    lastRefreshTime.labels(service).set(ts.getTime() / 1000);
  }

  /**
   * Update time since last refresh
   */
  updateTimeSinceLastRefresh(service: string, lastRefreshTimestamp: number): void {
    const now = Date.now();
    const secondsSince = (now - lastRefreshTimestamp) / 1000;
    timeSinceLastRefresh.labels(service).set(secondsSince);
  }

  /**
   * Set refresh in progress status
   */
  setRefreshInProgress(service: string, inProgress: boolean): void {
    refreshInProgress.labels(service).set(inProgress ? 1 : 0);
  }

  /**
   * Update database metrics
   */
  setDatabaseConnected(connected: boolean): void {
    databaseConnected.set(connected ? 1 : 0);
  }

  setDatabaseRecordCount(table: string, count: number): void {
    databaseRecordCount.labels(table).set(count);
  }

  setDatabaseTokenCount(table: string, count: number): void {
    databaseTokenCount.labels(table).set(count);
  }

  setDatabaseLatestDate(table: string, date: Date | string | null): void {
    if (!date) {
      databaseLatestDate.labels(table).set(0);
      return;
    }
    const timestamp = typeof date === 'string' ? new Date(date).getTime() : date.getTime();
    databaseLatestDate.labels(table).set(timestamp / 1000);
  }

  /**
   * Update cache metrics
   */
  setCacheSize(cache: string, size: number): void {
    cacheSize.labels(cache).set(size);
  }

  incrementCacheHit(cache: string): void {
    cacheHits.labels(cache).inc();
  }

  incrementCacheMiss(cache: string): void {
    cacheMisses.labels(cache).inc();
  }

  /**
   * Record HTTP request
   */
  recordHttpRequest(
    method: string,
    path: string,
    status: number,
    durationSeconds: number,
    clientTier: 'anon' | 'trusted' = 'anon',
  ): void {
    const normalizedPath = this.normalizePath(path);
    httpRequestsTotal.labels(method, normalizedPath, String(status), clientTier).inc();
    httpRequestDuration.labels(method, normalizedPath, String(status), clientTier).observe(durationSeconds);
  }

  incrementHttpRequestsInFlight(): void {
    httpRequestsInFlight.inc();
  }

  decrementHttpRequestsInFlight(): void {
    httpRequestsInFlight.dec();
  }

  /**
   * Record Dune API query
   */
  recordDuneQuery(queryType: string, success: boolean, durationSeconds: number, rowCount: number = 0, credits: number = 0): void {
    duneQueriesTotal.labels(queryType, success ? 'success' : 'error').inc();
    duneQueryDuration.labels(queryType).observe(durationSeconds);
    if (rowCount > 0) {
      duneRowsFetched.labels(queryType).inc(rowCount);
    }
    if (credits > 0) {
      duneCreditsUsed.inc(credits);
    }
  }

  /**
   * Record Solana RPC call
   */
  recordSolanaRpcCall(method: string, success: boolean, durationSeconds: number): void {
    solanaRpcCallsTotal.labels(method, success ? 'success' : 'error').inc();
    solanaRpcDuration.labels(method).observe(durationSeconds);
  }

  /**
   * Update business metrics
   */
  setActiveDaosCount(count: number): void {
    activeDaosCount.set(count);
  }

  setTotalVolumeUsd(volume: number): void {
    totalVolumeUsd.set(volume);
  }

  /**
   * Normalize API path for metrics (remove dynamic segments)
   */
  private normalizePath(path: string): string {
    // Replace dynamic segments with placeholders
    return path
      .replace(/\/[A-Za-z0-9]{32,50}/g, '/:address') // Solana addresses
      .replace(/\/\d+/g, '/:id') // Numeric IDs
      .replace(/\?.*$/, ''); // Remove query params
  }

  /**
   * Start periodic metrics updates
   */
  startPeriodicUpdates(intervalMs: number = 30000): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    this.updateInterval = setInterval(() => {
      this.lastUpdateTime = Date.now();
    }, intervalMs);
    
    logger.info(`[Metrics] Started periodic updates every ${intervalMs}ms`);
  }

  /**
   * Stop periodic updates
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    logger.info('[Metrics] Stopped');
  }
}

// Export singleton instance
export const metricsService = new MetricsService();
