import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';
import { config } from '../../src/config.js';

const app = createTestApp();

describe('Metrics Routes', () => {
  describe('GET /metrics', () => {
    it('should return Prometheus metrics', async () => {
      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('should include standard metrics', async () => {
      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      // Prometheus format includes HELP and TYPE comments
      expect(response.text).toContain('# HELP');
      expect(response.text).toContain('# TYPE');
    });

    it('labels unmatched paths as one series, so path scans cannot grow metrics without bound', async () => {
      await request(app).get('/wp-admin/scan-xyz-123');
      const response = await request(app).get('/metrics');

      expect(response.text).toContain('path="unmatched"');
      expect(response.text).not.toContain('scan-xyz');
    });

    it('labels matched requests by route pattern, never by the requested URL', async () => {
      await request(app).get('/api/supply/aaa111/total'); // matches :mintAddress, then 400s
      const response = await request(app).get('/metrics');

      expect(response.text).toContain('path="/api/supply/:mintAddress/total"');
      expect(response.text).not.toContain('aaa111');
    });

    it('keeps the API version in the label, so /v1 and unversioned traffic stay distinguishable', async () => {
      await request(app).get('/v1/api/supply/ccc333/total');
      const response = await request(app).get('/metrics');

      expect(response.text).toContain('path="/v1/api/supply/:mintAddress/total"');
      expect(response.text).not.toContain('ccc333');
    });

    it('should expose the served DB connectivity gauge', async () => {
      const response = await request(app).get('/metrics');

      expect(response.text).toContain('futarchy_served_db_connected 1');
    });
  });

  describe('METRICS_TOKEN', () => {
    it('requires the bearer token when set', async () => {
      config.metrics.token = 'scrape-secret';
      try {
        const missing = await request(app).get('/metrics');
        const wrong = await request(app).get('/metrics').set('Authorization', 'Bearer nope');
        const right = await request(app).get('/metrics').set('Authorization', 'Bearer scrape-secret');

        expect(missing.status).toBe(401);
        expect(missing.headers['www-authenticate']).toBe('Bearer');
        expect(wrong.status).toBe(401);
        expect(right.status).toBe(200);
        // The scheme name is case-insensitive; the token is not.
        expect((await request(app).get('/metrics').set('Authorization', 'bearer scrape-secret')).status).toBe(200);
        expect((await request(app).get('/metrics').set('Authorization', 'Bearer SCRAPE-SECRET')).status).toBe(401);
      } finally {
        config.metrics.token = '';
      }
    });
  });
});
