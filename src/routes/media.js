'use strict';

const express = require('express');
const { streamMedia } = require('../media');

const router = express.Router();

// Public: serve stored binary media (project covers, landing background, photos).
router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    await streamMedia(res, req.params.id);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
