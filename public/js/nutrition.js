/* =========================================================================
   Nutrition & weight tracker — client behaviour.
   All server data arrives via App.readData; all mutations go through App.api.
   ========================================================================= */
(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var el = App.el;
  var fmt = App.fmt;

  var boot = App.readData('nut-bootstrap') || {};
  var GOALS = normGoals(boot.goals);
  var WEIGHT_GOAL = normWeightGoal(boot.weightGoal);

  // Selected day (local YYYY-MM-DD). Defaults to today from the server.
  var selectedDate = boot.today || fmt.isoDate();
  // Currently active trend range in days.
  var rangeDays = 7;

  var charts = { calories: null, macros: null, weight: null };
  var searchTimer = null;

  // --- Small numeric helpers ---------------------------------------------
  function num(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }
  function round(v, d) {
    var f = Math.pow(10, d || 0);
    return Math.round(num(v) * f) / f;
  }
  function normGoals(g) {
    g = g || {};
    return {
      calories: num(g.calories, 0),
      protein: num(g.protein, 0),
      carbs: num(g.carbs, 0),
      fat: num(g.fat, 0),
    };
  }
  function normWeightGoal(w) {
    w = w || {};
    var target = w.target === null || w.target === undefined || w.target === '' ? null : num(w.target, null);
    return { target: Number.isFinite(target) ? target : null, unit: w.unit === 'kg' ? 'kg' : 'lb' };
  }

  // CSS custom-property colours resolved once for the charts.
  var css = getComputedStyle(document.documentElement);
  function cssVar(name, fallback) {
    var v = css.getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  var COL = {
    // Categorical series, validated against the dark card surface.
    series1: cssVar('--chart-1', '#b98c35'), // gold — calories, protein
    series2: cssVar('--chart-2', '#4f88cf'), // steel — carbs
    series3: cssVar('--chart-3', '#c25f87'), // rose — fat
    ink: cssVar('--text', '#e9e7e2'),        // single-series line (weight)
    goal: cssVar('--text-faint', '#64615a'), // dashed reference lines
    text: cssVar('--text-muted', '#97948c'),
    grid: cssVar('--chart-grid', '#1c1e23'),
  };

  // =====================================================================
  // Day view
  // =====================================================================

  function renderDayLabel() {
    var lbl = document.getElementById('day-label');
    if (!lbl) return;
    var pretty = fmt.prettyDate(selectedDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (selectedDate === fmt.isoDate()) pretty = 'Today · ' + pretty;
    lbl.textContent = pretty;
  }

  function metricBar(name, total, goal, cls) {
    var pct = goal > 0 ? (total / goal) * 100 : (total > 0 ? 100 : 0);
    var over = goal > 0 && total > goal;
    var barCls = 'progress__bar' + (cls ? ' ' + cls : '') + (over ? ' is-over' : '');
    var valNode = el('span', { class: 'nut-metric__val' }, [
      el('span', over ? { class: 'over' } : {}, [fmt.num(total)]),
      ' / ' + (goal > 0 ? fmt.num(goal) : '—') + ' g',
    ]);
    return el('div', { class: 'nut-metric' }, [
      el('div', { class: 'nut-metric__row' }, [
        el('span', { class: 'nut-metric__name' }, [name]),
        valNode,
      ]),
      el('div', { class: 'progress' }, [
        el('div', { class: barCls, style: { width: Math.min(100, pct) + '%' } }),
      ]),
    ]);
  }

  function renderSummary(data) {
    var box = document.getElementById('day-summary');
    if (!box) return;
    box.innerHTML = '';
    var t = data.totals || {};
    var g = data.goals || GOALS;
    GOALS = normGoals(g);

    var calGoal = num(g.calories);
    var calTotal = num(t.calories);
    var calOver = calGoal > 0 && calTotal > calGoal;
    var calPct = calGoal > 0 ? (calTotal / calGoal) * 100 : (calTotal > 0 ? 100 : 0);
    var remain = calGoal - calTotal;

    var calBlock = el('div', {}, [
      el('div', { class: 'nut-cal' }, [
        el('div', {}, [
          el('span', { class: 'nut-cal__big' }, [fmt.num(calTotal)]),
          ' ',
          el('span', { class: 'nut-cal__goal' }, ['/ ' + (calGoal > 0 ? fmt.num(calGoal) : '—') + ' kcal']),
        ]),
        el('div', { class: 'nut-cal__remain muted' }, [
          calGoal > 0
            ? (remain >= 0 ? fmt.num(remain) + ' left' : fmt.num(-remain) + ' over')
            : 'No calorie goal set',
        ]),
      ]),
      el('div', { class: 'progress mt-1' }, [
        el('div', {
          class: 'progress__bar' + (calOver ? ' is-over' : ''),
          style: { width: Math.min(100, calPct) + '%' },
        }),
      ]),
    ]);

    box.appendChild(calBlock);
    box.appendChild(
      el('div', {}, [
        metricBar('Protein', num(t.protein), num(g.protein), 'bar--protein'),
        metricBar('Carbs', num(t.carbs), num(g.carbs), 'bar--carbs'),
        metricBar('Fat', num(t.fat), num(g.fat), 'bar--fat'),
      ])
    );
  }

  function macroLine(m) {
    return 'P ' + fmt.num(m.protein) + ' · C ' + fmt.num(m.carbs) + ' · F ' + fmt.num(m.fat);
  }

  function renderMeals(meals) {
    var box = document.getElementById('meals-list');
    if (!box) return;
    box.innerHTML = '';
    if (!meals || !meals.length) {
      box.appendChild(el('div', { class: 'empty' }, ['No meals logged for this day yet.']));
      return;
    }

    var totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    meals.forEach(function (m) {
      totals.calories += num(m.calories);
      totals.protein += num(m.protein);
      totals.carbs += num(m.carbs);
      totals.fat += num(m.fat);

      var qtyBadge = num(m.quantity, 1) !== 1
        ? el('span', { class: 'badge text-xs' }, ['×' + fmt.num(m.quantity, 2)])
        : null;

      box.appendChild(
        el('div', { class: 'meal-row' }, [
          el('div', { class: 'meal-row__main' }, [
            el('div', { class: 'meal-row__name' }, [m.name, qtyBadge ? ' ' : null, qtyBadge]),
            el('div', { class: 'meal-row__macros' }, [macroLine(m)]),
          ]),
          el('div', { class: 'meal-row__cal' }, [fmt.num(m.calories) + ' kcal']),
          el('button', {
            class: 'btn btn--ghost btn--icon meal-row__del',
            type: 'button',
            'aria-label': 'Delete meal',
            title: 'Delete meal',
            onClick: function () { deleteMeal(m.id); },
          }, ['✕']),
        ])
      );
    });

    box.appendChild(
      el('div', { class: 'meals-total' }, [
        el('div', {}, [
          'Total',
          el('div', { class: 'meals-total__macros' }, [macroLine(totals)]),
        ]),
        el('div', { class: 'meal-row__cal' }, [fmt.num(totals.calories) + ' kcal']),
      ])
    );
  }

  function renderWeight(data) {
    var box = document.getElementById('weight-panel');
    if (!box) return;
    box.innerHTML = '';
    var unit = WEIGHT_GOAL.unit;
    var current = data.weight;
    var prev = data.prevWeight;

    if (current === null || current === undefined) {
      box.appendChild(el('div', { class: 'muted text-sm' }, ['No weight recorded for this day.']));
    } else {
      var deltaNode = null;
      if (prev !== null && prev !== undefined) {
        var diff = round(num(current) - num(prev), 1);
        if (diff !== 0) {
          deltaNode = el('span', { class: 'weight-delta ' + (diff > 0 ? 'up' : 'down') }, [
            (diff > 0 ? '▲ +' : '▼ ') + fmt.num(Math.abs(diff), 1) + ' ' + unit + ' vs ' + fmt.prettyDate(data.prevDate),
          ]);
        } else {
          deltaNode = el('span', { class: 'weight-delta muted' }, ['No change vs ' + fmt.prettyDate(data.prevDate)]);
        }
      }
      box.appendChild(
        el('div', { class: 'weight-current' }, [
          el('span', { class: 'weight-current__val' }, [fmt.num(current, 1)]),
          el('span', { class: 'weight-current__unit' }, [unit]),
          deltaNode,
        ])
      );
    }

    if (WEIGHT_GOAL.target !== null) {
      box.appendChild(
        el('div', { class: 'weight-goalline' }, ['Goal: ' + fmt.num(WEIGHT_GOAL.target, 1) + ' ' + unit])
      );
    }

    // Set / update form for the selected day.
    var input = el('input', {
      type: 'number',
      step: '0.1',
      min: '0',
      inputmode: 'decimal',
      id: 'weight-input',
      placeholder: 'e.g. 175',
      value: current !== null && current !== undefined ? String(current) : '',
    });
    var form = el('form', { class: 'weight-form', onSubmit: function (e) { e.preventDefault(); saveWeight(input.value); } }, [
      el('div', { class: 'field' }, [
        el('label', { for: 'weight-input' }, ['Weight for ' + fmt.prettyDate(selectedDate) + ' (' + unit + ')']),
        input,
      ]),
      el('button', { class: 'btn', type: 'submit' }, ['Save']),
    ]);
    box.appendChild(form);
  }

  // Cached last day payload so weight prev/current can be recomputed cheaply.
  var lastDay = null;

  async function loadDay() {
    setDateControls();
    renderDayLabel();

    var summaryBox = document.getElementById('day-summary');
    if (summaryBox) summaryBox.innerHTML = '<div class="muted text-sm">Loading…</div>';

    try {
      var data = await api.get('/api/nutrition/day?date=' + encodeURIComponent(selectedDate));
      lastDay = data;
      renderSummary(data);
      renderMeals(data.meals || []);
      await hydrateWeight(data);
    } catch (err) {
      if (summaryBox) summaryBox.innerHTML = '';
      App.toast.error('Could not load this day.');
    }
  }

  // The day endpoint only returns the current weight; fetch a small window
  // to find the most recent PRIOR reading for the "change vs previous" line.
  async function hydrateWeight(dayData) {
    dayData.prevWeight = null;
    dayData.prevDate = null;
    try {
      var from = fmt.addDays(selectedDate, -60);
      var range = await api.get(
        '/api/nutrition/range?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(selectedDate)
      );
      var days = (range.days || []).filter(function (d) { return d.weight !== null && d.weight !== undefined; });
      // Most recent reading strictly before the selected date.
      var prior = null;
      for (var i = days.length - 1; i >= 0; i -= 1) {
        if (days[i].date < selectedDate) { prior = days[i]; break; }
      }
      if (prior) {
        dayData.prevWeight = prior.weight;
        dayData.prevDate = prior.date;
      }
      // If the day endpoint had no weight but the range does (edge cases), trust the range.
      if (dayData.weight === null || dayData.weight === undefined) {
        var same = days.filter(function (d) { return d.date === selectedDate; })[0];
        if (same) dayData.weight = same.weight;
      }
    } catch (_) { /* non-fatal */ }
    renderWeight(dayData);
  }

  async function saveWeight(value) {
    if (value === '' || value === null || value === undefined) {
      App.toast.error('Enter a weight first.');
      return;
    }
    var w = Number(value);
    if (!Number.isFinite(w) || w <= 0) {
      App.toast.error('Weight must be a positive number.');
      return;
    }
    try {
      await api.post('/api/weights', { entry_date: selectedDate, weight: w });
      App.toast.success('Weight saved.');
      await loadDay();
      loadTrends();
    } catch (err) {
      App.toast.error(err.message || 'Could not save weight.');
    }
  }

  async function deleteMeal(id) {
    var ok = await App.confirm('Delete this meal from the log?', { confirmLabel: 'Delete' });
    if (!ok) return;
    try {
      await api.del('/api/meals/' + id);
      App.toast.success('Meal deleted.');
      await loadDay();
      loadTrends();
    } catch (err) {
      App.toast.error(err.message || 'Could not delete meal.');
    }
  }

  // =====================================================================
  // Date controls
  // =====================================================================

  function setDateControls() {
    var input = document.getElementById('day-input');
    if (input && input.value !== selectedDate) input.value = selectedDate;
  }

  function shiftDay(n) {
    selectedDate = fmt.addDays(selectedDate, n);
    loadDay();
    loadTrends();
  }

  function wireDateControls() {
    var input = document.getElementById('day-input');
    input.value = selectedDate;
    input.addEventListener('change', function () {
      if (input.value && /^\d{4}-\d{2}-\d{2}$/.test(input.value)) {
        selectedDate = input.value;
        loadDay();
        loadTrends();
      }
    });
    document.getElementById('day-prev').addEventListener('click', function () { shiftDay(-1); });
    document.getElementById('day-next').addEventListener('click', function () { shiftDay(1); });
    document.getElementById('day-today').addEventListener('click', function () {
      selectedDate = fmt.isoDate();
      loadDay();
      loadTrends();
    });
  }

  // =====================================================================
  // Food search + quick add
  // =====================================================================

  function foodMacroLine(f, qty) {
    var mult = qty === undefined ? 1 : qty;
    return fmt.num(f.calories * mult) + ' kcal · P ' + fmt.num(f.protein * mult) +
      ' · C ' + fmt.num(f.carbs * mult) + ' · F ' + fmt.num(f.fat * mult);
  }

  function renderFoodResults(foods, query) {
    var box = document.getElementById('food-results');
    if (!box) return;
    box.innerHTML = '';
    if (!foods.length) {
      box.appendChild(
        el('div', { class: 'nut-hint' }, [
          query
            ? 'No saved foods match “' + query + '”. Use “Add custom” to log it.'
            : 'No saved foods yet. Add one from “Add custom” (check “Save to my foods”).',
        ])
      );
      return;
    }

    foods.forEach(function (f) {
      var qtyInput = el('input', {
        type: 'number', step: '0.25', min: '0.25', value: '1',
        'aria-label': 'Quantity for ' + f.name,
      });
      var macroEl = el('div', { class: 'food-hit__macros' }, [foodMacroLine(f, 1)]);
      qtyInput.addEventListener('input', function () {
        var q = Number(qtyInput.value);
        macroEl.textContent = foodMacroLine(f, Number.isFinite(q) && q > 0 ? q : 1);
      });

      box.appendChild(
        el('div', { class: 'food-hit' }, [
          el('div', { class: 'food-hit__main' }, [
            el('div', { class: 'food-hit__name' }, [f.name, f.serving_label ? el('span', { class: 'muted text-xs' }, [' · ' + f.serving_label]) : null]),
            macroEl,
          ]),
          el('div', { class: 'food-hit__qty' }, [qtyInput]),
          el('button', {
            class: 'btn btn--sm', type: 'button',
            onClick: function () { quickAddFood(f, qtyInput.value); },
          }, ['Add']),
        ])
      );
    });
  }

  async function runSearch(q) {
    try {
      var data = await api.get('/api/foods?q=' + encodeURIComponent(q));
      renderFoodResults(data.foods || [], q);
    } catch (err) {
      App.toast.error('Food search failed.');
    }
  }

  function wireSearch() {
    var input = document.getElementById('food-search');
    input.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = input.value.trim();
      searchTimer = setTimeout(function () { runSearch(q); }, 180);
    });
    input.addEventListener('focus', function () {
      if (!document.getElementById('food-results').childNodes.length) runSearch(input.value.trim());
    });
  }

  async function quickAddFood(food, qtyRaw) {
    var qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    var payload = {
      entry_date: selectedDate,
      name: food.name,
      calories: round(food.calories * qty, 2),
      protein: round(food.protein * qty, 2),
      carbs: round(food.carbs * qty, 2),
      fat: round(food.fat * qty, 2),
      quantity: qty,
      food_id: food.id,
    };
    try {
      await api.post('/api/meals', payload);
      App.toast.success('Added ' + food.name + '.');
      await loadDay();
      loadTrends();
    } catch (err) {
      App.toast.error(err.message || 'Could not add meal.');
    }
  }

  // =====================================================================
  // Custom meal modal
  // =====================================================================

  function numField(label, id, opts) {
    opts = opts || {};
    var input = el('input', {
      type: 'number', step: opts.step || '1', min: opts.min || '0',
      id: id, value: opts.value !== undefined ? String(opts.value) : '',
      placeholder: opts.placeholder || '0', inputmode: 'decimal',
    });
    return { field: el('div', { class: 'field' }, [el('label', { for: id }, [label]), input]), input: input };
  }

  function openCustomMeal() {
    var name = el('input', { type: 'text', id: 'cm-name', placeholder: 'e.g. Chicken bowl', maxlength: '200' });
    var cal = numField('Calories', 'cm-cal', { placeholder: '0' });
    var pro = numField('Protein (g)', 'cm-pro');
    var carb = numField('Carbs (g)', 'cm-carb');
    var fat = numField('Fat (g)', 'cm-fat');
    var qty = numField('Quantity', 'cm-qty', { step: '0.25', min: '0.25', value: 1 });
    var save = el('input', { type: 'checkbox', id: 'cm-save' });
    var serving = el('input', { type: 'text', id: 'cm-serving', placeholder: 'e.g. 1 bowl (optional)' });
    var servingField = el('div', { class: 'field hidden', id: 'cm-serving-field' }, [
      el('label', { for: 'cm-serving' }, ['Serving label']),
      serving,
      el('div', { class: 'help' }, ['Per-serving macros will be saved (consumed ÷ quantity).']),
    ]);
    save.addEventListener('change', function () {
      servingField.classList.toggle('hidden', !save.checked);
    });

    App.modal({
      title: 'Add custom meal',
      wide: true,
      submitLabel: 'Add meal',
      body: function (node) {
        node.appendChild(el('div', { class: 'field' }, [el('label', { for: 'cm-name' }, ['Name']), name]));
        node.appendChild(el('div', { class: 'macro-grid' }, [cal.field, pro.field, carb.field, fat.field]));
        node.appendChild(qty.field);
        node.appendChild(el('div', { class: 'field field--inline' }, [
          save, el('label', { for: 'cm-save', style: { margin: '0' } }, ['Save to my foods']),
        ]));
        node.appendChild(servingField);
        node.appendChild(el('div', { class: 'help' }, ['Enter the totals actually consumed. Quantity is stored for reference.']));
      },
      onSubmit: async function (close) {
        var nameVal = name.value.trim();
        if (!nameVal) { throw new Error('Name is required.'); }
        var q = Number(qty.input.value);
        if (!Number.isFinite(q) || q <= 0) q = 1;
        var payload = {
          entry_date: selectedDate,
          name: nameVal,
          calories: num(cal.input.value),
          protein: num(pro.input.value),
          carbs: num(carb.input.value),
          fat: num(fat.input.value),
          quantity: q,
          save_food: save.checked,
          serving_label: serving.value.trim(),
        };
        await api.post('/api/meals', payload);
        App.toast.success('Meal added.');
        close();
        await loadDay();
        loadTrends();
      },
    });
  }

  // =====================================================================
  // Goals modal
  // =====================================================================

  function openGoals() {
    var cal = numField('Calories', 'g-cal', { value: GOALS.calories });
    var pro = numField('Protein (g)', 'g-pro', { value: GOALS.protein });
    var carb = numField('Carbs (g)', 'g-carb', { value: GOALS.carbs });
    var fat = numField('Fat (g)', 'g-fat', { value: GOALS.fat });
    var wTarget = el('input', {
      type: 'number', step: '0.1', min: '0', id: 'g-wtarget',
      placeholder: 'e.g. 165 (optional)',
      value: WEIGHT_GOAL.target !== null ? String(WEIGHT_GOAL.target) : '',
    });
    var wUnit = el('select', { id: 'g-wunit' }, [
      el('option', { value: 'lb' }, ['lb']),
      el('option', { value: 'kg' }, ['kg']),
    ]);
    wUnit.value = WEIGHT_GOAL.unit;

    App.modal({
      title: 'Edit goals',
      wide: true,
      submitLabel: 'Save goals',
      body: function (node) {
        node.appendChild(el('h4', { class: 'text-sm muted mb-1' }, ['Daily nutrition targets']));
        node.appendChild(el('div', { class: 'macro-grid mb-2' }, [cal.field, pro.field, carb.field, fat.field]));
        node.appendChild(el('h4', { class: 'text-sm muted mb-1' }, ['Weight goal']));
        node.appendChild(el('div', { class: 'field-grid' }, [
          el('div', { class: 'field' }, [el('label', { for: 'g-wtarget' }, ['Target weight']), wTarget]),
          el('div', { class: 'field' }, [el('label', { for: 'g-wunit' }, ['Unit']), wUnit]),
        ]));
      },
      onSubmit: async function (close) {
        var payload = {
          nutrition_goals: {
            calories: num(cal.input.value),
            protein: num(pro.input.value),
            carbs: num(carb.input.value),
            fat: num(fat.input.value),
          },
          weight_goal: {
            target: wTarget.value.trim() === '' ? null : num(wTarget.value),
            unit: wUnit.value,
          },
        };
        var res = await api.put('/api/goals', payload);
        GOALS = normGoals(res.nutrition_goals);
        WEIGHT_GOAL = normWeightGoal(res.weight_goal);
        App.toast.success('Goals saved.');
        close();
        await loadDay();
        loadTrends();
      },
    });
  }

  // =====================================================================
  // Manage saved foods modal
  // =====================================================================

  function foodFormFields(food) {
    food = food || {};
    var name = el('input', { type: 'text', placeholder: 'Name', maxlength: '200', value: food.name || '' });
    var serving = el('input', { type: 'text', placeholder: 'Serving label (optional)', value: food.serving_label || '' });
    var cal = numField('Calories', 'ff-cal-' + Math.random().toString(36).slice(2), { value: food.calories });
    var pro = numField('Protein (g)', 'ff-pro-' + Math.random().toString(36).slice(2), { value: food.protein });
    var carb = numField('Carbs (g)', 'ff-carb-' + Math.random().toString(36).slice(2), { value: food.carbs });
    var fat = numField('Fat (g)', 'ff-fat-' + Math.random().toString(36).slice(2), { value: food.fat });
    return { name: name, serving: serving, cal: cal, pro: pro, carb: carb, fat: fat };
  }

  function editFoodModal(food, onDone) {
    var isEdit = !!(food && food.id);
    var f = foodFormFields(food);
    App.modal({
      title: isEdit ? 'Edit food' : 'Add food',
      submitLabel: isEdit ? 'Save' : 'Add',
      body: function (node) {
        node.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Name']), f.name]));
        node.appendChild(el('div', { class: 'field' }, [el('label', {}, ['Serving label']), f.serving]));
        node.appendChild(el('div', { class: 'macro-grid' }, [f.cal.field, f.pro.field, f.carb.field, f.fat.field]));
        node.appendChild(el('div', { class: 'help mt-1' }, ['Enter macros for one serving. Quantity is applied when logging.']));
      },
      onSubmit: async function (close) {
        var nameVal = f.name.value.trim();
        if (!nameVal) { throw new Error('Name is required.'); }
        var payload = {
          name: nameVal,
          serving_label: f.serving.value.trim(),
          calories: num(f.cal.input.value),
          protein: num(f.pro.input.value),
          carbs: num(f.carb.input.value),
          fat: num(f.fat.input.value),
        };
        if (isEdit) await api.put('/api/foods/' + food.id, payload);
        else await api.post('/api/foods', payload);
        App.toast.success(isEdit ? 'Food updated.' : 'Food added.');
        close();
        if (onDone) onDone();
      },
    });
  }

  async function openManageFoods() {
    var listNode = el('div', { class: 'foods-manage-list' }, [el('div', { class: 'muted text-sm' }, ['Loading…'])]);

    async function refresh() {
      try {
        var data = await api.get('/api/foods');
        var foods = data.foods || [];
        listNode.innerHTML = '';
        if (!foods.length) {
          listNode.appendChild(el('div', { class: 'empty' }, ['No saved foods yet.']));
          return;
        }
        foods.forEach(function (food) {
          listNode.appendChild(
            el('div', { class: 'foods-manage-row' }, [
              el('div', { class: 'foods-manage-row__main' }, [
                el('div', { class: 'foods-manage-row__name' }, [
                  food.name,
                  food.serving_label ? el('span', { class: 'muted text-xs' }, [' · ' + food.serving_label]) : null,
                ]),
                el('div', { class: 'foods-manage-row__macros' }, [foodMacroLine(food, 1)]),
              ]),
              el('div', { class: 'foods-manage-row__actions' }, [
                el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: function () { editFoodModal(food, refresh); } }, ['Edit']),
                el('button', {
                  class: 'btn btn--ghost btn--sm', type: 'button',
                  onClick: async function () {
                    var ok = await App.confirm('Delete “' + food.name + '” from your saved foods?', { confirmLabel: 'Delete' });
                    if (!ok) return;
                    try {
                      await api.del('/api/foods/' + food.id);
                      App.toast.success('Food deleted.');
                      refresh();
                    } catch (err) { App.toast.error(err.message || 'Could not delete food.'); }
                  },
                }, ['Delete']),
              ]),
            ])
          );
        });
      } catch (err) {
        listNode.innerHTML = '';
        listNode.appendChild(el('div', { class: 'muted text-sm' }, ['Could not load foods.']));
      }
    }

    App.modal({
      title: 'Saved foods',
      wide: true,
      body: function (node) {
        node.appendChild(
          el('div', { class: 'row row--end mb-2' }, [
            el('button', { class: 'btn btn--sm', type: 'button', onClick: function () { editFoodModal(null, refresh); } }, ['+ Add food']),
          ])
        );
        node.appendChild(listNode);
      },
      footer: function (foot, close) {
        foot.appendChild(el('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, ['Close']));
      },
    });

    refresh();
  }

  // =====================================================================
  // Trends
  // =====================================================================

  function wireRange() {
    var seg = document.getElementById('range-seg');
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-range]');
      if (!btn) return;
      var days = Number(btn.getAttribute('data-range'));
      if (!Number.isFinite(days)) return;
      rangeDays = days;
      App.$$('button', seg).forEach(function (b) { b.classList.toggle('is-active', b === btn); });
      loadTrends();
    });
  }

  // Group daily rows into ISO-week averages (used for the 90d view).
  function groupByWeek(days) {
    var buckets = new Map();
    var order = [];
    days.forEach(function (d) {
      var date = fmt.parseDate(d.date);
      // ISO week: shift to Thursday of the current week.
      var tmp = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      var dayNum = (tmp.getDay() + 6) % 7; // Mon=0..Sun=6
      tmp.setDate(tmp.getDate() - dayNum); // Monday of this week
      var key = fmt.isoDate(tmp);
      if (!buckets.has(key)) {
        buckets.set(key, { date: key, calories: 0, protein: 0, carbs: 0, fat: 0, calDays: 0, wSum: 0, wCount: 0 });
        order.push(key);
      }
      var b = buckets.get(key);
      // Average calories/macros over logged days only (days with any calories).
      if (d.calories > 0 || d.protein > 0 || d.carbs > 0 || d.fat > 0) {
        b.calories += d.calories; b.protein += d.protein; b.carbs += d.carbs; b.fat += d.fat; b.calDays += 1;
      }
      if (d.weight !== null && d.weight !== undefined) { b.wSum += d.weight; b.wCount += 1; }
    });
    return order.map(function (key) {
      var b = buckets.get(key);
      var dv = b.calDays || 1;
      return {
        date: key,
        calories: round(b.calories / dv, 0),
        protein: round(b.protein / dv, 0),
        carbs: round(b.carbs / dv, 0),
        fat: round(b.fat / dv, 0),
        weight: b.wCount ? round(b.wSum / b.wCount, 1) : null,
      };
    });
  }

  function computeAverages(days) {
    var logged = days.filter(function (d) {
      return d.calories > 0 || d.protein > 0 || d.carbs > 0 || d.fat > 0;
    });
    var sum = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    logged.forEach(function (d) {
      sum.calories += d.calories; sum.protein += d.protein; sum.carbs += d.carbs; sum.fat += d.fat;
    });
    var n = logged.length || 1;
    var avg = {
      calories: round(sum.calories / n, 0),
      protein: round(sum.protein / n, 0),
      carbs: round(sum.carbs / n, 0),
      fat: round(sum.fat / n, 0),
      loggedDays: logged.length,
    };

    var weighed = days.filter(function (d) { return d.weight !== null && d.weight !== undefined; });
    avg.weightTrend = null;
    avg.weightLatest = null;
    if (weighed.length) {
      avg.weightLatest = weighed[weighed.length - 1].weight;
      if (weighed.length >= 2) {
        avg.weightTrend = round(weighed[weighed.length - 1].weight - weighed[0].weight, 1);
      }
    }
    return avg;
  }

  function renderAverages(avg) {
    var box = document.getElementById('trends-averages');
    if (!box) return;
    box.innerHTML = '';

    function stat(label, val, sub, subCls) {
      return el('div', { class: 'avg-stat' }, [
        el('div', { class: 'avg-stat__label' }, [label]),
        el('div', { class: 'avg-stat__val' }, [val]),
        sub ? el('div', { class: 'avg-stat__sub' + (subCls ? ' ' + subCls : '') }, [sub]) : null,
      ]);
    }

    box.appendChild(stat('Avg calories', avg.loggedDays ? fmt.num(avg.calories) : '—',
      avg.loggedDays ? avg.loggedDays + ' logged day' + (avg.loggedDays === 1 ? '' : 's') : 'No meals logged'));
    box.appendChild(stat('Avg protein', avg.loggedDays ? fmt.num(avg.protein) + ' g' : '—'));
    box.appendChild(stat('Avg carbs', avg.loggedDays ? fmt.num(avg.carbs) + ' g' : '—'));
    box.appendChild(stat('Avg fat', avg.loggedDays ? fmt.num(avg.fat) + ' g' : '—'));

    var wSub = '';
    var wCls = '';
    if (avg.weightTrend !== null) {
      if (avg.weightTrend > 0) { wSub = '▲ +' + fmt.num(avg.weightTrend, 1) + ' ' + WEIGHT_GOAL.unit; wCls = 'up'; }
      else if (avg.weightTrend < 0) { wSub = '▼ ' + fmt.num(avg.weightTrend, 1) + ' ' + WEIGHT_GOAL.unit; wCls = 'down'; }
      else { wSub = 'No change'; }
    } else if (avg.weightLatest !== null) {
      wSub = 'Only one reading';
    } else {
      wSub = 'No readings';
    }
    box.appendChild(stat('Weight', avg.weightLatest !== null ? fmt.num(avg.weightLatest, 1) + ' ' + WEIGHT_GOAL.unit : '—', wSub, wCls));
  }

  function destroyChart(key) {
    if (charts[key]) { charts[key].destroy(); charts[key] = null; }
  }

  function baseOptions(extra) {
    var opts = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false, labels: { color: COL.text } },
        tooltip: { enabled: true },
      },
      scales: {
        x: { grid: { color: COL.grid }, ticks: { color: COL.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { grid: { color: COL.grid }, ticks: { color: COL.text }, beginAtZero: true },
      },
    };
    return Object.assign(opts, extra || {});
  }

  function labelsFor(rows) {
    return rows.map(function (r) { return fmt.prettyDate(r.date, { month: 'short', day: 'numeric' }); });
  }

  function goalLineDataset(rows, value, color, label) {
    return {
      label: label,
      data: rows.map(function () { return value; }),
      borderColor: color,
      borderWidth: 1.5,
      borderDash: [6, 5],
      pointRadius: 0,
      fill: false,
      type: 'line',
      tension: 0,
    };
  }

  function drawCalories(rows) {
    destroyChart('calories');
    var ctx = document.getElementById('chart-calories');
    if (!ctx || !window.Chart) return;
    var datasets = [{
      label: 'Calories',
      data: rows.map(function (r) { return r.calories; }),
      backgroundColor: COL.series1,
      borderRadius: 4,
      maxBarThickness: 42,
      order: 2,
    }];
    if (GOALS.calories > 0) {
      datasets.push(Object.assign(goalLineDataset(rows, GOALS.calories, COL.goal, 'Goal'), { order: 1 }));
    }
    charts.calories = new window.Chart(ctx, {
      type: 'bar',
      data: { labels: labelsFor(rows), datasets: datasets },
      options: baseOptions({ plugins: { legend: { display: true, labels: { color: COL.text } }, tooltip: { enabled: true } } }),
    });
  }

  function drawMacros(rows) {
    destroyChart('macros');
    var ctx = document.getElementById('chart-macros');
    if (!ctx || !window.Chart) return;
    function line(label, key, color) {
      return {
        label: label,
        data: rows.map(function (r) { return r[key]; }),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: rows.length > 40 ? 0 : 2,
        tension: 0.25,
        fill: false,
      };
    }
    charts.macros = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels: labelsFor(rows),
        datasets: [line('Protein', 'protein', COL.series1), line('Carbs', 'carbs', COL.series2), line('Fat', 'fat', COL.series3)],
      },
      options: baseOptions({ plugins: { legend: { display: true, labels: { color: COL.text } }, tooltip: { enabled: true } } }),
    });
  }

  function drawWeight(rows) {
    destroyChart('weight');
    var ctx = document.getElementById('chart-weight');
    if (!ctx || !window.Chart) return;

    var hasAny = rows.some(function (r) { return r.weight !== null && r.weight !== undefined; });
    var datasets = [{
      label: 'Weight (' + WEIGHT_GOAL.unit + ')',
      data: rows.map(function (r) { return r.weight === null || r.weight === undefined ? null : r.weight; }),
      borderColor: COL.ink,
      backgroundColor: COL.ink,
      borderWidth: 2,
      pointRadius: rows.length > 40 ? 0 : 3,
      tension: 0.25,
      spanGaps: true,
      fill: false,
    }];
    if (WEIGHT_GOAL.target !== null) {
      datasets.push(goalLineDataset(rows, WEIGHT_GOAL.target, COL.goal, 'Goal'));
    }
    charts.weight = new window.Chart(ctx, {
      type: 'line',
      data: { labels: labelsFor(rows), datasets: datasets },
      options: baseOptions({
        plugins: { legend: { display: true, labels: { color: COL.text } }, tooltip: { enabled: true } },
        scales: {
          x: { grid: { color: COL.grid }, ticks: { color: COL.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
          y: { grid: { color: COL.grid }, ticks: { color: COL.text }, beginAtZero: false },
        },
      }),
    });
    if (!hasAny) {
      // Draw an empty-ish chart; the averages box already communicates "no readings".
      charts.weight.options.scales.y.suggestedMin = 0;
      charts.weight.options.scales.y.suggestedMax = 1;
      charts.weight.update();
    }
  }

  async function loadTrends() {
    var to = selectedDate;
    var from = fmt.addDays(to, -(rangeDays - 1));
    try {
      var data = await api.get('/api/nutrition/range?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
      GOALS = normGoals(data.goals);
      WEIGHT_GOAL = normWeightGoal(data.weight_goal);
      var days = data.days || [];

      renderAverages(computeAverages(days));

      var chartRows = rangeDays >= 90 ? groupByWeek(days) : days;
      drawCalories(chartRows);
      drawMacros(chartRows);
      drawWeight(chartRows);
    } catch (err) {
      App.toast.error('Could not load trends.');
    }
  }

  // =====================================================================
  // Wire up + initial load
  // =====================================================================

  function init() {
    wireDateControls();
    wireSearch();
    wireRange();

    document.getElementById('btn-custom-meal').addEventListener('click', openCustomMeal);
    document.getElementById('btn-edit-goals').addEventListener('click', openGoals);
    document.getElementById('btn-manage-foods').addEventListener('click', openManageFoods);

    loadDay();
    loadTrends();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
