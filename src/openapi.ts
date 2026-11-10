/**
 * OpenAPI 3.1 contract for the public, read-only Futarchy External API.
 *
 * Hand-maintained to match the route handlers in src/routes/ and the response
 * types in src/types/. tests/openapi.test.ts guards against drift: every
 * documented path must exist in the app and every `$ref` must resolve. When a
 * route or response shape changes, update this file in the same change.
 *
 * Lives under src/ (not docs/) because the Docker image only ships src/ and the
 * spec is served at GET /openapi.json.
 */

// ---------------------------------------------------------------------------
// Small builders (keep the paths section readable). They return plain objects.
// ---------------------------------------------------------------------------

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` }) as const;
const responseRef = (name: string) => ({ $ref: `#/components/responses/${name}` }) as const;
const paramRef = (name: string) => ({ $ref: `#/components/parameters/${name}` }) as const;
const headerRef = (name: string) => ({ $ref: `#/components/headers/${name}` }) as const;

/** X-API-Key is optional: anonymous access is allowed at a lower rate limit. */
const OPTIONAL_API_KEY = [{}, { apiKey: [] }];

/** Headers on every response that passed the rate limiter, plus caching/request id. */
const DATA_HEADERS = {
  'Cache-Control': headerRef('CacheControlPublic'),
  'RateLimit-Limit': headerRef('RateLimitLimit'),
  'RateLimit-Remaining': headerRef('RateLimitRemaining'),
  'RateLimit-Reset': headerRef('RateLimitReset'),
  'X-Request-Id': headerRef('XRequestId'),
};

const NO_STORE_HEADERS = {
  'Cache-Control': headerRef('CacheControlNoStore'),
  'RateLimit-Limit': headerRef('RateLimitLimit'),
  'RateLimit-Remaining': headerRef('RateLimitRemaining'),
  'RateLimit-Reset': headerRef('RateLimitReset'),
  'X-Request-Id': headerRef('XRequestId'),
};

/** Probe endpoints run before the rate limiter: no RateLimit-* headers. */
const PROBE_HEADERS = {
  'Cache-Control': headerRef('CacheControlNoStore'),
  'X-Request-Id': headerRef('XRequestId'),
};

function jsonOk(description: string, schema: object, headers: object = DATA_HEADERS) {
  return {
    description,
    headers,
    content: { 'application/json': { schema } },
  };
}

/** Standard error responses for a rate-limited data endpoint. */
const COMMON_ERRORS = {
  '400': responseRef('BadRequest'),
  '401': responseRef('Unauthorized'),
  '429': responseRef('TooManyRequests'),
  '500': responseRef('InternalError'),
  '503': responseRef('ServiceUnavailable'),
};

const solanaAddress = {
  type: 'string',
  pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
  description: 'Solana public key (base58).',
  examples: ['So11111111111111111111111111111111111111112'],
} as const;

const decimalString = (description: string) => ({
  type: 'string',
  description: `${description} Decimal string in human units.`,
  examples: ['1234.56'],
});

const nullableDecimalString = (description: string) => ({
  type: ['string', 'null'],
  description: `${description} Decimal string in human units; null when the day had no conditional-market row.`,
});

// ---------------------------------------------------------------------------
// Market-data row schemas (src/services/externalDatabaseService.ts)
// ---------------------------------------------------------------------------

const FUTARCHY_FEE_FIELDS = [
  ['buy_volume', 'Buy-side volume (quote/USD).'],
  ['sell_volume', 'Sell-side volume (quote/USD).'],
  ['base_volume', 'Volume in the base token.'],
  ['target_volume', 'Volume in the quote token (USD).'],
  ['usdc_fees', 'Fees collected in USDC.'],
  ['token_fees', 'Fees collected in the base token.'],
  ['token_fees_usdc', 'Base-token fees valued in USDC.'],
  ['protocol_fee_usd', 'Protocol fee portion (USD), collected to the treasury.'],
  ['lp_fee_usd', 'LP fee portion (USD), retained in the pool.'],
] as const;

function futarchyActivityProperties() {
  const props: Record<string, object> = {
    token: { ...solanaAddress, description: 'Base token mint.' },
    date: { type: 'string', format: 'date', description: 'UTC day (YYYY-MM-DD).' },
    has_conditional_volume: { type: 'boolean', description: 'True when the day has a conditional-market row.' },
  };
  for (const [field, desc] of FUTARCHY_FEE_FIELDS) {
    props[`spot_${field}`] = decimalString(`Spot market: ${desc}`);
  }
  props.spot_trade_count = { type: 'integer', description: 'Spot market trade count.' };
  for (const [field, desc] of FUTARCHY_FEE_FIELDS) {
    props[`conditional_${field}`] = nullableDecimalString(`Conditional markets: ${desc}`);
  }
  props.conditional_trade_count = {
    type: ['integer', 'null'],
    description: 'Conditional markets trade count; null when the day had no conditional-market row.',
  };
  for (const [field, desc] of FUTARCHY_FEE_FIELDS) {
    props[`total_${field}`] = decimalString(`Spot + conditional: ${desc}`);
  }
  props.total_trade_count = { type: 'integer', description: 'Spot + conditional trade count.' };
  props.conditional_reconciled = { type: 'boolean', description: 'Whether conditional volume for the day has been reconciled.' };
  props.pending_open_proposals = { type: 'integer', description: 'Open proposals whose conditional volume is still pending.' };
  return props;
}

const futarchyActivityRowProperties = futarchyActivityProperties();

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

// Data endpoints are served under /v1 and, unchanged, at the unversioned path
// (a frozen alias of v1). Operational endpoints are only at the root.
const VERSIONED_SERVERS = [
  { url: '/v1', description: 'Versioned (recommended for new integrations)' },
  { url: '/', description: 'Unversioned alias of v1, kept for existing integrations' },
];

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Futarchy External API',
    version: '2.0.0',
    description: [
      'Public, read-only HTTP API serving Futarchy protocol DEX data (FutarchyAMM spot markets, plus Meteora pools for daily market data) to aggregators such as CoinGecko, CoinMarketCap, DexScreener and Jupiter, and to dashboards.',
      '',
      '**Versioning.** Every data endpoint is served under `/v1` (e.g. `/v1/api/tickers`) and, unchanged, at its unversioned path, which is a frozen alias of v1. Health, probe, metrics and docs endpoints are not versioned. Breaking changes ship as a new version prefix. A deprecated version answers with `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and `Link: <…>; rel="successor-version"` headers.',
      '',
      '**Units.** Token amounts, prices and volumes are in human units (already divided by the mint decimals). Most adapters serve them as decimal strings; fields suffixed `Raw` are integer strings in base units. Adapters whose consumer requires JSON numbers (CoinMarketCap, DexScreener, the Jupiter supply endpoints) serve numbers, as noted per schema.',
      '',
      '**Rate limits.** Anonymous clients get 60 requests per minute per IP. Trusted partners send an `X-API-Key` header and get a higher limit; an unknown key is rejected with 401 `INVALID_API_KEY`. Rate-limited responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds); a 429 also carries `Retry-After` (seconds). Container probes (`/health/startup`, `/health/ready`, `/health/live`) are not rate limited. Limits are enforced across all replicas when the deployment shares a Redis store.',
      '',
      '**Caching.** Successful data responses are sent with `Cache-Control: private, max-age=30` (client-side reuse only; responses carry per-caller rate-limit headers). Errors, health and metrics responses are `Cache-Control: no-store`. Responses over 1 KB are compressed (`br`, `gzip` or `deflate`) when the request sends `Accept-Encoding`.',
      '',
      '**Serving invariant.** Infrastructure failures (Solana RPC, served database) return a 5xx. The API never answers 200 with zero, empty, or placeholder financial data because a dependency failed. Retry on 5xx; treat a 200 as authoritative.',
      '',
      '**Errors.** Every error is JSON in one shape, the `Error` schema: `{ error, code, field?, requestId }`. Branch on `code` (stable), not on the `error` message (human-readable, may change); `field` names the offending parameter on a 400. Each request may take each query parameter at most once: a repeated parameter is a 400 `INVALID_QUERY_PARAMETER`. Unknown routes return 404 `NOT_FOUND`. A request that exceeds the server timeout returns 503 `REQUEST_TIMEOUT`.',
    ].join('\n'),
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'CoinGecko', description: 'CoinGecko DEX integration (strings for numeric values).' },
    { name: 'CoinMarketCap', description: 'CoinMarketCap DEX integration [Section C] (JSON numbers). Also served under `/cmc/v1`.' },
    { name: 'DexScreener', description: 'DexScreener HTTP adapter v1.1. Block numbers are Solana slots.' },
    { name: 'Supply', description: 'Token total and circulating supply, including launchpad allocations.' },
    { name: 'Market data', description: 'Daily volume and fee history from the served ETL.' },
    { name: 'Launches', description: 'Launchpad raises currently accepting commitments.' },
    { name: 'Health', description: 'Health checks, container probes and Prometheus metrics.' },
    { name: 'Meta', description: 'API index and documentation.' },
  ],
  paths: {
    // ------------------------------------------------------------------ Meta
    '/': {
      get: {
        operationId: 'getApiIndex',
        summary: 'API index',
        description: 'Human-oriented index of the available endpoints and DEX metadata. Informational; the field set is not a stable contract.',
        tags: ['Meta'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': jsonOk('API index.', ref('ApiIndex')),
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'OpenAPI document',
        description: 'This OpenAPI 3.1 document.',
        tags: ['Meta'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': {
            description: 'The OpenAPI document.',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
        },
      },
    },
    '/docs': {
      get: {
        operationId: 'getDocs',
        summary: 'HTML API documentation',
        description: 'Human-readable documentation page rendered from `/openapi.json`.',
        tags: ['Meta'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': {
            description: 'HTML documentation page.',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
        },
      },
    },

    // ------------------------------------------------------------- CoinGecko
    '/api/tickers': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCoinGeckoTickers',
        summary: 'CoinGecko tickers',
        description: 'One ticker per FutarchyAMM spot market. Price, spread and liquidity come from live pool reserves; 24h volume, high and low come from the served ETL. A market with no trades in the last 24h reports volume "0" and omits high/low. Returns 503 `SERVED_DB_UNAVAILABLE` when the served database is not connected, and 503 `SERVED_DATA_STALE` when the newest FutarchyAMM spot swap is older than the server\'s freshness limit (default 6h), rather than reporting volume that drains to zero behind a stalled pipeline.',
        tags: ['CoinGecko'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': jsonOk('Array of tickers.', { type: 'array', items: ref('CoinGeckoTicker') }),
          ...COMMON_ERRORS,
        },
      },
    },

    // ----------------------------------------------------------- Market data
    '/api/market-data': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getMarketData',
        summary: 'Daily market data',
        description: 'Daily FutarchyAMM (spot, conditional and total) and Meteora activity per token over an inclusive date range. Parameters are validated before the database is touched, so a bad request is always 400.',
        tags: ['Market data'],
        security: OPTIONAL_API_KEY,
        parameters: [
          {
            name: 'startDate', in: 'query', required: true,
            description: 'First UTC day, inclusive (YYYY-MM-DD). Must be a real calendar date on or before `endDate`.',
            schema: { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            example: '2026-01-01',
          },
          {
            name: 'endDate', in: 'query', required: true,
            description: 'Last UTC day, inclusive (YYYY-MM-DD). The range may span at most 366 days (server default); split longer histories into several requests.',
            schema: { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            example: '2026-01-31',
          },
          {
            name: 'tokens', in: 'query', required: false,
            description: 'Comma-separated base-token mints to filter by (at most 100, each a valid Solana address). Omit for all tokens.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': jsonOk('Daily market data.', ref('MarketDataResponse')),
          ...COMMON_ERRORS,
        },
      },
    },

    // ---------------------------------------------------------------- Supply
    '/api/supply/{mintAddress}': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getSupply',
        summary: 'Supply breakdown',
        description: 'Total and circulating supply plus the launchpad allocation breakdown. `result` is the TOTAL supply; circulating supply is in `data.circulatingSupply`.',
        tags: ['Supply'],
        security: OPTIONAL_API_KEY,
        parameters: [paramRef('MintAddress')],
        responses: {
          '200': jsonOk('Supply breakdown.', ref('SupplyResponse')),
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/supply/{mintAddress}/total': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getTotalSupply',
        summary: 'Total supply',
        tags: ['Supply'],
        security: OPTIONAL_API_KEY,
        parameters: [paramRef('MintAddress')],
        responses: {
          '200': jsonOk('Total supply.', ref('SupplyResult')),
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/supply/{mintAddress}/circulating': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCirculatingSupply',
        summary: 'Circulating supply',
        description: 'Circulating supply = total supply minus the team performance package, unclaimed additional token allocation, DAO treasury tokens and configured excluded-holder balances. AMM and Meteora liquidity IS circulating. `allocation` is present for a non-trivial breakdown, including configured holders of tokens without a launch.',
        tags: ['Supply'],
        security: OPTIONAL_API_KEY,
        parameters: [paramRef('MintAddress')],
        responses: {
          '200': jsonOk('Circulating supply.', ref('CirculatingSupplyResponse')),
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/supply/{mintAddress}/jupiter/circulating': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getJupiterCirculatingSupply',
        summary: 'Circulating supply (Jupiter format)',
        tags: ['Supply'],
        security: OPTIONAL_API_KEY,
        parameters: [paramRef('MintAddress')],
        responses: {
          '200': jsonOk('Circulating supply as a JSON number.', ref('JupiterCirculatingSupply')),
          ...COMMON_ERRORS,
        },
      },
    },
    '/api/supply/{mintAddress}/jupiter/total': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getJupiterTotalSupply',
        summary: 'Total supply (Jupiter format)',
        tags: ['Supply'],
        security: OPTIONAL_API_KEY,
        parameters: [paramRef('MintAddress')],
        responses: {
          '200': jsonOk('Total supply as a JSON number.', ref('JupiterTotalSupply')),
          ...COMMON_ERRORS,
        },
      },
    },

    // -------------------------------------------------------------- Launches
    '/api/launches/live': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getLiveLaunches',
        summary: 'Live launches',
        description: 'Launchpad raises currently accepting commitments, read on-chain and cached server-side (default 5 minutes; `updatedAt` is the snapshot time).',
        tags: ['Launches'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': jsonOk('Live launches.', ref('LiveLaunchesResponse')),
          ...COMMON_ERRORS,
        },
      },
    },

    // --------------------------------------------------------- CoinMarketCap
    '/cmc/summary': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCmcSummary',
        summary: 'CoinMarketCap summary',
        description: '24h overview of every tradeable pair. 503 codes: `SERVED_DB_UNAVAILABLE`, `SERVED_DATA_STALE`, `CMC_ALLOWLIST_NO_MATCH`, `CMC_DUPLICATE_BASE_MINT`. 500 `CMC_MALFORMED_METRIC` when the served ETL returns a non-numeric metric.',
        tags: ['CoinMarketCap'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': responseRef('CmcSummary'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/cmc/ticker': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCmcTicker',
        summary: 'CoinMarketCap ticker',
        description: '24h price and volume keyed by `BASE_QUOTE` (mint addresses). Same 5xx codes as `/cmc/summary`.',
        tags: ['CoinMarketCap'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': responseRef('CmcTicker'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/cmc/assets': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCmcAssets',
        summary: 'CoinMarketCap assets',
        description: 'Identity of every base and quote token, keyed by mint address. On-chain metadata only (does not need the served DB). 503 codes: `CMC_ALLOWLIST_NO_MATCH`, `CMC_DUPLICATE_BASE_MINT`.',
        tags: ['CoinMarketCap'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': responseRef('CmcAssets'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/cmc/v1/summary': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCmcV1Summary',
        summary: 'CoinMarketCap summary (v1)',
        description: 'Versioned alias of `/cmc/summary`; same handler and response.',
        tags: ['CoinMarketCap'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': responseRef('CmcSummary'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/cmc/v1/ticker': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCmcV1Ticker',
        summary: 'CoinMarketCap ticker (v1)',
        description: 'Versioned alias of `/cmc/ticker`; same handler and response.',
        tags: ['CoinMarketCap'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': responseRef('CmcTicker'),
          ...COMMON_ERRORS,
        },
      },
    },
    '/cmc/v1/assets': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getCmcV1Assets',
        summary: 'CoinMarketCap assets (v1)',
        description: 'Versioned alias of `/cmc/assets`; same handler and response.',
        tags: ['CoinMarketCap'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': responseRef('CmcAssets'),
          ...COMMON_ERRORS,
        },
      },
    },

    // ----------------------------------------------------------- DexScreener
    '/dexscreener/latest-block': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getDexScreenerLatestBlock',
        summary: 'Latest indexed block',
        description: 'Slot and timestamp of the newest indexed FutarchyAMM spot swap.',
        tags: ['DexScreener'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': jsonOk('Latest block.', ref('DexScreenerLatestBlockResponse')),
          '401': responseRef('Unauthorized'),
          '404': responseRef('DexScreenerNotFound'),
          '429': responseRef('TooManyRequests'),
          '500': responseRef('InternalError'),
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/dexscreener/asset': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getDexScreenerAsset',
        summary: 'Asset metadata',
        description: 'Token name, symbol, decimals and supply. Cached server-side for CACHE_TICKERS_TTL (55 seconds by default). If supply cannot be verified, the request returns 503 SUPPLY_UNAVAILABLE.',
        tags: ['DexScreener'],
        security: OPTIONAL_API_KEY,
        parameters: [
          {
            name: 'id', in: 'query', required: true,
            description: 'Token mint address.',
            schema: solanaAddress,
          },
        ],
        responses: {
          '200': jsonOk('Asset.', ref('DexScreenerAssetResponse')),
          '400': responseRef('BadRequest'),
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
          '500': responseRef('InternalError'),
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/dexscreener/pair': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getDexScreenerPair',
        summary: 'Pair metadata',
        description: 'Pair identity and creation block (first spot swap). Cached server-side for 5 minutes. 404 when the DAO has no spot swaps.',
        tags: ['DexScreener'],
        security: OPTIONAL_API_KEY,
        parameters: [
          {
            name: 'id', in: 'query', required: true,
            description: 'Pair id: the DAO address.',
            schema: solanaAddress,
          },
        ],
        responses: {
          '200': jsonOk('Pair.', ref('DexScreenerPairResponse')),
          '400': responseRef('BadRequest'),
          '401': responseRef('Unauthorized'),
          '404': responseRef('DexScreenerNotFound'),
          '429': responseRef('TooManyRequests'),
          '500': responseRef('InternalError'),
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },
    '/dexscreener/events': {
      servers: VERSIONED_SERVERS,
      get: {
        operationId: 'getDexScreenerEvents',
        summary: 'Swap events by block range',
        description: 'FutarchyAMM spot swap events with `fromBlock <= slot <= toBlock`, ordered by slot then transaction. The range may span at most 500,000 slots (`toBlock - fromBlock <= 500000`); larger ranges, non-integer or negative bounds, and `toBlock < fromBlock` are 400.',
        tags: ['DexScreener'],
        security: OPTIONAL_API_KEY,
        parameters: [
          {
            name: 'fromBlock', in: 'query', required: true,
            description: 'First slot, inclusive.',
            schema: { type: 'integer', minimum: 0 },
          },
          {
            name: 'toBlock', in: 'query', required: true,
            description: 'Last slot, inclusive. Must be >= fromBlock and at most fromBlock + 500000.',
            schema: { type: 'integer', minimum: 0 },
          },
        ],
        responses: {
          '200': jsonOk('Swap events.', ref('DexScreenerEventsResponse')),
          '400': responseRef('BadRequest'),
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
          '500': responseRef('InternalError'),
          '503': responseRef('ServiceUnavailable'),
        },
      },
    },

    // ---------------------------------------------------------------- Health
    '/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Basic liveness',
        description: 'Process is up. Never checks dependencies. Rate limited (unlike the `/health/*` probes).',
        tags: ['Health'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': jsonOk('Process is up.', ref('BasicHealth'), NO_STORE_HEADERS),
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
        },
      },
    },
    '/api/health': {
      get: {
        operationId: 'getDetailedHealth',
        summary: 'Detailed health',
        description: 'Served-database connectivity, data-contract and freshness checks. Returns 200 when `status` is "healthy" and 503 with the same body when it is "degraded".',
        tags: ['Health'],
        security: OPTIONAL_API_KEY,
        responses: {
          '200': jsonOk('Healthy.', ref('DetailedHealth'), NO_STORE_HEADERS),
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
          '503': jsonOk(
            'Degraded (same body, `status: "degraded"` with a `message`), or `REQUEST_TIMEOUT` (`Error` body) if the checks took longer than the request timeout.',
            { anyOf: [ref('DetailedHealth'), ref('Error')] },
            NO_STORE_HEADERS,
          ),
        },
      },
    },
    '/health/startup': {
      get: {
        operationId: 'getStartupProbe',
        summary: 'Startup probe',
        description: 'Container startup probe: 200 once the served database connected at boot. Not rate limited.',
        tags: ['Health'],
        security: [{}],
        responses: {
          '200': jsonOk('Started.', ref('ProbeStatus'), PROBE_HEADERS),
          '503': jsonOk('Served database not connected (`status: "starting"`).', ref('ProbeStatus'), PROBE_HEADERS),
        },
      },
    },
    '/health/ready': {
      get: {
        operationId: 'getReadinessProbe',
        summary: 'Readiness probe',
        description: 'Container readiness probe: 200 while the served database answers within 2s. 503 with `status` "unavailable" when it does not, or "draining" during shutdown. Not rate limited.',
        tags: ['Health'],
        security: [{}],
        responses: {
          '200': jsonOk('Ready.', ref('ProbeStatus'), PROBE_HEADERS),
          '503': jsonOk('Not ready.', ref('ProbeStatus'), PROBE_HEADERS),
        },
      },
    },
    '/health/live': {
      get: {
        operationId: 'getLivenessProbe',
        summary: 'Liveness probe',
        description: 'Container liveness probe: 200 whenever the event loop can answer. No dependency checks. Not rate limited.',
        tags: ['Health'],
        security: [{}],
        responses: {
          '200': jsonOk('Alive.', ref('ProbeStatus'), PROBE_HEADERS),
        },
      },
    },
    '/metrics': {
      get: {
        operationId: 'getMetrics',
        summary: 'Prometheus metrics',
        description: 'Prometheus text exposition format. When the server sets `METRICS_TOKEN`, requests must send `Authorization: Bearer <METRICS_TOKEN>` (401 otherwise); the endpoint is open only when `METRICS_TOKEN` is unset.',
        tags: ['Health'],
        security: [{ metricsBearer: [] }],
        responses: {
          '200': {
            description: 'Metrics.',
            headers: NO_STORE_HEADERS,
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          '401': responseRef('Unauthorized'),
          '429': responseRef('TooManyRequests'),
          '503': responseRef('ServiceUnavailable'),
          '500': {
            description: 'Metrics could not be generated (plain-text body).',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Optional partner key. Requests without it are served at the anonymous rate limit (60/min per IP); a valid key gets the trusted limit; an unknown key is rejected with 401 `INVALID_API_KEY`.',
      },
      metricsBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Required on `/metrics` only when the server sets `METRICS_TOKEN`; the token is that value. When `METRICS_TOKEN` is unset, `/metrics` is open.',
      },
    },

    parameters: {
      MintAddress: {
        name: 'mintAddress',
        in: 'path',
        required: true,
        description: 'Token mint address. Invalid addresses are 400 `INVALID_MINT_ADDRESS`.',
        schema: solanaAddress,
      },
    },

    headers: {
      CacheControlPublic: {
        description: '`private, max-age=30` on successful data responses.',
        schema: { type: 'string', examples: ['private, max-age=30'] },
      },
      CacheControlNoStore: {
        description: '`no-store` on errors, health and metrics responses.',
        schema: { type: 'string', const: 'no-store' },
      },
      RateLimitLimit: {
        description: 'Requests allowed per window for this client tier.',
        schema: { type: 'integer' },
      },
      RateLimitRemaining: {
        description: 'Requests remaining in the current window.',
        schema: { type: 'integer' },
      },
      RateLimitReset: {
        description: 'Seconds until the current window resets.',
        schema: { type: 'integer' },
      },
      RetryAfter: {
        description: 'Seconds to wait before retrying.',
        schema: { type: 'integer' },
      },
      XRequestId: {
        description: 'Request id (echoes a safe client-supplied `X-Request-Id`, otherwise a generated UUID). Quote it when reporting problems.',
        schema: { type: 'string' },
      },
    },

    responses: {
      BadRequest: {
        description: 'Invalid request: `INVALID_MINT_ADDRESS` for a bad path address, `INVALID_QUERY_PARAMETER` for a missing, malformed or repeated query parameter. `field` names the parameter.',
        headers: { 'Cache-Control': headerRef('CacheControlNoStore') },
        content: { 'application/json': { schema: ref('Error') } },
      },
      Unauthorized: {
        description: 'Unknown `X-API-Key` (`INVALID_API_KEY`), or missing/invalid metrics bearer token on `/metrics`.',
        headers: { 'Cache-Control': headerRef('CacheControlNoStore') },
        content: { 'application/json': { schema: ref('Error') } },
      },
      TooManyRequests: {
        description: 'Rate limit exceeded (`RATE_LIMITED`).',
        headers: {
          'Cache-Control': headerRef('CacheControlNoStore'),
          'RateLimit-Limit': headerRef('RateLimitLimit'),
          'RateLimit-Remaining': headerRef('RateLimitRemaining'),
          'RateLimit-Reset': headerRef('RateLimitReset'),
          'Retry-After': headerRef('RetryAfter'),
        },
        content: { 'application/json': { schema: ref('Error') } },
      },
      InternalError: {
        description: 'Unexpected server or upstream (RPC/DB) failure. Retry later.',
        headers: { 'Cache-Control': headerRef('CacheControlNoStore') },
        content: { 'application/json': { schema: ref('Error') } },
      },
      ServiceUnavailable: {
        description: 'A dependency is unavailable or its data is stale (e.g. `SERVED_DB_UNAVAILABLE`, `SERVED_DATA_STALE`) or the request timed out (`REQUEST_TIMEOUT`). Retry later.',
        headers: { 'Cache-Control': headerRef('CacheControlNoStore') },
        content: { 'application/json': { schema: ref('Error') } },
      },
      NotFound: {
        description: 'Unknown route (`NOT_FOUND`).',
        headers: { 'Cache-Control': headerRef('CacheControlNoStore') },
        content: { 'application/json': { schema: ref('Error') } },
      },
      DexScreenerNotFound: {
        description: 'No matching data (`NOT_FOUND`: "Pair not found" / "No blocks available").',
        headers: { 'Cache-Control': headerRef('CacheControlNoStore') },
        content: { 'application/json': { schema: ref('Error') } },
      },
      CmcSummary: jsonOk('Array of pair summaries.', { type: 'array', items: ref('CoinMarketCapSummaryPair') }),
      CmcTicker: jsonOk('Tickers keyed by `BASE_QUOTE` trading pair.', ref('CoinMarketCapTickerResponse')),
      CmcAssets: jsonOk('Assets keyed by mint address.', ref('CoinMarketCapAssetsResponse')),
    },

    schemas: {
      // -------------------------------------------------------------- errors
      Error: {
        type: 'object',
        description: 'The error body of every endpoint.',
        required: ['error', 'code', 'requestId'],
        properties: {
          error: { type: 'string', description: 'Human-readable message. May change; branch on `code`.' },
          code: {
            type: 'string',
            description: 'Stable machine-readable code.',
            examples: ['NOT_FOUND', 'RATE_LIMITED', 'INVALID_API_KEY', 'INVALID_QUERY_PARAMETER', 'INVALID_MINT_ADDRESS', 'SERVED_DB_UNAVAILABLE', 'SERVED_DATA_STALE', 'REQUEST_TIMEOUT', 'INTERNAL_ERROR'],
          },
          field: { type: 'string', description: 'On a 400: the request parameter that was rejected.', examples: ['startDate', 'id'] },
          requestId: { type: 'string', description: 'Request id, same as the `X-Request-Id` header.' },
        },
      },

      // ----------------------------------------------------------- CoinGecko
      CoinGeckoTicker: {
        type: 'object',
        description: 'A FutarchyAMM spot market. All numeric values are decimal strings in human units.',
        required: ['ticker_id', 'base_currency', 'target_currency', 'pool_id', 'last_price', 'base_volume', 'target_volume', 'liquidity_in_usd', 'bid', 'ask'],
        properties: {
          ticker_id: { type: 'string', description: '`{base_currency}_{target_currency}`.' },
          base_currency: { ...solanaAddress, description: 'Base token mint.' },
          target_currency: { ...solanaAddress, description: 'Quote token mint.' },
          base_symbol: { type: 'string' },
          base_name: { type: 'string' },
          target_symbol: { type: 'string' },
          target_name: { type: 'string' },
          pool_id: { ...solanaAddress, description: 'DAO address.' },
          last_price: decimalString('Mid price (quote per base) from pool reserves.'),
          base_volume: decimalString('Rolling 24h volume in the base token.'),
          target_volume: decimalString('Rolling 24h volume in the quote token.'),
          liquidity_in_usd: decimalString('Pool liquidity in USD.'),
          bid: decimalString('Bid price.'),
          ask: decimalString('Ask price.'),
          high_24h: decimalString('Rolling 24h high. Omitted when there were no trades.'),
          low_24h: decimalString('Rolling 24h low. Omitted when there were no trades.'),
          treasury_usdc_aum: decimalString('DAO treasury USDC holdings.'),
          treasury_vault_address: { ...solanaAddress, description: 'DAO treasury vault address.' },
          startDate: { type: 'string', format: 'date', description: 'First spot-trade day (YYYY-MM-DD).' },
        },
      },

      // ------------------------------------------------------- CoinMarketCap
      CoinMarketCapSummaryPair: {
        type: 'object',
        description: 'One pair in `/cmc/summary`. Prices and volumes are JSON numbers in human units.',
        required: ['trading_pairs', 'base_currency', 'quote_currency', 'type', 'last_price', 'lowest_ask', 'highest_bid', 'base_volume', 'quote_volume'],
        properties: {
          trading_pairs: { type: 'string', description: '`{baseMint}_{quoteMint}`.' },
          base_currency: { ...solanaAddress, description: 'Base token mint.' },
          quote_currency: { ...solanaAddress, description: 'Quote token mint.' },
          type: { type: 'string', const: 'spot' },
          last_price: { type: 'number' },
          lowest_ask: { type: 'number' },
          highest_bid: { type: 'number' },
          base_volume: { type: 'number', description: 'Rolling 24h volume in the base token.' },
          quote_volume: { type: 'number', description: 'Rolling 24h volume in the quote token.' },
          highest_price_24h: { type: 'number', description: 'Omitted when there were no trades in 24h.' },
          lowest_price_24h: { type: 'number', description: 'Omitted when there were no trades in 24h.' },
          price_change_percent_24h: { type: 'number', description: 'Percent change vs the price 24h ago. Omitted for markets younger than 24h, or when the history source is unavailable.' },
        },
      },
      CoinMarketCapTicker: {
        type: 'object',
        description: 'One entry in `/cmc/ticker`.',
        required: ['base_id', 'quote_id', 'base_name', 'base_symbol', 'quote_name', 'quote_symbol', 'last_price', 'base_volume', 'quote_volume', 'isFrozen'],
        properties: {
          base_id: { ...solanaAddress, description: 'Base token mint (same key as `/cmc/assets`).' },
          quote_id: { ...solanaAddress, description: 'Quote token mint.' },
          base_name: { type: 'string', description: 'Falls back to the first 8 characters of the mint.' },
          base_symbol: { type: 'string' },
          quote_name: { type: 'string' },
          quote_symbol: { type: 'string' },
          last_price: { type: 'number' },
          base_volume: { type: 'number' },
          quote_volume: { type: 'number' },
          isFrozen: { type: 'integer', enum: [0, 1], description: 'Always 0 for an on-chain AMM.' },
        },
      },
      CoinMarketCapTickerResponse: {
        type: 'object',
        description: 'Object keyed by `{baseMint}_{quoteMint}`.',
        additionalProperties: ref('CoinMarketCapTicker'),
      },
      CoinMarketCapAsset: {
        type: 'object',
        required: ['name', 'symbol', 'contractAddress', 'can_withdraw', 'can_deposit', 'maker_fee', 'taker_fee'],
        properties: {
          name: { type: 'string', description: 'Falls back to the first 8 characters of the mint.' },
          symbol: { type: 'string' },
          contractAddress: { ...solanaAddress, description: 'Token mint.' },
          can_withdraw: { type: 'string', enum: ['true', 'false'] },
          can_deposit: { type: 'string', enum: ['true', 'false'] },
          maker_fee: { type: 'number', description: 'Protocol fee rate as a fraction (e.g. 0.005).' },
          taker_fee: { type: 'number', description: 'Protocol fee rate as a fraction (e.g. 0.005).' },
        },
      },
      CoinMarketCapAssetsResponse: {
        type: 'object',
        description: 'Object keyed by mint address.',
        additionalProperties: ref('CoinMarketCapAsset'),
      },

      // --------------------------------------------------------- DexScreener
      DexScreenerBlock: {
        type: 'object',
        required: ['blockNumber', 'blockTimestamp'],
        properties: {
          blockNumber: { type: 'integer', description: 'Solana slot.' },
          blockTimestamp: { type: 'integer', description: 'Unix seconds.' },
        },
      },
      DexScreenerLatestBlockResponse: {
        type: 'object',
        required: ['block'],
        properties: { block: ref('DexScreenerBlock') },
      },
      DexScreenerAsset: {
        type: 'object',
        required: ['id', 'name', 'symbol', 'totalSupply', 'circulatingSupply', 'metadata'],
        properties: {
          id: { ...solanaAddress, description: 'Token mint.' },
          name: { type: 'string', description: 'Falls back to the first 8 characters of the mint.' },
          symbol: { type: 'string', description: 'Falls back to the first 8 characters of the mint.' },
          totalSupply: { type: 'number', description: 'Human units.' },
          circulatingSupply: { type: 'number', description: 'Human units.' },
          metadata: {
            type: 'object',
            required: ['decimals'],
            properties: { decimals: { type: 'string', description: 'Mint decimals as a string.' } },
            additionalProperties: { type: 'string' },
          },
        },
      },
      DexScreenerAssetResponse: {
        type: 'object',
        required: ['asset'],
        properties: { asset: ref('DexScreenerAsset') },
      },
      DexScreenerPair: {
        type: 'object',
        required: ['id', 'dexKey', 'asset0Id', 'asset1Id', 'feeBps', 'createdAtBlockNumber', 'createdAtBlockTimestamp', 'createdAtTxnId'],
        properties: {
          id: { ...solanaAddress, description: 'DAO address.' },
          dexKey: { type: 'string', const: 'futarchyAMM' },
          asset0Id: { ...solanaAddress, description: 'Base token mint.' },
          asset1Id: { ...solanaAddress, description: 'Quote token mint.' },
          feeBps: { type: 'integer', description: 'Protocol fee in basis points (e.g. 50).' },
          createdAtBlockNumber: { type: 'integer', description: 'Slot of the first spot swap.' },
          createdAtBlockTimestamp: { type: 'integer', description: 'Unix seconds.' },
          createdAtTxnId: { type: 'string', description: 'Signature of the first spot swap.' },
        },
      },
      DexScreenerPairResponse: {
        type: 'object',
        required: ['pair'],
        properties: { pair: ref('DexScreenerPair') },
      },
      DexScreenerSwapEvent: {
        type: 'object',
        description: 'A swap. asset0 is the base token, asset1 the quote token. Buys carry `asset1In` + `asset0Out`; sells carry `asset0In` + `asset1Out`. Amounts are JSON numbers in human units.',
        required: ['block', 'eventType', 'txnId', 'txnIndex', 'eventIndex', 'maker', 'pairId', 'priceNative'],
        properties: {
          block: ref('DexScreenerBlock'),
          eventType: { type: 'string', const: 'swap' },
          txnId: { type: 'string', description: 'Transaction signature.' },
          txnIndex: { type: 'integer', description: 'Index of the transaction among this API\'s events in the slot.' },
          eventIndex: { type: 'integer', description: 'Index of the event within the transaction.' },
          maker: { ...solanaAddress, description: 'Trader wallet.' },
          pairId: { ...solanaAddress, description: 'DAO address (pair id).' },
          asset0In: { type: 'number' },
          asset1In: { type: 'number' },
          asset0Out: { type: 'number' },
          asset1Out: { type: 'number' },
          priceNative: { type: 'number', description: 'Quote per base.' },
          reserves: {
            type: 'object',
            description: 'Post-swap pool reserves (human units). Omitted if unknown.',
            required: ['asset0', 'asset1'],
            properties: {
              asset0: { type: 'number' },
              asset1: { type: 'number' },
            },
          },
        },
      },
      DexScreenerEventsResponse: {
        type: 'object',
        required: ['events'],
        properties: { events: { type: 'array', items: ref('DexScreenerSwapEvent') } },
      },

      // -------------------------------------------------------------- Supply
      SupplyAllocation: {
        type: 'object',
        description: 'Non-circulating / liquidity breakdown. Amounts are decimal strings in human units; configured excluded holders include zero balances.',
        properties: {
          teamPerformancePackage: {
            type: 'object',
            required: ['amount'],
            properties: { amount: { type: 'string' }, address: solanaAddress },
          },
          futarchyAmmLiquidity: {
            type: 'object',
            required: ['amount'],
            properties: { amount: { type: 'string' }, vaultAddress: solanaAddress },
          },
          meteoraLpLiquidity: {
            type: 'object',
            required: ['amount'],
            properties: { amount: { type: 'string' }, poolAddress: solanaAddress, vaultAddress: solanaAddress },
          },
          additionalTokenAllocation: ref('AdditionalTokenAllocation'),
          initialTokenAllocation: ref('InitialTokenAllocation'),
          daoTreasuryTokens: ref('DaoTreasuryTokens'),
          excludedHolders: { type: 'array', items: ref('ExcludedHolderBalance') },
          balanceSnapshotSlot: { type: 'integer', description: 'Confirmed slot shared by live balance, mint supply and claim-state reads.' },
          daoAddress: solanaAddress,
          launchAddress: solanaAddress,
          version: { type: 'string', examples: ['v0.6', 'v0.7'] },
        },
      },
      AdditionalTokenAllocation: {
        type: 'object',
        description: 'v0.7+ additional token recipient allocation.',
        required: ['amount', 'recipient', 'claimed'],
        properties: {
          amount: { type: 'string' },
          recipient: solanaAddress,
          claimed: { type: 'boolean' },
          tokenAccountAddress: solanaAddress,
        },
      },
      ExcludedHolderBalance: {
        type: 'object',
        required: ['amount', 'address'],
        properties: {
          amount: decimalString('Non-circulating balance in human units.'),
          address: solanaAddress,
          label: { type: 'string' },
        },
      },
      InitialTokenAllocation: {
        type: 'object',
        description: 'Claimed initial allocation that IS circulating (special cases).',
        required: ['amount', 'claimed'],
        properties: { amount: { type: 'string' }, claimed: { type: 'boolean' } },
      },
      DaoTreasuryTokens: {
        type: 'object',
        description: 'Base tokens held in the DAO treasury vault (not circulating).',
        required: ['amount'],
        properties: { amount: { type: 'string' }, vaultAddress: solanaAddress },
      },
      TokenSupplyInfo: {
        type: 'object',
        required: ['mint', 'totalSupply', 'circulatingSupply', 'decimals', 'rawTotalSupply'],
        properties: {
          mint: solanaAddress,
          totalSupply: decimalString('Total supply.'),
          circulatingSupply: decimalString('Circulating supply.'),
          decimals: { type: 'integer' },
          rawTotalSupply: { type: 'string', description: 'Total supply in base units (integer string).' },
          allocation: ref('SupplyAllocation'),
        },
      },
      SupplyResponse: {
        type: 'object',
        required: ['result', 'data'],
        properties: {
          result: decimalString('TOTAL supply (same as data.totalSupply).'),
          data: ref('TokenSupplyInfo'),
        },
      },
      SupplyResult: {
        type: 'object',
        required: ['result'],
        properties: { result: decimalString('Supply.') },
      },
      CirculatingSupplyResponse: {
        type: 'object',
        required: ['result'],
        properties: {
          result: decimalString('Circulating supply.'),
          allocation: {
            type: 'object',
            description: 'Present when launchpad allocations or configured excluded holders supply allocation details.',
            properties: {
              teamPerformancePackageAddress: solanaAddress,
              futarchyAmmVaultAddress: solanaAddress,
              meteoraPoolAddress: solanaAddress,
              meteoraVaultAddress: solanaAddress,
              additionalTokenAllocation: ref('AdditionalTokenAllocation'),
              initialTokenAllocation: ref('InitialTokenAllocation'),
              daoTreasuryTokens: ref('DaoTreasuryTokens'),
              excludedHolders: { type: 'array', items: ref('ExcludedHolderBalance') },
              balanceSnapshotSlot: { type: 'integer', description: 'Confirmed slot shared by live balance, mint supply and claim-state reads.' },
              daoAddress: solanaAddress,
              launchAddress: solanaAddress,
              version: { type: 'string', examples: ['v0.6', 'v0.7'] },
            },
          },
        },
      },
      JupiterCirculatingSupply: {
        type: 'object',
        required: ['circulatingSupply'],
        properties: { circulatingSupply: { type: 'number', description: 'Human units.' } },
      },
      JupiterTotalSupply: {
        type: 'object',
        required: ['totalSupply'],
        properties: { totalSupply: { type: 'number', description: 'Human units.' } },
      },

      // ------------------------------------------------------------ Launches
      LiveLaunch: {
        type: 'object',
        description: 'A launch currently accepting commitments. Amounts are in the quote mint (usually USDC).',
        required: ['launchAddress', 'version', 'tokenAddress', 'quoteMint', 'quoteDecimals', 'committerCount', 'totalCommitted', 'totalCommittedRaw', 'minimumRaise', 'minimumRaiseRaw', 'closeTime', 'tokenName', 'tokenSymbol'],
        properties: {
          launchAddress: solanaAddress,
          version: { type: 'string', enum: ['v0.6', 'v0.7', 'v0.8'] },
          tokenAddress: { ...solanaAddress, description: 'Mint of the token being launched.' },
          quoteMint: solanaAddress,
          quoteDecimals: { type: 'integer' },
          committerCount: { type: 'integer', description: 'Funders with a non-zero commitment.' },
          totalCommitted: decimalString('Total committed.'),
          totalCommittedRaw: { type: 'string', description: 'Total committed in base units (integer string).' },
          minimumRaise: decimalString('Minimum raise.'),
          minimumRaiseRaw: { type: 'string', description: 'Minimum raise in base units (integer string).' },
          closeTime: { type: 'integer', description: 'Unix seconds when the launch closes.' },
          tokenName: { type: ['string', 'null'], description: 'Metaplex name; null if metadata is missing.' },
          tokenSymbol: { type: ['string', 'null'], description: 'Metaplex symbol; null if metadata is missing.' },
        },
      },
      LiveLaunchesResponse: {
        type: 'object',
        required: ['count', 'updatedAt', 'launches'],
        properties: {
          count: { type: 'integer' },
          updatedAt: { type: 'string', format: 'date-time', description: 'When the cached snapshot was taken.' },
          launches: { type: 'array', items: ref('LiveLaunch') },
        },
      },

      // --------------------------------------------------------- Market data
      FutarchyAmmDailyActivity: {
        type: 'object',
        description: 'One token-day of FutarchyAMM activity: spot, conditional (null when absent) and totals. Volumes are USD / human token units as decimal strings.',
        required: Object.keys(futarchyActivityRowProperties),
        properties: futarchyActivityRowProperties,
      },
      MeteoraDailyVolume: {
        type: 'object',
        description: 'One token-day of Meteora activity. Decimal strings in human units.',
        required: ['token', 'date', 'base_volume', 'target_volume', 'buy_volume', 'sell_volume', 'trade_count', 'average_price', 'usdc_fees', 'token_fees', 'token_fees_usdc', 'token_per_usdc'],
        properties: {
          token: { ...solanaAddress, description: 'Base token mint.' },
          date: { type: 'string', format: 'date' },
          base_volume: decimalString('Volume in the base token.'),
          target_volume: decimalString('Volume in USDC.'),
          buy_volume: decimalString('Buy-side volume.'),
          sell_volume: decimalString('Sell-side volume.'),
          trade_count: { type: 'integer' },
          average_price: decimalString('Average price (USDC per token).'),
          usdc_fees: decimalString('Fees in USDC.'),
          token_fees: decimalString('Fees in the base token.'),
          token_fees_usdc: decimalString('Base-token fees valued in USDC.'),
          token_per_usdc: { type: ['string', 'null'], description: 'base_volume / target_volume; null when target_volume is 0.' },
        },
      },
      MarketDataResponse: {
        type: 'object',
        required: ['filters', 'source', 'futarchyAMM', 'meteora'],
        properties: {
          filters: {
            type: 'object',
            required: ['tokens', 'startDate', 'endDate'],
            properties: {
              tokens: {
                description: 'The requested token list, or the string "all" when no filter was given.',
                oneOf: [{ type: 'string', const: 'all' }, { type: 'array', items: { type: 'string' } }],
              },
              startDate: { type: 'string', format: 'date' },
              endDate: { type: 'string', format: 'date' },
            },
          },
          source: { type: 'string', const: 'user-pool-etl' },
          futarchyAMM: {
            type: 'object',
            required: ['source', 'count', 'data'],
            properties: {
              source: { type: 'string', const: 'etl-user-pool-daily' },
              count: { type: 'integer' },
              data: { type: 'array', items: ref('FutarchyAmmDailyActivity') },
            },
          },
          meteora: {
            type: 'object',
            required: ['source', 'count', 'data'],
            properties: {
              source: { type: 'string', const: 'etl-meteora-daily' },
              count: { type: 'integer' },
              data: { type: 'array', items: ref('MeteoraDailyVolume') },
            },
          },
        },
      },

      // -------------------------------------------------------------- Health
      BasicHealth: {
        type: 'object',
        required: ['status', 'timestamp', 'uptime'],
        properties: {
          status: { type: 'string', const: 'healthy' },
          timestamp: { type: 'string', format: 'date-time' },
          uptime: { type: 'number', description: 'Process uptime in seconds.' },
        },
      },
      DetailedHealth: {
        type: 'object',
        required: ['status', 'timestamp', 'uptime', 'servedDatabase'],
        properties: {
          status: { type: 'string', enum: ['healthy', 'degraded'] },
          message: { type: 'string', description: 'Reason, present when degraded.' },
          timestamp: { type: 'string', format: 'date-time' },
          uptime: { type: 'number', description: 'Process uptime in seconds.' },
          servedDatabase: {
            type: 'object',
            required: ['connected', 'servedDataContract', 'freshness'],
            properties: {
              connected: { type: 'boolean' },
              servedDataContract: {
                type: 'object',
                required: ['ok', 'checkedAt', 'missing'],
                properties: {
                  ok: { type: 'boolean' },
                  checkedAt: { type: 'string', format: 'date-time' },
                  missing: { type: 'array', items: { type: 'string' }, description: 'Missing tables/columns, or ["connection"].' },
                },
              },
              freshness: {
                description: 'Newest served swap; null when disconnected or the check failed.',
                oneOf: [
                  {
                    type: 'object',
                    required: ['latestSwapAt', 'ageSeconds'],
                    properties: {
                      latestSwapAt: { type: ['string', 'null'], format: 'date-time' },
                      ageSeconds: { type: ['number', 'null'] },
                    },
                  },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      },
      ProbeStatus: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['ok', 'starting', 'draining', 'unavailable'] },
          message: { type: 'string' },
        },
      },

      // ---------------------------------------------------------------- Meta
      ApiIndex: {
        type: 'object',
        description: 'Informational endpoint index.',
        required: ['name', 'version', 'endpoints'],
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          documentation: { type: 'string' },
          endpoints: { type: 'object', additionalProperties: { type: 'string' } },
          dexscreener: { type: 'object', additionalProperties: { type: 'string' } },
          coinmarketcap: { type: 'object', additionalProperties: { type: 'string' } },
          dex: {
            type: 'object',
            properties: {
              fork_type: { type: 'string' },
              factory_address: { type: 'string' },
              router_address: { type: 'string' },
            },
          },
          supplyBreakdown: { type: 'object', additionalProperties: { type: 'string' } },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;
