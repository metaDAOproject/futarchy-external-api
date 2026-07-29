/**
 * Unit tests for SolanaService.getSupplyInfo circulating-supply math, focused on
 * the MET-570 excluded-holders exclusion. RPC is bypassed by overriding the
 * private withRetry wrapper (which normally runs getMint), so no network is hit.
 */

import { describe, it, expect } from 'bun:test';
import {
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { SolanaService } from '../../src/services/solanaService.js';
import type { TokenAllocationInput } from '../../src/services/solanaService.js';

const MINT = 'So11111111111111111111111111111111111111112';
const RNGR_MINT = 'RNGRtJMbCveqCp7AC6U95KmrdKecFckaJZiWbPGmeta';
const HOLDER_A = 'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta';
const HOLDER_B = 'DMB74TZgN7Rqfwtqqm3VQBgKBb2WYPdBqVtHbvB4LLeV';

const DECIMALS = 6;
const ONE = new BN(10).pow(new BN(DECIMALS));
// 1,000,000 tokens total supply (raw = 1e6 * 1e6).
const TOTAL_RAW = new BN(1_000_000).mul(ONE);
const ZERO_KEY = new PublicKey(new Uint8Array(32));

function token2022MintAccountInfo(
  supply: bigint,
  decimals: number,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: ZERO_KEY,
    supply,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: ZERO_KEY,
  }, data);
  return {
    data,
    executable: false,
    lamports: 1,
    owner: TOKEN_2022_PROGRAM_ID,
    rentEpoch: 0,
  };
}

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
  it('reads standalone Token-2022 total supply using the mint account owner', async () => {
    const svc = new SolanaService();
    (svc as any).connection = {
      getAccountInfo: async () =>
        token2022MintAccountInfo(BigInt(TOTAL_RAW.toString()), DECIMALS),
    };

    expect(await svc.getTotalSupply(MINT)).toBe('1000000');
    const info = await svc.getSupplyInfo(MINT);
    expect(info.totalSupply).toBe('1000000');
    expect(info.circulatingSupply).toBe('1000000');
  });

  it('uses the mint supply captured with allocation balances without another RPC read', async () => {
    const svc = new SolanaService();
    (svc as any).withRetry = async () => {
      throw new Error('mint RPC should not be called');
    };

    const info = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      balanceSnapshotSlot: 456,
      mintSupplySnapshot: {
        amount: TOTAL_RAW,
        decimals: DECIMALS,
      },
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(100_000).mul(ONE) },
      ],
    });

    expect(info.totalSupply).toBe('1000000');
    expect(info.circulatingSupply).toBe('900000');
    expect(info.allocation?.balanceSnapshotSlot).toBe(456);
  });

  it('subtracts configured excluded-holder balances from circulating supply', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      balanceSnapshotSlot: 123,
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
    expect(info.allocation?.balanceSnapshotSlot).toBe(123);
  });

  it('surfaces zero-balance holders so configuration remains observable', async () => {
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
      { amount: '0', address: HOLDER_B, label: 'empty' },
    ]);
  });

  it('leaves circulating == total when no excluded holders are passed', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(MINT, baseAllocation());

    expect(info.circulatingSupply).toBe('1000000');
    expect(info.allocation?.excludedHolders).toBeUndefined();
  });

  it('subtracts additional allocation only while it is unclaimed', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const amount = new BN(25_000).mul(ONE);

    const unclaimed = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      additionalTokenAllocation: {
        amount,
        recipient: HOLDER_A,
        claimed: false,
      },
    });
    const claimed = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      additionalTokenAllocation: {
        amount,
        recipient: HOLDER_A,
        claimed: true,
      },
    });

    expect(unclaimed.circulatingSupply).toBe('975000');
    expect(claimed.circulatingSupply).toBe('1000000');
    expect(unclaimed.allocation?.additionalTokenAllocation?.claimed).toBe(false);
    expect(claimed.allocation?.additionalTokenAllocation?.claimed).toBe(true);
  });

  it('does not add the RNGR claimed tranche after the full allocation is claimed', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(RNGR_MINT, {
      ...baseAllocation(),
      additionalTokenAllocation: {
        amount: new BN(250_000).mul(ONE),
        recipient: HOLDER_A,
        claimed: true,
      },
    });

    expect(info.circulatingSupply).toBe('1000000');
    expect(info.allocation?.initialTokenAllocation).toBeUndefined();
  });

  it('adds the RNGR claimed tranche back while the remaining allocation is unclaimed', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(RNGR_MINT, {
      ...baseAllocation(),
      additionalTokenAllocation: {
        amount: new BN(250_000).mul(ONE),
        recipient: HOLDER_A,
        claimed: false,
      },
    });

    expect(info.circulatingSupply).toBe('942187.5');
    expect(info.allocation?.initialTokenAllocation).toEqual({
      amount: '192187.5',
      claimed: true,
    });
  });

  it('allows a claimed additional recipient to be excluded by its live balance', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);
    const info = await svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      additionalTokenAllocation: {
        amount: new BN(25_000).mul(ONE),
        recipient: HOLDER_A,
        claimed: true,
      },
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(10_000).mul(ONE) },
      ],
    });

    expect(info.circulatingSupply).toBe('990000');
  });

  it('rejects an excluded holder that overlaps the team package owner', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);

    await expect(svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      teamPerformancePackage: {
        amount: new BN(100_000).mul(ONE),
        address: HOLDER_A,
      },
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(100_000).mul(ONE) },
      ],
    })).rejects.toThrow('overlaps the team performance package allocation');
  });

  it('rejects an excluded holder that overlaps an unclaimed additional allocation', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);

    await expect(svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      additionalTokenAllocation: {
        amount: new BN(25_000).mul(ONE),
        recipient: HOLDER_A,
        claimed: false,
      },
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(25_000).mul(ONE) },
      ],
    })).rejects.toThrow('overlaps the unclaimed additional-token allocation');
  });

  it('rejects an excluded holder that overlaps the DAO treasury owner', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);

    await expect(svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      daoTreasuryTokens: {
        amount: new BN(50_000).mul(ONE),
        vaultAddress: HOLDER_A,
      },
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(50_000).mul(ONE) },
      ],
    })).rejects.toThrow('overlaps the DAO treasury allocation');
  });

  it('rejects overlap between named non-circulating allocation owners', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);

    await expect(svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      teamPerformancePackage: {
        amount: new BN(100_000).mul(ONE),
        address: HOLDER_A,
      },
      daoTreasuryTokens: {
        amount: new BN(50_000).mul(ONE),
        vaultAddress: HOLDER_A,
      },
    })).rejects.toThrow(
      'overlaps the team performance package and DAO treasury allocations',
    );
  });

  it('rejects duplicate excluded-holder addresses', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);

    await expect(svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(10).mul(ONE) },
        { address: HOLDER_A, amount: new BN(20).mul(ONE) },
      ],
    })).rejects.toThrow('configured more than once');
  });

  it('rejects non-circulating allocations that exceed total supply', async () => {
    const svc = serviceWithSupply(TOTAL_RAW);

    await expect(svc.getSupplyInfo(MINT, {
      ...baseAllocation(),
      excludedHolders: [
        { address: HOLDER_A, amount: new BN(2_000_000).mul(ONE) },
      ],
    })).rejects.toThrow('Non-circulating allocations exceed total supply');
  });

  it('bounds cached snapshot variants and evicts the oldest entry', () => {
    const svc = new SolanaService();

    for (let index = 0; index <= 1000; index++) {
      (svc as any).setCache(`snapshot-${index}`, index);
    }

    expect((svc as any).cache.size).toBe(1000);
    expect((svc as any).cache.has('snapshot-0')).toBe(false);
    expect((svc as any).cache.get('snapshot-1000')?.data).toBe(1000);
  });
});
