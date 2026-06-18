import express, { type Request, type Response, type NextFunction } from 'express';
import type { Application } from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler, asyncHandler, AppError } from './middleware/errorHandler.js';
import { clientContextMiddleware } from './middleware/clientContext.js';
import { corsMiddleware } from './middleware/cors.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';
import { restrictionMiddleware } from './middleware/restriction.js';
import { metricsService } from './services/metricsService.js';
import { config } from './config.js';
import { createRoutes } from './routes/index.js';
import { createServiceGetters, type Services } from './routes/types.js';

export type { Services } from './routes/types.js';

export interface AppOptions {
  services: Services;
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
  metricsService.setRestrictionMode(config.server.restriction.mode);

  // Resolve the real client IP from X-Forwarded-For when behind a reverse
  // proxy. Without this, every anonymous client shares the proxy's IP — and
  // therefore one collective rate-limit bucket. Uses an explicit hop count
  // (never `true`) so clients can't spoof their IP via XFF.
  if (config.server.trustProxyHops > 0) {
    app.set('trust proxy', config.server.trustProxyHops);
  }

  app.use(express.json());

  app.use(requestIdMiddleware);
  app.use(corsMiddleware);

  // Metrics BEFORE the rate limiter so 429/401 responses are recorded too.
  app.use(createMetricsMiddleware());
  app.use(clientContextMiddleware);
  app.use(restrictionMiddleware);
  app.use(createRateLimitMiddleware());

  // Mount all routes
  app.use(createRoutes(serviceGetters));

  app.use(errorHandler);

  return app;
}

export { AppError, asyncHandler };
