import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';

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

    it('should expose the served DB connectivity gauge', async () => {
      const response = await request(app).get('/metrics');

      expect(response.text).toContain('futarchy_served_db_connected 1');
    });
  });
});
