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
 * `<mint>:<wallet>:<label>`. Whitespace is trimmed. Malformed entries (missing
 * mint/wallet, invalid base58 pubkey) are skipped rather than fatal, so one bad
 * entry can never take down startup / every supply read. The label may contain
 * anything except a comma (which delimits entries).
 */
export function parseExcludedHolders(raw: string): ExcludedHolder[] {
  const holders: ExcludedHolder[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Split into at most 3 parts so a label may itself contain ':'.
    const firstColon = trimmed.indexOf(':');
    if (firstColon === -1) continue;
    const secondColon = trimmed.indexOf(':', firstColon + 1);
    const mint = trimmed.slice(0, firstColon).trim();
    const wallet =
      secondColon === -1
        ? trimmed.slice(firstColon + 1).trim()
        : trimmed.slice(firstColon + 1, secondColon).trim();
    const label = secondColon === -1 ? undefined : trimmed.slice(secondColon + 1).trim() || undefined;
    if (!mint || !wallet) continue;
    try {
      // Validate both are real pubkeys; keep `mint` as string (matches how the
      // supply path compares mints) and `wallet` as a PublicKey for ATA derivation.
      new PublicKey(mint);
      holders.push({ mint, wallet: new PublicKey(wallet), label });
    } catch {
      // Invalid base58 — skip this entry, never abort the whole list.
    }
  }
  return holders;
}

export const config = {
  solana: {
    rpcUrl: process.env.RPCPOOL_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  },
  server: {
    port: parseInt(process.env.PORT || '3000'),
    // Request timeout in milliseconds (default: 5 minutes)
    requestTimeout: parseInt(process.env.SERVER_REQUEST_TIMEOUT || '300000'),
    // Keep-alive timeout in milliseconds (default: 5 minutes)
    keepAliveTimeout: parseInt(process.env.SERVER_KEEP_ALIVE_TIMEOUT || '300000'),
    // Number of reverse-proxy hops in front of this process. Express uses it to
    // resolve the real client IP from X-Forwarded-For for per-IP rate limiting.
    // 0 = no proxy (req.ip is the socket peer). Use the exact hop count — a
    // blanket "trust everything" would let clients spoof their IP via XFF.
    trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0'),
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
    // TTL for blockchain data cache in milliseconds (default: 55 seconds).
    // Consumers (CoinGecko/DexScreener pollers) read about once per minute, so a
    // sub-minute TTL keeps every poll fresher than its cadence while cutting the
    // full DAO RPC scan from ~6x/minute to ~1x/minute.
    // Lower = more real-time prices but more RPC calls.
    tickersTTL: parseInt(process.env.CACHE_TICKERS_TTL || '55000'),
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
  circulating: {
    // Operator-vetted wallets whose live balance of a given mint is NON-circulating
    // (external/vesting/encumbered/protocol-owned holdings). Subtracted from the
    // circulating supply of the matching mint. See parseExcludedHolders for format.
    excludedHolders: parseExcludedHolders(process.env.EXCLUDED_CIRCULATING_WALLETS || ''),
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
    intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '60000'),
    // Alert when the newest user_pool swap is older than this (seconds).
    // 0 disables the staleness alert (connectivity/contract alerts remain).
    maxDataAgeSeconds: parseInt(process.env.HEARTBEAT_MAX_DATA_AGE_SECONDS || '21600'),
    // Run the served-data contract check every Nth heartbeat tick.
    contractCheckEveryTicks: 10,
  },
};
