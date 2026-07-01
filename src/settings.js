'use strict';

const { query, DEFAULT_SETTINGS } = require('./db');

/**
 * Site settings live in the `settings` table as key -> JSONB value.
 * These helpers merge stored values over the defaults so newly added
 * default keys always have a value even before an admin saves anything.
 */

async function getSetting(key) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  const stored = rows[0] ? rows[0].value : {};
  const fallback = DEFAULT_SETTINGS[key];
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    return { ...fallback, ...(stored || {}) };
  }
  return stored !== undefined && stored !== null ? stored : fallback;
}

async function getAllSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const stored = {};
  for (const row of rows) stored[row.key] = row.value;
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

async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
  return getSetting(key);
}

module.exports = { getSetting, getAllSettings, setSetting };
