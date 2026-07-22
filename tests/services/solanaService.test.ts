/**
 * Unit tests for SolanaService.getSupplyInfo circulating-supply math, focused on
 * the MET-570 excluded-holders exclusion. RPC is bypassed by overriding the
 * private withRetry wrapper (which normally runs getMint), so no network is hit.
 */

import { describe, it, expect } from 'bun:test';
import BN from 'bn.js';
import { SolanaService } from '../../src/services/solanaService.js';
import type { TokenAllocationInput } from '../../src/services/solanaService.js';

const MINT = 'So11111111111111111111111111111111111111112';
const HOLDER_A = 'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta';
const HOLDER_B = 'DMB74TZgN7Rqfwtqqm3VQBgKBb2WYPdBqVtHbvB4LLeV';

const DECIMALS = 6;
const ONE = new BN(10).pow(new BN(DECIMALS));
// 1,000,000 tokens total supply (raw = 1e6 * 1e6).
const TOTAL_RAW = new BN(1_000_000).mul(ONE);

function serviceWithSupply(rawSupply: BN): SolanaService {
  const svc = new SolanaService();
  // withRetry normally executes () => getMint(...); short-circuit it to a fake mint.
  (svc as any).withRetry = async () => ({
    supply: BigInt(rawSupply.toString()),
    decimals: DECIMALS,
  });
  return svc;
}

const baseAllocation = (): TokenAllocationInput => ({
  teamPerformancePackage: { amount: new BN(0) },
  futarchyAmmLiquidity: { amount: new BN(0) },
  meteoraLpLiquidity: { amount: new BN(0) },
});

describe('SolanaService.getSupplyInfo — excluded holders', () => {
  it('subtracts configured excluded-holder balances from circulating supply', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      excludedHolders: [
        { address: HOLDER_A, label: 'external', amount: new BN(100_000).mul(ONE) },
        { address: HOLDER_B, label: 'vesting', amount: new BN(50_000).mul(ONE) },
      ],
    });

    expect(info.totalSupply).toBe('1000000');
    // 1,000,000 - 100,000 - 50,000 = 850,000
    expect(info.circulatingSupply).toBe('850000');
    expect(info.allocation?.excludedHolders).toEqual([
      { amount: '100000', address: HOLDER_A, label: 'external' },
      { amount: '50000', address: HOLDER_B, label: 'vesting' },
    ]);
  });

  it('omits zero-balance holders from the response but keeps the total accurate', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      excludedHolders: [
        { address: HOLDER_A, label: 'external', amount: new BN(100_000).mul(ONE) },
        { address: HOLDER_B, label: 'empty', amount: new BN(0) },
      ],
    });

    expect(info.circulatingSupply).toBe('900000');
    expect(info.allocation?.excludedHolders).toEqual([
      { amount: '100000', address: HOLDER_A, label: 'external' },
    ]);
  });

  it('leaves circulating == total when no excluded holders are passed', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(MINT, baseAllocation());

    expect(info.circulatingSupply).toBe('1000000');
    expect(info.allocation?.excludedHolders).toBeUndefined();
  });

  it('clamps circulating supply to 0 rather than going negative', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(2_000_000).mul(ONE) },
      ],
    });

    expect(info.circulatingSupply).toBe('0');
  });
});
