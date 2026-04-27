import express, { type Request, type Response, type NextFunction } from 'express';
import type { Application } from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler, asyncHandler, AppError } from './middleware/errorHandler.js';
import { metricsService } from './services/metricsService.js';
import { config } from './config.js';
import { createRoutes } from './routes/index.js';
import { createServiceGetters, type Services } from './routes/types.js';

export type { Services } from './routes/types.js';

declare global {
  namespace Express {
    interface Request {
      clientTier?: 'anon' | 'trusted';
    }
  }
}

export interface AppOptions {
  services: Services;
}

function createRateLimitMiddleware() {
  const buckets = new Map<string, { count: number; resetTime: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const apiKey = req.header('x-api-key');
    let tier: { windowMs: number; maxRequests: number };
    let bucketKey: string;

    if (apiKey) {
      if (!config.server.trustedApiKeys.has(apiKey)) {
        throw AppError.unauthorized('Invalid API key', 'INVALID_API_KEY');
      }
      tier = config.server.trustedRateLimit;
      bucketKey = `key:${apiKey}`;
      req.clientTier = 'trusted';
    } else {
      tier = config.server.rateLimit;
      bucketKey = `ip:${req.ip ?? 'unknown'}`;
      req.clientTier = 'anon';
    }

    const now = Date.now();
    const limit = buckets.get(bucketKey);

    if (!limit || now > limit.resetTime) {
      buckets.set(bucketKey, { count: 1, resetTime: now + tier.windowMs });
      next();
      return;
    }

    if (limit.count >= tier.maxRequests) {
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
      metricsService.recordHttpRequest(
        req.method,
        req.path,
        res.statusCode,
        durationSeconds,
        req.clientTier ?? 'anon',
      );
    });

    next();
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
