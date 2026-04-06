import { Router } from 'express';
import { createHealthRouter, saveHealthSnapshots } from './health.js';
import { createMetricsRouter } from './metrics.js';
import { createCoinGeckoRouter } from './coingecko.js';
import { createAdminRouter } from './admin.js';
import { createSupplyRouter } from './supply.js';
import { createMarketRouter } from './market.js';
import { createTradingActivityRouter } from './tradingActivity.js';
import { createRootRouter } from './root.js';
import type { ServiceGetters } from './types.js';

export { saveHealthSnapshots } from './health.js';
export type { ServiceGetters } from './types.js';

export function createRoutes(services: ServiceGetters): Router {
  const router = Router();

  router.use(createHealthRouter(services));
  router.use(createMetricsRouter(services));
  router.use(createCoinGeckoRouter(services));
  router.use(createAdminRouter(services));
  router.use(createSupplyRouter(services));
  router.use(createMarketRouter(services));
  router.use(createTradingActivityRouter(services));
  router.use(createRootRouter(services));

  return router;
}
