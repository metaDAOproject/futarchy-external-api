import { describe, it, expect } from 'bun:test';
import { ExternalDatabaseService } from '../../src/services/externalDatabaseService.js';

describe('ExternalDatabaseService.ping (readiness)', () => {
  it('rejects at the deadline when the DB never replies, destroys the connection, and shares one ping', async () => {
    const releases: Array<boolean | undefined> = [];
    let connects = 0;
    const svc = new ExternalDatabaseService();
    (svc as any).isConnected = true;
    (svc as any).pool = {
      connect: async () => {
        connects++;
        return {
          query: () => new Promise(() => {}), // hung DB: accepts the connection, never answers
          release: (destroy?: boolean) => releases.push(destroy),
        };
      },
    };

    const started = Date.now();
    const results = await Promise.allSettled([svc.ping(50), svc.ping(50)]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(connects).toBe(1);
    expect(releases).toEqual([true]);
  });

  it('never starts a second connect while a ping is still stuck connecting', async () => {
    let connects = 0;
    const svc = new ExternalDatabaseService();
    (svc as any).isConnected = true;
    (svc as any).pool = {
      connect: () => {
        connects++;
        return new Promise(() => {}); // hung DB: connection handshake never completes
      },
    };

    await expect(svc.ping(30)).rejects.toThrow('timed out');
    await expect(svc.ping(30)).rejects.toThrow('timed out');

    expect(connects).toBe(1);
  });
});

describe('ExternalDatabaseService served aggregates', () => {
  it('coalesces concurrent reads into one query, reuses the result, and never caches a failure', async () => {
    let queries = 0;
    let fail = true;
    const svc = new ExternalDatabaseService();
    (svc as any).isConnected = true;
    (svc as any).pool = {
      query: async () => {
        queries++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (fail) throw new Error('connection terminated');
        return { rows: [{ token: 'A', first_date: '2025-01-01' }] };
      },
    };

    await expect(svc.getFirstTradeDates()).rejects.toThrow('connection terminated');
    expect(queries).toBe(1);

    fail = false;
    const results = await Promise.all([svc.getFirstTradeDates(), svc.getFirstTradeDates()]);
    expect(results.map((m) => m.get('A'))).toEqual(['2025-01-01', '2025-01-01']);
    expect(queries).toBe(2);

    await svc.getFirstTradeDates();
    expect(queries).toBe(2);
  });
});
