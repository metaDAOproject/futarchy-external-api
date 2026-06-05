import { Router, type Request, type Response } from 'express';
import type { CoinGeckoTicker } from '../types/coingecko.js';
import type { ServiceGetters } from './types.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';

export function createCoinGeckoRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getFutarchyService, getPriceService, getDatabaseService, getExternalDatabaseService } = services;

  // CoinGecko Endpoint: /tickers
  router.get('/api/tickers', asyncHandler(async (req: Request, res: Response) => {
      const futarchyService = getFutarchyService();
      const priceService = getPriceService();
      const databaseService = getDatabaseService();
      const externalDatabaseService = getExternalDatabaseService();

      const allDaos = await futarchyService.getAllDaos();

      const firstTradeDates = externalDatabaseService?.isAvailable()
        ? await externalDatabaseService.getFirstTradeDates()
        : new Map<string, string>();

      const tokenToDaoMap = new Map<string, string>();
      for (const dao of allDaos) {
        tokenToDaoMap.set(dao.baseMint.toString(), dao.daoAddress.toString());
      }

      const volumeMetricsMap = new Map<string, { base_volume_24h: string; target_volume_24h: string; high_24h: string; low_24h: string }>();
      let volumeSource = 'none';

      // Primary: read rolling-24h spot metrics straight from the indexer DB
      // (futarchy.trades, keyed by dao_addr). No Dune, no app-DB rollup.
      if (externalDatabaseService?.isAvailable()) {
        const daoAddresses = allDaos.map(dao => dao.daoAddress.toString());
        const spotMetrics = await externalDatabaseService.getSpotRolling24hMetrics(daoAddresses);

        for (const [daoAddress, metrics] of spotMetrics.entries()) {
          volumeMetricsMap.set(daoAddress, {
            base_volume_24h: metrics.base_volume_24h,
            target_volume_24h: metrics.target_volume_24h,
            high_24h: metrics.high_24h,
            low_24h: metrics.low_24h,
          });
        }

        if (volumeMetricsMap.size > 0) {
          volumeSource = 'futarchy-trades-db';
          logger.debug('Using indexer futarchy.trades rolling 24h metrics', { daoCount: volumeMetricsMap.size, requestId: req.requestId });
        }
      }

      // Fallback: v0.6 indexer OHLCV (app DB) for ONLY the DAOs the primary
      // (futarchy.trades) didn't cover — per-DAO merge, not all-or-nothing. This
      // covers the window before futarchy.trades is populated for a given DAO
      // without zeroing out the DAOs that the primary did return.
      const missingDaos = allDaos.filter(dao => !volumeMetricsMap.has(dao.daoAddress.toString()));
      if (missingDaos.length > 0 && databaseService?.isAvailable()) {
        const missingBaseMints = missingDaos.map(dao => dao.baseMint.toString());
        const v06Metrics = await databaseService.getV06Rolling24hMetrics(missingBaseMints);

        let filled = 0;
        for (const [tokenAddress, metrics] of v06Metrics.entries()) {
          const daoAddress = tokenToDaoMap.get(tokenAddress);
          if (daoAddress && !volumeMetricsMap.has(daoAddress)) {
            volumeMetricsMap.set(daoAddress, {
              base_volume_24h: metrics.base_volume_24h,
              target_volume_24h: metrics.target_volume_24h,
              high_24h: metrics.high_24h,
              low_24h: metrics.low_24h,
            });
            filled++;
          }
        }

        if (filled > 0) {
          volumeSource = volumeSource === 'futarchy-trades-db' ? 'futarchy-trades-db+v06-fallback' : 'v06-indexer-fallback';
          logger.debug('Filled missing DAOs from v0.6 indexer rolling 24h metrics', { filled, requestId: req.requestId });
        }
      }

      if (volumeMetricsMap.size === 0) {
        logger.warn('No volume metrics available', { requestId: req.requestId });
        sendAlert(
          'No volume metrics available — all sources returned empty',
          { cooldownKey: 'no-volume-data', cooldownMs: 10 * 60 * 1000 }
        );
      } else {
        logger.debug('Volume source selected', { volumeSource, daoCount: volumeMetricsMap.size, requestId: req.requestId });
      }
      
      const tickers: CoinGeckoTicker[] = [];
      
      for (const daoData of allDaos) {
        try {
          const { 
            daoAddress, 
            baseMint, 
            quoteMint, 
            baseDecimals, 
            quoteDecimals, 
            baseSymbol,
            baseName,
            quoteSymbol,
            quoteName,
            poolData 
          } = daoData;
          const tickerId = `${baseMint.toString()}_${quoteMint.toString()}`;
          const poolId = daoAddress.toString();
          
          const lastPrice = priceService.calculatePrice(
            poolData.baseReserves,
            poolData.quoteReserves,
            baseDecimals,
            quoteDecimals
          );
          
          if (!lastPrice) continue;
          
          const priceNum = parseFloat(lastPrice);
          const spread = priceService.calculateSpread(priceNum);
          
          if (!spread) continue;
          
          const liquidityUsd = priceService.calculateLiquidityUSD(
            poolData.quoteReserves,
            quoteDecimals
          );
          
          if (!liquidityUsd) continue;

          const volumeMetrics = volumeMetricsMap.get(poolId);
          let baseVolume: string;
          let targetVolume: string;
          let high24h: string | undefined;
          let low24h: string | undefined;

          if (volumeMetrics) {
            baseVolume = volumeMetrics.base_volume_24h;
            targetVolume = volumeMetrics.target_volume_24h;
            high24h = volumeMetrics.high_24h !== '0' ? volumeMetrics.high_24h : undefined;
            low24h = volumeMetrics.low_24h !== '0' ? volumeMetrics.low_24h : undefined;
          } else {
            baseVolume = '0';
            targetVolume = '0';
          }

          if (isNaN(parseFloat(baseVolume)) || isNaN(parseFloat(targetVolume))) {
            continue;
          }

          const ticker: CoinGeckoTicker = {
            ticker_id: tickerId,
            base_currency: baseMint.toString(),
            target_currency: quoteMint.toString(),
            base_symbol: baseSymbol,
            base_name: baseName,
            target_symbol: quoteSymbol,
            target_name: quoteName,
            pool_id: poolId,
            last_price: lastPrice,
            base_volume: baseVolume,
            target_volume: targetVolume,
            liquidity_in_usd: liquidityUsd,
            bid: spread.bid,
            ask: spread.ask,
          };

          if (high24h) ticker.high_24h = high24h;
          if (low24h) ticker.low_24h = low24h;
          if (daoData.treasuryUsdcAum) ticker.treasury_usdc_aum = daoData.treasuryUsdcAum;
          if (daoData.treasuryVaultAddress) ticker.treasury_vault_address = daoData.treasuryVaultAddress;

          const startDate = firstTradeDates.get(baseMint.toString());
          if (startDate) ticker.startDate = startDate;

          tickers.push(ticker);
        } catch (error) {
          logger.error('Error generating ticker', error, { daoAddress: daoData.daoAddress.toString(), requestId: req.requestId });
        }
      }

      res.json(tickers);
  }));

  return router;
}
