#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { getCalibrationDb } from './db.js';

const DEFAULT_OUT = resolve(process.cwd(), 'ops', 'calibration-report-latest.md');
const DAYS = Number(process.argv.find((v, i, a) => a[i - 1] === '--days') || 30);
const OUT = process.argv.includes('--out')
  ? resolve(process.cwd(), process.argv[process.argv.indexOf('--out') + 1])
  : DEFAULT_OUT;

function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return 'n/a';
  return `${Number(v).toFixed(2)}%`;
}

function fmtNum(v) {
  if (v == null || !Number.isFinite(Number(v))) return 'n/a';
  return Number(v).toFixed(2);
}

function getAvailableDays(db) {
  return db.prepare(`
    SELECT days_forward, COUNT(*) AS samples
    FROM token_outcomes
    WHERE relative_return_pct IS NOT NULL
    GROUP BY days_forward
    ORDER BY days_forward ASC
  `).all();
}

function resolveDays(db, requestedDays) {
  const available = getAvailableDays(db);
  const exact = available.find((r) => Number(r.days_forward) === Number(requestedDays));
  if (exact) return { requestedDays, resolvedDays: requestedDays, available, exact: true };
  if (!available.length) return { requestedDays, resolvedDays: requestedDays, available, exact: true };
  const fallback = available[0].days_forward;
  return { requestedDays, resolvedDays: fallback, available, exact: false };
}

function getOverview(db, days) {
  return db.prepare(`
    SELECT
      COUNT(*) AS samples,
      AVG(o.return_pct) AS avg_return,
      AVG(o.btc_return_pct) AS avg_btc_return,
      AVG(o.relative_return_pct) AS avg_relative_return,
      AVG(ts.overall_score) AS avg_score
    FROM token_outcomes o
    JOIN token_scores ts ON ts.snapshot_id = o.snapshot_id
    WHERE o.days_forward = ?
      AND o.relative_return_pct IS NOT NULL
      AND ts.overall_score IS NOT NULL
  `).get(days);
}

function getBucketStats(db, days) {
  return db.prepare(`
    SELECT
      COALESCE(ts.score_bucket, 'unbucketed') AS score_bucket,
      COUNT(*) AS samples,
      AVG(o.return_pct) AS avg_return,
      AVG(o.btc_return_pct) AS avg_btc_return,
      AVG(o.relative_return_pct) AS avg_relative_return,
      SUM(CASE WHEN o.relative_return_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS win_rate_vs_btc,
      SUM(CASE WHEN o.return_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS win_rate_abs
    FROM token_outcomes o
    JOIN token_scores ts ON ts.snapshot_id = o.snapshot_id
    WHERE o.days_forward = ?
      AND o.relative_return_pct IS NOT NULL
    GROUP BY COALESCE(ts.score_bucket, 'unbucketed')
    ORDER BY CASE COALESCE(ts.score_bucket, 'unbucketed')
      WHEN '0-3' THEN 1
      WHEN '3-5' THEN 2
      WHEN '5-7' THEN 3
      WHEN '7-10' THEN 4
      ELSE 99 END
  `).all(days);
}

function getCategoryStats(db, days) {
  return db.prepare(`
    SELECT
      COALESCE(ts.category, 'unknown') AS category,
      COUNT(*) AS samples,
      AVG(ts.overall_score) AS avg_score,
      AVG(o.relative_return_pct) AS avg_relative_return,
      SUM(CASE WHEN o.relative_return_pct > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS win_rate_vs_btc
    FROM token_outcomes o
    JOIN token_scores ts ON ts.snapshot_id = o.snapshot_id
    WHERE o.days_forward = ?
      AND o.relative_return_pct IS NOT NULL
    GROUP BY COALESCE(ts.category, 'unknown')
    HAVING COUNT(*) >= 5
    ORDER BY avg_relative_return DESC
    LIMIT 12
  `).all(days);
}

function getBestWorst(db, days) {
  const best = db.prepare(`
    SELECT s.project_name, ts.overall_score, ts.score_bucket, o.relative_return_pct
    FROM token_outcomes o
    JOIN token_scores ts ON ts.snapshot_id = o.snapshot_id
    JOIN token_snapshots s ON s.id = o.snapshot_id
    WHERE o.days_forward = ? AND o.relative_return_pct IS NOT NULL
    ORDER BY o.relative_return_pct DESC LIMIT 5
  `).all(days);

  const worst = db.prepare(`
    SELECT s.project_name, ts.overall_score, ts.score_bucket, o.relative_return_pct
    FROM token_outcomes o
    JOIN token_scores ts ON ts.snapshot_id = o.snapshot_id
    JOIN token_snapshots s ON s.id = o.snapshot_id
    WHERE o.days_forward = ? AND o.relative_return_pct IS NOT NULL
    ORDER BY o.relative_return_pct ASC LIMIT 5
  `).all(days);

  return { best, worst };
}

function buildMarkdown({ requestedDays, resolvedDays, exact, available, overview, buckets, categories, bestWorst }) {
  const lines = [];
  lines.push(`# Calibration Report — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Window richiesta: **${requestedDays} giorni forward**`);
  lines.push(`Window usata: **${resolvedDays} giorni forward**${exact ? '' : ' _(fallback automatico)_'} `);
  lines.push('');
  lines.push('## Available checkpoints');
  if (!available.length) {
    lines.push('- Nessun outcome relativo vs BTC disponibile ancora.');
  } else {
    for (const row of available) {
      lines.push(`- ${row.days_forward}d → ${row.samples} samples`);
    }
  }
  lines.push('');
  lines.push('');
  lines.push('## Overview');
  lines.push(`- Samples: **${overview?.samples ?? 0}**`);
  lines.push(`- Avg overall score: **${fmtNum(overview?.avg_score)}**`);
  lines.push(`- Avg absolute return: **${fmtPct(overview?.avg_return)}**`);
  lines.push(`- Avg BTC return: **${fmtPct(overview?.avg_btc_return)}**`);
  lines.push(`- Avg relative return vs BTC: **${fmtPct(overview?.avg_relative_return)}**`);
  lines.push('');
  lines.push('## Score buckets');
  lines.push('');
  lines.push('| Bucket | Samples | Avg return | Avg vs BTC | Win rate vs BTC | Win rate abs |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const row of buckets) {
    lines.push(`| ${row.score_bucket} | ${row.samples} | ${fmtPct(row.avg_return)} | ${fmtPct(row.avg_relative_return)} | ${fmtPct((row.win_rate_vs_btc ?? 0) * 100)} | ${fmtPct((row.win_rate_abs ?? 0) * 100)} |`);
  }
  lines.push('');
  lines.push('## Category performance (min 5 samples)');
  lines.push('');
  lines.push('| Category | Samples | Avg score | Avg vs BTC | Win rate vs BTC |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const row of categories) {
    lines.push(`| ${row.category} | ${row.samples} | ${fmtNum(row.avg_score)} | ${fmtPct(row.avg_relative_return)} | ${fmtPct((row.win_rate_vs_btc ?? 0) * 100)} |`);
  }
  lines.push('');
  lines.push('## Best relative performers');
  for (const row of bestWorst.best) {
    lines.push(`- ${row.project_name} — score ${fmtNum(row.overall_score)} (${row.score_bucket || 'n/a'}) → ${fmtPct(row.relative_return_pct)} vs BTC`);
  }
  lines.push('');
  lines.push('## Worst relative performers');
  for (const row of bestWorst.worst) {
    lines.push(`- ${row.project_name} — score ${fmtNum(row.overall_score)} (${row.score_bucket || 'n/a'}) → ${fmtPct(row.relative_return_pct)} vs BTC`);
  }
  lines.push('');
  lines.push('## Initial read');
  if ((overview?.samples ?? 0) < 20) {
    lines.push('- Dataset ancora piccolo: leggere il report come segnale iniziale, non come verità statistica.');
  } else {
    const topBucket = buckets[buckets.length - 1];
    const midBucket = buckets.find((b) => b.score_bucket === '5-7');
    if (topBucket?.avg_relative_return != null && midBucket?.avg_relative_return != null) {
      lines.push(`- Bucket alto (${topBucket.score_bucket}) vs bucket medio (5-7): ${fmtPct(topBucket.avg_relative_return)} vs ${fmtPct(midBucket.avg_relative_return)} relative return.`);
    }
    lines.push('- Usare questo report come base per future proposte di reweighting, non per cambiare i pesi in produzione immediatamente.');
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const db = getCalibrationDb();
  const resolution = resolveDays(db, DAYS);
  const overview = getOverview(db, resolution.resolvedDays);
  const buckets = getBucketStats(db, resolution.resolvedDays);
  const categories = getCategoryStats(db, resolution.resolvedDays);
  const bestWorst = getBestWorst(db, resolution.resolvedDays);
  const md = buildMarkdown({
    requestedDays: resolution.requestedDays,
    resolvedDays: resolution.resolvedDays,
    exact: resolution.exact,
    available: resolution.available,
    overview,
    buckets,
    categories,
    bestWorst,
  });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md);
  console.log(`Wrote ${OUT}`);
  console.log(`requested=${resolution.requestedDays} resolved=${resolution.resolvedDays} samples=${overview?.samples ?? 0} buckets=${buckets.length} categories=${categories.length}`);
}

main();
