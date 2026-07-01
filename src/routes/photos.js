'use strict';

const express = require('express');
const multer = require('multer');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { createMedia, deleteMedia } = require('../media');

const router = express.Router();

// ---------------------------------------------------------------------------
// Upload handling
// ---------------------------------------------------------------------------
// Raster images only (no SVG — it is a scriptable document type). Kept in
// memory so we can hand the buffer straight to createMedia. Counts are bounded
// to avoid unbounded in-memory buffering.
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20, parts: 25 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_IMAGE_MIME.has((file.mimetype || '').toLowerCase())),
});

// Accept files under either 'photos' (multi) or 'photo' (single), tolerating
// whichever field name the client sends. .any() collects them all.
const acceptFiles = upload.any();

// Wrap async handlers so thrown errors reach the Express error middleware.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize an incoming slug, defaulting to the built-in photo reel. */
function normalizeSlug(raw) {
  const slug = typeof raw === 'string' ? raw.trim() : '';
  return slug || 'photos';
}

/** Look up a project by slug; returns the row or null. */
async function findProject(slug) {
  const { rows } = await query(
    'SELECT id, slug, title, kind FROM projects WHERE slug = $1 LIMIT 1',
    [slug]
  );
  return rows[0] || null;
}

/** Public read path: only resolve projects that are published/visible. */
async function findPublishedProject(slug) {
  const { rows } = await query(
    'SELECT id, slug, title, kind FROM projects WHERE slug = $1 AND published = true LIMIT 1',
    [slug]
  );
  return rows[0] || null;
}

/** Trim a caption to a sane length, or return null for blanks. */
function normalizeCaption(raw) {
  if (raw === null || raw === undefined) return null;
  const caption = String(raw).trim();
  if (!caption) return null;
  return caption.slice(0, 500);
}

/** Shape a photos row for the client. */
function shapePhoto(row) {
  return {
    id: row.id,
    url: '/media/' + row.media_id,
    caption: row.caption,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/photos — public feed for a project (default 'photos')
// ---------------------------------------------------------------------------
router.get(
  '/api/photos',
  wrap(async (req, res) => {
    const slug = normalizeSlug(req.query.project);
    const project = await findPublishedProject(slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { rows } = await query(
      `SELECT id, media_id, caption, created_at
         FROM photos
        WHERE project_id = $1
        ORDER BY position ASC, created_at DESC, id DESC`,
      [project.id]
    );

    res.json(rows.map(shapePhoto));
  })
);

// ---------------------------------------------------------------------------
// POST /api/photos — upload one or many images (auth)
// ---------------------------------------------------------------------------
router.post(
  '/api/photos',
  requireAuth,
  acceptFiles,
  wrap(async (req, res) => {
    const body = req.body || {};
    const slug = normalizeSlug(body.project);
    const project = await findProject(slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // .any() gathers every file regardless of field name; still guard the
    // field name to the ones we advertise so stray parts are ignored cleanly.
    const files = (req.files || []).filter(
      (f) => f.fieldname === 'photos' || f.fieldname === 'photo'
    );
    if (files.length === 0) {
      return res.status(400).json({ error: 'No image files were uploaded.' });
    }

    const caption = normalizeCaption(body.caption);

    // Find the current max position so new photos append after existing ones.
    const posResult = await query(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM photos WHERE project_id = $1',
      [project.id]
    );
    let position = Number(posResult.rows[0].max_pos);
    if (!Number.isFinite(position)) position = -1;

    const created = [];
    for (const file of files) {
      const mediaId = await createMedia({
        buffer: file.buffer,
        mime: file.mimetype,
        filename: file.originalname,
      });
      position += 1;
      const { rows } = await query(
        `INSERT INTO photos (project_id, media_id, caption, position)
           VALUES ($1, $2, $3, $4)
        RETURNING id, media_id, caption, created_at`,
        [project.id, mediaId, caption, position]
      );
      created.push(shapePhoto(rows[0]));
    }

    res.status(201).json(created);
  })
);

// ---------------------------------------------------------------------------
// PUT /api/photos/:id — update a caption (auth)
// ---------------------------------------------------------------------------
router.put(
  '/api/photos/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid photo id.' });
    }

    const caption = normalizeCaption((req.body || {}).caption);

    const { rows } = await query(
      `UPDATE photos SET caption = $1
        WHERE id = $2
    RETURNING id, media_id, caption, created_at`,
      [caption, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Photo not found' });

    res.json(shapePhoto(rows[0]));
  })
);

// ---------------------------------------------------------------------------
// DELETE /api/photos/:id — remove a photo and its backing media (auth)
// ---------------------------------------------------------------------------
router.delete(
  '/api/photos/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid photo id.' });
    }

    const { rows } = await query(
      'DELETE FROM photos WHERE id = $1 RETURNING media_id',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Photo not found' });

    // Best-effort media cleanup; the photo row is already gone.
    if (rows[0].media_id) {
      try {
        await deleteMedia(rows[0].media_id);
      } catch (err) {
        // A dangling media row is harmless; don't fail the request over it.
        console.error('[photos] failed to delete media', rows[0].media_id, err);
      }
    }

    res.json({ ok: true, id });
  })
);

// ---------------------------------------------------------------------------
// Multer error translation — turn upload failures into clean JSON.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
router.use('/api/photos', (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'One of the images is too large (max 12MB each).'
        : 'Upload failed: ' + err.message;
    return res.status(400).json({ error: message });
  }
  return next(err);
});

module.exports = router;
