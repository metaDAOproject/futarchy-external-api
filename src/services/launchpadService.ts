import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  LaunchpadClient as LaunchpadClientV06,
  getLaunchSignerAddr,
} from "@metadaoproject/programs/launchpad/v0.6";
import {
  LaunchpadClient as LaunchpadClientV07,
} from "@metadaoproject/programs/launchpad/v0.7";
import {
  LaunchpadClient as LaunchpadClientV08,
} from "@metadaoproject/programs/launchpad/v0.8";
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import { getPerformancePackageAddr } from "@metadaoproject/programs/price_based_performance_package/v0.6";
import {
  PRICE_BASED_PERFORMANCE_PACKAGE_PROGRAM_ID,
  DAMM_V2_PROGRAM_ID,
  LAUNCHPAD_V0_6_MAINNET_METEORA_CONFIG as MAINNET_METEORA_CONFIG_V06,
  LAUNCHPAD_V0_7_MAINNET_METEORA_CONFIG as MAINNET_METEORA_CONFIG_V07,
} from "@metadaoproject/programs";
import { getAssociatedTokenAddress, getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from '@solana/spl-token';
import { config } from '../config.js';
import { createSolanaConnection } from '../utils/solanaConnection.js';
import { TtlCache } from '../utils/ttlCache.js';
import BN from 'bn.js';
import { logger } from '../utils/logger.js';

// Launchpad version detection
export type LaunchpadVersion = 'v0.6' | 'v0.7';

/**
 * Additional token recipient allocation (v0.7+ only)
 */
export interface AdditionalTokenAllocation {
  recipient: PublicKey;
  amount: BN;
  claimed: boolean;
  tokenAccountAddress?: PublicKey;
}

/**
 * A configured non-circulating holder resolved to its live on-chain balance.
 * These are operator-vetted external/vesting/encumbered/protocol-owned wallets
 * (e.g. Laso's external wallet) whose tokens are NOT "in the hands of others".
 */
export interface ExcludedHolderBalance {
  wallet: PublicKey;
  label?: string;
  amount: BN;
}

/**
 * Complete token allocation breakdown for launchpad tokens
 */
export interface TokenAllocationBreakdown {
  // Launchpad version used
  version: LaunchpadVersion;
  // Team Performance Package - locked tokens for the team
  teamPerformancePackage: {
    amount: BN;
    address?: PublicKey;
  };
  // FutarchyAMM Liquidity - tokens in the internal Futarchy AMM for spot trading
  futarchyAmmLiquidity: {
    amount: BN;
    vaultAddress?: PublicKey;
  };
  // Meteora LP Position - tokens in the external Meteora DAMM pool
  meteoraLpLiquidity: {
    amount: BN;
    poolAddress?: PublicKey;
    vaultAddress?: PublicKey;
  };
  // Additional token recipient (v0.7+ only) - not in circulating supply
  additionalTokenAllocation?: AdditionalTokenAllocation;
  // DAO treasury tokens - base tokens held in the DAO's squads vault (not circulating)
  daoTreasuryTokens: {
    amount: BN;
    vaultAddress?: PublicKey;
  };
  // Operator-configured non-circulating holders (external/vesting/encumbered) for
  // this mint, resolved to their live on-chain balances. Empty when none configured.
  excludedHolders: ExcludedHolderBalance[];
  // Confirmed Solana slot shared by mint-supply and live-balance RPC batches.
  balanceSnapshotSlot?: number;
  // Mint supply read in the same RPC snapshot as the live balances.
  mintSupplySnapshot: {
    amount: BN;
    decimals: number;
  };
  // DAO address (if launch completed)
  daoAddress?: PublicKey;
  // Launch address
  launchAddress?: PublicKey;
  // Total non-circulating supply (performance package + additional tokens if unclaimed
  // + DAO treasury + configured excluded holders)
  totalNonCirculating: BN;
}

export interface LaunchData {
  launchAddress: PublicKey;
  baseMint: PublicKey;
  performancePackageGrantee: PublicKey;
  performancePackageTokenAmount: BN;
  state: LaunchState;
  dao?: PublicKey;
  // v0.7+ fields
  version: LaunchpadVersion;
  additionalTokensAmount?: BN;
  additionalTokensRecipient?: PublicKey;
  additionalTokensClaimed?: boolean;
}

/**
 * A launch that is currently accepting commitments (on-chain state `live`).
 * Amounts are in the quote mint (usually USDC); `*Raw` fields are base units.
 */
export interface LiveLaunch {
  launchAddress: string;
  version: LaunchpadVersion | 'v0.8';
  /** Mint of the token being launched (the launch's `baseMint`). */
  tokenAddress: string;
  quoteMint: string;
  quoteDecimals: number;
  /** Number of funding records with a non-zero commitment (one record per funder). */
  committerCount: number;
  /** Sum of `committedAmount` across the launch's funding records. */
  totalCommitted: string;
  totalCommittedRaw: string;
  /** On-chain `minimumRaiseAmount`. */
  minimumRaise: string;
  minimumRaiseRaw: string;
  /** Unix seconds: `unixTimestampStarted + secondsForLaunch`. */
  closeTime: number;
}

export interface LiveLaunchesSnapshot {
  updatedAt: string;
  launches: LiveLaunch[];
}

// FundingRecord layout: 8-byte discriminator, pdaBump (u8), funder (Pubkey),
// then launch (Pubkey) — identical in launchpad v0.6, v0.7 and v0.8.
const FUNDING_RECORD_LAUNCH_OFFSET = 8 + 1 + 32;

function formatUnits(raw: BN, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export type LaunchState =
  | { initialized: Record<string, never> }
  | { active: Record<string, never> }
  | { closed: Record<string, never> }
  | { completed: Record<string, never> }
  | { cancelled: Record<string, never> };

export class LaunchpadService {
  private static readonly SNAPSHOT_BATCH_SIZE = 100;
  private connection: Connection;
  private clientV06: LaunchpadClientV06;
  private clientV07: LaunchpadClientV07;
  private clientV08: LaunchpadClientV08;
  private futarchyClient: FutarchyClient;
  // Keyed by caller-supplied mints, so bounded.
  private cache = new TtlCache(10_000);
  private liveLaunches: { snapshot: LiveLaunchesSnapshot; fetchedAt: number } | null = null;
  private liveLaunchesInFlight: Promise<LiveLaunchesSnapshot> | null = null;
  private mintDecimals = new Map<string, Promise<number>>();

  constructor() {
    this.connection = createSolanaConnection();
    
    // Create a dummy wallet for read-only operations
    let wallet: Wallet;
    try {
      wallet = Wallet.local();
    } catch (error) {
      // If ANCHOR_WALLET is not set, create a dummy wallet for read-only operations
      const dummyKeypair = Keypair.generate();
      wallet = new Wallet(dummyKeypair);
    }
    
    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: 'confirmed',
    });
    this.clientV06 = LaunchpadClientV06.createClient({ provider });
    this.clientV07 = LaunchpadClientV07.createClient({ provider });
    this.clientV08 = LaunchpadClientV08.createClient({ provider });
    this.futarchyClient = FutarchyClient.createClient({ provider });
  }


  /**
   * Get the Launch PDA address for a given base mint (v0.6 program)
   */
  getLaunchAddressV06(baseMint: PublicKey): PublicKey {
    return this.clientV06.getLaunchAddress({ baseMint });
  }

  /**
   * Get the Launch PDA address for a given base mint (v0.7 program)
   */
  getLaunchAddressV07(baseMint: PublicKey): PublicKey {
    return this.clientV07.getLaunchAddress({ baseMint });
  }


  /**
   * The launch for a token's base mint, from the v0.7 or v0.6 launchpad (v0.7,
   * the newer program, wins if both exist). Both launch PDAs are read in one
   * RPC call. "No launch" is cached like a found launch; an RPC failure
   * throws and is not cached — a silent null would make the allocation
   * breakdown treat a launched token as un-launched (zero locked allocations,
   * circulating = total supply).
   */
  getLaunchByBaseMint(baseMint: PublicKey): Promise<LaunchData | null> {
    return this.cache.getOrLoad(`launch_by_mint_${baseMint.toString()}`, config.cache.tickersTTL, async () => {
      const launchAddressV07 = this.getLaunchAddressV07(baseMint);
      const launchAddressV06 = this.getLaunchAddressV06(baseMint);
      const [infoV07, infoV06] = await this.connection.getMultipleAccountsInfo([launchAddressV07, launchAddressV06]);

      let found: { launchAccount: any; version: LaunchpadVersion; launchAddress: PublicKey } | null = null;
      if (infoV07) {
        found = { launchAccount: await this.clientV07.deserializeLaunch(infoV07), version: 'v0.7', launchAddress: launchAddressV07 };
      } else if (infoV06) {
        found = { launchAccount: await this.clientV06.deserializeLaunch(infoV06), version: 'v0.6', launchAddress: launchAddressV06 };
      }
      if (!found) {
        logger.debug(`[Launchpad] No launch found for mint ${baseMint.toString()}`);
        return null;
      }

      const { launchAccount, version, launchAddress } = found;
      logger.debug(`[Launchpad] Found ${version} launch ${launchAddress.toString()} for mint ${baseMint.toString()}`);
      const launchData: LaunchData = {
        launchAddress,
        baseMint: launchAccount.baseMint,
        performancePackageGrantee: launchAccount.performancePackageGrantee,
        performancePackageTokenAmount: new BN(launchAccount.performancePackageTokenAmount.toString()),
        state: launchAccount.state as LaunchState,
        dao: launchAccount.dao || undefined,
        version,
        // v0.7 specific fields
        additionalTokensAmount: launchAccount.additionalTokensAmount
          ? new BN(launchAccount.additionalTokensAmount.toString())
          : undefined,
        additionalTokensRecipient: launchAccount.additionalTokensRecipient || undefined,
        additionalTokensClaimed: launchAccount.additionalTokensClaimed || undefined,
      };
      return launchData;
    });
  }

  /**
   * Derive the performance package address for a given launch (v0.6 style).
   * The createKey used during completeLaunch is the launch signer.
   */
  getPerformancePackageAddressV06(launchAddress: PublicKey): PublicKey {
    const [launchSigner] = getLaunchSignerAddr(
      this.clientV06.getProgramId(),
      launchAddress
    );
    const [performancePackageAddress] = getPerformancePackageAddr({
      programId: PRICE_BASED_PERFORMANCE_PACKAGE_PROGRAM_ID,
      createKey: launchSigner,
    });
    return performancePackageAddress;
  }

  /**
   * Derive the performance package address for a given launch (v0.7 style).
   * Uses the launch-specific PDA derivation.
   */
  getPerformancePackageAddressV07(launchAddress: PublicKey): PublicKey {
    return this.clientV07.getLaunchPerformancePackageAddress({ launch: launchAddress });
  }

  /**
   * Get performance package address for a launch, detecting version automatically.
   */
  getPerformancePackageAddress(launchAddress: PublicKey, version: LaunchpadVersion = 'v0.6'): PublicKey {
    if (version === 'v0.7') {
      return this.getPerformancePackageAddressV07(launchAddress);
    }
    return this.getPerformancePackageAddressV06(launchAddress);
  }

  /**
   * Get the appropriate Meteora config for a given launchpad version.
   * v0.6 and v0.7 use different Meteora configs.
   */
  getMeteoraConfig(version: LaunchpadVersion): PublicKey {
    return version === 'v0.7' ? MAINNET_METEORA_CONFIG_V07 : MAINNET_METEORA_CONFIG_V06;
  }

  /**
   * Derive the Meteora DAMM v2 pool address for a token pair.
   * Seeds: ["pool", config, larger_mint, smaller_mint]
   * Token order: DESCENDING (larger first, smaller second) - per SDK's getFirstKey/getSecondKey
   * 
   * @param baseMint - The base token mint
   * @param quoteMint - The quote token mint
   * @param version - The launchpad version (determines which Meteora config to use)
   */
  getMeteoraPoolAddress(baseMint: PublicKey, quoteMint: PublicKey, version: LaunchpadVersion = 'v0.6'): PublicKey {
    // Sort mints - Meteora uses DESCENDING order (larger first, smaller second)
    const buf1 = baseMint.toBuffer();
    const buf2 = quoteMint.toBuffer();
    const comparison = Buffer.compare(buf1, buf2);
    
    // getFirstKey: if buf1 > buf2, return buf1, else return buf2 (the larger one)
    // getSecondKey: if buf1 > buf2, return buf2, else return buf1 (the smaller one)
    const firstKey = comparison === 1 ? baseMint : quoteMint;
    const secondKey = comparison === 1 ? quoteMint : baseMint;
    
    const meteoraConfig = this.getMeteoraConfig(version);
    
    const [poolAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool"),
        meteoraConfig.toBuffer(),
        firstKey.toBuffer(),
        secondKey.toBuffer(),
      ],
      DAMM_V2_PROGRAM_ID
    );
    return poolAddress;
  }

  /**
   * Get the Meteora DAMM v2 pool's token vault for a given mint.
   * Seeds: ["token_vault", tokenMint, pool] - per SDK's derivation
   */
  getMeteoraPoolVault(poolAddress: PublicKey, tokenMint: PublicKey): PublicKey {
    // Meteora DAMM v2 vault PDA derivation - note: tokenMint comes BEFORE pool
    const [vaultAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("token_vault"),
        tokenMint.toBuffer(),
        poolAddress.toBuffer(),
      ],
      DAMM_V2_PROGRAM_ID
    );
    return vaultAddress;
  }

  /**
   * Discover every configured holder's token accounts, then read the mint and all
   * relevant token accounts in contextual getMultipleAccounts batches at the same
   * confirmed slot. Account discovery is repeated after the snapshot; if the address set changed around
   * the snapshot, the whole operation is retried.
   */
  private async getLiveBalanceSnapshot(
    baseMint: PublicKey,
    performancePackageOwner?: PublicKey,
    daoTreasuryOwner?: PublicKey,
    additionalAccounts: { futarchyAmm?: PublicKey; meteoraLp?: PublicKey; additionalTokenLaunch?: PublicKey } = {},
  ): Promise<{
    excludedHolders: ExcludedHolderBalance[];
    performancePackageAmount: BN;
    daoTreasuryAmount: BN;
    futarchyAmmAmount: BN | null;
    meteoraLpAmount: BN | null;
    additionalTokensClaimed?: boolean;
    mintSupply: {
      amount: BN;
      decimals: number;
    };
    tokenProgramId: PublicKey;
    slot: number;
  }> {
    const mint = baseMint.toString();
    const configured = config.circulating.excludedHolders.filter(h => h.mint === mint);
    const maxAttempts = 3;

    const deriveCandidateAtas = async (owner: PublicKey | undefined) => {
      if (!owner) return undefined;
      const [legacy, token2022] = await Promise.all([
        getAssociatedTokenAddress(baseMint, owner, true, TOKEN_PROGRAM_ID),
        getAssociatedTokenAddress(baseMint, owner, true, TOKEN_2022_PROGRAM_ID),
      ]);
      return { legacy, token2022 };
    };
    const [performancePackageAtas, daoTreasuryAtas] = await Promise.all([
      deriveCandidateAtas(performancePackageOwner),
      deriveCandidateAtas(daoTreasuryOwner),
    ]);

    const discoverHolderAccounts = async (minContextSlot?: number) =>
      Promise.all(
        configured.map(holder =>
          this.connection.getTokenAccountsByOwner(
            holder.wallet,
            { mint: baseMint },
            {
              commitment: 'confirmed',
              ...(minContextSlot !== undefined ? { minContextSlot } : {}),
            },
          ),
        ),
      );

    const accountAddresses = (
      responses: Awaited<ReturnType<typeof discoverHolderAccounts>>,
    ): string[][] =>
      responses.map(response =>
        response.value
          .map(({ pubkey }) => pubkey.toString())
          .sort(),
      );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const firstDiscovery = await discoverHolderAccounts();
      const minimumSnapshotSlot = firstDiscovery.reduce(
        (maximum, response) => Math.max(maximum, response.context.slot),
        0,
      );

      const uniqueAddresses = new Map<string, PublicKey>();
      const addAddress = (address: PublicKey | undefined): void => {
        if (address) uniqueAddresses.set(address.toString(), address);
      };
      addAddress(baseMint);
      addAddress(additionalAccounts.futarchyAmm);
      addAddress(additionalAccounts.meteoraLp);
      addAddress(additionalAccounts.additionalTokenLaunch);
      for (const response of firstDiscovery) {
        for (const { pubkey } of response.value) addAddress(pubkey);
      }
      addAddress(performancePackageAtas?.legacy);
      addAddress(performancePackageAtas?.token2022);
      addAddress(daoTreasuryAtas?.legacy);
      addAddress(daoTreasuryAtas?.token2022);

      const addresses = [...uniqueAddresses.values()];
      const batches = [];
      for (let offset = 0; offset < addresses.length; offset += LaunchpadService.SNAPSHOT_BATCH_SIZE) {
        batches.push(addresses.slice(offset, offset + LaunchpadService.SNAPSHOT_BATCH_SIZE));
      }
      const snapshots = await Promise.all(batches.map(batch =>
        this.connection.getMultipleAccountsInfoAndContext(batch, {
          commitment: 'confirmed',
          ...(minimumSnapshotSlot > 0 ? { minContextSlot: minimumSnapshotSlot } : {}),
        }),
      ));
      const context = snapshots[0]!.context;
      // minContextSlot is a lower bound, not an exact-slot read. Retry rather
      // than combine balances from different banks during a transfer or burn.
      if (snapshots.some(snapshot => snapshot.context.slot !== context.slot)) {
        if (attempt < maxAttempts) continue;
        throw new Error(`[Launchpad] Balance snapshot slots differed for ${mint} after ${maxAttempts} attempts`);
      }
      const snapshot = { context, value: snapshots.flatMap(batch => batch.value) };
      const secondDiscovery = await discoverHolderAccounts(snapshot.context.slot);

      const firstAddresses = accountAddresses(firstDiscovery);
      const secondAddresses = accountAddresses(secondDiscovery);
      if (JSON.stringify(firstAddresses) !== JSON.stringify(secondAddresses)) {
        logger.warn('[Launchpad] Retrying after token-account topology changed around snapshot', {
          mint,
          attempt,
          snapshotSlot: snapshot.context.slot,
        });
        if (attempt < maxAttempts) continue;
        throw new Error(
          `[Launchpad] Token-account topology changed around ${mint} snapshot for ${maxAttempts} attempts`,
        );
      }

      const accountsByAddress = new Map(
        addresses.map((address, index) => [
          address.toString(),
          snapshot.value[index] ?? null,
        ]),
      );
      const mintAccount = accountsByAddress.get(mint);
      if (!mintAccount) {
        throw new Error(`[Launchpad] Mint account ${mint} was absent from balance snapshot`);
      }
      if (
        !mintAccount.owner.equals(TOKEN_PROGRAM_ID) &&
        !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
      ) {
        throw new Error(`[Launchpad] Mint ${mint} is not owned by a supported token program`);
      }
      const tokenProgramId = mintAccount.owner;
      const mintInfo = unpackMint(baseMint, mintAccount, tokenProgramId);
      const selectAta = (
        candidates: { legacy: PublicKey; token2022: PublicKey } | undefined,
      ): PublicKey | undefined =>
        tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
          ? candidates?.token2022
          : candidates?.legacy;
      const performancePackageAta = selectAta(performancePackageAtas);
      const daoTreasuryAta = selectAta(daoTreasuryAtas);

      const readTokenAmount = (
        address: PublicKey | undefined,
        description: string,
        absentIsZero: boolean,
        expectedOwner?: PublicKey,
      ): BN => {
        if (!address) return new BN(0);
        const accountInfo = accountsByAddress.get(address.toString());
        if (!accountInfo) {
          if (absentIsZero) return new BN(0);
          throw new Error(`[Launchpad] ${description} was absent from balance snapshot`);
        }
        const tokenAccount = unpackAccount(address, accountInfo, tokenProgramId);
        if (!tokenAccount.mint.equals(baseMint)) {
          throw new Error(`[Launchpad] ${description} belongs to an unexpected mint`);
        }
        // Token authority can change without changing the account address.
        if (expectedOwner && !tokenAccount.owner.equals(expectedOwner)) {
          throw new Error(`[Launchpad] ${description} belongs to an unexpected owner`);
        }
        return new BN(tokenAccount.amount.toString());
      };

      const excludedHolders = configured.map((holder, index) => {
        const addressesForHolder = firstDiscovery[index]!.value.map(({ pubkey }) => pubkey);
        const amount = addressesForHolder.reduce(
          (sum, address) =>
            sum.add(readTokenAmount(
              address,
              `excluded holder account ${address.toString()}`,
              false,
              holder.wallet,
            )),
          new BN(0),
        );
        logger.info(
          `[Launchpad] Excluded holder ${holder.wallet.toString()} (${holder.label ?? 'unlabeled'}) holds ${amount.toString()} tokens of ${mint} across ${addressesForHolder.length} account(s)`,
        );
        return { wallet: holder.wallet, label: holder.label, amount };
      });

      let additionalTokensClaimed: boolean | undefined;
      if (additionalAccounts.additionalTokenLaunch) {
        const launchInfo = accountsByAddress.get(additionalAccounts.additionalTokenLaunch.toString());
        if (!launchInfo) throw new Error(`[Launchpad] Additional-token launch was absent from balance snapshot`);
        const launch = await this.clientV07.deserializeLaunch(launchInfo);
        additionalTokensClaimed = launch.additionalTokensClaimed;
      }

      return {
        excludedHolders,
        performancePackageAmount: readTokenAmount(
          performancePackageAta,
          `performance package ATA ${performancePackageAta?.toString()}`,
          true,
          performancePackageOwner,
        ),
        daoTreasuryAmount: readTokenAmount(
          daoTreasuryAta,
          `DAO treasury ATA ${daoTreasuryAta?.toString()}`,
          true,
          daoTreasuryOwner,
        ),
        futarchyAmmAmount: additionalAccounts.futarchyAmm && accountsByAddress.get(additionalAccounts.futarchyAmm.toString())
          ? readTokenAmount(additionalAccounts.futarchyAmm, 'Futarchy AMM vault', true) : null,
        meteoraLpAmount: additionalAccounts.meteoraLp && accountsByAddress.get(additionalAccounts.meteoraLp.toString())
          ? readTokenAmount(additionalAccounts.meteoraLp, 'Meteora LP vault', true) : null,
        additionalTokensClaimed,
        mintSupply: {
          amount: new BN(mintInfo.supply.toString()),
          decimals: mintInfo.decimals,
        },
        tokenProgramId,
        slot: snapshot.context.slot,
      };
    }

    throw new Error(`[Launchpad] Unreachable balance snapshot state for ${mint}`);
  }

  /**
   * Get the complete token allocation breakdown for a launchpad token.
   * This provides a complete picture of where all tokens are allocated:
   * - Team Performance Package (locked)
   * - FutarchyAMM Liquidity (internal AMM)
   * - Meteora LP Liquidity (external DEX)
   * - Additional Token Allocation (v0.7+ only, not in circulating supply until claimed)
   *
   * FutarchyAMM and Meteora liquidity remain circulating. Live balances and
   * mint supply share one confirmed slot, and concurrent requests share a load.
   *
   * Cached per mint; concurrent requests for one mint share a single load.
   */
  getTokenAllocationBreakdown(baseMint: PublicKey): Promise<TokenAllocationBreakdown> {
    return this.cache.getOrLoad(
      `allocation_${baseMint.toString()}`,
      config.cache.tickersTTL,
      () => this.loadTokenAllocationBreakdown(baseMint),
    );
  }

  private async loadTokenAllocationBreakdown(baseMint: PublicKey): Promise<TokenAllocationBreakdown> {
    // No catch-all below: an empty breakdown is returned ONLY for the two
    // genuinely-empty cases (token never launched / launch not completed).
    // Every infrastructure failure (RPC, network, timeout) propagates to the
    // caller — swallowing it here would zero out every locked allocation and
    // serve circulating supply = total supply on a transient outage, which is
    // the exact mispricing the isTokenAccountAbsent contract exists to prevent.
    const launch = await this.getLaunchByBaseMint(baseMint);
    if (!launch) {
      const snapshot = await this.getLiveBalanceSnapshot(baseMint);
      const excludedHoldersTotal = snapshot.excludedHolders.reduce(
        (sum, holder) => sum.add(holder.amount),
        new BN(0),
      );
      const breakdown: TokenAllocationBreakdown = {
        version: 'v0.6',
        teamPerformancePackage: { amount: new BN(0) },
        futarchyAmmLiquidity: { amount: new BN(0) },
        meteoraLpLiquidity: { amount: new BN(0) },
        daoTreasuryTokens: { amount: new BN(0) },
        excludedHolders: snapshot.excludedHolders,
        balanceSnapshotSlot: snapshot.slot,
        mintSupplySnapshot: snapshot.mintSupply,
        totalNonCirculating: excludedHoldersTotal,
      };
      return breakdown;
    }

    if (!launch.dao) {
      const snapshot = await this.getLiveBalanceSnapshot(baseMint);
      const excludedHoldersTotal = snapshot.excludedHolders.reduce(
        (sum, holder) => sum.add(holder.amount),
        new BN(0),
      );
      const breakdown: TokenAllocationBreakdown = {
        version: launch.version,
        teamPerformancePackage: { amount: new BN(0) },
        futarchyAmmLiquidity: { amount: new BN(0) },
        meteoraLpLiquidity: { amount: new BN(0) },
        daoTreasuryTokens: { amount: new BN(0) },
        excludedHolders: snapshot.excludedHolders,
        balanceSnapshotSlot: snapshot.slot,
        mintSupplySnapshot: snapshot.mintSupply,
        launchAddress: launch.launchAddress,
        totalNonCirculating: excludedHoldersTotal,
      };
      return breakdown;
    }

    // Get DAO to find quote mint
    const dao = await this.futarchyClient.fetchDao(launch.dao);
    const quoteMint = dao?.quoteMint;

    // Derive the performance package address and fetch its actual on-chain token balance
    // We use the live balance rather than launch.performancePackageTokenAmount because
    // tokens may have been unlocked/claimed (e.g. ZKFG, Loyal), making the configured
    // amount stale and over-subtracting from circulating supply.
    const performancePackageAddress = this.getPerformancePackageAddress(
      launch.launchAddress,
      launch.version,
    );
    const ammBaseVault: PublicKey | undefined = dao?.amm?.ammBaseVault;
    const meteoraPool = quoteMint ? this.getMeteoraPoolAddress(baseMint, quoteMint, launch.version) : undefined;
    const meteoraVault = meteoraPool ? this.getMeteoraPoolVault(meteoraPool, baseMint) : undefined;

    // Handle additional token allocation (v0.7+ only)
    let additionalTokenAllocation: AdditionalTokenAllocation | undefined;
    if (launch.version === 'v0.7' && launch.additionalTokensRecipient && launch.additionalTokensAmount) {
      additionalTokenAllocation = {
        recipient: launch.additionalTokensRecipient,
        amount: launch.additionalTokensAmount,
        claimed: launch.additionalTokensClaimed || false,
      };
    }

    // Resolve the DAO treasury owner and ATA before taking the shared live-balance snapshot.
    let daoTreasuryVaultAddress: PublicKey | undefined;
    if (dao && (dao as any).squadsMultisigVault) {
      daoTreasuryVaultAddress = new PublicKey((dao as any).squadsMultisigVault);
    }

    const snapshot = await this.getLiveBalanceSnapshot(
      baseMint,
      performancePackageAddress,
      daoTreasuryVaultAddress,
      {
        futarchyAmm: ammBaseVault,
        meteoraLp: meteoraVault,
        additionalTokenLaunch: additionalTokenAllocation ? launch.launchAddress : undefined,
      },
    );
    if (additionalTokenAllocation) {
      // Claim state and recipient balances must agree even if launch discovery
      // was cached before the claim transferred tokens into the recipient's wallet.
      additionalTokenAllocation.claimed = snapshot.additionalTokensClaimed!;
      if (!additionalTokenAllocation.claimed && additionalTokenAllocation.amount.gt(new BN(0))) {
        // The unclaimed allocation is held by the launch signer, not its recipient.
        const launchSigner = this.clientV07.getLaunchSignerAddress({ launch: launch.launchAddress });
        if (snapshot.excludedHolders.some(holder => holder.wallet.equals(launchSigner) && !holder.amount.isZero())) {
          throw new Error(`[Launchpad] Excluded holder ${launchSigner.toString()} overlaps the unclaimed additional-token escrow`);
        }
      }
      additionalTokenAllocation.tokenAccountAddress = await getAssociatedTokenAddress(
        baseMint,
        additionalTokenAllocation.recipient,
        true,
        snapshot.tokenProgramId,
      );
    }
    const futarchyAmm = snapshot.futarchyAmmAmount
      ? { amount: snapshot.futarchyAmmAmount, vaultAddress: ammBaseVault } : { amount: new BN(0) };
    const meteoraLp = snapshot.meteoraLpAmount
      ? { amount: snapshot.meteoraLpAmount, poolAddress: meteoraPool, vaultAddress: meteoraVault } : { amount: new BN(0) };
    const performancePackageLockedAmount = snapshot.performancePackageAmount;
    const excludedHolders = snapshot.excludedHolders;
    const excludedHoldersTotal = excludedHolders.reduce(
      (sum, holder) => sum.add(holder.amount),
      new BN(0),
    );
    const daoTreasuryTokens: { amount: BN; vaultAddress?: PublicKey } = {
      amount: snapshot.daoTreasuryAmount,
      vaultAddress: daoTreasuryVaultAddress,
    };

    logger.info(
      `[Launchpad] Performance package at ${performancePackageAddress.toString()} holds ${performancePackageLockedAmount.toString()} tokens (configured: ${launch.performancePackageTokenAmount.toString()})`,
    );
    if (daoTreasuryVaultAddress) {
      logger.info(
        `[Launchpad] DAO treasury holds ${daoTreasuryTokens.amount.toString()} base tokens in vault ${daoTreasuryVaultAddress.toString()}`,
      );
    }

    // Calculate total non-circulating supply using live on-chain balance
    let totalNonCirculating = performancePackageLockedAmount;
    
    // Add additional tokens if not yet claimed (they're still locked)
    if (additionalTokenAllocation && !additionalTokenAllocation.claimed) {
      totalNonCirculating = totalNonCirculating.add(additionalTokenAllocation.amount);
    }

    // Add DAO treasury tokens (protocol-controlled, not circulating)
    totalNonCirculating = totalNonCirculating.add(daoTreasuryTokens.amount);

    // Add configured excluded holders (external/vesting/encumbered, not circulating)
    totalNonCirculating = totalNonCirculating.add(excludedHoldersTotal);

    const breakdown: TokenAllocationBreakdown = {
      version: launch.version,
      teamPerformancePackage: {
        amount: performancePackageLockedAmount,
        address: performancePackageAddress,
      },
      futarchyAmmLiquidity: {
        amount: futarchyAmm.amount,
        vaultAddress: futarchyAmm.vaultAddress,
      },
      meteoraLpLiquidity: {
        amount: meteoraLp.amount,
        poolAddress: meteoraLp.poolAddress,
        vaultAddress: meteoraLp.vaultAddress,
      },
      additionalTokenAllocation,
      daoTreasuryTokens,
      excludedHolders,
      balanceSnapshotSlot: snapshot.slot,
      mintSupplySnapshot: snapshot.mintSupply,
      daoAddress: launch.dao,
      launchAddress: launch.launchAddress,
      totalNonCirculating,
    };

    return breakdown;
  }

  /**
   * Launches still accepting commitments across launchpad v0.6/v0.7/v0.8:
   * on-chain state `live` and close time not yet passed. Launches past their
   * close time stay `live` on-chain until someone calls closeLaunch (many
   * never are), so they are excluded at serve time — a launch drops out the
   * moment it closes, even within a cache window.
   *
   * Served from a snapshot refreshed at most once per
   * `config.cache.liveLaunchesTTL`; concurrent requests during a refresh share
   * one scan. A failed refresh is not cached and propagates (→ 5xx) rather
   * than serving an empty list.
   */
  async getLiveLaunches(): Promise<LiveLaunchesSnapshot> {
    const snapshot = await this.getLiveLaunchesSnapshot();
    const nowSeconds = Date.now() / 1000;
    return {
      updatedAt: snapshot.updatedAt,
      launches: snapshot.launches.filter((launch) => launch.closeTime > nowSeconds),
    };
  }

  private async getLiveLaunchesSnapshot(): Promise<LiveLaunchesSnapshot> {
    if (this.liveLaunches && Date.now() - this.liveLaunches.fetchedAt < config.cache.liveLaunchesTTL) {
      return this.liveLaunches.snapshot;
    }
    if (!this.liveLaunchesInFlight) {
      this.liveLaunchesInFlight = this.fetchLiveLaunches()
        .then((snapshot) => {
          this.liveLaunches = { snapshot, fetchedAt: Date.now() };
          return snapshot;
        })
        .finally(() => {
          this.liveLaunchesInFlight = null;
        });
    }
    return this.liveLaunchesInFlight;
  }

  private async fetchLiveLaunches(): Promise<LiveLaunchesSnapshot> {
    const programs = [
      { version: 'v0.6', program: this.clientV06.launchpad },
      { version: 'v0.7', program: this.clientV07.launchpad },
      { version: 'v0.8', program: this.clientV08.launchpad },
    ] as const;

    const nowSeconds = Date.now() / 1000;
    const perProgram = await Promise.all(programs.map(async ({ version, program }) => {
      const launches = await program.account.launch.all();

      // Keep `live` launches whose close time hasn't passed. Expired launches
      // stay `live` on-chain until closeLaunch is called (many never are) and
      // would always be filtered at serve time, so don't read their funding
      // records at all.
      const open: Array<{ publicKey: PublicKey; account: (typeof launches)[number]['account']; closeTime: number }> = [];
      for (const { publicKey, account } of launches) {
        if (!('live' in account.state)) continue;
        // A launch only enters `live` via startLaunch, which sets this timestamp.
        if (!account.unixTimestampStarted) {
          throw new Error(`Live ${version} launch ${publicKey.toBase58()} has no start timestamp`);
        }
        const closeTime = account.unixTimestampStarted.toNumber() + account.secondsForLaunch;
        if (closeTime > nowSeconds) open.push({ publicKey, account, closeTime });
      }

      return Promise.all(open.map(async ({ publicKey, account, closeTime }): Promise<LiveLaunch> => {
        const [fundingRecords, quoteDecimals] = await Promise.all([
          program.account.fundingRecord.all([
            { memcmp: { offset: FUNDING_RECORD_LAUNCH_OFFSET, bytes: publicKey.toBase58() } },
          ]),
          this.getMintDecimals(account.quoteMint),
        ]);

        let totalCommitted = new BN(0);
        let committerCount = 0;
        for (const { account: record } of fundingRecords) {
          if (record.committedAmount.isZero()) continue;
          totalCommitted = totalCommitted.add(record.committedAmount);
          committerCount++;
        }

        return {
          launchAddress: publicKey.toBase58(),
          version,
          tokenAddress: account.baseMint.toBase58(),
          quoteMint: account.quoteMint.toBase58(),
          quoteDecimals,
          committerCount,
          totalCommitted: formatUnits(totalCommitted, quoteDecimals),
          totalCommittedRaw: totalCommitted.toString(),
          minimumRaise: formatUnits(account.minimumRaiseAmount, quoteDecimals),
          minimumRaiseRaw: account.minimumRaiseAmount.toString(),
          closeTime,
        };
      }));
    }));

    const launches = perProgram.flat().sort((a, b) => a.closeTime - b.closeTime);
    logger.info(`[Launchpad] Refreshed live launches: ${launches.length} live`);
    return { updatedAt: new Date().toISOString(), launches };
  }

  // Caches the pending lookup so launches sharing a quote mint (usually USDC)
  // make one getMint call. A failed lookup is evicted so the next refresh retries.
  private getMintDecimals(mint: PublicKey): Promise<number> {
    const key = mint.toBase58();
    let decimals = this.mintDecimals.get(key);
    if (!decimals) {
      decimals = getMint(this.connection, mint).then((info) => info.decimals);
      decimals.catch(() => this.mintDecimals.delete(key));
      this.mintDecimals.set(key, decimals);
    }
    return decimals;
  }
}

export default LaunchpadService;
