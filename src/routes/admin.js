'use strict';

// ===========================================================================
// Site Admin / Content Management
// ---------------------------------------------------------------------------
// Owns the private /app/admin page plus the settings, media-upload, and
// project-management APIs behind it. Every route requires authentication;
// there are no public read endpoints here.
// ===========================================================================

const express = require('express');
const multer = require('multer');
const { query } = require('../db');
const { requireAuth } = require('../auth');
const { getAllSettings, setSetting } = require('../settings');
const { createMedia } = require('../media');

const router = express.Router();

// ---------------------------------------------------------------------------
// Upload handling — images and videos, kept in memory for createMedia.
// ---------------------------------------------------------------------------
// Allowlist of safe raster image + common video types. SVG is intentionally
// excluded — it is a scriptable document type.
const ALLOWED_MEDIA_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, parts: 5 }, // ~25MB
  fileFilter: (req, file, cb) =>
    cb(null, ALLOWED_MEDIA_MIME.has((file.mimetype || '').toLowerCase())),
});

// Wrap async handlers so thrown errors reach the Express error middleware.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

// Only these setting keys may be written through the admin settings endpoint.
const ALLOWED_SETTING_KEYS = ['landing', 'site'];

// Icons the landing links may reference (kept in sync with landing.ejs ICONS).
const LINK_ICONS = [
  'file', 'star', 'grid', 'link', 'mail',
  'github', 'globe', 'book', 'code', 'heart',
];

// Columns returned for project rows (admin sees unpublished too).
const PROJECT_COLUMNS = `
  id, slug, title, summary, description,
  image_url, image_media_id, external_url, kind,
  position, published, created_at
`;

/**
 * Slugify a string: lowercase, non-alphanumerics -> '-', collapse repeats,
 * trim leading/trailing '-'. Returns '' when nothing usable remains.
 */
function slugify(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Trim a string field to a max length, returning null for blanks. */
function cleanText(raw, max) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

/** Coerce a value to a finite integer, or return the fallback. */
function toInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Coerce a nullable positive integer id (for media ids), or null. */
function toMediaId(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Coerce anything truthy-ish into a boolean. */
function toBool(raw) {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'on' || s === 'yes';
  }
  return Boolean(raw);
}

/** Shape a DB project row into JSON with numbers/booleans normalised. */
function shapeProject(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    description: row.description,
    image_url: row.image_url,
    image_media_id: row.image_media_id == null ? null : Number(row.image_media_id),
    external_url: row.external_url,
    kind: row.kind,
    position: Number(row.position),
    published: Boolean(row.published),
    created_at: row.created_at,
    // Convenience cover src the client can use directly.
    cover: row.image_media_id
      ? '/media/' + row.image_media_id
      : (row.image_url || null),
  };
}

/**
 * Produce a slug unique across the projects table. Starts from `base`
 * (already slugified) and appends -2, -3, ... until free. `excludeId`
 * lets an update keep its own slug.
 */
async function uniqueSlug(base, excludeId) {
  let candidate = base || 'project';
  let suffix = 1;
  // Loop until we find a slug not taken by another row.
  // Bounded by a sane cap to avoid pathological loops.
  for (let i = 0; i < 1000; i += 1) {
    const { rows } = await query(
      'SELECT id FROM projects WHERE slug = $1 LIMIT 1',
      [candidate]
    );
    const clash = rows[0] && (excludeId == null || rows[0].id !== excludeId);
    if (!clash) return candidate;
    suffix += 1;
    candidate = base + '-' + suffix;
  }
  // Extremely unlikely fallback: make it unique with a timestamp.
  return base + '-' + Date.now();
}

/** Sanitise the landing settings object into a known shape. */
function sanitizeLanding(value) {
  const v = value && typeof value === 'object' ? value : {};

  let bgType = String(v.background_type || 'gradient');
  if (!['image', 'video', 'gradient'].includes(bgType)) bgType = 'gradient';

  let overlay = Number(v.overlay);
  if (!Number.isFinite(overlay)) overlay = 0.45;
  overlay = Math.max(0, Math.min(1, overlay));

  const rawLinks = Array.isArray(v.links) ? v.links : [];
  const links = [];
  for (const link of rawLinks) {
    if (!link || typeof link !== 'object') continue;
    const label = cleanText(link.label, 120);
    const href = cleanText(link.href, 2000);
    // A link needs at least a label or an href to be meaningful; require both
    // so the public page never renders half-empty buttons.
    if (!label || !href) continue;
    const icon = LINK_ICONS.includes(link.icon) ? link.icon : '';
    links.push({ label, href, icon });
  }

  return {
    title: cleanText(v.title, 200) || '',
    subtitle: cleanText(v.subtitle, 400) || '',
    background_type: bgType,
    background_media_id: toMediaId(v.background_media_id),
    background_url: cleanText(v.background_url, 2000) || '',
    overlay,
    links,
  };
}

/** Sanitise the site settings object into a known shape. */
function sanitizeSite(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    brand: cleanText(v.brand, 120) || '',
    footer_text: cleanText(v.footer_text, 300) || '',
  };
}

// ===========================================================================
// GET /app/admin — the admin page
// ===========================================================================
router.get(
  '/app/admin',
  requireAuth,
  wrap(async (req, res) => {
    const settings = await getAllSettings();
    res.render('app/admin', {
      title: 'Site Admin',
      active: 'admin',
      landing: settings.landing || {},
      site: settings.site || {},
      linkIcons: LINK_ICONS,
    });
  })
);

// ===========================================================================
// PUT /api/admin/settings — persist an allow-listed settings key
// ===========================================================================
router.put(
  '/api/admin/settings',
  requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};
    const key = typeof body.key === 'string' ? body.key.trim() : '';

    if (!ALLOWED_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ error: 'Unknown or disallowed settings key.' });
    }
    if (body.value === null || body.value === undefined || typeof body.value !== 'object' || Array.isArray(body.value)) {
      return res.status(400).json({ error: 'Setting value must be an object.' });
    }

    const value = key === 'landing'
      ? sanitizeLanding(body.value)
      : sanitizeSite(body.value);

    const saved = await setSetting(key, value);
    res.json({ key, value: saved });
  })
);

// ===========================================================================
// POST /api/media — upload an image or video, return {id, url}
// ===========================================================================
router.post(
  '/api/media',
  requireAuth,
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded, or file type not allowed (images and videos only).' });
    }
    const id = await createMedia({
      buffer: req.file.buffer,
      mime: req.file.mimetype,
      filename: req.file.originalname,
    });
    res.status(201).json({ id, url: '/media/' + id });
  })
);

// ===========================================================================
// GET /api/admin/projects — all projects (including unpublished)
// ===========================================================================
router.get(
  '/api/admin/projects',
  requireAuth,
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT ${PROJECT_COLUMNS}
         FROM projects
        ORDER BY position ASC, id ASC`
    );
    res.json(rows.map(shapeProject));
  })
);

// ===========================================================================
// POST /api/admin/projects — create a standard project
// ===========================================================================
router.post(
  '/api/admin/projects',
  requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};

    const title = cleanText(body.title, 200);
    if (!title) {
      return res.status(400).json({ error: 'A title is required.' });
    }

    const base = slugify(body.slug) || slugify(title);
    const slug = await uniqueSlug(base, null);

    const summary = cleanText(body.summary, 500);
    const description = cleanText(body.description, 20000);
    const imageUrl = cleanText(body.image_url, 2000);
    const imageMediaId = toMediaId(body.image_media_id);
    const externalUrl = cleanText(body.external_url, 2000);
    const position = toInt(body.position, 0);
    const published = body.published === undefined ? true : toBool(body.published);

    const { rows } = await query(
      `INSERT INTO projects
         (slug, title, summary, description, image_url, image_media_id,
          external_url, kind, position, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'standard', $8, $9)
       RETURNING ${PROJECT_COLUMNS}`,
      [slug, title, summary, description, imageUrl, imageMediaId,
        externalUrl, position, published]
    );

    res.status(201).json(shapeProject(rows[0]));
  })
);

// ===========================================================================
// PUT /api/admin/projects/:id — update provided fields
// ===========================================================================
router.put(
  '/api/admin/projects/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid project id.' });
    }

    const { rows: existingRows } = await query(
      'SELECT id, slug, kind FROM projects WHERE id = $1 LIMIT 1',
      [id]
    );
    const existing = existingRows[0];
    if (!existing) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    const isPhotos = existing.slug === 'photos' || existing.kind === 'photos';
    const body = req.body || {};

    // Build a dynamic update from only the fields that were provided.
    const sets = [];
    const params = [];
    const push = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (body.title !== undefined) {
      const title = cleanText(body.title, 200);
      if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
      push('title', title);
    }

    // Slug and kind are locked for the built-in photos project.
    if (!isPhotos && body.slug !== undefined) {
      const base = slugify(body.slug);
      if (!base) return res.status(400).json({ error: 'Slug cannot be empty.' });
      const slug = await uniqueSlug(base, id);
      push('slug', slug);
    }

    if (body.summary !== undefined) push('summary', cleanText(body.summary, 500));
    if (body.description !== undefined) push('description', cleanText(body.description, 20000));
    if (body.image_url !== undefined) push('image_url', cleanText(body.image_url, 2000));
    if (body.image_media_id !== undefined) push('image_media_id', toMediaId(body.image_media_id));
    if (body.external_url !== undefined) push('external_url', cleanText(body.external_url, 2000));
    if (body.position !== undefined) push('position', toInt(body.position, 0));
    if (body.published !== undefined) push('published', toBool(body.published));

    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update.' });
    }

    params.push(id);
    const { rows } = await query(
      `UPDATE projects SET ${sets.join(', ')}
        WHERE id = $${params.length}
        RETURNING ${PROJECT_COLUMNS}`,
      params
    );

    res.json(shapeProject(rows[0]));
  })
);

// ===========================================================================
// DELETE /api/admin/projects/:id — delete (blocks the built-in photos reel)
// ===========================================================================
router.delete(
  '/api/admin/projects/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid project id.' });
    }

    const { rows } = await query(
      'SELECT id, slug, kind FROM projects WHERE id = $1 LIMIT 1',
      [id]
    );
    const project = rows[0];
    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    if (project.slug === 'photos' || project.kind === 'photos') {
      return res.status(400).json({
        error: 'The built-in Photos project cannot be deleted. Unpublish it instead if you want to hide it.',
      });
    }

    await query('DELETE FROM projects WHERE id = $1', [id]);
    res.json({ ok: true, id });
  })
);

// ---------------------------------------------------------------------------
// Multer error translation — turn upload failures into clean JSON.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
router.use('/api/media', (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large (max 25MB).'
        : 'Upload failed: ' + err.message;
    return res.status(400).json({ error: message });
  }
  return next(err);
});

module.exports = router;
