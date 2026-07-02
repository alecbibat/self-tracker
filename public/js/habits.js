/* =========================================================================
   Habit Tracker — one month calendar per habit.
   Depends on window.App (common.js).
   ========================================================================= */
(function () {
  'use strict';

  var App = window.App;
  var el = App.el;
  var fmt = App.fmt;

  var DEFAULT_COLOR = '#c4a265';
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  var listRoot = App.$('#habits-list');
  var TODAY = fmt.isoDate(); // local YYYY-MM-DD

  // Per-habit view state: current month + fetched entries keyed by date.
  // { [habitId]: { year, month(0-11), entries: {date: {done, value}} } }
  var viewState = {};
  var habits = [];

  // ---- Date helpers -------------------------------------------------------

  function ymd(year, month, day) {
    return (
      String(year) + '-' +
      String(month + 1).padStart(2, '0') + '-' +
      String(day).padStart(2, '0')
    );
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  // First day-of-week (0=Sun) for the 1st of the month.
  function firstWeekday(year, month) {
    return new Date(year, month, 1).getDay();
  }

  // ---- Entry / completion logic ------------------------------------------

  function isDayComplete(habit, entry) {
    if (!entry) return false;
    if (habit.type === 'yesno') return !!entry.done;
    var value = Number(entry.value) || 0;
    if (habit.target != null && Number(habit.target) > 0) return value >= Number(habit.target);
    return value > 0;
  }

  // Fill intensity 0..1 for a quantity cell (relative to target if set).
  function intensity(habit, entry) {
    if (!entry) return 0;
    var value = Number(entry.value) || 0;
    if (value <= 0) return 0;
    if (habit.target != null && Number(habit.target) > 0) {
      return Math.max(0.18, Math.min(1, value / Number(habit.target)));
    }
    return 1;
  }

  // Current streak: consecutive complete days ending at today (or yesterday if
  // today isn't logged yet). Counts backward across the full entry set.
  function computeStreak(habit) {
    var entries = (viewState[habit.id] && viewState[habit.id].allEntries) || {};
    var streak = 0;
    var cursor = TODAY;

    // If today isn't complete, allow the streak to still count if yesterday is
    // complete (today simply "not logged yet"), but a broken today stops it.
    if (!isDayComplete(habit, entries[cursor])) {
      cursor = fmt.addDays(cursor, -1);
    }
    while (isDayComplete(habit, entries[cursor])) {
      streak += 1;
      cursor = fmt.addDays(cursor, -1);
    }
    return streak;
  }

  // Completed-day count within the currently displayed month.
  function monthCompletedCount(habit) {
    var vs = viewState[habit.id];
    if (!vs) return 0;
    var count = 0;
    var dim = daysInMonth(vs.year, vs.month);
    for (var d = 1; d <= dim; d++) {
      var date = ymd(vs.year, vs.month, d);
      if (isDayComplete(habit, vs.entries[date])) count += 1;
    }
    return count;
  }

  // ---- Data loading -------------------------------------------------------

  function monthRange(year, month) {
    var last = daysInMonth(year, month);
    return { from: ymd(year, month, 1), to: ymd(year, month, last) };
  }

  // Load entries for the visible month (plus a small trailing window so the
  // streak reads correctly across the month boundary).
  function loadMonthEntries(habit) {
    var vs = viewState[habit.id];
    var range = monthRange(vs.year, vs.month);
    // Fetch a window that always covers both the visible month AND a ~45-day
    // run of recent history ending today, so the streak reads correctly no
    // matter which month is on screen (past, current, or future).
    var monthStartBack = fmt.addDays(range.from, -45);
    var todayBack = fmt.addDays(TODAY, -45);
    var from = monthStartBack < todayBack ? monthStartBack : todayBack;
    var to = range.to > TODAY ? range.to : TODAY;

    return App.api.get(
      '/api/habits/' + habit.id + '/entries?from=' + from + '&to=' + to
    ).then(function (rows) {
      var entries = {};
      var all = {};
      (rows || []).forEach(function (r) {
        var rec = { done: !!r.done, value: Number(r.value) || 0 };
        all[r.entry_date] = rec;
        entries[r.entry_date] = rec;
      });
      vs.entries = entries;
      vs.allEntries = all;
    });
  }

  // ---- Rendering ----------------------------------------------------------

  function renderAll() {
    listRoot.innerHTML = '';

    if (!habits.length) {
      listRoot.appendChild(
        el('div', { class: 'empty' }, [
          el('p', { class: 'mb-1', text: 'No habits yet.' }),
          el('button', {
            class: 'btn',
            type: 'button',
            onClick: openAddModal,
          }, ['＋ Add your first habit']),
        ])
      );
      return;
    }

    habits.forEach(function (habit) {
      listRoot.appendChild(renderHabitCard(habit));
    });
  }

  function renderHabitCard(habit) {
    var vs = viewState[habit.id];
    var color = habit.color || DEFAULT_COLOR;

    var card = el('div', {
      class: 'card habit-card',
      dataset: { habitId: String(habit.id) },
    });
    // Custom properties must be set via setProperty; Object.assign(style, ...)
    // (used by App.el) silently ignores dashed property names.
    card.style.setProperty('--habit-color', color);

    // --- Header: title, badges, actions ---
    var badges = el('div', { class: 'row row--wrap habit-badges' });
    badges.appendChild(
      el('span', { class: 'badge habit-type-badge' }, [
        habit.type === 'yesno' ? 'Yes / No' : 'Quantity',
      ])
    );
    if (habit.type === 'quantity' && habit.unit) {
      badges.appendChild(el('span', { class: 'badge' }, [habit.unit]));
    }
    if (habit.target != null) {
      badges.appendChild(
        el('span', { class: 'badge badge--brand' }, [
          'Goal ' + fmt.num(habit.target, 2) + (habit.unit ? ' ' + habit.unit : ''),
        ])
      );
    }

    var streak = computeStreak(habit);
    var monthCount = monthCompletedCount(habit);

    var stats = el('div', { class: 'row row--wrap habit-stats' }, [
      el('span', { class: 'habit-stat' }, [
        el('span', { class: 'habit-stat__num', text: String(streak) }),
        el('span', { class: 'habit-stat__label', text: streak === 1 ? 'day streak' : 'day streak' }),
      ]),
      el('span', { class: 'habit-stat' }, [
        el('span', { class: 'habit-stat__num', text: String(monthCount) }),
        el('span', { class: 'habit-stat__label', text: 'this month' }),
      ]),
    ]);

    var actions = el('div', { class: 'row habit-actions' }, [
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        title: 'Edit habit',
        'aria-label': 'Edit ' + habit.name,
        onClick: function () { openEditModal(habit); },
      }, ['Edit']),
      el('button', {
        class: 'btn btn--ghost btn--sm habit-delete',
        type: 'button',
        title: 'Remove habit',
        'aria-label': 'Remove ' + habit.name,
        onClick: function () { removeHabit(habit); },
      }, ['Remove']),
    ]);

    var header = el('div', { class: 'habit-head' }, [
      el('div', { class: 'habit-head__main' }, [
        el('div', { class: 'row row--wrap habit-title-row' }, [
          el('span', { class: 'habit-dot', style: { background: color } }),
          el('h3', { class: 'habit-name', text: habit.name }),
        ]),
        badges,
      ]),
      el('div', { class: 'habit-head__side' }, [stats, actions]),
    ]);

    // --- Month pager ---
    var monthLabel = el('span', {
      class: 'habit-month-label',
      text: MONTHS[vs.month] + ' ' + vs.year,
    });
    var pager = el('div', { class: 'row row--between habit-pager' }, [
      el('button', {
        class: 'btn btn--ghost btn--sm btn--icon',
        type: 'button',
        'aria-label': 'Previous month',
        onClick: function () { changeMonth(habit, -1); },
      }, ['‹']),
      monthLabel,
      el('button', {
        class: 'btn btn--ghost btn--sm btn--icon',
        type: 'button',
        'aria-label': 'Next month',
        onClick: function () { changeMonth(habit, 1); },
      }, ['›']),
    ]);

    // --- Calendar grid ---
    var cal = el('div', { class: 'habit-cal', role: 'grid', 'aria-label': habit.name + ' calendar' });

    WEEKDAYS.forEach(function (w) {
      cal.appendChild(el('div', { class: 'habit-cal__wd', role: 'columnheader', text: w }));
    });

    var lead = firstWeekday(vs.year, vs.month);
    for (var i = 0; i < lead; i++) {
      cal.appendChild(el('div', { class: 'habit-cal__cell habit-cal__cell--empty', 'aria-hidden': 'true' }));
    }

    var dim = daysInMonth(vs.year, vs.month);
    for (var day = 1; day <= dim; day++) {
      cal.appendChild(buildDayCell(habit, vs, day));
    }

    card.appendChild(header);
    card.appendChild(pager);
    card.appendChild(cal);
    return card;
  }

  function buildDayCell(habit, vs, day) {
    var date = ymd(vs.year, vs.month, day);
    var entry = vs.entries[date];
    var complete = isDayComplete(habit, entry);
    var isToday = date === TODAY;
    var isFuture = date > TODAY;

    var cls = 'habit-cal__cell';
    if (isToday) cls += ' is-today';
    if (isFuture) cls += ' is-future';
    if (complete) cls += ' is-complete';

    var attrs = {
      class: cls,
      role: 'gridcell',
      dataset: { date: date },
    };

    var children = [el('span', { class: 'habit-cal__day', text: String(day) })];

    // Custom properties (--fill) can't be set through App.el's style object
    // (Object.assign ignores dashed names); apply them via setProperty below.
    var fill = null;
    if (habit.type === 'quantity') {
      var value = entry ? Number(entry.value) || 0 : 0;
      if (value > 0) {
        fill = String(intensity(habit, entry));
        cls += ' has-value';
        attrs.class = cls;
        children.push(el('span', { class: 'habit-cal__val', text: fmt.num(value, 2) }));
      }
    } else if (complete) {
      fill = '1';
    }

    var cell = el('div', attrs, children);
    if (fill !== null) cell.style.setProperty('--fill', fill);

    if (!isFuture) {
      cell.setAttribute('tabindex', '0');
      var label = fmt.prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric' });
      cell.setAttribute('aria-label', label + (complete ? ' — done' : ''));
      var handler = function () { onDayClick(habit, date); };
      cell.addEventListener('click', handler);
      cell.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handler();
        }
      });
    } else {
      cell.setAttribute('aria-disabled', 'true');
    }

    return cell;
  }

  // Re-render only one habit's card in place (avoids rebuilding the whole list).
  function refreshCard(habit) {
    var existing = App.$('.habit-card[data-habit-id="' + habit.id + '"]');
    var fresh = renderHabitCard(habit);
    if (existing && existing.parentNode) {
      existing.parentNode.replaceChild(fresh, existing);
    } else {
      renderAll();
    }
  }

  // ---- Interactions -------------------------------------------------------

  function changeMonth(habit, delta) {
    var vs = viewState[habit.id];
    var m = vs.month + delta;
    var y = vs.year;
    if (m < 0) { m = 11; y -= 1; }
    else if (m > 11) { m = 0; y += 1; }
    vs.month = m;
    vs.year = y;
    loadMonthEntries(habit)
      .then(function () { refreshCard(habit); })
      .catch(function (err) { App.toast.error(err.message || 'Failed to load month.'); });
  }

  function onDayClick(habit, date) {
    if (date > TODAY) return;
    if (habit.type === 'yesno') {
      toggleYesNo(habit, date);
    } else {
      openQuantityModal(habit, date);
    }
  }

  function toggleYesNo(habit, date) {
    var vs = viewState[habit.id];
    var current = vs.entries[date];
    var next = !(current && current.done);
    App.api.put('/api/habits/' + habit.id + '/entries/' + date, { done: next })
      .then(function (row) {
        var rec = { done: !!row.done, value: Number(row.value) || 0 };
        vs.entries[date] = rec;
        vs.allEntries[date] = rec;
        refreshCard(habit);
      })
      .catch(function (err) { App.toast.error(err.message || 'Failed to save.'); });
  }

  function openQuantityModal(habit, date) {
    var vs = viewState[habit.id];
    var current = vs.entries[date];
    var currentVal = current ? Number(current.value) || 0 : 0;
    var unit = habit.unit || '';
    var input;
    var closeModal;
    var saveBtn;

    function submit() {
      var raw = input.value.trim();
      var value = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        App.toast.error('Enter a number of zero or more.');
        return;
      }
      saveQuantity(habit, date, value, closeModal, saveBtn);
    }

    App.modal({
      title: fmt.prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric' }),
      body: function (node) {
        var field = el('div', { class: 'field' }, [
          el('label', { for: 'qty-input', text: 'Amount' + (unit ? ' (' + unit + ')' : '') }),
          (input = el('input', {
            id: 'qty-input',
            type: 'number',
            min: '0',
            step: 'any',
            inputmode: 'decimal',
            value: currentVal ? String(currentVal) : '',
            placeholder: '0',
          })),
        ]);
        node.appendChild(field);
        if (habit.target != null) {
          node.appendChild(
            el('p', { class: 'help', text: 'Goal: ' + fmt.num(habit.target, 2) + (unit ? ' ' + unit : '') })
          );
        }
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
        });
      },
      footer: function (foot, close) {
        closeModal = close;
        // Optional quick-clear button for quantity days.
        foot.appendChild(
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            onClick: function () { saveQuantity(habit, date, 0, close); },
          }, ['Clear'])
        );
        foot.appendChild(el('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, ['Cancel']));
        saveBtn = el('button', { class: 'btn', type: 'button' }, ['Save']);
        saveBtn.addEventListener('click', submit);
        foot.appendChild(saveBtn);
      },
    });
  }

  function saveQuantity(habit, date, value, close, btn) {
    if (btn) btn.disabled = true;
    var vs = viewState[habit.id];
    App.api.put('/api/habits/' + habit.id + '/entries/' + date, { value: value })
      .then(function (row) {
        var rec = { done: !!row.done, value: Number(row.value) || 0 };
        vs.entries[date] = rec;
        vs.allEntries[date] = rec;
        if (close) close();
        refreshCard(habit);
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        App.toast.error(err.message || 'Failed to save.');
      });
  }

  // ---- Add / edit habit modal --------------------------------------------

  function habitFormBody(node, values) {
    var typeSel, unitField, unitInput;

    var nameInput = el('input', {
      id: 'h-name', type: 'text', value: values.name || '', maxlength: '120',
      placeholder: 'e.g. Drink water', required: 'required',
    });
    node.appendChild(el('div', { class: 'field' }, [
      el('label', { for: 'h-name', text: 'Name' }),
      nameInput,
    ]));

    typeSel = el('select', { id: 'h-type' }, [
      el('option', { value: 'yesno' }, ['Yes / No — did I do it?']),
      el('option', { value: 'quantity' }, ['Quantity — how much?']),
    ]);
    typeSel.value = values.type || 'yesno';
    // Editing can't change type (entries semantics differ); lock it.
    if (values.locked) typeSel.disabled = true;
    node.appendChild(el('div', { class: 'field' }, [
      el('label', { for: 'h-type', text: 'Type' }),
      typeSel,
      values.locked
        ? el('p', { class: 'help', text: 'Type cannot be changed after a habit is created.' })
        : null,
    ]));

    unitInput = el('input', {
      id: 'h-unit', type: 'text', value: values.unit || '', maxlength: '40',
      placeholder: 'e.g. glasses, min, pages',
    });
    unitField = el('div', { class: 'field' }, [
      el('label', { for: 'h-unit', text: 'Unit' }),
      unitInput,
      el('p', { class: 'help', text: 'What one point counts (quantity habits only).' }),
    ]);
    node.appendChild(unitField);

    var targetInput = el('input', {
      id: 'h-target', type: 'number', min: '0', step: 'any',
      value: values.target != null ? String(values.target) : '',
      placeholder: 'optional',
    });
    node.appendChild(el('div', { class: 'field' }, [
      el('label', { for: 'h-target', text: 'Target / goal (optional)' }),
      targetInput,
      el('p', { class: 'help', text: 'A day counts as complete when it reaches this.' }),
    ]));

    var colorInput = el('input', {
      id: 'h-color', type: 'color', value: values.color || DEFAULT_COLOR,
    });
    node.appendChild(el('div', { class: 'field' }, [
      el('label', { for: 'h-color', text: 'Color' }),
      colorInput,
    ]));

    function syncType() {
      var isQty = typeSel.value === 'quantity';
      unitField.style.display = isQty ? '' : 'none';
    }
    typeSel.addEventListener('change', syncType);
    syncType();

    return {
      read: function () {
        return {
          name: nameInput.value.trim(),
          type: typeSel.value,
          unit: typeSel.value === 'quantity' ? unitInput.value.trim() : '',
          target: targetInput.value.trim(),
          color: colorInput.value || DEFAULT_COLOR,
        };
      },
      focus: function () { nameInput.focus(); },
    };
  }

  function openAddModal() {
    var form;
    App.modal({
      title: 'Add habit',
      body: function (node) { form = habitFormBody(node, {}); },
      submitLabel: 'Create',
      onSubmit: function (close) {
        var data = form.read();
        if (!data.name) { App.toast.error('Name is required.'); return; }
        var payload = {
          name: data.name,
          type: data.type,
          unit: data.unit,
          target: data.target === '' ? null : Number(data.target),
          color: data.color,
        };
        if (payload.target != null && (!Number.isFinite(payload.target) || payload.target < 0)) {
          App.toast.error('Target must be a number of zero or more.');
          return;
        }
        return App.api.post('/api/habits', payload).then(function (habit) {
          close();
          App.toast.success('Habit added.');
          addHabitToState(habit);
        });
      },
    });
  }

  function openEditModal(habit) {
    var form;
    App.modal({
      title: 'Edit habit',
      body: function (node) {
        form = habitFormBody(node, {
          name: habit.name,
          type: habit.type,
          unit: habit.unit,
          target: habit.target,
          color: habit.color,
          locked: true,
        });
      },
      submitLabel: 'Save',
      onSubmit: function (close) {
        var data = form.read();
        if (!data.name) { App.toast.error('Name is required.'); return; }
        var payload = {
          name: data.name,
          unit: data.unit,
          target: data.target === '' ? null : Number(data.target),
          color: data.color,
        };
        if (payload.target != null && (!Number.isFinite(payload.target) || payload.target < 0)) {
          App.toast.error('Target must be a number of zero or more.');
          return;
        }
        return App.api.put('/api/habits/' + habit.id, payload).then(function (updated) {
          close();
          App.toast.success('Habit updated.');
          // Merge updated fields, keep the same view state / entries.
          Object.assign(habit, updated);
          refreshCard(habit);
        });
      },
    });
  }

  function removeHabit(habit) {
    App.confirm(
      'Remove “' + habit.name + '”? This deletes the habit and all of its logged days.',
      { danger: true, confirmLabel: 'Remove' }
    ).then(function (ok) {
      if (!ok) return;
      App.api.del('/api/habits/' + habit.id).then(function () {
        App.toast.success('Habit removed.');
        habits = habits.filter(function (h) { return h.id !== habit.id; });
        delete viewState[habit.id];
        var card = App.$('.habit-card[data-habit-id="' + habit.id + '"]');
        if (card && card.parentNode) card.parentNode.removeChild(card);
        if (!habits.length) renderAll();
      }).catch(function (err) {
        App.toast.error(err.message || 'Failed to remove.');
      });
    });
  }

  // ---- State bootstrap ----------------------------------------------------

  function initViewState(habit) {
    var now = new Date();
    viewState[habit.id] = {
      year: now.getFullYear(),
      month: now.getMonth(),
      entries: {},
      allEntries: {},
    };
  }

  function addHabitToState(habit) {
    habits.push(habit);
    initViewState(habit);
    loadMonthEntries(habit)
      .then(function () { renderAll(); })
      .catch(function () { renderAll(); });
  }

  function load() {
    App.api.get('/api/habits')
      .then(function (rows) {
        habits = rows || [];
        habits.forEach(initViewState);
        return Promise.all(habits.map(function (h) {
          return loadMonthEntries(h).catch(function () { /* keep going */ });
        }));
      })
      .then(function () { renderAll(); })
      .catch(function (err) {
        listRoot.innerHTML = '';
        listRoot.appendChild(
          el('div', { class: 'empty' }, [err.message || 'Failed to load habits.'])
        );
      });
  }

  // ---- Wire up ------------------------------------------------------------

  var addBtn = App.$('#add-habit');
  if (addBtn) addBtn.addEventListener('click', openAddModal);

  load();
})();
