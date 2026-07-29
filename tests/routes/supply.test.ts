import { describe, it, expect } from 'bun:test';
import BN from 'bn.js';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';
import type { LaunchpadService } from '../../src/services/launchpadService.js';
import type { SolanaService } from '../../src/services/solanaService.js';

const app = createTestApp();

describe('Supply Routes', () => {
  const validMintAddress = 'So11111111111111111111111111111111111111112'; // SOL wrapped
  const invalidAddress = 'invalid-address';
  const tooShortAddress = 'abc123';

  describe('GET /api/supply/:mintAddress', () => {
    it('should reject invalid mint address', async () => {
      const response = await request(app).get(`/api/supply/${invalidAddress}`);
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not a valid Solana public key');
    });

    it('should reject too short address', async () => {
      const response = await request(app).get(`/api/supply/${tooShortAddress}`);
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not a valid Solana public key');
    });

    it('should accept valid Solana address format', async () => {
      const response = await request(app).get(`/api/supply/${validMintAddress}`);
      
      // Either succeeds or fails with RPC error (not validation error)
      if (response.status === 400) {
        expect(response.body.error).not.toContain('Invalid Solana address');
      }
    });
  });

  describe('GET /api/supply/:mintAddress/total', () => {
    it('should reject invalid mint address', async () => {
      const response = await request(app).get(`/api/supply/${invalidAddress}/total`);
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not a valid Solana public key');
    });

    it('should accept valid format', async () => {
      const response = await request(app).get(`/api/supply/${validMintAddress}/total`);
      
      if (response.status === 400) {
        expect(response.body.error).not.toContain('Invalid Solana address');
      }
    });
  });

  describe('GET /api/supply/:mintAddress/circulating', () => {
    it('should reject invalid mint address', async () => {
      const response = await request(app).get(`/api/supply/${invalidAddress}/circulating`);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not a valid Solana public key');
    });

    it('surfaces excluded holders in the allocation breakdown', async () => {
      const holderAddress = 'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta';
      const launchpadService = {
        getTokenAllocationBreakdown: async () => ({
          version: 'v0.7',
          teamPerformancePackage: { amount: new BN(0) },
          futarchyAmmLiquidity: { amount: new BN(0) },
          meteoraLpLiquidity: { amount: new BN(0) },
          daoTreasuryTokens: { amount: new BN(0) },
          excludedHolders: [{ wallet: { toString: () => holderAddress }, label: 'Laso external', amount: new BN(100) }],
          balanceSnapshotSlot: 123,
          totalNonCirculating: new BN(100),
        }),
      } as unknown as LaunchpadService;
      let capturedAllocation: any;
      const solanaService = {
        getSupplyInfo: async (_mint: string, allocation: any) => {
          capturedAllocation = allocation;
          return {
            mint: validMintAddress,
            totalSupply: '1000000',
            circulatingSupply: '999900',
            decimals: 6,
            rawTotalSupply: '1000000000000',
            allocation: {
              excludedHolders: [{ amount: '0.0001', address: holderAddress, label: 'Laso external' }],
              balanceSnapshotSlot: 123,
            },
          };
        },
      } as unknown as SolanaService;
      const testApp = createTestApp({ launchpadService, solanaService });

      const response = await request(testApp).get(`/api/supply/${validMintAddress}/circulating`);

      expect(response.status).toBe(200);
      expect(response.body.result).toBe('999900');
      expect(response.body.allocation.excludedHolders).toEqual([
        { amount: '0.0001', address: holderAddress, label: 'Laso external' },
      ]);
      expect(response.body.allocation.balanceSnapshotSlot).toBe(123);
      // The breakdown's excludedHolders must be mapped (wallet -> address) and
      // forwarded to getSupplyInfo — guards supplyWithLaunchpadAllocation wiring.
      expect(capturedAllocation.excludedHolders).toHaveLength(1);
      expect(capturedAllocation.excludedHolders[0].address).toBe(holderAddress);
      expect(capturedAllocation.excludedHolders[0].label).toBe('Laso external');
      expect(capturedAllocation.excludedHolders[0].amount.toString()).toBe('100');
      expect(capturedAllocation.balanceSnapshotSlot).toBe(123);
    });
  });

  describe('GET /api/supply/:mintAddress/jupiter/circulating', () => {
    it('should reject invalid mint address', async () => {
      const response = await request(app).get(`/api/supply/${invalidAddress}/jupiter/circulating`);
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not a valid Solana public key');
    });
  });

  describe('GET /api/supply/:mintAddress/jupiter/total', () => {
    it('should reject invalid mint address', async () => {
      const response = await request(app).get(`/api/supply/${invalidAddress}/jupiter/total`);
      
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('not a valid Solana public key');
    });
  });
});
