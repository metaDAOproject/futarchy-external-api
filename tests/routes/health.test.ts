import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';

const app = createTestApp();

describe('Health Routes', () => {
  describe('GET /health', () => {
    it('should return 200 with healthy status', async () => {
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
    });

    it('should include timestamp', async () => {
      const response = await request(app).get('/health');
      
      expect(response.body.timestamp).toBeDefined();
      expect(new Date(response.body.timestamp).getTime()).not.toBeNaN();
    });

    it('should include uptime', async () => {
      const response = await request(app).get('/health');
      
      expect(response.body.uptime).toBeDefined();
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('GET /api/health', () => {
    it('should return 200 with comprehensive health status', async () => {
      const response = await request(app).get('/api/health');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('services');
      expect(response.body).toHaveProperty('database');
    });

    it('should report database connection status', async () => {
      const response = await request(app).get('/api/health');
      
      expect(response.body.database).toHaveProperty('connected');
      expect(typeof response.body.database.connected).toBe('boolean');
    });

    it('should return services object', async () => {
      const response = await request(app).get('/api/health');
      
      expect(typeof response.body.services).toBe('object');
    });
  });

  describe('GET /api/health/history', () => {
    it('should return history or error', async () => {
      const response = await request(app).get('/api/health/history');
      
      // 200 if database connected, 503 if not
      expect([200, 503]).toContain(response.status);
    });

    it('should accept hours parameter', async () => {
      const response = await request(app).get('/api/health/history?hours=12');
      
      expect([200, 503]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body.hours).toBe(12);
      }
    });

    it('should accept service parameter', async () => {
      const response = await request(app).get('/api/health/history?service=external_database');
      
      expect([200, 503]).toContain(response.status);
      if (response.status === 200) {
        expect(response.body.service).toBe('external_database');
      }
    });
  });
});
