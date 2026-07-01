'use strict';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    '\n[fatal] DATABASE_URL is not set. Create a .env file (see .env.example) ' +
      'or provision the Heroku Postgres add-on.\n'
  );
}

// Heroku Postgres requires SSL; a local Postgres almost never does.
// Enable SSL unless the host is local or explicitly disabled.
function shouldUseSsl(url) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') return true;
  if (!url) return false;
  return !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
}

const pool = new Pool({
  connectionString,
  ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on('error', (err) => {
  console.error('[db] unexpected idle client error', err);
});

/** Run a parameterised query. */
function query(text, params) {
  return pool.query(text, params);
}

/** Convenience: run a callback inside a transaction. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema. Every statement is idempotent (IF NOT EXISTS) so migrate() can run
// on every boot. This keeps deployment to a single `git push heroku`.
// ---------------------------------------------------------------------------
const SCHEMA_STATEMENTS = [
  // Key/value site settings, stored as JSONB so each value can be an object.
  `CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,

  // Binary media (project covers, landing background, photos) kept in Postgres.
  `CREATE TABLE IF NOT EXISTS media (
      id         SERIAL PRIMARY KEY,
      mime       TEXT NOT NULL,
      bytes      BYTEA NOT NULL,
      byte_size  INTEGER NOT NULL DEFAULT 0,
      filename   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // --- Habit tracker -------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS habits (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      type       TEXT NOT NULL DEFAULT 'yesno' CHECK (type IN ('yesno','quantity')),
      unit       TEXT,
      target     NUMERIC,
      color      TEXT NOT NULL DEFAULT '#5b8def',
      position   INTEGER NOT NULL DEFAULT 0,
      archived   BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS habit_entries (
      id         SERIAL PRIMARY KEY,
      habit_id   INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
      entry_date DATE NOT NULL,
      done       BOOLEAN NOT NULL DEFAULT false,
      value      NUMERIC NOT NULL DEFAULT 0,
      UNIQUE (habit_id, entry_date)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_habit_entries_date ON habit_entries(entry_date)`,

  // --- Nutrition / weight --------------------------------------------------
  // Reusable saved foods/meals library for quick search + select.
  `CREATE TABLE IF NOT EXISTS foods (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      serving_label TEXT,
      calories      NUMERIC NOT NULL DEFAULT 0,
      protein       NUMERIC NOT NULL DEFAULT 0,
      carbs         NUMERIC NOT NULL DEFAULT 0,
      fat           NUMERIC NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(lower(name))`,
  // Individual logged meals for a given day.
  `CREATE TABLE IF NOT EXISTS meals (
      id         SERIAL PRIMARY KEY,
      entry_date DATE NOT NULL,
      name       TEXT NOT NULL,
      calories   NUMERIC NOT NULL DEFAULT 0,
      protein    NUMERIC NOT NULL DEFAULT 0,
      carbs      NUMERIC NOT NULL DEFAULT 0,
      fat        NUMERIC NOT NULL DEFAULT 0,
      quantity   NUMERIC NOT NULL DEFAULT 1,
      food_id    INTEGER REFERENCES foods(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(entry_date)`,
  // One weight reading per day.
  `CREATE TABLE IF NOT EXISTS weights (
      id         SERIAL PRIMARY KEY,
      entry_date DATE NOT NULL UNIQUE,
      weight     NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // --- Projects / photos ---------------------------------------------------
  `CREATE TABLE IF NOT EXISTS projects (
      id             SERIAL PRIMARY KEY,
      slug           TEXT NOT NULL UNIQUE,
      title          TEXT NOT NULL,
      summary        TEXT,
      description    TEXT,
      image_url      TEXT,
      image_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      external_url   TEXT,
      kind           TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','photos')),
      position       INTEGER NOT NULL DEFAULT 0,
      published      BOOLEAN NOT NULL DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS photos (
      id         SERIAL PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      caption    TEXT,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_photos_project ON photos(project_id)`,
];

// Default settings seeded once, on first boot. Users edit these from /app/admin.
const DEFAULT_SETTINGS = {
  site: {
    brand: 'My Self Tracker',
    footer_text: '',
  },
  landing: {
    title: 'Hello, I’m Alec',
    subtitle: 'Builder, athlete, and lifelong tracker of things.',
    background_type: 'gradient', // 'image' | 'video' | 'gradient'
    background_media_id: null,
    background_url: '',
    overlay: 0.45, // 0..1 dark overlay for legibility
    links: [
      { label: 'Resume', href: '#', icon: 'file' },
      { label: 'Skills', href: '#', icon: 'star' },
      { label: 'Projects', href: '/projects', icon: 'grid' },
    ],
  },
  nutrition_goals: {
    calories: 2200,
    protein: 160,
    carbs: 220,
    fat: 70,
  },
  weight_goal: {
    target: null,
    unit: 'lb',
  },
};

async function seedDefaults(client) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await client.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }
  // Ensure the built-in "Photos" project exists so the photo reel has a home.
  await client.query(
    `INSERT INTO projects (slug, title, summary, description, kind, position)
       VALUES ('photos', 'Photos', 'A running photo reel.',
               'A collection of photos, shown as a scrolling reel. Click any photo to view it full size.',
               'photos', 100)
       ON CONFLICT (slug) DO NOTHING`
  );
}

let migratePromise = null;

/** Create tables and seed defaults. Safe to call repeatedly; runs once. */
function migrate() {
  if (!migratePromise) {
    migratePromise = withTransaction(async (client) => {
      for (const stmt of SCHEMA_STATEMENTS) {
        await client.query(stmt);
      }
      await seedDefaults(client);
    }).then(() => {
      console.log('[db] schema ready');
    });
  }
  return migratePromise;
}

module.exports = {
  pool,
  query,
  withTransaction,
  migrate,
  DEFAULT_SETTINGS,
};
