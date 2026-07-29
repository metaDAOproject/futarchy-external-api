import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';
import type { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';
import type { FutarchyService } from '../../src/services/futarchyService.js';
import type { LaunchpadService } from '../../src/services/launchpadService.js';
import type { SolanaService } from '../../src/services/solanaService.js';

const VALID_MINT = 'So11111111111111111111111111111111111111112';

function assetMetadataService(): FutarchyService {
  return {
    getTokenMetadata: async () => ({ name: 'Wrapped SOL', symbol: 'SOL' }),
    getTokenDecimals: async () => 9,
  } as unknown as FutarchyService;
}

// Stub the served DB with canned user_pool_swaps-shaped rows (the aliased column
// shape the migrated /events SQL returns) so we test the event-building transform:
// buy/sell leg mapping, priceNative, reserves, and txnIndex/eventIndex grouping.
function extDbReturning(rows: any[]): ExternalDatabaseService {
  return {
    isAvailable: () => true,
    query: async (text: string) => {
      if (/ORDER BY slot DESC/i.test(text)) {
        return { rows: [{ slot: 999, unix_timestamp: '1700000999' }] } as any;
      }
      return { rows } as any; // /events
    },
  } as unknown as ExternalDatabaseService;
}

describe('DexScreener Routes', () => {
  describe('GET /dexscreener/asset', () => {
    it('returns 503 and does not cache a failed supply read', async () => {
      let allocationCalls = 0;
      const launchpadService = {
        getTokenAllocationBreakdown: async () => {
          allocationCalls++;
          throw new Error('RPC connection refused');
        },
      } as unknown as LaunchpadService;
      const app = createTestApp({
        futarchyService: assetMetadataService(),
        launchpadService,
      });

      const first = await request(app).get('/dexscreener/asset').query({ id: VALID_MINT });
      const second = await request(app).get('/dexscreener/asset').query({ id: VALID_MINT });

      expect(first.status).toBe(503);
      expect(first.body.code).toBe('SUPPLY_UNAVAILABLE');
      expect(second.status).toBe(503);
      expect(allocationCalls).toBe(2);
    });

    it('returns complete supply data when the allocation snapshot succeeds', async () => {
      const launchpadService = {
        getTokenAllocationBreakdown: async () => ({
          version: 'v0.7',
          teamPerformancePackage: { amount: { toString: () => '0' } },
          futarchyAmmLiquidity: { amount: { toString: () => '0' } },
          meteoraLpLiquidity: { amount: { toString: () => '0' } },
          daoTreasuryTokens: { amount: { toString: () => '0' } },
          excludedHolders: [],
          totalNonCirculating: { toString: () => '0' },
        }),
      } as unknown as LaunchpadService;
      const solanaService = {
        getSupplyInfo: async () => ({
          totalSupply: '1000000',
          circulatingSupply: '875000',
        }),
      } as unknown as SolanaService;
      const app = createTestApp({
        futarchyService: assetMetadataService(),
        launchpadService,
        solanaService,
      });

      const response = await request(app).get('/dexscreener/asset').query({ id: VALID_MINT });

      expect(response.status).toBe(200);
      expect(response.body.asset).toMatchObject({
        id: VALID_MINT,
        name: 'Wrapped SOL',
        symbol: 'SOL',
        totalSupply: 1000000,
        circulatingSupply: 875000,
        metadata: { decimals: '9' },
      });
    });
  });

  describe('GET /dexscreener/events', () => {
    it('maps buy/sell legs, price, reserves, and txn/event indices from user_pool_swaps', async () => {
      // Two swaps in one signature (same txn → eventIndex 0,1), one in a second txn.
      const rows = [
        { id: 1, signature: 'SIGA', slot: 10, unix_timestamp: '1700', dao_addr: 'DAO1', user_addr: 'U1',
          swap_type: 'buy',  input_amount: '2000000',  output_amount: '40000000',
          amm_base_amount: '1000000000', amm_quote_amount: '50000000' },
        { id: 2, signature: 'SIGA', slot: 10, unix_timestamp: '1700', dao_addr: 'DAO1', user_addr: 'U1',
          swap_type: 'sell', input_amount: '10000000', output_amount: '500000',
          amm_base_amount: '1010000000', amm_quote_amount: '49500000' },
        // Same slot as SIGA, new signature → txnIndex increments, eventIndex resets.
        { id: 3, signature: 'SIGB', slot: 10, unix_timestamp: '1700', dao_addr: 'DAO1', user_addr: 'U2',
          swap_type: 'buy',  input_amount: '1000000',  output_amount: '20000000',
          amm_base_amount: '990000000', amm_quote_amount: '50500000' },
      ];
      const app = createTestApp({ externalDatabaseService: extDbReturning(rows) });

      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 0, toBlock: 100 });
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(3);

      const [buy, sell, buy2] = res.body.events;

      // Buy: USDC in (asset1In), token out (asset0Out); price = USDC/token = 2/40 = 0.05
      expect(buy.eventType).toBe('swap');
      expect(buy.txnId).toBe('SIGA');
      expect(buy.txnIndex).toBe(0);
      expect(buy.eventIndex).toBe(0);
      expect(buy.maker).toBe('U1');
      expect(buy.pairId).toBe('DAO1');
      expect(buy.asset1In).toBe(2);
      expect(buy.asset0Out).toBe(40);
      expect(buy.priceNative).toBeCloseTo(0.05, 9);
      expect(buy.reserves).toEqual({ asset0: 1000, asset1: 50 });

      // Second swap in the SAME signature → same txnIndex, eventIndex increments.
      expect(sell.txnId).toBe('SIGA');
      expect(sell.txnIndex).toBe(0);
      expect(sell.eventIndex).toBe(1);
      // Sell: token in (asset0In=10), USDC out (asset1Out=0.5); price = USDC/token = 0.5/10 = 0.05
      expect(sell.asset0In).toBe(10);
      expect(sell.asset1Out).toBe(0.5);
      expect(sell.priceNative).toBeCloseTo(0.05, 9);
      expect(sell.reserves).toEqual({ asset0: 1010, asset1: 49.5 });

      // New signature in the SAME slot → txnIndex increments, eventIndex resets.
      expect(buy2.txnId).toBe('SIGB');
      expect(buy2.txnIndex).toBe(1);
      expect(buy2.eventIndex).toBe(0);
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const app = createTestApp({
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 0, toBlock: 100 });
      expect(res.status).toBe(503);
    });

    it('rejects an out-of-order block range', async () => {
      const app = createTestApp({ externalDatabaseService: extDbReturning([]) });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 100, toBlock: 10 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /dexscreener/latest-block', () => {
    it('returns the latest block from user_pool_swaps', async () => {
      const app = createTestApp({ externalDatabaseService: extDbReturning([]) });
      const res = await request(app).get('/dexscreener/latest-block');
      expect(res.status).toBe(200);
      expect(res.body.block.blockNumber).toBe(999);
      expect(res.body.block.blockTimestamp).toBe(1700000999);
    });
  });
});
