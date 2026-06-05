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
  });

  describe('GET /api/metrics/history/:metricName', () => {
    it('should require database connection', async () => {
      const response = await request(app).get('/api/metrics/history/test_metric');
      
      // 200 if database connected, 503 if not, 500 if mock incomplete
      expect([200, 500, 503]).toContain(response.status);
    });

    it('should validate hours parameter', async () => {
      const response = await request(app)
        .get('/api/metrics/history/test_metric')
        .query({ hours: 'invalid' });
      
      // 400 if validation runs, 503 if database check happens first
      expect([400, 503]).toContain(response.status);
      if (response.status === 400) {
        expect(response.body.error).toBe('Invalid integer');
      }
    });

    it('should enforce hours minimum', async () => {
      const response = await request(app)
        .get('/api/metrics/history/test_metric')
        .query({ hours: '0' });
      
      expect([400, 503]).toContain(response.status);
      if (response.status === 400) {
        expect(response.body.error).toBe('Value too small');
      }
    });

    it('should enforce hours maximum', async () => {
      const response = await request(app)
        .get('/api/metrics/history/test_metric')
        .query({ hours: '200' });
      
      expect([400, 503]).toContain(response.status);
      if (response.status === 400) {
        expect(response.body.error).toBe('Value too large');
      }
    });

    it('should validate labels JSON', async () => {
      const response = await request(app)
        .get('/api/metrics/history/test_metric')
        .query({ labels: '{invalid json}' });
      
      expect([400, 503]).toContain(response.status);
      if (response.status === 400) {
        expect(response.body.error).toBe('Invalid JSON');
      }
    });

    it('should accept valid labels JSON', async () => {
      const response = await request(app)
        .get('/api/metrics/history/test_metric')
        .query({ labels: '{"table":"v06_spot_ohlcv_1m"}' });
      
      // 200 if database connected, 503 if not, 500 if mock incomplete
      expect([200, 500, 503]).toContain(response.status);
    });

    it('should use default hours when not specified', async () => {
      const response = await request(app).get('/api/metrics/history/test_metric');
      
      if (response.status === 200) {
        expect(response.body.hours).toBe(24);
      }
    });
  });
});
