'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool, migrate } = require('./src/db');
const { requireAuth, exposeAuth } = require('./src/auth');
const { getAllSettings } = require('./src/settings');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// Cache-busting token for /static asset URLs (?v=...). Heroku sets
// SOURCE_VERSION to the deployed commit SHA; package.json version is the
// local fallback. Without this, the 7-day static maxAge would serve
// returning visitors a stale mix of old and new CSS/JS after a deploy.
const ASSET_VERSION = (process.env.SOURCE_VERSION || require('./package.json').version).slice(0, 12);

// Behind Heroku's router; needed for secure cookies + correct protocol.
app.set('trust proxy', 1);

// Gzip HTML/CSS/JS/JSON responses (already-compressed images are skipped).
app.use(compression());

// --- Views ---------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Security headers ----------------------------------------------------
// CSP allows our own assets and inline styles (used for full-screen
// background images). Chart.js is self-hosted, so no CDN is needed.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'data:', 'blob:', 'https:'],
        'font-src': ["'self'", 'https:', 'data:'],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'self'"],
        'upgrade-insecure-requests': isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// --- Body parsing --------------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// --- Static assets -------------------------------------------------------
app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), {
    maxAge: isProd ? '7d' : 0,
  })
);

// Public, DB-light routes are mounted BEFORE the session + settings
// middleware so asset/image/health requests skip that per-request work.
// (Media is public and heavily requested — e.g. a photo reel loads many.)
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/media', require('./src/routes/media'));

// --- Sessions ------------------------------------------------------------
app.use(
  session({
    store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    // rolling:false avoids a session-table write on every authenticated
    // request; the 30-day cookie lifetime is measured from login.
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);

app.use(exposeAuth);

// Serialize data for embedding in a <script type="application/json"> block so
// a value containing "</script>" (or U+2028/U+2029) can't break out of the tag.
// Views MUST use <%- jsonScript(data) %> instead of raw JSON.stringify.
function jsonScript(value) {
  return JSON.stringify(value === undefined ? null : value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

// Make site settings available to every rendered view as `settings`.
// JSON API routes don't render views, so they skip this entirely.
app.use(async (req, res, next) => {
  res.locals.jsonScript = jsonScript;
  res.locals.assetVersion = ASSET_VERSION;
  if (req.path.startsWith('/api/')) return next();
  try {
    res.locals.settings = await getAllSettings();
    res.locals.currentPath = req.path;
    next();
  } catch (err) {
    next(err);
  }
});

// --- Routes --------------------------------------------------------------
// (/media and /healthz are mounted earlier, before session/settings.)
app.use('/', require('./src/routes/auth'));
app.use('/', require('./src/routes/public'));
app.use('/', require('./src/routes/photos'));

// Private section landing / dashboard.
app.get('/app', requireAuth, async (req, res, next) => {
  try {
    res.render('app/dashboard', { title: 'Dashboard', active: 'dashboard' });
  } catch (err) {
    next(err);
  }
});

app.use('/', require('./src/routes/habits'));
app.use('/', require('./src/routes/nutrition'));
app.use('/', require('./src/routes/admin'));

// --- 404 + error handling ------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).render('error', {
    title: 'Not found',
    status: 404,
    message: 'That page could not be found.',
  });
});

// Postgres error codes that mean "bad client input", not a server fault, so
// they should surface as 400 rather than 500:
//   22003 numeric out of range, 22007/22008 invalid datetime,
//   22P02 invalid text representation, 23502 not-null, 23503 FK violation,
//   23505 unique violation, 23514 check violation.
const PG_BAD_REQUEST_CODES = new Set([
  '22003', '22007', '22008', '22P02', '23502', '23503', '23505', '23514',
]);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  if (err && PG_BAD_REQUEST_CODES.has(err.code)) status = 400;
  if (status >= 500) console.error('[error]', err);
  if (req.path.startsWith('/api/')) {
    const message = status === 400 ? err.publicMessage || 'Invalid request' : err.publicMessage || 'Server error';
    return res.status(status).json({ error: message });
  }
  res.status(status).render('error', {
    title: status === 400 ? 'Bad request' : 'Something went wrong',
    status,
    message: isProd ? (status === 400 ? 'Invalid request.' : 'Something went wrong.') : String(err.stack || err),
  });
});

const PORT = process.env.PORT || 3000;

// Fail fast with an actionable message instead of a confusing
// "ECONNREFUSED 127.0.0.1:5432" when the database isn't configured.
if (!process.env.DATABASE_URL) {
  console.error(
    '\n[fatal] DATABASE_URL is not set — the app cannot start.\n' +
      'On Heroku, attach Postgres (this sets DATABASE_URL automatically):\n' +
      '    heroku addons:create heroku-postgresql:essential-0 -a <your-app>\n' +
      'Locally, copy .env.example to .env and set DATABASE_URL.\n'
  );
  process.exit(1);
}

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] listening on http://localhost:${PORT} (${isProd ? 'production' : 'development'})`);
    });
  })
  .catch((err) => {
    console.error('[fatal] failed to connect to / migrate the database. Check that DATABASE_URL is correct and the Postgres add-on is attached.', err);
    process.exit(1);
  });

module.exports = app;
