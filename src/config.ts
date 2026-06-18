import { PublicKey } from '@solana/web3.js';

export type RestrictionMode = 'normal' | 'restricted' | 'lockdown';

const VALID_RESTRICTION_MODES = ['normal', 'restricted', 'lockdown'] as const;

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsv(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseRestrictionMode(value: string | undefined): RestrictionMode {
  switch (value) {
    case 'restricted':
      return 'restricted';
    case 'lockdown':
      return 'lockdown';
    case 'normal':
    case undefined:
    case '':
      return 'normal';
    default:
      console.warn(JSON.stringify({
        level: 'WARN',
        message: 'Invalid RESTRICTION_MODE; falling back to normal',
        value,
        validValues: VALID_RESTRICTION_MODES,
      }));
      return 'normal';
  }
}

export const config = {
  solana: {
    rpcUrl: process.env.RPCPOOL_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  },
  server: {
    port: parseInteger(process.env.PORT, 3000),
    // Request timeout in milliseconds (default: 5 minutes)
    requestTimeout: parseInteger(process.env.SERVER_REQUEST_TIMEOUT, 300000),
    // Keep-alive timeout in milliseconds (default: 5 minutes)
    keepAliveTimeout: parseInteger(process.env.SERVER_KEEP_ALIVE_TIMEOUT, 300000),
    // Number of reverse-proxy hops in front of this process. Express uses it to
    // resolve the real client IP from X-Forwarded-For for per-IP rate limiting.
    // 0 = no proxy (req.ip is the socket peer). Use the exact hop count — a
    // blanket "trust everything" would let clients spoof their IP via XFF.
    trustProxyHops: parseInteger(process.env.TRUST_PROXY_HOPS, 0),
    rateLimit: {
      windowMs: parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 60000),
      maxRequests: parseInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 60),
    },
    globalRateLimit: {
      maxRequests: parseInteger(process.env.GLOBAL_RATE_LIMIT_MAX, 0),
      windowMs: parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 60000),
    },
    trustedApiKeys: new Set<string>(
      parseCsv(process.env.TRUSTED_API_KEYS)
    ),
    trustedRateLimit: {
      windowMs: 60_000,
      maxRequests: parseInteger(process.env.TRUSTED_RATE_LIMIT_MAX, 600),
    },
    restriction: {
      mode: parseRestrictionMode(process.env.RESTRICTION_MODE),
      disabledPaths: parseCsv(process.env.RESTRICTION_DISABLED_PATHS),
      exemptCidrs: parseCsv(process.env.RESTRICTION_EXEMPT_CIDRS),
      alwaysAllowedPaths: ['/health', '/api/health', '/metrics'],
    },
    allowedOrigins: parseCsv(process.env.ALLOWED_ORIGINS),
  },
  cache: {
    tickersTTL: parseInteger(process.env.CACHE_TICKERS_TTL, 55000),
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
    // Protocol fee rate (0.005 = 0.5%); used to report fee bps on DexScreener routes.
    protocolFeeRate: parseFloat(process.env.PROTOCOL_FEE_RATE || '0.005'),
  },
  alerts: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || 'https://telegram-webhook-relay.themetadao-org.workers.dev',
    webhookSecret: process.env.ALERT_WEBHOOK_SECRET || '',
  },
  externalDatabase: {
    // Read-only connection to the served ETL DB — the ONLY database this API uses.
    // (The old app DB is fully removed; any future write goes to the prod DB.)
    connectionString: process.env.DATABASE_PG_URL || '',
    ssl: process.env.DATABASE_PG_SSL === 'true',
    // PEM CA certificate (the cert content, not a path) for verifying a server
    // signed by a private CA. With SSL on and no CA cert, system CAs are used.
    caCert: process.env.DATABASE_PG_CA_CERT || '',
    // Explicit opt-out of TLS server verification (legacy/self-signed setups).
    // Encrypts but does NOT authenticate the server — set only as a stopgap.
    sslNoVerify: process.env.DATABASE_PG_SSL_NO_VERIFY === 'true',
  },
  heartbeat: {
    // Background self-check cadence (served DB connectivity, data freshness,
    // contract drift). 0 disables the heartbeat entirely.
    intervalMs: parseInteger(process.env.HEARTBEAT_INTERVAL_MS, 60000),
    // Alert when the newest user_pool swap is older than this (seconds).
    // 0 disables the staleness alert (connectivity/contract alerts remain).
    maxDataAgeSeconds: parseInteger(process.env.HEARTBEAT_MAX_DATA_AGE_SECONDS, 21600),
    // Run the served-data contract check every Nth heartbeat tick.
    contractCheckEveryTicks: 10,
  },
};
