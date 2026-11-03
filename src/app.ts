import express, { type Request, type Response, type NextFunction } from 'express';
import compression from 'compression';
import { createHash } from 'crypto';
import type { Application } from 'express';
import { requestIdMiddleware } from './middleware/requestId.js';
import { errorHandler, asyncHandler, AppError } from './middleware/errorHandler.js';
import { metricsService } from './services/metricsService.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { createApiRoutes, createInfraRoutes } from './routes/index.js';
import { createProbeRouter } from './routes/health.js';
import { createServiceGetters, type Services } from './routes/types.js';
import { createRateLimitStore, type RateLimitStore } from './utils/rateLimitStore.js';

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
  /** Defaults to Redis when RATE_LIMIT_REDIS_URL is set, else per-process. */
  rateLimitStore?: RateLimitStore;
}

function createRateLimitMiddleware(store: RateLimitStore) {
  let warnedAboutProxy = false;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Behind a proxy with TRUST_PROXY_HOPS=0, req.ip is the proxy's address, so
    // every anonymous client shares ONE rate-limit bucket — a handful of
    // pollers would 429 everyone. Surface the misconfiguration once.
    if (!warnedAboutProxy && config.server.trustProxyHops === 0 && req.headers['x-forwarded-for']) {
      warnedAboutProxy = true;
      logger.warn('Requests carry X-Forwarded-For but TRUST_PROXY_HOPS=0: all clients share the proxy IP rate-limit bucket. Set TRUST_PROXY_HOPS to the number of proxies in front of the API.');
    }

    const apiKey = req.header('x-api-key');
    let tier: { windowMs: number; maxRequests: number };
    let bucketKey: string;

    if (apiKey) {
      if (!config.server.trustedApiKeys.has(apiKey)) {
        throw AppError.unauthorized('Invalid API key', 'INVALID_API_KEY');
      }
      tier = config.server.trustedRateLimit;
      // Hashed, so the shared store (Redis) never holds partner keys.
      bucketKey = `key:${createHash('sha256').update(apiKey).digest('hex')}`;
      req.clientTier = 'trusted';
    } else {
      tier = config.server.rateLimit;
      bucketKey = `ip:${req.ip ?? 'unknown'}`;
      req.clientTier = 'anon';
    }

    const { count, resetTime } = await store.hit(bucketKey, tier.windowMs);

    // IETF RateLimit header fields, so clients can pace themselves.
    const resetSeconds = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
    res.setHeader('RateLimit-Limit', tier.maxRequests);
    res.setHeader('RateLimit-Reset', resetSeconds);
    res.setHeader('RateLimit-Remaining', Math.max(0, tier.maxRequests - count));

    if (count > tier.maxRequests) {
      res.setHeader('Retry-After', resetSeconds);
      res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED', requestId: req.requestId });
      return;
    }
    next();
  };
}

/**
 * Bounded metrics label for a matched request: its API version prefix (from
 * the URL, since Express has restored `req.baseUrl` by the time an error
 * response finishes) plus the matched route pattern. Keeps /v1 and
 * unversioned traffic distinguishable for deprecation decisions.
 */
function routeLabel(req: Request): string {
  const version = req.originalUrl.match(/^\/v\d+(?=[/?]|$)/)?.[0] ?? '';
  return version + [req.route.path].flat().join('|');
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
      const durationMs = Date.now() - startTime;
      // Label by the matched route PATTERN (`/api/supply/:mintAddress/total`),
      // never the requested URL, and give unmatched requests one shared label,
      // so arbitrary URLs can't create unbounded Prometheus series.
      const route = req.route ? routeLabel(req) : 'unmatched';
      metricsService.recordHttpRequest(
        req.method,
        route,
        res.statusCode,
        durationMs / 1000,
        req.clientTier ?? 'anon',
      );
      // One structured line per request, so the X-Request-Id a partner quotes
      // can be traced even when the request didn't error. Probes are mounted
      // before this middleware and stay out of the log.
      logger.info('HTTP request', {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        route,
        status: res.statusCode,
        durationMs,
        tier: req.clientTier ?? 'anon',
      });
    });

    next();
  };
}

// Operational endpoints whose responses must never be cached.
// Case-insensitive with optional trailing slash, matching Express's routing.
const UNCACHEABLE_PATH = /^\/(health|metrics)(\/|$)|^\/api\/health\/?$/i;

/**
 * Response headers every public response gets: CORS (read-only, any origin),
 * nosniff, and Cache-Control decided when the status is known: successful
 * data GETs are `private` (client-side cache only) for `cacheMaxAgeSeconds`,
 * everything else (errors, health, metrics) is no-store. `private`, not
 * `public`, because responses carry per-caller headers (RateLimit-*,
 * X-Request-Id) that a shared cache would replay to other callers. A route
 * can still set its own Cache-Control.
 */
function createResponseHeadersMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key, X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: unknown[]) {
      if (!res.getHeader('Cache-Control')) {
        const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
        const cacheable = req.method === 'GET' && status >= 200 && status < 300
          && !UNCACHEABLE_PATH.test(req.originalUrl.split('?')[0]!);
        res.setHeader('Cache-Control', cacheable
          ? `private, max-age=${config.server.cacheMaxAgeSeconds}`
          : 'no-store');
      }
      return (writeHead as (...a: unknown[]) => Response).apply(this, args);
    } as typeof res.writeHead;

    // CORS preflight: answer directly, before rate limiting.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Answer 503 REQUEST_TIMEOUT when a handler hasn't responded within
 * `requestTimeout`, so a client gets a clear, retryable error instead of a
 * hung connection. The handler keeps running; anything it writes later is
 * dropped (see errorHandler).
 */
function createRequestTimeoutMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // SERVER_REQUEST_TIMEOUT=0 disables the timeout, as it always has.
    if (config.server.requestTimeout === 0) {
      next();
      return;
    }
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      logger.warn('Request timed out', { requestId: req.requestId, path: req.originalUrl });
      res.status(503).json({ error: 'Request timed out', code: 'REQUEST_TIMEOUT', requestId: req.requestId });
    }, config.server.requestTimeout);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

/**
 * Every endpoint takes each query parameter at most once. A repeated one
 * (`?id=a&id=b`) parses to an array, which the string-typed handlers would
 * otherwise turn into a 500 or a confusing lookup.
 */
function rejectRepeatedQueryParams(req: Request, _res: Response, next: NextFunction): void {
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== 'string') {
      throw AppError.badRequest(`Query parameter '${key}' must be given exactly once`, 'INVALID_QUERY_PARAMETER');
    }
  }
  next();
}

export function createApp(options: AppOptions): Application {
  const app = express();
  const { services } = options;
  const serviceGetters = createServiceGetters(services);

  // Resolve the real client IP from X-Forwarded-For when behind a reverse
  // proxy. Without this, every anonymous client shares the proxy's IP — and
  // therefore one collective rate-limit bucket. Uses an explicit hop count
  // (never `true`) so clients can't spoof their IP via XFF.
  if (config.server.trustProxyHops > 0) {
    app.set('trust proxy', config.server.trustProxyHops);
  }
  app.disable('x-powered-by');

  app.use(requestIdMiddleware);
  app.use(createResponseHeadersMiddleware());
  // gzip/brotli/deflate per Accept-Encoding for bodies over 1 KB. Market-data
  // and DexScreener event responses are large, highly repetitive JSON.
  app.use(compression());
  app.use(createRequestTimeoutMiddleware());

  // Container probes BEFORE metrics and the rate limiter (see createProbeRouter).
  app.use(createProbeRouter(serviceGetters));

  // Metrics BEFORE the rate limiter so 429/401 responses are recorded too.
  app.use(createMetricsMiddleware());
  app.use(createRateLimitMiddleware(options.rateLimitStore ?? createRateLimitStore()));
  // After metrics and rate limiting, so rejected requests are counted and
  // spend quota like any other.
  app.use(rejectRepeatedQueryParams);

  // Health/metrics/index are operational and unversioned; the data API is
  // served under /v1 plus the legacy unversioned alias (see routes/index.ts).
  app.use(createInfraRoutes(serviceGetters));
  app.use(createApiRoutes(serviceGetters));

  // JSON 404 (Express's default is an HTML page) in the same shape as errors.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', requestId: req.requestId });
  });

  app.use(errorHandler);

  return app;
}

export { AppError, asyncHandler };
