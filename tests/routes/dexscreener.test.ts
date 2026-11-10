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
import { PublicKey } from '@solana/web3.js';

const BASE_MINT = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const QUOTE_MINT = new PublicKey(new Uint8Array(32).fill(2)).toBase58();

function decimalsService(baseDecimals = 6, quoteDecimals = 6, calls: string[] = []): FutarchyService {
  return {
    getTokenDecimals: async (mint: PublicKey) => {
      const address = mint.toBase58();
      calls.push(address);
      if (address === BASE_MINT) return baseDecimals;
      if (address === QUOTE_MINT) return quoteDecimals;
      throw new Error('Unexpected mint');
    },
  } as unknown as FutarchyService;
}

// Raw units reconstructed from the reported block 451277837 event.
const sanctumBuy = {
  signature: '4yWsBcQ2QDJ7bHAnptJbh84md7Ae2RxAuPAjHTfx9Tu2eWeF2EhyUKegJns3csMudSaHxGwZ11pQw3zEZsp52dMZ',
  slot: 451277837, unix_timestamp: '1790587475',
  dao_addr: 'CATL7SAzmnytyYmr9sVs92PQ2YDWowS3LN2xz3MMnB6H',
  user_addr: 'DCXBVytwaBxTaeDErhTKdMvAk246pvssPb9adc7BYaUt',
  base_mint: BASE_MINT, quote_mint: QUOTE_MINT,
  swap_type: 'buy', input_amount: '4767277', output_amount: '58706559303',
  amm_base_amount: '1407179424717063', amm_quote_amount: '113703642670',
};

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
      let metadataCalls = 0;
      const launchpadService = {
        getTokenAllocationBreakdown: async () => {
          allocationCalls++;
          throw new Error('RPC connection refused');
        },
      } as unknown as LaunchpadService;
      const app = createTestApp({
        futarchyService: {
          getTokenMetadata: async () => {
            metadataCalls++;
            return { name: 'Wrapped SOL', symbol: 'SOL' };
          },
          getTokenDecimals: async () => {
            metadataCalls++;
            return 9;
          },
        } as unknown as FutarchyService,
        launchpadService,
      });

      const first = await request(app).get('/dexscreener/asset').query({ id: VALID_MINT });
      const second = await request(app).get('/dexscreener/asset').query({ id: VALID_MINT });

      expect(first.status).toBe(503);
      expect(first.body.code).toBe('SUPPLY_UNAVAILABLE');
      expect(second.status).toBe(503);
      expect(allocationCalls).toBe(2);
      expect(metadataCalls).toBe(0);
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
          balanceSnapshotSlot: 100,
          mintSupplySnapshot: {
            amount: { toString: () => '1000000000000' },
            decimals: 6,
          },
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

    it('rejects numeric-prefix garbage instead of truncating it', async () => {
      const solanaService = {
        getSupplyInfo: async () => ({
          totalSupply: '123abc',
          circulatingSupply: '100',
        }),
      } as unknown as SolanaService;
      const app = createTestApp({
        futarchyService: assetMetadataService(),
        solanaService,
      });

      const response = await request(app).get('/dexscreener/asset').query({ id: VALID_MINT });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('SUPPLY_UNAVAILABLE');
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
      const app = createTestApp({
        externalDatabaseService: extDbReturning(rows.map(row => ({
          ...row, base_mint: BASE_MINT, quote_mint: QUOTE_MINT,
        }))),
        futarchyService: decimalsService(),
      });

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

    it('normalizes the reported Sanctum buy using nine base decimals and six quote decimals', async () => {
      const app = createTestApp({
        externalDatabaseService: extDbReturning([sanctumBuy]),
        futarchyService: decimalsService(9, 6),
      });
      const res = await request(app).get('/dexscreener/events')
        .query({ fromBlock: 451277837, toBlock: 451277837 });
      expect(res.status).toBe(200);
      expect(res.body.events).toEqual([{
        block: { blockNumber: 451277837, blockTimestamp: 1790587475 },
        eventType: 'swap', txnId: sanctumBuy.signature, txnIndex: 0, eventIndex: 0,
        maker: sanctumBuy.user_addr, pairId: sanctumBuy.dao_addr,
        asset1In: 4.767277, asset0Out: 58.706559303,
        priceNative: 0.08120518484816712,
        reserves: { asset0: 1407179.424717063, asset1: 113703.64267 },
      }]);
    });

    for (const [baseDecimals, quoteDecimals] of [[9, 6], [6, 9], [0, 6]] as const) {
      it(`normalizes sells with ${baseDecimals}/${quoteDecimals} decimals and omits absent reserves`, async () => {
        const app = createTestApp({
          externalDatabaseService: extDbReturning([{
            ...sanctumBuy, swap_type: 'sell',
            input_amount: String(10 * 10 ** baseDecimals),
            output_amount: String(2 * 10 ** quoteDecimals),
            amm_base_amount: null, amm_quote_amount: null,
          }]),
          futarchyService: decimalsService(baseDecimals, quoteDecimals),
        });
        const res = await request(app).get('/dexscreener/events').query({ fromBlock: 451277837, toBlock: 451277837 });
        expect(res.status).toBe(200);
        expect(res.body.events[0]).toMatchObject({ asset0In: 10, asset1Out: 2, priceNative: 0.2 });
        expect(res.body.events[0]).not.toHaveProperty('reserves');
      });
    }

    it('selects both mint identities in the bounded swaps query and normalizes sell reserves', async () => {
      const app = createTestApp({
        externalDatabaseService: {
          isAvailable: () => true,
          query: async (sql: string, params: unknown[]) => {
            const selection = sql.split('FROM futarchy.user_pool_swaps')[0]!;
            expect(selection).toContain('u.base_mint');
            expect(selection).toContain('u.quote_mint');
            expect(sql).toContain('u.slot >= $1 AND u.slot <= $2');
            expect(params).toEqual([451277837, 451277837]);
            return { rows: [{ ...sanctumBuy, swap_type: 'sell',
              input_amount: '58706559303', output_amount: '4767277' }] };
          },
        } as unknown as ExternalDatabaseService,
        futarchyService: decimalsService(9, 6),
      });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 451277837, toBlock: 451277837 });
      expect(res.status).toBe(200);
      expect(res.body.events[0]).toMatchObject({
        asset0In: 58.706559303, asset1Out: 4.767277, priceNative: 0.08120518484816712,
        reserves: { asset0: 1407179.424717063, asset1: 113703.64267 },
      });
    });

    it('uses each mint independently across mixed pairs and resolves each mint once per request', async () => {
      const calls: string[] = [];
      const app = createTestApp({
        externalDatabaseService: extDbReturning([
          sanctumBuy,
          { ...sanctumBuy, base_mint: QUOTE_MINT, quote_mint: BASE_MINT,
            input_amount: '2000000000', output_amount: '10000000',
            amm_base_amount: '100000000', amm_quote_amount: '20000000000' },
          { ...sanctumBuy, slot: 451277838 },
        ]),
        futarchyService: decimalsService(9, 6, calls),
      });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 451277837, toBlock: 451277838 });
      expect(res.status).toBe(200);
      expect(res.body.events[1]).toMatchObject({
        asset1In: 2, asset0Out: 10, priceNative: 0.2,
        reserves: { asset0: 100, asset1: 20 }, txnIndex: 0, eventIndex: 1,
      });
      expect(res.body.events[2]).toMatchObject({ asset0Out: 58.706559303, txnIndex: 0, eventIndex: 0 });
      expect(calls.sort()).toEqual([BASE_MINT, QUOTE_MINT].sort());
    });

    it('overlaps cold mint lookups without exceeding eight concurrent reads', async () => {
      let active = 0;
      let peak = 0;
      const calls: string[] = [];
      const rows = Array.from({ length: 12 }, (_, i) => ({
        ...sanctumBuy, base_mint: new PublicKey(new Uint8Array(32).fill(i + 3)).toBase58(),
      }));
      const app = createTestApp({
        externalDatabaseService: extDbReturning(rows),
        futarchyService: {
          getTokenDecimals: async (mint: PublicKey) => {
            calls.push(mint.toBase58());
            peak = Math.max(peak, ++active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            return 6;
          },
        } as unknown as FutarchyService,
      });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 451277837, toBlock: 451277837 });
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(12);
      expect(calls).toHaveLength(13);
      expect(new Set(calls).size).toBe(13);
      expect(peak).toBeGreaterThan(2);
      expect(peak).toBeLessThanOrEqual(8);
      expect(active).toBe(0);
    });

    for (const failedMint of [BASE_MINT, QUOTE_MINT]) {
      it(`fails the whole response when decimals cannot be loaded for ${failedMint}`, async () => {
        const app = createTestApp({
          externalDatabaseService: extDbReturning([sanctumBuy]),
          futarchyService: {
            getTokenDecimals: async (mint: PublicKey) => {
              if (mint.toBase58() === failedMint) throw new Error('RPC unavailable');
              return 6;
            },
          } as unknown as FutarchyService,
        });
        const res = await request(app).get('/dexscreener/events').query({ fromBlock: 451277837, toBlock: 451277837 });
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(res.body).not.toHaveProperty('events');
      });
    }

    it('returns an empty range without needing mint metadata', async () => {
      const app = createTestApp({ externalDatabaseService: extDbReturning([]) });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 0, toBlock: 1 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ events: [] });
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const app = createTestApp({
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 0, toBlock: 100 });
      expect(res.status).toBe(503);
    });

    it.each([' ', '0x10', '1e3', '-1', '1.5'])('rejects fromBlock=%p as not a slot, before querying', async (fromBlock) => {
      const app = createTestApp({ externalDatabaseService: extDbReturning([]) });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock, toBlock: 100 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_QUERY_PARAMETER', field: 'fromBlock' });
    });

    it('rejects an out-of-order block range', async () => {
      const app = createTestApp({ externalDatabaseService: extDbReturning([]) });
      const res = await request(app).get('/dexscreener/events').query({ fromBlock: 100, toBlock: 10 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /dexscreener/pair', () => {
    it('rejects a non-address id with 400 before querying the DB', async () => {
      let queried = false;
      const app = createTestApp({
        externalDatabaseService: {
          isAvailable: () => true,
          query: async () => { queried = true; return { rows: [] }; },
        } as unknown as ExternalDatabaseService,
      });
      const res = await request(app).get('/dexscreener/pair').query({ id: 'not-a-dao' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_QUERY_PARAMETER', field: 'id' });
      expect(queried).toBe(false);
    });
  });

  describe('GET /dexscreener/asset', () => {
    it('fails 5xx when supply cannot be loaded, and does not cache the failure', async () => {
      let supplyUp = false;
      const app = createTestApp({
        futarchyService: {
          getTokenMetadata: async () => ({ name: 'Token', symbol: 'TKN' }),
          getTokenDecimals: async () => 6,
        } as unknown as FutarchyService,
        solanaService: {
          getSupplyInfo: async () => {
            if (!supplyUp) throw new Error('RPC unavailable');
            return { totalSupply: '1000', circulatingSupply: '400' };
          },
        } as unknown as SolanaService,
      });

      const down = await request(app).get('/dexscreener/asset').query({ id: BASE_MINT });
      expect(down.status).toBeGreaterThanOrEqual(500);
      expect(down.body).not.toHaveProperty('asset');

      supplyUp = true;
      const up = await request(app).get('/dexscreener/asset').query({ id: BASE_MINT });
      expect(up.status).toBe(200);
      expect(up.body.asset).toMatchObject({ id: BASE_MINT, symbol: 'TKN', totalSupply: 1000, circulatingSupply: 400 });
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
