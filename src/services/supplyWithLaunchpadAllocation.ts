import { PublicKey } from '@solana/web3.js';
import type SolanaService from './solanaService.js';
import type { TokenSupplyInfo } from './solanaService.js';
import type LaunchpadService from './launchpadService.js';
import type { TokenAllocationBreakdown } from './launchpadService.js';

/**
 * Resolve total/circulating supply using the same launchpad allocation breakdown
 * and Solana mint path as GET /api/supply/:mint (aligned with MetaDAO market supply API semantics).
 */
export async function getSupplyInfoWithLaunchpadAllocation(
  mintAddress: string,
  solanaService: SolanaService,
  launchpadService: LaunchpadService,
): Promise<{ supplyInfo: TokenSupplyInfo; allocation: TokenAllocationBreakdown }> {
  const allocation = await launchpadService.getTokenAllocationBreakdown(
    new PublicKey(mintAddress),
  );

  const supplyInfo = await solanaService.getSupplyInfo(mintAddress, {
    teamPerformancePackage: {
      amount: allocation.teamPerformancePackage.amount,
      address: allocation.teamPerformancePackage.address?.toString(),
    },
    futarchyAmmLiquidity: {
      amount: allocation.futarchyAmmLiquidity.amount,
      vaultAddress: allocation.futarchyAmmLiquidity.vaultAddress?.toString(),
    },
    meteoraLpLiquidity: {
      amount: allocation.meteoraLpLiquidity.amount,
      poolAddress: allocation.meteoraLpLiquidity.poolAddress?.toString(),
      vaultAddress: allocation.meteoraLpLiquidity.vaultAddress?.toString(),
    },
    additionalTokenAllocation: allocation.additionalTokenAllocation
      ? {
          amount: allocation.additionalTokenAllocation.amount,
          recipient: allocation.additionalTokenAllocation.recipient.toString(),
          claimed: allocation.additionalTokenAllocation.claimed,
          tokenAccountAddress:
            allocation.additionalTokenAllocation.tokenAccountAddress?.toString(),
        }
      : undefined,
    daoTreasuryTokens: {
      amount: allocation.daoTreasuryTokens.amount,
      vaultAddress: allocation.daoTreasuryTokens.vaultAddress?.toString(),
    },
    excludedHolders: (allocation.excludedHolders ?? []).map((h) => ({
      amount: h.amount,
      address: h.wallet.toString(),
      label: h.label,
    })),
    daoAddress: allocation.daoAddress?.toString(),
    launchAddress: allocation.launchAddress?.toString(),
    version: allocation.version,
  });

  return { supplyInfo, allocation };
}
