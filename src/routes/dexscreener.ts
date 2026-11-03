import { Router, type Request, type Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { AppError, asyncHandler } from '../middleware/errorHandler.js';
import { parseSolanaAddress, orBadRequest } from '../utils/validation.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { ServiceGetters } from './types.js';
import type {
  DexScreenerLatestBlockResponse,
  DexScreenerAssetResponse,
  DexScreenerPairResponse,
  DexScreenerEventsResponse,
  DexScreenerSwapEvent,
} from '../types/dexscreener.js';
import { getSupplyInfoWithLaunchpadAllocation } from '../services/supplyWithLaunchpadAllocation.js';

const DEX_KEY = 'futarchyAMM';
const FEE_BPS = Math.round(config.fees.protocolFeeRate * 10000); // 0.005 → 50

export function createDexScreenerRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getFutarchyService, getExternalDatabaseService, getSolanaService, getLaunchpadService } =
    services;

  // In-memory TTL caches for mostly-static endpoints. Bounded: the keys are
  // caller-supplied ids, so without a cap a scanner cycling through arbitrary
  // valid pubkeys would grow these maps (and burn RPC per miss) without limit.
  const assetCache = new Map<string, { data: DexScreenerAssetResponse; expiresAt: number }>();
  const pairCache = new Map<string, { data: DexScreenerPairResponse; expiresAt: number }>();
  const ASSET_CACHE_TTL_MS = config.cache.tickersTTL;
  const PAIR_CACHE_TTL_MS = 5 * 60 * 1000;
  const CACHE_MAX_ENTRIES = 1000;

  function requireServedDb() {
    const extDb = getExternalDatabaseService();
    if (!extDb?.isAvailable()) {
      throw AppError.serviceUnavailable('Served database not available', 'SERVED_DB_UNAVAILABLE');
    }
    return extDb;
  }

  function cachePut<T>(cache: Map<string, T>, key: string, value: T): void {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      // Evict oldest insertion (Map preserves insertion order)
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }

  // ---------------------------------------------------------------
  // GET /dexscreener/latest-block
  // ---------------------------------------------------------------
  router.get('/dexscreener/latest-block', asyncHandler(async (_req: Request, res: Response) => {
    const extDb = requireServedDb();

    const result = await extDb.query(`
      SELECT slot, extract(epoch FROM block_time)::bigint AS unix_timestamp
      FROM futarchy.user_pool_swaps
      WHERE source = 'futarchy_amm' AND market_kind = 'spot'
      ORDER BY slot DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      throw AppError.notFound('No blocks available', 'NOT_FOUND');
    }

    const row = result.rows[0];
    const response: DexScreenerLatestBlockResponse = {
      block: {
        blockNumber: Number(row.slot),
        blockTimestamp: Number(row.unix_timestamp),
      },
    };

    res.json(response);
  }));

  // ---------------------------------------------------------------
  // GET /dexscreener/asset?id=:string
  // ---------------------------------------------------------------
  router.get('/dexscreener/asset', asyncHandler(async (req: Request, res: Response) => {
    const id = orBadRequest(parseSolanaAddress(req.query.id as string, 'id'));

    const cached = assetCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.data);
    }

    const futarchyService = getFutarchyService();
    const solanaService = getSolanaService();
    const launchpadService = getLaunchpadService();

    const mintPubkey = new PublicKey(id);

    let totalSupply: number;
    let circulatingSupply: number;
    try {
      const { supplyInfo } = await getSupplyInfoWithLaunchpadAllocation(
        id,
        solanaService,
        launchpadService,
      );
      const total = Number(supplyInfo.totalSupply);
      const circ = Number(supplyInfo.circulatingSupply);
      if (!Number.isFinite(total) || !Number.isFinite(circ)) {
        throw new Error('Supply response was not a finite number');
      }
      totalSupply = total;
      circulatingSupply = circ;
    } catch (err) {
      logger.warn('[DexScreener] /asset could not load supply', {
        mint: id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw AppError.serviceUnavailable(
        'Supply data temporarily unavailable',
        'SUPPLY_UNAVAILABLE',
      );
    }

    const [metadata, decimals] = await Promise.all([
      futarchyService.getTokenMetadata(mintPubkey),
      futarchyService.getTokenDecimals(mintPubkey),
    ]);

    const response: DexScreenerAssetResponse = {
      asset: {
        id,
        name: metadata?.name || id.slice(0, 8),
        symbol: metadata?.symbol || id.slice(0, 8),
        totalSupply,
        circulatingSupply,
        metadata: {
          decimals: String(decimals),
        },
      },
    };

    cachePut(assetCache, id, {
      data: response,
      expiresAt: Date.now() + ASSET_CACHE_TTL_MS,
    });
    res.json(response);
  }));

  // ---------------------------------------------------------------
  // GET /dexscreener/pair?id=:string
  // ---------------------------------------------------------------
  router.get('/dexscreener/pair', asyncHandler(async (req: Request, res: Response) => {
    const id = orBadRequest(parseSolanaAddress(req.query.id as string, 'id'));

    const cached = pairCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.data);
    }

    const extDb = requireServedDb();

    // Pair identity + creation (first spot swap) from the unified ETL output. One
    // query: the earliest futarchy spot swap for the DAO carries its base/quote
    // mints AND the creation block/txn. A DAO with no spot swaps has no tradeable
    // pair → 404 (same status the old v0_6_daos miss returned).
    const pairResult = await extDb.query(
      `SELECT dao_addr, base_mint, quote_mint,
              slot, extract(epoch FROM block_time)::bigint AS unix_timestamp, signature
       FROM futarchy.user_pool_swaps
       WHERE source = 'futarchy_amm' AND market_kind = 'spot' AND dao_addr = $1
       -- signature in the tie-break: separate txns in one slot can share (inner_group,
       -- inner_ix) (those are within-txn coords), so order it too for a deterministic
       -- "first swap" → stable createdAtTxnId.
       ORDER BY slot ASC, signature ASC, inner_group ASC, inner_ix ASC
       LIMIT 1`,
      [id],
    );

    if (pairResult.rows.length === 0) {
      throw AppError.notFound('Pair not found', 'NOT_FOUND');
    }

    const dao = pairResult.rows[0];

    const response: DexScreenerPairResponse = {
      pair: {
        id: dao.dao_addr,
        dexKey: DEX_KEY,
        asset0Id: dao.base_mint,
        asset1Id: dao.quote_mint,
        feeBps: FEE_BPS,
        createdAtBlockNumber: Number(dao.slot),
        createdAtBlockTimestamp: Number(dao.unix_timestamp),
        createdAtTxnId: dao.signature,
      },
    };

    cachePut(pairCache, id, {
      data: response,
      expiresAt: Date.now() + PAIR_CACHE_TTL_MS,
    });
    res.json(response);
  }));

  // ---------------------------------------------------------------
  // GET /dexscreener/events?fromBlock=:number&toBlock=:number
  // ---------------------------------------------------------------
  router.get('/dexscreener/events', asyncHandler(async (req: Request, res: Response) => {
    // Digits only: Number() also reads '' and ' ' as 0, '0x10' as 16 and
    // '1e3' as 1000, none of which is a slot the caller meant.
    const isSlot = (value: unknown) => typeof value === 'string' && /^\d+$/.test(value);
    const fromBlock = Number(req.query.fromBlock);
    const toBlock = Number(req.query.toBlock);

    if (!isSlot(req.query.fromBlock) || !Number.isSafeInteger(fromBlock)) {
      throw AppError.badRequest('fromBlock must be a non-negative integer', 'INVALID_QUERY_PARAMETER', 'fromBlock');
    }
    if (!isSlot(req.query.toBlock) || !Number.isSafeInteger(toBlock)) {
      throw AppError.badRequest('toBlock must be a non-negative integer', 'INVALID_QUERY_PARAMETER', 'toBlock');
    }

    if (toBlock < fromBlock) {
      throw AppError.badRequest('toBlock must be >= fromBlock', 'INVALID_QUERY_PARAMETER', 'toBlock');
    }

    const MAX_BLOCK_WINDOW = 500_000;
    if (toBlock - fromBlock > MAX_BLOCK_WINDOW) {
      throw AppError.badRequest(`Block range too large (max ${MAX_BLOCK_WINDOW} slots per request)`, 'INVALID_QUERY_PARAMETER', 'toBlock');
    }

    const extDb = requireServedDb();

    // Query swap events in the slot range (both inclusive) from the unified ETL
    // output. Columns are aliased to the legacy v0_6 shape so the builder below is
    // unchanged: side→swap_type, and input/output reconstructed from base/quote +
    // side (Buy: USDC in / token out; Sell: token in / USDC out). amm_base/quote
    // reserves are our decoded post-swap reserves — non-NULL for EVERY spot swap
    // (validated dollar-exact vs the live feed), unlike the nullable raw column.
    // Ordered by (slot, signature, inner_group, inner_ix): signature MUST be in the
    // key because inner_group/inner_ix are within-transaction coordinates — two
    // distinct txns in one slot can share the same (inner_group, inner_ix), so
    // ordering without signature both is non-deterministic AND interleaves one txn's
    // events with another's, which makes the txnIndex builder below assign the same
    // signature two different txnIndex values. Grouping by signature keeps each txn's
    // events contiguous → stable, consistent txnIndex/eventIndex.
    const result = await extDb.query(
      `SELECT
         u.id,
         u.signature,
         u.slot,
         extract(epoch FROM u.block_time)::bigint                       AS unix_timestamp,
         u.dao_addr,
         u.user_addr,
         u.base_mint,
         u.quote_mint,
         u.side                                                         AS swap_type,
         CASE WHEN u.side = 'buy' THEN u.quote_amount ELSE u.base_amount  END AS input_amount,
         CASE WHEN u.side = 'buy' THEN u.base_amount  ELSE u.quote_amount END AS output_amount,
         u.amm_base_reserves                                            AS amm_base_amount,
         u.amm_quote_reserves                                           AS amm_quote_amount
       FROM futarchy.user_pool_swaps u
       WHERE u.source = 'futarchy_amm' AND u.market_kind = 'spot'
         AND u.slot >= $1 AND u.slot <= $2
         AND u.base_amount > 0 AND u.quote_amount > 0
       ORDER BY u.slot ASC, u.signature ASC, u.inner_group ASC, u.inner_ix ASC`,
      [fromBlock, toBlock],
    );

    // Build per-slot txnIndex using signature grouping, eventIndex for multiple events per txn
    const events: DexScreenerSwapEvent[] = [];
    let currentSlot = -1;
    let currentSig = '';
    let txnIndex = -1;
    let eventIndex = 0;

    // Resolve distinct mints in bounded batches to avoid both serial cold-cache
    // latency and an unbounded RPC burst. Reuse the service's on-chain cache;
    // failed lookups fail the request rather than defaulting to six decimals.
    const divisors = new Map<string, number>();
    const mints = [...new Set<string>(result.rows.flatMap(row => [row.base_mint, row.quote_mint]))];
    const MINT_LOOKUP_BATCH_SIZE = 8;
    for (let i = 0; i < mints.length; i += MINT_LOOKUP_BATCH_SIZE) {
      await Promise.all(mints.slice(i, i + MINT_LOOKUP_BATCH_SIZE).map(async mint => {
        const decimals = await getFutarchyService().getTokenDecimals(new PublicKey(mint));
        divisors.set(mint, 10 ** decimals);
      }));
    }

    for (const row of result.rows) {
      const slot = Number(row.slot);
      const sig = row.signature;

      if (slot !== currentSlot) {
        currentSlot = slot;
        currentSig = '';
        txnIndex = -1;
      }

      if (sig !== currentSig) {
        currentSig = sig;
        txnIndex++;
        eventIndex = 0;
      } else {
        eventIndex++;
      }

      const swapType = row.swap_type.trim().toLowerCase();
      const baseDivisor = divisors.get(row.base_mint)!;
      const quoteDivisor = divisors.get(row.quote_mint)!;
      const inputAmount = Number(row.input_amount) / (swapType === 'buy' ? quoteDivisor : baseDivisor);
      const outputAmount = Number(row.output_amount) / (swapType === 'buy' ? baseDivisor : quoteDivisor);

      // Post-swap reserves from the DB (may be null for older rows)
      const hasReserves = row.amm_base_amount != null && row.amm_quote_amount != null;
      const reserves = hasReserves
        ? { asset0: Number(row.amm_base_amount) / baseDivisor, asset1: Number(row.amm_quote_amount) / quoteDivisor }
        : undefined;

      let priceNative: number;
      let event: DexScreenerSwapEvent;

      if (swapType === 'buy') {
        // Buy: user sends USDC (asset1), receives token (asset0)
        priceNative = inputAmount / outputAmount; // USDC per token
        event = {
          block: {
            blockNumber: slot,
            blockTimestamp: Number(row.unix_timestamp),
          },
          eventType: 'swap',
          txnId: row.signature,
          txnIndex,
          eventIndex,
          maker: row.user_addr,
          pairId: row.dao_addr,
          asset1In: inputAmount,
          asset0Out: outputAmount,
          priceNative,
          reserves,
        };
      } else {
        // Sell: user sends token (asset0), receives USDC (asset1)
        priceNative = outputAmount / inputAmount; // USDC per token
        event = {
          block: {
            blockNumber: slot,
            blockTimestamp: Number(row.unix_timestamp),
          },
          eventType: 'swap',
          txnId: row.signature,
          txnIndex,
          eventIndex,
          maker: row.user_addr,
          pairId: row.dao_addr,
          asset0In: inputAmount,
          asset1Out: outputAmount,
          priceNative,
          reserves,
        };
      }

      events.push(event);
    }

    logger.debug(`[DexScreener] /events fromBlock=${fromBlock} toBlock=${toBlock} returned ${events.length} events`);

    const response: DexScreenerEventsResponse = { events };
    res.json(response);
  }));

  return router;
}
