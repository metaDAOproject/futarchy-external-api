/**
 * Regression tests for the getTokenAllocationBreakdown error contract.
 *
 * An empty breakdown (zero locked allocations) is ONLY correct when the token
 * genuinely has no launch / an incomplete launch. An infrastructure failure
 * must REJECT — a swallowed error here would zero out every locked allocation
 * and serve circulating supply = total supply during any RPC blip (the exact
 * bug this suite pins down).
 */

import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { PublicKey } from '@solana/web3.js';
import { LaunchpadService } from '../../src/services/launchpadService.js';
import { config } from '../../src/config.js';

const MINT = new PublicKey('SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta');

// Guarantee a clean excluded-holders config for EVERY test in this file, so the
// no-launch/incomplete-launch cases below never depend on ambient
// EXCLUDED_CIRCULATING_WALLETS (which would add unexpected RPC / balances).
beforeEach(() => {
  config.circulating.excludedHolders.length = 0;
});

describe('LaunchpadService.getTokenAllocationBreakdown', () => {
  it('propagates infrastructure failures instead of returning an empty breakdown', async () => {
    const svc = new LaunchpadService();
    (svc as any).getLaunchByBaseMint = async () => {
      throw new Error('RPC connection refused');
    };

    await expect(svc.getTokenAllocationBreakdown(MINT)).rejects.toThrow('RPC connection refused');
  });

  it('returns an empty breakdown when the token genuinely has no launch', async () => {
    const svc = new LaunchpadService();
    (svc as any).getLaunchByBaseMint = async () => null;

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);

    expect(breakdown.teamPerformancePackage.amount.isZero()).toBe(true);
    expect(breakdown.futarchyAmmLiquidity.amount.isZero()).toBe(true);
    expect(breakdown.meteoraLpLiquidity.amount.isZero()).toBe(true);
    expect(breakdown.totalNonCirculating.isZero()).toBe(true);
  });

  it('returns an empty breakdown (with launch metadata) for an incomplete launch', async () => {
    const svc = new LaunchpadService();
    const launchAddress = new PublicKey('5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE');
    (svc as any).getLaunchByBaseMint = async () => ({
      launchAddress,
      baseMint: MINT,
      version: 'v0.7',
      dao: undefined,
    });

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);

    expect(breakdown.version).toBe('v0.7');
    expect(breakdown.launchAddress?.equals(launchAddress)).toBe(true);
    expect(breakdown.totalNonCirculating.isZero()).toBe(true);
    expect(breakdown.excludedHolders).toEqual([]);
  });

});

describe('LaunchpadService.getExcludedHolderBalances', () => {
  const HOLDER = new PublicKey('DMB74TZgN7Rqfwtqqm3VQBgKBb2WYPdBqVtHbvB4LLeV');
  const HOLDER_2 = new PublicKey('5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE');
  const OTHER_MINT = 'So11111111111111111111111111111111111111112';

  afterEach(() => {
    // The config singleton is mutated in-place by these tests; reset it so the
    // default (no configured holders) is restored for every other suite.
    config.circulating.excludedHolders.length = 0;
  });

  function tokenAccount(amount: string) {
    return { account: { data: { parsed: { info: { tokenAmount: { amount } } } } } };
  }

  function tokenAccountsResponse(amounts: string[], slot = 100) {
    return {
      context: { slot },
      value: amounts.map(tokenAccount),
    };
  }

  it('resolves no excluded holders (and hits no RPC) when none are configured for the mint', async () => {
    const svc = new LaunchpadService();
    let called = false;
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () => {
        called = true;
        return tokenAccountsResponse([]);
      },
    };
    const balances = await (svc as any).getExcludedHolderBalances(MINT);
    expect(balances).toEqual([]);
    expect(called).toBe(false);
  });

  it('sums ALL of the holder’s token accounts for the mint, not just the ATA', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER, label: 'ext' });
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () => tokenAccountsResponse(['100', '25']),
    };
    const balances = await (svc as any).getExcludedHolderBalances(MINT);
    expect(balances).toHaveLength(1);
    expect(balances[0].amount.toString()).toBe('125');
    expect(balances[0].label).toBe('ext');
  });

  it('yields a 0 balance when the holder owns no token accounts of the mint', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () => tokenAccountsResponse([]),
    };
    const balances = await (svc as any).getExcludedHolderBalances(MINT);
    expect(balances[0].amount.isZero()).toBe(true);
  });

  it('propagates an RPC failure instead of returning a silent 0', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () => {
        throw new Error('RPC connection refused');
      },
    };
    await expect((svc as any).getExcludedHolderBalances(MINT)).rejects.toThrow('RPC connection refused');
  });

  it('throws on an unreadable parsed token-account shape instead of counting it as 0', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () => ({
        context: { slot: 100 },
        value: [{ account: { data: { parsed: { info: {} } } } }],
      }),
    };
    await expect((svc as any).getExcludedHolderBalances(MINT)).rejects.toThrow('Unexpected parsed token-account shape');
  });

  it('ignores holders configured for a different mint (no RPC for the queried mint)', async () => {
    config.circulating.excludedHolders.push({ mint: OTHER_MINT, wallet: HOLDER });
    const svc = new LaunchpadService();
    let called = false;
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () => {
        called = true;
        return tokenAccountsResponse([]);
      },
    };
    const balances = await (svc as any).getExcludedHolderBalances(MINT);
    expect(balances).toEqual([]);
    expect(called).toBe(false);
  });

  it('retries all holder reads until they share one confirmed slot', async () => {
    config.circulating.excludedHolders.push(
      { mint: MINT.toString(), wallet: HOLDER },
      { mint: MINT.toString(), wallet: HOLDER_2 },
    );
    const svc = new LaunchpadService();
    let calls = 0;
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () => {
        const call = calls++;
        const attempt = Math.floor(call / 2);
        const holderIndex = call % 2;
        const slots = attempt === 0 ? [100, 101] : [102, 102];
        return tokenAccountsResponse(['10'], slots[holderIndex]);
      },
    };

    const snapshot = await (svc as any).getLiveBalanceSnapshot(MINT);

    expect(calls).toBe(4);
    expect(snapshot.slot).toBe(102);
    expect(snapshot.excludedHolders.map((holder: any) => holder.amount.toString())).toEqual([
      '10',
      '10',
    ]);
  });

  it('reads performance-package and DAO treasury balances in the shared snapshot', async () => {
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getParsedAccountInfo: async (address: PublicKey) => ({
        context: { slot: 321 },
        value: tokenAccount(address.equals(HOLDER) ? '75' : '25').account,
      }),
    };

    const snapshot = await (svc as any).getLiveBalanceSnapshot(MINT, HOLDER, HOLDER_2);

    expect(snapshot.slot).toBe(321);
    expect(snapshot.performancePackageAmount.toString()).toBe('75');
    expect(snapshot.daoTreasuryAmount.toString()).toBe('25');
  });

  it('fails closed when holder reads remain on different slots', async () => {
    config.circulating.excludedHolders.push(
      { mint: MINT.toString(), wallet: HOLDER },
      { mint: MINT.toString(), wallet: HOLDER_2 },
    );
    const svc = new LaunchpadService();
    let calls = 0;
    (svc as any).connection = {
      getParsedTokenAccountsByOwner: async () =>
        tokenAccountsResponse(['10'], calls++ % 2 === 0 ? 100 : 101),
    };

    await expect((svc as any).getLiveBalanceSnapshot(MINT)).rejects.toThrow(
      'consistent non-circulating balance snapshot',
    );
    expect(calls).toBe(6);
  });
});
