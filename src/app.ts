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
