import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';
import type { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';

const app = createTestApp();

// A served-DB stub seeded with one futarchy row (spot + conditional pivoted by
// getFutarchyAmmDailyActivity) and one meteora row, so the happy path asserts the
// actual user_pool ETL → /api/market-data contract, not just the HTTP envelope.
function seededExternalDb(): ExternalDatabaseService {
  return {
    isAvailable: () => true,
    getFutarchyAmmDailyActivity: async () => [
      {
        token: 'TOK', date: '2024-01-02', has_conditional_volume: true,
        spot_target_volume: '1000', spot_usdc_fees: '5',
        spot_protocol_fee_usd: '4', spot_lp_fee_usd: '1',
        conditional_target_volume: '200', conditional_usdc_fees: '1',
        total_target_volume: '1200', total_usdc_fees: '6',
        total_protocol_fee_usd: '4.8', total_lp_fee_usd: '1.2',
        conditional_reconciled: true, pending_open_proposals: 0,
      },
    ],
    getDailyMeteoraVolumes: async () => [
      {
        token: 'TOK', date: '2024-01-02', base_volume: '50', target_volume: '500',
        buy_volume: '300', sell_volume: '200', trade_count: 7, average_price: '10',
        usdc_fees: '2', token_fees: '0.1', token_fees_usdc: '1', token_per_usdc: '0.1',
      },
    ],
  } as unknown as ExternalDatabaseService;
}

describe('Market Routes', () => {
  describe('GET /api/market-data', () => {
    it('returns 400 with field=startDate when startDate is missing', async () => {
      const response = await request(app).get('/api/market-data').query({ endDate: '2024-01-15' });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Missing required parameter');
      expect(response.body.field).toBe('startDate');
    });

    it('returns 400 with field=endDate when endDate is missing', async () => {
      const response = await request(app).get('/api/market-data').query({ startDate: '2024-01-01' });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Missing required parameter');
      expect(response.body.field).toBe('endDate');
    });

    it('returns 400 Invalid date format for a malformed startDate', async () => {
      const response = await request(app)
        .get('/api/market-data')
        .query({ startDate: '01-01-2024', endDate: '2024-01-15' });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid date format');
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const downApp = createTestApp({
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const response = await request(downApp)
        .get('/api/market-data')
        .query({ startDate: '2024-01-01', endDate: '2024-01-15' });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Served database not available');
    });

    it('serves futarchy + meteora rows from the user_pool ETL with exact values', async () => {
      const seededApp = createTestApp({ externalDatabaseService: seededExternalDb() });
      const response = await request(seededApp)
        .get('/api/market-data')
        .query({ startDate: '2024-01-01', endDate: '2024-01-15' });

      expect(response.status).toBe(200);
      // envelope
      expect(response.body.source).toBe('user-pool-etl');
      expect(response.body.filters.startDate).toBe('2024-01-01');
      expect(response.body.filters.endDate).toBe('2024-01-15');

      // futarchy block — source-tagged, counted, and the pivoted spot/conditional/total
      // + protocol/LP split passed through verbatim from getFutarchyAmmDailyActivity.
      expect(response.body.futarchyAMM.source).toBe('etl-user-pool-daily');
      expect(response.body.futarchyAMM.count).toBe(1);
      const fut = response.body.futarchyAMM.data[0];
      expect(fut.token).toBe('TOK');
      expect(fut.spot_target_volume).toBe('1000');
      expect(fut.spot_protocol_fee_usd).toBe('4');
      expect(fut.spot_lp_fee_usd).toBe('1');
      expect(fut.total_target_volume).toBe('1200');
      expect(fut.total_protocol_fee_usd).toBe('4.8');
      expect(fut.total_lp_fee_usd).toBe('1.2');
      expect(fut.conditional_reconciled).toBe(true);

      // meteora block
      expect(response.body.meteora.source).toBe('etl-meteora-daily');
      expect(response.body.meteora.count).toBe(1);
      const met = response.body.meteora.data[0];
      expect(met.token).toBe('TOK');
      expect(met.target_volume).toBe('500');
      expect(met.usdc_fees).toBe('2');
      expect(met.token_per_usdc).toBe('0.1');
    });

    it('passes the tokens filter through to the response envelope', async () => {
      const seededApp = createTestApp({ externalDatabaseService: seededExternalDb() });
      const response = await request(seededApp)
        .get('/api/market-data')
        .query({ startDate: '2024-01-01', endDate: '2024-01-15', tokens: 'token1,token2' });
      expect(response.status).toBe(200);
      expect(response.body.filters.tokens).toEqual(['token1', 'token2']);
    });
  });
});
