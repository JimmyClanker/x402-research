const LLAMA_PROTOCOLS_URL = 'https://api.llama.fi/protocols';
const LLAMA_PROTOCOL_URL = 'https://api.llama.fi/protocol';
const LLAMA_FEES_URL = 'https://api.llama.fi/summary/fees';
const DEFAULT_TIMEOUT_MS = 12000;

function createEmptyOnchainResult(projectName) {
  return {
    project_name: projectName,
    slug: null,
    tvl: null,
    tvl_change_7d: null,
    tvl_change_30d: null,
    chains: [],
    category: null,
    fees_7d: null,
    revenue_7d: null,
    error: null,
  };
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function similarityScore(projectName, protocol) {
  const target = normalize(projectName);
  const name = normalize(protocol?.name);
  const symbol = normalize(protocol?.symbol);
  const slug = normalize(protocol?.slug);

  let score = 0;
  if (!target) return score;
  if (name === target) score += 100;
  if (symbol === target) score += 90;
  if (slug === target) score += 85;
  if (name.includes(target)) score += 60;
  if (target.includes(name) && name) score += 50;
  if (slug.includes(target)) score += 45;
  if (symbol && target.includes(symbol)) score += 35;
  if (protocol?.category) score += 3;
  if (protocol?.chains?.length) score += 2;
  return score;
}

function computePctChange(current, previous) {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function getClosestHistoricalTvl(tvlHistory, daysBack) {
  if (!Array.isArray(tvlHistory) || tvlHistory.length === 0) return null;
  const targetTs = Date.now() - daysBack * 24 * 60 * 60 * 1000;

  let closest = null;
  let smallestDistance = Number.POSITIVE_INFINITY;

  for (const point of tvlHistory) {
    const ts = (point?.date || 0) * 1000;
    const distance = Math.abs(ts - targetTs);
    if (Number.isFinite(point?.totalLiquidityUSD) && distance < smallestDistance) {
      closest = point.totalLiquidityUSD;
      smallestDistance = distance;
    }
  }

  return closest;
}

function sumLastNDays(values, days) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values]
    .filter((item) => Number.isFinite(item?.dailyFees) || Number.isFinite(item?.dailyRevenue))
    .sort((a, b) => (a?.timestamp || 0) - (b?.timestamp || 0));

  if (!sorted.length) return null;

  const tail = sorted.slice(-days);
  const totals = tail.reduce(
    (acc, item) => {
      acc.fees += Number(item?.dailyFees || 0);
      acc.revenue += Number(item?.dailyRevenue || 0);
      return acc;
    },
    { fees: 0, revenue: 0 }
  );

  return totals;
}

export async function collectOnchain(projectName) {
  const fallback = createEmptyOnchainResult(projectName);

  try {
    const protocols = await fetchJson(LLAMA_PROTOCOLS_URL);
    const match = [...(protocols || [])]
      .map((protocol) => ({ protocol, score: similarityScore(projectName, protocol) }))
      .sort((a, b) => b.score - a.score)[0];

    if (!match?.protocol?.slug || match.score < 20) {
      return { ...fallback, error: 'DeFiLlama protocol not found' };
    }

    const slug = match.protocol.slug;
    const [protocolData, feesData] = await Promise.allSettled([
      fetchJson(`${LLAMA_PROTOCOL_URL}/${encodeURIComponent(slug)}`),
      fetchJson(`${LLAMA_FEES_URL}/${encodeURIComponent(slug)}`).catch(() => null),
    ]);

    const protocol = protocolData.status === 'fulfilled' ? protocolData.value : null;
    const fees = feesData.status === 'fulfilled' ? feesData.value : null;
    const currentTvl = protocol?.currentChainTvls
      ? Object.values(protocol.currentChainTvls).reduce((sum, value) => sum + Number(value || 0), 0)
      : Number(protocol?.tvl ?? match.protocol?.tvl ?? 0) || null;
    const tvlHistory = protocol?.tvl || [];
    const tvl7dAgo = getClosestHistoricalTvl(tvlHistory, 7);
    const tvl30dAgo = getClosestHistoricalTvl(tvlHistory, 30);
    const feeTotals = sumLastNDays(fees?.totalDataChart || fees?.data || [], 7);

    return {
      ...fallback,
      slug,
      tvl: currentTvl,
      tvl_change_7d: computePctChange(currentTvl, tvl7dAgo),
      tvl_change_30d: computePctChange(currentTvl, tvl30dAgo),
      chains: protocol?.chains || match.protocol?.chains || [],
      category: protocol?.category || match.protocol?.category || null,
      fees_7d: feeTotals?.fees ?? fees?.total24h ? Number(fees.total24h) * 7 : null,
      revenue_7d: feeTotals?.revenue ?? null,
      error: null,
    };
  } catch (error) {
    return {
      ...fallback,
      error: error.name === 'AbortError' ? 'DeFiLlama timeout' : error.message,
    };
  }
}
