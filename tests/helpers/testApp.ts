import BN from 'bn.js';
import { createApp, type Services } from '../../src/app.js';
import type { FutarchyService } from '../../src/services/futarchyService.js';
import type { PriceService } from '../../src/services/priceService.js';
import type { DatabaseService } from '../../src/services/databaseService.js';
import type { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';
import type { SolanaService } from '../../src/services/solanaService.js';
import type { LaunchpadService } from '../../src/services/launchpadService.js';

export function createMockDatabaseService(): DatabaseService {
  return {
    isAvailable: () => true,
    getServiceHealthHistory: async () => [],
    getRecentMetrics: async () => [],
    insertServiceHealthSnapshot: async () => {},
    insertMetricsBatch: async () => {},
    pruneOldMetrics: async () => {},
    close: async () => {},
  } as unknown as DatabaseService;
}

export function createMockExternalDatabaseService(): ExternalDatabaseService {
  return {
    isAvailable: () => true,
    getSpotRolling24hMetrics: async () => new Map(),
    getDailyMeteoraVolumes: async () => [],
    getFutarchyAmmDailyActivity: async () => [],
    getFirstTradeDates: async () => new Map(),
    close: async () => {},
  } as unknown as ExternalDatabaseService;
}

export function createMockFutarchyService(): FutarchyService {
  return {
    getAllDaos: async () => [],
  } as unknown as FutarchyService;
}

export function createMockPriceService(): PriceService {
  return {
    calculatePrice: () => '0.05',
    calculateSpread: () => ({ bid: '0.04975', ask: '0.05025' }),
    calculateLiquidityUSD: () => '100000.00',
  } as unknown as PriceService;
}

export function createMockSolanaService(): SolanaService {
  return {
    getTotalSupply: async () => '1000000',
    getSupplyInfo: async () => ({
      totalSupply: '1000000',
      circulatingSupply: '500000',
    }),
  } as unknown as SolanaService;
}

export function createMockLaunchpadService(): LaunchpadService {
  return {
    getTokenAllocationBreakdown: async () => ({
      version: 'v0.6',
      teamPerformancePackage: { amount: new BN(0) },
      futarchyAmmLiquidity: { amount: new BN(0) },
      meteoraLpLiquidity: { amount: new BN(0) },
      daoTreasuryTokens: { amount: new BN(0) },
      totalNonCirculating: new BN(0),
    }),
  } as unknown as LaunchpadService;
}

export function createTestServices(overrides?: Partial<Services>): Services {
  return {
    futarchyService: createMockFutarchyService(),
    priceService: createMockPriceService(),
    databaseService: createMockDatabaseService(),
    externalDatabaseService: createMockExternalDatabaseService(),
    solanaService: createMockSolanaService(),
    launchpadService: createMockLaunchpadService(),
    ...overrides,
  };
}

export function createTestApp(overrides?: Partial<Services>) {
  return createApp({ services: createTestServices(overrides) });
}
