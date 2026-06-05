import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import type { ServiceGetters } from './types.js';

export function createRootRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getDuneCacheService } = services;

  // Root endpoint with API documentation
  router.get('/', (req: Request, res: Response) => {
    const duneCacheService = getDuneCacheService();
    const cacheStatus = duneCacheService?.getCacheStatus();
    
    res.json({
      name: 'Futarchy AMM - CoinGecko API',
      version: '1.0.0',
      documentation: 'https://docs.coingecko.com/reference/exchanges-list',
      endpoints: {
        tickers: '/api/tickers - Returns all DAO tickers with pricing and volume',
        market_data: '/api/market-data - Daily market data (futarchy AMM + Meteora); uses v0.6 indexer when USE_DUNE_DATA=false',
        supply: '/api/supply/:mintAddress - Returns complete supply breakdown with allocation details',
        supply_total: '/api/supply/:mintAddress/total - Returns total supply only',
        supply_circulating: '/api/supply/:mintAddress/circulating - Returns circulating supply (excludes team performance package)',
        health: '/health',
        health_detailed: '/api/health - Comprehensive health with DB and data freshness',
      },
      dexscreener: {
        description: 'DexScreener Adapter (v1.1) — requires EXTERNAL_DATABASE_URL',
        latest_block: '/dexscreener/latest-block - Latest indexed Solana slot',
        asset: '/dexscreener/asset?id=:mintAddress - Token metadata',
        pair: '/dexscreener/pair?id=:daoAddress - Pair info',
        events: '/dexscreener/events?fromBlock=:slot&toBlock=:slot - Swap events by slot range',
      },
      dex: {
        fork_type: config.dex.forkType,
        factory_address: config.dex.factoryAddress,
        router_address: config.dex.routerAddress,
      },
      supplyBreakdown: {
        description: 'For launchpad tokens, supply is broken down into:',
        circulatingSupply: 'Total supply minus team performance package (liquidity IS circulating)',
        teamPerformancePackage: 'Locked tokens allocated to the team (price-based unlock) - NOT circulating',
        futarchyAmmLiquidity: 'Tokens in the internal FutarchyAMM for spot trading - IS circulating',
        meteoraLpLiquidity: 'Tokens in the external Meteora DAMM pool (POL) - IS circulating',
      },
      caching: {
        description: 'Ticker volume is served from app DB aggregates populated by the separate indexer runtime',
        refreshInterval: `${parseInt(process.env.DUNE_CACHE_REFRESH_INTERVAL || '3600')} seconds`,
        fetchTimeout: `${parseInt(process.env.DUNE_FETCH_TIMEOUT || '240')} seconds`,
        status: cacheStatus ? {
          isInitialized: cacheStatus.isInitialized,
          poolMetricsCount: cacheStatus.poolMetricsCount,
          lastUpdated: cacheStatus.lastUpdated.toISOString(),
        } : 'No live cache in API runtime',
      },
      note: 'This API discovers DAOs for serving responses; background indexing runs separately.',
    });
  });

  return router;
}
