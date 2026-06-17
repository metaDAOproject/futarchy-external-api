/**
 * Failure-path contract tests for the financial endpoints.
 *
 * The serving invariant: an infrastructure failure (RPC down, DB query error)
 * must surface as a 5xx — NEVER as a 200 with zero/total/empty data that a
 * consumer would read as real market data. These tests pin that behavior for
 * every financial route so a future refactor can't silently reintroduce a
 * swallow-and-default path.
 */

import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp, createMockExternalDatabaseService } from '../helpers/testApp.js';
import type { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';
import type { LaunchpadService } from '../../src/services/launchpadService.js';
import type { SolanaService } from '../../src/services/solanaService.js';

const VALID_MINT = 'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta';

function failingExtDb(overrides: Partial<ExternalDatabaseService>): ExternalDatabaseService {
  return {
    ...createMockExternalDatabaseService(),
    ...overrides,
  } as unknown as ExternalDatabaseService;
}

describe('Financial endpoint failure paths (infra failure → 5xx, never fake data)', () => {
  describe('/api/supply/:mint/circulating', () => {
    it('returns 500 when the allocation breakdown fails (RPC outage), not circulating=total', async () => {
      const launchpadService = {
        getTokenAllocationBreakdown: async () => {
          throw new Error('RPC connection refused');
        },
      } as unknown as LaunchpadService;
      const app = createTestApp({ launchpadService });

      const res = await request(app).get(`/api/supply/${VALID_MINT}/circulating`);

      expect(res.status).toBe(500);
      expect(res.body).not.toHaveProperty('result');
    });

    it('returns 500 when the mint supply fetch fails', async () => {
      const solanaService = {
        getSupplyInfo: async () => {
          throw new Error('RPC timeout');
        },
        getTotalSupply: async () => {
          throw new Error('RPC timeout');
        },
      } as unknown as SolanaService;
      const app = createTestApp({ solanaService });

      const res = await request(app).get(`/api/supply/${VALID_MINT}/circulating`);

      expect(res.status).toBe(500);
    });
  });

  describe('/api/supply/:mint/total', () => {
    it('returns 500 when the RPC fetch fails', async () => {
      const solanaService = {
        getTotalSupply: async () => {
          throw new Error('RPC timeout');
        },
      } as unknown as SolanaService;
      const app = createTestApp({ solanaService });

      const res = await request(app).get(`/api/supply/${VALID_MINT}/total`);

      expect(res.status).toBe(500);
      expect(res.body).not.toHaveProperty('result');
    });
  });

  describe('/api/tickers', () => {
    it('returns 5xx when the 24h metrics query fails (a failed query is not "zero volume")', async () => {
      const externalDatabaseService = failingExtDb({
        getSpotRolling24hMetrics: async () => {
          throw new Error('relation does not exist');
        },
      });
      const app = createTestApp({ externalDatabaseService });

      const res = await request(app).get('/api/tickers');

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(Array.isArray(res.body)).toBe(false);
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const externalDatabaseService = failingExtDb({ isAvailable: () => false });
      const app = createTestApp({ externalDatabaseService });

      const res = await request(app).get('/api/tickers');

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SERVED_DB_UNAVAILABLE');
    });
  });

  describe('/api/market-data', () => {
    it('returns 500 when the daily-activity query fails, with no partial data', async () => {
      const externalDatabaseService = failingExtDb({
        getFutarchyAmmDailyActivity: async () => {
          throw new Error('query failed');
        },
      });
      const app = createTestApp({ externalDatabaseService });

      const res = await request(app)
        .get('/api/market-data')
        .query({ startDate: '2026-01-01', endDate: '2026-01-31' });

      expect(res.status).toBe(500);
      expect(res.body).not.toHaveProperty('futarchyAMM');
      // No raw SQL/schema detail leaks to the client
      expect(JSON.stringify(res.body)).not.toContain('query failed');
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const externalDatabaseService = failingExtDb({ isAvailable: () => false });
      const app = createTestApp({ externalDatabaseService });

      const res = await request(app)
        .get('/api/market-data')
        .query({ startDate: '2026-01-01', endDate: '2026-01-31' });

      expect(res.status).toBe(503);
    });
  });

  describe('/dexscreener/events', () => {
    it('returns 5xx when the swaps query fails (a failed query is not "no events")', async () => {
      const externalDatabaseService = failingExtDb({
        query: async () => {
          throw new Error('connection terminated');
        },
      } as Partial<ExternalDatabaseService>);
      const app = createTestApp({ externalDatabaseService });

      const res = await request(app)
        .get('/dexscreener/events')
        .query({ fromBlock: 0, toBlock: 100 });

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toHaveProperty('events');
    });
  });
});
