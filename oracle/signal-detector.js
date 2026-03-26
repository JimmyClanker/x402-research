import { getCalibrationDb } from '../calibration/db.js';

/**
 * Analizza gli snapshot più recenti e genera segnali.
 * Progettato per essere chiamato periodicamente (ogni 1-6h).
 * @param {{ db?: import('better-sqlite3').Database }} [opts]
 * @returns {{ signals: Array, summary: { total: number, by_type: Record<string,number> } }}
 */
export function detectSignals({ db: injectedDb } = {}) {
  const db = injectedDb || getCalibrationDb();
  const signals = [];

  signals.push(...detectScoreMomentum(db));
  signals.push(...detectCategoryLeaderShift(db));
  signals.push(...detectBreakerAlerts(db));
  signals.push(...detectDivergence(db));
  // REGIME_SHIFT: placeholder — ritorna [] per ora
  signals.push(...detectRegimeShift(db));

  const saved = saveSignals(db, signals);

  return {
    signals: saved,
    summary: {
      total: saved.length,
      by_type: saved.reduce((acc, s) => {
        acc[s.signal_type] = (acc[s.signal_type] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}

// ---------------------------------------------------------------------------
// SCORE_MOMENTUM
// ---------------------------------------------------------------------------

/**
 * Confronta lo score più recente di ogni token con quello di ~72h fa (range 60-84h).
 * Se |delta| > 1.0 → segnale SCORE_MOMENTUM.
 */
export function detectScoreMomentum(db) {
  // Per ogni token, ottieni (snapshot_recente, score_recente) e
  // (snapshot_più_vecchio_almeno_60h_fa, score_relativo)
  const rows = db.prepare(`
    SELECT
      tu.id            AS token_id,
      tu.name          AS token_name,
      tu.symbol        AS token_symbol,
      ts_recent.id     AS recent_snapshot_id,
      ts_recent.snapshot_at AS recent_at,
      sc_recent.overall_score AS current_score,
      ts_old.id        AS old_snapshot_id,
      ts_old.snapshot_at   AS old_at,
      sc_old.overall_score  AS prev_score,
      (sc_recent.overall_score - sc_old.overall_score) AS delta
    FROM token_universe tu

    -- snapshot più recente per ogni token
    JOIN token_snapshots ts_recent
      ON ts_recent.token_id = tu.id
      AND ts_recent.id = (
        SELECT id FROM token_snapshots
        WHERE token_id = tu.id
        ORDER BY snapshot_at DESC LIMIT 1
      )
    JOIN token_scores sc_recent ON sc_recent.snapshot_id = ts_recent.id

    -- snapshot più recente che è almeno 60h fa (tolleranza 60-84h)
    JOIN token_snapshots ts_old
      ON ts_old.token_id = tu.id
      AND ts_old.id = (
        SELECT id FROM token_snapshots
        WHERE token_id = tu.id
          AND datetime(snapshot_at) <= datetime(ts_recent.snapshot_at, '-60 hours')
          AND datetime(snapshot_at) >= datetime(ts_recent.snapshot_at, '-84 hours')
        ORDER BY snapshot_at DESC LIMIT 1
      )
    JOIN token_scores sc_old ON sc_old.snapshot_id = ts_old.id

    WHERE sc_recent.overall_score IS NOT NULL
      AND sc_old.overall_score IS NOT NULL
      AND ABS(sc_recent.overall_score - sc_old.overall_score) > 1.0
  `).all();

  // Helper: ottieni tutti gli snapshot recenti per trend consistency check
  const getRecentSnapshots = (tokenId, recentAt) => {
    return db.prepare(`
      SELECT sc.overall_score
      FROM token_snapshots ts
      JOIN token_scores sc ON sc.snapshot_id = ts.id
      WHERE ts.token_id = ?
        AND datetime(ts.snapshot_at) <= datetime(?)
        AND sc.overall_score IS NOT NULL
      ORDER BY ts.snapshot_at DESC
      LIMIT 5
    `).all(tokenId, recentAt);
  };

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  return rows.map(row => {
    const delta = row.delta;
    const absDelta = Math.abs(delta);
    const direction = delta > 0 ? 'improving' : 'declining';
    const severity = absDelta > 2.0 ? 'critical' : absDelta > 1.5 ? 'high' : 'medium';
    const tokenName = row.token_name || row.token_symbol || `token#${row.token_id}`;

    const msOld = new Date(row.old_at.replace(' ', 'T') + 'Z').getTime();
    const msRecent = new Date(row.recent_at.replace(' ', 'T') + 'Z').getTime();
    const hours = Math.round((msRecent - msOld) / (1000 * 60 * 60));
    const velocity = hours > 0 ? (delta / hours) : 0; // pts per hour
    const normalizedDelta = row.current_score !== 0 ? (delta / row.current_score) : 0; // relative change

    // Trend consistency: score è sempre cresciuto/decresciuto negli ultimi N snapshot?
    const recentSnaps = getRecentSnapshots(row.token_id, row.recent_at);
    let trendConsistent = false;
    if (recentSnaps.length >= 3) {
      const scores = recentSnaps.map(s => s.overall_score);
      const allImproving = scores.every((s, i) => i === 0 || s >= scores[i - 1]);
      const allDeclining = scores.every((s, i) => i === 0 || s <= scores[i - 1]);
      trendConsistent = direction === 'improving' ? allImproving : allDeclining;
    }

    const consistencyNote = trendConsistent ? ' [consistent trend]' : '';

    return {
      signal_type: 'SCORE_MOMENTUM',
      token_id: row.token_id,
      severity,
      title: `${tokenName}: score ${direction} ${absDelta.toFixed(1)} pts in 72h (velocity: ${velocity.toFixed(3)} pts/h)${consistencyNote}`,
      detail: `Score moved from ${row.prev_score.toFixed(1)}/10 to ${row.current_score.toFixed(1)}/10. ${direction === 'improving' ? 'Positive momentum' : 'Deterioration detected'}. Velocity: ${velocity.toFixed(3)} pts/h.${trendConsistent ? ' Trend is consistent across recent snapshots.' : ''}`,
      data_json: JSON.stringify({
        current_score: row.current_score,
        prev_score: row.prev_score,
        delta,
        direction,
        hours,
        velocity,
        normalized_delta: normalizedDelta,
        trend_consistent: trendConsistent,
      }),
      expires_at: expiresAt,
    };
  });
}

// ---------------------------------------------------------------------------
// CATEGORY_LEADER_SHIFT
// ---------------------------------------------------------------------------

/**
 * Per ogni categoria, confronta il top 3 attuale con quello di ~7 giorni fa.
 * Se cambia → segnale CATEGORY_LEADER_SHIFT.
 */
export function detectCategoryLeaderShift(db) {
  // Top 3 corrente per categoria
  const currentRows = db.prepare(`
    SELECT
      sc.category,
      tu.id AS token_id,
      tu.name AS token_name,
      tu.symbol AS token_symbol,
      sc.overall_score
    FROM token_scores sc
    JOIN token_snapshots ts ON ts.id = sc.snapshot_id
    JOIN token_universe tu ON tu.id = ts.token_id
    WHERE sc.category IS NOT NULL
      AND sc.overall_score IS NOT NULL
      AND ts.id IN (
        SELECT id FROM token_snapshots
        WHERE token_id = tu.id
        ORDER BY snapshot_at DESC LIMIT 1
      )
    ORDER BY sc.category, sc.overall_score DESC
  `).all();

  // Top 3 di ~7 giorni fa (range 6-8 giorni)
  const oldRows = db.prepare(`
    SELECT
      sc.category,
      tu.id AS token_id,
      tu.name AS token_name,
      tu.symbol AS token_symbol,
      sc.overall_score,
      ts.snapshot_at
    FROM token_scores sc
    JOIN token_snapshots ts ON ts.id = sc.snapshot_id
    JOIN token_universe tu ON tu.id = ts.token_id
    WHERE sc.category IS NOT NULL
      AND sc.overall_score IS NOT NULL
      AND ts.id IN (
        SELECT id FROM token_snapshots
        WHERE token_id = tu.id
          AND datetime(snapshot_at) <= datetime('now', '-6 days')
          AND datetime(snapshot_at) >= datetime('now', '-8 days')
        ORDER BY snapshot_at DESC LIMIT 1
      )
    ORDER BY sc.category, sc.overall_score DESC
  `).all();

  // Raggruppa per categoria
  const groupBy = (rows, key) => rows.reduce((acc, r) => {
    if (!acc[r[key]]) acc[r[key]] = [];
    acc[r[key]].push(r);
    return acc;
  }, {});

  const currentByCategory = groupBy(currentRows, 'category');
  const oldByCategory = groupBy(oldRows, 'category');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const signals = [];

  for (const [category, rows] of Object.entries(currentByCategory)) {
    const oldRows2 = oldByCategory[category];
    if (!oldRows2 || oldRows2.length === 0) continue; // nessun dato storico

    const newTop3Ids = rows.slice(0, 3).map(r => r.token_id);
    const oldTop3Ids = oldRows2.slice(0, 3).map(r => r.token_id);

    // Verifica se il top 3 è cambiato
    const sameIds = newTop3Ids.length === oldTop3Ids.length &&
      newTop3Ids.every(id => oldTop3Ids.includes(id));
    if (sameIds) continue;

    const newTop3Names = rows.slice(0, 3).map(r => r.token_name || r.token_symbol || `#${r.token_id}`);
    const oldTop3Names = oldRows2.slice(0, 3).map(r => r.token_name || r.token_symbol || `#${r.token_id}`);

    const enteredIds = newTop3Ids.filter(id => !oldTop3Ids.includes(id));
    const exitedIds = oldTop3Ids.filter(id => !newTop3Ids.includes(id));

    const enteredNames = rows
      .filter(r => enteredIds.includes(r.token_id))
      .map(r => r.token_name || r.token_symbol || `#${r.token_id}`);
    const exitedNames = oldRows2
      .filter(r => exitedIds.includes(r.token_id))
      .map(r => r.token_name || r.token_symbol || `#${r.token_id}`);

    const newLeader = newTop3Names[0] || 'Unknown';
    const changeCount = enteredIds.length; // quanti nuovi entrati
    const severity = changeCount >= 3 ? 'critical' : changeCount === 2 ? 'high' : 'medium';

    const newLeaderScore = rows[0]?.overall_score ?? null;
    const oldLeaderScore = oldRows2[0]?.overall_score ?? null;
    const scoreGap = (newLeaderScore !== null && oldLeaderScore !== null) ? (newLeaderScore - oldLeaderScore) : null;

    signals.push({
      signal_type: 'CATEGORY_LEADER_SHIFT',
      token_id: null,
      severity,
      title: `${category}: leadership change — ${newLeader} enters top 3 (${changeCount} new)`,
      detail: `New top 3: ${newTop3Names.join(', ')}. Previous: ${oldTop3Names.join(', ')}. ${changeCount} token(s) changed.${scoreGap !== null ? ` Leader score gap: ${scoreGap > 0 ? '+' : ''}${scoreGap.toFixed(1)} pts.` : ''}`,
      data_json: JSON.stringify({
        category,
        new_top3: newTop3Names,
        old_top3: oldTop3Names,
        new_top3_ids: newTop3Ids,
        old_top3_ids: oldTop3Ids,
        entered: enteredNames,
        exited: exitedNames,
        change_count: changeCount,
        score_gap: scoreGap,
      }),
      expires_at: expiresAt,
    });
  }

  return signals;
}

// ---------------------------------------------------------------------------
// BREAKER_ALERT
// ---------------------------------------------------------------------------

/**
 * Rileva attivazione/disattivazione di circuit breaker per ogni token.
 */
export function detectBreakerAlerts(db) {
  // Per ogni token con snapshot nelle ultime 24h, confronta il circuit_breakers_json
  // con lo snapshot precedente
  const recentSnapshots = db.prepare(`
    SELECT
      ts.id AS snapshot_id,
      ts.token_id,
      ts.snapshot_at,
      tu.name AS token_name,
      tu.symbol AS token_symbol,
      sc.circuit_breakers_json,
      -- snapshot precedente
      (
        SELECT id FROM token_snapshots
        WHERE token_id = ts.token_id
          AND datetime(snapshot_at) < datetime(ts.snapshot_at)
        ORDER BY snapshot_at DESC LIMIT 1
      ) AS prev_snapshot_id
    FROM token_snapshots ts
    JOIN token_universe tu ON tu.id = ts.token_id
    JOIN token_scores sc ON sc.snapshot_id = ts.id
    WHERE datetime(ts.snapshot_at) >= datetime('now', '-24 hours')
      AND ts.id IN (
        SELECT MAX(id) FROM token_snapshots
        WHERE datetime(snapshot_at) >= datetime('now', '-24 hours')
        GROUP BY token_id
      )
  `).all();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const signals = [];

  for (const snap of recentSnapshots) {
    if (!snap.prev_snapshot_id) continue;

    const prevScore = db.prepare(`
      SELECT circuit_breakers_json FROM token_scores WHERE snapshot_id = ?
    `).get(snap.prev_snapshot_id);

    if (!prevScore) continue;

    let currentBreakers = [];
    let prevBreakers = [];

    try {
      currentBreakers = snap.circuit_breakers_json ? JSON.parse(snap.circuit_breakers_json) : [];
      prevBreakers = prevScore.circuit_breakers_json ? JSON.parse(prevScore.circuit_breakers_json) : [];
    } catch {
      continue;
    }

    if (!Array.isArray(currentBreakers)) currentBreakers = [];
    if (!Array.isArray(prevBreakers)) prevBreakers = [];

    // Estrai type/id per confronto
    const getBreakerKey = b => b?.type || b?.id || JSON.stringify(b);
    const currentKeys = new Set(currentBreakers.map(getBreakerKey));
    const prevKeys = new Set(prevBreakers.map(getBreakerKey));

    const tokenName = snap.token_name || snap.token_symbol || `token#${snap.token_id}`;

    // Breaker attivati (presenti ora, non prima)
    const activatedBreakers = [];
    for (const breaker of currentBreakers) {
      const key = getBreakerKey(breaker);
      if (!prevKeys.has(key)) {
        activatedBreakers.push(breaker);
      }
    }

    if (activatedBreakers.length > 0) {
      const breakerCount = currentBreakers.length;
      
      // Check se qualche breaker è attivo da >48h (presente negli ultimi 3+ snapshot)
      const oldSnapshots = db.prepare(`
        SELECT ts.id, sc.circuit_breakers_json
        FROM token_snapshots ts
        JOIN token_scores sc ON sc.snapshot_id = ts.id
        WHERE ts.token_id = ?
          AND datetime(ts.snapshot_at) <= datetime(?)
        ORDER BY ts.snapshot_at DESC
        LIMIT 4
      `).all(snap.token_id, snap.snapshot_at);

      let longDurationBreaker = false;
      if (oldSnapshots.length >= 3) {
        const currentKeys = new Set(currentBreakers.map(getBreakerKey));
        let persistentCount = 0;
        for (const oldSnap of oldSnapshots.slice(1)) {
          try {
            const oldB = oldSnap.circuit_breakers_json ? JSON.parse(oldSnap.circuit_breakers_json) : [];
            const oldKeys = new Set(oldB.map(getBreakerKey));
            const anyPersistent = [...currentKeys].some(k => oldKeys.has(k));
            if (anyPersistent) persistentCount++;
          } catch {}
        }
        longDurationBreaker = persistentCount >= 2; // presente in almeno 2 snapshot precedenti
      }

      const severity = longDurationBreaker ? 'critical' : (breakerCount >= 3 ? 'critical' : 'high');
      const firstBreaker = activatedBreakers[0];
      const breakerType = firstBreaker?.type || firstBreaker?.id || 'unknown';
      const cap = firstBreaker?.cap ?? firstBreaker?.score_cap ?? null;
      const reason = firstBreaker?.reason || firstBreaker?.detail || breakerType;
      const durationNote = longDurationBreaker ? ' [active >48h]' : '';
      signals.push({
        signal_type: 'BREAKER_ALERT',
        token_id: snap.token_id,
        severity,
        title: `${tokenName}: circuit breaker ACTIVATED — ${breakerType} (${breakerCount} active)${durationNote}`,
        detail: `${reason}. Score cap: ${cap != null ? cap + '/10' : 'n/a'}. Total breakers: ${breakerCount}.${longDurationBreaker ? ' Breaker active for >48h.' : ''}`,
        data_json: JSON.stringify({ 
          breaker_type: breakerType, 
          activated: true, 
          cap, 
          reason, 
          breaker_count: breakerCount,
          long_duration: longDurationBreaker,
          all_breakers: currentBreakers.map(b => b?.type || b?.id || 'unknown'),
        }),
        expires_at: expiresAt,
      });
    }

    // Breaker disattivati (presenti prima, non ora)
    for (const breaker of prevBreakers) {
      const key = getBreakerKey(breaker);
      if (!currentKeys.has(key)) {
        const breakerType = breaker?.type || breaker?.id || 'unknown';
        const cap = breaker?.cap ?? breaker?.score_cap ?? null;
        const reason = breaker?.reason || breaker?.detail || breakerType;
        signals.push({
          signal_type: 'BREAKER_ALERT',
          token_id: snap.token_id,
          severity: 'low',
          title: `${tokenName}: circuit breaker cleared — ${breakerType}`,
          detail: `${reason}. Score cap: ${cap != null ? cap + '/10' : 'n/a'}.`,
          data_json: JSON.stringify({ breaker_type: breakerType, activated: false, cap, reason }),
          expires_at: expiresAt,
        });
      }
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// DIVERGENCE
// ---------------------------------------------------------------------------

/**
 * Rileva divergenza sentiment-price:
 * - score >= 6.5 + prezzo sceso > 15% in 7d → positive_divergence (opportunità)
 * - score <= 4.5 + prezzo salito > 15% in 7d → negative_divergence (trappola)
 * Severity: high se score estremo (≥7.0 o ≤4.0), medium se moderato (6.5-7.0 o 4.0-4.5).
 */
export function detectDivergence(db) {
  const rows = db.prepare(`
    SELECT
      tu.id AS token_id,
      tu.name AS token_name,
      tu.symbol AS token_symbol,
      ts.price_change_7d,
      ts.volume_24h,
      ts.market_cap,
      sc.overall_score
    FROM token_snapshots ts
    JOIN token_universe tu ON tu.id = ts.token_id
    JOIN token_scores sc ON sc.snapshot_id = ts.id
    WHERE ts.id IN (
      SELECT MAX(id) FROM token_snapshots GROUP BY token_id
    )
      AND sc.overall_score IS NOT NULL
      AND ts.price_change_7d IS NOT NULL
      AND (
        (sc.overall_score >= 6.5 AND ts.price_change_7d < -15.0)
        OR
        (sc.overall_score <= 4.5 AND ts.price_change_7d > 15.0)
      )
  `).all();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  return rows.map(row => {
    const isPositive = row.overall_score >= 6.5 && row.price_change_7d < -15.0;
    const divergenceType = isPositive ? 'positive_divergence' : 'negative_divergence';
    const tokenName = row.token_name || row.token_symbol || `token#${row.token_id}`;
    const priceDirection = row.price_change_7d < 0 ? `down ${Math.abs(row.price_change_7d).toFixed(1)}%` : `up ${row.price_change_7d.toFixed(1)}%`;
    const scoreImplication = isPositive ? 'strong fundamentals' : 'weak fundamentals';
    const opportunityOrTrap = isPositive ? 'accumulation opportunity' : 'potential value trap';

    // Volume quality check: mcap e volume devono essere presenti per severity upgrade
    const volumeToMcap = (row.volume_24h && row.market_cap && row.market_cap > 0) 
      ? (row.volume_24h / row.market_cap) 
      : 0;
    const lowVolume = volumeToMcap < 0.05; // < 5% daily turnover = thin

    // Severity: high se score estremo + volume OK, medium se moderato o low volume
    const extremeScore = isPositive ? row.overall_score >= 7.0 : row.overall_score <= 4.0;
    let severity = extremeScore ? 'high' : 'medium';
    if (lowVolume && severity === 'high') severity = 'medium'; // downgrade se volume thin

    const volumeNote = lowVolume ? ' [low volume]' : '';

    return {
      signal_type: 'DIVERGENCE',
      token_id: row.token_id,
      severity,
      title: `${tokenName}: ${divergenceType} — score ${row.overall_score.toFixed(1)}/10 but price ${priceDirection}${volumeNote}`,
      detail: `Algorithmic score ${row.overall_score.toFixed(1)}/10 suggests ${scoreImplication}, but price has moved ${priceDirection} in 7d. Potential ${opportunityOrTrap}.${lowVolume ? ' Low volume (<5% daily turnover) — signal quality reduced.' : ''}`,
      data_json: JSON.stringify({
        score: row.overall_score,
        price_change_7d: row.price_change_7d,
        divergence_type: divergenceType,
        extreme_score: extremeScore,
        volume_to_mcap: volumeToMcap,
        low_volume: lowVolume,
      }),
      expires_at: expiresAt,
    };
  });
}

// ---------------------------------------------------------------------------
// REGIME_SHIFT (placeholder)
// ---------------------------------------------------------------------------

/**
 * Regime shift detection requires BTC regime filter (Phase 8).
 * Currently returns no signals.
 */
export function detectRegimeShift(_db) {
  return [];
}

// ---------------------------------------------------------------------------
// SAVE SIGNALS (con dedup)
// ---------------------------------------------------------------------------

/**
 * Salva segnali nel DB con deduplicazione:
 * Non salva se esiste già un segnale non scaduto con stesso signal_type + token_id.
 * @returns {Array} segnali salvati con id
 */
export function saveSignals(db, signals) {
  if (!signals.length) return [];

  const checkExisting = db.prepare(`
    SELECT id FROM oracle_signals
    WHERE signal_type = ?
      AND (token_id IS ? OR (token_id IS NULL AND ? IS NULL))
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    LIMIT 1
  `);

  const insertSignal = db.prepare(`
    INSERT INTO oracle_signals (signal_type, token_id, severity, title, detail, data_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const saved = [];

  for (const signal of signals) {
    const tokenIdForCheck = signal.token_id ?? null;
    const existing = checkExisting.get(signal.signal_type, tokenIdForCheck, tokenIdForCheck);
    if (existing) continue; // dedup

    const result = insertSignal.run(
      signal.signal_type,
      signal.token_id ?? null,
      signal.severity ?? null,
      signal.title ?? null,
      signal.detail ?? null,
      signal.data_json ?? null,
      signal.expires_at ?? null,
    );
    saved.push({
      ...signal,
      id: Number(result.lastInsertRowid),
      generated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
  }

  return saved;
}
