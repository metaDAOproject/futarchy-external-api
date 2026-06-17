/**
 * Prometheus Metrics Service
 *
 * Exports metrics for monitoring service health, performance, and the served
 * ETL database (the API's only data dependency). Accessible via GET /metrics.
 */

import client from 'prom-client';

// Create a Registry to hold all metrics
const register = new client.Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({ register });

// ============================================
// SERVED (EXTERNAL) DATABASE METRICS
// ============================================

export const servedDbConnected = new client.Gauge({
  name: 'futarchy_served_db_connected',
  help: 'Served (external) ETL database connection status (1 = connected, 0 = disconnected)',
  registers: [register],
});

export const servedContractOk = new client.Gauge({
  name: 'futarchy_served_contract_ok',
  help: 'Served ETL data contract check status (1 = all required tables/columns present)',
  registers: [register],
});

export const servedDataAgeSeconds = new client.Gauge({
  name: 'futarchy_served_data_age_seconds',
  help: 'Age in seconds of the newest swap row in the served ETL DB (pipeline freshness)',
  registers: [register],
});

export const heartbeatLastRun = new client.Gauge({
  name: 'futarchy_heartbeat_last_run_timestamp_seconds',
  help: 'Unix timestamp of the last heartbeat self-check run',
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
// BUSINESS METRICS
// ============================================

export const activeDaosCount = new client.Gauge({
  name: 'futarchy_active_daos_count',
  help: 'Number of active DAOs being tracked',
  registers: [register],
});

// ============================================
// METRICS SERVICE CLASS
// ============================================

export class MetricsService {
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

  // Served DB / heartbeat gauges

  setServedDbConnected(connected: boolean): void {
    servedDbConnected.set(connected ? 1 : 0);
  }

  setServedContractOk(ok: boolean): void {
    servedContractOk.set(ok ? 1 : 0);
  }

  setServedDataAgeSeconds(ageSeconds: number | null): void {
    if (ageSeconds !== null) {
      servedDataAgeSeconds.set(ageSeconds);
    }
  }

  markHeartbeatRun(): void {
    heartbeatLastRun.set(Date.now() / 1000);
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
   * Update business metrics
   */
  setActiveDaosCount(count: number): void {
    activeDaosCount.set(count);
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
}

// Export singleton instance
export const metricsService = new MetricsService();
