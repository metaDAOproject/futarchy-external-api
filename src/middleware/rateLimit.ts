import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

type RateLimitConfig = {
  readonly maxRequests: number;
  readonly windowMs: number;
};

type Bucket = {
  count: number;
  resetTime: number;
};

type ChargeResult = {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetTime: number;
  readonly retryAfterSeconds: number;
};

function getBucket(
  buckets: Map<string, Bucket>,
  key: string,
  now: number,
  windowMs: number,
): Bucket {
  const existing = buckets.get(key);
  if (existing && now <= existing.resetTime) {
    return existing;
  }

  const created = { count: 0, resetTime: now + windowMs };
  buckets.set(key, created);
  return created;
}

function secondsUntil(resetTime: number, now: number): number {
  return Math.max(1, Math.ceil((resetTime - now) / 1000));
}

function chargeBucket(
  buckets: Map<string, Bucket>,
  key: string,
  limit: RateLimitConfig,
  now: number,
): ChargeResult {
  const bucket = getBucket(buckets, key, now, limit.windowMs);
  const retryAfterSeconds = secondsUntil(bucket.resetTime, now);

  if (bucket.count >= limit.maxRequests) {
    return {
      allowed: false,
      limit: limit.maxRequests,
      remaining: 0,
      resetTime: bucket.resetTime,
      retryAfterSeconds,
    };
  }

  bucket.count++;
  return {
    allowed: true,
    limit: limit.maxRequests,
    remaining: Math.max(0, limit.maxRequests - bucket.count),
    resetTime: bucket.resetTime,
    retryAfterSeconds,
  };
}

function setRateLimitHeaders(res: Response, result: ChargeResult): void {
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetTime / 1000)));
}

function sendRateLimited(res: Response, result: ChargeResult): void {
  setRateLimitHeaders(res, result);
  res.setHeader('Retry-After', String(result.retryAfterSeconds));
  res.status(429).json({ error: 'Too many requests' });
}

export function createRateLimitMiddleware() {
  const buckets = new Map<string, Bucket>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now > bucket.resetTime) buckets.delete(key);
    }
  }, 5 * 60 * 1000);
  sweep.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.isExempt) {
      next();
      return;
    }

    const now = Date.now();
    const tier = req.clientTier ?? 'anon';
    const apiKey = req.apiKey ?? 'unknown';
    const primaryLimit = tier === 'trusted' ? config.server.trustedRateLimit : config.server.rateLimit;
    const primaryKey = tier === 'trusted' ? `key:${apiKey}` : `ip:${req.ip ?? 'unknown'}`;
    const primaryResult = chargeBucket(buckets, primaryKey, primaryLimit, now);

    if (!primaryResult.allowed) {
      sendRateLimited(res, primaryResult);
      return;
    }

    if (tier === 'anon' && config.server.globalRateLimit.maxRequests > 0) {
      const globalResult = chargeBucket(buckets, 'global:anon', config.server.globalRateLimit, now);
      if (!globalResult.allowed) {
        sendRateLimited(res, globalResult);
        return;
      }
    }

    setRateLimitHeaders(res, primaryResult);
    next();
  };
}
