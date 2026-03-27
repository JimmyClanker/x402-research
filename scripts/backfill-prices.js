#!/usr/bin/env node
/**
 * backfill-prices.js — One-shot script to fill NULL prices in token_snapshots.
 *
 * Strategy:
 * 1. For each distinct project_name with NULL price, look up coingecko_id from token_universe
 * 2. Try to copy price from the nearest snapshot of the same project that HAS a price
 * 3. If no same-project price exists, fetch current price from CoinGecko (only useful for recent snapshots)
 *
 * Usage: node scripts/backfill-prices.js [--dry-run]
 */

import { getCalibrationDb } from '../calibration/db.js';

const DRY_RUN = process.argv.includes('--dry-run');
const COINGECKO_DELAY_MS = 1500; // respect rate limits

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPrice(coingeckoId) {
  if (!coingeckoId) return null;
  const id = String(coingeckoId).toLowerCase().trim();
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[backfill] Rate limited — waiting 60s`);
        await sleep(60000);
        return fetchPrice(coingeckoId); // retry once
      }
      return null;
    }
    const data = await res.json();
    return data?.[id]?.usd ?? null;
  } catch (err) {
    console.warn(`[backfill] fetchPrice(${coingeckoId}) failed: ${err.message}`);
    return null;
  }
}

async function main() {
  const db = getCalibrationDb();

  // Get all snapshots without price, grouped by project
  const missingByProject = db.prepare(`
    SELECT project_name, COUNT(*) as missing_count
    FROM token_snapshots
    WHERE price IS NULL OR price = 0
    GROUP BY project_name
    ORDER BY missing_count DESC
  `).all();

  console.log(`[backfill] Found ${missingByProject.length} projects with missing prices`);

  const updatePrice = db.prepare(`UPDATE token_snapshots SET price = ? WHERE id = ?`);
  let filled = 0;
  let skipped = 0;
  let apiCalls = 0;

  for (const { project_name, missing_count } of missingByProject) {
    // Strategy 1: Find nearest snapshot of the same project that HAS a price
    const nearestWithPrice = db.prepare(`
      SELECT price FROM token_snapshots
      WHERE LOWER(project_name) = LOWER(?) AND price IS NOT NULL AND price > 0
      ORDER BY id DESC LIMIT 1
    `).get(project_name);

    let price = nearestWithPrice?.price ?? null;

    // Strategy 2: Look up coingecko_id from universe, fetch current price
    if (price == null) {
      const universeRow = db.prepare(`
        SELECT coingecko_id FROM token_universe
        WHERE LOWER(name) = LOWER(?) OR LOWER(symbol) = LOWER(?) OR coingecko_id = ?
        LIMIT 1
      `).get(project_name, project_name, project_name.toLowerCase());

      const cgId = universeRow?.coingecko_id || project_name.toLowerCase();
      price = await fetchPrice(cgId);
      apiCalls++;
      if (apiCalls % 5 === 0) await sleep(COINGECKO_DELAY_MS); // rate limit
    }

    if (price == null || price === 0) {
      console.log(`[backfill] ✗ ${project_name} (${missing_count} snapshots) — no price found`);
      skipped += missing_count;
      continue;
    }

    // Get all snapshot IDs missing price for this project
    const missingSnapshots = db.prepare(`
      SELECT id FROM token_snapshots
      WHERE project_name = ? AND (price IS NULL OR price = 0)
    `).all(project_name);

    if (!DRY_RUN) {
      const tx = db.transaction(() => {
        for (const { id } of missingSnapshots) {
          updatePrice.run(price, id);
        }
      });
      tx();
    }

    filled += missingSnapshots.length;
    console.log(`[backfill] ✓ ${project_name} — filled ${missingSnapshots.length} snapshots @ $${price}${DRY_RUN ? ' (dry-run)' : ''}`);
  }

  console.log(`\n[backfill] Done — filled: ${filled}, skipped: ${skipped}, API calls: ${apiCalls}${DRY_RUN ? ' (DRY RUN)' : ''}`);
}

main().catch(err => {
  console.error(`[backfill] Fatal: ${err.message}`);
  process.exit(1);
});
