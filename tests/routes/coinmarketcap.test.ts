import { describe, it, expect } from 'bun:test';
import { createTestApp } from '../helpers/testApp.js';
import request from 'supertest';
import type { FutarchyService, DaoTickerData } from '../../src/services/futarchyService.js';
import type { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';

// Minimal DAO stand-ins: buildPairs only ever calls `.toString()` on the pubkey
// fields and reads decimals/poolData, and the mock PriceService (testApp) ignores
// the reserve values, so a plain object with a toString() is enough.
function pk(v: string) {
  return { toString: () => v } as any;
}

function dao(base: string, quote: string, addr: string): DaoTickerData {
  return {
    daoAddress: pk(addr),
    baseMint: pk(base),
    quoteMint: pk(quote),
    baseDecimals: 6,
    quoteDecimals: 6,
    baseSymbol: `${base}SYM`,
    baseName: `${base} Name`,
    quoteSymbol: 'USDC',
    quoteName: 'USD Coin',
    poolData: { baseReserves: {}, quoteReserves: {}, baseProtocolFees: {}, quoteProtocolFees: {} },
  } as unknown as DaoTickerData;
}

function futarchyReturning(daos: DaoTickerData[]): FutarchyService {
  return { getAllDaos: async () => daos } as unknown as FutarchyService;
}

// getSpotRolling24hMetrics is keyed by base mint (token). BASE1 has real 24h
// high/low; BASE2 carries the '0' no-data sentinel so we assert high/low are
// omitted rather than reported as 0.
function extDbWithMetrics(): ExternalDatabaseService {
  return {
    isAvailable: () => true,
    getSpotRolling24hMetrics: async () =>
      new Map([
        ['BASE1', { token: 'BASE1', base_volume_24h: '100', target_volume_24h: '5', high_24h: '0.06', low_24h: '0.04', trade_count_24h: 3 }],
        ['BASE2', { token: 'BASE2', base_volume_24h: '0', target_volume_24h: '0', high_24h: '0', low_24h: '0', trade_count_24h: 0 }],
      ]),
  } as unknown as ExternalDatabaseService;
}

const DAOS = [dao('BASE1', 'USDC', 'DAOA'), dao('BASE2', 'USDC', 'DAOB')];

describe('CoinMarketCap Routes', () => {
  describe('GET /cmc/summary', () => {
    it('returns a 24h summary array with price, spread, and volume per pair', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbWithMetrics(),
      });

      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);

      const a = res.body.find((p: any) => p.trading_pairs === 'BASE1_USDC');
      expect(a.base_currency).toBe('BASE1');
      expect(a.quote_currency).toBe('USDC');
      expect(a.type).toBe('spot');
      expect(a.last_price).toBe(0.05);
      // Mock PriceService spread → bid 0.04975 / ask 0.05025.
      expect(a.lowest_ask).toBe(0.05025);
      expect(a.highest_bid).toBe(0.04975);
      expect(a.base_volume).toBe(100);
      expect(a.quote_volume).toBe(5);
      expect(a.highest_price_24h).toBe(0.06);
      expect(a.lowest_price_24h).toBe(0.04);

      // BASE2 has the '0' no-data sentinel → high/low omitted, volume 0.
      const b = res.body.find((p: any) => p.trading_pairs === 'BASE2_USDC');
      expect(b.base_volume).toBe(0);
      expect(b).not.toHaveProperty('highest_price_24h');
      expect(b).not.toHaveProperty('lowest_price_24h');
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SERVED_DB_UNAVAILABLE');
    });
  });

  describe('GET /cmc/ticker', () => {
    it('returns an object keyed by BASE_QUOTE with base/quote ids and isFrozen', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbWithMetrics(),
      });

      const res = await request(app).get('/cmc/ticker');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['BASE1_USDC', 'BASE2_USDC']);

      const t = res.body['BASE1_USDC'];
      expect(t.base_id).toBe('BASE1');
      expect(t.quote_id).toBe('USDC');
      expect(t.last_price).toBe(0.05);
      expect(t.base_volume).toBe(100);
      expect(t.quote_volume).toBe(5);
      expect(t.isFrozen).toBe(0);
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const res = await request(app).get('/cmc/ticker');
      expect(res.status).toBe(503);
    });
  });

  describe('GET /cmc/assets', () => {
    it('returns token identity keyed by mint, deduping the shared quote', async () => {
      const app = createTestApp({ futarchyService: futarchyReturning(DAOS) });

      const res = await request(app).get('/cmc/assets');
      expect(res.status).toBe(200);
      // BASE1, BASE2, and a single shared USDC entry.
      expect(Object.keys(res.body).sort()).toEqual(['BASE1', 'BASE2', 'USDC']);

      expect(res.body['BASE1'].symbol).toBe('BASE1SYM');
      expect(res.body['BASE1'].name).toBe('BASE1 Name');
      expect(res.body['BASE1'].contractAddress).toBe('BASE1');
      expect(res.body['BASE1'].can_withdraw).toBe('true');
      expect(res.body['USDC'].symbol).toBe('USDC');
    });

    it('does NOT require the served DB (pure on-chain metadata)', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const res = await request(app).get('/cmc/assets');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toContain('BASE1');
    });
  });
});
