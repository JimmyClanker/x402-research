import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../app.js';
import { createSignalsService } from '../services/signals.js';
import { calculateScores } from '../synthesis/scoring.js';
import { getCalibrationDb, getSnapshotsForOutcomeTracking, __resetCalibrationDbForTests } from '../calibration/db.js';
import {
  storeScanSnapshot,
  __resetSnapshotStoreForTests,
  __setSnapshotStoreHooksForTests,
  __extractSnapshotRecordForTests,
} from '../calibration/snapshot-store.js';

function createRawData(overrides = {}) {
  return {
    project_name: 'Bitcoin',
    market: {
      symbol: 'BTC',
      name: 'Bitcoin',
      coingecko_id: 'bitcoin',
      current_price: 68234.12,
      market_cap: 1320000000000,
      fully_diluted_valuation: 1430000000000,
      total_volume: 42000000000,
      price_change_pct_1h: 0.6,
      price_change_pct_24h: 4.4,
      price_change_pct_7d: 10.2,
      price_change_pct_30d: 18.9,
      ath_distance_pct: -6.5,
      ...overrides.market,
    },
    onchain: {
      category: 'store-of-value',
      chain: 'bitcoin',
      tvl: 1000000000,
      tvl_change_7d: 3.1,
      fees_7d: 12000000,
      revenue_7d: 9000000,
      ...overrides.onchain,
    },
    social: {
      mentions: 321,
      filtered_mentions: 210,
      sentiment: 'bullish',
      sentiment_score: 0.82,
      ...overrides.social,
    },
    github: {
      commits_30d: 42,
      commit_trend: 'up',
      ...overrides.github,
    },
    holders: {
      top10_pct: 11.3,
      ...overrides.holders,
    },
    dex: {
      dex_liquidity_usd: 76500000,
      buy_sell_ratio: 1.7,
      ...overrides.dex,
    },
    metadata: {
      collectors: {
        market: { ok: true },
        onchain: { ok: true },
        social: { ok: true },
        github: { ok: true },
        tokenomics: { ok: true },
      },
      duration_ms: 10,
      ...overrides.metadata,
    },
    alpha_signals: [{ signal: 'volume_surge', strength: 'strong' }],
    red_flags: [{ flag: 'none', severity: 'low' }],
    volatility: { regime: 'calm' },
    momentum: { divergence: { type: 'bullish' } },
    ...overrides,
  };
}

function useTempCalibrationDb() {
  const dir = mkdtempSync(join(tmpdir(), 'clawnkers-calibration-'));
  process.env.CALIBRATION_DB_PATH = join(dir, 'calibration.db');
  __resetCalibrationDbForTests();
  __resetSnapshotStoreForTests();
  return () => {
    delete process.env.CALIBRATION_DB_PATH;
    __setSnapshotStoreHooksForTests({});
    __resetSnapshotStoreForTests();
    __resetCalibrationDbForTests();
    rmSync(dir, { recursive: true, force: true });
  };
}

function mockFetchWithBtc(price) {
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (String(url || '').includes('api.coingecko.com/api/v3/simple/price')) {
      return {
        async json() {
          return { bitcoin: { usd: price } };
        },
      };
    }
    return originalFetch(input, init);
  };
  return () => {
    global.fetch = originalFetch;
  };
}

function createTestApp({ collectAllFn } = {}) {
  const signalsService = createSignalsService({
    dbPath: ':memory:',
    maxBatchSignals: 100,
    ingestKey: 'x'.repeat(32),
  });

  const config = {
    appName: 'test',
    version: 'test',
    port: 0,
    exaApiKey: 'exa',
    xaiApiKey: null,
    alphaAuthKey: null,
    signalIngestKey: 'x'.repeat(32),
    nvmApiKey: null,
    nvmPlanId: null,
    nvmAgentId: null,
    nvmEnv: 'development',
    mcpAuthKey: 'test-mcp-key',
    payTo: '0x0',
    dbPath: ':memory:',
    exaCacheTtlMs: 300000,
    exaCacheMaxEntries: 200,
    maxBatchSignals: 100,
    maxMcpSessions: 50,
    x402Enabled: false,
  };

  const exaService = {
    async exaSearch() {
      return { results: [], freshness: { state: 'live', ageSeconds: 0 } };
    },
    async exaFetch(url) {
      return { url, title: 'mock', text: 'mock', freshness: { state: 'live', ageSeconds: 0 } };
    },
    getCacheStats() {
      return { hits: 0, misses: 0, size: 0, maxEntries: 200, ttlMs: 300000 };
    },
  };

  const created = createApp({ config, exaService, signalsService, collectAllFn });
  return created;
}

test('calibration DB schema is created correctly', () => {
  const cleanup = useTempCalibrationDb();
  try {
    const db = getCalibrationDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.ok(tables.includes('token_universe'));
    assert.ok(tables.includes('token_snapshots'));
    assert.ok(tables.includes('token_scores'));
    assert.ok(tables.includes('token_outcomes'));
    assert.ok(tables.includes('oracle_signals'));
    assert.ok(tables.includes('llm_reports'));
  } finally {
    cleanup();
  }
});

test('storeScanSnapshot saves snapshot and score records', async () => {
  const cleanup = useTempCalibrationDb();
  const restoreFetch = mockFetchWithBtc(90500);
  try {
    const rawData = createRawData();
    const scores = calculateScores(rawData);
    const snapshotId = await storeScanSnapshot('bitcoin', rawData, scores);
    assert.ok(snapshotId > 0);

    const db = getCalibrationDb();
    const snapshot = db.prepare('SELECT * FROM token_snapshots WHERE id = ?').get(snapshotId);
    const score = db.prepare('SELECT * FROM token_scores WHERE snapshot_id = ?').get(snapshotId);
    const token = db.prepare('SELECT * FROM token_universe WHERE id = ?').get(snapshot.token_id);

    assert.equal(snapshot.project_name, 'bitcoin');
    assert.equal(snapshot.price, rawData.market.current_price);
    assert.equal(score.overall_score, scores.overall.score);
    assert.equal(token.coingecko_id, 'bitcoin');
    assert.equal(token.symbol, 'BTC');
  } finally {
    restoreFetch();
    cleanup();
  }
});

test('storeScanSnapshot extracts relevant fields from rawData', () => {
  const rawData = createRawData({
    social: { filtered_mentions: 77, sentiment_score: 0.45 },
    github: { commits_30d: 9, commit_trend: 'flat' },
    holders: { top10_pct: 33.2 },
    dex: { dex_liquidity_usd: 123456, buy_sell_ratio: 0.91 },
  });

  const snapshot = __extractSnapshotRecordForTests('bitcoin', rawData, 88000);
  assert.equal(snapshot.social_mentions, 77);
  assert.equal(snapshot.sentiment_score, 0.45);
  assert.equal(snapshot.github_commits_30d, 9);
  assert.equal(snapshot.github_commit_trend, 'flat');
  assert.equal(snapshot.holder_concentration, 33.2);
  assert.equal(snapshot.dex_liquidity, 123456);
  assert.equal(snapshot.buy_sell_ratio, 0.91);
  assert.equal(snapshot.btc_price, 88000);
});

test('storeScanSnapshot saves BTC price from CoinGecko fetch', async () => {
  const cleanup = useTempCalibrationDb();
  const restoreFetch = mockFetchWithBtc(99123.45);
  try {
    const rawData = createRawData();
    const scores = calculateScores(rawData);
    const snapshotId = await storeScanSnapshot('bitcoin', rawData, scores);
    const db = getCalibrationDb();
    const snapshot = db.prepare('SELECT btc_price FROM token_snapshots WHERE id = ?').get(snapshotId);
    assert.equal(snapshot.btc_price, 99123.45);
  } finally {
    restoreFetch();
    cleanup();
  }
});

test('snapshot save failure does not block alpha response flow', async () => {
  const cleanup = useTempCalibrationDb();
  const restoreFetch = mockFetchWithBtc(87000);
  try {
    __setSnapshotStoreHooksForTests({
      beforeInsert() {
        throw new Error('forced snapshot failure');
      },
    });

    const { app, services } = createTestApp({
      collectAllFn: async (projectName) => createRawData({ project_name: projectName }),
    });

    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const response = await fetch(`${baseUrl}/alpha/quick?project=bitcoin&force_refresh=1`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.project_name, 'bitcoin');
    } finally {
      server.close();
      services.signals.close();
    }
  } finally {
    restoreFetch();
    cleanup();
  }
});

test('getSnapshotsForOutcomeTracking returns recent snapshots', async () => {
  const cleanup = useTempCalibrationDb();
  const restoreFetch = mockFetchWithBtc(88000);
  try {
    const rawData = createRawData();
    const scores = calculateScores(rawData);
    await storeScanSnapshot('bitcoin', rawData, scores);
    const rows = getSnapshotsForOutcomeTracking(30);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].coingecko_id, 'bitcoin');
  } finally {
    restoreFetch();
    cleanup();
  }
});
