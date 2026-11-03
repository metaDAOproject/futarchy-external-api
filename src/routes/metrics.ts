import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config.js';
import { metricsService } from '../services/metricsService.js';
import type { ServiceGetters } from './types.js';
import { logger } from '../utils/logger.js';

function hasMetricsToken(req: Request): boolean {
  const header = req.header('authorization') ?? '';
  // The auth scheme name is case-insensitive (RFC 9110); the token is not.
  const supplied = Buffer.from(/^Bearer /i.test(header) ? header.slice(7) : '');
  const expected = Buffer.from(config.metrics.token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createMetricsRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getExternalDatabaseService } = services;

  // Refresh scrape-time gauges. The heartbeat keeps these up to date too; this
  // just guarantees a scrape never reads values older than the last heartbeat.
  // DAO gauges are set when a snapshot refresh succeeds — a scrape must never
  // trigger an on-chain scan (the endpoint may be publicly reachable).
  function updateMetricsSnapshot(): void {
    metricsService.setServedDbConnected(!!getExternalDatabaseService()?.isAvailable());
  }

  // Prometheus metrics endpoint
  router.get('/metrics', async (req: Request, res: Response) => {
    if (config.metrics.token && !hasMetricsToken(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED', requestId: req.requestId });
      return;
    }
    try {
      updateMetricsSnapshot();

      res.set('Content-Type', metricsService.getContentType());
      res.end(await metricsService.getMetrics());
    } catch (error: any) {
      logger.error('[Metrics] Error generating metrics:', error);
      res.status(500).end('Error generating metrics');
    }
  });

  return router;
}
