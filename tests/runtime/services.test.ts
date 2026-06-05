import { describe, expect, it } from 'bun:test';
import { config } from '../../src/config.js';
import { createServices } from '../../src/runtime/services.js';

describe('runtime service composition', () => {
  it('creates API services without indexing workers', () => {
    const services = createServices('api');

    expect(services.databaseService).toBeTruthy();
    expect(services.externalDatabaseService).toBeTruthy();
    expect(services.duneService).toBeNull();
    expect(services.duneCacheService).toBeNull();
    expect(services.hourlyAggregationService).toBeNull();
    expect(services.tenMinuteVolumeFetcherService).toBeNull();
    expect(services.dailyAggregationService).toBeNull();
    expect(services.v06ReconciliationService).toBeNull();
  });

  it('creates indexer services for collection and reconciliation', () => {
    const services = createServices('indexer');

    expect(services.v06ReconciliationService).toBeTruthy();

    if (config.dune.apiKey) {
      expect(services.duneService).toBeTruthy();
      expect(services.tenMinuteVolumeFetcherService).toBeTruthy();
      expect(services.hourlyAggregationService).toBeTruthy();
      expect(services.dailyAggregationService).toBeTruthy();
    } else {
      expect(services.duneService).toBeNull();
      expect(services.tenMinuteVolumeFetcherService).toBeNull();
    }
  });
});

