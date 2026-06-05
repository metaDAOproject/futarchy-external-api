import type { FutarchyService } from '../services/futarchyService.js';
import type { PriceService } from '../services/priceService.js';
import type { SolanaService } from '../services/solanaService.js';
import type { LaunchpadService } from '../services/launchpadService.js';
import type { DatabaseService } from '../services/databaseService.js';
import type { ExternalDatabaseService } from '../services/externalDatabaseService.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Service registry for all application services.
 *
 * Three conventions are used:
 * - `foo: T`        → always available, getter returns `T`
 * - `foo: T | null` → optional capability, getter returns `T | null`
 * - `foo?: T`       → conditionally wired, getter throws `AppError(503)` if missing
 */
export interface Services {
  futarchyService: FutarchyService;
  priceService: PriceService;
  databaseService: DatabaseService;

  externalDatabaseService: ExternalDatabaseService | null;

  solanaService?: SolanaService;
  launchpadService?: LaunchpadService;
}

/**
 * Service getters passed to route handlers.
 * This allows routes to access services without direct imports,
 * enabling lazy initialization and easier testing.
 */
export interface ServiceGetters {
  getFutarchyService: () => FutarchyService;
  getPriceService: () => PriceService;
  getSolanaService: () => SolanaService;
  getLaunchpadService: () => LaunchpadService;
  getDatabaseService: () => DatabaseService;
  getExternalDatabaseService: () => ExternalDatabaseService | null;
}

function requireService<T>(service: T | undefined, name: string): T {
  if (!service) throw new AppError(`${name} service not available`, 503);
  return service;
}

function optionalService<T>(service: T | null | undefined): T | null {
  return service ?? null;
}

export function createServiceGetters(services: Services): ServiceGetters {
  return {
    getFutarchyService: () => services.futarchyService,
    getPriceService: () => services.priceService,
    getDatabaseService: () => services.databaseService,

    getExternalDatabaseService: () => optionalService(services.externalDatabaseService),

    getSolanaService: () => requireService(services.solanaService, 'Solana'),
    getLaunchpadService: () => requireService(services.launchpadService, 'Launchpad'),
  };
}
