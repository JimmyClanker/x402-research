/**
 * cross-dimensional.js — Round 3: Cross-Dimensional Analysis
 *
 * Detects divergences, convergences, and anomalies across scoring dimensions.
 * Each dimension is independent in scoring.js — this module finds patterns
 * that emerge from comparing them.
 */

function safeScore(dim) {
  if (!dim || typeof dim !== 'object') return null;
  return typeof dim.score === 'number' ? dim.score : null;
}

const DIMENSION_KEYS = [
  'market_strength', 'onchain_health', 'social_momentum',
  'development', 'tokenomics_health', 'distribution', 'risk',
];

const DIMENSION_LABELS = {
  market_strength: 'Market',
  onchain_health: 'Onchain',
  social_momentum: 'Social',
  development: 'Development',
  tokenomics_health: 'Tokenomics',
  distribution: 'Distribution',
  risk: 'Risk',
};

/**
 * Detect divergence patterns — dimensions telling conflicting stories.
 */
function detectDivergences(scores) {
  const divergences = [];
  const s = {};
  for (const k of DIMENSION_KEYS) {
    s[k] = safeScore(scores[k]);
  }

  // High social + low onchain = hype without substance
  if (s.social_momentum !== null && s.onchain_health !== null) {
    if (s.social_momentum >= 7 && s.onchain_health <= 4) {
      divergences.push({
        type: 'hype_without_substance',
        severity: 'warning',
        dimensions: ['social_momentum', 'onchain_health'],
        detail: `High social momentum (${s.social_momentum}/10) but weak onchain health (${s.onchain_health}/10) — hype may not be backed by real protocol usage.`,
      });
    }
  }

  // High dev + low market = undervalued builder
  if (s.development !== null && s.market_strength !== null) {
    if (s.development >= 7 && s.market_strength <= 4) {
      divergences.push({
        type: 'undervalued_builder',
        severity: 'info',
        dimensions: ['development', 'market_strength'],
        detail: `Strong development activity (${s.development}/10) but weak market performance (${s.market_strength}/10) — potentially undervalued builder, waiting for catalyst.`,
      });
    }
  }

  // High market + low dev = potential vapor
  if (s.market_strength !== null && s.development !== null) {
    if (s.market_strength >= 7 && s.development <= 3) {
      divergences.push({
        type: 'potential_vapor',
        severity: 'warning',
        dimensions: ['market_strength', 'development'],
        detail: `Strong market performance (${s.market_strength}/10) but minimal development (${s.development}/10) — price may not be supported by fundamentals.`,
      });
    }
  }

  // High social + low dev = narrative-driven without substance
  if (s.social_momentum !== null && s.development !== null) {
    if (s.social_momentum >= 7 && s.development <= 3) {
      divergences.push({
        type: 'narrative_driven',
        severity: 'warning',
        dimensions: ['social_momentum', 'development'],
        detail: `High social buzz (${s.social_momentum}/10) with negligible development (${s.development}/10) — pure narrative play, high risk.`,
      });
    }
  }

  // High onchain + low social = undiscovered gem or fading
  if (s.onchain_health !== null && s.social_momentum !== null) {
    if (s.onchain_health >= 7 && s.social_momentum <= 3) {
      divergences.push({
        type: 'undiscovered_protocol',
        severity: 'info',
        dimensions: ['onchain_health', 'social_momentum'],
        detail: `Strong onchain metrics (${s.onchain_health}/10) but low social visibility (${s.social_momentum}/10) — potentially undiscovered or losing mindshare.`,
      });
    }
  }

  // High risk score (safe) + low tokenomics = false safety
  if (s.risk !== null && s.tokenomics_health !== null) {
    if (s.risk >= 7 && s.tokenomics_health <= 3) {
      divergences.push({
        type: 'hidden_tokenomics_risk',
        severity: 'warning',
        dimensions: ['risk', 'tokenomics_health'],
        detail: `Risk profile looks safe (${s.risk}/10) but tokenomics are weak (${s.tokenomics_health}/10) — unlock/dilution risks may not be captured in price action yet.`,
      });
    }
  }

  return divergences;
}

/**
 * Detect convergence patterns — all dimensions telling the same story.
 */
function detectConvergences(scores) {
  const convergences = [];
  const values = DIMENSION_KEYS.map(k => safeScore(scores[k])).filter(v => v !== null);

  if (values.length < 4) return convergences;

  const allHigh = values.every(v => v >= 7);
  const allMid = values.every(v => v >= 4 && v <= 6);
  const allLow = values.every(v => v <= 3);

  if (allHigh) {
    convergences.push({
      type: 'strong_conviction',
      detail: `All ${values.length} dimensions score 7+/10 — strong across-the-board fundamentals. High conviction.`,
      action: 'Consider strong position sizing.',
    });
  }

  if (allMid) {
    convergences.push({
      type: 'mediocre_across_board',
      detail: `All ${values.length} dimensions score 4-6/10 — mediocre across the board. No standout strength.`,
      action: 'Wait for improvement in at least one key dimension before entering.',
    });
  }

  if (allLow) {
    convergences.push({
      type: 'weak_across_board',
      detail: `All ${values.length} dimensions score ≤3/10 — uniformly weak. No redeeming quality visible.`,
      action: 'Strong avoid — no dimension justifies allocation.',
    });
  }

  // Partial convergence: at least 5 of 7 dimensions above 6
  const highCount = values.filter(v => v >= 6).length;
  if (highCount >= 5 && !allHigh) {
    convergences.push({
      type: 'mostly_strong',
      detail: `${highCount}/${values.length} dimensions score 6+/10 — broad strength with some gaps.`,
      action: 'Investigate weak dimensions before sizing up.',
    });
  }

  return convergences;
}

/**
 * Detect anomalies — one dimension drastically different from the rest.
 */
function detectAnomalies(scores) {
  const anomalies = [];
  const entries = DIMENSION_KEYS.map(k => ({ key: k, score: safeScore(scores[k]) }))
    .filter(e => e.score !== null);

  if (entries.length < 4) return anomalies;

  const avg = entries.reduce((s, e) => s + e.score, 0) / entries.length;

  for (const entry of entries) {
    const deviation = entry.score - avg;

    // Positive outlier: one dimension 9+ while avg < 5
    if (entry.score >= 9 && avg < 5) {
      anomalies.push({
        type: 'suspicious_outlier_high',
        dimension: entry.key,
        label: DIMENSION_LABELS[entry.key],
        score: entry.score,
        avg_others: parseFloat(avg.toFixed(1)),
        detail: `${DIMENSION_LABELS[entry.key]} scores ${entry.score}/10 while average is ${avg.toFixed(1)} — suspicious positive outlier. Possible manipulation or data artifact.`,
      });
    }

    // Negative outlier: one dimension < 3 while avg > 7
    if (entry.score <= 3 && avg > 7) {
      anomalies.push({
        type: 'critical_weakness',
        dimension: entry.key,
        label: DIMENSION_LABELS[entry.key],
        score: entry.score,
        avg_others: parseFloat(avg.toFixed(1)),
        detail: `${DIMENSION_LABELS[entry.key]} scores only ${entry.score}/10 while average is ${avg.toFixed(1)} — critical single-point weakness.`,
      });
    }

    // Large deviation (>4 points from mean)
    if (Math.abs(deviation) > 4) {
      const dir = deviation > 0 ? 'above' : 'below';
      anomalies.push({
        type: 'large_deviation',
        dimension: entry.key,
        label: DIMENSION_LABELS[entry.key],
        score: entry.score,
        deviation: parseFloat(deviation.toFixed(1)),
        detail: `${DIMENSION_LABELS[entry.key]} is ${Math.abs(deviation).toFixed(1)} points ${dir} the mean (${avg.toFixed(1)}).`,
      });
    }
  }

  return anomalies;
}

/**
 * Main entry point: analyze cross-dimensional patterns.
 *
 * @param {object} scores - calculateScores() result
 * @param {object} rawData - raw collector data (for additional context)
 * @returns {object} cross-dimensional analysis
 */
export function analyzeCrossDimensional(scores, rawData = {}) {
  const divergences = detectDivergences(scores);
  const convergences = detectConvergences(scores);
  const anomalies = detectAnomalies(scores);

  const totalFindings = divergences.length + convergences.length + anomalies.length;

  // Generate a summary narrative for LLM injection
  const summaryParts = [];
  if (convergences.length > 0) {
    summaryParts.push(convergences.map(c => c.detail).join(' '));
  }
  if (divergences.length > 0) {
    summaryParts.push(`Key divergences: ${divergences.map(d => d.detail).join(' ')}`);
  }
  if (anomalies.length > 0) {
    summaryParts.push(`Anomalies: ${anomalies.map(a => a.detail).join(' ')}`);
  }

  return {
    divergences,
    convergences,
    anomalies,
    total_findings: totalFindings,
    summary: summaryParts.join(' ') || 'No significant cross-dimensional patterns detected.',
  };
}
