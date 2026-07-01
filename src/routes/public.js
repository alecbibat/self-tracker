'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a project row's cover image source, preferring a stored media
 * upload over an external URL. Returns a string src or null when neither
 * is present (the view then renders a gradient placeholder).
 */
function coverSrc(project) {
  if (project.image_media_id) return '/media/' + project.image_media_id;
  if (project.image_url) return project.image_url;
  return null;
}

/** Columns selected for project listings and detail pages. */
const PROJECT_COLUMNS = `
  id, slug, title, summary, description,
  image_url, image_media_id, external_url, kind,
  position, published, created_at
`;

// ---------------------------------------------------------------------------
// GET / — Landing / hero
// ---------------------------------------------------------------------------
router.get('/', (req, res, next) => {
  try {
    const landing = (res.locals.settings && res.locals.settings.landing) || {};

    // Normalise the background so the view never has to guess.
    let backgroundSrc = null;
    if (landing.background_type === 'image' || landing.background_type === 'video') {
      backgroundSrc = landing.background_media_id
        ? '/media/' + landing.background_media_id
        : (landing.background_url || null);
    }

    // Clamp overlay opacity into a sane 0..1 range.
    let overlay = Number(landing.overlay);
    if (!Number.isFinite(overlay)) overlay = 0.45;
    overlay = Math.max(0, Math.min(1, overlay));

    const links = Array.isArray(landing.links) ? landing.links : [];

    res.render('landing', {
      title: 'Home',
      landing,
      backgroundSrc,
      overlay,
      links,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /projects — grid of published projects
// ---------------------------------------------------------------------------
router.get('/projects', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${PROJECT_COLUMNS}
         FROM projects
        WHERE published = true
        ORDER BY position ASC, id ASC`
    );

    const projects = rows.map((p) => ({ ...p, cover: coverSrc(p) }));

    res.render('projects', {
      title: 'Projects',
      projects,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /projects/:slug — project detail (or photo reel)
// ---------------------------------------------------------------------------
router.get('/projects/:slug', async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '').trim();

    const { rows } = await query(
      `SELECT ${PROJECT_COLUMNS}
         FROM projects
        WHERE slug = $1 AND published = true
        LIMIT 1`,
      [slug]
    );

    const project = rows[0];
    if (!project) {
      return res.status(404).render('error', {
        title: 'Not found',
        status: 404,
        message: 'Project not found.',
      });
    }

    // The built-in photo reel is rendered by the photos feature's template.
    if (project.kind === 'photos') {
      return res.render('photos', { project });
    }

    project.cover = coverSrc(project);
    return res.render('project-detail', {
      title: project.title,
      project,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
