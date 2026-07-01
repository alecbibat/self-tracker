'use strict';

const { query } = require('./db');

/** Store a binary blob and return its new media id. */
async function createMedia({ buffer, mime, filename }) {
  const { rows } = await query(
    `INSERT INTO media (mime, bytes, byte_size, filename)
       VALUES ($1, $2, $3, $4) RETURNING id`,
    [mime || 'application/octet-stream', buffer, buffer ? buffer.length : 0, filename || null]
  );
  return rows[0].id;
}

/** Fetch a media row (bytes + mime) by id, or null. */
async function getMedia(id) {
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) return null;
  const { rows } = await query(
    'SELECT id, mime, bytes, byte_size FROM media WHERE id = $1',
    [numeric]
  );
  return rows[0] || null;
}

/** Write a media row to an Express response with sensible caching headers. */
async function streamMedia(res, id, { download } = {}) {
  const row = await getMedia(id);
  if (!row) {
    res.status(404).send('Not found');
    return false;
  }
  res.set('Content-Type', row.mime);
  res.set('Content-Length', String(row.byte_size || row.bytes.length));
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (download) res.set('Content-Disposition', 'attachment');
  res.send(row.bytes);
  return true;
}

async function deleteMedia(id) {
  await query('DELETE FROM media WHERE id = $1', [Number(id)]);
}

module.exports = { createMedia, getMedia, streamMedia, deleteMedia };
