'use strict';

const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (!ADMIN_PASSWORD) {
  console.warn(
    '[auth] ADMIN_PASSWORD is not set — the private section cannot be unlocked. ' +
      'Set it in .env locally or as a Heroku config var.'
  );
}

/** Constant-time comparison so login timing does not leak the password. */
function passwordMatches(candidate) {
  if (!ADMIN_PASSWORD || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) {
    // Still burn a comparison to keep timing roughly constant.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Gate for private pages: redirect browsers to /login, 401 for API calls. */
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith('/api/') || req.xhr || req.accepts(['html', 'json']) === 'json') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const returnTo = encodeURIComponent(req.originalUrl || '/app');
  return res.redirect(`/login?next=${returnTo}`);
}

/** Expose auth state to every view via res.locals. */
function exposeAuth(req, res, next) {
  res.locals.isAuthed = Boolean(req.session && req.session.authed);
  next();
}

module.exports = { passwordMatches, requireAuth, exposeAuth };
