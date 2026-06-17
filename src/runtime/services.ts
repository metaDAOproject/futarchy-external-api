import type { Services } from '../app.js';
import { ExternalDatabaseService } from '../services/externalDatabaseService.js';
import { FutarchyService } from '../services/futarchyService.js';
import { LaunchpadService } from '../services/launchpadService.js';
import { PriceService } from '../services/priceService.js';
import { SolanaService } from '../services/solanaService.js';
import { logger } from '../utils/logger.js';

export function createServices(): Services {
  const futarchyService = new FutarchyService();
  const priceService = new PriceService();
  const externalDatabaseService = new ExternalDatabaseService();
  const solanaService = new SolanaService();
  const launchpadService = new LaunchpadService();

  return {
    futarchyService,
    priceService,
    externalDatabaseService,
    solanaService,
    launchpadService,
  };
}

export async function initializeRuntimeDataStores(
  services: Services,
  runtimeName: string
): Promise<void> {
  if (services.externalDatabaseService) {
    const extConnected = await services.externalDatabaseService.initialize();
    if (extConnected) {
      logger.info(`${runtimeName} served (external) indexer database initialized and connected`);
    } else {
      logger.warn(`${runtimeName} served (external) indexer database not available — market data routes will return 503`);
    }
  }
}

export async function closeDataStores(services: Services): Promise<void> {
  await services.externalDatabaseService?.close();
}
