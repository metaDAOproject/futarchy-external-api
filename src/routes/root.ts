import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import type { ServiceGetters } from './types.js';

export function createRootRouter(_services: ServiceGetters): Router {
  const router = Router();

  // Root endpoint with API documentation
  router.get('/', (req: Request, res: Response) => {
    res.json({
      name: 'Futarchy AMM - CoinGecko API',
      version: '2.0.0',
      documentation: 'https://docs.coingecko.com/reference/exchanges-list',
      endpoints: {
        tickers: '/api/tickers - Returns all DAO tickers with pricing and volume',
        market_data: '/api/market-data - Daily market data from the served user_pool ETL',
        supply: '/api/supply/:mintAddress - Returns complete supply breakdown with allocation details',
        supply_total: '/api/supply/:mintAddress/total - Returns total supply only',
        supply_circulating: '/api/supply/:mintAddress/circulating - Returns circulating supply (excludes team performance package)',
        health: '/health',
        health_detailed: '/api/health - Comprehensive health with app DB and served ETL contract checks',
      },
      dexscreener: {
        description: 'DexScreener Adapter (v1.1) — requires DATABASE_PG_URL',
        latest_block: '/dexscreener/latest-block - Latest indexed Solana slot',
        asset: '/dexscreener/asset?id=:mintAddress - Token metadata',
        pair: '/dexscreener/pair?id=:daoAddress - Pair info',
        events: '/dexscreener/events?fromBlock=:slot&toBlock=:slot - Swap events by slot range',
      },
      coinmarketcap: {
        description: 'CoinMarketCap DEX Adapter [Section C] — requires DATABASE_PG_URL for summary/ticker',
        summary: '/cmc/summary - 24h overview of every tradeable pair',
        ticker: '/cmc/ticker - 24h price/volume keyed by BASE_QUOTE pair',
        assets: '/cmc/assets - Token identity keyed by mint address',
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
      note: 'Read-only API. Market data and ticker volume are served from the user_pool ETL in the served DB; no Dune, no in-process indexing.',
    });
  });

  return router;
}
