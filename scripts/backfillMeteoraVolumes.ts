/**
 * Backfill Script for Meteora Daily Volumes
 * 
 * This script backfills historical Meteora pool fee data from Dune.
 * It fetches data from 2025-10-09 to present and stores it in the database.
 * Processes data in chunks to avoid API limits.
 * 
 * Usage: 
 *   bun run scripts/backfillMeteoraVolumes.ts
 *   RECENT_DAYS=7 bun run scripts/backfillMeteoraVolumes.ts   # Only backfill last 7 days
 *   CHUNK_DAYS=30 bun run scripts/backfillMeteoraVolumes.ts   # Use 30-day chunks (default: 30)
 *
 * Chunk skipping (METEORA_BACKFILL_SKIP_CHUNKS):
 *   coverage (default) — skip a chunk only if DB already has rows for every mapped token in that date range (adds missing tokens after you extend the map + Dune query).
 *   any — skip whenever any row exists in the chunk (legacy; misses new tokens in already-filled ranges).
 *   never — always call Dune (idempotent upserts; highest Dune usage).
 */

import { DatabaseService } from '../src/services/databaseService.js';
import { DuneService } from '../src/services/duneService.js';
import { MeteoraVolumeFetcherService } from '../src/services/meteoraVolumeFetcherService.js';
import { getAllMappedTokens } from '../src/services/meteoraService.js';
import { config } from '../src/config.js';

/** Chunk skip behavior: avoid re-querying Dune when data already exists. */
type ChunkSkipMode = 'coverage' | 'any' | 'never';

function parseChunkSkipMode(raw: string | undefined): ChunkSkipMode {
  if (raw === 'any' || raw === 'never' || raw === 'coverage') {
    return raw;
  }
  return 'coverage';
}

/**
 * Helper to add days to a date
 */
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Helper to format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

/**
 * Generate date chunks for backfilling
 */
function generateDateChunks(startDate: Date, endDate: Date, chunkDays: number): Array<{ start: Date; end: Date }> {
  const chunks: Array<{ start: Date; end: Date }> = [];
  let currentStart = new Date(startDate);

  while (currentStart < endDate) {
    const currentEnd = new Date(currentStart);
    currentEnd.setDate(currentEnd.getDate() + chunkDays - 1);
    
    // Don't go past the end date
    if (currentEnd > endDate) {
      currentEnd.setTime(endDate.getTime());
    }

    chunks.push({
      start: new Date(currentStart),
      end: new Date(currentEnd),
    });

    // Move to next chunk
    currentStart = addDays(currentEnd, 1);
  }

  return chunks;
}

async function backfillMeteoraVolumes() {
  console.log('=== Starting Meteora Volumes Backfill ===\n');

  // Check environment variables for options
  const recentDays = process.env.RECENT_DAYS ? parseInt(process.env.RECENT_DAYS) : null;
  const chunkDays = process.env.CHUNK_DAYS ? parseInt(process.env.CHUNK_DAYS) : 30; // Default: 30-day chunks
  const chunkSkipMode = parseChunkSkipMode(process.env.METEORA_BACKFILL_SKIP_CHUNKS);
  const expectedTokens = getAllMappedTokens();

  if (recentDays) {
    console.log(`⚠ RECENT_DAYS=${recentDays}: Will only backfill last ${recentDays} days\n`);
  }
  console.log(`📦 Using ${chunkDays}-day chunks to avoid API limits`);
  console.log(`   Mapped Meteora tokens: ${expectedTokens.length} (${chunkSkipMode} chunk skip)\n`);

  // Initialize services
  const databaseService = new DatabaseService();
  const duneService = new DuneService();
  const meteoraService = new MeteoraVolumeFetcherService(duneService, databaseService);

  try {
    // 1. Connect to database
    console.log('1. Connecting to database...');
    const dbConnected = await databaseService.initialize();
    if (!dbConnected) {
      console.error('Failed to connect to database');
      process.exit(1);
    }
    console.log('✓ Database connected\n');

    // 2. Check for existing records
    console.log('2. Checking for existing records...');
    if (!databaseService.pool) {
      console.error('Database pool not available');
      process.exit(1);
    }

    const existingCheck = await databaseService.pool.query(`
      SELECT 
        COUNT(*) as total_records,
        MIN(date) as earliest_date,
        MAX(date) as latest_date
      FROM daily_meteora_volumes
    `);

    const stats = existingCheck.rows[0];
    console.log(`   Total records: ${stats.total_records}`);
    console.log(`   Date range: ${stats.earliest_date || 'N/A'} to ${stats.latest_date || 'N/A'}\n`);

    // 3. Determine date range
    const launchDate = new Date('2025-10-09');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    let actualStartDate = new Date(launchDate);
    let actualEndDate = new Date(today);

    if (recentDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - recentDays);
      cutoffDate.setHours(0, 0, 0, 0);
      if (cutoffDate > launchDate) {
        actualStartDate = cutoffDate;
        console.log(`   Limiting to last ${recentDays} days (since ${formatDate(actualStartDate)})\n`);
      } else {
        console.log(`   Starting from ${formatDate(launchDate)} (launch date)\n`);
      }
    } else {
      console.log(`   Date range: ${formatDate(actualStartDate)} to ${formatDate(actualEndDate)}\n`);
    }

    // 4. Check if query ID is configured
    if (!config.dune.meteoraVolumeQueryId) {
      console.error('❌ DUNE_METEORA_VOLUME_QUERY_ID not configured');
      console.error('   Please set DUNE_METEORA_VOLUME_QUERY_ID in your .env file');
      process.exit(1);
    }

    console.log(`3. Using Dune query ID: ${config.dune.meteoraVolumeQueryId}\n`);

    // 5. Skip service initialization to avoid automatic backfill
    // The backfill script handles chunked fetching manually
    console.log('4. Ready to process chunks (skipping service auto-initialization)\n');

    // 6. Generate date chunks
    console.log('5. Generating date chunks...');
    const chunks = generateDateChunks(actualStartDate, actualEndDate, chunkDays);
    console.log(`   Generated ${chunks.length} chunks of ${chunkDays} days each\n`);

    // 7. Process chunks
    console.log('6. Processing chunks from Dune...\n');
    let totalRecords = 0;
    let processedChunks = 0;
    let errors = 0;
    let apiLimitHit = false;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx]!;
      const chunkStart = formatDate(chunk.start);
      const chunkEnd = formatDate(chunk.end);
      
      console.log(`   [${chunkIdx + 1}/${chunks.length}] Processing ${chunkStart} to ${chunkEnd}...`);

      try {
        if (chunkSkipMode !== 'never') {
          if (chunkSkipMode === 'any') {
            const existingCheck = await databaseService.pool!.query(
              `
              SELECT COUNT(*)::int AS count
              FROM daily_meteora_volumes
              WHERE date >= $1 AND date <= $2
            `,
              [chunkStart, chunkEnd],
            );

            const existingCount = Number(existingCheck.rows[0]!.count);
            if (existingCount > 0) {
              console.log(`      ⏭️  Skipping (${existingCount} records already exist, skip mode=any)`);
              processedChunks++;
              continue;
            }
          } else {
            const coverageCheck = await databaseService.pool!.query(
              `
              SELECT COUNT(*)::int AS distinct_tokens
              FROM (
                SELECT DISTINCT token
                FROM daily_meteora_volumes
                WHERE date >= $1 AND date <= $2
                  AND token = ANY($3::varchar[])
              ) t
            `,
              [chunkStart, chunkEnd, expectedTokens],
            );

            const distinctInChunk = Number(coverageCheck.rows[0]!.distinct_tokens);
            if (distinctInChunk >= expectedTokens.length) {
              console.log(
                `      ⏭️  Skipping (${distinctInChunk}/${expectedTokens.length} mapped tokens present in range, skip mode=coverage)`,
              );
              processedChunks++;
              continue;
            }
            if (distinctInChunk > 0) {
              console.log(`      Refetch (${distinctInChunk}/${expectedTokens.length} mapped tokens in range — filling gaps)`);
            }
          }
        }

        // Fetch chunk from Dune
        const recordsUpserted = await meteoraService.fetchDateRange(chunkStart, chunkEnd);
        
        if (recordsUpserted > 0) {
          totalRecords += recordsUpserted;
          console.log(`      ✓ Fetched and stored ${recordsUpserted} records`);
        } else {
          console.log(`      - No new records for this chunk`);
        }

        processedChunks++;
        
        // Add delay between chunks to avoid rate limits (3 seconds between chunks)
        if (chunkIdx < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error: any) {
        errors++;
        if (error.message?.includes('402') || error.message?.includes('Payment Required')) {
          apiLimitHit = true;
          console.error(`\n      ✗ Dune API limit reached!`);
          console.error(`\n   Processed ${processedChunks} chunks, fetched ${totalRecords} records before limit.`);
          console.error(`\n   Options to continue:`);
          console.error(`   1. Wait for your Dune billing cycle to reset`);
          console.error(`   2. Upgrade your Dune subscription`);
          console.error(`   3. Resume later - with METEORA_BACKFILL_SKIP_CHUNKS=coverage (default), chunks skip only when every mapped token exists in that date range`);
          console.error(`\n   Run the script again to resume; use METEORA_BACKFILL_SKIP_CHUNKS=never to force re-querying all chunks.\n`);
          break;
        } else {
          console.error(`      ✗ Error: ${error.message}`);
          // Continue with next chunk on non-limit errors
        }
      }

      if (apiLimitHit) break;
    }

    if (!apiLimitHit) {
      console.log(`\n✓ Backfill completed successfully`);
      console.log(`   Processed ${processedChunks}/${chunks.length} chunks`);
      console.log(`   Total records fetched: ${totalRecords}`);
    } else {
      console.log(`\n⚠ Backfill partially completed`);
      console.log(`   Processed ${processedChunks}/${chunks.length} chunks`);
      console.log(`   Total records fetched: ${totalRecords}`);
      console.log(`   Run the script again to continue from where it left off.`);
    }

    if (errors > 0 && !apiLimitHit) {
      console.log(`\n⚠ Completed with ${errors} error(s) (non-fatal)`);
    }

    // 8. Verify final state
    console.log('\n7. Verifying final state...');
    const finalCheck = await databaseService.pool.query(`
      SELECT 
        COUNT(*) as total_records,
        MIN(date) as earliest_date,
        MAX(date) as latest_date,
        COUNT(DISTINCT token) as unique_tokens
      FROM daily_meteora_volumes
    `);

    const finalStats = finalCheck.rows[0];
    console.log(`   Total records: ${finalStats.total_records}`);
    console.log(`   Date range: ${finalStats.earliest_date || 'N/A'} to ${finalStats.latest_date || 'N/A'}`);
    console.log(`   Unique tokens: ${finalStats.unique_tokens}\n`);

    console.log('=== Backfill Completed ===');
    process.exit(0);
  } catch (error: any) {
    console.error('Error during backfill:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the backfill
backfillMeteoraVolumes();
