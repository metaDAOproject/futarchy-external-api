/**
 * Background heartbeat: the API's self-check loop.
 *
 * Replaces the old app-DB health snapshots. Every tick it verifies the served
 * ETL DB (the API's only data dependency) along three axes and pushes webhook
 * alerts (with cooldowns) when something is wrong, so failures surface even
 * when no consumer happens to be polling:
 *
 *  1. connectivity — is the served DB reachable?
 *  2. freshness    — how old is the newest user_pool swap? (a connected DB
 *                    with a stalled ETL is still an outage for consumers)
 *  3. contract     — every Nth tick, do the required tables/columns exist?
 *
 * Each tick also updates the Prometheus gauges, so /metrics exposes the same
 * signals for scrape-based alerting.
 */

import { config } from '../config.js';
import { metricsService } from '../services/metricsService.js';
import { sendAlert } from '../utils/alerts.js';
import { logger } from '../utils/logger.js';
import { scheduleWithoutPileup, type ScheduledTask } from '../utils/scheduling.js';
import type { Services } from '../routes/types.js';

const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

export function startHeartbeat(services: Services): ScheduledTask | null {
  if (config.heartbeat.intervalMs <= 0) {
    logger.info('[Heartbeat] Disabled (HEARTBEAT_INTERVAL_MS <= 0)');
    return null;
  }

  let tick = 0;

  return scheduleWithoutPileup(
    async () => {
      tick++;
      metricsService.markHeartbeatRun();

      const extDb = services.externalDatabaseService;

      // 1. Connectivity
      if (!extDb?.isAvailable()) {
        metricsService.setServedDbConnected(false);
        logger.warn('[Heartbeat] Served DB not connected');
        sendAlert('Heartbeat: served (external) DB not connected — market data routes are returning 503', {
          cooldownKey: 'heartbeat-served-db-down',
          cooldownMs: ALERT_COOLDOWN_MS,
        });
        return;
      }
      metricsService.setServedDbConnected(true);

      // 2. Data freshness
      try {
        const freshness = await extDb.getServedDataFreshness();
        metricsService.setServedDataAgeSeconds(freshness.ageSeconds);

        const maxAge = config.heartbeat.maxDataAgeSeconds;
        if (maxAge > 0 && freshness.ageSeconds !== null && freshness.ageSeconds > maxAge) {
          logger.warn('[Heartbeat] Served data is stale', {
            ageSeconds: freshness.ageSeconds,
            latestSwapAt: freshness.latestSwapAt,
            maxAgeSeconds: maxAge,
          });
          sendAlert(
            `Heartbeat: served data is stale — newest swap is ${Math.round(freshness.ageSeconds / 60)}min old (threshold ${Math.round(maxAge / 60)}min). ETL pipeline may be stalled.`,
            { cooldownKey: 'heartbeat-data-stale', cooldownMs: ALERT_COOLDOWN_MS }
          );
        }
      } catch (error) {
        logger.error('[Heartbeat] Freshness check failed', error);
        sendAlert('Heartbeat: served DB freshness check failed (query error)', {
          cooldownKey: 'heartbeat-freshness-failed',
          cooldownMs: ALERT_COOLDOWN_MS,
        });
      }

      // 3. Served-data contract (cheap information_schema query, but no need
      //    to run it every minute — schema drift is not a fast-moving failure)
      if (tick === 1 || tick % config.heartbeat.contractCheckEveryTicks === 0) {
        const contract = await extDb.checkServedDataContract();
        metricsService.setServedContractOk(contract.ok);
        if (!contract.ok) {
          logger.error('[Heartbeat] Served data contract check failed', undefined, {
            missing: contract.missing,
          });
          sendAlert(
            `Heartbeat: served ETL contract check failed — missing: ${contract.missing.join(', ')}`,
            { cooldownKey: 'heartbeat-contract-failed', cooldownMs: ALERT_COOLDOWN_MS }
          );
        }
      }
    },
    {
      name: 'Heartbeat',
      intervalMs: config.heartbeat.intervalMs,
      immediate: true,
    }
  );
}
