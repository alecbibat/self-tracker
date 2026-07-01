'use strict';

const express = require('express');
const { passwordMatches } = require('../auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.authed) {
    return res.redirect(safeNext(req.query.next));
  }
  res.render('login', { title: 'Log in', error: null, next: safeNext(req.query.next) });
});

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (passwordMatches(password)) {
    req.session.authed = true;
    return req.session.save(() => res.redirect(safeNext(req.body.next)));
  }
  res.status(401).render('login', {
    title: 'Log in',
    error: 'Incorrect password.',
    next: safeNext(req.body.next),
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Only allow same-origin relative redirects to avoid open-redirect abuse.
// Resolve against a dummy origin so browser-style normalization (e.g. a
// backslash "/\evil.com" -> "//evil.com") is caught and rejected.
function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/app';
  if (/[\\\x00-\x1f]/.test(next)) return '/app';
  try {
    const url = new URL(next, 'http://placeholder.invalid');
    if (url.origin !== 'http://placeholder.invalid') return '/app';
  } catch (_) {
    return '/app';
  }
  return next;
}

module.exports = router;
