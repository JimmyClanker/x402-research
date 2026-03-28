#!/usr/bin/env node
/**
 * backfill-outcomes.js — Calculate outcomes for existing snapshots
 * 
 * Runs the outcome tracker on all snapshots, then reports stats.
 * Can also generate synthetic backfill by fetching current prices
 * for snapshots that are old enough for 3-day checkpoint.
 * 
 * Usage: node calibration/backfill-outcomes.js [--max-age-days 91]
 */

import { trackOutcomes } from './outcome-tracker.js';
import { getCalibrationDb } from './db.js';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };
  const maxAgeDays = parseInt(getArg('--max-age-days', '91'), 10);

  const db = getCalibrationDb();

  // Report before
  console.log('=== BEFORE BACKFILL ===');
  reportStats(db);

  // Run outcome tracker
  console.log('\n--- Running outcome tracker ---');
  const result = await trackOutcomes({ maxAgeDays, rateLimitMs: 2000 });
  console.log(`Updated: ${result.updated}, Skipped: ${result.skipped}, Errors: ${result.errors}`);

  // Report after
  console.log('\n=== AFTER BACKFILL ===');
  reportStats(db);
}

function reportStats(db) {
  const total = db.prepare('SELECT COUNT(*) as n FROM token_outcomes').get();
  const unique = db.prepare(`
    SELECT COUNT(DISTINCT ts.project_name) as n
    FROM token_outcomes o
    JOIN token_snapshots ts ON ts.id = o.snapshot_id
  `).get();

  console.log(`Total outcomes: ${total.n} (${unique.n} unique tokens)`);

  // Per-token outcome count
  const perToken = db.prepare(`
    SELECT ts.project_name, COUNT(*) as n,
           ROUND(AVG(o.relative_return_pct), 2) as avg_vs_btc
    FROM token_outcomes o
    JOIN token_snapshots ts ON ts.id = o.snapshot_id
    GROUP BY LOWER(ts.project_name)
    ORDER BY n DESC
    LIMIT 20
  `).all();
  console.log('Top tokens with outcomes:');
  for (const t of perToken) {
    console.log(`  ${t.project_name}: ${t.n} outcomes, avg vs BTC: ${t.avg_vs_btc}%`);
  }

  // Score bucket distribution
  const buckets = db.prepare(`
    SELECT s.score_bucket, COUNT(*) as n,
           ROUND(AVG(o.relative_return_pct), 2) as avg_vs_btc,
           COUNT(DISTINCT ts.project_name) as tokens
    FROM token_outcomes o
    JOIN token_scores s ON s.snapshot_id = o.snapshot_id
    JOIN token_snapshots ts ON ts.id = o.snapshot_id
    GROUP BY s.score_bucket
    ORDER BY s.score_bucket
  `).all();
  console.log('Score bucket performance:');
  for (const b of buckets) {
    console.log(`  ${b.score_bucket}: ${b.n} outcomes (${b.tokens} tokens), avg vs BTC: ${b.avg_vs_btc}%`);
  }

  // Snapshots eligible for outcome (>3 days old, no outcome yet)
  const eligible = db.prepare(`
    SELECT COUNT(*) as n
    FROM token_snapshots ts
    WHERE ts.price IS NOT NULL AND ts.price > 0
      AND datetime(ts.snapshot_at) < datetime('now', '-2 days')
      AND NOT EXISTS (
        SELECT 1 FROM token_outcomes o WHERE o.snapshot_id = ts.id
      )
  `).get();
  console.log(`Snapshots eligible for outcome tracking (>2 days, no outcome yet): ${eligible.n}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
