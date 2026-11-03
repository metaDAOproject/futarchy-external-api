import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';
import type { FutarchyService } from '../../src/services/futarchyService.js';
import type { LaunchpadService, LiveLaunch } from '../../src/services/launchpadService.js';

const launch: LiveLaunch = {
  launchAddress: '5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE',
  version: 'v0.7',
  tokenAddress: 'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta',
  quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  quoteDecimals: 6,
  committerCount: 2,
  totalCommitted: '251.5',
  totalCommittedRaw: '251500000',
  minimumRaise: '500000',
  minimumRaiseRaw: '500000000000',
  closeTime: 1_800_000_000,
};

const launchpadService = {
  getLiveLaunches: async () => ({ updatedAt: '2026-10-09T00:00:00.000Z', launches: [launch] }),
} as unknown as LaunchpadService;

describe('GET /api/launches/live', () => {
  it('returns each live launch with its token name and symbol', async () => {
    const futarchyService = {
      getTokenMetadata: async () => ({ name: 'Solomon', symbol: 'SOLO' }),
    } as unknown as FutarchyService;
    const app = createTestApp({ launchpadService, futarchyService });

    const res = await request(app).get('/api/launches/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      count: 1,
      updatedAt: '2026-10-09T00:00:00.000Z',
      launches: [{ ...launch, tokenName: 'Solomon', tokenSymbol: 'SOLO' }],
    });
  });

  it('serves null name/symbol when the token has no metadata', async () => {
    const futarchyService = { getTokenMetadata: async () => null } as unknown as FutarchyService;
    const app = createTestApp({ launchpadService, futarchyService });

    const res = await request(app).get('/api/launches/live');

    expect(res.status).toBe(200);
    expect(res.body.launches[0]).toMatchObject({ tokenName: null, tokenSymbol: null });
  });
});
