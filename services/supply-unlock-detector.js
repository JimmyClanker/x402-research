import { safeNum } from '../utils/math.js';
/**
 * supply-unlock-detector.js — Round 234 (AutoResearch)
 * Analyzes tokenomics data to detect upcoming supply unlock risk.
 * Works with existing collector data — no new API calls needed.
 */


/**
 * Analyze supply unlock pressure from existing tokenomics data.
 *
 * @param {object} tokenomics - tokenomics collector output
 * @param {object} market     - market collector output
 * @returns {{
 *   risk_level: 'high'|'medium'|'low'|'none'|'unknown',
 *   unlock_overhang_pct: number|null,
 *   dilution_risk: string|null,
 *   estimated_sell_pressure: 'severe'|'moderate'|'mild'|'minimal'|null,
 *   notes: string[]
 * }}
 */
export function analyzeSupplyUnlockRisk(tokenomics = {}, market = {}) {
  const notes = [];

  const pctCirculating = safeNum(tokenomics.pct_circulating ?? null, null);
  const unlockOverhang = safeNum(tokenomics.unlock_overhang_pct ?? null, null);
  const dilutionRisk = tokenomics.dilution_risk ?? null;
  const inflationRate = safeNum(tokenomics.inflation_rate ?? null, null);
  const mcap = safeNum(market.market_cap ?? 0);
  const fdv = safeNum(market.fully_diluted_valuation ?? 0);

  // Case 1: No tokenomics data
  if (pctCirculating === null && fdv === 0) {
    return { risk_level: 'unknown', unlock_overhang_pct: null, dilution_risk: null, estimated_sell_pressure: null, notes: ['Insufficient tokenomics data for unlock analysis.'] };
  }

  // Compute overhang from market data if not in tokenomics
  const overhang = unlockOverhang ?? (
    mcap > 0 && fdv > mcap ? ((fdv - mcap) / fdv) * 100 : null
  );

  let riskLevel = 'low';
  let sellPressure = 'minimal';

  if (overhang !== null) {
    if (overhang > 60) {
      riskLevel = 'high';
      sellPressure = 'severe';
      notes.push(`${overhang.toFixed(0)}% of total supply is not yet circulating — massive future dilution risk.`);
    } else if (overhang > 30) {
      riskLevel = 'medium';
      sellPressure = 'moderate';
      notes.push(`${overhang.toFixed(0)}% of supply locked — significant future unlock pressure.`);
    } else if (overhang > 10) {
      riskLevel = 'low';
      sellPressure = 'mild';
      notes.push(`${overhang.toFixed(0)}% supply overhang — manageable unlock schedule.`);
    } else {
      riskLevel = 'none';
      sellPressure = 'minimal';
      notes.push(`${overhang.toFixed(0)}% supply overhang — near fully diluted, minimal future pressure.`);
    }
  }

  // Inflation rate compounds overhang risk
  if (inflationRate !== null && inflationRate > 30) {
    if (riskLevel === 'low') riskLevel = 'medium';
    else if (riskLevel === 'medium') riskLevel = 'high';
    notes.push(`Annual inflation rate ${inflationRate.toFixed(0)}% amplifies dilution risk.`);
  }

  // Round 384 (AutoResearch batch): team vesting cliff detection
  // Projects <18 months old with >20% team allocation are approaching typical 12-18 month cliff
  const vestingInfo = tokenomics.vesting_info ?? {};
  const launchDate = vestingInfo.launch_date ?? tokenomics.launch_date ?? null;
  const teamAllocationPct = safeNum(vestingInfo.team_allocation_pct ?? null, null);
  if (launchDate && teamAllocationPct != null && teamAllocationPct > 15) {
    const launchMs = Date.now() - new Date(launchDate).getTime();
    const launchMonths = launchMs / (1000 * 60 * 60 * 24 * 30.44);
    if (Number.isFinite(launchMonths) && launchMonths > 0) {
      if (launchMonths >= 10 && launchMonths <= 14 && teamAllocationPct > 15) {
        // Approaching 12-month cliff — common team vesting schedule
        notes.push(`⏰ Team cliff warning: ${launchMonths.toFixed(0)} months since launch with ${teamAllocationPct.toFixed(0)}% team allocation — approaching typical 12-month team unlock cliff.`);
        if (riskLevel === 'low' || riskLevel === 'none') riskLevel = 'medium';
        if (sellPressure === 'minimal') sellPressure = 'mild';
      } else if (launchMonths >= 22 && launchMonths <= 26 && teamAllocationPct > 15) {
        // Approaching 24-month cliff
        notes.push(`⏰ 2-year cliff approaching: ${launchMonths.toFixed(0)} months since launch, ${teamAllocationPct.toFixed(0)}% team allocation — potential unlock event within 2 months.`);
        if (riskLevel === 'low' || riskLevel === 'none') riskLevel = 'medium';
      }
    }
  }

  return {
    risk_level: riskLevel,
    unlock_overhang_pct: overhang !== null ? parseFloat(overhang.toFixed(1)) : null,
    dilution_risk: dilutionRisk,
    estimated_sell_pressure: sellPressure,
    notes,
  };
}
