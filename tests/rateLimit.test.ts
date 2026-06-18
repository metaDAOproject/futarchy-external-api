import { describe, it, expect, afterEach } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createTestServices } from './helpers/testApp.js';

const originalAnonMax = config.server.rateLimit.maxRequests;
const originalAnonWindowMs = config.server.rateLimit.windowMs;
const originalTrustedMax = config.server.trustedRateLimit.maxRequests;
const originalGlobalRateLimit = { ...config.server.globalRateLimit };
const originalKeys = new Set(config.server.trustedApiKeys);
const originalTrustProxyHops = config.server.trustProxyHops;

afterEach(() => {
  config.server.rateLimit.maxRequests = originalAnonMax;
  config.server.rateLimit.windowMs = originalAnonWindowMs;
  config.server.trustedRateLimit.maxRequests = originalTrustedMax;
  config.server.globalRateLimit = { ...originalGlobalRateLimit };
  config.server.trustedApiKeys.clear();
  originalKeys.forEach(k => config.server.trustedApiKeys.add(k));
  config.server.trustProxyHops = originalTrustProxyHops;
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
      expect(overflow.body).toEqual({ error: 'Too many requests' });
      expect(overflow.headers['x-ratelimit-limit']).toBe('3');
      expect(overflow.headers['x-ratelimit-remaining']).toBe('0');
      expect(overflow.headers['x-ratelimit-reset']).toBeTruthy();
      expect(overflow.headers['retry-after']).toBeTruthy();
    });

    it('returns rate-limit headers on allowed responses', async () => {
      // Given
      config.server.rateLimit.maxRequests = 3;
      const app = createApp({ services: createTestServices() });

      // When
      const response = await request(app).get('/health');

      // Then
      expect(response.status).toBe(200);
      expect(response.headers['x-ratelimit-limit']).toBe('3');
      expect(response.headers['x-ratelimit-remaining']).toBe('2');
      expect(response.headers['x-ratelimit-reset']).toBeTruthy();
    });

    it('enforces a global anonymous ceiling across distinct client IPs', async () => {
      // Given
      config.server.trustProxyHops = 1;
      config.server.rateLimit.maxRequests = 60;
      config.server.globalRateLimit = { maxRequests: 2, windowMs: 60_000 };
      config.server.trustedApiKeys.add('consumer-key');
      const app = createApp({ services: createTestServices() });

      // When
      const first = await request(app).get('/health').set('X-Forwarded-For', '198.51.100.1');
      const second = await request(app).get('/health').set('X-Forwarded-For', '198.51.100.2');
      const third = await request(app).get('/health').set('X-Forwarded-For', '198.51.100.3');
      const trusted = await request(app)
        .get('/health')
        .set('X-Forwarded-For', '198.51.100.4')
        .set('X-API-Key', 'consumer-key');

      // Then
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      expect(third.headers['x-ratelimit-limit']).toBe('2');
      expect(trusted.status).toBe(200);
    });

    it('does not consume per-IP quota when a request is rejected by the global ceiling', async () => {
      // Given: a single IP whose per-IP budget (3) is larger than the global
      // ceiling (2), so the global ceiling — not the per-IP limit — rejects.
      config.server.trustProxyHops = 1;
      config.server.rateLimit.maxRequests = 3;
      config.server.globalRateLimit = { maxRequests: 2, windowMs: 60_000 };
      const app = createApp({ services: createTestServices() });
      const fromIp = () => request(app).get('/health').set('X-Forwarded-For', '198.51.100.7');

      // When: two served requests exhaust the global ceiling, the third is
      // rejected by it (per-IP still has a slot free: 2 of 3 used).
      const r1 = await fromIp();
      const r2 = await fromIp();
      const r3 = await fromIp();

      // Lift the global ceiling and replay from the same IP.
      config.server.globalRateLimit.maxRequests = 10;
      const r4 = await fromIp();
      const r5 = await fromIp();

      // Then: r3 was rejected by the GLOBAL ceiling (limit 2), not per-IP.
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(429);
      expect(r3.headers['x-ratelimit-limit']).toBe('2');
      // r4 must succeed: the rejected r3 must NOT have charged the per-IP bucket.
      // (Under the old charge-then-check order it would have, making r4 the 4th
      // per-IP hit against a limit of 3 → 429.)
      expect(r4.status).toBe(200);
      // The per-IP bucket has now seen exactly 3 served requests (r1, r2, r4),
      // so the next one is rejected by the per-IP limit (limit 3).
      expect(r5.status).toBe(429);
      expect(r5.headers['x-ratelimit-limit']).toBe('3');
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
});
