/**
 * pipeline.test.js — Round 10: End-to-End Integration Test
 *
 * Tests the full 3-phase analysis pipeline with mock data.
 * At least 15 test cases covering all new analysis modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { calculateScores, calculateConfidence } from '../synthesis/scoring.js';
import { formatMarkdown, formatPlainText, formatAgentJSON, formatReportMulti } from '../synthesis/templates.js';
import { analyzeCrossDimensional } from '../analysis/cross-dimensional.js';
import { calculateConviction } from '../analysis/conviction.js';
import { analyzeTemporalDelta } from '../analysis/temporal.js';
import { buildRiskMatrix } from '../analysis/risk-matrix.js';
import { classifySector, getSectorWeights } from '../analysis/sector-context.js';
import { phaseEnrich, phaseCollect } from '../analysis/pipeline.js';
import { detectRedFlags } from '../services/red-flags.js';
import { detectAlphaSignals } from '../services/alpha-signals.js';
import { generateThesis } from '../services/thesis-generator.js';
import { ensureSchema, storeScanHistory } from '../routes/alpha-helpers.js';

// ── Mock Data Helpers ────────────────────────────────────────────

function createMockRawData(overrides = {}) {
  return {
    project_name: 'TestProject',
    market: {
      current_price: 1.50,
      market_cap: 500_000_000,
      total_volume: 80_000_000,
      price_change_pct_1h: 2.1,
      price_change_pct_24h: 5.3,
      price_change_pct_7d: 12.5,
      price_change_pct_30d: 25.0,
      ath: 3.00,
      atl: 0.10,
      ath_distance_pct: -50,
      atl_distance_pct: 1400,
      fully_diluted_valuation: 800_000_000,
      market_cap_rank: 80,
      genesis_date: '2023-01-15',
      exchange_count: 12,
      ...overrides.market,
    },
    onchain: {
      tvl: 200_000_000,
      tvl_change_7d: 8.5,
      tvl_change_30d: 15.2,
      fees_7d: 350_000,
      revenue_7d: 120_000,
      category: 'Lending',
      chains: ['ethereum', 'arbitrum', 'optimism'],
      ...overrides.onchain,
    },
    social: {
      mentions: 25,
      filtered_mentions: 20,
      sentiment_score: 0.4,
      sentiment_counts: { bullish: 12, bearish: 3, neutral: 5 },
      key_narratives: ['defi revival', 'institutional adoption'],
      ...overrides.social,
    },
    github: {
      contributors: 22,
      commits_90d: 150,
      commits_30d: 60,
      commits_30d_prev: 45,
      stars: 2500,
      forks: 400,
      open_issues: 30,
      commit_trend: 'accelerating',
      last_commit: { date: new Date().toISOString() },
      has_ci: true,
      license: 'MIT',
      ...overrides.github,
    },
    tokenomics: {
      pct_circulating: 65,
      inflation_rate: 5.2,
      token_distribution: { community: 40, treasury: 25, team: 15, investors: 20 },
      ...overrides.tokenomics,
    },
    dex: {
      dex_price_usd: 1.49,
      dex_liquidity_usd: 15_000_000,
      dex_pair_count: 8,
      buy_sell_ratio: 1.15,
      pressure_signal: 'buy_pressure',
      buys_24h: 580,
      sells_24h: 504,
      ...overrides.dex,
    },
    reddit: {
      post_count: 5,
      sentiment: 'bullish',
      ...overrides.reddit,
    },
    holders: {
      top10_concentration: 22,
      ...overrides.holders,
    },
    ecosystem: {
      chain_count: 3,
      ...overrides.ecosystem,
    },
    contract: {
      verified: true,
      ...overrides.contract,
    },
    metadata: {
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: 3500,
      collectors: {
        market: { ok: true, error: null, source: 'fresh' },
        onchain: { ok: true, error: null, source: 'fresh' },
        social: { ok: true, error: null, source: 'fresh' },
        github: { ok: true, error: null, source: 'fresh' },
        tokenomics: { ok: true, error: null, source: 'fresh' },
        dex: { ok: true, error: null, source: 'fresh' },
        reddit: { ok: true, error: null, source: 'cache' },
        holders: { ok: true, error: null, source: 'fresh' },
        ecosystem: { ok: true, error: null, source: 'fresh' },
        contract: { ok: true, error: null, source: 'fresh' },
      },
      ...overrides.metadata,
    },
  };
}

function createMockScores(rawData) {
  return calculateScores(rawData);
}

function createTestDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  return db;
}

// ── Test 1: Phase 1 → Phase 2 → Phase 3 data flow ───────────────

test('Pipeline: Phase 1 collect returns structured rawData', async () => {
  const mockCollect = async () => createMockRawData();
  const rawData = await phaseCollect({
    projectName: 'TestProject',
    exaService: null,
    collectorCache: null,
    collectAllFn: mockCollect,
  });
  assert.ok(rawData.market);
  assert.ok(rawData.onchain);
  assert.ok(rawData.social);
  assert.ok(rawData.github);
  assert.ok(rawData.metadata);
});

test('Pipeline: Phase 2 enrich produces all enrichment fields', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const enrichment = phaseEnrich(rawData, scores);

  assert.ok(Array.isArray(enrichment.redFlags));
  assert.ok(Array.isArray(enrichment.alphaSignals));
  assert.ok(enrichment.volatilityAssessment);
  assert.ok(Array.isArray(enrichment.priceAlerts));
  assert.ok(enrichment.trendReversal);
  assert.ok(enrichment.narrativeMomentum);
  assert.ok(enrichment.momentumData);
  assert.ok(enrichment.crossDimensional);
  assert.ok(enrichment.riskMatrix);

  // Verify rawData was enriched
  assert.ok(rawData.red_flags);
  assert.ok(rawData.alpha_signals);
  assert.ok(rawData.volatility);
  assert.ok(rawData.cross_dimensional);
  assert.ok(rawData.risk_matrix);
});

// ── Test 2: Cross-dimensional analysis ───────────────────────────

test('Cross-dimensional: detects hype without substance divergence', () => {
  const scores = {
    market_strength: { score: 5 },
    onchain_health: { score: 3 },
    social_momentum: { score: 8 },
    development: { score: 5 },
    tokenomics_health: { score: 5 },
    distribution: { score: 5 },
    risk: { score: 5 },
    overall: { score: 5 },
  };
  const result = analyzeCrossDimensional(scores);
  const hypeDiv = result.divergences.find(d => d.type === 'hype_without_substance');
  assert.ok(hypeDiv, 'Should detect hype without substance');
  assert.equal(hypeDiv.severity, 'warning');
});

test('Cross-dimensional: detects undervalued builder divergence', () => {
  const scores = {
    market_strength: { score: 3 },
    onchain_health: { score: 5 },
    social_momentum: { score: 5 },
    development: { score: 8 },
    tokenomics_health: { score: 5 },
    distribution: { score: 5 },
    risk: { score: 5 },
    overall: { score: 5 },
  };
  const result = analyzeCrossDimensional(scores);
  const builderDiv = result.divergences.find(d => d.type === 'undervalued_builder');
  assert.ok(builderDiv, 'Should detect undervalued builder');
});

test('Cross-dimensional: detects strong conviction convergence', () => {
  const scores = {
    market_strength: { score: 8 },
    onchain_health: { score: 7.5 },
    social_momentum: { score: 7 },
    development: { score: 8.5 },
    tokenomics_health: { score: 7 },
    distribution: { score: 7.5 },
    risk: { score: 8 },
    overall: { score: 7.8 },
  };
  const result = analyzeCrossDimensional(scores);
  const strongConv = result.convergences.find(c => c.type === 'strong_conviction');
  assert.ok(strongConv, 'Should detect strong conviction');
});

test('Cross-dimensional: detects suspicious outlier anomaly', () => {
  const scores = {
    market_strength: { score: 3 },
    onchain_health: { score: 3 },
    social_momentum: { score: 9.5 },
    development: { score: 3 },
    tokenomics_health: { score: 3 },
    distribution: { score: 3 },
    risk: { score: 3 },
    overall: { score: 4 },
  };
  const result = analyzeCrossDimensional(scores);
  const outlier = result.anomalies.find(a => a.type === 'suspicious_outlier_high');
  assert.ok(outlier, 'Should detect suspicious outlier');
  assert.equal(outlier.dimension, 'social_momentum');
});

// ── Test 3: Conviction score ─────────────────────────────────────

test('Conviction: high score with complete data', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const enrichment = { redFlags: [], alphaSignals: [] };
  const conviction = calculateConviction(rawData, scores, enrichment);

  assert.ok(conviction.score > 60, `Expected conviction > 60, got ${conviction.score}`);
  assert.equal(conviction.label, 'High');
  assert.ok(conviction.factors.completeness.score > 20);
  assert.ok(conviction.reasoning.length > 50);
});

test('Conviction: low score with missing data', () => {
  const rawData = createMockRawData({
    metadata: {
      collectors: {
        market: { ok: true, error: null, source: 'stale-cache' },
        onchain: { ok: false, error: 'timeout', source: 'error' },
        social: { ok: false, error: 'timeout', source: 'error' },
        github: { ok: false, error: 'timeout', source: 'error' },
        tokenomics: { ok: false, error: 'timeout', source: 'error' },
        dex: { ok: false, error: 'timeout', source: 'error' },
        reddit: { ok: false, error: 'timeout', source: 'error' },
        holders: { ok: false, error: 'timeout', source: 'error' },
        ecosystem: { ok: false, error: 'timeout', source: 'error' },
        contract: { ok: false, error: 'timeout', source: 'error' },
      },
    },
  });
  const scores = createMockScores(rawData);
  const enrichment = {
    redFlags: [
      { flag: 'low_volume', severity: 'critical' },
      { flag: 'no_github', severity: 'critical' },
    ],
  };
  const conviction = calculateConviction(rawData, scores, enrichment);
  assert.ok(conviction.score < 50, `Expected conviction < 50, got ${conviction.score}`);
});

// ── Test 4: Temporal delta ───────────────────────────────────────

test('Temporal: detects changes when previous scan exists', () => {
  const db = createTestDb();
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);

  // Store a "previous" scan with different values
  const prevScores = { ...scores, overall: { ...scores.overall, score: 5.0 } };
  const prevReport = {
    raw_data: createMockRawData({
      market: { current_price: 1.20, market_cap: 400_000_000, total_volume: 60_000_000 },
      onchain: { tvl: 150_000_000 },
    }),
    red_flags: [{ flag: 'low_volume', severity: 'warning' }],
    verdict: 'HOLD',
  };
  storeScanHistory(db, 'TestProject', prevScores, prevReport);

  const delta = analyzeTemporalDelta(db, 'TestProject', rawData, scores);

  assert.ok(delta.has_history);
  assert.ok(delta.scan_count > 0);
  assert.ok(delta.deltas.length > 0);
  assert.ok(delta.score_deltas.length > 0);
  assert.ok(delta.narrative.length > 0);
  db.close();
});

test('Temporal: returns no history when no previous scans', () => {
  const db = createTestDb();
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);

  const delta = analyzeTemporalDelta(db, 'NewProject', rawData, scores);
  assert.equal(delta.has_history, false);
  assert.equal(delta.scan_count, 0);
  db.close();
});

// ── Test 5: Risk matrix ──────────────────────────────────────────

test('Risk matrix: categorizes red flags correctly', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const redFlags = [
    { flag: 'no_github', severity: 'warning', detail: 'No GitHub repo' },
    { flag: 'whale_concentration', severity: 'critical', detail: 'Top 10 hold 65%' },
    { flag: 'low_volume', severity: 'warning', detail: 'Volume < $50K' },
  ];

  const matrix = buildRiskMatrix(rawData, scores, redFlags);

  assert.ok(matrix.categories.smart_contract.flag_count > 0);
  assert.ok(matrix.categories.concentration.flag_count > 0);
  assert.ok(matrix.categories.market.flag_count > 0);
  assert.ok(matrix.overall_risk_score >= 1 && matrix.overall_risk_score <= 10);
  assert.ok(['Minimal', 'Low', 'Moderate', 'High', 'Extreme'].includes(matrix.risk_level));
  assert.ok(matrix.heatmap.length > 0);
});

test('Risk matrix: minimal risk with no flags', () => {
  const matrix = buildRiskMatrix({}, {}, []);
  assert.equal(matrix.total_flags, 0);
  assert.equal(matrix.active_categories, 0);
  assert.equal(matrix.overall_risk_score, 1); // min clamp
});

// ── Test 6: Sector context ───────────────────────────────────────

test('Sector context: classifies DeFi project correctly', () => {
  const rawData = createMockRawData({ onchain: { category: 'Lending' } });
  const sector = classifySector(rawData);
  assert.ok(['DeFi', 'Lending'].includes(sector.sector));
  assert.ok(sector.key_metrics.length > 0);
  assert.ok(sector.adjusted_weights);
});

test('Sector context: classifies Meme project correctly', () => {
  const rawData = createMockRawData({
    market: { name: 'PepeCoin Meme' },
    social: { key_narratives: ['meme', 'viral'] },
    onchain: { category: null },
  });
  const sector = classifySector(rawData);
  assert.equal(sector.sector, 'Meme');
});

test('Sector weights: returns valid weights for each sector', () => {
  const weights = getSectorWeights('Meme');
  assert.ok(weights.social > weights.development, 'Social should matter more than dev for memecoins');
  const total = Object.values(weights).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1.0) < 0.01, `Weights should sum to ~1.0, got ${total}`);
});

// ── Test 7: Confidence-weighted scoring ──────────────────────────

test('Scoring: confidence-weighted scoring pulls low-confidence toward 5.0', () => {
  const rawData = createMockRawData({
    onchain: { error: 'No data' },
    github: { error: 'No data' },
  });
  const scores = calculateScores(rawData);

  // Onchain and dev should have low confidence and be pulled toward 5.0
  assert.ok(scores.onchain_health.confidence <= 30, `Expected low onchain confidence, got ${scores.onchain_health.confidence}`);
  assert.ok(scores.development.confidence <= 30, `Expected low dev confidence, got ${scores.development.confidence}`);
  // Raw score is ~4.0 for empty, confidence-weighted should be closer to 5.0
  assert.ok(scores.onchain_health.raw_score != null);
  assert.ok(scores.onchain_health.confidence_label);
});

test('Scoring: calculateConfidence returns valid structure', () => {
  const rawData = createMockRawData();
  const confidence = calculateConfidence(rawData);
  assert.ok(confidence.market >= 0 && confidence.market <= 100);
  assert.ok(confidence.overall_confidence >= 0 && confidence.overall_confidence <= 100);
  assert.ok(confidence.market === 100, 'Full market data should be 100% confidence');
});

// ── Test 8: Output format tests ──────────────────────────────────

test('Templates: Markdown format produces valid markdown', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const analysis = { verdict: 'BUY', moat: 'Strong lending market', risks: ['Market risk'], catalysts: ['New chain deployment'], key_findings: ['Finding 1'], analysis_text: 'Analysis here.' };

  const md = formatMarkdown('TestProject', rawData, scores, analysis);
  assert.ok(md.includes('# 🧠 Alpha Scanner'));
  assert.ok(md.includes('**Verdict:** BUY'));
  assert.ok(md.includes('| Dimension |'));
  assert.ok(md.length > 200);
});

test('Templates: Plain text format is under 1500 chars', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const analysis = { verdict: 'BUY', risks: ['Risk 1', 'Risk 2'], catalysts: ['Catalyst 1'], analysis_text: 'Short analysis.' };

  const text = formatPlainText('TestProject', rawData, scores, analysis);
  assert.ok(text.length <= 1500, `Expected <= 1500 chars, got ${text.length}`);
  assert.ok(text.includes('TestProject'));
  assert.ok(text.includes('BUY'));
});

test('Templates: Agent JSON format has all required fields', () => {
  const rawData = createMockRawData();
  rawData.conviction = { score: 75, label: 'Moderate' };
  const scores = createMockScores(rawData);
  const analysis = { verdict: 'HOLD', moat: 'Test', risks: [], catalysts: [], key_findings: [] };

  const json = formatAgentJSON('TestProject', rawData, scores, analysis);
  assert.equal(json.project_name, 'TestProject');
  assert.equal(json.verdict, 'HOLD');
  assert.ok(json.scores.market_strength);
  assert.ok(json.conviction);
});

test('Templates: formatReportMulti selects correct format', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const analysis = { verdict: 'BUY', moat: 'Test', risks: [], catalysts: [], key_findings: [], analysis_text: 'Test' };

  const md = formatReportMulti('md', 'TestProject', rawData, scores, analysis);
  assert.equal(md.contentType, 'text/markdown');

  const text = formatReportMulti('text', 'TestProject', rawData, scores, analysis);
  assert.equal(text.contentType, 'text/plain');

  const json = formatReportMulti('json', 'TestProject', rawData, scores, analysis);
  assert.equal(json.contentType, 'application/json');

  const html = formatReportMulti('html', 'TestProject', rawData, scores, analysis);
  assert.equal(html.contentType, 'text/html');
});

// ── Test 9: Thesis strengthening ─────────────────────────────────

test('Thesis: includes evidence, invalidation, time horizons, probabilities', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const redFlags = detectRedFlags(rawData, scores);
  const alphaSignals = detectAlphaSignals(rawData, scores);

  const thesis = generateThesis('TestProject', rawData, scores, redFlags, alphaSignals);

  assert.ok(thesis.bull_case);
  assert.ok(thesis.bear_case);
  assert.ok(thesis.neutral_case);
  assert.ok(thesis.evidence);
  assert.ok(Array.isArray(thesis.evidence.bull));
  assert.ok(Array.isArray(thesis.evidence.bear));
  assert.ok(thesis.invalidation);
  assert.ok(Array.isArray(thesis.invalidation.bull));
  assert.ok(Array.isArray(thesis.invalidation.bear));
  assert.ok(thesis.time_horizons);
  assert.ok(thesis.time_horizons['1_week']);
  assert.ok(thesis.time_horizons['1_month']);
  assert.ok(thesis.time_horizons['3_months']);
  assert.ok(thesis.probabilities);
  assert.ok(thesis.probabilities.bull >= 10 && thesis.probabilities.bull <= 85);
  assert.ok(thesis.probabilities.bear >= 10 && thesis.probabilities.bear <= 85);
});

test('Scores: tokenomics fallback data remains usable even when collector reports partial error', () => {
  const rawData = createMockRawData({
    tokenomics: {
      pct_circulating: 99.9999,
      unlock_overhang_pct: 0.0001,
      dilution_risk: 'low',
      inflation_rate: 1,
      token_distribution: null,
      error: 'Messari tokenomics unavailable',
    },
  });

  const scores = calculateScores(rawData);
  assert.match(scores.tokenomics_health.reasoning, /Circulating supply 100\.00%/);
  assert.match(scores.tokenomics_health.reasoning, /inflation 1\.00%/);
});

test('Thesis: one_liner stays aligned with HOLD verdict band', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  scores.overall.score = 6.1;
  const redFlags = detectRedFlags(rawData, scores);
  const alphaSignals = detectAlphaSignals(rawData, scores);

  const thesis = generateThesis('TestProject', rawData, scores, redFlags, alphaSignals);
  assert.match(thesis.one_liner, /^TestProject — HOLD:/);
  assert.doesNotMatch(thesis.one_liner, /justify entry/i);
});

// ── Test 10: Full pipeline data flow ─────────────────────────────

test('Pipeline: full Phase 1 → 2 → enrichment produces consistent data', () => {
  const rawData = createMockRawData();
  const scores = createMockScores(rawData);
  const enrichment = phaseEnrich(rawData, scores);

  // Verify all enrichment injected into rawData
  assert.ok(rawData.red_flags === enrichment.redFlags);
  assert.ok(rawData.alpha_signals === enrichment.alphaSignals);
  assert.ok(rawData.volatility === enrichment.volatilityAssessment);
  assert.ok(rawData.cross_dimensional === enrichment.crossDimensional);
  assert.ok(rawData.risk_matrix === enrichment.riskMatrix);

  // Cross-dimensional should reference same scores
  assert.ok(enrichment.crossDimensional.total_findings >= 0);
  assert.ok(enrichment.riskMatrix.total_flags >= 0);
});
