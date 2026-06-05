import { describe, expect, it } from 'bun:test';
import { createServices } from '../../src/runtime/services.js';

describe('runtime service composition', () => {
  it('creates API services without indexing workers', () => {
    const services = createServices('api');

    expect(services.databaseService).toBeTruthy();
    expect(services.externalDatabaseService).toBeTruthy();
    expect(services.v06ReconciliationService).toBeNull();
  });

  it('creates indexer services for reconciliation', () => {
    const services = createServices('indexer');

    expect(services.v06ReconciliationService).toBeTruthy();
  });
});
