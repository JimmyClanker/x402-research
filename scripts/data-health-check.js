#!/usr/bin/env node
/**
 * data-health-check.js — Daily health check for data collection pipeline.
 *
 * Checks:
 * 1. Clawnkers server is up
 * 2. Today's snapshot count + price coverage
 * 3. Outcomes produced
 * 4. Last batch scan status
 * 5. Auto-fix: restart server if down
 *
 * Usage: node scripts/data-health-check.js
 * Output: markdown report to stdout
 */

import { getCalibrationDb } from '../calibration/db.js';

const SERVER_URL = 'http://localhost:4021';
const today = new Date().toISOString().split('T')[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

async function checkServer() {
  try {
    const res = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return { up: res.ok, status: res.status };
  } catch {
    return { up: false, status: 'unreachable' };
  }
}

function checkSnapshots(db) {
  const todayStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN price IS NOT NULL AND price > 0 THEN 1 ELSE 0 END) as with_price
    FROM token_snapshots
    WHERE DATE(snapshot_at) = ?
  `).get(today);

  const yesterdayStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN price IS NOT NULL AND price > 0 THEN 1 ELSE 0 END) as with_price
    FROM token_snapshots
    WHERE DATE(snapshot_at) = ?
  `).get(yesterday);

  const allTime = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN price IS NOT NULL AND price > 0 THEN 1 ELSE 0 END) as with_price
    FROM token_snapshots
  `).get();

  return { today: todayStats, yesterday: yesterdayStats, allTime };
}

function checkOutcomes(db) {
  const total = db.prepare('SELECT COUNT(*) as n FROM token_outcomes').get();
  const byCheckpoint = db.prepare(`
    SELECT days_forward, COUNT(*) as n
    FROM token_outcomes
    GROUP BY days_forward
    ORDER BY days_forward
  `).all();
  return { total: total.n, byCheckpoint };
}

function checkScores(db) {
  const todayScores = db.prepare(`
    SELECT COUNT(*) as n,
      AVG(ts.overall_score) as avg_score,
      MIN(ts.overall_score) as min_score,
      MAX(ts.overall_score) as max_score
    FROM token_scores ts
    JOIN token_snapshots s ON s.id = ts.snapshot_id
    WHERE DATE(s.snapshot_at) = ?
  `).get(today);
  return todayScores;
}

function checkUniverse(db) {
  const active = db.prepare("SELECT COUNT(*) as n FROM token_universe WHERE active = 1").get();
  const withCg = db.prepare("SELECT COUNT(*) as n FROM token_universe WHERE active = 1 AND coingecko_id IS NOT NULL").get();
  return { active: active.n, withCoingecko: withCg.n };
}

async function main() {
  const issues = [];
  const fixes = [];

  // 1. Server check
  const server = await checkServer();
  if (!server.up) {
    issues.push('🔴 Server Clawnkers DOWN');
    // Auto-fix attempt
    try {
      const { execSync } = await import('child_process');
      execSync('cd ~/clawd/projects/clawnkers && node server.js &', { stdio: 'ignore', timeout: 5000 });
      fixes.push('🔧 Attempted server restart');
    } catch {
      fixes.push('❌ Server restart failed');
    }
  }

  // 2-5. DB checks
  let db;
  try {
    db = getCalibrationDb();
  } catch (err) {
    issues.push(`🔴 Cannot open calibration DB: ${err.message}`);
    console.log(buildReport(server, null, null, null, null, issues, fixes));
    return;
  }

  const snapshots = checkSnapshots(db);
  const outcomes = checkOutcomes(db);
  const scores = checkScores(db);
  const universe = checkUniverse(db);

  // Evaluate health
  if (snapshots.today.total === 0) {
    issues.push('🔴 Zero snapshots today — batch scanner may not have run');
  } else if (snapshots.today.total < 50) {
    issues.push(`🟡 Only ${snapshots.today.total} snapshots today (expected ~100)`);
  }

  const priceCoverage = snapshots.today.total > 0
    ? ((snapshots.today.with_price / snapshots.today.total) * 100).toFixed(0)
    : 0;
  if (Number(priceCoverage) < 70 && snapshots.today.total > 0) {
    issues.push(`🟡 Price coverage today: ${priceCoverage}% (target: >90%)`);
  }

  // Build report
  const lines = [];
  lines.push(`## 🧪 Data Health Check — ${today}`);
  lines.push('');
  lines.push(`**Server:** ${server.up ? '🟢 UP' : '🔴 DOWN'}`);
  lines.push('');
  lines.push('### Snapshots');
  lines.push(`- Today: ${snapshots.today.total} (${snapshots.today.with_price} with price, ${priceCoverage}%)`);
  lines.push(`- Yesterday: ${snapshots.yesterday.total} (${snapshots.yesterday.with_price} with price)`);
  lines.push(`- All time: ${snapshots.allTime.total} (${snapshots.allTime.with_price} with price, ${((snapshots.allTime.with_price/snapshots.allTime.total)*100).toFixed(0)}%)`);
  lines.push('');
  lines.push('### Scores (today)');
  if (scores.n > 0) {
    lines.push(`- Count: ${scores.n}`);
    lines.push(`- Avg: ${Number(scores.avg_score).toFixed(2)} | Min: ${Number(scores.min_score).toFixed(2)} | Max: ${Number(scores.max_score).toFixed(2)}`);
  } else {
    lines.push('- No scores today');
  }
  lines.push('');
  lines.push('### Outcomes');
  lines.push(`- Total: ${outcomes.total}`);
  if (outcomes.byCheckpoint.length > 0) {
    lines.push(`- By checkpoint: ${outcomes.byCheckpoint.map(c => `${c.days_forward}d: ${c.n}`).join(', ')}`);
  } else {
    lines.push('- No outcomes yet');
  }
  lines.push('');
  lines.push('### Universe');
  lines.push(`- Active tokens: ${universe.active} (${universe.withCoingecko} with CoinGecko ID)`);
  lines.push('');

  if (issues.length > 0) {
    lines.push('### ⚠️ Issues');
    issues.forEach(i => lines.push(`- ${i}`));
  }
  if (fixes.length > 0) {
    lines.push('### 🔧 Auto-fixes');
    fixes.forEach(f => lines.push(`- ${f}`));
  }
  if (issues.length === 0) {
    lines.push('### ✅ All checks passed');
  }

  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error(`[health-check] Fatal: ${err.message}`);
  process.exit(1);
});
