#!/usr/bin/env bun
/**
 * v0.6 Fee-only Backfill — re-calculates fee volume daily tables
 * (spot, conditional, aggregate) without touching OHLCV data.
 *
 * Usage:
 *   bun run scripts/backfillV06Fees.ts --from-oldest --chunk-days 30
 *   bun run scripts/backfillV06Fees.ts                   # default since 2025-01-01
 *   bun run scripts/backfillV06Fees.ts --since 2025-06-01
 *   bun run scripts/backfillV06Fees.ts --days 90
 *   bun run scripts/backfillV06Fees.ts --chunk-days 30
 *
 * Spot and conditional fee queries run in parallel against the indexer,
 * then the aggregate step runs once.
 *
 * Chunk boundaries use UTC midnight (see backfillV06.ts) so daily upserts are full days.
 */

import { parseArgs } from 'util';

function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function addUtcDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      since: { type: 'string', short: 's' },
      days: { type: 'string', short: 'd' },
      'chunk-days': { type: 'string', short: 'c' },
      'from-oldest': { type: 'boolean', short: 'o', default: false },
    },
    strict: false,
  });

  const fromOldest = values['from-oldest'] === true;
  const hasSince = Boolean(values.since);
  const hasDays = Boolean(values.days);

  if (fromOldest && (hasSince || hasDays)) {
    console.error('❌ Use only one of: --from-oldest  OR  --since / --days');
    process.exit(1);
  }

  let since: Date;
  if (fromOldest) {
    since = new Date(0);
  } else if (values.since) {
    since = new Date(values.since as string);
  } else if (values.days) {
    since = new Date(Date.now() - Number(values.days) * 86_400_000);
  } else {
    since = new Date('2025-01-01T00:00:00Z');
  }

  const chunkDays = values['chunk-days'] ? Number(values['chunk-days']) : 0;

  console.log('🚀 v0.6 Fee-only Backfill (spot + conditional + aggregate)');
  if (!fromOldest) {
    console.log(`   Since:      ${since.toISOString()}`);
  }
  console.log(`   Chunk days: ${chunkDays || 'none (single pass)'}`);
  console.log('');

  if (!process.env.DATABASE_URL && !process.env.COINGECKO_PG_URL) {
    console.error('❌ DATABASE_URL (or COINGECKO_PG_URL) is required');
    process.exit(1);
  }
  if (!process.env.EXTERNAL_DATABASE_URL && !process.env.FRONTEND_READER_PG_URL) {
    console.error('❌ EXTERNAL_DATABASE_URL or FRONTEND_READER_PG_URL is required');
    process.exit(1);
  }

  const { DatabaseService } = await import('../src/services/databaseService');
  const { ExternalDatabaseService } = await import('../src/services/externalDatabaseService');
  const { V06ReconciliationService } = await import('../src/services/v06ReconciliationService');

  const appDb = new DatabaseService();
  const extDb = new ExternalDatabaseService();

  const dbOk = await appDb.initialize();
  if (!dbOk) { console.error('❌ Failed to connect to app DB'); process.exit(1); }
  console.log('✅ App DB connected');

  const extOk = await extDb.initialize();
  if (!extOk) { console.error('❌ Failed to connect to external DB'); await appDb.close(); process.exit(1); }
  console.log('✅ External DB connected');

  if (fromOldest) {
    console.log('📍 Resolving earliest reconcilable swap timestamp in external DB...');
    const minEpoch = await extDb.getEarliestReconcilableSwapUnixTimestamp();
    if (minEpoch === null) {
      console.error('❌ No reconcilable rows found in external DB.');
      await extDb.close();
      await appDb.close();
      process.exit(1);
    }
    since = new Date(minEpoch * 1000);
    console.log(`   Earliest unix_timestamp: ${minEpoch} → ${since.toISOString()}`);
    since = startOfUtcDay(since);
    console.log(`   Aligned to UTC day start: ${since.toISOString()}`);
    const spanDays = (Date.now() - since.getTime()) / 86_400_000;
    if (spanDays > 120 && chunkDays <= 0) {
      console.warn(
        `⚠️  Range is ~${Math.round(spanDays)} days without --chunk-days. Consider --chunk-days 30.`,
      );
    }
  }

  const reconciler = new V06ReconciliationService(appDb, extDb);

  try {
    const totalStart = Date.now();

    if (chunkDays > 0) {
      let cursor = startOfUtcDay(since);
      const now = new Date();
      const msPerChunk = chunkDays * 86_400_000;
      const totalChunks = Math.max(1, Math.ceil((now.getTime() - cursor.getTime()) / msPerChunk));
      let chunkNum = 0;

      while (cursor < now) {
        chunkNum++;
        const chunkStart = Date.now();
        const nextBoundary = addUtcDays(cursor, chunkDays);
        const chunkEnd = new Date(Math.min(nextBoundary.getTime(), now.getTime()));
        console.log(`\n📦 Chunk ${chunkNum}/${totalChunks}: ${cursor.toISOString()} → ${chunkEnd.toISOString()}`);
        await reconciler.reconcileFeesOnly(cursor, chunkEnd);
        cursor = chunkEnd;
        const chunkElapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
        const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
        const remaining = totalChunks - chunkNum;
        const avgPerChunk = (Date.now() - totalStart) / chunkNum / 1000;
        const eta = remaining > 0 ? `~${(remaining * avgPerChunk / 60).toFixed(1)} min` : 'done';
        console.log(`   ✓ Chunk ${chunkNum} done in ${chunkElapsed}s (total: ${totalElapsed}s, remaining: ${remaining} chunks, ETA: ${eta})`);
      }
    } else {
      console.log('\n⏳ Running single-pass fee reconciliation...');
      await reconciler.reconcileFeesOnly(since);
    }

    const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
    console.log(`\n✅ Fee backfill complete in ${totalElapsed}s!`);
  } catch (error: any) {
    console.error('❌ Fee backfill failed:', error.message || error);
    process.exit(1);
  } finally {
    await extDb.close();
    await appDb.close();
  }
}

main().catch(console.error);
