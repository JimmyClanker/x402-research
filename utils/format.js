/**
 * format.js — Shared formatting utilities for Clawnkers Alpha Scanner
 * Round 233 (AutoResearch nightly): Centralize formatting helpers used across services and templates.
 */

/**
 * Format a USD value into human-readable compact form.
 * $1.23B, $456.7M, $12.3K, $0.0042
 * @param {number|null} value
 * @returns {string}
 */
export function formatUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'n/a';
  const n = Number(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3)  return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  if (abs > 0 && abs < 1) {
    const decimals = abs < 0.0001 ? 6 : abs < 0.01 ? 5 : 4;
    return `${sign}$${abs.toFixed(decimals)}`;
  }
  return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/**
 * Format a percentage with sign and specified decimals.
 * @param {number|null} value
 * @param {number} [decimals=1]
 * @param {boolean} [signed=false] - prefix positive values with +
 * @returns {string}
 */
export function formatPercent(value, decimals = 1, signed = false) {
  if (value == null || !Number.isFinite(Number(value))) return 'n/a';
  const n = Number(value);
  const prefix = signed && n > 0 ? '+' : '';
  return `${prefix}${n.toFixed(decimals)}%`;
}

/**
 * Format elapsed time in a human-readable way.
 * 5 seconds → "5s", 90 seconds → "1m 30s", etc.
 * @param {number} ms - milliseconds
 * @returns {string}
 */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

/**
 * Format a token age in human-readable form.
 * @param {number|null} days - age in days
 * @returns {string}
 */
export function formatAge(days) {
  if (days == null || !Number.isFinite(Number(days))) return 'n/a';
  const d = Math.round(Number(days));
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30.44)}mo`;
  return `${(d / 365).toFixed(1)}yr`;
}

/**
 * Format a score (1-10) as a label.
 * @param {number|null} score
 * @returns {string}
 */
export function scoreLabel(score) {
  if (score == null || !Number.isFinite(Number(score))) return 'n/a';
  const s = Number(score);
  if (s >= 8.5) return 'STRONG BUY';
  if (s >= 7)   return 'BUY';
  if (s >= 5.5) return 'HOLD';
  if (s >= 3.5) return 'AVOID';
  return 'STRONG AVOID';
}

/**
 * Clamp a value between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}
