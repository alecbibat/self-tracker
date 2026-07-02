'use strict';

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TYPES = new Set(['yesno', 'quantity']);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#c4a265';

/** True for a strict YYYY-MM-DD string that is also a real calendar date. */
function isValidDate(str) {
  if (typeof str !== 'string' || !DATE_RE.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Coerce to a finite number, or return null. */
function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize a color to a #rrggbb hex, falling back to the default. */
function normalizeColor(v) {
  if (typeof v === 'string' && HEX_COLOR_RE.test(v.trim())) return v.trim().toLowerCase();
  return DEFAULT_COLOR;
}

/** Shape a habits row for JSON, numeric columns as numbers. */
function shapeHabit(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    unit: row.unit,
    target: row.target === null || row.target === undefined ? null : Number(row.target),
    color: row.color,
    position: row.position,
  };
}

// Wrap async handlers so thrown errors reach the Express error middleware.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

router.get(
  '/app/habits',
  requireAuth,
  wrap(async (req, res) => {
    res.render('app/habits', { title: 'Habits', active: 'habits' });
  })
);

// ---------------------------------------------------------------------------
// API — habits CRUD
// ---------------------------------------------------------------------------

// List non-archived habits.
router.get(
  '/api/habits',
  requireAuth,
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT id, name, type, unit, target, color, position
         FROM habits
        WHERE archived = false
        ORDER BY position ASC, id ASC`
    );
    res.json(rows.map(shapeHabit));
  })
);

// Create a habit.
router.post(
  '/api/habits',
  requireAuth,
  wrap(async (req, res) => {
    const body = req.body || {};

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (name.length > 120) {
      return res.status(400).json({ error: 'Name is too long.' });
    }

    const type = typeof body.type === 'string' ? body.type : 'yesno';
    if (!VALID_TYPES.has(type)) {
      return res.status(400).json({ error: "Type must be 'yesno' or 'quantity'." });
    }

    // Unit only meaningful for quantity habits.
    let unit = null;
    if (type === 'quantity') {
      unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim().slice(0, 40) : null;
    }

    const target = toNumberOrNull(body.target);
    if (target !== null && target < 0) {
      return res.status(400).json({ error: 'Target must be zero or greater.' });
    }

    const color = normalizeColor(body.color);

    // Append to the end of the list.
    const { rows: posRows } = await query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM habits WHERE archived = false'
    );
    const position = posRows[0].next;

    const { rows } = await query(
      `INSERT INTO habits (name, type, unit, target, color, position)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, type, unit, target, color, position`,
      [name, type, unit, target, color, position]
    );
    res.status(201).json(shapeHabit(rows[0]));
  })
);

// Update a habit.
router.put(
  '/api/habits/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid habit id.' });
    }

    const { rows: existingRows } = await query(
      'SELECT id, type FROM habits WHERE id = $1 AND archived = false',
      [id]
    );
    if (!existingRows[0]) {
      return res.status(404).json({ error: 'Habit not found.' });
    }
    const type = existingRows[0].type;

    const body = req.body || {};

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }
    if (name.length > 120) {
      return res.status(400).json({ error: 'Name is too long.' });
    }

    // Unit only applies to quantity habits.
    let unit = null;
    if (type === 'quantity') {
      unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim().slice(0, 40) : null;
    }

    const target = toNumberOrNull(body.target);
    if (target !== null && target < 0) {
      return res.status(400).json({ error: 'Target must be zero or greater.' });
    }

    const color = normalizeColor(body.color);

    const position = toNumberOrNull(body.position);
    const hasPosition = position !== null && Number.isInteger(position);

    const { rows } = await query(
      `UPDATE habits
          SET name = $1,
              unit = $2,
              target = $3,
              color = $4,
              position = COALESCE($5, position)
        WHERE id = $6
        RETURNING id, name, type, unit, target, color, position`,
      [name, unit, target, color, hasPosition ? position : null, id]
    );
    res.json(shapeHabit(rows[0]));
  })
);

// Delete a habit (entries cascade via FK).
router.delete(
  '/api/habits/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid habit id.' });
    }
    const { rowCount } = await query('DELETE FROM habits WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Habit not found.' });
    }
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// API — habit entries
// ---------------------------------------------------------------------------

// Fetch entries for a habit in a date range (inclusive).
router.get(
  '/api/habits/:id/entries',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid habit id.' });
    }

    const { from, to } = req.query;
    if (from !== undefined && !isValidDate(from)) {
      return res.status(400).json({ error: "'from' must be YYYY-MM-DD." });
    }
    if (to !== undefined && !isValidDate(to)) {
      return res.status(400).json({ error: "'to' must be YYYY-MM-DD." });
    }

    const conditions = ['habit_id = $1'];
    const params = [id];
    if (from !== undefined) {
      params.push(from);
      conditions.push(`entry_date >= $${params.length}`);
    }
    if (to !== undefined) {
      params.push(to);
      conditions.push(`entry_date <= $${params.length}`);
    }

    const { rows } = await query(
      `SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date, done, value
         FROM habit_entries
        WHERE ${conditions.join(' AND ')}
        ORDER BY entry_date ASC`,
      params
    );

    res.json(
      rows.map((r) => ({
        entry_date: r.entry_date,
        done: r.done,
        value: r.value === null || r.value === undefined ? 0 : Number(r.value),
      }))
    );
  })
);

// Upsert a single day's entry for a habit.
router.put(
  '/api/habits/:id/entries/:date',
  requireAuth,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid habit id.' });
    }

    const date = req.params.date;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Date must be a valid YYYY-MM-DD.' });
    }

    const { rows: habitRows } = await query(
      'SELECT id, type FROM habits WHERE id = $1 AND archived = false',
      [id]
    );
    if (!habitRows[0]) {
      return res.status(404).json({ error: 'Habit not found.' });
    }
    const type = habitRows[0].type;

    const body = req.body || {};

    let done = false;
    let value = 0;

    if (type === 'yesno') {
      done = Boolean(body.done);
      // A yes/no habit's value mirrors its done flag for consistency.
      value = done ? 1 : 0;
    } else {
      const parsed = toNumberOrNull(body.value);
      if (parsed === null) {
        return res.status(400).json({ error: 'Value must be a number.' });
      }
      if (parsed < 0) {
        return res.status(400).json({ error: 'Value must be zero or greater.' });
      }
      value = parsed;
      done = value > 0;
    }

    const { rows } = await query(
      `INSERT INTO habit_entries (habit_id, entry_date, done, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (habit_id, entry_date)
         DO UPDATE SET done = EXCLUDED.done, value = EXCLUDED.value
       RETURNING to_char(entry_date, 'YYYY-MM-DD') AS entry_date, done, value`,
      [id, date, done, value]
    );

    const row = rows[0];
    res.json({
      entry_date: row.entry_date,
      done: row.done,
      value: row.value === null || row.value === undefined ? 0 : Number(row.value),
    });
  })
);

// ---------------------------------------------------------------------------
// API — dashboard summary
// ---------------------------------------------------------------------------

router.get(
  '/api/habits/summary',
  requireAuth,
  wrap(async (req, res) => {
    const date = req.query.date;
    if (date !== undefined && !isValidDate(date)) {
      return res.status(400).json({ error: 'Date must be a valid YYYY-MM-DD.' });
    }
    // Default to server-local today if no date supplied.
    const target = date !== undefined ? date : new Date().toLocaleDateString('en-CA');

    const { rows } = await query(
      `SELECT h.id, h.name, h.type, h.target, h.unit,
              e.done, e.value
         FROM habits h
         LEFT JOIN habit_entries e
           ON e.habit_id = h.id AND e.entry_date = $1
        WHERE h.archived = false
        ORDER BY h.position ASC, h.id ASC`,
      [target]
    );

    let completed = 0;
    const habits = rows.map((r) => {
      const value = r.value === null || r.value === undefined ? 0 : Number(r.value);
      const done = Boolean(r.done);
      const habitTarget = r.target === null || r.target === undefined ? null : Number(r.target);

      let isComplete;
      if (r.type === 'yesno') {
        isComplete = done;
      } else if (habitTarget !== null && habitTarget > 0) {
        isComplete = value >= habitTarget;
      } else {
        // No meaningful target (null or <= 0): any positive amount counts.
        isComplete = value > 0;
      }
      if (isComplete) completed += 1;

      return {
        id: r.id,
        name: r.name,
        type: r.type,
        done,
        value,
        target: habitTarget,
        unit: r.unit,
      };
    });

    res.json({
      date: target,
      total: habits.length,
      completed,
      habits,
    });
  })
);

module.exports = router;
