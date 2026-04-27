import { timingSafeEqual } from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Application } from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler, asyncHandler, AppError } from './middleware/errorHandler.js';
import { metricsService } from './services/metricsService.js';
import { config } from './config.js';
import { createRoutes } from './routes/index.js';
import { createServiceGetters, type Services } from './routes/types.js';

export type { Services } from './routes/types.js';

export interface AppOptions {
  services: Services;
}

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function getElevatedHeaderValue(req: Request, headerName: string): string | undefined {
  const raw = req.headers[headerName.toLowerCase()];
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? raw[0] : raw;
}

function isElevatedRateLimit(req: Request): boolean {
  const { elevated } = config.server.rateLimit;
  if (!elevated.secret) {
    return false;
  }
  const presented = getElevatedHeaderValue(req, elevated.headerName);
  if (presented === undefined) {
    return false;
  }
  return timingSafeStringEqual(presented, elevated.secret);
}

function createRateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || 'unknown';
    const elevated = isElevatedRateLimit(req);
    const maxRequests = elevated
      ? config.server.rateLimit.elevated.maxRequests
      : config.server.rateLimit.maxRequests;
    const bucketKey = elevated ? `${ip}:elevated` : `${ip}:default`;
    const now = Date.now();
    const limit = rateLimitMap.get(bucketKey);

    if (!limit || now > limit.resetTime) {
      rateLimitMap.set(bucketKey, {
        count: 1,
        resetTime: now + config.server.rateLimit.windowMs,
      });
      next();
      return;
    }

    if (limit.count >= maxRequests) {
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

export function createApp(options: AppOptions): Application {
  const app = express();
  const { services } = options;
  const serviceGetters = createServiceGetters(services);

  app.use(express.json());

  app.use(requestIdMiddleware);

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    const elevatedHeader = config.server.rateLimit.elevated.headerName;
    res.header(
      'Access-Control-Allow-Headers',
      `Origin, X-Requested-With, Content-Type, Accept, ${elevatedHeader}`,
    );
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
