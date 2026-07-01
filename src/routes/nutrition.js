'use strict';

/**
 * Calorie / macro / weight tracker.
 *
 * Owns: the /app/nutrition page plus its JSON API for meals, foods, weights,
 * goals, a per-day summary (also consumed by the dashboard) and a date-range
 * aggregate used to draw the trend charts.
 */

const express = require('express');
const { requireAuth } = require('../auth');
const { query } = require('../db');
const { getSetting, setSetting } = require('../settings');

const router = express.Router();

// --- Helpers ---------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce to a finite number or return `fallback`. */
function toNum(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a finite, non-negative number or return `fallback`. */
function toNonNeg(value, fallback = 0) {
  const n = toNum(value, fallback);
  return n < 0 ? fallback : n;
}

/** Validate a YYYY-MM-DD string; returns the string or null. */
function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const d = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Guard against overflow like 2026-02-31 being coerced to March.
  if (d.toISOString().slice(0, 10) !== value) return null;
  return value;
}

/** Local YYYY-MM-DD for "today" (server local time). */
function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Normalise the persisted nutrition goals into plain numbers. */
function normGoals(raw) {
  const g = raw || {};
  return {
    calories: toNonNeg(g.calories, 0),
    protein: toNonNeg(g.protein, 0),
    carbs: toNonNeg(g.carbs, 0),
    fat: toNonNeg(g.fat, 0),
  };
}

/** Normalise the persisted weight goal. */
function normWeightGoal(raw) {
  const w = raw || {};
  const target = w.target === null || w.target === undefined || w.target === '' ? null : toNum(w.target, null);
  const unit = w.unit === 'kg' ? 'kg' : 'lb';
  return { target: Number.isFinite(target) ? target : null, unit };
}

/** Shape a meal row from pg (NUMERIC comes back as string). */
function shapeMeal(row) {
  return {
    id: row.id,
    entry_date: row.entry_date,
    name: row.name,
    calories: toNum(row.calories),
    protein: toNum(row.protein),
    carbs: toNum(row.carbs),
    fat: toNum(row.fat),
    quantity: toNum(row.quantity, 1),
    food_id: row.food_id === null || row.food_id === undefined ? null : Number(row.food_id),
  };
}

/** Shape a food row from pg. */
function shapeFood(row) {
  return {
    id: row.id,
    name: row.name,
    serving_label: row.serving_label || '',
    calories: toNum(row.calories),
    protein: toNum(row.protein),
    carbs: toNum(row.carbs),
    fat: toNum(row.fat),
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

router.get('/app/nutrition', requireAuth, async (req, res, next) => {
  try {
    const goals = normGoals(await getSetting('nutrition_goals'));
    const weightGoal = normWeightGoal(await getSetting('weight_goal'));
    res.render('app/nutrition', {
      title: 'Nutrition',
      active: 'nutrition',
      today: todayIso(),
      goals,
      weightGoal,
      head: '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Per-day summary (also consumed by the dashboard)
// ---------------------------------------------------------------------------

router.get('/api/nutrition/day', requireAuth, async (req, res, next) => {
  try {
    const date = validDate(req.query.date) || todayIso();

    const [mealsRes, weightRes] = await Promise.all([
      query(
        `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, name,
                calories, protein, carbs, fat, quantity, food_id
           FROM meals
          WHERE entry_date = $1
          ORDER BY created_at ASC, id ASC`,
        [date]
      ),
      query('SELECT weight FROM weights WHERE entry_date = $1', [date]),
    ]);

    const meals = mealsRes.rows.map(shapeMeal);
    const totals = meals.reduce(
      (acc, m) => {
        acc.calories += m.calories;
        acc.protein += m.protein;
        acc.carbs += m.carbs;
        acc.fat += m.fat;
        return acc;
      },
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );
    // Round to avoid float dust leaking to the client.
    for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;

    const goals = normGoals(await getSetting('nutrition_goals'));
    const weight = weightRes.rows[0] ? toNum(weightRes.rows[0].weight) : null;

    res.json({ date, totals, goals, meals, weight });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Date-range aggregate for the trend charts
// ---------------------------------------------------------------------------

router.get('/api/nutrition/range', requireAuth, async (req, res, next) => {
  try {
    const from = validDate(req.query.from);
    const to = validDate(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'from must be on or before to' });
    }

    const [nutritionRes, weightRes] = await Promise.all([
      query(
        `SELECT to_char(entry_date, 'YYYY-MM-DD') AS date,
                SUM(calories) AS calories,
                SUM(protein)  AS protein,
                SUM(carbs)    AS carbs,
                SUM(fat)      AS fat
           FROM meals
          WHERE entry_date BETWEEN $1 AND $2
          GROUP BY entry_date`,
        [from, to]
      ),
      query(
        `SELECT to_char(entry_date, 'YYYY-MM-DD') AS date, weight
           FROM weights
          WHERE entry_date BETWEEN $1 AND $2`,
        [from, to]
      ),
    ]);

    const byDate = new Map();
    for (const r of nutritionRes.rows) {
      byDate.set(r.date, {
        calories: toNum(r.calories),
        protein: toNum(r.protein),
        carbs: toNum(r.carbs),
        fat: toNum(r.fat),
      });
    }
    const weightByDate = new Map();
    for (const r of weightRes.rows) weightByDate.set(r.date, toNum(r.weight));

    // Build a dense, ordered day list from `from` to `to` inclusive.
    const days = [];
    let cursor = from;
    // Hard cap the loop so a bad range can never spin forever.
    for (let guard = 0; guard < 1000 && cursor <= to; guard += 1) {
      const nut = byDate.get(cursor);
      days.push({
        date: cursor,
        calories: nut ? nut.calories : 0,
        protein: nut ? nut.protein : 0,
        carbs: nut ? nut.carbs : 0,
        fat: nut ? nut.fat : 0,
        weight: weightByDate.has(cursor) ? weightByDate.get(cursor) : null,
      });
      cursor = addDaysIso(cursor, 1);
    }

    res.json({
      goals: normGoals(await getSetting('nutrition_goals')),
      weight_goal: normWeightGoal(await getSetting('weight_goal')),
      days,
    });
  } catch (err) {
    next(err);
  }
});

/** Add `n` days to a YYYY-MM-DD string using UTC math (no DST drift). */
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

router.post('/api/meals', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const entryDate = validDate(body.entry_date);
    if (!entryDate) {
      return res.status(400).json({ error: 'entry_date must be YYYY-MM-DD' });
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > 200) {
      return res.status(400).json({ error: 'name is too long' });
    }

    const calories = toNonNeg(body.calories, 0);
    const protein = toNonNeg(body.protein, 0);
    const carbs = toNonNeg(body.carbs, 0);
    const fat = toNonNeg(body.fat, 0);
    const quantity = toNonNeg(body.quantity, 1) || 1;

    let foodId = null;
    if (body.food_id !== null && body.food_id !== undefined && body.food_id !== '') {
      foodId = Number(body.food_id);
      if (!Number.isInteger(foodId) || foodId <= 0) {
        return res.status(400).json({ error: 'food_id must be a positive integer' });
      }
      // Ensure the referenced food exists so the FK never rejects the insert.
      const exists = await query('SELECT 1 FROM foods WHERE id = $1', [foodId]);
      if (!exists.rows[0]) foodId = null;
    }

    // Optionally persist a reusable food. When adding from a saved food we store
    // the ACTUAL consumed macros (already multiplied by quantity by the caller),
    // so the food we save is the per-serving figure = consumed / quantity.
    if (body.save_food && !foodId) {
      const per = quantity > 0 ? quantity : 1;
      const foodRow = await query(
        `INSERT INTO foods (name, serving_label, calories, protein, carbs, fat)
           VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          name,
          typeof body.serving_label === 'string' ? body.serving_label.trim() : '',
          Math.round((calories / per) * 100) / 100,
          Math.round((protein / per) * 100) / 100,
          Math.round((carbs / per) * 100) / 100,
          Math.round((fat / per) * 100) / 100,
        ]
      );
      foodId = foodRow.rows[0].id;
    }

    const inserted = await query(
      `INSERT INTO meals (entry_date, name, calories, protein, carbs, fat, quantity, food_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date,
                 name, calories, protein, carbs, fat, quantity, food_id`,
      [entryDate, name, calories, protein, carbs, fat, quantity, foodId]
    );

    res.status(201).json(shapeMeal(inserted.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.delete('/api/meals/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await query('DELETE FROM meals WHERE id = $1 RETURNING id', [id]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Meal not found' });
    }
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Saved foods library
// ---------------------------------------------------------------------------

router.get('/api/foods', requireAuth, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    let rows;
    if (q) {
      const like = '%' + q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
      ({ rows } = await query(
        `SELECT id, name, serving_label, calories, protein, carbs, fat
           FROM foods
          WHERE name ILIKE $1 ESCAPE '\\'
          ORDER BY name ASC
          LIMIT 25`,
        [like]
      ));
    } else {
      ({ rows } = await query(
        `SELECT id, name, serving_label, calories, protein, carbs, fat
           FROM foods
          ORDER BY name ASC
          LIMIT 25`
      ));
    }
    res.json({ foods: rows.map(shapeFood) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/foods', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > 200) {
      return res.status(400).json({ error: 'name is too long' });
    }
    const inserted = await query(
      `INSERT INTO foods (name, serving_label, calories, protein, carbs, fat)
         VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, serving_label, calories, protein, carbs, fat`,
      [
        name,
        typeof body.serving_label === 'string' ? body.serving_label.trim() : '',
        toNonNeg(body.calories, 0),
        toNonNeg(body.protein, 0),
        toNonNeg(body.carbs, 0),
        toNonNeg(body.fat, 0),
      ]
    );
    res.status(201).json(shapeFood(inserted.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.put('/api/foods/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (name.length > 200) {
      return res.status(400).json({ error: 'name is too long' });
    }
    const updated = await query(
      `UPDATE foods
          SET name = $2, serving_label = $3, calories = $4, protein = $5, carbs = $6, fat = $7
        WHERE id = $1
      RETURNING id, name, serving_label, calories, protein, carbs, fat`,
      [
        id,
        name,
        typeof body.serving_label === 'string' ? body.serving_label.trim() : '',
        toNonNeg(body.calories, 0),
        toNonNeg(body.protein, 0),
        toNonNeg(body.carbs, 0),
        toNonNeg(body.fat, 0),
      ]
    );
    if (!updated.rows[0]) {
      return res.status(404).json({ error: 'Food not found' });
    }
    res.json(shapeFood(updated.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.delete('/api/foods/:id(\\d+)', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await query('DELETE FROM foods WHERE id = $1 RETURNING id', [id]);
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Food not found' });
    }
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Goals (nutrition + weight)
// ---------------------------------------------------------------------------

router.put('/api/goals', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const out = {};

    if (body.nutrition_goals && typeof body.nutrition_goals === 'object') {
      const current = normGoals(await getSetting('nutrition_goals'));
      const incoming = body.nutrition_goals;
      const merged = {
        calories: incoming.calories === undefined ? current.calories : toNonNeg(incoming.calories, current.calories),
        protein: incoming.protein === undefined ? current.protein : toNonNeg(incoming.protein, current.protein),
        carbs: incoming.carbs === undefined ? current.carbs : toNonNeg(incoming.carbs, current.carbs),
        fat: incoming.fat === undefined ? current.fat : toNonNeg(incoming.fat, current.fat),
      };
      out.nutrition_goals = normGoals(await setSetting('nutrition_goals', merged));
    } else {
      out.nutrition_goals = normGoals(await getSetting('nutrition_goals'));
    }

    if (body.weight_goal && typeof body.weight_goal === 'object') {
      const current = normWeightGoal(await getSetting('weight_goal'));
      const incoming = body.weight_goal;
      let target = current.target;
      if ('target' in incoming) {
        target = incoming.target === null || incoming.target === '' ? null : toNum(incoming.target, current.target);
      }
      const unit = incoming.unit === 'kg' || incoming.unit === 'lb' ? incoming.unit : current.unit;
      out.weight_goal = normWeightGoal(await setSetting('weight_goal', { target, unit }));
    } else {
      out.weight_goal = normWeightGoal(await getSetting('weight_goal'));
    }

    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Weight (one reading per day, upsert)
// ---------------------------------------------------------------------------

router.post('/api/weights', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const entryDate = validDate(body.entry_date);
    if (!entryDate) {
      return res.status(400).json({ error: 'entry_date must be YYYY-MM-DD' });
    }
    if (body.weight === null || body.weight === undefined || body.weight === '') {
      return res.status(400).json({ error: 'weight is required' });
    }
    const weight = Number(body.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      return res.status(400).json({ error: 'weight must be a positive number' });
    }

    const upserted = await query(
      `INSERT INTO weights (entry_date, weight)
         VALUES ($1, $2)
       ON CONFLICT (entry_date) DO UPDATE SET weight = EXCLUDED.weight
       RETURNING id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, weight`,
      [entryDate, weight]
    );
    const row = upserted.rows[0];
    res.json({ id: row.id, entry_date: row.entry_date, weight: toNum(row.weight) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
