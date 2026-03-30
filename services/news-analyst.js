/**
 * News Analyst — LLM-powered contextual analysis of news mentions.
 *
 * Two modes:
 * - quick: keyword heuristic only (free, <1ms)
 * - full:  Opus via Anthropic API for narrative analysis ($0, API key in launchd)
 *          + Grok X search for real-time Twitter sentiment (~$0.002)
 *          Falls back to heuristic if LLM calls fail.
 *
 * Added: 28 Mar 2026
 */

const ANALYSIS_TIMEOUT_MS = 20_000;
const X_SEARCH_TIMEOUT_MS = 15_000;
const XAI_CHAT_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_CHAT_MODEL = 'grok-4-0709';

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze news items for a project and return structured risk assessment.
 * 
 * @param {string} projectName
 * @param {Array} newsItems - Array of {title, highlights, url, date}
 * @param {object} options
 * @param {string} options.mode - 'quick' (heuristic) or 'full' (LLM + X search)
 * @param {string} [options.anthropicApiKey] - Anthropic API key (for Opus)
 * @param {string} [options.xaiApiKey] - xAI API key (for Grok X search)
 * @returns {object} Structured analysis with corrected risk levels
 */
export async function analyzeNews(projectName, newsItems, options = {}) {
  if (!newsItems?.length) {
    return createEmptyAnalysis();
  }

  const { mode = 'quick', anthropicApiKey, xaiApiKey } = options;

  // Filter to risk-relevant items
  const relevantItems = filterRiskItems(newsItems);

  if (relevantItems.length === 0) {
    return createEmptyAnalysis();
  }

  // Quick mode: keyword heuristic only (free)
  if (mode === 'quick') {
    return keywordFallbackAnalysis(projectName, relevantItems);
  }

  // Full mode: parallel LLM narrative analysis + X search
  const [narrativeResult, xSentiment] = await Promise.allSettled([
    analyzeNarrative(projectName, relevantItems, newsItems, { anthropicApiKey }),
    searchXSentiment(projectName, { xaiApiKey }),
  ]);

  const narrative = narrativeResult.status === 'fulfilled'
    ? narrativeResult.value
    : keywordFallbackAnalysis(projectName, relevantItems);

  const xData = xSentiment.status === 'fulfilled' ? xSentiment.value : null;

  // Merge X sentiment into narrative result
  if (xData) {
    narrative.x_sentiment = xData;
    // If X shows strong directional sentiment, override neutral
    if (narrative.overall_sentiment_shift === 'neutral' && xData.dominant_sentiment !== 'neutral') {
      narrative.overall_sentiment_shift = xData.dominant_sentiment;
    }
    // Enrich key insight with X context
    if (xData.key_narrative && !narrative.key_insight) {
      narrative.key_insight = xData.key_narrative;
    } else if (xData.key_narrative && narrative.key_insight) {
      narrative.key_insight += ` X sentiment: ${xData.key_narrative}`;
    }
  }

  return narrative;
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1: Opus narrative analysis (Anthropic API)
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeNarrative(projectName, relevantItems, allNewsItems, options = {}) {
  const anthropicKey = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
  console.log(`[news-analyst] narrative: gatewayToken=${!!gatewayToken} anthropicKey=${!!anthropicKey} riskItems=${relevantItems.length}`);
  if (!anthropicKey && !gatewayToken) {
    console.error('[news-analyst] No ANTHROPIC_API_KEY or OPENCLAW_GATEWAY_TOKEN — falling back to heuristic');
    return keywordFallbackAnalysis(projectName, relevantItems);
  }

  // Build news digest: risk items first, then recent general items for context
  const riskDigest = relevantItems.slice(0, 8).map((item, i) => {
    const date = item.date ? new Date(item.date).toISOString().split('T')[0] : 'unknown';
    const highlights = (item.highlights || []).join(' ').slice(0, 250);
    return `[RISK-${i + 1}] ${date} | ${item.title}${highlights ? `\n    ${highlights}` : ''}`;
  }).join('\n');

  const contextDigest = allNewsItems
    .filter(i => !relevantItems.includes(i))
    .slice(0, 6)
    .map((item, i) => {
      const date = item.date ? new Date(item.date).toISOString().split('T')[0] : 'unknown';
      return `[CTX-${i + 1}] ${date} | ${item.title}`;
    }).join('\n');

  const prompt = `You are analyzing news about "${projectName}" for an investment scanner. Today is ${new Date().toISOString().split('T')[0]}.

RISK-FLAGGED NEWS (these contain exploit/hack/unlock/regulatory keywords):
${riskDigest}

RECENT GENERAL NEWS (for context):
${contextDigest || '(none)'}

Classify each risk category and provide investment-relevant analysis.

Rules:
- "active" exploit = confirmed incident in the last 7 days directly affecting this protocol
- "historical" = references to past events, retrospective reviews, post-mortems
- "ecosystem" = about other protocols or the broader DeFi ecosystem
- "imminent" unlock = scheduled within 30 days from today
- "distant" unlock = >30 days away or already completed
- Sentiment should reflect the OVERALL narrative direction, not just risk items

Respond in JSON only:
{
  "exploit_risk": "active" | "historical" | "ecosystem" | "none",
  "exploit_summary": "one line",
  "unlock_risk": "imminent" | "upcoming" | "distant" | "none",
  "unlock_summary": "one line",
  "regulatory_risk": "direct" | "industry" | "none",
  "regulatory_summary": "one line",
  "overall_sentiment_shift": "positive" | "neutral" | "negative",
  "key_insight": "one line — the most important thing an investor should know right now",
  "narrative_phase": "accumulation" | "markup" | "distribution" | "markdown" | "unclear"
}`;

  // PRIMARY: Grok Chat API (fast, reliable JSON, zero gateway dependency)
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
      const response = await fetch(XAI_CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${xaiKey}`,
        },
        body: JSON.stringify({
          model: GROK_CHAT_MODEL,
          messages: [
            { role: 'system', content: 'You are a crypto risk analyst. Respond with valid JSON only, no markdown code blocks.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 800,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        const text = (data.choices?.[0]?.message?.content || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const analysis = JSON.parse(jsonMatch[0]);
          console.log(`[news-analyst] Grok Chat OK (${text.length} chars)`);
          return {
            ...createEmptyAnalysis(),
            ...analysis,
            analyzed: true,
            items_analyzed: relevantItems.length,
            model_used: GROK_CHAT_MODEL,
          };
        }
      } else {
        const errBody = await response.text().catch(() => '');
        console.error(`[news-analyst] Grok Chat ${response.status}: ${errBody.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[news-analyst] Grok Chat error: ${err.message}`);
    }
  }

  // FALLBACK 1: OpenClaw gateway → OAuth Opus (zero cost)
  try {
    let text = '';
    if (gatewayToken) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
      const response = await fetch('http://localhost:18789/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          model: 'openclaw',
          messages: [
            { role: 'system', content: 'You are a crypto risk analyst. Respond with valid JSON only, no markdown code blocks.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 800,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Gateway ${response.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await response.json();
      text = (data.choices?.[0]?.message?.content || '').trim();
    } else if (anthropicKey) {
      // FALLBACK 2: direct Anthropic API (costs money)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          system: 'You are a crypto risk analyst. Respond with valid JSON only, no markdown code blocks.',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 600,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Anthropic ${response.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await response.json();
      text = (data.content?.[0]?.text || '').trim();
    } else {
      throw new Error('No gateway token and no ANTHROPIC_API_KEY');
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[news-analyst] Failed to parse fallback JSON response');
      return keywordFallbackAnalysis(projectName, relevantItems);
    }

    const analysis = JSON.parse(jsonMatch[0]);
    return {
      ...createEmptyAnalysis(),
      ...analysis,
      analyzed: true,
      items_analyzed: relevantItems.length,
      model_used: gatewayToken ? 'openclaw' : 'claude-sonnet-4-20250514',
    };
  } catch (err) {
    console.error(`[news-analyst] Narrative error: ${err.message} (stack: ${err.stack?.split('\n')[1]?.trim() || 'n/a'})`);
    return keywordFallbackAnalysis(projectName, relevantItems);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 2: Grok X/Twitter real-time sentiment search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search X/Twitter for real-time sentiment about a project using Grok's
 * native X search capability (search_mode: "on").
 */
async function searchXSentiment(projectName, options = {}) {
  const xaiKey = options.xaiApiKey || process.env.XAI_API_KEY;
  if (!xaiKey) {
    return null;
  }

  const prompt = `Search X/Twitter for the latest posts about "${projectName}" crypto project in the last 7 days.

Analyze the sentiment and narratives. Return JSON only:
{
  "dominant_sentiment": "positive" | "neutral" | "negative",
  "sentiment_score": <-1.0 to 1.0>,
  "bullish_signals": ["list of bullish narratives from X"],
  "bearish_signals": ["list of bearish narratives from X"],
  "key_narrative": "one line — the dominant X narrative right now",
  "notable_accounts": ["any notable accounts discussing this"],
  "post_volume": "high" | "medium" | "low",
  "sources_found": <number of relevant posts analyzed>
}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), X_SEARCH_TIMEOUT_MS);

    // Use the new xAI Responses API with x_search tool (search_parameters deprecated since Mar 2026)
    const response = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4-1-fast-non-reasoning',
        input: [
          { role: 'system', content: 'You are a crypto sentiment analyst. Search X for real-time data. Respond with valid JSON only, no markdown.' },
          { role: 'user', content: prompt },
        ],
        tools: [{ type: 'x_search' }],
        temperature: 0.1,
        max_output_tokens: 500,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[news-analyst] Grok X search ${response.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = await response.json();
    // Responses API: output array contains tool_use items then a message with output_text
    const messageOutput = data.output?.find(o => o.type === 'message');
    const textContent = messageOutput?.content?.find(c => c.type === 'output_text');
    const text = (textContent?.text || '').trim();
    
    // Extract X citation URLs for provenance
    const xCitations = (textContent?.annotations || [])
      .filter(a => a.type === 'url_citation' && a.url?.includes('x.com'))
      .map(a => a.url)
      .slice(0, 10);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[news-analyst] Failed to parse Grok X search JSON');
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    result.model_used = 'grok-4-fast';
    result.search_mode = 'x_search_tool';
    if (xCitations.length > 0) result.x_citations = xCitations;
    return result;
  } catch (err) {
    console.error(`[news-analyst] X search error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword heuristic fallback (free, used for quick mode + LLM failures)
// ─────────────────────────────────────────────────────────────────────────────

function filterRiskItems(newsItems) {
  return newsItems.filter(item => {
    const text = `${item.title || ''} ${(item.highlights || []).join(' ')} ${item.url || ''}`.toLowerCase();
    return /hack|exploit|stolen|drained|compromised|attack|rugpull|unlock|vesting|cliff|regulatory|sec |cftc|lawsuit|sued|security|breach|vulnerab/.test(text);
  });
}

function keywordFallbackAnalysis(projectName, items) {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const exploitItems = items.filter(i => {
    const text = `${i.title} ${(i.highlights || []).join(' ')}`.toLowerCase();
    return /hack|exploit|stolen|drained|compromised|attack|rugpull/.test(text);
  });
  const recentExploits = exploitItems.filter(i => new Date(i.date || 0).getTime() > sevenDaysAgo);
  const oldExploits = exploitItems.filter(i => new Date(i.date || 0).getTime() <= sevenDaysAgo);

  const directExploits = exploitItems.filter(i => {
    const text = i.title.toLowerCase();
    return text.includes(projectName.toLowerCase()) && /hack|exploit|stolen|drained/.test(text);
  });

  let exploitRisk = 'none';
  if (recentExploits.length >= 2 && directExploits.length >= 1) exploitRisk = 'active';
  else if (directExploits.length > 0 && oldExploits.length > recentExploits.length) exploitRisk = 'historical';
  else if (exploitItems.length > 0) exploitRisk = 'ecosystem';

  const unlockItems = items.filter(i => {
    const text = `${i.title} ${(i.highlights || []).join(' ')}`.toLowerCase();
    return /unlock|vesting|cliff/.test(text);
  });
  const recentUnlockNews = unlockItems.filter(i => new Date(i.date || 0).getTime() > thirtyDaysAgo);

  let unlockRisk = 'none';
  if (recentUnlockNews.length >= 2) unlockRisk = 'upcoming';
  else if (unlockItems.length > 0) unlockRisk = 'distant';

  return {
    exploit_risk: exploitRisk,
    exploit_summary: exploitRisk === 'active'
      ? `${recentExploits.length} recent articles report active security issues`
      : exploitRisk === 'historical'
        ? 'Exploit mentions reference past incidents, not active threats'
        : exploitRisk === 'ecosystem'
          ? `Exploit mentions are about the broader ecosystem, not ${projectName} directly`
          : 'No exploit mentions found',
    unlock_risk: unlockRisk,
    unlock_summary: unlockRisk === 'upcoming'
      ? `${recentUnlockNews.length} recent articles discuss upcoming token unlocks`
      : unlockRisk === 'distant'
        ? 'Unlock mentions reference distant or completed events'
        : 'No unlock concerns',
    regulatory_risk: 'none',
    regulatory_summary: 'No regulatory concerns detected',
    overall_sentiment_shift: 'neutral',
    key_insight: '',
    analyzed: false,
    items_analyzed: items.length,
    model_used: 'keyword_heuristic',
  };
}

function createEmptyAnalysis() {
  return {
    exploit_risk: 'none',
    exploit_summary: 'No relevant news to analyze',
    unlock_risk: 'none',
    unlock_summary: 'No relevant news to analyze',
    regulatory_risk: 'none',
    regulatory_summary: 'No relevant news to analyze',
    overall_sentiment_shift: 'neutral',
    key_insight: '',
    analyzed: false,
    items_analyzed: 0,
    model_used: null,
  };
}
