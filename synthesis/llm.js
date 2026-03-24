const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';
const DEFAULT_TIMEOUT_MS = 60000;
const FAST_MODEL = 'grok-4-1-fast-non-reasoning';
const REASONING_MODEL = 'grok-4.20-0309-reasoning';
const FALLBACK_VERDICTS = [
  { min: 8.5, verdict: 'STRONG BUY' },
  { min: 7, verdict: 'BUY' },
  { min: 5.5, verdict: 'HOLD' },
  { min: 3.5, verdict: 'AVOID' },
  { min: 0, verdict: 'STRONG AVOID' },
];

function withTimeout(timeoutMs, callback) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return callback(controller.signal).finally(() => clearTimeout(timeout));
}

function pickVerdict(score) {
  return FALLBACK_VERDICTS.find((item) => score >= item.min)?.verdict || 'HOLD';
}

function normalizeList(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;

  const seen = new Set();
  const items = [];

  for (const item of value) {
    const normalized = String(item).trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(normalized);
  }

  return items.length ? items : fallback;
}

function normalizeVerdict(value, fallbackScore = 0) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

  return FALLBACK_VERDICTS.some((item) => item.verdict === normalized)
    ? normalized
    : pickVerdict(fallbackScore);
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  for (const item of payload?.output || []) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === 'string' && content.text.trim()) {
        chunks.push(content.text.trim());
      }
    }
  }

  return chunks.join('\n').trim();
}

function buildPrompt(projectName, rawData, scores) {
  return [
    'You are a senior crypto analyst focused on alpha discovery. Produce a report that is genuinely useful to an investor, not a generic review.',
    'ALWAYS use the attached raw data as the primary numerical foundation.',
    'Then use X Search to validate X/Twitter sentiment, whale mentions, KOL opinions, community tone, and the active narrative around the project.',
    'Use Web Search to verify recent news, audit/security notes, exchange listing rumors, partnerships, governance changes, funding, and competitive context.',
    'If external data is weak or cannot be verified, say so clearly instead of making things up.',
    'Return ONLY valid JSON.',
    'Required fields: verdict, analysis_text, moat, risks, catalysts, competitor_comparison, x_sentiment_summary, key_findings.',
    'verdict must be one of: STRONG BUY, BUY, HOLD, AVOID, STRONG AVOID.',
    'risks, catalysts, and key_findings must be arrays of strings.',
    `PROJECT: ${projectName}`,
    `SCORES: ${JSON.stringify(scores, null, 2)}`,
    `RAW_DATA: ${JSON.stringify(rawData, null, 2)}`,
  ].join('\n\n');
}

export function fallbackReport(projectName, rawData, scores, error = null) {
  const overallScore = Number(scores?.overall?.score || 0);
  const verdict = pickVerdict(overallScore);
  const risks = [];
  const catalysts = [];
  const keyFindings = [];

  if ((rawData?.tokenomics?.pct_circulating || 0) < 50) {
    risks.push('Circulating supply is still limited: unlock/dilution risk remains.');
  }
  if ((rawData?.onchain?.tvl_change_30d || 0) < 0) {
    risks.push('TVL is contracting on a monthly basis.');
  }
  if ((rawData?.social?.sentiment || 'neutral') === 'bullish') {
    catalysts.push('Social sentiment is constructive and the narrative is active.');
  }
  if ((rawData?.github?.commits_90d || 0) > 30) {
    catalysts.push('Visible software development over the last 90 days.');
  }
  if ((rawData?.market?.market_cap || 0) > 0) {
    keyFindings.push(`Observed market cap: ${Number(rawData.market.market_cap).toLocaleString('en-US')}.`);
  }
  if ((rawData?.onchain?.tvl || 0) > 0) {
    keyFindings.push(`Observed TVL: ${Number(rawData.onchain.tvl).toLocaleString('en-US')}.`);
  }

  return {
    verdict,
    analysis_text: `${projectName}: overall score ${overallScore}/10. Market ${scores?.market_strength?.score}/10, onchain ${scores?.onchain_health?.score}/10, social ${scores?.social_momentum?.score}/10, dev ${scores?.development?.score}/10, tokenomics ${scores?.tokenomics_health?.score}/10.${error ? ` Fallback used: ${error}.` : ''}`,
    moat:
      'Requires external qualitative validation; competitive advantage depends on network effects, liquidity, brand, and execution.',
    risks: risks.length ? risks : ['Data coverage is incomplete: further qualitative validation is required.'],
    catalysts: catalysts.length ? catalysts : ['No strong catalyst emerged from the available data.'],
    competitor_comparison:
      'Competitor comparison is unavailable in fallback mode; use category/chains/narrative to build a manual peer set.',
    x_sentiment_summary:
      'X sentiment is unavailable in local fallback mode; Grok X Search is required for qualitative validation.',
    key_findings: keyFindings.length
      ? keyFindings
      : ['Analysis is based only on local collectors and algorithmic scoring.'],
  };
}

function normalizeReport(payload, projectName, rawData, scores) {
  const overallScore = Number(scores?.overall?.score || 0);
  return {
    verdict: normalizeVerdict(payload?.verdict, overallScore),
    analysis_text:
      String(payload?.analysis_text || '').trim() || fallbackReport(projectName, rawData, scores).analysis_text,
    moat: String(payload?.moat || '').trim() || 'n/a',
    risks: normalizeList(payload?.risks, ['n/a']),
    catalysts: normalizeList(payload?.catalysts, ['n/a']),
    competitor_comparison: String(payload?.competitor_comparison || '').trim() || 'n/a',
    x_sentiment_summary: String(payload?.x_sentiment_summary || '').trim() || 'n/a',
    key_findings: normalizeList(payload?.key_findings, ['n/a']),
  };
}

async function requestXai({ apiKey, model, input, tools = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const response = await withTimeout(timeoutMs, (signal) =>
    fetch(XAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input,
        tools,
        text: { format: { type: 'json_object' } },
        max_output_tokens: 4000,
      }),
      signal,
    })
  );

  if (!response.ok) {
    throw new Error(`xAI returned ${response.status}`);
  }

  return response.json();
}

export async function generateQuickReport(projectName, rawData, scores, { apiKey: explicitKey } = {}) {
  const apiKey = explicitKey || process.env.XAI_API_KEY;
  if (!apiKey) {
    return fallbackReport(projectName, rawData, scores, 'XAI_API_KEY missing');
  }

  const prompt = [
    'Generate a compact, fast version of the report.',
    'Do not use external tools. Rely only on the attached data.',
    'Return only valid JSON with the same required fields.',
    `PROJECT: ${projectName}`,
    `SCORES: ${JSON.stringify(scores, null, 2)}`,
    `RAW_DATA: ${JSON.stringify(rawData, null, 2)}`,
  ].join('\n\n');

  try {
    const payload = await requestXai({ apiKey, model: FAST_MODEL, input: prompt, tools: [], timeoutMs: 15000 });
    const text = extractOutputText(payload);
    return normalizeReport(JSON.parse(text), projectName, rawData, scores);
  } catch (error) {
    return fallbackReport(
      projectName,
      rawData,
      scores,
      error.name === 'AbortError' ? 'xAI quick timeout' : error.message
    );
  }
}

export async function generateReport(projectName, rawData, scores, { apiKey: explicitKey } = {}) {
  const apiKey = explicitKey || process.env.XAI_API_KEY;
  if (!apiKey) {
    return fallbackReport(projectName, rawData, scores, 'XAI_API_KEY missing');
  }

  const prompt = buildPrompt(projectName, rawData, scores);

  try {
    const payload = await requestXai({
      apiKey,
      model: REASONING_MODEL,
      input: prompt,
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const text = extractOutputText(payload);
    return normalizeReport(JSON.parse(text), projectName, rawData, scores);
  } catch (error) {
    return fallbackReport(
      projectName,
      rawData,
      scores,
      error.name === 'AbortError' ? 'xAI timeout' : error.message
    );
  }
}
