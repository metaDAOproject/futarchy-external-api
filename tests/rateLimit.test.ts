import { describe, it, expect, afterEach } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createTestServices } from './helpers/testApp.js';
import { MemoryRateLimitStore, RedisRateLimitStore, type RedisLike } from '../src/utils/rateLimitStore.js';

const originalAnonMax = config.server.rateLimit.maxRequests;
const originalTrustedMax = config.server.trustedRateLimit.maxRequests;
const originalKeys = new Set(config.server.trustedApiKeys);

afterEach(() => {
  config.server.rateLimit.maxRequests = originalAnonMax;
  config.server.trustedRateLimit.maxRequests = originalTrustedMax;
  config.server.trustedApiKeys.clear();
  originalKeys.forEach(k => config.server.trustedApiKeys.add(k));
});

describe('Rate limiting', () => {
  describe('anonymous traffic', () => {
    it('returns 429 once the configured anon limit is exceeded', async () => {
      config.server.rateLimit.maxRequests = 3;
      const app = createApp({ services: createTestServices() });

      for (let i = 0; i < 3; i++) {
        const r = await request(app).get('/health');
        expect(r.status).toBe(200);
      }

      const overflow = await request(app).get('/health');
      expect(overflow.status).toBe(429);
      expect(overflow.body).toMatchObject({ error: 'Too many requests', code: 'RATE_LIMITED' });
      expect(overflow.headers['ratelimit-limit']).toBe('3');
      expect(overflow.headers['ratelimit-remaining']).toBe('0');
      expect(Number(overflow.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('counts requests rejected for repeated query parameters against the quota', async () => {
      config.server.rateLimit.maxRequests = 1;
      const app = createApp({ services: createTestServices() });

      expect((await request(app).get('/dexscreener/asset?id=a&id=b')).status).toBe(400);
      expect((await request(app).get('/dexscreener/asset?id=a&id=b')).status).toBe(429);
    });

    it('never rate-limits the container probes', async () => {
      config.server.rateLimit.maxRequests = 1;
      const app = createApp({ services: createTestServices() });

      for (let i = 0; i < 5; i++) {
        expect((await request(app).get('/health/live')).status).toBe(200);
        expect((await request(app).get('/health/startup')).status).toBe(200);
      }
    });
  });

  describe('trusted X-API-Key', () => {
    it('uses the elevated limit and exceeds the anon cap cleanly', async () => {
      config.server.rateLimit.maxRequests = 3;
      config.server.trustedRateLimit.maxRequests = 10;
      config.server.trustedApiKeys.add('valid-key-1');
      const app = createApp({ services: createTestServices() });

      for (let i = 0; i < 5; i++) {
        const r = await request(app)
          .get('/health')
          .set('X-API-Key', 'valid-key-1');
        expect(r.status).toBe(200);
      }
    });

    it('returns 401 INVALID_API_KEY when the key is not on the allowlist', async () => {
      config.server.trustedApiKeys.add('valid-key-1');
      const app = createApp({ services: createTestServices() });

      const r = await request(app)
        .get('/health')
        .set('X-API-Key', 'wrong-key');

      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Invalid API key');
      expect(r.body.code).toBe('INVALID_API_KEY');
      expect(r.body.requestId).toBeTruthy();
    });

    it('gives each trusted key its own bucket', async () => {
      config.server.trustedRateLimit.maxRequests = 2;
      config.server.trustedApiKeys.add('key-A');
      config.server.trustedApiKeys.add('key-B');
      const app = createApp({ services: createTestServices() });

      // Burn key-A's budget.
      const a1 = await request(app).get('/health').set('X-API-Key', 'key-A');
      const a2 = await request(app).get('/health').set('X-API-Key', 'key-A');
      const aOver = await request(app).get('/health').set('X-API-Key', 'key-A');
      expect(a1.status).toBe(200);
      expect(a2.status).toBe(200);
      expect(aOver.status).toBe(429);

      // key-B's bucket is independent.
      const b1 = await request(app).get('/health').set('X-API-Key', 'key-B');
      const b2 = await request(app).get('/health').set('X-API-Key', 'key-B');
      expect(b1.status).toBe(200);
      expect(b2.status).toBe(200);
    });
  });

  describe('shared store (multiple replicas)', () => {
    it('enforces one limit across app instances that share a store', async () => {
      config.server.rateLimit.maxRequests = 2;
      const store = new MemoryRateLimitStore();
      const replicaA = createApp({ services: createTestServices(), rateLimitStore: store });
      const replicaB = createApp({ services: createTestServices(), rateLimitStore: store });

      expect((await request(replicaA).get('/health')).status).toBe(200);
      expect((await request(replicaB).get('/health')).status).toBe(200);
      expect((await request(replicaA).get('/health')).status).toBe(429);
    });

    it('keeps limiting per process when Redis is down or hangs, instead of failing requests', async () => {
      config.server.rateLimit.maxRequests = 2;
      for (const failure of [
        async () => { throw new Error('Connection has failed'); },
        () => new Promise(() => {}), // accepted, never answered
      ]) {
        let sends = 0;
        let closes = 0;
        const send = () => { sends++; return failure(); };
        const client = { connected: true, connect: async () => {}, send, close: () => { closes++; } } as unknown as RedisLike;
        const store = new RedisRateLimitStore(client, new MemoryRateLimitStore(), { timeoutMs: 20, reconnectIntervalMs: 60_000 });
        const app = createApp({ services: createTestServices(), rateLimitStore: store });

        expect((await request(app).get('/health')).status).toBe(200);
        expect((await request(app).get('/health')).status).toBe(200);
        expect((await request(app).get('/health')).status).toBe(429);
        // Circuit breaker: only the first request waited on Redis, and its
        // possibly half-open connection was dropped.
        expect(sends).toBe(1);
        expect(closes).toBe(1);
      }
    });

    it('keeps the budget already spent through Redis when it fails mid-window', async () => {
      config.server.rateLimit.maxRequests = 2;
      let redisCount = 0;
      let redisUp = true;
      const client = {
        connected: true,
        connect: async () => {},
        close: () => {},
        send: async () => {
          if (!redisUp) throw new Error('Connection has failed');
          return [++redisCount, 30_000];
        },
      } as unknown as RedisLike;
      const store = new RedisRateLimitStore(client, new MemoryRateLimitStore(), { timeoutMs: 20, reconnectIntervalMs: 60_000 });
      const app = createApp({ services: createTestServices(), rateLimitStore: store });

      expect((await request(app).get('/health')).status).toBe(200);
      expect((await request(app).get('/health')).status).toBe(200);
      redisUp = false;
      expect((await request(app).get('/health')).status).toBe(429);
    });

    it('reconnects a disconnected Redis client and uses it once connected', async () => {
      let connected = false;
      let connects = 0;
      const client = {
        get connected() { return connected; },
        connect: async () => { connects++; connected = true; },
        close: () => { connected = false; },
        send: async () => [7, 30_000],
      } as unknown as RedisLike;
      const store = new RedisRateLimitStore(client, new MemoryRateLimitStore(), { timeoutMs: 20, reconnectIntervalMs: 0 });
      await Bun.sleep(0);

      expect(connects).toBe(1);
      expect((await store.hit('ip:1', 60_000)).count).toBe(7);
    });
  });
});
