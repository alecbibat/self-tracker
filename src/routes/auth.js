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
function safeNext(next) {
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/app';
}

module.exports = router;
