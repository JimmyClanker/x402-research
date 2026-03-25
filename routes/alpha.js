import express from 'express';
import { collectAll } from '../collectors/index.js';
import {
  safeParseJSON,
  verifyPayment,
  FULL_TTL_MS,
  QUICK_TTL_MS,
  normalizeProject,
  buildCacheKey,
  createCacheHelpers,
  runAnalysis,
} from './alpha-helpers.js';
import { createHistoryRouter } from './alpha-history.js';


function extractAlphaErrorDetails(error) {
  const stage = error?.stage || error?.step || 'unknown';
  const message = error?.cause?.message || error?.message || 'Unknown error';
  return { stage, message };
}

export function createAlphaRouter({ config, exaService, signalsService, collectAllFn = collectAll, collectorCache = null }) {
  const router = express.Router();
  const cache = createCacheHelpers(signalsService.db);
  const inFlight = new Map();

  // Cleanup expired cache rows every 30 min
  const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
  const cleanupStmt = signalsService.db.prepare(
    "DELETE FROM alpha_reports WHERE datetime(created_at) < datetime('now', '-2 hours')"
  );
  const cleanupTimer = setInterval(() => {
    try { cleanupStmt.run(); } catch (_) { /* ignore */ }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  async function getOrCreateReport({ cacheKey, ttlMs, projectName, exaService, mode, collectorCache: cc = collectorCache }) {
    const cached = cache.read(cacheKey, ttlMs);
    if (cached) return cached;

    // Single-flight: dedup concurrent requests for the same key
    if (inFlight.has(cacheKey)) {
      return inFlight.get(cacheKey);
    }

    const promise = (async () => {
      try {
        const report = await runAnalysis({ projectName, exaService, mode, config, collectAllFn, collectorCache: cc, db: signalsService.db });
        cache.write(cacheKey, report);
        try { signalsService.db.exec("CREATE TABLE IF NOT EXISTS scan_counter (id INTEGER PRIMARY KEY, count INTEGER DEFAULT 0)"); signalsService.db.exec("INSERT OR IGNORE INTO scan_counter (id, count) VALUES (1, 0)"); signalsService.db.prepare("UPDATE scan_counter SET count = count + 1 WHERE id = 1").run(); } catch {}
        return {
          ...report,
          cache: {
            ...(report.cache || {}),
            hit: false,
            key: cacheKey,
            ttl_ms: ttlMs,
            age_ms: 0,
            created_at: new Date().toISOString(),
          },
        };
      } finally {
        inFlight.delete(cacheKey);
      }
    })();

    inFlight.set(cacheKey, promise);
    return promise;
  }

  async function handleRequest(req, res, mode) {
    const projectName = normalizeProject(req.query.project);
    if (!projectName) {
      return res.status(400).json({ error: 'Missing or invalid ?project= parameter (max 100 characters)' });
    }

    if (
      mode === 'full' &&
      config?.xaiApiKey &&
      config?.alphaAuthKey &&
      req.get('x-alpha-key') !== config.alphaAuthKey &&
      req.query.key !== config.alphaAuthKey
    ) {
      return res.status(401).json({
        error: 'Unauthorized: a valid x-alpha-key header is required for full alpha reports',
      });
    }

    const forceRefresh = req.query.force_refresh === 'true' || req.query.force_refresh === '1';
    // Round 73: force_refresh bypasses cache by using 0ms TTL (effectively cache-miss always)
    const ttlMs = forceRefresh ? 0 : (mode === 'quick' ? QUICK_TTL_MS : FULL_TTL_MS);
    const cacheKey = buildCacheKey(projectName, mode);

    try {
      const response = await getOrCreateReport({ cacheKey, ttlMs, projectName, exaService, mode });
      // Round 72: Add cache status header for client-side debugging
      const cacheStatus = response?.cache?.hit ? 'HIT' : 'MISS';
      res.set('X-Cache-Status', cacheStatus);
      res.set('X-Cache-Age-Ms', String(response?.cache?.age_ms ?? 0));
      return res.json(response);
    } catch (error) {
      const { stage, message } = extractAlphaErrorDetails(error);
      console.error(`[alpha:${mode}] analysis failed at stage=${stage}: ${message}`, {
        projectName,
        cacheKey,
        forceRefresh,
        stack: error?.stack,
        cause: error?.cause?.stack || error?.cause?.message || null,
      });
      return res.status(502).json({
        error: `Alpha analysis failed during ${stage}`,
        detail: message,
      });
    }
  }

  router.get('/alpha', (req, res) => handleRequest(req, res, 'full'));
  router.get('/alpha/quick', (req, res) => handleRequest(req, res, 'quick'));

  // ── Direct USDC payment: verify tx then run full scan ──────────
  router.post('/alpha/pay-verify', express.json(), async (req, res) => {
    const { txHash, project } = req.body || {};
    if (!txHash || !project) {
      return res.status(400).json({ error: 'Missing txHash or project' });
    }

    const projectName = normalizeProject(project);
    if (!projectName) {
      return res.status(400).json({ error: 'Invalid project name (max 100 characters)' });
    }

    const valid = await verifyPayment(txHash);
    if (!valid) {
      return res.status(402).json({ error: 'Payment not verified. Ensure you sent >= $1 USDC to our wallet on Base.' });
    }

    // Run full scan (bypasses auth key check since payment is proven on-chain)
    const ttlMs = FULL_TTL_MS;
    const cacheKey = buildCacheKey(projectName, 'full');
    try {
      const response = await getOrCreateReport({ cacheKey, ttlMs, projectName, exaService, mode: 'full', collectorCache });
      return res.json(response);
    } catch (error) {
      console.error(`[pay-verify] scan failed: ${error.stack || error.message}`);
      return res.status(500).json({ error: 'Scan failed: ' + error.message });
    }
  });

  // ── Round 27: Batch quick-scan endpoint ───────────────────────
  router.post('/alpha/batch', express.json({ limit: '10kb' }), async (req, res) => {
    const { projects } = req.body || {};
    if (!Array.isArray(projects) || projects.length === 0) {
      return res.status(400).json({ error: 'Provide a JSON body: { "projects": ["btc", "eth", ...] }' });
    }
    if (projects.length > 5) {
      return res.status(400).json({ error: 'Maximum 5 projects per batch request' });
    }

    const normalized = projects.map(normalizeProject).filter(Boolean);
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'No valid project names provided' });
    }

    // Run all quick scans in parallel (already uses cache + single-flight)
    const results = await Promise.allSettled(
      normalized.map((projectName) =>
        getOrCreateReport({
          cacheKey: buildCacheKey(projectName, 'quick'),
          ttlMs: QUICK_TTL_MS,
          projectName,
          exaService,
          mode: 'quick',
        })
      )
    );

    const batch = results.map((result, idx) => {
      const projectName = normalized[idx];
      if (result.status === 'fulfilled') {
        const r = result.value;
        return {
          project: projectName,
          ok: true,
          verdict: r.verdict,
          overall_score: r.scores?.overall?.score ?? null,
          key_metrics: r.key_metrics,
          elevator_pitch: r.elevator_pitch ?? null,
          // Round 19 (AutoResearch batch): include trend + volatility in batch output
          trend_reversal: r.trend_reversal ? { pattern: r.trend_reversal.pattern, confidence: r.trend_reversal.confidence } : null,
          volatility_regime: r.volatility?.regime ?? 'calm',
          critical_flags: (r.red_flags ?? []).filter((f) => f.severity === 'critical').length,
          strong_signals: (r.alpha_signals ?? []).filter((s) => s.strength === 'strong').length,
          // Round 21 (AutoResearch nightly): add liquidity health and news momentum
          liquidity_health: r.raw_data?.dex?.liquidity_health_score ?? null,
          news_momentum: r.raw_data?.social?.news_momentum ?? null,
          report_quality_grade: r.report_quality?.grade ?? null,
          cache: r.cache,
        };
      }
      return {
        project: projectName,
        ok: false,
        error: result.reason?.message ?? 'Scan failed',
      };
    });

    return res.json({
      batch,
      count: batch.length,
      generated_at: new Date().toISOString(),
    });
  });

  // ── Round 38: Watchlist endpoint — track a portfolio of projects ──────────
  router.get('/alpha/watchlist', async (req, res) => {
    const raw = req.query.projects || req.query.project || '';
    const projectList = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    if (projectList.length === 0) {
      return res.status(400).json({ error: 'Provide ?projects=btc,eth,sol (comma-separated)' });
    }
    if (projectList.length > 8) {
      return res.status(400).json({ error: 'Maximum 8 projects per watchlist request' });
    }
    const normalized = projectList.map(normalizeProject).filter(Boolean);

    const results = await Promise.allSettled(
      normalized.map((projectName) =>
        getOrCreateReport({
          cacheKey: buildCacheKey(projectName, 'quick'),
          ttlMs: QUICK_TTL_MS,
          projectName,
          exaService,
          mode: 'quick',
        })
      )
    );

    const watchlist = results.map((result, idx) => {
      const projectName = normalized[idx];
      if (result.status === 'fulfilled') {
        const r = result.value;
        const scores = r.scores ?? {};
        const dimScores = {};
        for (const dim of ['market_strength', 'onchain_health', 'social_momentum', 'development', 'tokenomics_health', 'risk']) {
          dimScores[dim] = scores[dim]?.score ?? null;
        }
        return {
          project: projectName,
          ok: true,
          verdict: r.verdict,
          overall_score: scores.overall?.score ?? null,
          dimension_scores: dimScores,
          key_metrics: {
            price_fmt: r.key_metrics?.price_fmt,
            market_cap_fmt: r.key_metrics?.market_cap_fmt,
            volume_24h_fmt: r.key_metrics?.volume_24h_fmt,
          },
          red_flag_count: (r.red_flags ?? []).length,
          critical_flag_count: (r.red_flags ?? []).filter((f) => f.severity === 'critical').length,
          alpha_signal_count: (r.alpha_signals ?? []).length,
          volatility_regime: r.volatility?.regime ?? 'calm',
          elevator_pitch: r.elevator_pitch ?? null,
          cache_hit: r.cache?.hit ?? false,
        };
      }
      return { project: projectName, ok: false, error: result.reason?.message ?? 'Scan failed' };
    });

    // Sort by overall_score descending for at-a-glance ranking
    const sorted = [...watchlist].sort((a, b) => (b.overall_score ?? -1) - (a.overall_score ?? -1));

    return res.json({
      watchlist: sorted,
      count: sorted.length,
      generated_at: new Date().toISOString(),
    });
  });

  // ── Round 10: Project comparison endpoint ─────────────────────
  router.get('/alpha/compare', async (req, res) => {
    const a = normalizeProject(req.query.a);
    const b = normalizeProject(req.query.b);
    if (!a || !b) {
      return res.status(400).json({ error: 'Missing ?a= and ?b= project parameters' });
    }
    if (a.toLowerCase() === b.toLowerCase()) {
      return res.status(400).json({ error: 'Parameters a and b must be different projects' });
    }

    try {
      const [reportA, reportB] = await Promise.all([
        getOrCreateReport({ cacheKey: buildCacheKey(a, 'quick'), ttlMs: QUICK_TTL_MS, projectName: a, exaService, mode: 'quick' }),
        getOrCreateReport({ cacheKey: buildCacheKey(b, 'quick'), ttlMs: QUICK_TTL_MS, projectName: b, exaService, mode: 'quick' }),
      ]);

      const compareScores = (key) => {
        const sa = reportA?.scores?.[key]?.score ?? reportA?.scores?.[key] ?? null;
        const sb = reportB?.scores?.[key]?.score ?? reportB?.scores?.[key] ?? null;
        return { [a]: sa, [b]: sb, winner: sa != null && sb != null ? (sa > sb ? a : sb > sa ? b : 'tie') : null };
      };

      const dimensions = ['market_strength', 'onchain_health', 'social_momentum', 'development', 'tokenomics_health', 'distribution', 'risk'];
      const scoreComparison = {};
      for (const dim of dimensions) {
        scoreComparison[dim] = compareScores(dim);
      }
      scoreComparison.overall = compareScores('overall');

      return res.json({
        comparison: {
          [a]: {
            verdict: reportA?.verdict,
            overall_score: reportA?.scores?.overall?.score ?? null,
            key_metrics: reportA?.key_metrics,
          },
          [b]: {
            verdict: reportB?.verdict,
            overall_score: reportB?.scores?.overall?.score ?? null,
            key_metrics: reportB?.key_metrics,
          },
        },
        score_comparison: scoreComparison,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[alpha/compare]', err.message);
      return res.status(502).json({ error: 'Comparison failed: ' + err.message });
    }
  });

  // ── Round 15 (AutoResearch nightly): Server health endpoint for monitoring ──
  router.get('/alpha/health', (req, res) => {
    try {
      const db = signalsService.db;
      const totalScans = (() => { try { return db.prepare('SELECT COALESCE(count,0) as c FROM scan_counter WHERE id=1').get()?.c ?? 0; } catch { return 0; } })();
      const recentScans1h = (() => {
        try {
          const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
          return db.prepare('SELECT COUNT(*) as c FROM scan_history WHERE scanned_at >= ?').get(cutoff)?.c ?? 0;
        } catch { return 0; }
      })();
      const cacheSize = (() => { try { return db.prepare('SELECT COUNT(*) as c FROM alpha_reports').get()?.c ?? 0; } catch { return 0; } })();
      return res.json({
        status: 'ok',
        uptime_seconds: Math.round(process.uptime()),
        total_scans: totalScans,
        scans_last_1h: recentScans1h,
        cache_entries: cacheSize,
        in_flight_requests: inFlight.size,
        memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // ── Mount history router on /alpha/* ──────────────────────────
  const historyRouter = createHistoryRouter({
    signalsService,
    cache,
    getOrCreateReport,
    exaService,
    FULL_TTL_MS,
    QUICK_TTL_MS,
    buildCacheKey,
    normalizeProject,
    safeParseJSON,
  });
  router.use('/alpha', historyRouter);

  return router;
}

export default createAlphaRouter;
