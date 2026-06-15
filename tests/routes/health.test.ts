import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp, createMockExternalDatabaseService } from '../helpers/testApp.js';
import type { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';

const app = createTestApp();

describe('Health Routes', () => {
  describe('GET /health (liveness)', () => {
    it('should return 200 with healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
    });

    it('should include timestamp', async () => {
      const response = await request(app).get('/health');

      expect(response.body.timestamp).toBeDefined();
      expect(new Date(response.body.timestamp).getTime()).not.toBeNaN();
    });

    it('should include uptime', async () => {
      const response = await request(app).get('/health');

      expect(response.body.uptime).toBeDefined();
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/health (readiness)', () => {
    it('reports healthy with served DB connected, contract ok, and freshness', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.servedDatabase.connected).toBe(true);
      expect(response.body.servedDatabase.servedDataContract.ok).toBe(true);
      expect(response.body.servedDatabase.freshness.ageSeconds).toBe(30);
      expect(response.body.servedDatabase.freshness.latestSwapAt).toBeDefined();
    });

    it('reports degraded when the served DB is not connected', async () => {
      const extDb = {
        ...createMockExternalDatabaseService(),
        isAvailable: () => false,
      } as unknown as ExternalDatabaseService;
      const degradedApp = createTestApp({ externalDatabaseService: extDb });

      const response = await request(degradedApp).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('degraded');
      expect(response.body.servedDatabase.connected).toBe(false);
      expect(response.body.servedDatabase.servedDataContract.missing).toContain('connection');
      expect(response.body.message).toContain('not connected');
    });

    it('reports degraded when the served data contract check fails', async () => {
      const extDb = {
        ...createMockExternalDatabaseService(),
        checkServedDataContract: async () => ({
          ok: false,
          checkedAt: new Date().toISOString(),
          missing: ['futarchy.user_pool_swaps.inner_group'],
        }),
      } as unknown as ExternalDatabaseService;
      const degradedApp = createTestApp({ externalDatabaseService: extDb });

      const response = await request(degradedApp).get('/api/health');

      expect(response.body.status).toBe('degraded');
      expect(response.body.message).toContain('contract');
    });

    it('reports degraded when the freshness query fails (never masks a failure)', async () => {
      const extDb = {
        ...createMockExternalDatabaseService(),
        getServedDataFreshness: async () => {
          throw new Error('query failed');
        },
      } as unknown as ExternalDatabaseService;
      const degradedApp = createTestApp({ externalDatabaseService: extDb });

      const response = await request(degradedApp).get('/api/health');

      expect(response.body.status).toBe('degraded');
      expect(response.body.servedDatabase.freshness).toBeNull();
      expect(response.body.message).toContain('freshness');
    });
  });
});
