import type { FutarchyService } from '../services/futarchyService.js';
import type { PriceService } from '../services/priceService.js';
import type { DuneService } from '../services/duneService.js';
import type { DuneCacheService } from '../services/duneCacheService.js';
import type { SolanaService } from '../services/solanaService.js';
import type { LaunchpadService } from '../services/launchpadService.js';
import type { DatabaseService } from '../services/databaseService.js';
import type { HourlyAggregationService } from '../services/hourlyAggregationService.js';
import type { TenMinuteVolumeFetcherService } from '../services/tenMinuteVolumeFetcherService.js';
import type { DailyAggregationService } from '../services/dailyAggregationService.js';
import type { ExternalDatabaseService } from '../services/externalDatabaseService.js';
import type { V06ReconciliationService } from '../services/v06ReconciliationService.js';
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
  duneService: DuneService | null;
  duneCacheService: DuneCacheService | null;
  hourlyAggregationService: HourlyAggregationService | null;
  tenMinuteVolumeFetcherService: TenMinuteVolumeFetcherService | null;
  dailyAggregationService: DailyAggregationService | null;
  v06ReconciliationService: V06ReconciliationService | null;

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
  getDuneService: () => DuneService | null;
  getDuneCacheService: () => DuneCacheService | null;
  getSolanaService: () => SolanaService;
  getLaunchpadService: () => LaunchpadService;
  getDatabaseService: () => DatabaseService;
  getHourlyAggregationService: () => HourlyAggregationService | null;
  getTenMinuteVolumeFetcherService: () => TenMinuteVolumeFetcherService | null;
  getDailyAggregationService: () => DailyAggregationService | null;
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

    getDuneService: () => optionalService(services.duneService),
    getDuneCacheService: () => optionalService(services.duneCacheService),
    getHourlyAggregationService: () => optionalService(services.hourlyAggregationService),
    getTenMinuteVolumeFetcherService: () => optionalService(services.tenMinuteVolumeFetcherService),
    getDailyAggregationService: () => optionalService(services.dailyAggregationService),
    getExternalDatabaseService: () => optionalService(services.externalDatabaseService),

    getSolanaService: () => requireService(services.solanaService, 'Solana'),
    getLaunchpadService: () => requireService(services.launchpadService, 'Launchpad'),
  };
}
