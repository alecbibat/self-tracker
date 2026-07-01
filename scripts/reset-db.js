'use strict';

/**
 * Danger: drops every application table and re-runs migrations.
 * Usage: node scripts/reset-db.js --yes
 */
require('dotenv').config();
const { pool, migrate } = require('../src/db');

const TABLES = [
  'session',
  'photos',
  'projects',
  'weights',
  'meals',
  'foods',
  'habit_entries',
  'habits',
  'media',
  'settings',
];

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to reset without --yes. This DROPS all data.');
    process.exit(1);
  }
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    console.log('dropped', t);
  }
  await migrate();
  console.log('re-migrated. done.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
