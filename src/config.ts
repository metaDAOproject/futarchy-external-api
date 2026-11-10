import { PublicKey } from '@solana/web3.js';

/**
 * A wallet whose live on-chain balance of a specific mint is treated as
 * non-circulating (external/vesting/encumbered/protocol-owned holdings that are
 * NOT "in the hands of others"). Scoped per-mint so we only ever exclude a
 * balance an operator has explicitly vetted as encumbered.
 */
export interface ExcludedHolder {
  /** Base mint whose balance held by `wallet` is excluded from circulating supply. */
  mint: string;
  /** Wallet (owner) address that holds the encumbered tokens. */
  wallet: PublicKey;
  /** Optional human-readable tag surfaced in the supply allocation response. */
  label?: string;
}

/**
 * Parse the `EXCLUDED_CIRCULATING_WALLETS` env value into structured holders.
 *
 * Format: comma-separated entries, each `<mint>:<wallet>` or
 * `<mint>:<wallet>:<label>`. Whitespace is trimmed and blank entries (e.g. a
 * trailing comma) are ignored. The label may contain anything except a comma
 * (which delimits entries).
 *
 * A malformed NON-blank entry (missing mint/wallet, invalid base58 pubkey)
 * THROWS. This is a financial serving path: silently dropping a typo'd exclusion
 * would overstate circulating supply, so we fail fast at startup instead — the
 * same fail-loud-not-quietly-wrong contract the rest of the supply path follows.
 */
export function parseExcludedHolders(raw: string): ExcludedHolder[] {
  const holders: ExcludedHolder[] = [];
  // Dedupe by mint:wallet — a duplicated env entry (copy/paste) would otherwise be
  // resolved and subtracted twice, double-counting the same live balance and
  // understating circulating supply.
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue; // blank entry / trailing comma — not an error
    const [mintPart = '', walletPart = '', ...labelParts] = trimmed.split(':');
    const mint = mintPart.trim();
    const wallet = walletPart.trim();
    const label = labelParts.join(':').trim() || undefined;
    if (!mint || !wallet) {
      throw new Error(
        `Invalid EXCLUDED_CIRCULATING_WALLETS entry "${trimmed}" — expected "<mint>:<wallet>" or "<mint>:<wallet>:<label>"`,
      );
    }
    try {
      // Validate both are real pubkeys; keep `mint` as string (matches how the
      // supply path compares mints) and `wallet` as a PublicKey for lookups.
      new PublicKey(mint);
      const walletKey = new PublicKey(wallet); // throws if invalid
      const dedupeKey = `${mint}:${wallet}`;
      if (seen.has(dedupeKey)) continue; // drop exact duplicate (keep first occurrence)
      seen.add(dedupeKey);
      holders.push({ mint, wallet: walletKey, label });
    } catch {
      throw new Error(
        `Invalid EXCLUDED_CIRCULATING_WALLETS entry "${trimmed}" — mint and wallet must be valid base58 pubkeys`,
      );
    }
  }
  return holders;
}

// Numeric env vars are validated at startup: a typo (e.g. "30s") must fail
// fast, not become NaN — a NaN TTL silently disables caching, a NaN port or
// rate limit breaks serving.
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

function fractionEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${name} must be a number in [0, 1), got "${raw}"`);
  }
  return value;
}

export const config = {
  solana: {
    rpcUrl: process.env.RPCPOOL_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    // Per-request RPC timeout (ms). Generous enough for getProgramAccounts scans.
    rpcTimeoutMs: intEnv('RPC_TIMEOUT_MS', 20000),
  },
  server: {
    port: intEnv('PORT', 3000),
    // Max time (ms) to produce a response; slower requests get a 503
    // REQUEST_TIMEOUT instead of hanging the client (default: 30 seconds).
    requestTimeout: intEnv('SERVER_REQUEST_TIMEOUT', 30000),
    // Keep-alive timeout in milliseconds (default: 5 minutes)
    keepAliveTimeout: intEnv('SERVER_KEEP_ALIVE_TIMEOUT', 300000),
    // Number of reverse-proxy hops in front of this process. Express uses it to
    // resolve the real client IP from X-Forwarded-For for per-IP rate limiting.
    // 0 = no proxy (req.ip is the socket peer). Use the exact hop count — a
    // blanket "trust everything" would let clients spoof their IP via XFF.
    trustProxyHops: intEnv('TRUST_PROXY_HOPS', 0),
    // `Cache-Control: private, max-age=N` on successful data responses, so
    // clients can reuse a response for N seconds. Errors and health/metrics are no-store.
    cacheMaxAgeSeconds: intEnv('CACHE_CONTROL_MAX_AGE', 30),
    // On SIGTERM, report not-ready and keep serving this long (ms) so the load
    // balancer stops routing here before the listener closes. Kubernetes
    // removes a terminating pod from its endpoints right away; this covers the
    // propagation to the ingress. Keep drain + 15s close budget under the
    // platform's termination grace period (Kubernetes default 30s).
    shutdownDrainMs: intEnv('SHUTDOWN_DRAIN_MS', 10000),
    rateLimit: {
      windowMs: 60000, // 1 minute
      maxRequests: 60, // 60 requests per minute
    },
    // Shared rate-limit counters (redis:// or rediss://). Unset: each replica
    // counts on its own, so N replicas allow N× the published limits.
    rateLimitRedisUrl: process.env.RATE_LIMIT_REDIS_URL || '',
    trustedApiKeys: new Set<string>(
      (process.env.TRUSTED_API_KEYS || '')
        .split(',')
        .map(k => k.trim())
        .filter(Boolean)
    ),
    trustedRateLimit: {
      windowMs: 60_000,
      maxRequests: intEnv('TRUSTED_RATE_LIMIT_MAX', 600),
    },
  },
  cache: {
    // TTL for blockchain data cache in milliseconds (default: 55 seconds).
    // Consumers (CoinGecko/DexScreener pollers) read about once per minute, so a
    // sub-minute TTL keeps every poll fresher than its cadence while cutting the
    // full DAO RPC scan from ~6x/minute to ~1x/minute.
    // Lower = more real-time prices but more RPC calls.
    tickersTTL: intEnv('CACHE_TICKERS_TTL', 55000),
    // Once the DAO snapshot is older than tickersTTL it is refreshed in the
    // background while the previous snapshot keeps being served, up to this
    // age (ms). Past it, requests wait for a fresh scan and fail (5xx) if the
    // RPC is down, rather than serve prices older than this.
    tickersMaxStale: intEnv('CACHE_TICKERS_MAX_STALE', 300000),
    // TTL for the /api/launches/live snapshot (default: 5 minutes). Each refresh
    // scans every launch account plus the funding records of each live launch.
    liveLaunchesTTL: intEnv('CACHE_LIVE_LAUNCHES_TTL', 300000),
    // How long (ms) the served-DB aggregates behind /api/tickers and /cmc/*
    // (rolling-24h volume, 24h-ago reserves, first-trade dates) are reused
    // across requests. Matches the default Cache-Control max-age; the ETL
    // itself lags by more than this. 0 still coalesces concurrent queries.
    servedMetricsTTL: intEnv('CACHE_SERVED_METRICS_TTL', 30000),
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
    protocolFeeRate: fractionEnv('PROTOCOL_FEE_RATE', 0.005),
  },
  marketData: {
    // Max inclusive days one /api/market-data request may span (366 = a full
    // leap year). Bounds the response size and the served-DB scan per request;
    // longer histories are fetched in several ranges. 0 disables the cap.
    maxRangeDays: intEnv('MARKET_DATA_MAX_RANGE_DAYS', 366),
  },
  circulating: {
    // Operator-vetted wallets whose live balance of a given mint is NON-circulating
    // (external/vesting/encumbered/protocol-owned holdings). Subtracted from the
    // circulating supply of the matching mint. See parseExcludedHolders for format.
    excludedHolders: parseExcludedHolders(process.env.EXCLUDED_CIRCULATING_WALLETS || ''),
  },
  coinmarketcap: {
    // Optional allowlist of base-mint addresses exposed on the CoinMarketCap
    // routes. Empty (the default) means "serve every discovered DAO", matching
    // the CoinGecko/DexScreener adapters. When set, ONLY these base mints appear
    // — this is how we map our tokens onto CMC's expected asset ids without
    // leaking test/never-listed DAOs into the CMC feed.
    //
    // Each entry is validated as a Solana pubkey at startup (like EXCLUDED_DAOS):
    // a typo throws here — fail fast — rather than silently filtering every pair
    // and serving an empty /cmc feed that a poller would read as "delisted". The
    // normalized base58 form is stored so lookups match baseMint.toString().
    allowedMints: new Set<string>(
      (process.env.CMC_ALLOWED_MINTS || '')
        .split(',')
        .map(m => m.trim())
        .filter(Boolean)
        .map(m => new PublicKey(m).toString())
    ),
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
    // Postgres cancels any statement running longer than this (ms), so a slow
    // query can't hold one of the pool's 5 connections after its request has
    // already timed out (SERVER_REQUEST_TIMEOUT, 30s). 0 disables it.
    statementTimeoutMs: intEnv('DATABASE_PG_STATEMENT_TIMEOUT_MS', 25000),
    // /api/tickers and /cmc/summary|ticker answer 503 SERVED_DATA_STALE when
    // the newest FutarchyAMM spot swap is older than this (seconds), instead of serving
    // 24h volume that drains to zero behind a stalled ETL. Same default as the
    // heartbeat's stale-data alert. 0 disables the guard.
    maxDataAgeSeconds: intEnv('SERVED_DATA_MAX_AGE_SECONDS', 21600),
  },
  metrics: {
    // When set, GET /metrics requires `Authorization: Bearer <token>`.
    // Unset leaves it open (a startup warning is logged).
    token: process.env.METRICS_TOKEN || '',
  },
  heartbeat: {
    // Background self-check cadence (served DB connectivity, data freshness,
    // contract drift). 0 disables the heartbeat entirely.
    intervalMs: intEnv('HEARTBEAT_INTERVAL_MS', 60000),
    // Alert when the newest user_pool swap is older than this (seconds).
    // 0 disables the staleness alert (connectivity/contract alerts remain).
    maxDataAgeSeconds: intEnv('HEARTBEAT_MAX_DATA_AGE_SECONDS', 21600),
    // Run the served-data contract check every Nth heartbeat tick.
    contractCheckEveryTicks: 10,
  },
};
