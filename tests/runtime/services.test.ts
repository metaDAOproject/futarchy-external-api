import { describe, expect, it } from 'bun:test';
import { createServices } from '../../src/runtime/services.js';

describe('runtime service composition', () => {
  it('creates API services without an app DB or indexing workers', () => {
    const services = createServices();

    expect(services.externalDatabaseService).toBeTruthy();
    expect(services.futarchyService).toBeTruthy();
    expect(services.solanaService).toBeTruthy();
    expect(services.launchpadService).toBeTruthy();
    expect('databaseService' in services).toBe(false);
  });
});
