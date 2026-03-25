/**
 * Tests for Phase 3 — Category-Adaptive Weighting
 * scoring/category-weights.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_WEIGHTS,
  CATEGORY_MAP,
  getCategoryWeights,
} from '../scoring/category-weights.js';
import { calculateScores } from '../synthesis/scoring.js';

const DIMS = ['market', 'onchain', 'social', 'development', 'tokenomics', 'distribution', 'risk'];

// ─── Helper ──────────────────────────────────────────────────────────────────

function sumWeights(w) {
  return DIMS.reduce((acc, d) => acc + (w[d] ?? 0), 0);
}

// ─── Test 1: CoinGecko "meme" → meme_token ───────────────────────────────────

test('getCategoryWeights: CoinGecko category "meme" → meme_token, confidence 0.9', () => {
  const rawData = { market: { categories: ['meme', 'ethereum-ecosystem'] } };
  const result = getCategoryWeights(rawData);
  assert.equal(result.category, 'meme_token');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.source, 'coingecko_categories');
  // At confidence 0.9 (>=0.5) weights should be the category weights unchanged
  for (const dim of DIMS) {
    assert.equal(result.weights[dim], CATEGORY_WEIGHTS.meme_token[dim]);
  }
});

// ─── Test 2: DeFiLlama "lending" → defi_lending ──────────────────────────────

test('getCategoryWeights: DeFiLlama category "lending" → defi_lending, confidence 0.9', () => {
  const rawData = { onchain: { category: 'lending', tvl: 500_000_000 } };
  const result = getCategoryWeights(rawData);
  assert.equal(result.category, 'defi_lending');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.source, 'defillama_category');
});

// ─── Test 3: ecosystem.category "ai" → ai_infrastructure, confidence 0.7 ────

test('getCategoryWeights: ecosystem.category "ai" → ai_infrastructure, confidence 0.7', () => {
  const rawData = { ecosystem: { category: 'ai' } };
  const result = getCategoryWeights(rawData);
  assert.equal(result.category, 'ai_infrastructure');
  assert.equal(result.confidence, 0.7);
  assert.equal(result.source, 'llm_ecosystem');
});

// ─── Test 4: TVL + fees but no category → defi_inferred, confidence 0.5 ─────

test('getCategoryWeights: TVL + fees but no category → defi_inferred, confidence 0.5', () => {
  const rawData = { onchain: { tvl: 1_000_000, fees_7d: 50_000 } };
  const result = getCategoryWeights(rawData);
  assert.equal(result.category, 'defi_inferred');
  assert.equal(result.confidence, 0.5);
  assert.equal(result.source, 'heuristic_defi');
});

// ─── Test 5: mentions > 500 + no TVL + no github → meme_inferred ─────────────

test('getCategoryWeights: mentions > 500 + no TVL + no github → meme_inferred, confidence 0.5', () => {
  const rawData = {
    social: { mentions: 600 },
    onchain: { tvl: 0 },
    github: { error: 'not found' },
  };
  const result = getCategoryWeights(rawData);
  assert.equal(result.category, 'meme_inferred');
  assert.equal(result.confidence, 0.5);
  assert.equal(result.source, 'heuristic_meme');
});

// ─── Test 6: no data at all → default, confidence 0.3 ───────────────────────

test('getCategoryWeights: no data → default, confidence 0.3', () => {
  const result = getCategoryWeights({});
  assert.equal(result.category, 'default');
  assert.equal(result.confidence, 0.3);
  assert.equal(result.source, 'fallback');
});

// ─── Test 7: confidence 0.3 → pesi interpolati (mix di categoria + default) ──

test('getCategoryWeights: confidence 0.3 produces interpolated weights (mix category + default)', () => {
  // Force a confidence-0.3 path via fallback
  const result = getCategoryWeights({});
  assert.equal(result.confidence, 0.3);
  const defaultW = CATEGORY_WEIGHTS.default;
  for (const dim of DIMS) {
    // At confidence 0.3, weights = category * 0.3 + default * 0.7
    // Since category IS default here, all weights should still equal default
    const expected = defaultW[dim] * 0.3 + defaultW[dim] * 0.7;
    assert.ok(
      Math.abs(result.weights[dim] - expected) < 0.0001,
      `dim ${dim}: expected ${expected}, got ${result.weights[dim]}`
    );
  }
});

// ─── Test 7b: confidence 0.7 (llm) → pesi identici alla categoria (no interpolation) ─

test('getCategoryWeights: confidence 0.7 (≥0.5) uses category weights directly (no interpolation)', () => {
  const rawData = { ecosystem: { category: 'ai' } };
  const result = getCategoryWeights(rawData);
  assert.equal(result.confidence, 0.7);
  const catW = CATEGORY_WEIGHTS.ai_infrastructure;
  for (const dim of DIMS) {
    assert.equal(
      result.weights[dim], catW[dim],
      `dim ${dim}: expected ${catW[dim]}, got ${result.weights[dim]}`
    );
  }
});

// ─── Test 8: confidence 0.9 → pesi quasi identici alla categoria ─────────────

test('getCategoryWeights: confidence 0.9 → weights equal category weights (no interpolation)', () => {
  const rawData = { market: { categories: ['layer-1'] } };
  const result = getCategoryWeights(rawData);
  assert.equal(result.confidence, 0.9);
  const catW = CATEGORY_WEIGHTS.layer_1;
  for (const dim of DIMS) {
    assert.equal(result.weights[dim], catW[dim], `dim ${dim} mismatch`);
  }
});

// ─── Test 9: tutti i set di pesi sommano a 1.0 ───────────────────────────────

test('CATEGORY_WEIGHTS: all weight sets sum to 1.0 (±0.001)', () => {
  for (const [key, weights] of Object.entries(CATEGORY_WEIGHTS)) {
    const sum = sumWeights(weights);
    assert.ok(
      Math.abs(sum - 1.0) <= 0.001,
      `Weight set "${key}" sums to ${sum.toFixed(6)}, expected 1.0`
    );
  }
});

// ─── Test 10: CATEGORY_MAP copre le chiavi attese ─────────────────────────────

test('CATEGORY_MAP: covers all expected raw category slugs', () => {
  const expectedKeys = [
    'lending', 'borrowing-lending', 'dexes', 'dex', 'yield', 'yield-aggregator',
    'liquid-staking', 'bridge', 'derivatives', 'perpetuals',
    'layer-1', 'layer-2', 'rollup',
    'meme', 'meme-token', 'dog-themed', 'cat-themed',
    'artificial-intelligence', 'ai', 'depin',
    'gaming', 'nft', 'metaverse', 'play-to-earn',
  ];
  for (const key of expectedKeys) {
    assert.ok(
      key in CATEGORY_MAP,
      `CATEGORY_MAP is missing key: "${key}"`
    );
    // Each value should be a valid CATEGORY_WEIGHTS key (excluding 'default')
    const target = CATEGORY_MAP[key];
    assert.ok(
      target in CATEGORY_WEIGHTS,
      `CATEGORY_MAP["${key}"] → "${target}" is not a valid CATEGORY_WEIGHTS key`
    );
  }
});

// ─── Test 11: Integration — calculateScores con dati meme → overall.category ─

test('Integration: calculateScores with meme data → overall.category present', () => {
  const rawData = {
    market: {
      categories: ['meme'],
      current_price: 0.0001,
      market_cap: 1_000_000,
      total_volume: 100_000,
    },
    social: { mentions: 800, sentiment_score: 0.3 },
    onchain: {},
    github: { error: 'no github' },
    tokenomics: { pct_circulating: 80, inflation_rate: 0 },
  };
  const scores = calculateScores(rawData);
  assert.ok(scores.overall.category, 'overall.category should be set');
  assert.equal(scores.overall.category, 'meme_token');
  assert.equal(scores.overall.category_source, 'coingecko_categories');
  assert.equal(scores.overall.category_confidence, 0.9);
  assert.ok(scores.overall.weights_used, 'weights_used should be present');
  // Weights should include all 7 dims
  for (const dim of DIMS) {
    assert.ok(
      typeof scores.overall.weights_used[dim] === 'number',
      `weights_used.${dim} should be a number`
    );
  }
});

// ─── Test 12: Integration — calculateScores without category → default weights ─

test('Integration: calculateScores without category data → uses default weights', () => {
  const rawData = {
    market: { current_price: 1, market_cap: 5_000_000, total_volume: 200_000 },
    social: { mentions: 50 },
    onchain: {},
    github: {},
    tokenomics: { pct_circulating: 60 },
  };
  const scores = calculateScores(rawData);
  assert.equal(scores.overall.category, 'default');
  assert.equal(scores.overall.category_source, 'fallback');
  assert.ok(
    typeof scores.overall.category_confidence === 'number',
    'category_confidence should be a number'
  );
  // Weights should be interpolated blend (confidence 0.3)
  assert.ok(scores.overall.weights_used, 'weights_used should be present');
});
