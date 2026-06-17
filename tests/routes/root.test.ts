import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';

const app = createTestApp();

describe('Root Routes', () => {
  describe('GET /', () => {
    it('should return 200', async () => {
      const response = await request(app).get('/');
      expect(response.status).toBe(200);
    });

    it('should return API name and version', async () => {
      const response = await request(app).get('/');
      
      expect(response.body).toHaveProperty('name');
      expect(response.body).toHaveProperty('version');
      expect(response.body.name).toBe('Futarchy AMM - CoinGecko API');
      expect(response.body.version).toBe('2.0.0');
    });

    it('should list available endpoints', async () => {
      const response = await request(app).get('/');
      
      expect(response.body).toHaveProperty('endpoints');
      expect(response.body.endpoints).toHaveProperty('tickers');
      expect(response.body.endpoints).toHaveProperty('supply');
      expect(response.body.endpoints).toHaveProperty('health');
    });

    it('should include DEX configuration', async () => {
      const response = await request(app).get('/');
      
      expect(response.body).toHaveProperty('dex');
      expect(response.body.dex).toHaveProperty('fork_type');
      expect(response.body.dex).toHaveProperty('factory_address');
      expect(response.body.dex).toHaveProperty('router_address');
    });

    it('should include supply breakdown documentation', async () => {
      const response = await request(app).get('/');
      
      expect(response.body).toHaveProperty('supplyBreakdown');
      expect(response.body.supplyBreakdown).toHaveProperty('description');
      expect(response.body.supplyBreakdown).toHaveProperty('circulatingSupply');
    });

    it('describes itself as a read-only, Dune-free API', async () => {
      const response = await request(app).get('/');

      // The stale cache block was removed; root now carries a `note` and no caching fields.
      expect(response.body).toHaveProperty('note');
      expect(response.body.note).toContain('no Dune');
      expect(response.body).not.toHaveProperty('caching');
    });
  });
});
