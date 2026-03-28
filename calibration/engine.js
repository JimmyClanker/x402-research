#!/usr/bin/env node
/**
 * Calibration Engine v1.0 — Analyze scoring effectiveness from real outcomes
 * 
 * Reads outcomes from calibration.db and computes:
 * - Per-dimension correlation with forward returns (vs BTC)
 * - Suggested weight adjustments
 * - Score bucket performance analysis
 * - Dataset health metrics
 * 
 * Usage: node calibration/engine.js --analyze [--json] [--apply]
 * 
 * Created: 29 Mar 2026
 */

import { getCalibrationDb } from './db.js';
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const DIMENSIONS = [
  { key: 'market_score', label: 'Market Strength', currentWeight: 0.19 },
  { key: 'onchain_score', label: 'Onchain Health', currentWeight: 0.19 },
  { key: 'social_score', label: 'Social Momentum', currentWeight: 0.12 },
  { key: 'dev_score', label: 'Development', currentWeight: 0.16 },
  { key: 'tokenomics_score', label: 'Tokenomics', currentWeight: 0.14 },
  { key: 'distribution_score', label: 'Distribution', currentWeight: 0.14 },
  { key: 'risk_score', label: 'Risk', currentWeight: 0.10 },
];

/**
 * Calculate Pearson correlation coefficient between two arrays.
 */
function pearsonCorrelation(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, v, i) => a + v * y[i], 0);
  const sumX2 = x.reduce((a, v) => a + v * v, 0);
  const sumY2 = y.reduce((a, v) => a + v * v, 0);
  
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Calculate rank correlation (Spearman) — more robust to outliers.
 */
function spearmanCorrelation(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  
  function rank(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return arr.map(v => sorted.indexOf(v) + 1);
  }
  
  return pearsonCorrelation(rank(x), rank(y));
}

function analyze(db) {
  // Get all outcomes with dimension scores, excluding BTC (benchmark) and stablecoins
  const rows = db.prepare(`
    SELECT 
      ts.project_name,
      s.market_score, s.onchain_score, s.social_score, s.dev_score,
      s.tokenomics_score, s.distribution_score, s.risk_score,
      s.overall_score, s.score_bucket,
      o.return_pct, o.btc_return_pct, o.relative_return_pct,
      o.days_forward
    FROM token_outcomes o
    JOIN token_scores s ON s.snapshot_id = o.snapshot_id
    JOIN token_snapshots ts ON ts.id = o.snapshot_id
    WHERE o.relative_return_pct IS NOT NULL
      AND LOWER(ts.project_name) NOT IN ('bitcoin', 'btc')
      AND LOWER(ts.project_name) NOT IN ('tether', 'usd-coin', 'dai', 'usds', 'ethena-usde', 'paypal-usd', 'global-dollar', 'hashnote-usyc', 'usd1-wlfi', 'falcon-finance')
    ORDER BY ts.project_name
  `).all();

  if (rows.length < 10) {
    console.error(`[engine] Only ${rows.length} valid outcomes (need ≥10 for analysis). Run more batch scans first.`);
    return null;
  }

  console.log(`\n📊 CALIBRATION ANALYSIS — ${rows.length} outcomes on ${new Set(rows.map(r => r.project_name.toLowerCase())).size} unique tokens\n`);

  // 1. Per-dimension correlation analysis
  console.log('═══ DIMENSION CORRELATIONS ═══');
  const dimAnalysis = [];
  
  for (const dim of DIMENSIONS) {
    const scores = rows.map(r => r[dim.key]).filter(v => v != null);
    const returns = rows
      .filter(r => r[dim.key] != null)
      .map(r => r.relative_return_pct);

    if (scores.length < 5) {
      console.log(`  ${dim.label}: insufficient data (${scores.length} points)`);
      dimAnalysis.push({ ...dim, pearson: null, spearman: null, n: scores.length });
      continue;
    }

    const pearson = pearsonCorrelation(scores, returns);
    const spearman = spearmanCorrelation(scores, returns);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

    // High-score vs low-score performance
    const median = [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)];
    const highScoreReturns = returns.filter((_, i) => scores[i] >= median);
    const lowScoreReturns = returns.filter((_, i) => scores[i] < median);
    const highAvg = highScoreReturns.length ? highScoreReturns.reduce((a, b) => a + b, 0) / highScoreReturns.length : null;
    const lowAvg = lowScoreReturns.length ? lowScoreReturns.reduce((a, b) => a + b, 0) / lowScoreReturns.length : null;

    const signal = pearson > 0.15 ? '🟢 predictive' :
                   pearson > 0 ? '🟡 weak signal' :
                   pearson > -0.15 ? '⚪ noise' : '🔴 inverted';

    console.log(`  ${dim.label} (weight ${dim.currentWeight}):`);
    console.log(`    Pearson r=${pearson?.toFixed(3) ?? 'n/a'}, Spearman ρ=${spearman?.toFixed(3) ?? 'n/a'} (n=${scores.length}) ${signal}`);
    console.log(`    High-score avg return: ${highAvg?.toFixed(2) ?? 'n/a'}% | Low-score avg: ${lowAvg?.toFixed(2) ?? 'n/a'}%`);

    dimAnalysis.push({
      ...dim,
      pearson: pearson != null ? Math.round(pearson * 1000) / 1000 : null,
      spearman: spearman != null ? Math.round(spearman * 1000) / 1000 : null,
      n: scores.length,
      avgScore: Math.round(avgScore * 100) / 100,
      highScoreAvgReturn: highAvg != null ? Math.round(highAvg * 100) / 100 : null,
      lowScoreAvgReturn: lowAvg != null ? Math.round(lowAvg * 100) / 100 : null,
      signal,
    });
  }

  // 2. Overall score performance
  console.log('\n═══ SCORE BUCKET PERFORMANCE ═══');
  const buckets = {};
  for (const row of rows) {
    const bucket = row.score_bucket || 'unknown';
    if (!buckets[bucket]) buckets[bucket] = { returns: [], tokens: new Set() };
    buckets[bucket].returns.push(row.relative_return_pct);
    buckets[bucket].tokens.add(row.project_name.toLowerCase());
  }

  const bucketAnalysis = [];
  for (const [bucket, data] of Object.entries(buckets).sort()) {
    const avg = data.returns.reduce((a, b) => a + b, 0) / data.returns.length;
    const positiveRate = data.returns.filter(r => r > 0).length / data.returns.length * 100;
    const median = [...data.returns].sort((a, b) => a - b)[Math.floor(data.returns.length / 2)];
    
    console.log(`  ${bucket}: ${data.returns.length} outcomes (${data.tokens.size} tokens)`);
    console.log(`    Mean vs BTC: ${avg.toFixed(2)}% | Median: ${median.toFixed(2)}% | % positive: ${positiveRate.toFixed(0)}%`);

    bucketAnalysis.push({
      bucket,
      n: data.returns.length,
      tokens: data.tokens.size,
      meanVsBtc: Math.round(avg * 100) / 100,
      medianVsBtc: Math.round(median * 100) / 100,
      positiveRate: Math.round(positiveRate),
    });
  }

  // 3. Overall correlation
  const overallScores = rows.map(r => r.overall_score);
  const overallReturns = rows.map(r => r.relative_return_pct);
  const overallPearson = pearsonCorrelation(overallScores, overallReturns);
  const overallSpearman = spearmanCorrelation(overallScores, overallReturns);

  console.log('\n═══ OVERALL SCORE EFFECTIVENESS ═══');
  console.log(`  Overall score ↔ relative return: Pearson r=${overallPearson?.toFixed(3)}, Spearman ρ=${overallSpearman?.toFixed(3)}`);

  // 4. Suggested weight adjustments
  console.log('\n═══ WEIGHT SUGGESTIONS ═══');
  const validDims = dimAnalysis.filter(d => d.spearman != null && d.n >= 5);
  
  if (validDims.length >= 3) {
    // Normalize positive correlations to new weights
    const totalCorr = validDims.reduce((sum, d) => {
      const corr = Math.max(d.spearman, 0); // Only positive correlations contribute
      return sum + corr;
    }, 0);

    if (totalCorr > 0) {
      for (const dim of validDims) {
        const corrContribution = Math.max(dim.spearman, 0);
        const suggestedWeight = Math.round(corrContribution / totalCorr * 100) / 100;
        const delta = suggestedWeight - dim.currentWeight;
        const arrow = delta > 0.02 ? '⬆️' : delta < -0.02 ? '⬇️' : '≈';
        console.log(`  ${dim.label}: ${dim.currentWeight} → ${suggestedWeight.toFixed(2)} (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(0)}pp) ${arrow}`);
      }
    }
  } else {
    console.log('  ⚠️ Not enough data for weight suggestions (need ≥3 dimensions with ≥5 data points)');
  }

  // 5. Dataset health
  console.log('\n═══ DATASET HEALTH ═══');
  const uniqueTokens = new Set(rows.map(r => r.project_name.toLowerCase()));
  const dayForwards = new Set(rows.map(r => r.days_forward));
  console.log(`  Outcomes: ${rows.length}`);
  console.log(`  Unique tokens: ${uniqueTokens.size}`);
  console.log(`  Checkpoints: ${[...dayForwards].sort((a, b) => a - b).join(', ')} days`);
  console.log(`  Score range: ${Math.min(...overallScores).toFixed(1)} — ${Math.max(...overallScores).toFixed(1)}`);
  
  // Confidence assessment
  let confidence = 'low';
  if (rows.length >= 100 && uniqueTokens.size >= 30 && dayForwards.size >= 2) confidence = 'high';
  else if (rows.length >= 50 && uniqueTokens.size >= 20) confidence = 'medium';
  console.log(`  Confidence: ${confidence}`);

  const needsMore = [];
  if (rows.length < 100) needsMore.push(`outcomes (have ${rows.length}, need 100+)`);
  if (uniqueTokens.size < 30) needsMore.push(`unique tokens (have ${uniqueTokens.size}, need 30+)`);
  if (dayForwards.size < 2) needsMore.push(`checkpoints (have ${dayForwards.size}, need 2+ — wait for 7d checkpoint)`);
  if (needsMore.length > 0) {
    console.log(`  Needs more: ${needsMore.join(', ')}`);
  }

  return {
    timestamp: new Date().toISOString(),
    outcomes: rows.length,
    uniqueTokens: uniqueTokens.size,
    checkpoints: [...dayForwards].sort((a, b) => a - b),
    confidence,
    overallCorrelation: {
      pearson: overallPearson != null ? Math.round(overallPearson * 1000) / 1000 : null,
      spearman: overallSpearman != null ? Math.round(overallSpearman * 1000) / 1000 : null,
    },
    dimensions: dimAnalysis,
    buckets: bucketAnalysis,
    needsMore,
  };
}

// CLI
const args = process.argv.slice(2);
const jsonMode = args.includes('--json');

const db = getCalibrationDb();
const result = analyze(db);

if (result && jsonMode) {
  const outPath = join(DATA_DIR, 'calibration-analysis.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n💾 Saved to ${outPath}`);
}

if (!result) {
  process.exit(1);
}
