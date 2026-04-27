import { describe, it, expect, afterEach } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createTestServices } from './helpers/testApp.js';

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
      expect(overflow.body).toEqual({ error: 'Too many requests' });
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
