import { describe, it, expect } from 'bun:test';
import express, { Router } from 'express';
import request from 'supertest';
import { createTestApp, createTestServices } from '../helpers/testApp.js';
import { createServiceGetters } from '../../src/routes/types.js';
import { createApiRoutes } from '../../src/routes/index.js';
import type { LaunchpadService } from '../../src/services/launchpadService.js';

const launchpadService = {
  getLiveLaunches: async () => ({ updatedAt: '2026-10-09T00:00:00.000Z', launches: [] }),
} as unknown as LaunchpadService;
const app = createTestApp({ launchpadService });

describe('API versioning', () => {
  it('serves every data route under /v1 identically to its unversioned alias', async () => {
    for (const path of [
      '/api/launches/live',
      '/api/supply/So11111111111111111111111111111111111111112/total',
      '/cmc/assets',
      '/api/market-data?startDate=2026-01-01&endDate=2026-01-31',
    ]) {
      const unversioned = await request(app).get(path);
      const versioned = await request(app).get(`/v1${path}`);

      expect(unversioned.status).toBe(200);
      expect(versioned.status).toBe(unversioned.status);
      expect(versioned.body).toEqual(unversioned.body);
    }
  });

  it('keeps health, probe and metrics endpoints unversioned', async () => {
    expect((await request(app).get('/health/live')).status).toBe(200);
    expect((await request(app).get('/v1/health/live')).status).toBe(404);
    expect((await request(app).get('/v1/api/health')).status).toBe(404);
  });

  it('does not mark the current version or the alias as deprecated', async () => {
    for (const path of ['/v1/api/launches/live', '/api/launches/live']) {
      const res = await request(app).get(path);
      expect(res.headers.deprecation).toBeUndefined();
      expect(res.headers.sunset).toBeUndefined();
    }
  });

  describe('deprecation through the real mounts', () => {
    const deprecation = {
      since: new Date('2026-11-01T00:00:00Z'),
      sunset: new Date('2027-05-01T00:00:00Z'),
      successor: '/v2',
    };
    const v1Routes = () => {
      const r = Router();
      r.get('/api/tickers', (_req, res) => { res.json({ ok: true }); });
      return r;
    };
    const build = (versionDeprecated: boolean, aliasDeprecated: boolean) => {
      const services = createServiceGetters(createTestServices());
      const built = express();
      built.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
      built.use(createApiRoutes(
        services,
        [{ prefix: '/v1', createRoutes: v1Routes, ...(versionDeprecated ? { deprecation } : {}) }],
        { version: '/v1', ...(aliasDeprecated ? { deprecation } : {}) },
      ));
      return built;
    };

    it('stamps only the unversioned alias when only the alias is deprecated', async () => {
      const built = build(false, true);

      const legacy = await request(built).get('/api/tickers?x=1');
      expect(legacy.headers.deprecation).toBe('@1793491200');
      expect(legacy.headers.sunset).toBe('Sat, 01 May 2027 00:00:00 GMT');
      expect(legacy.headers.link).toBe('</v2/api/tickers?x=1>; rel="successor-version"');
      expect(legacy.headers['access-control-expose-headers']).toContain('Deprecation, Sunset, Link');

      for (const path of ['/v1/api/tickers', '/v1/no-such-route', '/health']) {
        const res = await request(built).get(path);
        expect(res.headers.deprecation).toBeUndefined();
        expect(res.headers.link).toBeUndefined();
      }
    });

    it('stamps only the version when only the version is deprecated', async () => {
      const built = build(true, false);

      const v1 = await request(built).get('/v1/api/tickers');
      expect(v1.headers.deprecation).toBe('@1793491200');
      expect(v1.headers.link).toBe('</v2/api/tickers>; rel="successor-version"');

      for (const path of ['/api/tickers', '/health']) {
        const res = await request(built).get(path);
        expect(res.headers.deprecation).toBeUndefined();
        expect(res.headers.link).toBeUndefined();
      }
    });
  });
});
