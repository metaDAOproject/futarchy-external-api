import {
  Connection,
  PublicKey,
  Keypair,
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  LaunchpadClient as LaunchpadClientV06,
  getLaunchSignerAddr,
} from "@metadaoproject/programs/launchpad/v0.6";
import {
  LaunchpadClient as LaunchpadClientV07,
} from "@metadaoproject/programs/launchpad/v0.7";
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import { getPerformancePackageAddr } from "@metadaoproject/programs/price_based_performance_package/v0.6";
import {
  PRICE_BASED_PERFORMANCE_PACKAGE_PROGRAM_ID,
  DAMM_V2_PROGRAM_ID,
  LAUNCHPAD_V0_6_MAINNET_METEORA_CONFIG as MAINNET_METEORA_CONFIG_V06,
  LAUNCHPAD_V0_7_MAINNET_METEORA_CONFIG as MAINNET_METEORA_CONFIG_V07,
} from "@metadaoproject/programs";
import {
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { isTokenAccountAbsent } from '../utils/solanaErrors.js';
import { config } from '../config.js';
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
  // Confirmed Solana slot for the single mint-supply and live-balance RPC batch.
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

export type LaunchState =
  | { initialized: Record<string, never> }
  | { active: Record<string, never> }
  | { closed: Record<string, never> }
  | { completed: Record<string, never> }
  | { cancelled: Record<string, never> };

export class LaunchpadService {
  private static readonly CACHE_MAX_ENTRIES = 1000;
  private static readonly MAX_SNAPSHOT_ACCOUNTS = 100;

  private connection: Connection;
  private clientV06: LaunchpadClientV06;
  private clientV07: LaunchpadClientV07;
  private futarchyClient: FutarchyClient;
  private cache: Map<string, { data: any; timestamp: number }>;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    
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
    this.futarchyClient = FutarchyClient.createClient({ provider });
    this.cache = new Map();
  }

  private getCached<T>(key: string, ttl: number): T | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.data as T;
    }
    return null;
  }

  private setCache(key: string, data: any): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    if (this.cache.size >= LaunchpadService.CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { data, timestamp: Date.now() });
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
   * Fetch a Launch account by its address from the specified program
   */
  private async fetchLaunchFromProgram(
    launchAddress: PublicKey, 
    version: LaunchpadVersion
  ): Promise<{ launch: any; version: LaunchpadVersion } | null> {
    try {
      const client = version === 'v0.7' ? this.clientV07 : this.clientV06;
      const launch = await client.fetchLaunch(launchAddress);
      if (launch) {
        logger.info(`[Launchpad] Found launch in ${version} program at ${launchAddress.toString()}`);
        return { launch, version };
      }
    } catch (error: any) {
      // ONLY a genuinely-absent account means "no launch of this version" → null
      // (the caller then tries the other version, and a token with no launch at all
      // correctly gets an empty allocation breakdown). ANY OTHER error (RPC /
      // network / timeout) MUST propagate: a silent null here makes
      // getTokenAllocationBreakdown treat a launched token as un-launched → ZERO
      // locked allocations → circulating supply = total supply (hugely overstated
      // market cap on a transient RPC blip).
      if (!error.message?.includes('Account does not exist')) {
        logger.info(`[Launchpad] Error fetching ${version} launch at ${launchAddress.toString()}: ${error.message}`);
        throw error;
      }
    }
    return null;
  }

  /**
   * Fetch a Launch account by the token's base mint address
   * Tries v0.7 program first (newer launches), then falls back to v0.6
   */
  async getLaunchByBaseMint(baseMint: PublicKey): Promise<LaunchData | null> {
    const cacheKey = `launch_by_mint_${baseMint.toString()}`;
    // Claim state changes circulating supply, so launch data must not outlive the
    // allocation/supply cache cadence.
    const cached = this.getCached<LaunchData>(cacheKey, config.cache.tickersTTL);
    if (cached) return cached;

    const launchAddressV07 = this.getLaunchAddressV07(baseMint);
    logger.info(`[Launchpad] Checking v0.7 launch at ${launchAddressV07.toString()} for mint ${baseMint.toString()}`);
    let launch = await this.fetchLaunchFromProgram(launchAddressV07, 'v0.7');
    
    // If not found in v0.7, try v0.6
    if (!launch) {
      const launchAddressV06 = this.getLaunchAddressV06(baseMint);
      logger.debug(`[Launchpad] v0.7 not found, checking v0.6 launch at ${launchAddressV06.toString()}`);
      launch = await this.fetchLaunchFromProgram(launchAddressV06, 'v0.6');
    }

    if (!launch) {
      logger.debug(`[Launchpad] No launch found for mint ${baseMint.toString()}`);
      return null;
    }

    logger.debug(`[Launchpad] Found ${launch.version} launch for mint ${baseMint.toString()}`);
    

    const { launch: launchAccount, version } = launch;
    const launchAddress = version === 'v0.7' ? launchAddressV07 : this.getLaunchAddressV06(baseMint);

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

    this.setCache(cacheKey, launchData);
    return launchData;
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
   * Get the FutarchyAMM liquidity for a DAO.
   * This is the base token balance in the DAO's embedded AMM base vault.
   */
  async getFutarchyAmmLiquidity(daoAddress: PublicKey): Promise<{
    amount: BN;
    vaultAddress?: PublicKey;
  }> {
    try {
      const dao = await this.futarchyClient.fetchDao(daoAddress);
      if (!dao) {
        return { amount: new BN(0) };
      }

      const vaultAddress = dao.amm.ammBaseVault;
      const tokenAccount = await getAccount(this.connection, vaultAddress);
      const amount = new BN(tokenAccount.amount.toString());

      return { amount, vaultAddress };
    } catch (error) {
      // Only treat a genuinely-absent vault as 0 liquidity. An RPC failure here
      // would UNDERCOUNT locked AMM liquidity → OVERSTATE circulating supply →
      // wrong market cap, so it must propagate (the supply endpoint errors out).
      if (!isTokenAccountAbsent(error)) throw error;
      return { amount: new BN(0) };
    }
  }

  /**
   * Get the Meteora LP liquidity for a token pair.
   * This is the base token balance in the Meteora pool's vault.
   * 
   * Note: The pool address derivation follows Meteora DAMM v2 seeds.
   * v0.6 and v0.7 launches use different Meteora configs.
   * 
   * @param baseMint - The base token mint
   * @param quoteMint - The quote token mint
   * @param version - The launchpad version (determines which Meteora config to use)
   */
  async getMeteoraLpLiquidity(
    baseMint: PublicKey, 
    quoteMint: PublicKey,
    version: LaunchpadVersion = 'v0.6'
  ): Promise<{
    amount: BN;
    poolAddress?: PublicKey;
    vaultAddress?: PublicKey;
  }> {
    try {
      const meteoraConfig = this.getMeteoraConfig(version);
      const poolAddress = this.getMeteoraPoolAddress(baseMint, quoteMint, version);
      const vaultAddress = this.getMeteoraPoolVault(poolAddress, baseMint);
      
      logger.info(`[Meteora] Checking ${version} pool ${poolAddress.toString()} (config: ${meteoraConfig.toString().slice(0, 8)}...) vault ${vaultAddress.toString()} for ${baseMint.toString()}`);
      
      const tokenAccount = await getAccount(this.connection, vaultAddress);
      const amount = new BN(tokenAccount.amount.toString());

      logger.info(`[Meteora] Found ${amount.toString()} tokens in Meteora ${version} pool`);
      return { amount, poolAddress, vaultAddress };
    } catch (error: any) {
      // Genuinely-absent pool vault → 0 LP is correct. An RPC failure must NOT be
      // read as 0 (it would overstate circulating supply / market cap) → propagate.
      if (!isTokenAccountAbsent(error)) throw error;
      logger.info(`[Meteora] ${version} pool not present for ${baseMint.toString()} — 0 LP`);
      return { amount: new BN(0) };
    }
  }

  /**
   * Discover every configured holder's token accounts, then read the mint and all
   * relevant token accounts in one contextual getMultipleAccounts call. Account
   * discovery is repeated after the snapshot; if the address set changed around
   * the snapshot, the whole operation is retried.
   */
  private async getLiveBalanceSnapshot(
    baseMint: PublicKey,
    performancePackageOwner?: PublicKey,
    daoTreasuryOwner?: PublicKey,
  ): Promise<{
    excludedHolders: ExcludedHolderBalance[];
    performancePackageAmount: BN;
    daoTreasuryAmount: BN;
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
      for (const response of firstDiscovery) {
        for (const { pubkey } of response.value) addAddress(pubkey);
      }
      addAddress(performancePackageAtas?.legacy);
      addAddress(performancePackageAtas?.token2022);
      addAddress(daoTreasuryAtas?.legacy);
      addAddress(daoTreasuryAtas?.token2022);

      if (uniqueAddresses.size > LaunchpadService.MAX_SNAPSHOT_ACCOUNTS) {
        throw new Error(
          `[Launchpad] Non-circulating snapshot for ${mint} requires ${uniqueAddresses.size} accounts; maximum is ${LaunchpadService.MAX_SNAPSHOT_ACCOUNTS}`,
        );
      }

      const addresses = [...uniqueAddresses.values()];
      const snapshot = await this.connection.getMultipleAccountsInfoAndContext(
        addresses,
        {
          commitment: 'confirmed',
          ...(minimumSnapshotSlot > 0 ? { minContextSlot: minimumSnapshotSlot } : {}),
        },
      );
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
            )),
          new BN(0),
        );
        logger.info(
          `[Launchpad] Excluded holder ${holder.wallet.toString()} (${holder.label ?? 'unlabeled'}) holds ${amount.toString()} tokens of ${mint} across ${addressesForHolder.length} account(s)`,
        );
        return { wallet: holder.wallet, label: holder.label, amount };
      });

      return {
        excludedHolders,
        performancePackageAmount: readTokenAmount(
          performancePackageAta,
          `performance package ATA ${performancePackageAta?.toString()}`,
          true,
        ),
        daoTreasuryAmount: readTokenAmount(
          daoTreasuryAta,
          `DAO treasury ATA ${daoTreasuryAta?.toString()}`,
          true,
        ),
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

  private async getExcludedHolderBalances(baseMint: PublicKey): Promise<ExcludedHolderBalance[]> {
    if (!config.circulating.excludedHolders.some(holder => holder.mint === baseMint.toString())) {
      return [];
    }
    const snapshot = await this.getLiveBalanceSnapshot(baseMint);
    return snapshot.excludedHolders;
  }

  /**
   * Get the complete token allocation breakdown for a launchpad token.
   * This provides a complete picture of where all tokens are allocated:
   * - Team Performance Package (locked)
   * - FutarchyAMM Liquidity (internal AMM)
   * - Meteora LP Liquidity (external DEX)
   * - Additional Token Allocation (v0.7+ only, not in circulating supply until claimed)
   *
   * FutarchyAMM and Meteora liquidity remain circulating. Mint supply and live
   * non-circulating balances are read in one confirmed contextual RPC batch and
   * cached for the normal ticker TTL.
   */
  async getTokenAllocationBreakdown(baseMint: PublicKey): Promise<TokenAllocationBreakdown> {
    const cacheKey = `allocation_${baseMint.toString()}`;
    const cached = this.getCached<TokenAllocationBreakdown>(cacheKey, config.cache.tickersTTL);
    if (cached) return cached;

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
      this.setCache(cacheKey, breakdown);
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
      this.setCache(cacheKey, breakdown);
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
    // Get FutarchyAMM liquidity
    const futarchyAmm = await this.getFutarchyAmmLiquidity(launch.dao);

    // Get Meteora LP liquidity (if quote mint is available)
    // Use the correct Meteora config based on launch version
    let meteoraLp: { amount: BN; poolAddress?: PublicKey; vaultAddress?: PublicKey } = { amount: new BN(0) };
    if (quoteMint) {
      meteoraLp = await this.getMeteoraLpLiquidity(baseMint, quoteMint, launch.version);
    }

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
    );
    if (additionalTokenAllocation) {
      additionalTokenAllocation.tokenAccountAddress = await getAssociatedTokenAddress(
        baseMint,
        additionalTokenAllocation.recipient,
        true,
        snapshot.tokenProgramId,
      );
    }
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

    this.setCache(cacheKey, breakdown);
    return breakdown;
  }
}

export default LaunchpadService;
