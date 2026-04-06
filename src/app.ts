import express, { type Request, type Response, type NextFunction } from 'express';
import type { Application } from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler, asyncHandler, AppError } from './middleware/errorHandler.js';
import { metricsService } from './services/metricsService.js';
import { config } from './config.js';
import { createRoutes } from './routes/index.js';
import type { ServiceGetters } from './routes/types.js';

import type { FutarchyService } from './services/futarchyService.js';
import type { PriceService } from './services/priceService.js';
import type { DuneService } from './services/duneService.js';
import type { DuneCacheService } from './services/duneCacheService.js';
import type { SolanaService } from './services/solanaService.js';
import type { LaunchpadService } from './services/launchpadService.js';
import type { DatabaseService } from './services/databaseService.js';
import type { ExternalDatabaseService } from './services/externalDatabaseService.js';
import type { HourlyAggregationService } from './services/hourlyAggregationService.js';
import type { TenMinuteVolumeFetcherService } from './services/tenMinuteVolumeFetcherService.js';
import type { DailyAggregationService } from './services/dailyAggregationService.js';
import type { MeteoraVolumeFetcherService } from './services/meteoraVolumeFetcherService.js';
import type { V06ReconciliationService } from './services/v06ReconciliationService.js';

export interface Services {
  futarchyService: FutarchyService;
  priceService: PriceService;
  databaseService: DatabaseService;
  externalDatabaseService?: ExternalDatabaseService;
  duneService?: DuneService | null;
  duneCacheService?: DuneCacheService | null;
  solanaService?: SolanaService;
  launchpadService?: LaunchpadService;
  hourlyAggregationService?: HourlyAggregationService | null;
  tenMinuteVolumeFetcherService?: TenMinuteVolumeFetcherService | null;
  dailyAggregationService?: DailyAggregationService | null;
  meteoraVolumeFetcherService?: MeteoraVolumeFetcherService | null;
  v06ReconciliationService?: V06ReconciliationService | null;
}

export interface AppOptions {
  services: Services;
}

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function createRateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const limit = rateLimitMap.get(ip);

    if (!limit || now > limit.resetTime) {
      rateLimitMap.set(ip, {
        count: 1,
        resetTime: now + config.server.rateLimit.windowMs,
      });
      next();
      return;
    }

    if (limit.count >= config.server.rateLimit.maxRequests) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    limit.count++;
    next();
  };
}

function createMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/metrics') {
      next();
      return;
    }

    const startTime = Date.now();
    metricsService.incrementHttpRequestsInFlight();

    res.on('finish', () => {
      metricsService.decrementHttpRequestsInFlight();
      const durationSeconds = (Date.now() - startTime) / 1000;
      metricsService.recordHttpRequest(req.method, req.path, res.statusCode, durationSeconds);
    });

    next();
  };
}

function createServiceGetters(services: Services): ServiceGetters {
  return {
    getFutarchyService: () => services.futarchyService,
    getPriceService: () => services.priceService,
    getDuneService: () => services.duneService ?? null,
    getDuneCacheService: () => services.duneCacheService ?? null,
    getSolanaService: () => {
      if (!services.solanaService) throw new AppError('Solana service not available', 503);
      return services.solanaService;
    },
    getLaunchpadService: () => {
      if (!services.launchpadService) throw new AppError('Launchpad service not available', 503);
      return services.launchpadService;
    },
    getDatabaseService: () => services.databaseService,
    getHourlyAggregationService: () => services.hourlyAggregationService ?? null,
    getTenMinuteVolumeFetcherService: () => services.tenMinuteVolumeFetcherService ?? null,
    getDailyAggregationService: () => services.dailyAggregationService ?? null,
    getMeteoraVolumeFetcherService: () => services.meteoraVolumeFetcherService ?? null,
  };
}

export function createApp(options: AppOptions): Application {
  const app = express();
  const { services } = options;
  const serviceGetters = createServiceGetters(services);

  app.use(express.json());

  app.use(requestIdMiddleware);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  app.use(createRateLimitMiddleware());
  app.use(createMetricsMiddleware());

  // Mount all routes
  app.use(createRoutes(serviceGetters));

  app.use(errorHandler);

  return app;
}

export { AppError, asyncHandler };
