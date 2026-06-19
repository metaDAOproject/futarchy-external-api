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

// Build the response metadata for a bucket WITHOUT mutating its count. The
// caller checks every applicable limit first and only increments the buckets
// once all of them pass, so a request rejected by one ceiling never consumes
// quota from another (e.g. a global-ceiling rejection must not also burn the
// per-IP allowance).
function describeBucket(
  bucket: Bucket,
  limit: RateLimitConfig,
  now: number,
  allowed: boolean,
): ChargeResult {
  return {
    allowed,
    limit: limit.maxRequests,
    // remaining is computed against the post-increment count when allowed.
    remaining: allowed ? Math.max(0, limit.maxRequests - (bucket.count + 1)) : 0,
    resetTime: bucket.resetTime,
    retryAfterSeconds: secondsUntil(bucket.resetTime, now),
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
    const now = Date.now();
    const tier = req.clientTier ?? 'anon';
    const apiKey = req.apiKey ?? 'unknown';
    const primaryLimit = tier === 'trusted' ? config.server.trustedRateLimit : config.server.rateLimit;
    const primaryKey = tier === 'trusted' ? `key:${apiKey}` : `ip:${req.ip ?? 'unknown'}`;

    const globalLimit = config.server.globalRateLimit;
    const useGlobal = tier === 'anon' && globalLimit.maxRequests > 0;

    const primaryBucket = getBucket(buckets, primaryKey, now, primaryLimit.windowMs);
    const globalBucket = useGlobal
      ? getBucket(buckets, 'global:anon', now, globalLimit.windowMs)
      : null;

    // Check every applicable limit before charging either bucket.
    if (primaryBucket.count >= primaryLimit.maxRequests) {
      sendRateLimited(res, describeBucket(primaryBucket, primaryLimit, now, false));
      return;
    }
    if (globalBucket && globalBucket.count >= globalLimit.maxRequests) {
      sendRateLimited(res, describeBucket(globalBucket, globalLimit, now, false));
      return;
    }

    // All limits have room — commit the request against each.
    setRateLimitHeaders(res, describeBucket(primaryBucket, primaryLimit, now, true));
    primaryBucket.count++;
    if (globalBucket) globalBucket.count++;

    next();
  };
}
