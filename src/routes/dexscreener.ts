import { Router, type Request, type Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { asyncHandler } from '../middleware/errorHandler.js';
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

  // In-memory TTL caches for mostly-static endpoints
  const assetCache = new Map<string, { data: DexScreenerAssetResponse; expiresAt: number }>();
  const pairCache = new Map<string, { data: DexScreenerPairResponse; expiresAt: number }>();
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // ---------------------------------------------------------------
  // GET /dexscreener/latest-block
  // ---------------------------------------------------------------
  router.get('/dexscreener/latest-block', asyncHandler(async (_req: Request, res: Response) => {
    const extDb = getExternalDatabaseService();
    if (!extDb || !extDb.isAvailable()) {
      return res.status(503).json({ error: 'External database not available' });
    }

    const result = await extDb.query(`
      SELECT slot, unix_timestamp
      FROM v0_6_spot_swaps
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

    let totalSupply: number | undefined;
    let circulatingSupply: number | undefined;
    try {
      const { supplyInfo } = await getSupplyInfoWithLaunchpadAllocation(
        id,
        solanaService,
        launchpadService,
      );
      const total = parseFloat(supplyInfo.totalSupply);
      const circ = parseFloat(supplyInfo.circulatingSupply);
      if (Number.isFinite(total) && Number.isFinite(circ)) {
        totalSupply = total;
        circulatingSupply = circ;
      }
    } catch (err) {
      logger.warn('[DexScreener] /asset could not load supply', {
        mint: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const response: DexScreenerAssetResponse = {
      asset: {
        id,
        name: metadata?.name || id.slice(0, 8),
        symbol: metadata?.symbol || id.slice(0, 8),
        ...(totalSupply !== undefined && circulatingSupply !== undefined
          ? { totalSupply, circulatingSupply }
          : {}),
        metadata: {
          decimals: String(decimals),
        },
      },
    };

    assetCache.set(id, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });
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

    // Look up the pair (DAO) in the external DB
    const daoResult = await extDb.query(
      `SELECT dao_addr, base_mint_acct, quote_mint_acct
       FROM v0_6_daos
       WHERE dao_addr = $1`,
      [id],
    );

    if (daoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pair not found' });
    }

    const dao = daoResult.rows[0];

    // Get creation info (first swap for this pair)
    const creationResult = await extDb.query(
      `SELECT slot, unix_timestamp, signature
       FROM v0_6_spot_swaps
       WHERE dao_addr = $1
       ORDER BY slot ASC, id ASC
       LIMIT 1`,
      [id],
    );

    const response: DexScreenerPairResponse = {
      pair: {
        id: dao.dao_addr,
        dexKey: DEX_KEY,
        asset0Id: dao.base_mint_acct,
        asset1Id: dao.quote_mint_acct,
        feeBps: FEE_BPS,
      },
    };

    if (creationResult.rows.length > 0) {
      const creation = creationResult.rows[0];
      response.pair.createdAtBlockNumber = Number(creation.slot);
      response.pair.createdAtBlockTimestamp = Number(creation.unix_timestamp);
      response.pair.createdAtTxnId = creation.signature;
    }

    pairCache.set(id, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });
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

    // Query swap events in the slot range (both inclusive)
    // amm_base_amount / amm_quote_amount = post-swap pool reserves (nullable for older rows)
    const result = await extDb.query(
      `SELECT
         s.id,
         s.signature,
         s.slot,
         s.unix_timestamp,
         s.dao_addr,
         s.user_addr,
         s.swap_type,
         s.input_amount,
         s.output_amount,
         s.amm_base_amount,
         s.amm_quote_amount
       FROM v0_6_spot_swaps s
       WHERE s.slot >= $1 AND s.slot <= $2
         AND s.input_amount > 0 AND s.output_amount > 0
         AND LOWER(TRIM(s.swap_type)) IN ('buy', 'sell')
       ORDER BY s.slot ASC, s.id ASC`,
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
