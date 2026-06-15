import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import { getMint, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { config } from '../config.js';
import BN from 'bn.js';
import { retry, isTransientError, createRetryLogger } from '../utils/resilience.js';
import { logger } from '../utils/logger.js';

export interface PoolData {
  baseReserves: BN;
  quoteReserves: BN;
  baseProtocolFees: BN;
  quoteProtocolFees: BN;
}

export interface TokenMetadata {
  symbol: string;
  name: string;
}

export interface DaoTickerData {
  daoAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  baseSymbol?: string;
  baseName?: string;
  quoteSymbol?: string;
  quoteName?: string;
  poolData: PoolData;
  treasuryUsdcAum?: string;
  treasuryVaultAddress?: string;
}

interface PoolState {
  baseReserves: number | BN | string;
  quoteReserves: number | BN | string;
  baseProtocolFeeBalance?: number | BN | string;
  quoteProtocolFeeBalance?: number | BN | string;
}

export class FutarchyService {
  private connection: Connection;
  private client: FutarchyClient;
  private cache: Map<string, { data: any; timestamp: number }>;
  private rateLimitErrors: number = 0;
  private lastRateLimitTime: number = 0;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    
    // Create a dummy wallet for read-only operations
    // If ANCHOR_WALLET is set, use it; otherwise use a generated keypair
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
    this.client = FutarchyClient.createClient({ provider });
    this.cache = new Map();
  }

  private isRateLimitError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorString = String(error).toLowerCase();
    
    return (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('429') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('429 too many requests') ||
      errorString.includes('rate limit') ||
      errorString.includes('429') ||
      error?.code === 429 ||
      error?.status === 429
    );
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    return retry(fn, {
      maxRetries,
      initialDelayMs: baseDelay,
      maxDelayMs: 10000,
      isRetryable: (error) => {
        // Track rate limit errors for monitoring
        if (this.isRateLimitError(error)) {
          this.rateLimitErrors++;
          this.lastRateLimitTime = Date.now();
          return true;
        }
        return isTransientError(error);
      },
      onRetry: createRetryLogger('[Solana]'),
    });
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

  async getPoolData(daoAddress?: PublicKey): Promise<PoolData | null> {
    const daoPubkey = daoAddress;
    if (!daoPubkey) {
      throw new Error('DAO address is required. Provide daoAddress parameter or set DAO_PUBLIC_KEY environment variable.');
    }
    const cacheKey = `pool_data_${daoPubkey.toString()}`;
    const cached = this.getCached<PoolData>(cacheKey, config.cache.tickersTTL);
    if (cached) return cached;

    let dao: any;
    try {
      dao = await this.retryWithBackoff(() => this.client.getDao(daoPubkey));
    } catch (error: any) {
      const isRateLimited = this.isRateLimitError(error);
      if (isRateLimited) {
        logger.error(`Rate limited while fetching DAO ${daoPubkey.toString()}:`, error);
      } else {
        logger.error(`Error fetching DAO ${daoPubkey.toString()}:`, error);
      }
      throw error;
    }
    
    // Try to find a pool with non-zero reserves
    // Check all possible pools: spot, and if futarchy, check all available pools
    const poolsToCheck: PoolState[] = [];
    
    if (!dao?.amm || !dao?.amm?.state) {
      return null;
    }
    
    if ('spot' in dao.amm.state) {
      // Simple spot state - check if it has a nested pool field
      const spotState = dao.amm.state.spot as any;
      
      if (spotState && typeof spotState === 'object') {
        // Check for nested structures: spot.spot, spot.pool, or spot itself
        if ('spot' in spotState && spotState.spot) {
          // Double-nested: spot.spot contains the pool
          poolsToCheck.push(spotState.spot as unknown as PoolState);
        } else if ('pool' in spotState && spotState.pool) {
          // Nested pool: spot.pool contains the pool
          poolsToCheck.push(spotState.pool as unknown as PoolState);
        } else {
          // Spot might be the pool itself (check if it has reserves)
          if ('baseReserves' in spotState || 'quoteReserves' in spotState) {
            poolsToCheck.push(spotState as unknown as PoolState);
          }
        }
      }
    } else if ('futarchy' in dao.amm.state) {
      // Futarchy state - ONLY use spot pool, ignore conditional pools (pass/fail)
      const futarchyState = dao.amm.state.futarchy as any;
      
      // Check spot pool only - it might be directly accessible or nested in a pool field
      if (futarchyState.spot) {
        // The spot might be an enum variant with a pool inside it
        if (typeof futarchyState.spot === 'object') {
          // Check if spot has a pool field (nested structure)
          if ('pool' in futarchyState.spot) {
            poolsToCheck.push(futarchyState.spot.pool as unknown as PoolState);
          } else {
            // Spot might be the pool itself
            poolsToCheck.push(futarchyState.spot as unknown as PoolState);
          }
        }
      }
      
      // Explicitly do NOT check conditional pools (pass/fail) - only use spot
    } else {
      return null;
    }
    
    if (poolsToCheck.length === 0) {
      return null;
    }

    // Find the pool with the highest liquidity (sum of base and quote reserves)
    let bestPool: PoolState | null = null;
    let bestLiquidity = new BN(0);

    for (let i = 0; i < poolsToCheck.length; i++) {
      const pool = poolsToCheck[i];
      if (!pool) continue;
      
      try {
        const baseReserves = new BN(pool.baseReserves);
        const quoteReserves = new BN(pool.quoteReserves);
        const totalLiquidity = baseReserves.add(quoteReserves);
        
        // Only consider pools with non-zero reserves
        if (totalLiquidity.gt(new BN(0)) && totalLiquidity.gt(bestLiquidity)) {
          bestPool = pool;
          bestLiquidity = totalLiquidity;
        }
      } catch (error) {
        // Skip invalid pools
        continue;
      }
    }

    if (!bestPool) {
      return null;
    }

    const poolData: PoolData = {
      baseReserves: new BN(bestPool.baseReserves),
      quoteReserves: new BN(bestPool.quoteReserves),
      baseProtocolFees: new BN(bestPool.baseProtocolFeeBalance || 0),
      quoteProtocolFees: new BN(bestPool.quoteProtocolFeeBalance || 0),
    };

    this.setCache(cacheKey, poolData);
    return poolData;
  }

  async getTokenDecimals(mintAddress: PublicKey): Promise<number> {
    const cacheKey = `token_decimals_${mintAddress.toString()}`;
    const cached = this.getCached<number>(cacheKey, config.cache.tickersTTL * 10); // Cache decimals longer
    if (cached !== null) return cached;

    // No fallback default: a wrong decimals value silently scales price by
    // 10^(±n) (e.g. assuming 9 for a 6-decimal token makes the served price 1000x
    // wrong). On an RPC failure this MUST throw so the caller drops/fails rather
    // than serving a mispriced ticker. Decimals are immutable, so the long cache
    // above already shields the steady state from RPC blips.
    const mintInfo = await this.retryWithBackoff(() => getMint(this.connection, mintAddress));
    const decimals = mintInfo.decimals;
    this.setCache(cacheKey, decimals);
    return decimals;
  }

  private async findMetadataPDA(mintAddress: PublicKey): Promise<PublicKey> {
    // Metaplex Token Metadata Program ID
    const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
    
    // Derive the metadata PDA
    const [metadataPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        mintAddress.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID
    );
    
    return metadataPDA;
  }

  async getTokenMetadata(mintAddress: PublicKey): Promise<TokenMetadata | null> {
    const cacheKey = `token_metadata_${mintAddress.toString()}`;
    const cached = this.getCached<TokenMetadata>(cacheKey, config.cache.tickersTTL * 100); // Cache metadata much longer
    if (cached) return cached;

    try {
      const metadataPDA = await this.findMetadataPDA(mintAddress);
      const accountInfo = await this.retryWithBackoff(() => 
        this.connection.getAccountInfo(metadataPDA)
      );

      if (!accountInfo || !accountInfo.data) {
        return null;
      }

      // Parse Metaplex Token Metadata structure
      // Offset 1: key (1 byte) - skip
      // Offset 1-33: update authority (32 bytes) - skip
      // Offset 33-65: mint (32 bytes) - skip
      // Offset 65-97: data struct starts
      //   - name string (4 bytes length + string)
      //   - symbol string (4 bytes length + string)
      //   - uri string (4 bytes length + string)

      const data = accountInfo.data;
      let offset = 1 + 32 + 32; // Skip key, update authority, mint

      // Read name
      const nameLength = data.readUInt32LE(offset);
      offset += 4;
      const name = data.slice(offset, offset + nameLength).toString('utf8').replace(/\0/g, '');
      offset += nameLength;

      // Read symbol
      const symbolLength = data.readUInt32LE(offset);
      offset += 4;
      const symbol = data.slice(offset, offset + symbolLength).toString('utf8').replace(/\0/g, '');

      const metadata: TokenMetadata = {
        symbol: symbol || mintAddress.toString().slice(0, 8),
        name: name || mintAddress.toString().slice(0, 8),
      };

      this.setCache(cacheKey, metadata);
      return metadata;
    } catch (error: any) {
      // Return null if we can't fetch metadata - we'll use the mint address as fallback
      return null;
    }
  }

  /**
   * Get USDC balance for a given vault address (owner)
   * USDC mint on Solana mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   */
  async getUsdcBalanceForVault(vaultAddress: PublicKey): Promise<string | null> {
    const cacheKey = `usdc_balance_${vaultAddress.toString()}`;
    const cached = this.getCached<string>(cacheKey, config.cache.tickersTTL);
    if (cached !== null) return cached;

    try {
      // USDC mint address on Solana mainnet
      const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      
      // Get the associated token account address for the vault
      const tokenAccountAddress = await getAssociatedTokenAddress(
        USDC_MINT,
        vaultAddress,
        true
      );

      // Get the token account
      const tokenAccount = await this.retryWithBackoff(() => 
        getAccount(this.connection, tokenAccountAddress)
      );

      // USDC has 6 decimals
      const balance = tokenAccount.amount.toString();
      const balanceFormatted = (Number(balance) / 1e6).toFixed(6);

      this.setCache(cacheKey, balanceFormatted);
      return balanceFormatted;
    } catch (error: any) {
      // If token account doesn't exist or other error, return null
      // This is expected for vaults that don't have USDC
      return null;
    }
  }

  async getAllDaos(): Promise<DaoTickerData[]> {
    const cacheKey = 'all_daos';
    const cached = this.getCached<DaoTickerData[]>(cacheKey, config.cache.tickersTTL);
    if (cached) return cached;

    // Single-flight: concurrent callers after cache expiry share one scan instead
    // of each launching a full DAO+RPC sweep (cache stampede against the RPC).
    if (this.allDaosInFlight) return this.allDaosInFlight;
    this.allDaosInFlight = this.fetchAllDaos(cacheKey).finally(() => {
      this.allDaosInFlight = null;
    });
    return this.allDaosInFlight;
  }

  private allDaosInFlight: Promise<DaoTickerData[]> | null = null;

  private async fetchAllDaos(cacheKey: string): Promise<DaoTickerData[]> {
    try {
      // Fetch all DAO accounts with retry logic
      let daoAccounts: any[];
      try {
        daoAccounts = await this.retryWithBackoff(() => this.client.futarchy.account.dao.all());
      } catch (error: any) {
        const isRateLimited = this.isRateLimitError(error);
        if (isRateLimited) {
          logger.error('Rate limited while fetching all DAOs:', error);
        } else {
          logger.error('Error fetching all DAOs:', error);
        }
        throw error;
      }
      
      // Process DAOs sequentially with delays to avoid rate limiting
      const validDaoData: DaoTickerData[] = [];
      let perDaoErrors = 0;

      for (let i = 0; i < daoAccounts.length; i++) {
        const daoAccount = daoAccounts[i];
        if (!daoAccount) continue;
        
        const daoAddress = daoAccount.publicKey;
        
        // Check if this DAO is in the excluded list
        if (config.excludedDaos.some(excluded => excluded.equals(daoAddress))) {
          continue;
        }
        
        try {
          // Add a small delay between requests to avoid rate limiting
          if (i > 0 && i % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay every 10 DAOs
          }
          
          const dao = daoAccount.account;
          
          // Extract base and quote mints from DAO account
          const baseMint = dao.baseMint;
          const quoteMint = dao.quoteMint;

          // Get token decimals and metadata
          const [baseDecimals, quoteDecimals, baseMetadata, quoteMetadata] = await Promise.all([
            this.getTokenDecimals(baseMint),
            this.getTokenDecimals(quoteMint),
            this.getTokenMetadata(baseMint),
            this.getTokenMetadata(quoteMint),
          ]);
          
          // Get pool data for this DAO
          const poolData = await this.getPoolData(daoAddress);
          
          // Skip if no valid pool found
          if (!poolData) {
            continue;
          }
          
          // Validate pool data - filter out pools with zero or invalid reserves
          const baseReservesNum = poolData.baseReserves.toNumber();
          const quoteReservesNum = poolData.quoteReserves.toNumber();
          
          if (baseReservesNum === 0 || quoteReservesNum === 0 ||
              !isFinite(baseReservesNum) || !isFinite(quoteReservesNum) ||
              isNaN(baseReservesNum) || isNaN(quoteReservesNum)) {
            continue;
          }
          
          // Get treasury USDC balance if squads_multisig_vault exists
          let treasuryUsdcAum: string | undefined;
          let treasuryVaultAddress: string | undefined;
          
          if (dao.squadsMultisigVault) {
            try {
              const vaultAddress = new PublicKey(dao.squadsMultisigVault);
              treasuryVaultAddress = vaultAddress.toString();
              const usdcBalance = await this.getUsdcBalanceForVault(vaultAddress);
              treasuryUsdcAum = usdcBalance || undefined;
            } catch (error: any) {
              // If vault address is invalid or balance can't be fetched, continue without it
              logger.warn(`Could not fetch USDC balance for vault ${dao.squads_multisig_vault} for DAO ${daoAddress.toString()}:`, { error: error.message });
            }
          }
          
          validDaoData.push({
            daoAddress,
            baseMint,
            quoteMint,
            baseDecimals,
            quoteDecimals,
            baseSymbol: baseMetadata?.symbol,
            baseName: baseMetadata?.name,
            quoteSymbol: quoteMetadata?.symbol,
            quoteName: quoteMetadata?.name,
            poolData,
            treasuryUsdcAum,
            treasuryVaultAddress,
          });
        } catch (error: any) {
          // A per-DAO fetch failed (RPC/decimals/pool/metadata). Skip THIS dao so
          // one flaky account doesn't take down the whole feed — but count it, so
          // we can refuse to serve a silently-shrunken list below (see guard).
          perDaoErrors++;
          const isRateLimited = this.isRateLimitError(error);
          if (isRateLimited) {
            // Wait longer if rate limited
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          // Continue processing other DAOs
        }
      }

      if (this.rateLimitErrors > 0) {
        logger.warn(`⚠️  Encountered ${this.rateLimitErrors} rate limit errors during processing`);
      }

      // Don't serve an empty (or all-failed) ticker set as if it were real: if we
      // had DAOs to process and produced ZERO results while errors occurred, that's
      // an infrastructure problem (RPC degraded), not a genuinely empty market.
      // Throw so /api/tickers returns an error the poller retries — never an empty
      // 200 that reads as "everything delisted / zero volume".
      if (validDaoData.length === 0 && daoAccounts.length > 0 && perDaoErrors > 0) {
        throw new Error(
          `getAllDaos produced 0 tickers from ${daoAccounts.length} DAOs with ${perDaoErrors} fetch errors — refusing to serve an empty set`,
        );
      }

      this.setCache(cacheKey, validDaoData);
      return validDaoData;
    } catch (error) {
      logger.error('Error fetching all DAOs:', error);
      throw error;
    }
  }

}