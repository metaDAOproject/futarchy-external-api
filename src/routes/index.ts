import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHealthRouter } from './health.js';
import { createMetricsRouter } from './metrics.js';
import { createCoinGeckoRouter } from './coingecko.js';
import { createCoinMarketCapRouter } from './coinmarketcap.js';

import { createSupplyRouter } from './supply.js';
import { createMarketRouter } from './market.js';
import { createLaunchesRouter } from './launches.js';

import { createDexScreenerRouter } from './dexscreener.js';
import { createRootRouter } from './root.js';
import { createDocsRouter } from './docs.js';
import type { ServiceGetters } from './types.js';

export type { ServiceGetters } from './types.js';

export interface ApiDeprecation {
  /** When the version was deprecated (RFC 9745 `Deprecation` header). */
  since: Date;
  /** When it stops being served (RFC 8594 `Sunset` header). */
  sunset?: Date;
  /** Prefix of the replacement version, e.g. '/v2' (`Link: rel="successor-version"`). */
  successor: string;
}

export interface ApiVersion {
  prefix: string;
  createRoutes: (services: ServiceGetters) => Router;
  deprecation?: ApiDeprecation;
}

/** The v1 API contract: every partner-facing data route. */
function createV1Routes(services: ServiceGetters): Router {
  const router = Router();
  router.use(createCoinGeckoRouter(services));
  router.use(createCoinMarketCapRouter(services));
  router.use(createSupplyRouter(services));
  router.use(createMarketRouter(services));
  router.use(createLaunchesRouter(services));
  router.use(createDexScreenerRouter(services));
  return router;
}

/**
 * Every served API version, mounted at its URL prefix (`/v1/api/tickers`, ...).
 *
 * - Ship a breaking change: add `{ prefix: '/v2', createRoutes: createV2Routes }`
 *   and leave v1 untouched.
 * - Deprecate a version: set `deprecation` on it. Every response under its
 *   prefix then carries `Deprecation`, `Sunset` and `Link: rel="successor-version"`
 *   headers so clients can discover the migration.
 * - Retire it: remove the entry after its sunset date.
 */
const API_VERSIONS: ApiVersion[] = [
  { prefix: '/v1', createRoutes: createV1Routes },
];

/**
 * The pre-versioning unversioned paths (`/api/tickers`, `/cmc/summary`, ...)
 * that existing partner integrations (CoinGecko, CMC, DexScreener, Jupiter)
 * are configured with. Frozen as an alias of v1; deprecate it here once
 * partners have moved to versioned URLs.
 */
export interface UnversionedAlias {
  /** Prefix of the API version the unversioned paths serve. */
  version: string;
  deprecation?: ApiDeprecation;
}

const UNVERSIONED_ALIAS: UnversionedAlias = { version: '/v1' };

const toHttpDate = (date: Date): string => date.toUTCString();

/**
 * Advertise a version's deprecation (RFC 9745 / RFC 8594). `prefix` is the
 * deprecated version's mount path ('' for the unversioned alias).
 */
export function deprecationHeaders(prefix: string, deprecation: ApiDeprecation) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Deprecation', `@${Math.floor(deprecation.since.getTime() / 1000)}`);
    if (deprecation.sunset) res.setHeader('Sunset', toHttpDate(deprecation.sunset));
    const successorUrl = deprecation.successor + req.originalUrl.slice(prefix.length);
    res.setHeader('Link', `<${successorUrl}>; rel="successor-version"`);
    // Let cross-origin browser clients read the migration headers too.
    const exposed = res.getHeader('Access-Control-Expose-Headers');
    res.setHeader(
      'Access-Control-Expose-Headers',
      [exposed, 'Deprecation, Sunset, Link'].filter(Boolean).join(', ')
    );
    next();
  };
}

/**
 * All versioned API routes plus the unversioned legacy alias. `versions` and
 * `alias` default to the served configuration above (overridable in tests).
 */
export function createApiRoutes(
  services: ServiceGetters,
  versions: ApiVersion[] = API_VERSIONS,
  alias: UnversionedAlias = UNVERSIONED_ALIAS,
): Router {
  const router = Router();
  const versionPrefixes = versions.map((v) => v.prefix);
  const mount = (prefix: string, routes: Router, deprecation?: ApiDeprecation) => {
    if (!deprecation) {
      router.use(prefix || '/', routes);
      return;
    }
    const headers = deprecationHeaders(prefix, deprecation);
    if (prefix) {
      router.use(prefix, headers, routes);
      return;
    }
    // The unversioned alias is mounted at '/', so unmatched requests under a
    // version prefix (e.g. a /v1 404) fall through to it; don't stamp them
    // with the alias's deprecation.
    router.use('/', (req: Request, res: Response, next: NextFunction) => {
      const underVersion = versionPrefixes.some((p) => req.path === p || req.path.startsWith(`${p}/`));
      if (underVersion) next();
      else headers(req, res, next);
    }, routes);
  };

  // Each version's router is built once; the unversioned alias mounts the same
  // instance, so the two paths share in-router state (e.g. DexScreener caches).
  const routersByPrefix = new Map<string, Router>();
  for (const version of versions) {
    const routes = version.createRoutes(services);
    routersByPrefix.set(version.prefix, routes);
    mount(version.prefix, routes, version.deprecation);
  }

  const aliased = routersByPrefix.get(alias.version);
  if (!aliased) throw new Error(`Unversioned alias targets unknown API version ${alias.version}`);
  mount('', aliased, alias.deprecation);

  return router;
}

/** Operational endpoints: health, metrics, docs, API index. Not versioned. */
export function createInfraRoutes(services: ServiceGetters): Router {
  const router = Router();
  router.use(createHealthRouter(services));
  router.use(createMetricsRouter(services));
  router.use(createDocsRouter());
  router.use(createRootRouter(services));
  return router;
}
