#!/usr/bin/env node
/**
 * cleanup-dataset.js — Fix the calibration dataset
 * 
 * Problems found:
 * 1. 1681/2475 snapshots are Bitcoin (68%) — web UI spam
 * 2. Outcomes for BTC show non-zero relative_return (BTC vs BTC with different timestamps)
 * 3. Only 505 outcomes total, 473 are Bitcoin
 * 
 * Actions:
 * - Keep max 3 BTC snapshots per day (deduplicate)
 * - Fix all BTC outcomes: set relative_return_pct = 0
 * - Report dataset health after cleanup
 */

import { getCalibrationDb } from './db.js';

function main() {
  const db = getCalibrationDb();

  console.log('=== BEFORE CLEANUP ===');
  reportStats(db);

  // Step 1: Deduplicate BTC snapshots — keep max 3 per day
  console.log('\n--- Step 1: Dedup Bitcoin snapshots (max 3/day) ---');
  const btcSnaps = db.prepare(`
    SELECT id, project_name, snapshot_at, DATE(snapshot_at) as snap_day
    FROM token_snapshots
    WHERE LOWER(project_name) IN ('bitcoin', 'btc')
    ORDER BY snapshot_at ASC
  `).all();

  const byDay = {};
  for (const snap of btcSnaps) {
    if (!byDay[snap.snap_day]) byDay[snap.snap_day] = [];
    byDay[snap.snap_day].push(snap);
  }

  let deletedSnapshots = 0;
  let deletedOutcomes = 0;
  let deletedScores = 0;

  const delOutcomes = db.prepare('DELETE FROM token_outcomes WHERE snapshot_id = ?');
  const delScores = db.prepare('DELETE FROM token_scores WHERE snapshot_id = ?');
  const delSnapshot = db.prepare('DELETE FROM token_snapshots WHERE id = ?');

  const tx = db.transaction(() => {
    for (const [day, snaps] of Object.entries(byDay)) {
      if (snaps.length <= 3) continue;
      // Keep first, middle, and last of the day
      const keep = new Set([
        snaps[0].id,
        snaps[Math.floor(snaps.length / 2)].id,
        snaps[snaps.length - 1].id,
      ]);
      for (const snap of snaps) {
        if (keep.has(snap.id)) continue;
        const oRes = delOutcomes.run(snap.id);
        const sRes = delScores.run(snap.id);
        const snRes = delSnapshot.run(snap.id);
        deletedOutcomes += oRes.changes;
        deletedScores += sRes.changes;
        deletedSnapshots += snRes.changes;
      }
    }
  });
  tx();
  console.log(`Deleted: ${deletedSnapshots} BTC snapshots, ${deletedOutcomes} outcomes, ${deletedScores} scores`);

  // Step 2: Fix BTC outcomes — relative_return_pct = 0
  console.log('\n--- Step 2: Fix BTC relative returns ---');
  const fixResult = db.prepare(`
    UPDATE token_outcomes
    SET relative_return_pct = 0
    WHERE snapshot_id IN (
      SELECT id FROM token_snapshots WHERE LOWER(project_name) IN ('bitcoin', 'btc')
    )
  `).run();
  console.log(`Fixed ${fixResult.changes} BTC outcomes (relative_return = 0)`);

  // Step 3: Also fix stablecoin outcomes — relative return should be ~ -btc_return
  // (already handled correctly in formula, just a note)

  console.log('\n=== AFTER CLEANUP ===');
  reportStats(db);
}

function reportStats(db) {
  const total = db.prepare('SELECT COUNT(*) as n FROM token_snapshots').get();
  const unique = db.prepare('SELECT COUNT(DISTINCT project_name) as n FROM token_snapshots').get();
  const btc = db.prepare("SELECT COUNT(*) as n FROM token_snapshots WHERE LOWER(project_name) IN ('bitcoin', 'btc')").get();
  const outcomes = db.prepare('SELECT COUNT(*) as n FROM token_outcomes').get();
  const btcOutcomes = db.prepare(`
    SELECT COUNT(*) as n FROM token_outcomes 
    WHERE snapshot_id IN (SELECT id FROM token_snapshots WHERE LOWER(project_name) IN ('bitcoin', 'btc'))
  `).get();

  console.log(`Total snapshots: ${total.n}`);
  console.log(`Unique tokens: ${unique.n}`);
  console.log(`Bitcoin snapshots: ${btc.n} (${(btc.n / total.n * 100).toFixed(1)}%)`);
  console.log(`Total outcomes: ${outcomes.n}`);
  console.log(`BTC outcomes: ${btcOutcomes.n} (${outcomes.n > 0 ? (btcOutcomes.n / outcomes.n * 100).toFixed(1) : 0}%)`);

  // Top 10 by snapshot count
  const top = db.prepare(`
    SELECT project_name, COUNT(*) as n 
    FROM token_snapshots 
    GROUP BY LOWER(project_name) 
    ORDER BY n DESC LIMIT 10
  `).all();
  console.log('Top 10 by snapshots:');
  for (const t of top) {
    console.log(`  ${t.project_name}: ${t.n}`);
  }

  // Score bucket distribution for outcomes
  const buckets = db.prepare(`
    SELECT s.score_bucket, COUNT(*) as n, ROUND(AVG(o.relative_return_pct), 2) as avg_vs_btc
    FROM token_outcomes o
    JOIN token_scores s ON s.snapshot_id = o.snapshot_id
    GROUP BY s.score_bucket
    ORDER BY s.score_bucket
  `).all();
  console.log('Outcome distribution by score bucket:');
  for (const b of buckets) {
    console.log(`  ${b.score_bucket}: ${b.n} outcomes, avg vs BTC: ${b.avg_vs_btc}%`);
  }
}

main();
