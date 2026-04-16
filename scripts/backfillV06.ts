#!/usr/bin/env bun
/**
 * v0.6 Backfill — pull historical data from the external indexer DB
 * into the app DB's v06_* tables.
 *
 * Each run of `reconcile(since, until)` runs the **full** pipeline (same as hourly job):
 *   1. Spot OHLCV 1m (from indexer swaps + DAOs)
 *   2. Spot OHLCV 1d (rollup from app DB 1m)
 *   3. v06_fee_volume_daily_spot
 *   4. v06_fee_volume_daily_conditional (+ pending proposals)
 *   5. v06_fee_volume_daily_aggregate (spot + conditional joined)
 *
 * Usage:
 *   bun run scripts/backfillV06.ts --from-oldest --chunk-days 14   # full history from earliest indexer row (recommended)
 *   bun run scripts/backfillV06.ts --from-oldest                   # single pass (OK for small ranges; huge ranges may timeout)
 *   bun run scripts/backfillV06.ts                               # default since 2025-01-01
 *   bun run scripts/backfillV06.ts --since 2025-06-01
 *   bun run scripts/backfillV06.ts --days 90
 *
 * Speed tips:
 *   - Only need fee / aggregate tables? Use `bun run scripts/backfillV06Fees.ts`
 *     (skips OHLCV 1m/1d — usually much faster).
 *   - For huge date ranges, `--chunk-days` avoids one enormous indexer scan
 *     (can help with memory/timeouts; total work is similar).
 *   - Chunks are aligned to **UTC midnight** so each calendar day’s fee + aggregate
 *     rows are upserted once with full-day volumes (fixed-width ms chunks used to
 *     overwrite high-volume days with partial sums).
 *
 * Required env:
 *   DATABASE_URL            (or COINGECKO_PG_URL) — app DB (read-write)
 *   EXTERNAL_DATABASE_URL   — indexer DB (read-only)
 */

import { parseArgs } from 'util';

function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/** Add n calendar days in UTC (e.g. n=14 → same time-of-day, next fortnight boundary at 00:00). */
function addUtcDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

async function main() {
  // ---- CLI args ----
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
    since = new Date(0); // placeholder; set after external DB connects
  } else if (values.since) {
    since = new Date(values.since as string);
  } else if (values.days) {
    since = new Date(Date.now() - Number(values.days) * 86_400_000);
  } else {
    since = new Date('2025-01-01T00:00:00Z');
  }

  const chunkDays = values['chunk-days'] ? Number(values['chunk-days']) : 0;

  console.log('🚀 v0.6 Backfill (full pipeline: OHLCV 1m/1d + fee daily spot/conditional/aggregate)');
  if (!fromOldest) {
    console.log(`   Since:      ${since.toISOString()}`);
  }
  console.log(`   Chunk days: ${chunkDays || 'none (single pass)'}`);
  console.log('');

  // ---- env checks ----
  if (!process.env.DATABASE_URL && !process.env.COINGECKO_PG_URL) {
    console.error('❌ DATABASE_URL (or COINGECKO_PG_URL) is required');
    process.exit(1);
  }
  if (!process.env.EXTERNAL_DATABASE_URL && !process.env.FRONTEND_READER_PG_URL) {
    console.error('❌ EXTERNAL_DATABASE_URL or FRONTEND_READER_PG_URL is required');
    process.exit(1);
  }

  // ---- init services ----
  const { DatabaseService } = await import('../src/services/databaseService');
  const { ExternalDatabaseService } = await import('../src/services/externalDatabaseService');
  const { V06ReconciliationService } = await import('../src/services/v06ReconciliationService');

  const appDb = new DatabaseService();
  const extDb = new ExternalDatabaseService();

  const dbOk = await appDb.initialize();
  if (!dbOk) {
    console.error('❌ Failed to connect to app database');
    process.exit(1);
  }
  console.log('✅ App DB connected');

  const extOk = await extDb.initialize();
  if (!extOk) {
    console.error('❌ Failed to connect to external indexer database');
    await appDb.close();
    process.exit(1);
  }
  console.log('✅ External DB connected');

  if (fromOldest) {
    console.log('📍 Resolving earliest reconcilable swap timestamp in external DB (spot ∪ conditional → DAOs)...');
    const minEpoch = await extDb.getEarliestReconcilableSwapUnixTimestamp();
    if (minEpoch === null) {
      console.error('❌ No reconcilable rows found (empty v0_6_spot_swaps / v0_6_conditional_swaps with DAO joins).');
      await extDb.close();
      await appDb.close();
      process.exit(1);
    }
    since = new Date(minEpoch * 1000);
    console.log(`   Earliest unix_timestamp: ${minEpoch} → ${since.toISOString()}`);
    since = startOfUtcDay(since);
    console.log(`   Aligned to UTC day start for full-day fee rows: ${since.toISOString()}`);
    const spanDays = (Date.now() - since.getTime()) / 86_400_000;
    if (spanDays > 120 && chunkDays <= 0) {
      console.warn(
        `⚠️  Range is ~${Math.round(spanDays)} days without --chunk-days. For large histories, prefer e.g. --chunk-days 14 to avoid huge single queries.`,
      );
    }
  }

  const reconciler = new V06ReconciliationService(appDb, extDb);

  try {
    const totalStart = Date.now();

    if (chunkDays > 0) {
      // ---- chunked backfill (UTC calendar chunks — avoids partial-day overwrites on fee tables) ----
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
        await reconciler.reconcile(cursor, chunkEnd);
        cursor = chunkEnd;
        const chunkElapsed = ((Date.now() - chunkStart) / 1000).toFixed(1);
        const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
        const remaining = totalChunks - chunkNum;
        const avgPerChunk = (Date.now() - totalStart) / chunkNum / 1000;
        const eta = remaining > 0 ? `~${(remaining * avgPerChunk / 60).toFixed(1)} min` : 'done';
        console.log(`   ✓ Chunk ${chunkNum} done in ${chunkElapsed}s (total: ${totalElapsed}s, remaining: ${remaining} chunks, ETA: ${eta})`);
      }
    } else {
      // ---- single pass ----
      console.log('\n⏳ Running single-pass reconciliation (this may take a while)...');
      await reconciler.reconcile(since);
    }

    const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
    console.log(`\n✅ Backfill complete in ${totalElapsed}s!`);
  } catch (error: any) {
    console.error('❌ Backfill failed:', error.message || error);
    process.exit(1);
  } finally {
    await extDb.close();
    await appDb.close();
  }
}

main().catch(console.error);
