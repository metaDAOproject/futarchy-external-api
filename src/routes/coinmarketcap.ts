import { Router, type Request, type Response } from 'express';
import type {
  CoinMarketCapTicker,
  CoinMarketCapTickerResponse,
  CoinMarketCapSummaryPair,
  CoinMarketCapAsset,
  CoinMarketCapAssetsResponse,
} from '../types/coinmarketcap.js';
import type { DaoTickerData } from '../services/futarchyService.js';
import type { ServiceGetters } from './types.js';
import { AppError, asyncHandler } from '../middleware/errorHandler.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';

// Fees reported on /cmc/assets. Both maker and taker pay the same flat protocol
// fee on the FutarchyAMM — there is no maker/taker distinction on an AMM.
const PROTOCOL_FEE_RATE = config.fees.protocolFeeRate;

/**
 * Apply the optional CMC allowlist (config.coinmarketcap.allowedMints). An empty
 * allowlist means "serve every discovered DAO" — same default as the CoinGecko
 * and DexScreener adapters.
 *
 * Fails CLOSED when an allowlist is configured but matches ZERO discovered DAOs:
 * that is a misconfiguration (stale/wrong mint) or an upstream discovery outage,
 * and returning an empty 200 would read as "every listed market delisted" to a
 * poller. We surface it as 503 + alert instead so it retries and we get paged,
 * rather than silently serving an empty feed.
 */
function filterAllowed(daos: DaoTickerData[]): DaoTickerData[] {
  const allowed = config.coinmarketcap.allowedMints;
  if (allowed.size === 0) return daos;
  const filtered = daos.filter(dao => allowed.has(dao.baseMint.toString()));
  if (filtered.length === 0) {
    sendAlert(
      `CMC_ALLOWED_MINTS matched none of ${daos.length} discovered DAOs — refusing to serve an empty feed`,
      { cooldownKey: 'cmc-allowlist-no-match', cooldownMs: 10 * 60 * 1000 }
    );
    throw AppError.serviceUnavailable(
      'CMC allowlist matched no discovered markets',
      'CMC_ALLOWLIST_NO_MATCH'
    );
  }
  return filtered;
}

/**
 * A single tradeable pair, enriched with live price/spread (from spot reserves)
 * and rolling-24h volume/high/low (from the served ETL). Shared by /cmc/summary
 * and /cmc/ticker so both feeds are always internally consistent.
 */
interface CmcPair {
  tradingPair: string; // `${baseMint}_${quoteMint}`
  baseId: string;
  quoteId: string;
  lastPrice: number;
  bid: number;
  ask: number;
  baseVolume: number;
  quoteVolume: number;
  high24h?: number;
  low24h?: number;
}

export function createCoinMarketCapRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getFutarchyService, getPriceService, getExternalDatabaseService } = services;

  /**
   * Build the enriched pair list shared by /cmc/summary and /cmc/ticker.
   *
   * Mirrors the CoinGecko /api/tickers path: the served ETL DB is the source of
   * truth for 24h volume, so its absence is surfaced as 503 (never masked as
   * zero volume for a financial feed). Price/spread/liquidity come from live
   * spot-pool reserves via the same PriceService the CoinGecko adapter uses.
   */
  async function buildPairs(req: Request): Promise<CmcPair[]> {
    const futarchyService = getFutarchyService();
    const priceService = getPriceService();
    const externalDatabaseService = getExternalDatabaseService();

    if (!externalDatabaseService?.isAvailable()) {
      logger.warn('Served database unavailable for /cmc endpoint', { requestId: req.requestId });
      sendAlert(
        'Served database unavailable for /cmc — refusing to report zero volume',
        { cooldownKey: 'cmc-served-db-unavailable', cooldownMs: 10 * 60 * 1000 }
      );
      throw AppError.serviceUnavailable('Served database not available', 'SERVED_DB_UNAVAILABLE');
    }

    const allDaos = filterAllowed(await futarchyService.getAllDaos());

    // Rolling-24h spot metrics keyed by base mint (token) → mapped to dao (pool_id),
    // identical to the CoinGecko adapter's single source.
    const tokenToDaoMap = new Map<string, string>();
    for (const dao of allDaos) {
      tokenToDaoMap.set(dao.baseMint.toString(), dao.daoAddress.toString());
    }

    const baseMints = allDaos.map(dao => dao.baseMint.toString());
    const spotMetrics = await externalDatabaseService.getSpotRolling24hMetrics(baseMints);

    const volumeByDao = new Map<string, { base_volume_24h: string; target_volume_24h: string; high_24h: string; low_24h: string }>();
    for (const [token, metrics] of spotMetrics.entries()) {
      const daoAddress = tokenToDaoMap.get(token);
      if (!daoAddress) continue;
      volumeByDao.set(daoAddress, {
        base_volume_24h: metrics.base_volume_24h,
        target_volume_24h: metrics.target_volume_24h,
        high_24h: metrics.high_24h,
        low_24h: metrics.low_24h,
      });
    }

    const pairs: CmcPair[] = [];
    for (const dao of allDaos) {
      try {
        const { daoAddress, baseMint, quoteMint, baseDecimals, quoteDecimals, poolData } = dao;

        const lastPriceStr = priceService.calculatePrice(
          poolData.baseReserves,
          poolData.quoteReserves,
          baseDecimals,
          quoteDecimals
        );
        if (!lastPriceStr) continue;

        const priceNum = parseFloat(lastPriceStr);
        const spread = priceService.calculateSpread(priceNum);
        if (!spread) continue;

        // Volume semantics for a financial feed:
        //  - metrics ABSENT  → the pair simply had no spot trades in 24h; 0 is the
        //    genuine, correct volume (not an error).
        //  - metrics PRESENT but non-finite → served-DB contract drift produced a
        //    corrupt SUM for an INCLUDED pair. Do NOT silently drop it (that would
        //    turn schema drift into a partial 200); throw so the whole request
        //    fails as 5xx via asyncHandler and we get paged.
        const metrics = volumeByDao.get(daoAddress.toString());
        let baseVolume = 0;
        let quoteVolume = 0;
        if (metrics) {
          baseVolume = parseFloat(metrics.base_volume_24h);
          quoteVolume = parseFloat(metrics.target_volume_24h);
          if (!Number.isFinite(baseVolume) || !Number.isFinite(quoteVolume)) {
            throw AppError.internal(
              `Malformed 24h volume from the served ETL for ${baseMint.toString()}`,
              'CMC_MALFORMED_VOLUME'
            );
          }
        }

        const pair: CmcPair = {
          tradingPair: `${baseMint.toString()}_${quoteMint.toString()}`,
          baseId: baseMint.toString(),
          quoteId: quoteMint.toString(),
          lastPrice: priceNum,
          bid: parseFloat(spread.bid),
          ask: parseFloat(spread.ask),
          baseVolume,
          quoteVolume,
        };

        // Only attach a 24h high/low when the ETL reports a real (non-zero) one —
        // the metrics helper returns '0' as its "no data" sentinel.
        if (metrics && metrics.high_24h !== '0') {
          const high = parseFloat(metrics.high_24h);
          if (Number.isFinite(high)) pair.high24h = high;
        }
        if (metrics && metrics.low_24h !== '0') {
          const low = parseFloat(metrics.low_24h);
          if (Number.isFinite(low)) pair.low24h = low;
        }

        pairs.push(pair);
      } catch (error) {
        // Intentional financial-integrity failures (AppError, e.g. malformed ETL
        // volume above) MUST propagate — rethrow so the request fails 5xx rather
        // than being downgraded to a silently-dropped pair.
        if (error instanceof AppError) throw error;
        // Otherwise this is a per-pair skip ONLY (identical to the CoinGecko
        // adapter's per-ticker catch): drop a single pair whose price/spread can't
        // be computed so one bad pool doesn't sink the whole feed. This does NOT
        // mask an infrastructure/data outage as a 200 — those surface as 5xx
        // before we reach here: getAllDaos() throws (its "refusing to serve an
        // empty set" guard) if the RPC scan degrades, and getSpotRolling24hMetrics()
        // throws on any served-DB/query failure. Both propagate via asyncHandler.
        logger.error('Error building CMC pair', error, {
          daoAddress: dao.daoAddress.toString(),
          requestId: req.requestId,
        });
      }
    }

    return pairs;
  }

  // ---------------------------------------------------------------
  // GET /cmc/summary — 24h overview of every tradeable pair (array).
  // ---------------------------------------------------------------
  router.get('/cmc/summary', asyncHandler(async (req: Request, res: Response) => {
    const pairs = await buildPairs(req);

    const summary: CoinMarketCapSummaryPair[] = pairs.map(p => {
      const entry: CoinMarketCapSummaryPair = {
        trading_pairs: p.tradingPair,
        base_currency: p.baseId,
        quote_currency: p.quoteId,
        type: 'spot',
        last_price: p.lastPrice,
        lowest_ask: p.ask,
        highest_bid: p.bid,
        base_volume: p.baseVolume,
        quote_volume: p.quoteVolume,
      };
      if (p.high24h !== undefined) entry.highest_price_24h = p.high24h;
      if (p.low24h !== undefined) entry.lowest_price_24h = p.low24h;
      return entry;
    });

    res.json(summary);
  }));

  // ---------------------------------------------------------------
  // GET /cmc/ticker — 24h price/volume keyed by `BASE_QUOTE` pair.
  // ---------------------------------------------------------------
  router.get('/cmc/ticker', asyncHandler(async (req: Request, res: Response) => {
    const pairs = await buildPairs(req);

    const ticker: CoinMarketCapTickerResponse = {};
    for (const p of pairs) {
      const entry: CoinMarketCapTicker = {
        base_id: p.baseId,
        quote_id: p.quoteId,
        last_price: p.lastPrice,
        base_volume: p.baseVolume,
        quote_volume: p.quoteVolume,
        isFrozen: 0,
      };
      ticker[p.tradingPair] = entry;
    }

    res.json(ticker);
  }));

  // ---------------------------------------------------------------
  // GET /cmc/assets — token identity keyed by mint address.
  //
  // Pure on-chain metadata (symbol/name/decimals via getAllDaos) — no volume, so
  // it does NOT require the served DB. Exposes both the base and quote token of
  // every (allowlisted) pair.
  // ---------------------------------------------------------------
  router.get('/cmc/assets', asyncHandler(async (req: Request, res: Response) => {
    const futarchyService = getFutarchyService();
    const allDaos = filterAllowed(await futarchyService.getAllDaos());

    const assets: CoinMarketCapAssetsResponse = {};

    const addAsset = (mint: string, symbol: string | undefined, name: string | undefined): void => {
      // First writer wins: the base token's own metadata is authoritative, and a
      // shared quote (USDC) is identical across pairs, so skipping re-adds is safe.
      if (assets[mint]) return;
      const asset: CoinMarketCapAsset = {
        name: name || mint.slice(0, 8),
        symbol: symbol || mint.slice(0, 8),
        contractAddress: mint,
        can_withdraw: 'true',
        can_deposit: 'true',
        maker_fee: PROTOCOL_FEE_RATE,
        taker_fee: PROTOCOL_FEE_RATE,
      };
      assets[mint] = asset;
    };

    for (const dao of allDaos) {
      addAsset(dao.baseMint.toString(), dao.baseSymbol, dao.baseName);
      addAsset(dao.quoteMint.toString(), dao.quoteSymbol, dao.quoteName);
    }

    logger.debug('Built CMC assets', { count: Object.keys(assets).length, requestId: req.requestId });
    res.json(assets);
  }));

  return router;
}
