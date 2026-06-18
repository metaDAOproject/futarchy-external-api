import { describe, it, expect, afterEach } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createTestServices } from './helpers/testApp.js';

const originalRestriction = {
  mode: config.server.restriction.mode,
  disabledPaths: [...config.server.restriction.disabledPaths],
  exemptCidrs: [...config.server.restriction.exemptCidrs],
};
const originalKeys = new Set(config.server.trustedApiKeys);
const originalTrustProxyHops = config.server.trustProxyHops;

afterEach(() => {
  config.server.restriction.mode = originalRestriction.mode;
  config.server.restriction.disabledPaths = [...originalRestriction.disabledPaths];
  config.server.restriction.exemptCidrs = [...originalRestriction.exemptCidrs];
  config.server.trustedApiKeys.clear();
  originalKeys.forEach(k => config.server.trustedApiKeys.add(k));
  config.server.trustProxyHops = originalTrustProxyHops;
});

describe('Emergency restriction controls', () => {
  it('blocks anonymous API traffic in restricted mode while preserving trusted consumers and health checks', async () => {
    // Given
    config.server.restriction.mode = 'restricted';
    config.server.trustedApiKeys.add('consumer-key');
    const app = createApp({ services: createTestServices() });

    // When
    const anonymous = await request(app).get('/api/tickers');
    const trusted = await request(app).get('/api/tickers').set('X-API-Key', 'consumer-key');
    const health = await request(app).get('/health');
    const readiness = await request(app).get('/api/health');

    // Then
    expect(anonymous.status).toBe(503);
    expect(anonymous.body.code).toBe('SERVICE_RESTRICTED');
    expect(anonymous.headers['retry-after']).toBeTruthy();
    expect(trusted.status).toBe(200);
    expect(health.status).toBe(200);
    expect(readiness.status).toBe(200);
  });

  it('keeps metrics reachable during restricted mode for incident verification', async () => {
    // Given
    config.server.restriction.mode = 'restricted';
    const app = createApp({ services: createTestServices() });

    // When
    const response = await request(app).get('/metrics');

    // Then
    expect(response.status).toBe(200);
    expect(response.text).toContain('futarchy_restriction_mode');
  });

  it('blocks anonymous API traffic in lockdown mode while preserving trusted consumers', async () => {
    // Given
    config.server.restriction.mode = 'lockdown';
    config.server.trustedApiKeys.add('consumer-key');
    const app = createApp({ services: createTestServices() });

    // When
    const anonymous = await request(app).get('/api/tickers');
    const trusted = await request(app).get('/api/tickers').set('X-API-Key', 'consumer-key');
    const health = await request(app).get('/health');

    // Then
    expect(anonymous.status).toBe(503);
    expect(anonymous.body.code).toBe('SERVICE_RESTRICTED');
    expect(trusted.status).toBe(200);
    expect(health.status).toBe(200);
  });

  it('hard-disables configured path prefixes for every tier while leaving health reachable', async () => {
    // Given
    config.server.restriction.disabledPaths = ['/api/tickers'];
    config.server.trustedApiKeys.add('consumer-key');
    const app = createApp({ services: createTestServices() });

    // When
    const anonymous = await request(app).get('/api/tickers');
    const trusted = await request(app).get('/api/tickers').set('X-API-Key', 'consumer-key');
    const health = await request(app).get('/health');
    const otherEndpoint = await request(app).get('/api/market-data');

    // Then
    expect(anonymous.status).toBe(503);
    expect(trusted.status).toBe(503);
    expect(health.status).toBe(200);
    expect(otherEndpoint.status).toBe(400);
  });

  it('allows an exempt CIDR through restricted mode', async () => {
    // Given
    config.server.trustProxyHops = 1;
    config.server.restriction.mode = 'restricted';
    config.server.restriction.exemptCidrs = ['203.0.113.0/24'];
    const app = createApp({ services: createTestServices() });

    // When
    const response = await request(app)
      .get('/api/tickers')
      .set('X-Forwarded-For', '203.0.113.9');

    // Then
    expect(response.status).toBe(200);
  });
});
