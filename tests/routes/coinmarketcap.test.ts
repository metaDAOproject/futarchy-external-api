import { describe, it, expect, afterEach } from 'bun:test';
import { createTestApp } from '../helpers/testApp.js';
import request from 'supertest';
import { config } from '../../src/config.js';
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

// Served DB whose 24h-metrics query throws (contract drift / query failure) — a
// financial feed must surface this as 5xx, never as an empty/partial 200.
function extDbThatThrows(): ExternalDatabaseService {
  return {
    isAvailable: () => true,
    getSpotRolling24hMetrics: async () => {
      throw new Error('query failed');
    },
  } as unknown as ExternalDatabaseService;
}

// Served DB that returns a corrupt (non-numeric) metric for an INCLUDED pair.
// `field` selects which one is poisoned so we can assert both volume and high/low
// fail closed identically.
function extDbWithMalformedMetric(field: 'base_volume_24h' | 'high_24h'): ExternalDatabaseService {
  const base: any = { token: 'BASE1', base_volume_24h: '10', target_volume_24h: '5', high_24h: '0.06', low_24h: '0.04', trade_count_24h: 1 };
  base[field] = 'not-a-number';
  return {
    isAvailable: () => true,
    getSpotRolling24hMetrics: async () => new Map([['BASE1', base]]),
  } as unknown as ExternalDatabaseService;
}

const DAOS = [dao('BASE1', 'USDC', 'DAOA'), dao('BASE2', 'USDC', 'DAOB')];

describe('CoinMarketCap Routes', () => {
  // The allowlist lives on the config singleton; a couple of tests mutate it, so
  // always reset to the default (empty = serve all) afterward.
  afterEach(() => {
    config.coinmarketcap.allowedMints.clear();
  });

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
      // Identity carried inline per CMC's Section C DEX spec, consistent with
      // /cmc/assets keyed by base_id/quote_id.
      expect(t.base_symbol).toBe('BASE1SYM');
      expect(t.base_name).toBe('BASE1 Name');
      expect(t.quote_symbol).toBe('USDC');
      expect(t.quote_name).toBe('USD Coin');
      expect(t.last_price).toBe(0.05);
      expect(t.base_volume).toBe(100);
      expect(t.quote_volume).toBe(5);
      expect(t.isFrozen).toBe(0);
    });

    it('falls back to a mint prefix for inline symbol/name when metadata is missing', async () => {
      // A DAO whose base metadata never resolved on-chain: baseSymbol/baseName
      // undefined. The ticker must still emit a non-empty string (CMC marks these
      // mandatory) and match what /cmc/assets reports for the same mint.
      const noMeta = {
        daoAddress: pk('DAOC'),
        baseMint: pk('BASENOMETA1234567890'),
        quoteMint: pk('USDC'),
        baseDecimals: 6,
        quoteDecimals: 6,
        baseSymbol: undefined,
        baseName: undefined,
        quoteSymbol: 'USDC',
        quoteName: 'USD Coin',
        poolData: { baseReserves: {}, quoteReserves: {}, baseProtocolFees: {}, quoteProtocolFees: {} },
      } as unknown as DaoTickerData;

      const app = createTestApp({
        futarchyService: futarchyReturning([noMeta]),
        externalDatabaseService: extDbWithMetrics(),
      });

      const tRes = await request(app).get('/cmc/ticker');
      const t = tRes.body['BASENOMETA1234567890_USDC'];
      expect(t.base_symbol).toBe('BASENOME');
      expect(t.base_name).toBe('BASENOME');

      const aRes = await request(app).get('/cmc/assets');
      expect(aRes.body['BASENOMETA1234567890'].symbol).toBe(t.base_symbol);
      expect(aRes.body['BASENOMETA1234567890'].name).toBe(t.base_name);
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

  describe('served-DB failure semantics (never a partial 200)', () => {
    it('/cmc/summary surfaces a 24h-metrics query failure as 5xx with no feed body', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbThatThrows(),
      });
      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(Array.isArray(res.body)).toBe(false);
    });

    it('/cmc/ticker surfaces a 24h-metrics query failure as 5xx', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbThatThrows(),
      });
      const res = await request(app).get('/cmc/ticker');
      expect(res.status).toBeGreaterThanOrEqual(500);
    });

    it('/cmc/summary surfaces malformed ETL volume for an included pair as 5xx', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning([dao('BASE1', 'USDC', 'DAOA')]),
        externalDatabaseService: extDbWithMalformedMetric('base_volume_24h'),
      });
      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('CMC_MALFORMED_METRIC');
    });

    it('/cmc/summary surfaces a malformed non-zero 24h high as 5xx (not a silent omit)', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning([dao('BASE1', 'USDC', 'DAOA')]),
        externalDatabaseService: extDbWithMalformedMetric('high_24h'),
      });
      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('CMC_MALFORMED_METRIC');
    });
  });

  describe('API versioning (/cmc/v1 alias)', () => {
    // CMC asked for a versioned URL. The /cmc/v1/* paths must be exact aliases of
    // the unversioned handlers — same body, same status, same failure semantics.
    it('serves /cmc/v1/summary identically to /cmc/summary', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbWithMetrics(),
      });

      const unversioned = await request(app).get('/cmc/summary');
      const versioned = await request(app).get('/cmc/v1/summary');
      expect(versioned.status).toBe(200);
      expect(versioned.body).toEqual(unversioned.body);
    });

    it('serves /cmc/v1/ticker identically to /cmc/ticker', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbWithMetrics(),
      });

      const unversioned = await request(app).get('/cmc/ticker');
      const versioned = await request(app).get('/cmc/v1/ticker');
      expect(versioned.status).toBe(200);
      expect(versioned.body).toEqual(unversioned.body);
    });

    it('serves /cmc/v1/assets identically to /cmc/assets', async () => {
      const app = createTestApp({ futarchyService: futarchyReturning(DAOS) });

      const unversioned = await request(app).get('/cmc/assets');
      const versioned = await request(app).get('/cmc/v1/assets');
      expect(versioned.status).toBe(200);
      expect(versioned.body).toEqual(unversioned.body);
    });

    it('preserves fail-closed semantics on the versioned path (503 when served DB is down)', async () => {
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const res = await request(app).get('/cmc/v1/summary');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SERVED_DB_UNAVAILABLE');
    });
  });

  describe('CMC_ALLOWED_MINTS filtering', () => {
    it('serves only allowlisted base mints when the allowlist is set', async () => {
      config.coinmarketcap.allowedMints.add('BASE1');
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbWithMetrics(),
      });

      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].trading_pairs).toBe('BASE1_USDC');

      // /cmc/assets respects the same allowlist (only BASE1 + its quote).
      const assets = await request(app).get('/cmc/assets');
      expect(Object.keys(assets.body).sort()).toEqual(['BASE1', 'USDC']);
    });

    it('fails closed (503) when the allowlist matches zero discovered DAOs', async () => {
      config.coinmarketcap.allowedMints.add('NOTADISCOVEREDMINT');
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbWithMetrics(),
      });

      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CMC_ALLOWLIST_NO_MATCH');

      // Same fail-closed behavior on the DB-free /cmc/assets route.
      const assets = await request(app).get('/cmc/assets');
      expect(assets.status).toBe(503);
    });

    it('fails closed (503) when ONE of several allowlisted mints is missing (partial)', async () => {
      // BASE1 IS discovered, BASE_GONE is not — a partial match must not serve a
      // BASE1-only 200 that reads as "BASE_GONE delisted".
      config.coinmarketcap.allowedMints.add('BASE1');
      config.coinmarketcap.allowedMints.add('BASE_GONE');
      const app = createTestApp({
        futarchyService: futarchyReturning(DAOS),
        externalDatabaseService: extDbWithMetrics(),
      });

      const res = await request(app).get('/cmc/summary');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('CMC_ALLOWLIST_NO_MATCH');
    });
  });
});
