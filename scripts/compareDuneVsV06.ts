#!/usr/bin/env bun
/**
 * Compare Dune-sourced daily_volumes against v06_fee_volume_daily_aggregate
 * to identify divergences per token/day.
 *
 * Usage:
 *   bun run scripts/compareDuneVsV06.ts                         # default last 90 days
 *   bun run scripts/compareDuneVsV06.ts --since 2025-01-01
 *   bun run scripts/compareDuneVsV06.ts --days 30
 *   bun run scripts/compareDuneVsV06.ts --days 30 --token META
 *   bun run scripts/compareDuneVsV06.ts --threshold 5           # flag rows with >5% delta (default: 1%)
 *   bun run scripts/compareDuneVsV06.ts --basis total             # compare Dune to v06 total_* (spot+conditional; expect gaps)
 *
 * Basis:
 *   spot (default) — Dune daily_volumes is spot-only; compared to v06 spot_* columns (apples to apples).
 *   total          — compared to v06 total_*; divergences are normal when conditional volume exists.
 *
 * Units:
 *   daily_volumes (Dune path) stores human-scale amounts (/ 1e6 in Dune SQL).
 *   v06_fee_volume_* stores raw on-chain amounts (6 decimals). This script divides
 *   v06 volumes and fee columns by 1e6 before comparing so the delta is meaningful.
 *
 * Required env:
 *   DATABASE_URL (or COINGECKO_PG_URL)
 */

import 'dotenv/config';
import { parseArgs } from 'util';

// ---- types ----

interface ComparisonRow {
  token: string;
  date: string;
  // Dune (daily_volumes)
  dune_buy_volume: number;
  dune_sell_volume: number;
  dune_base_volume: number;
  dune_target_volume: number;
  dune_trade_count: number;
  dune_usdc_fees: number;
  dune_token_fees_usdc: number;
  // v06 aggregate (spot_* or total_* depending on --basis)
  v06_buy_volume: number;
  v06_sell_volume: number;
  v06_base_volume: number;
  v06_target_volume: number;
  v06_trade_count: number;
  v06_usdc_fees: number;
  v06_token_fees_usdc: number;
  // flags
  has_conditional_volume: boolean;
  conditional_reconciled: boolean;
  // source presence
  in_dune: boolean;
  in_v06: boolean;
}

interface DivergenceReport {
  token: string;
  date: string;
  field: string;
  dune_value: number;
  v06_value: number;
  delta: number;
  delta_pct: number;
  has_conditional_volume: boolean;
  conditional_reconciled: boolean;
}

// ---- main ----

type CompareBasis = 'spot' | 'total';

/** v0.6 indexer + reconciliation use raw token amounts (6 dp); Dune daily_volumes uses /1e6. */
const V06_TO_HUMAN_DIVISOR = 1_000_000;

async function main() {
  const { values } = parseArgs({
    options: {
      since:              { type: 'string',  short: 's' },
      days:               { type: 'string',  short: 'd' },
      token:              { type: 'string',  short: 't' },
      threshold:          { type: 'string',  short: 'p' },
      basis:              { type: 'string',  short: 'b' },
    },
    strict: false,
  });

  let since: Date;
  if (values.since) {
    since = new Date(values.since as string);
  } else if (values.days) {
    since = new Date(Date.now() - Number(values.days) * 86_400_000);
  } else {
    since = new Date(Date.now() - 90 * 86_400_000);
  }

  const thresholdPct = values.threshold ? Number(values.threshold) : 1;
  const tokenFilter = values.token as string | undefined;
  const basisRaw = (values.basis as string | undefined)?.toLowerCase();
  const basis: CompareBasis = basisRaw === 'total' ? 'total' : 'spot';

  console.log('🔍 Dune vs v06 Comparison');
  console.log(`   Since:      ${since.toISOString().slice(0, 10)}`);
  console.log(`   Token:      ${tokenFilter || 'all'}`);
  console.log(`   Threshold:  ${thresholdPct}%`);
  console.log(`   Basis:      ${basis} (v06 ${basis === 'spot' ? 'spot_* ↔ Dune spot-only' : 'total_* includes conditional — gaps vs Dune expected'})`);
  console.log(`   v06 scale:  volumes/fees ÷ ${V06_TO_HUMAN_DIVISOR} (raw 6dp → match Dune)`);
  console.log('');

  // ---- connect ----
  const { DatabaseService } = await import('../src/services/databaseService');
  const db = new DatabaseService();
  const ok = await db.initialize();
  if (!ok) {
    console.error('❌ Failed to connect to database');
    process.exit(1);
  }
  console.log('✅ DB connected\n');

  try {
    // ---- run comparison query ----
    const rows = await runComparison(db, since, tokenFilter, basis);
    const divergences = findDivergences(rows, thresholdPct);

    printSummary(rows, divergences, thresholdPct);
    printMissingDays(rows);
    printDivergences(divergences);
  } finally {
    await db.close();
  }
}

// ---- SQL comparison: FULL OUTER JOIN daily_volumes ↔ v06_fee_volume_daily_aggregate ----

async function runComparison(
  db: any,
  since: Date,
  tokenFilter: string | undefined,
  basis: CompareBasis,
): Promise<ComparisonRow[]> {
  const params: any[] = [since.toISOString().slice(0, 10)];
  if (tokenFilter) {
    params.push(tokenFilter);
  }

  const v06Cols =
    basis === 'total'
      ? {
          buy: 'v.total_buy_volume',
          sell: 'v.total_sell_volume',
          base: 'v.total_base_volume',
          target: 'v.total_target_volume',
          trades: 'v.total_trade_count',
          usdc: 'v.total_usdc_fees',
          tokUsdc: 'v.total_token_fees_usdc',
        }
      : {
          buy: 'v.spot_buy_volume',
          sell: 'v.spot_sell_volume',
          base: 'v.spot_base_volume',
          target: 'v.spot_target_volume',
          trades: 'v.spot_trade_count',
          usdc: 'v.spot_usdc_fees',
          tokUsdc: 'v.spot_token_fees_usdc',
        };

  // Use a FULL OUTER JOIN so we see rows present in one table but not the other
  const sql = `
    SELECT
      COALESCE(d.token, v.token) AS token,
      COALESCE(d.date, v.date)::text AS date,
      -- dune
      COALESCE(d.buy_volume, 0)::float8        AS dune_buy_volume,
      COALESCE(d.sell_volume, 0)::float8        AS dune_sell_volume,
      COALESCE(d.base_volume, 0)::float8        AS dune_base_volume,
      COALESCE(d.target_volume, 0)::float8      AS dune_target_volume,
      COALESCE(d.trade_count, 0)::int           AS dune_trade_count,
      COALESCE(d.usdc_fees, 0)::float8          AS dune_usdc_fees,
      COALESCE(d.token_fees_usdc, 0)::float8    AS dune_token_fees_usdc,
      -- v06 (${basis}) — divide by ${V06_TO_HUMAN_DIVISOR} so amounts match Dune human scale
      (COALESCE(${v06Cols.buy}, 0)::numeric / ${V06_TO_HUMAN_DIVISOR})::float8   AS v06_buy_volume,
      (COALESCE(${v06Cols.sell}, 0)::numeric / ${V06_TO_HUMAN_DIVISOR})::float8   AS v06_sell_volume,
      (COALESCE(${v06Cols.base}, 0)::numeric / ${V06_TO_HUMAN_DIVISOR})::float8   AS v06_base_volume,
      (COALESCE(${v06Cols.target}, 0)::numeric / ${V06_TO_HUMAN_DIVISOR})::float8 AS v06_target_volume,
      COALESCE(${v06Cols.trades}, 0)::int      AS v06_trade_count,
      (COALESCE(${v06Cols.usdc}, 0)::numeric / ${V06_TO_HUMAN_DIVISOR})::float8     AS v06_usdc_fees,
      (COALESCE(${v06Cols.tokUsdc}, 0)::numeric / ${V06_TO_HUMAN_DIVISOR})::float8 AS v06_token_fees_usdc,
      -- flags (non-zero conditional activity on this token-day)
      (COALESCE(v.conditional_trade_count, 0) > 0) AS has_conditional_volume,
      COALESCE(v.conditional_reconciled, false)  AS conditional_reconciled,
      (d.token IS NOT NULL)                      AS in_dune,
      (v.token IS NOT NULL)                      AS in_v06
    FROM daily_volumes d
    FULL OUTER JOIN v06_fee_volume_daily_aggregate v
      ON LOWER(d.token) = LOWER(v.token) AND d.date = v.date
    WHERE COALESCE(d.date, v.date) >= $1
      ${tokenFilter ? `AND (LOWER(d.token) = LOWER($2) OR LOWER(v.token) = LOWER($2))` : ''}
    ORDER BY COALESCE(d.token, v.token), COALESCE(d.date, v.date)
  `;

  const pool = (db as any).pool;
  const result = await pool.query(sql, params);
  return result.rows;
}

// ---- find divergences above threshold ----

const COMPARED_FIELDS = [
  'buy_volume',
  'sell_volume',
  'base_volume',
  'target_volume',
  'trade_count',
  'usdc_fees',
  'token_fees_usdc',
] as const;

function findDivergences(rows: ComparisonRow[], thresholdPct: number): DivergenceReport[] {
  const divergences: DivergenceReport[] = [];

  for (const row of rows) {
    if (!row.in_dune || !row.in_v06) continue; // handled separately as "missing"

    for (const field of COMPARED_FIELDS) {
      const duneVal = (row as any)[`dune_${field}`] as number;
      const v06Val = (row as any)[`v06_${field}`] as number;
      const delta = v06Val - duneVal;
      const maxAbs = Math.max(Math.abs(duneVal), Math.abs(v06Val));
      const deltaPct = maxAbs > 0 ? (Math.abs(delta) / maxAbs) * 100 : 0;

      if (deltaPct > thresholdPct) {
        divergences.push({
          token: row.token,
          date: row.date,
          field,
          dune_value: duneVal,
          v06_value: v06Val,
          delta,
          delta_pct: deltaPct,
          has_conditional_volume: row.has_conditional_volume,
          conditional_reconciled: row.conditional_reconciled,
        });
      }
    }
  }

  return divergences;
}

// ---- print helpers ----

function printSummary(rows: ComparisonRow[], divergences: DivergenceReport[], thresholdPct: number) {
  const tokens = new Set(rows.map((r) => r.token));
  const bothPresent = rows.filter((r) => r.in_dune && r.in_v06);
  const duneOnly = rows.filter((r) => r.in_dune && !r.in_v06);
  const v06Only = rows.filter((r) => !r.in_dune && r.in_v06);
  const divergentDays = new Set(divergences.map((d) => `${d.token}|${d.date}`));

  console.log('📊 SUMMARY');
  console.log(`   Tokens compared:          ${tokens.size}`);
  console.log(`   Total token-day pairs:    ${rows.length}`);
  console.log(`   Both sources present:     ${bothPresent.length}`);
  console.log(`   Dune only (missing v06):  ${duneOnly.length}`);
  console.log(`   v06 only (missing Dune):  ${v06Only.length}`);
  console.log(`   Divergent days (>${thresholdPct}%):   ${divergentDays.size}`);
  console.log(`   Total field divergences:  ${divergences.length}`);
  console.log('');
}

function printMissingDays(rows: ComparisonRow[]) {
  const duneOnly = rows.filter((r) => r.in_dune && !r.in_v06);
  const v06Only = rows.filter((r) => !r.in_dune && r.in_v06);

  if (duneOnly.length > 0) {
    console.log('⚠️  DAYS IN DUNE BUT MISSING FROM V06:');
    const byToken = groupBy(duneOnly, (r) => r.token);
    for (const [token, days] of Object.entries(byToken)) {
      const dates = days.map((d) => d.date).sort();
      const rangeStr = dates.length <= 5
        ? dates.join(', ')
        : `${dates[0]} … ${dates[dates.length - 1]} (${dates.length} days)`;
      console.log(`   ${token}: ${rangeStr}`);
    }
    console.log('');
  }

  if (v06Only.length > 0) {
    console.log('⚠️  DAYS IN V06 BUT MISSING FROM DUNE:');
    const byToken = groupBy(v06Only, (r) => r.token);
    for (const [token, days] of Object.entries(byToken)) {
      const dates = days.map((d) => d.date).sort();
      const rangeStr = dates.length <= 5
        ? dates.join(', ')
        : `${dates[0]} … ${dates[dates.length - 1]} (${dates.length} days)`;
      console.log(`   ${token}: ${rangeStr}`);
    }
    console.log('');
  }

  if (duneOnly.length === 0 && v06Only.length === 0) {
    console.log('✅ No missing days — both sources cover the same date ranges.\n');
  }
}

function printDivergences(divergences: DivergenceReport[]) {
  if (divergences.length === 0) {
    console.log('✅ No field divergences above threshold.\n');
    return;
  }

  console.log('🔴 DIVERGENCES:');
  console.log(
    '   ' +
      pad('TOKEN', 12) +
      pad('DATE', 12) +
      pad('FIELD', 18) +
      padR('DUNE', 16) +
      padR('V06', 16) +
      padR('DELTA', 16) +
      padR('Δ%', 8) +
      pad('COND?', 6) +
      pad('RECON?', 6),
  );
  console.log('   ' + '-'.repeat(110));

  for (const d of divergences) {
    console.log(
      '   ' +
        pad(d.token, 12) +
        pad(d.date, 12) +
        pad(d.field, 18) +
        padR(fmt(d.dune_value), 16) +
        padR(fmt(d.v06_value), 16) +
        padR(fmt(d.delta), 16) +
        padR(d.delta_pct.toFixed(1) + '%', 8) +
        pad(d.has_conditional_volume ? 'Y' : 'N', 6) +
        pad(d.conditional_reconciled ? 'Y' : 'N', 6),
    );
  }

  // Per-token summary
  console.log('');
  const byToken = groupBy(divergences, (d) => d.token);
  console.log('   Per-token divergence counts:');
  for (const [token, items] of Object.entries(byToken)) {
    const fields = groupBy(items, (i) => i.field);
    const fieldSummary = Object.entries(fields)
      .map(([f, arr]) => `${f}:${arr.length}`)
      .join(', ');
    console.log(`     ${token}: ${items.length} divergences (${fieldSummary})`);
  }
  console.log('');
}

// ---- util ----

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (map[k] ??= []).push(item);
  }
  return map;
}

function pad(s: string, n: number) {
  return s.padEnd(n);
}
function padR(s: string, n: number) {
  return s.padStart(n - 1) + ' ';
}
function fmt(n: number): string {
  if (Math.abs(n) < 0.01) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});
