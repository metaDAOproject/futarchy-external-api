import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from './helpers/testApp.js';
import type { LaunchpadService } from '../src/services/launchpadService.js';
import { config } from '../src/config.js';

const launchpadService = {
  getLiveLaunches: async () => ({ updatedAt: '2026-10-09T00:00:00.000Z', launches: [] }),
} as unknown as LaunchpadService;
const app = createTestApp({ launchpadService });

describe('Public API surface', () => {
  it('answers unknown routes with a JSON 404, never cached', async () => {
    const res = await request(app).get('/no/such/route');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Not found', code: 'NOT_FOUND' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('marks successful data responses cacheable, and errors and health no-store', async () => {
    const data = await request(app).get('/api/launches/live');
    const badRequest = await request(app).get('/api/supply/not-a-mint/total');
    const health = await request(app).get('/health');

    expect(data.status).toBe(200);
    expect(data.headers['cache-control']).toBe('private, max-age=30');
    expect(badRequest.status).toBe(400);
    expect(badRequest.headers['cache-control']).toBe('no-store');
    expect(health.headers['cache-control']).toBe('no-store');

    // Express also routes mixed-case and trailing-slash forms; they must not be cached either.
    for (const path of ['/API/Health/', '/Health/live']) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('compresses large responses for clients that accept it, and leaves small ones alone', async () => {
    const large = await request(app).get('/openapi.json').set('Accept-Encoding', 'gzip');
    const small = await request(app).get('/health').set('Accept-Encoding', 'gzip');
    const identity = await request(app).get('/openapi.json').set('Accept-Encoding', 'identity');

    expect(large.status).toBe(200);
    expect(large.headers['content-encoding']).toBe('gzip');
    expect(large.headers['vary']).toContain('Accept-Encoding');
    expect(large.body.openapi).toBe('3.1.0');
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(identity.headers['content-encoding']).toBeUndefined();
  });

  it('rejects a repeated query parameter with 400 instead of failing on an array', async () => {
    const res = await request(app).get('/dexscreener/asset?id=a&id=b');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUERY_PARAMETER');
  });

  it('answers CORS preflight directly, allowing the API key header', async () => {
    const res = await request(app)
      .options('/api/tickers')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Headers', 'x-api-key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toContain('X-API-Key');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization'); // /metrics bearer token
  });

  it('sends security headers and hides the framework', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('echoes a safe X-Request-Id and replaces an unsafe one', async () => {
    const safe = await request(app).get('/health').set('X-Request-Id', 'abc-123');
    const unsafe = await request(app).get('/health').set('X-Request-Id', 'a'.repeat(500));

    expect(safe.headers['x-request-id']).toBe('abc-123');
    expect(unsafe.headers['x-request-id']).not.toBe('a'.repeat(500));
  });

  it('answers 503 REQUEST_TIMEOUT when a handler does not respond in time', async () => {
    const original = config.server.requestTimeout;
    config.server.requestTimeout = 50;
    try {
      const hanging = createTestApp({
        launchpadService: { getLiveLaunches: () => new Promise(() => {}) } as unknown as LaunchpadService,
      });
      const res = await request(hanging).get('/api/launches/live');

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('REQUEST_TIMEOUT');
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      config.server.requestTimeout = original;
    }
  });

  it('drops a handler result or error that arrives after the timeout 503, and keeps serving', async () => {
    const original = config.server.requestTimeout;
    config.server.requestTimeout = 50;
    try {
      let settle: ((outcome: 'resolve' | 'reject') => void) | undefined;
      const launchpad = {
        getLiveLaunches: () => new Promise((resolve, reject) => {
          settle = (outcome) => outcome === 'resolve'
            ? resolve({ updatedAt: '2026-10-09T00:00:00.000Z', launches: [] })
            : reject(new Error('RPC failed late'));
        }),
      } as unknown as LaunchpadService;
      const slowApp = createTestApp({ launchpadService: launchpad });

      for (const outcome of ['resolve', 'reject'] as const) {
        const res = await request(slowApp).get('/api/launches/live');
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('REQUEST_TIMEOUT');
        settle!(outcome); // the handler finishes after its response already went out
        await Bun.sleep(10);
      }

      launchpad.getLiveLaunches = async () => ({ updatedAt: '2026-10-09T00:00:00.000Z', launches: [] });
      expect((await request(slowApp).get('/api/launches/live')).status).toBe(200);
    } finally {
      config.server.requestTimeout = original;
    }
  });

  it('never times out when SERVER_REQUEST_TIMEOUT is 0', async () => {
    const original = config.server.requestTimeout;
    config.server.requestTimeout = 0;
    try {
      const slowApp = createTestApp({
        launchpadService: {
          getLiveLaunches: () => Bun.sleep(60).then(() => ({ updatedAt: '2026-10-09T00:00:00.000Z', launches: [] })),
        } as unknown as LaunchpadService,
      });

      expect((await request(slowApp).get('/api/launches/live')).status).toBe(200);
    } finally {
      config.server.requestTimeout = original;
    }
  });
});
