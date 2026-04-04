import { Router, type Request, type Response } from 'express';
import type { CoinGeckoTicker } from '../types/coingecko.js';
import type { ServiceGetters } from './types.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';

export function createCoinGeckoRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getFutarchyService, getPriceService, getDuneCacheService, getTenMinuteVolumeFetcherService, getHourlyAggregationService, getDatabaseService } = services;

  // CoinGecko Endpoint: /tickers
  router.get('/api/tickers', asyncHandler(async (req: Request, res: Response) => {
      const futarchyService = getFutarchyService();
      const priceService = getPriceService();
      const duneCacheService = getDuneCacheService();
      const tenMinuteVolumeFetcherService = getTenMinuteVolumeFetcherService();
      const hourlyAggregationService = getHourlyAggregationService();
      const databaseService = getDatabaseService();
      
      const allDaos = await futarchyService.getAllDaos();
      
      const firstTradeDates = databaseService?.isAvailable() 
        ? await databaseService.getFirstTradeDates() 
        : new Map<string, string>();
      
      const tokenToDaoMap = new Map<string, string>();
      for (const dao of allDaos) {
        tokenToDaoMap.set(dao.baseMint.toString().toLowerCase(), dao.daoAddress.toString().toLowerCase());
      }
      
      let duneMetricsMap = new Map<string, { base_volume_24h: string; target_volume_24h: string; high_24h: string; low_24h: string }>();
      let volumeSource = 'none';
      
      // Try TenMinuteVolumeFetcherService first
      if (tenMinuteVolumeFetcherService?.isInitialized && tenMinuteVolumeFetcherService.isDatabaseConnected()) {
        const baseMints = allDaos.map(dao => dao.baseMint.toString());
        const tenMinMetrics = await tenMinuteVolumeFetcherService.getRolling24hMetrics(baseMints);
        
        if (tenMinMetrics.size > 0) {
          for (const [tokenAddress, metrics] of tenMinMetrics.entries()) {
            const daoAddress = tokenToDaoMap.get(tokenAddress.toLowerCase());
            if (daoAddress) {
              duneMetricsMap.set(daoAddress, {
                base_volume_24h: String(metrics.base_volume_24h),
                target_volume_24h: String(metrics.target_volume_24h),
                high_24h: String(metrics.high_24h),
                low_24h: String(metrics.low_24h),
              });
            }
          }
          volumeSource = '10-minute';
          logger.debug('Using 10-minute rolling 24h metrics', { daoCount: duneMetricsMap.size, requestId: req.requestId });
        }
      }
      
      // Fall back to HourlyAggregationService
      if (duneMetricsMap.size === 0 && hourlyAggregationService?.isInitialized && hourlyAggregationService.isDatabaseConnected()) {
        const baseMints = allDaos.map(dao => dao.baseMint.toString());
        const hourlyMetrics = await hourlyAggregationService.getRolling24hMetrics(baseMints);
        
        if (hourlyMetrics.size > 0) {
          for (const [tokenAddress, metrics] of hourlyMetrics.entries()) {
            const daoAddress = tokenToDaoMap.get(tokenAddress.toLowerCase());
            if (daoAddress) {
              duneMetricsMap.set(daoAddress, {
                base_volume_24h: metrics.base_volume_24h,
                target_volume_24h: metrics.target_volume_24h,
                high_24h: metrics.high_24h,
                low_24h: metrics.low_24h,
              });
            }
          }
          volumeSource = 'hourly';
          logger.debug('Using hourly rolling 24h metrics', { daoCount: duneMetricsMap.size, requestId: req.requestId });
        }
      }
      
      // Fall back to DuneCacheService
      if (duneMetricsMap.size === 0 && duneCacheService) {
        const cachedMetrics = duneCacheService.getPoolMetrics();
        if (cachedMetrics && cachedMetrics.size > 0) {
          const cacheStatus = duneCacheService.getCacheStatus();
          logger.debug('Using Dune cache metrics', { cacheAgeSeconds: Math.round(cacheStatus.cacheAgeMs / 1000), entryCount: cachedMetrics.size, requestId: req.requestId });
          duneMetricsMap = cachedMetrics;
          volumeSource = 'dune-cache';
        } else {
          logger.warn('No cached metrics available yet', { requestId: req.requestId });
        }
      }
      
      if (duneMetricsMap.size === 0) {
        logger.warn('No volume metrics available', { requestId: req.requestId });
        sendAlert(
          'No volume metrics available — all sources (10-min DB, hourly DB, Dune cache) returned empty',
          { cooldownKey: 'no-volume-data', cooldownMs: 10 * 60 * 1000 }
        );
      } else {
        logger.debug('Volume source selected', { volumeSource, daoCount: duneMetricsMap.size, requestId: req.requestId });
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

          const duneMetrics = duneMetricsMap.get(poolId.toLowerCase());
          let baseVolume: string;
          let targetVolume: string;
          let high24h: string | undefined;
          let low24h: string | undefined;

          if (duneMetrics) {
            baseVolume = duneMetrics.base_volume_24h;
            targetVolume = duneMetrics.target_volume_24h;
            high24h = duneMetrics.high_24h !== '0' ? duneMetrics.high_24h : undefined;
            low24h = duneMetrics.low_24h !== '0' ? duneMetrics.low_24h : undefined;
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

          const startDate = firstTradeDates.get(baseMint.toString().toLowerCase());
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
