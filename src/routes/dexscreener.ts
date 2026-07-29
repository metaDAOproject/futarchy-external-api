import { Router, type Request, type Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { AppError, asyncHandler } from '../middleware/errorHandler.js';
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
const TOKEN_DECIMALS = 6; // All futarchy tokens + USDC use 6 decimals
const DECIMALIZE = Math.pow(10, TOKEN_DECIMALS);

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
    const extDb = getExternalDatabaseService();
    if (!extDb || !extDb.isAvailable()) {
      return res.status(503).json({ error: 'External database not available' });
    }

    const result = await extDb.query(`
      SELECT slot, extract(epoch FROM block_time)::bigint AS unix_timestamp
      FROM futarchy.user_pool_swaps
      WHERE source = 'futarchy_amm' AND market_kind = 'spot'
      ORDER BY slot DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No blocks available' });
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
    const id = req.query.id as string;
    if (!id) {
      return res.status(400).json({ error: 'Missing required parameter: id' });
    }

    const cached = assetCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.data);
    }

    const futarchyService = getFutarchyService();
    const solanaService = getSolanaService();
    const launchpadService = getLaunchpadService();

    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(id);
    } catch {
      return res.status(400).json({ error: 'Invalid asset id (not a valid Solana address)' });
    }

    const [metadata, decimals] = await Promise.all([
      futarchyService.getTokenMetadata(mintPubkey),
      futarchyService.getTokenDecimals(mintPubkey),
    ]);

    let totalSupply: number;
    let circulatingSupply: number;
    try {
      const { supplyInfo } = await getSupplyInfoWithLaunchpadAllocation(
        id,
        solanaService,
        launchpadService,
      );
      const total = parseFloat(supplyInfo.totalSupply);
      const circ = parseFloat(supplyInfo.circulatingSupply);
      if (!Number.isFinite(total) || !Number.isFinite(circ)) {
        throw new Error('Supply response was not finite');
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
    const id = req.query.id as string;
    if (!id) {
      return res.status(400).json({ error: 'Missing required parameter: id' });
    }

    const cached = pairCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.data);
    }

    const extDb = getExternalDatabaseService();
    if (!extDb || !extDb.isAvailable()) {
      return res.status(503).json({ error: 'External database not available' });
    }

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
      return res.status(404).json({ error: 'Pair not found' });
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
    const fromBlock = Number(req.query.fromBlock);
    const toBlock = Number(req.query.toBlock);

    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0) {
      return res.status(400).json({ error: 'fromBlock and toBlock must be non-negative integers' });
    }

    if (toBlock < fromBlock) {
      return res.status(400).json({ error: 'toBlock must be >= fromBlock' });
    }

    const MAX_BLOCK_WINDOW = 500_000;
    if (toBlock - fromBlock > MAX_BLOCK_WINDOW) {
      return res.status(400).json({ error: `Block range too large (max ${MAX_BLOCK_WINDOW} slots per request)` });
    }

    const extDb = getExternalDatabaseService();
    if (!extDb || !extDb.isAvailable()) {
      return res.status(503).json({ error: 'External database not available' });
    }

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
      const inputAmount = Number(row.input_amount) / DECIMALIZE;
      const outputAmount = Number(row.output_amount) / DECIMALIZE;

      // Post-swap reserves from the DB (may be null for older rows)
      const hasReserves = row.amm_base_amount != null && row.amm_quote_amount != null;
      const reserves = hasReserves
        ? { asset0: Number(row.amm_base_amount) / DECIMALIZE, asset1: Number(row.amm_quote_amount) / DECIMALIZE }
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
