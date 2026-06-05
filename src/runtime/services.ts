import type { Services } from '../app.js';
import { config } from '../config.js';
import { DailyAggregationService } from '../services/dailyAggregationService.js';
import { DatabaseService } from '../services/databaseService.js';
import { DuneCacheService } from '../services/duneCacheService.js';
import { DuneService } from '../services/duneService.js';
import { ExternalDatabaseService } from '../services/externalDatabaseService.js';
import { FutarchyService } from '../services/futarchyService.js';
import { HourlyAggregationService } from '../services/hourlyAggregationService.js';
import { LaunchpadService } from '../services/launchpadService.js';
import { PriceService } from '../services/priceService.js';
import { SolanaService } from '../services/solanaService.js';
import { TenMinuteVolumeFetcherService } from '../services/tenMinuteVolumeFetcherService.js';
import { V06ReconciliationService } from '../services/v06ReconciliationService.js';
import { logger } from '../utils/logger.js';

export type RuntimeMode = 'api' | 'indexer';

export function createServices(mode: RuntimeMode): Services {
  const futarchyService = new FutarchyService();
  const priceService = new PriceService();
  const databaseService = new DatabaseService();
  const externalDatabaseService = new ExternalDatabaseService();
  const solanaService = new SolanaService();
  const launchpadService = new LaunchpadService();

  let duneService: DuneService | null = null;
  let duneCacheService: DuneCacheService | null = null;
  let hourlyAggregationService: HourlyAggregationService | null = null;
  let tenMinuteVolumeFetcherService: TenMinuteVolumeFetcherService | null = null;
  let dailyAggregationService: DailyAggregationService | null = null;
  let v06ReconciliationService: V06ReconciliationService | null = null;

  if (mode === 'indexer') {
    if (config.dune.apiKey) {
      duneService = new DuneService();
      duneCacheService = new DuneCacheService(duneService, databaseService, futarchyService);
      hourlyAggregationService = new HourlyAggregationService(databaseService, duneService, futarchyService);
      tenMinuteVolumeFetcherService = new TenMinuteVolumeFetcherService(duneService, databaseService, futarchyService);
      dailyAggregationService = new DailyAggregationService(duneService, databaseService, futarchyService);
    } else {
      logger.warn('DUNE_API_KEY not configured - Dune indexing services will not be created');
    }

    v06ReconciliationService = new V06ReconciliationService(databaseService, externalDatabaseService);
  }

  return {
    futarchyService,
    priceService,
    databaseService,
    externalDatabaseService,
    duneService,
    duneCacheService,
    solanaService,
    launchpadService,
    hourlyAggregationService,
    tenMinuteVolumeFetcherService,
    dailyAggregationService,
    v06ReconciliationService,
  };
}

export interface RuntimeDataStoreOptions {
  ensureAppSchema: boolean;
}

export async function initializeRuntimeDataStores(
  services: Services,
  runtimeName: string,
  options: RuntimeDataStoreOptions
): Promise<void> {
  const dbConnected = await services.databaseService.initialize({
    ensureSchema: options.ensureAppSchema,
  });
  if (dbConnected) {
    logger.info(`${runtimeName} app database initialized and connected`);
  } else {
    logger.warn(`${runtimeName} app database not available - historical volume routes may be degraded`);
  }

  if (services.externalDatabaseService) {
    const extConnected = await services.externalDatabaseService.initialize();
    if (extConnected) {
      logger.info(`${runtimeName} external indexer database initialized and connected`);
    } else {
      logger.warn(`${runtimeName} external indexer database not available`);
    }
  }
}

export async function closeDataStores(services: Services): Promise<void> {
  await services.externalDatabaseService?.close();
  await services.databaseService.close();
}
