import { Connection, PublicKey, Keypair, type AccountInfo } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { FutarchyClient } from "@metadaoproject/programs/futarchy/v0.6";
import {
  getMint,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config.js';
import BN from 'bn.js';
import { retry, isTransientError, createRetryLogger } from '../utils/resilience.js';
import { logger } from '../utils/logger.js';
import { createSolanaConnection } from '../utils/solanaConnection.js';
import { TtlCache } from '../utils/ttlCache.js';
import { metricsService } from './metricsService.js';

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

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
// getMultipleAccountsInfo accepts at most 100 keys per call.
const MAX_ACCOUNTS_PER_RPC = 100;

function metadataAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

/**
 * Name/symbol from a Metaplex metadata account: key (1) + update authority (32)
 * + mint (32), then borsh strings name, symbol (4-byte length prefix each).
 */
function parseTokenMetadata(data: Buffer, mint: PublicKey): TokenMetadata {
  let offset = 1 + 32 + 32;
  const nameLength = data.readUInt32LE(offset);
  offset += 4;
  const name = data.subarray(offset, offset + nameLength).toString('utf8').replace(/\0/g, '');
  offset += nameLength;
  const symbolLength = data.readUInt32LE(offset);
  offset += 4;
  const symbol = data.subarray(offset, offset + symbolLength).toString('utf8').replace(/\0/g, '');
  return {
    symbol: symbol || mint.toString().slice(0, 8),
    name: name || mint.toString().slice(0, 8),
  };
}

/**
 * The DAO's spot pool from its (already fetched) on-chain account, or null if
 * it has none / it's empty. Conditional (pass/fail) pools are never used.
 */
function extractSpotPool(dao: any): PoolData | null {
  const state = dao?.amm?.state;
  if (!state) return null;

  let pool: PoolState | null = null;
  if ('spot' in state) {
    const spotState = state.spot as any;
    if (spotState && typeof spotState === 'object') {
      if ('spot' in spotState && spotState.spot) pool = spotState.spot;
      else if ('pool' in spotState && spotState.pool) pool = spotState.pool;
      else if ('baseReserves' in spotState || 'quoteReserves' in spotState) pool = spotState;
    }
  } else if ('futarchy' in state) {
    const spot = (state.futarchy as any)?.spot;
    if (spot && typeof spot === 'object') {
      pool = 'pool' in spot ? spot.pool : spot;
    }
  }
  if (!pool) return null;

  let baseReserves: BN;
  let quoteReserves: BN;
  try {
    baseReserves = new BN(pool.baseReserves);
    quoteReserves = new BN(pool.quoteReserves);
  } catch {
    return null;
  }
  // BN comparisons, not toNumber(): u64 reserves can exceed 2^53, where
  // toNumber() throws and would silently drop the DAO from every feed.
  if (baseReserves.isZero() || quoteReserves.isZero() || baseReserves.isNeg() || quoteReserves.isNeg()) {
    return null;
  }

  return {
    baseReserves,
    quoteReserves,
    baseProtocolFees: new BN(pool.baseProtocolFeeBalance || 0),
    quoteProtocolFees: new BN(pool.quoteProtocolFeeBalance || 0),
  };
}

export class FutarchyService {
  private connection: Connection;
  private client: FutarchyClient;
  // Keyed by mints, some caller-supplied (DexScreener /asset), so bounded.
  private cache = new TtlCache(10_000);
  private rateLimitErrors: number = 0;
  private allDaos: { data: DaoTickerData[]; fetchedAt: number } | null = null;
  private allDaosInFlight: Promise<DaoTickerData[]> | null = null;

  constructor() {
    this.connection = createSolanaConnection();

    // Read-only: a generated keypair is enough unless ANCHOR_WALLET is set.
    let wallet: Wallet;
    try {
      wallet = Wallet.local();
    } catch {
      wallet = new Wallet(Keypair.generate());
    }

    const provider = new AnchorProvider(this.connection, wallet, {
      commitment: 'confirmed',
    });
    this.client = FutarchyClient.createClient({ provider });
  }

  private isRateLimitError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorString = String(error).toLowerCase();

    return (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('429') ||
      errorMessage.includes('too many requests') ||
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
        if (this.isRateLimitError(error)) {
          this.rateLimitErrors++;
          return true;
        }
        return isTransientError(error);
      },
      onRetry: createRetryLogger('[Solana]'),
    });
  }

  private getCached<T>(key: string, ttl: number): T | null {
    return this.cache.get<T>(key, ttl) ?? null;
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, data);
  }

  // Decimals never change and token names rarely do; cache them far longer
  // than the price snapshot.
  private static readonly DECIMALS_TTL_MS = config.cache.tickersTTL * 10;
  private static readonly METADATA_TTL_MS = config.cache.tickersTTL * 100;
  // A mint with no Metaplex metadata account (confirmed by a successful RPC
  // read, not an error) is remembered for a while so it isn't re-fetched on
  // every refresh; a later-created metadata account is picked up after this.
  private static readonly METADATA_ABSENT_TTL_MS = config.cache.tickersTTL * 10;

  async getTokenDecimals(mintAddress: PublicKey): Promise<number> {
    const cacheKey = `token_decimals_${mintAddress.toString()}`;
    const cached = this.getCached<number>(cacheKey, FutarchyService.DECIMALS_TTL_MS);
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

  async getTokenMetadata(mintAddress: PublicKey): Promise<TokenMetadata | null> {
    const cacheKey = `token_metadata_${mintAddress.toString()}`;
    const cached = this.getCached<TokenMetadata>(cacheKey, FutarchyService.METADATA_TTL_MS);
    if (cached) return cached;
    if (this.getCached<true>(`token_metadata_absent_${mintAddress}`, FutarchyService.METADATA_ABSENT_TTL_MS)) {
      return null;
    }

    try {
      const accountInfo = await this.retryWithBackoff(() =>
        this.connection.getAccountInfo(metadataAddress(mintAddress))
      );
      if (!accountInfo?.data) {
        this.setCache(`token_metadata_absent_${mintAddress}`, true);
        return null;
      }

      const metadata = parseTokenMetadata(accountInfo.data, mintAddress);
      this.setCache(cacheKey, metadata);
      return metadata;
    } catch (error) {
      // Identification only — callers fall back to the mint address.
      logger.warn('[Futarchy] Token metadata lookup failed; falling back to the mint address', {
        mint: mintAddress.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** getMultipleAccountsInfo in chunks of 100, results aligned with `keys`. */
  private async getAccountsBatched(keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> {
    const results: Array<AccountInfo<Buffer> | null> = [];
    for (let i = 0; i < keys.length; i += MAX_ACCOUNTS_PER_RPC) {
      const chunk = keys.slice(i, i + MAX_ACCOUNTS_PER_RPC);
      results.push(...await this.retryWithBackoff(() => this.connection.getMultipleAccountsInfo(chunk)));
    }
    return results;
  }

  /**
   * Fill the decimals/metadata caches for every mint not already cached, in
   * batched RPC calls (instead of 2 calls per mint). Mints that fail to load
   * here are simply left uncached; getTokenDecimals/getTokenMetadata then
   * fetch them individually and surface their errors as before.
   */
  private async prefetchMints(mints: PublicKey[]): Promise<void> {
    const unique = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
    const needDecimals = unique.filter(
      (m) => this.getCached<number>(`token_decimals_${m}`, FutarchyService.DECIMALS_TTL_MS) === null
    );
    const needMetadata = unique.filter(
      (m) => !this.getCached<TokenMetadata>(`token_metadata_${m}`, FutarchyService.METADATA_TTL_MS)
        && !this.getCached<true>(`token_metadata_absent_${m}`, FutarchyService.METADATA_ABSENT_TTL_MS)
    );
    if (needDecimals.length === 0 && needMetadata.length === 0) return;

    try {
      const infos = await this.getAccountsBatched([...needDecimals, ...needMetadata.map(metadataAddress)]);
      needDecimals.forEach((mint, i) => {
        const info = infos[i];
        if (!info) return;
        if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) return;
        this.setCache(`token_decimals_${mint}`, unpackMint(mint, info, info.owner).decimals);
      });
      needMetadata.forEach((mint, i) => {
        const info = infos[needDecimals.length + i];
        if (info?.data) this.setCache(`token_metadata_${mint}`, parseTokenMetadata(info.data, mint));
        else this.setCache(`token_metadata_absent_${mint}`, true);
      });
    } catch (error) {
      logger.warn('[Futarchy] Batched mint prefetch failed; falling back to per-mint lookups', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * USDC balance (UI units) of each treasury vault's associated token account,
   * in batched RPC calls. A vault without a USDC account is absent from the
   * map. Treasury AUM is informational, so a failed lookup omits the field
   * (logged) rather than failing the ticker feed.
   */
  private async getTreasuryUsdcBalances(vaults: PublicKey[]): Promise<Map<string, string>> {
    const balances = new Map<string, string>();
    if (vaults.length === 0) return balances;
    try {
      const atas = vaults.map((vault) => getAssociatedTokenAddressSync(USDC_MINT, vault, true));
      const infos = await this.getAccountsBatched(atas);
      infos.forEach((info, i) => {
        if (!info) return;
        const account = unpackAccount(atas[i]!, info);
        balances.set(vaults[i]!.toBase58(), (Number(account.amount) / 1e6).toFixed(6));
      });
    } catch (error) {
      logger.warn('[Futarchy] Treasury USDC balance lookup failed; omitting treasury AUM', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return balances;
  }

  /**
   * Every served DAO with live spot-pool reserves, from a snapshot that is
   * kept warm with stale-while-revalidate:
   * - younger than `cache.tickersTTL`: served as is;
   * - older, but younger than `cache.tickersMaxStale`: served immediately
   *   while one background refresh runs;
   * - older than that (or none yet): the caller waits for a fresh scan, which
   *   throws (→ 5xx) if the RPC is down — prices older than the cap are never
   *   served.
   */
  async getAllDaos(): Promise<DaoTickerData[]> {
    const ageMs = this.allDaos ? Date.now() - this.allDaos.fetchedAt : Infinity;
    // Both limits apply, so a cap configured below the TTL is still honored.
    if (this.allDaos && ageMs < config.cache.tickersTTL && ageMs < config.cache.tickersMaxStale) {
      return this.allDaos.data;
    }

    const refresh = this.refreshAllDaos();
    if (this.allDaos && ageMs < config.cache.tickersMaxStale) {
      refresh.catch(() => {}); // logged in fetchAllDaos; the next caller retries
      return this.allDaos.data;
    }
    return refresh;
  }

  // Single-flight: concurrent callers share one scan instead of each
  // launching a full DAO+RPC sweep (cache stampede against the RPC).
  private refreshAllDaos(): Promise<DaoTickerData[]> {
    if (!this.allDaosInFlight) {
      this.allDaosInFlight = this.fetchAllDaos()
        .then(({ data, readAt }) => {
          // The snapshot is as old as its reserves, not as old as the end of
          // the refresh: a slow refresh must not make old prices look fresh.
          const ageMs = Date.now() - readAt;
          if (ageMs >= config.cache.tickersMaxStale) {
            throw new Error(`DAO snapshot took ${ageMs}ms to build, past the ${config.cache.tickersMaxStale}ms max-stale cap; discarding it`);
          }
          this.allDaos = { data, fetchedAt: readAt };
          metricsService.markDaoSnapshotRefreshed(data.length, readAt);
          return data;
        })
        .finally(() => {
          this.allDaosInFlight = null;
        });
    }
    return this.allDaosInFlight;
  }

  private async fetchAllDaos(): Promise<{ data: DaoTickerData[]; readAt: number }> {
    try {
      const readAt = Date.now();
      let daoAccounts: any[];
      try {
        daoAccounts = await this.retryWithBackoff(() => this.client.futarchy.account.dao.all());
      } catch (error: any) {
        logger.error(this.isRateLimitError(error) ? 'Rate limited while fetching all DAOs:' : 'Error fetching all DAOs:', error);
        throw error;
      }

      // Pool reserves come straight from the scanned DAO accounts — one
      // consistent read, no per-DAO refetch.
      const candidates: Array<{ daoAddress: PublicKey; dao: any; poolData: PoolData; vault?: PublicKey }> = [];
      for (const daoAccount of daoAccounts) {
        if (!daoAccount) continue;
        const daoAddress: PublicKey = daoAccount.publicKey;
        if (config.excludedDaos.some((excluded) => excluded.equals(daoAddress))) continue;

        const dao = daoAccount.account;
        const poolData = extractSpotPool(dao);
        if (!poolData) continue;

        let vault: PublicKey | undefined;
        if (dao.squadsMultisigVault) {
          try {
            vault = new PublicKey(dao.squadsMultisigVault);
          } catch {
            logger.warn(`Invalid squads vault for DAO ${daoAddress.toString()}`);
          }
        }
        candidates.push({ daoAddress, dao, poolData, vault });
      }

      const [treasuryBalances] = await Promise.all([
        this.getTreasuryUsdcBalances(candidates.flatMap((c) => (c.vault ? [c.vault] : []))),
        this.prefetchMints(candidates.flatMap((c) => [c.dao.baseMint, c.dao.quoteMint])),
      ]);

      const validDaoData: DaoTickerData[] = [];
      let perDaoErrors = 0;

      for (const { daoAddress, dao, poolData, vault } of candidates) {
        try {
          const baseMint: PublicKey = dao.baseMint;
          const quoteMint: PublicKey = dao.quoteMint;

          // Cache hits after prefetchMints; a mint the batch couldn't load is
          // fetched individually here and, on failure, fails only this DAO.
          const [baseDecimals, quoteDecimals, baseMetadata, quoteMetadata] = await Promise.all([
            this.getTokenDecimals(baseMint),
            this.getTokenDecimals(quoteMint),
            this.getTokenMetadata(baseMint),
            this.getTokenMetadata(quoteMint),
          ]);

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
            treasuryUsdcAum: vault ? treasuryBalances.get(vault.toBase58()) : undefined,
            treasuryVaultAddress: vault?.toBase58(),
          });
        } catch (error: any) {
          // Skip THIS dao so one flaky account doesn't take down the whole
          // feed — but count it, so we can refuse to serve an all-failed list.
          perDaoErrors++;
          logger.warn(`Skipping DAO ${daoAddress.toString()}: ${error?.message ?? error}`);
        }
      }

      if (this.rateLimitErrors > 0) {
        logger.warn(`Encountered ${this.rateLimitErrors} rate limit errors during processing`);
      }

      // Don't serve an empty (or all-failed) ticker set as if it were real: if we
      // had DAOs to process and produced ZERO results while errors occurred, that's
      // an infrastructure problem (RPC degraded), not a genuinely empty market.
      // Throw so /api/tickers returns an error the poller retries — never an empty
      // 200 that reads as "everything delisted / zero volume".
      if (validDaoData.length === 0 && candidates.length > 0 && perDaoErrors > 0) {
        throw new Error(
          `getAllDaos produced 0 tickers from ${candidates.length} DAOs with ${perDaoErrors} fetch errors — refusing to serve an empty set`,
        );
      }

      return { data: validDaoData, readAt };
    } catch (error) {
      logger.error('Error fetching all DAOs:', error);
      throw error;
    }
  }
}
