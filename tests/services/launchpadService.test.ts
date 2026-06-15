/**
 * Regression tests for the getTokenAllocationBreakdown error contract.
 *
 * An empty breakdown (zero locked allocations) is ONLY correct when the token
 * genuinely has no launch / an incomplete launch. An infrastructure failure
 * must REJECT — a swallowed error here would zero out every locked allocation
 * and serve circulating supply = total supply during any RPC blip (the exact
 * bug this suite pins down).
 */

import { describe, it, expect } from 'bun:test';
import { PublicKey } from '@solana/web3.js';
import { LaunchpadService } from '../../src/services/launchpadService.js';

const MINT = new PublicKey('SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta');

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
  });
});
