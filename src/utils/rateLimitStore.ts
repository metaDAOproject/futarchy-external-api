import { RedisClient } from 'bun';
import { config } from '../config.js';
import { logger } from './logger.js';

/** A bucket's state after counting one request against it. */
export interface RateLimitHit {
  /** Requests counted in the current window, including this one. */
  count: number;
  /** Epoch ms when the window resets. */
  resetTime: number;
}

/** Fixed-window request counter shared by every request of a bucket. */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

/** Per-process counters: exact for one replica, N× the limit across N replicas. */
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, RateLimitHit>();

  constructor() {
    // Evict expired buckets so the map doesn't grow without bound across
    // distinct client IPs/keys. unref() keeps the sweep from holding the
    // process (or test runner) open.
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now > bucket.resetTime) this.buckets.delete(key);
      }
    }, 5 * 60 * 1000);
    sweep.unref?.();
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now > bucket.resetTime) {
      bucket = { count: 0, resetTime: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return { ...bucket };
  }
}

// Atomic fixed-window hit: count the request, start the window on the first
// one, and report the window's remaining TTL. The PTTL < 0 branch repairs a
// key that lost its expiry, which would otherwise rate-limit forever.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

const KEY_PREFIX = 'futarchy-external-api:ratelimit:';

/** The subset of Bun's RedisClient the store uses (a fake in tests). */
export type RedisLike = Pick<RedisClient, 'connected' | 'connect' | 'send' | 'close'>;

/**
 * Counters shared by every replica through Redis, so the published limits
 * hold however many replicas run.
 *
 * Rate limiting must never take the API down: while Redis is unreachable,
 * slow (over `timeoutMs`) or erroring, requests are limited by the
 * per-process `local` counters instead. Every request is counted locally as
 * well, so a fallback mid-window keeps the budget this replica already spent
 * rather than granting a fresh one. A failed or slow command drops the
 * connection (it may be stuck half-open) and skips Redis for
 * `reconnectIntervalMs`; a reconnect is attempted at most that often. (Bun's
 * client, with the offline queue disabled so commands fail fast, does not
 * reconnect by itself once it has given up.)
 */
export class RedisRateLimitStore implements RateLimitStore {
  private connecting = false;
  private lastConnectAttempt = 0;
  private lastDegradedLog = 0;
  private bypassUntil = 0;

  constructor(
    private readonly client: RedisLike,
    private readonly local: RateLimitStore,
    private readonly options = { timeoutMs: 250, reconnectIntervalMs: 5_000 },
  ) {
    this.ensureConnected();
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const local = await this.local.hit(key, windowMs);
    // Circuit breaker: after a failure, skip Redis for reconnectIntervalMs so a
    // half-open connection costs one timeout, not timeoutMs on every request.
    if (Date.now() < this.bypassUntil) {
      return local;
    }
    if (!this.client.connected) {
      this.ensureConnected();
      this.logDegraded('not connected');
      return local;
    }
    try {
      const [count, ttl] = await this.withTimeout(
        this.client.send('EVAL', [HIT_SCRIPT, '1', KEY_PREFIX + key, String(windowMs)]),
      ) as [number, number];
      return { count: Number(count), resetTime: Date.now() + Number(ttl) };
    } catch (error) {
      this.bypassUntil = Date.now() + this.options.reconnectIntervalMs;
      this.logDegraded(error instanceof Error ? error.message : String(error));
      // A timed-out command may sit on a half-open socket that still reports
      // `connected`; drop it so the reconnect opens a fresh one instead of
      // queueing more commands behind it.
      this.client.close();
      this.ensureConnected();
      return local;
    }
  }

  private ensureConnected(): void {
    const now = Date.now();
    if (this.client.connected || this.connecting || now - this.lastConnectAttempt < this.options.reconnectIntervalMs) {
      return;
    }
    this.connecting = true;
    this.lastConnectAttempt = now;
    this.client.connect().then(
      () => logger.info('[RateLimit] Connected to Redis; rate limits are shared across replicas'),
      (error) => logger.warn('[RateLimit] Redis connect failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    ).finally(() => {
      this.connecting = false;
    });
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Redis did not answer within ${this.options.timeoutMs}ms`)),
        this.options.timeoutMs,
      );
      timer.unref?.();
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private logDegraded(reason: string): void {
    const now = Date.now();
    if (now - this.lastDegradedLog < 60_000) return;
    this.lastDegradedLog = now;
    logger.warn('[RateLimit] Redis unavailable; counting requests per process until it recovers', { reason });
  }
}

/** Redis-backed when RATE_LIMIT_REDIS_URL is set, otherwise per-process. */
export function createRateLimitStore(): RateLimitStore {
  const memory = new MemoryRateLimitStore();
  const url = config.server.rateLimitRedisUrl;
  if (!url) return memory;
  const client = new RedisClient(url, {
    connectionTimeout: 2_000,
    enableOfflineQueue: false,
    autoReconnect: true,
  });
  return new RedisRateLimitStore(client, memory);
}
