import { PublicKey } from '@solana/web3.js';
export const config = {
  // Development mode - disables external Dune API calls
  devMode: process.env.DEV_MODE === 'true',
  solana: {
    rpcUrl: process.env.RPCPOOL_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    wsUrl: process.env.RPCPOOL_WS_URL || process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
  },
  server: {
    port: parseInt(process.env.PORT || '3000'),
    // Request timeout in milliseconds (default: 5 minutes)
    requestTimeout: parseInt(process.env.SERVER_REQUEST_TIMEOUT || '300000'),
    // Keep-alive timeout in milliseconds (default: 5 minutes)
    keepAliveTimeout: parseInt(process.env.SERVER_KEEP_ALIVE_TIMEOUT || '300000'),
    rateLimit: {
      windowMs: 60000, // 1 minute
      maxRequests: 60, // 60 requests per minute
    },
    trustedApiKeys: new Set<string>(
      (process.env.TRUSTED_API_KEYS || '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean)
    ),
    trustedRateLimit: {
      windowMs: 60_000,
      maxRequests: parseInt(process.env.TRUSTED_RATE_LIMIT_MAX || '600'),
    },
  },
  cache: {
    // TTL for blockchain data cache in milliseconds (default: 10 seconds)
    // Lower = more real-time prices but more RPC calls
    // Higher = less RPC load but slightly stale prices
    tickersTTL: parseInt(process.env.CACHE_TICKERS_TTL || '10000'),
  },
  dex: {
    forkType: process.env.DEX_FORK_TYPE || 'Custom',
    factoryAddress: process.env.FACTORY_ADDRESS || '',
    routerAddress: process.env.ROUTER_ADDRESS || '',
  },
  excludedDaos: (process.env.EXCLUDED_DAOS || '')
    .split(',')
    .map(addr => addr.trim())
    .filter(addr => addr.length > 0)
    .map(addr => new PublicKey(addr)),
  fees: {
    // Protocol fee rate (0.005 = 0.5%)
    protocolFeeRate: parseFloat(process.env.PROTOCOL_FEE_RATE || '0.005'),
  },
  // When true (default), use Dune-sourced volume data (10-min/hourly/cache) for FutarchyAMM 24h metrics.
  // Set USE_DUNE_DATA=false to use v0.6 indexer data (v06_spot_ohlcv_1m) instead.
  useDuneData: process.env.USE_DUNE_DATA !== 'false',
  dune: {
    apiKey: process.env.DUNE_API_KEY || '',
    // ACTIVE: 10-minute query - single source of truth, all other data aggregated from this
    tenMinuteVolumeQueryId: process.env.DUNE_TEN_MINUTE_VOLUME_QUERY_ID ? parseInt(process.env.DUNE_TEN_MINUTE_VOLUME_QUERY_ID) : undefined,
  },
  alerts: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || 'https://telegram-webhook-relay.themetadao-org.workers.dev',
    webhookSecret: process.env.ALERT_WEBHOOK_SECRET || '',
  },
  database: {
    // PostgreSQL connection - can use either connection string or individual params
    connectionString: process.env.COINGECKO_PG_URL || process.env.DATABASE_URL || '',
    host: process.env.DATABASE_HOST || '',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    database: process.env.DATABASE_NAME || 'futarchy_volumes',
    user: process.env.DATABASE_USER || '',
    password: process.env.DATABASE_PASSWORD || '',
    ssl: process.env.DATABASE_SSL === 'true',
  },
  externalDatabase: {
    // Read-only connection to the external indexer DB (v0_6_* tables)
    connectionString: process.env.FRONTEND_READER_PG_URL || process.env.EXTERNAL_DATABASE_URL || '',
    ssl: process.env.EXTERNAL_DATABASE_SSL === 'true',
  },
};