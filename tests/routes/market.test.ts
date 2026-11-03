import { describe, it, expect } from 'bun:test';
import request from 'supertest';
import { createTestApp } from '../helpers/testApp.js';
import type { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';

const app = createTestApp();
const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
    // Every rejection uses the standard error body and names the bad field.
    it.each([
      ['startDate is missing', { endDate: '2024-01-15' }, 'startDate'],
      ['endDate is missing', { startDate: '2024-01-01' }, 'endDate'],
      ['startDate is malformed', { startDate: '01-01-2024', endDate: '2024-01-15' }, 'startDate'],
      // new Date() rolls 2024-02-31 over to March 2; Postgres would reject it (500).
      ['startDate is not a calendar date', { startDate: '2024-02-31', endDate: '2024-03-15' }, 'startDate'],
      ['startDate is year 0000 (absent in Postgres)', { startDate: '0000-01-01', endDate: '0000-01-02' }, 'startDate'],
      ['tokens lists no mints', { startDate: '2024-01-01', endDate: '2024-01-15', tokens: ',,' }, 'tokens'],
      ['startDate is after endDate', { startDate: '2024-02-01', endDate: '2024-01-01' }, 'startDate'],
      ['a token is not a mint address', { startDate: '2024-01-01', endDate: '2024-01-15', tokens: 'ZKFG' }, 'tokens'],
      ['the range spans more than 366 days', { startDate: '2024-01-01', endDate: '2025-01-01' }, 'endDate'],
    ])('returns 400 when %s', async (_case, query, field) => {
      const response = await request(app).get('/api/market-data').query(query);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'INVALID_QUERY_PARAMETER', field });
      expect(typeof response.body.error).toBe('string');
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    });

    it('returns 503 when the served DB is unavailable', async () => {
      const downApp = createTestApp({
        externalDatabaseService: { isAvailable: () => false } as unknown as ExternalDatabaseService,
      });
      const response = await request(downApp)
        .get('/api/market-data')
        .query({ startDate: '2024-01-01', endDate: '2024-01-15' });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('SERVED_DB_UNAVAILABLE');
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

    it('accepts a range of exactly 366 days (a full leap year)', async () => {
      const response = await request(app).get('/api/market-data').query({ startDate: '2024-01-01', endDate: '2024-12-31' });
      expect(response.status).toBe(200);
    });

    it('passes the tokens filter through to the response envelope', async () => {
      const seededApp = createTestApp({ externalDatabaseService: seededExternalDb() });
      const response = await request(seededApp)
        .get('/api/market-data')
        .query({ startDate: '2024-01-01', endDate: '2024-01-15', tokens: `${TOKEN_A},${TOKEN_B}` });
      expect(response.status).toBe(200);
      expect(response.body.filters.tokens).toEqual([TOKEN_A, TOKEN_B]);
    });
  });
});
