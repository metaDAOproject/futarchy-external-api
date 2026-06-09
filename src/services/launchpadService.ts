import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet, Program } from '@coral-xyz/anchor';
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
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
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
  // DAO address (if launch completed)
  daoAddress?: PublicKey;
  // Launch address
  launchAddress?: PublicKey;
  // Total non-circulating supply (performance package + additional tokens if unclaimed + DAO treasury)
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

export interface PerformancePackageData {
  performancePackageAddress: PublicKey;
  totalTokenAmount: BN;
  alreadyUnlockedAmount: BN;
  recipient: PublicKey;
  tokenMint: PublicKey;
  state: PerformancePackageState;
}

export type PerformancePackageState = 
  | { locked: Record<string, never> }
  | { unlocking: { startAggregator: BN; startTimestamp: BN } }
  | { unlocked: Record<string, never> };

export class LaunchpadService {
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

  /**
   * Detect the launchpad version for a launch based on account fields.
   * v0.7 launches have additionalTokensAmount field.
   */
  private detectLaunchVersion(launch: any): LaunchpadVersion {
    // v0.7 has additionalTokensAmount and additionalTokensRecipient fields
    if ('additionalTokensAmount' in launch || 'additionalTokensRecipient' in launch) {
      return 'v0.7';
    }
    return 'v0.6';
  }

  private getCached<T>(key: string, ttl: number): T | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.data as T;
    }
    return null;
  }

  private setCache(key: string, data: any): void {
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
   * Fetch a Launch account by its address
   * Tries v0.7 first, falls back to v0.6 for older launches
   */
  async getLaunch(launchAddress: PublicKey): Promise<LaunchData | null> {
    const cacheKey = `launch_${launchAddress.toString()}`;
    const cached = this.getCached<LaunchData>(cacheKey, config.cache.tickersTTL * 10);
    if (cached) return cached;

    try {
      // Try v0.7 first, then v0.6
      let result = await this.fetchLaunchFromProgram(launchAddress, 'v0.7');
      if (!result) {
        result = await this.fetchLaunchFromProgram(launchAddress, 'v0.6');
      }
      
      if (!result) {
        return null;
      }

      const { launch, version } = result;

      const launchData: LaunchData = {
        launchAddress,
        baseMint: launch.baseMint,
        performancePackageGrantee: launch.performancePackageGrantee,
        performancePackageTokenAmount: new BN(launch.performancePackageTokenAmount.toString()),
        state: launch.state as LaunchState,
        dao: launch.dao || undefined,
        version,
        // v0.7 specific fields
        additionalTokensAmount: launch.additionalTokensAmount 
          ? new BN(launch.additionalTokensAmount.toString()) 
          : undefined,
        additionalTokensRecipient: launch.additionalTokensRecipient || undefined,
        additionalTokensClaimed: launch.additionalTokensClaimed || undefined,
      };

      this.setCache(cacheKey, launchData);
      return launchData;
    } catch (error) {
      logger.error(`Error fetching launch ${launchAddress.toString()}`, error);
      return null;
    }
  }

  /**
   * Fetch a Launch account by the token's base mint address
   * Tries v0.7 program first (newer launches), then falls back to v0.6
   */
  async getLaunchByBaseMint(baseMint: PublicKey): Promise<LaunchData | null> {
    const cacheKey = `launch_by_mint_${baseMint.toString()}`;
    const cached = this.getCached<LaunchData>(cacheKey, config.cache.tickersTTL * 10);
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
   * Fetch all Launch accounts from both v0.6 and v0.7 programs
   */
  async getAllLaunches(): Promise<LaunchData[]> {
    const cacheKey = 'all_launches';
    const cached = this.getCached<LaunchData[]>(cacheKey, config.cache.tickersTTL);
    if (cached) return cached;

    try {
      const launches: LaunchData[] = [];
      const seenAddresses = new Set<string>();

      // Fetch from v0.7 program first (includes all fields)
      try {
        const v07Accounts = await this.clientV07.launchpad.account.launch.all();
        for (const account of v07Accounts) {
          const launch = account.account;
          const version = this.detectLaunchVersion(launch);
          seenAddresses.add(account.publicKey.toString());
          launches.push({
            launchAddress: account.publicKey,
            baseMint: launch.baseMint,
            performancePackageGrantee: launch.performancePackageGrantee,
            performancePackageTokenAmount: new BN(launch.performancePackageTokenAmount.toString()),
            state: launch.state as LaunchState,
            dao: launch.dao || undefined,
            version,
            additionalTokensAmount: (launch as any).additionalTokensAmount 
              ? new BN((launch as any).additionalTokensAmount.toString()) 
              : undefined,
            additionalTokensRecipient: (launch as any).additionalTokensRecipient || undefined,
            additionalTokensClaimed: (launch as any).additionalTokensClaimed || undefined,
          });
        }
      } catch (error) {
        logger.warn('[Launchpad] Error fetching v0.7 launches', { error: error instanceof Error ? error.message : String(error) });
      }

      // Fetch from v0.6 program (older launches)
      try {
        const v06Accounts = await this.clientV06.launchpad.account.launch.all();
        for (const account of v06Accounts) {
          // Skip if already seen from v0.7
          if (seenAddresses.has(account.publicKey.toString())) {
            continue;
          }
          const launch = account.account;
          launches.push({
            launchAddress: account.publicKey,
            baseMint: launch.baseMint,
            performancePackageGrantee: launch.performancePackageGrantee,
            performancePackageTokenAmount: new BN(launch.performancePackageTokenAmount.toString()),
            state: launch.state as LaunchState,
            dao: launch.dao || undefined,
            version: 'v0.6',
          });
        }
      } catch (error) {
        logger.warn('[Launchpad] Error fetching v0.6 launches', { error: error instanceof Error ? error.message : String(error) });
      }

      this.setCache(cacheKey, launches);
      return launches;
    } catch (error) {
      logger.error('[Launchpad] Error fetching all launches', error);
      return [];
    }
  }

  /**
   * Fetch a PerformancePackage account by its address
   */
  async getPerformancePackage(performancePackageAddress: PublicKey): Promise<PerformancePackageData | null> {
    const cacheKey = `performance_package_${performancePackageAddress.toString()}`;
    const cached = this.getCached<PerformancePackageData>(cacheKey, config.cache.tickersTTL * 10);
    if (cached) return cached;

    try {
      // Try v0.7 first, then v0.6
      const pkgV07 = await this.clientV07.priceBasedUnlock.getPerformancePackage(performancePackageAddress);
      const pkg = pkgV07 ?? await this.clientV06.priceBasedUnlock.getPerformancePackage(performancePackageAddress);
      if (!pkg) {
        return null;
      }

      const packageData: PerformancePackageData = {
        performancePackageAddress,
        totalTokenAmount: pkg.totalTokenAmount,
        alreadyUnlockedAmount: pkg.alreadyUnlockedAmount,
        recipient: pkg.recipient,
        tokenMint: pkg.tokenMint,
        state: pkg.state as PerformancePackageState,
      };

      this.setCache(cacheKey, packageData);
      return packageData;
    } catch (error) {
      logger.error(`[Launchpad] Error fetching performance package ${performancePackageAddress.toString()}`, error);
      return null;
    }
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
   * Get the complete token allocation breakdown for a launchpad token.
   * This provides a complete picture of where all tokens are allocated:
   * - Team Performance Package (locked)
   * - FutarchyAMM Liquidity (internal AMM)
   * - Meteora LP Liquidity (external DEX)
   * - Additional Token Allocation (v0.7+ only, not in circulating supply until claimed)
   * 
   * Circulating Supply = Total - Team - FutarchyAMM - Meteora - AdditionalTokens (if unclaimed)
   */
  async getTokenAllocationBreakdown(baseMint: PublicKey): Promise<TokenAllocationBreakdown> {
    const cacheKey = `allocation_${baseMint.toString()}`;
    const cached = this.getCached<TokenAllocationBreakdown>(cacheKey, config.cache.tickersTTL * 5);
    if (cached) return cached;

    const emptyBreakdown: TokenAllocationBreakdown = {
      version: 'v0.6',
      teamPerformancePackage: { amount: new BN(0) },
      futarchyAmmLiquidity: { amount: new BN(0) },
      meteoraLpLiquidity: { amount: new BN(0) },
      daoTreasuryTokens: { amount: new BN(0) },
      totalNonCirculating: new BN(0),
    };

    try {
      const launch = await this.getLaunchByBaseMint(baseMint);
      if (!launch) {
        // Token was not launched via launchpad
        return emptyBreakdown;
      }

      if (!launch.dao) {
        // Launch not yet completed
        return {
          ...emptyBreakdown,
          version: launch.version,
          launchAddress: launch.launchAddress,
        };
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
        launch.version
      );

      let performancePackageLockedAmount = new BN(0);
      try {
        const ppAta = await getAssociatedTokenAddress(
          baseMint,
          performancePackageAddress,
          true
        );
        const ppTokenAccount = await getAccount(this.connection, ppAta);
        performancePackageLockedAmount = new BN(ppTokenAccount.amount.toString());
        logger.info(`[Launchpad] Performance package at ${performancePackageAddress.toString()} holds ${performancePackageLockedAmount.toString()} tokens (configured: ${launch.performancePackageTokenAmount.toString()})`);
      } catch (error: any) {
        // Account genuinely absent → all tokens unlocked/claimed → 0 locked (correct).
        // An RPC failure must propagate: treating it as 0 locked would OVERSTATE
        // circulating supply (the live-balance approach exists precisely to avoid
        // mis-subtracting — so a silent 0 on outage is the exact failure to avoid).
        if (!isTokenAccountAbsent(error)) throw error;
        logger.info(`[Launchpad] Performance package token account not found for ${performancePackageAddress.toString()}, 0 locked`);
      }

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
        // Get the token account address for the additional tokens recipient
        let tokenAccountAddress: PublicKey | undefined;
        try {
          tokenAccountAddress = await getAssociatedTokenAddress(
            baseMint,
            launch.additionalTokensRecipient
          );
        } catch (error) {
          logger.warn(`[Launchpad] Could not derive additional tokens account for ${launch.additionalTokensRecipient.toString()}`);
        }

        additionalTokenAllocation = {
          recipient: launch.additionalTokensRecipient,
          amount: launch.additionalTokensAmount,
          claimed: launch.additionalTokensClaimed || false,
          tokenAccountAddress,
        };
      }

      // Get DAO treasury base token balance (tokens held by the squads vault)
      let daoTreasuryTokens: { amount: BN; vaultAddress?: PublicKey } = { amount: new BN(0) };
      if (dao && (dao as any).squadsMultisigVault) {
        try {
          const vaultAddress = new PublicKey((dao as any).squadsMultisigVault);
          const vaultAta = await getAssociatedTokenAddress(baseMint, vaultAddress, true);
          const tokenAccount = await getAccount(this.connection, vaultAta);
          daoTreasuryTokens = {
            amount: new BN(tokenAccount.amount.toString()),
            vaultAddress,
          };
          logger.info(`[Launchpad] DAO treasury holds ${daoTreasuryTokens.amount.toString()} base tokens in vault ${vaultAddress.toString()}`);
        } catch (error: any) {
          // Genuinely-absent treasury ATA → 0 treasury tokens (correct). An RPC
          // failure must propagate (a silent 0 here overstates circulating supply).
          if (!isTokenAccountAbsent(error)) throw error;
          logger.info(`[Launchpad] No base token account in DAO treasury vault`);
        }
      }

      // Calculate total non-circulating supply using live on-chain balance
      let totalNonCirculating = performancePackageLockedAmount;
      
      // Add additional tokens if not yet claimed (they're still locked)
      if (additionalTokenAllocation && !additionalTokenAllocation.claimed) {
        totalNonCirculating = totalNonCirculating.add(additionalTokenAllocation.amount);
      }

      // Add DAO treasury tokens (protocol-controlled, not circulating)
      totalNonCirculating = totalNonCirculating.add(daoTreasuryTokens.amount);

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
        daoAddress: launch.dao,
        launchAddress: launch.launchAddress,
        totalNonCirculating,
      };

      this.setCache(cacheKey, breakdown);
      return breakdown;
    } catch (error) {
      logger.error(`Error getting token allocation breakdown for ${baseMint.toString()}`, error);
      return emptyBreakdown;
    }
  }


  /**
   * Build a map of baseMint -> lockedAmount for all launched tokens
   * Includes performance package + unclaimed additional tokens
   * More efficient when you need to check multiple tokens
   */
  async buildLockedAmountsMap(): Promise<Map<string, BN>> {
    const cacheKey = 'locked_amounts_map';
    const cached = this.getCached<Map<string, BN>>(cacheKey, config.cache.tickersTTL);
    if (cached) return cached;

    const lockedAmountsMap = new Map<string, BN>();
    
    try {
      const allLaunches = await this.getAllLaunches();
      
      for (const launch of allLaunches) {
        // Only include completed launches (those with a DAO set)
        if (launch.dao) {
          let totalLocked = launch.performancePackageTokenAmount;
          
          // Add unclaimed additional tokens (v0.7+ only)
          if (launch.version === 'v0.7' && 
              launch.additionalTokensAmount && 
              !launch.additionalTokensClaimed) {
            totalLocked = totalLocked.add(launch.additionalTokensAmount);
          }
          
          lockedAmountsMap.set(
            launch.baseMint.toString(),
            totalLocked
          );
        }
      }

      this.setCache(cacheKey, lockedAmountsMap);
      return lockedAmountsMap;
    } catch (error) {
      logger.error('Error building locked amounts map', error);
      return lockedAmountsMap;
    }
  }

  /**
   * Get detailed locked amounts breakdown including additional token allocations
   */
  async buildLockedAmountsDetailedMap(): Promise<Map<string, {
    performancePackage: BN;
    additionalTokens?: {
      amount: BN;
      recipient: PublicKey;
      claimed: boolean;
    };
    totalLocked: BN;
    version: LaunchpadVersion;
  }>> {
    const cacheKey = 'locked_amounts_detailed_map';
    const cached = this.getCached<Map<string, any>>(cacheKey, config.cache.tickersTTL);
    if (cached) return cached;

    const detailedMap = new Map<string, any>();
    
    try {
      const allLaunches = await this.getAllLaunches();
      
      for (const launch of allLaunches) {
        // Only include completed launches (those with a DAO set)
        if (launch.dao) {
          let totalLocked = launch.performancePackageTokenAmount;
          
          const entry: any = {
            performancePackage: launch.performancePackageTokenAmount,
            version: launch.version,
          };
          
          // Add additional tokens info (v0.7+ only)
          if (launch.version === 'v0.7' && 
              launch.additionalTokensAmount && 
              launch.additionalTokensRecipient) {
            entry.additionalTokens = {
              amount: launch.additionalTokensAmount,
              recipient: launch.additionalTokensRecipient,
              claimed: launch.additionalTokensClaimed || false,
            };
            
            // Only add to locked total if not claimed
            if (!launch.additionalTokensClaimed) {
              totalLocked = totalLocked.add(launch.additionalTokensAmount);
            }
          }
          
          entry.totalLocked = totalLocked;
          detailedMap.set(launch.baseMint.toString(), entry);
        }
      }

      this.setCache(cacheKey, detailedMap);
      return detailedMap;
    } catch (error) {
      logger.error('Error building detailed locked amounts map', error);
      return detailedMap;
    }
  }
}

export default LaunchpadService;

