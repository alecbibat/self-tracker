'use strict';

const { query, DEFAULT_SETTINGS } = require('./db');

/**
 * Site settings live in the `settings` table as key -> JSONB value.
 * These helpers merge stored values over the defaults so newly added
 * default keys always have a value even before an admin saves anything.
 *
 * Because settings are read on nearly every request (for the nav, landing,
 * goals, etc.) they are cached in memory. The cache is invalidated on write
 * and also expires after a short TTL so that, if the app ever runs on more
 * than one dyno, an edit on one dyno still propagates to the others quickly.
 */

const CACHE_TTL_MS = 60 * 1000;
let cache = null;
let cacheExpires = 0;
let inflight = null;

function mergeOverDefaults(stored) {
  const merged = {};
  const keys = new Set([...Object.keys(DEFAULT_SETTINGS), ...Object.keys(stored)]);
  for (const key of keys) {
    const fallback = DEFAULT_SETTINGS[key];
    const value = stored[key];
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      merged[key] = { ...fallback, ...(value || {}) };
    } else {
      merged[key] = value !== undefined ? value : fallback;
    }
  }
  return merged;
}

async function loadAll() {
  const { rows } = await query('SELECT key, value FROM settings');
  const stored = {};
  for (const row of rows) stored[row.key] = row.value;
  const merged = mergeOverDefaults(stored);
  cache = merged;
  cacheExpires = nowMs() + CACHE_TTL_MS;
  return merged;
}

// Date.now via a helper so it's easy to reason about; plain Date.now is fine here.
function nowMs() {
  return Date.now();
}

function invalidate() {
  cache = null;
  cacheExpires = 0;
}

async function getAllSettings() {
  if (cache && nowMs() < cacheExpires) return cache;
  if (!inflight) {
    inflight = loadAll().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function getSetting(key) {
  const all = await getAllSettings();
  return all[key];
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
  invalidate();
  return getSetting(key);
}

module.exports = { getSetting, getAllSettings, setSetting, invalidate };
