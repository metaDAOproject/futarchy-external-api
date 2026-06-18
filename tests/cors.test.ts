import { describe, it, expect, afterEach } from 'bun:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createTestServices } from './helpers/testApp.js';

const originalAllowedOrigins = [...config.server.allowedOrigins];

afterEach(() => {
  config.server.allowedOrigins = [...originalAllowedOrigins];
});

describe('CORS access controls', () => {
  it('keeps wildcard browser access by default', async () => {
    // Given
    config.server.allowedOrigins = [];
    const app = createApp({ services: createTestServices() });

    // When
    const response = await request(app).get('/health').set('Origin', 'https://frontend.example');

    // Then
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('reflects only configured frontend origins when an allowlist is set', async () => {
    // Given
    config.server.allowedOrigins = ['https://frontend.example'];
    const app = createApp({ services: createTestServices() });

    // When
    const allowed = await request(app).get('/health').set('Origin', 'https://frontend.example');
    const blocked = await request(app).get('/health').set('Origin', 'https://other.example');

    // Then
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://frontend.example');
    expect(blocked.status).toBe(200);
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});
