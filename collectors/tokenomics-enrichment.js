/**
 * tokenomics-enrichment.js — Exa-powered tokenomics data enrichment
 * 
 * When primary sources (Messari) fail, this collector uses Exa search
 * to find real tokenomics data from sources like:
 * - tokenomist.ai (allocation breakdowns, unlock schedules)
 * - dropstab.com (vesting schedules)
 * - official project docs/blogs
 * - coingecko tokenomics pages
 * - medium articles with detailed breakdowns
 * 
 * The enrichment data overrides crude estimates from estimateInflationFromMarket().
 * 
 * Created: 28 Mar 2026
 */

import { fetchJson } from './fetch.js';

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789/v1/chat/completions';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

const EXA_API_KEY = process.env.EXA_API_KEY || '';

/**
 * Search Exa for tokenomics data about a project.
 * Uses direct Exa API call with highlights for richer data extraction.
 * @param {string} projectName 
 * @returns {Array} - search result highlights
 */
async function searchTokenomicsData(projectName) {
  if (!EXA_API_KEY) {
    console.warn('[tokenomics-enrichment] No EXA_API_KEY — skipping search');
    return [];
  }

  try {
    const query = `${projectName} token tokenomics allocation distribution team investors community vesting unlock schedule 2024 2025 2026`;
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': EXA_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: 5,
        useAutoprompt: true,
        contents: {
          highlights: {
            numSentences: 5,
            highlightsPerUrl: 4,
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.error(`[tokenomics-enrichment] Exa returned ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data?.results || [];
  } catch (err) {
    console.error(`[tokenomics-enrichment] Exa search failed: ${err.message}`);
    return [];
  }
}

/**
 * Use OpenClaw gateway (Haiku — cheap, fast) to extract structured tokenomics
 * from Exa search highlights.
 * 
 * @param {string} projectName 
 * @param {Array} exaResults 
 * @param {object} currentData - current tokenomics data (CoinGecko/Messari)
 * @returns {object|null} - structured enrichment or null
 */
async function extractTokenomicsFromResults(projectName, exaResults, currentData = {}) {
  if (!exaResults?.length) return null;

  const gatewayToken = OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) {
    console.warn('[tokenomics-enrichment] No gateway token — skipping LLM extraction');
    return null;
  }

  // Build context from Exa results
  const context = exaResults.map(r => {
    const highlights = (r.highlights || []).join('\n');
    return `SOURCE: ${r.title || r.url}\nURL: ${r.url}\n${highlights}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are a crypto tokenomics data extractor. Given search results about a token's tokenomics, extract ONLY factual data that is explicitly stated in the sources. Never estimate or infer — if a value is not clearly stated, return null for that field.`;

  const userPrompt = `Extract tokenomics data for "${projectName}" from these search results:

${context}

Current data from CoinGecko (may be incomplete):
- Circulating supply %: ${currentData.pct_circulating?.toFixed(1) ?? 'unknown'}%
- Total supply: ${currentData.total_supply ?? 'unknown'}
- Max supply: ${currentData.max_supply ?? 'unknown'}

Return a JSON object with ONLY values you found EXPLICITLY stated in the sources. Use null for ANYTHING not clearly stated — never estimate, never calculate, never infer:

{
  "token_allocation": {
    "community_airdrop_pct": <number or null>,
    "future_emissions_pct": <number or null>,
    "team_pct": <number or null>,
    "foundation_pct": <number or null>,
    "investors_vc_pct": <number or null>,
    "treasury_pct": <number or null>,
    "other_pct": <number or null>,
    "other_label": <string or null>
  },
  "has_vc_funding": <true/false/null — false only if sources explicitly state no VC, or if no investor allocation exists>,
  "total_raised_usd": <number or null>,
  "real_inflation_rate": <number or null — ONLY if a source explicitly states an annual inflation rate>,
  "staking_apy": <number or null — ONLY if a source explicitly states current staking APY>,
  "buyback_burn": <true/false/null — true only if sources confirm buyback or burn mechanism>,
  "revenue_to_holders": <string or null — describe how fees/revenue flow to token holders if stated>,
  "vesting_team_months": <number or null — total vesting period in months>,
  "vesting_team_cliff_months": <number or null — cliff period before any team tokens unlock>,
  "tge_date": <"YYYY-MM-DD" or null>,
  "data_sources": [<list of source URLs that contained useful data>],
  "confidence_note": <brief note on data quality and any discrepancies between sources>
}

CRITICAL: null is ALWAYS better than a guess. If you're not 100% sure a value is explicitly stated in the sources, use null.`;

  try {
    const response = await fetch(OPENCLAW_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1000,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      console.error(`[tokenomics-enrichment] Gateway returned ${response.status}`);
      return null;
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[tokenomics-enrichment] No JSON found in LLM response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    parsed._source = 'exa_llm_enrichment';
    parsed._enriched_at = new Date().toISOString();
    return parsed;
  } catch (err) {
    console.error(`[tokenomics-enrichment] LLM extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Apply enrichment data to override estimated tokenomics values.
 * Only overrides values that were estimated (not from authoritative sources).
 * 
 * @param {object} tokenomicsData - current tokenomics collector output
 * @param {object} enrichment - extracted enrichment data
 * @returns {object} - merged tokenomics data with enrichment applied
 */
export function applyEnrichment(tokenomicsData, enrichment) {
  if (!enrichment || !tokenomicsData) return tokenomicsData;

  const result = { ...tokenomicsData };

  // Override inflation rate if we found a real one AND current is estimated
  if (enrichment.real_inflation_rate != null && tokenomicsData.inflation_source === 'estimated_from_supply') {
    result.inflation_rate = enrichment.real_inflation_rate;
    result.inflation_source = 'exa_enrichment';
    console.log(`[tokenomics-enrichment] Inflation override: ${tokenomicsData.inflation_rate}% → ${enrichment.real_inflation_rate}% (from Exa sources)`);
  }

  // If staking APY is found and inflation was estimated, use APY as better proxy
  if (enrichment.staking_apy != null && tokenomicsData.inflation_source === 'estimated_from_supply' && enrichment.real_inflation_rate == null) {
    // Staking APY is a reasonable inflation floor for PoS chains
    result.inflation_rate = enrichment.staking_apy;
    result.inflation_source = 'exa_enrichment_staking_apy';
    console.log(`[tokenomics-enrichment] Inflation override via staking APY: ${tokenomicsData.inflation_rate}% → ${enrichment.staking_apy}%`);
  }

  // Add token allocation data
  if (enrichment.token_allocation) {
    result.token_allocation_enriched = enrichment.token_allocation;
    // If we found that there's no VC funding, mark it
    if (enrichment.has_vc_funding === false) {
      result.has_vc_funding = false;
      result.total_raised_usd = 0;
    } else if (enrichment.total_raised_usd != null) {
      result.total_raised_usd = enrichment.total_raised_usd;
      result.has_vc_funding = enrichment.total_raised_usd > 0;
    }
  }

  // Buyback/burn flag
  if (enrichment.buyback_burn != null) {
    result.buyback_burn = enrichment.buyback_burn;
  }

  // Team vesting
  if (enrichment.vesting_team_months != null && result.vesting_info) {
    result.vesting_info.team_vesting_months = enrichment.vesting_team_months;
  }

  // TGE date
  if (enrichment.tge_date && result.vesting_info) {
    result.vesting_info.launch_date = enrichment.tge_date;
    result.vesting_info.launch_date_source = 'exa_enrichment';
  } else if (enrichment.tge_date) {
    result.vesting_info = {
      launch_date: enrichment.tge_date,
      launch_date_source: 'exa_enrichment',
    };
  }

  // Store enrichment metadata
  result._enrichment = {
    source: 'exa_llm',
    data_sources: enrichment.data_sources || [],
    confidence_note: enrichment.confidence_note || null,
    enriched_at: enrichment._enriched_at,
  };

  return result;
}

/**
 * Main entry point: search + extract + return structured enrichment.
 * Called by the pipeline during full scans when tokenomics data is low-quality.
 * 
 * @param {string} projectName 
 * @param {object} exaService 
 * @param {object} currentTokenomics - current tokenomics data
 * @returns {object|null}
 */
export async function enrichTokenomics(projectName, _exaService, currentTokenomics = {}) {
  const startMs = Date.now();
  
  // Only enrich if current data is estimated/missing
  const needsEnrichment = 
    currentTokenomics.inflation_source === 'estimated_from_supply' ||
    !currentTokenomics.token_distribution ||
    currentTokenomics.error;
  
  if (!needsEnrichment) {
    console.log(`[tokenomics-enrichment] ${projectName}: data quality OK, skipping enrichment`);
    return null;
  }

  console.log(`[tokenomics-enrichment] ${projectName}: low data quality detected, searching for real tokenomics data...`);

  // Uses direct Exa API (no exaService dependency)
  const exaResults = await searchTokenomicsData(projectName);
  if (!exaResults.length) {
    console.log(`[tokenomics-enrichment] ${projectName}: no Exa results found`);
    return null;
  }

  console.log(`[tokenomics-enrichment] ${projectName}: found ${exaResults.length} sources, extracting with LLM...`);

  const enrichment = await extractTokenomicsFromResults(projectName, exaResults, currentTokenomics);
  
  const durationMs = Date.now() - startMs;
  console.log(`[tokenomics-enrichment] ${projectName}: ${enrichment ? 'enrichment complete' : 'extraction failed'} (${durationMs}ms)`);

  return enrichment;
}
