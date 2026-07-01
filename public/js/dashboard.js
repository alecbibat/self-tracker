/* Dashboard "today at a glance" — fetches feature summaries, degrades gracefully. */
(function () {
  'use strict';
  const { api, fmt } = window.App;
  const today = fmt.isoDate();

  (async function habits() {
    const box = document.getElementById('glance-habits');
    try {
      const data = await api.get('/api/habits/summary?date=' + today);
      if (!data.total) { box.textContent = 'No habits yet. Add some →'; return; }
      box.innerHTML =
        '<strong style="font-size:1.4rem">' + data.completed + '/' + data.total + '</strong> ' +
        '<span class="muted">habits done today</span>';
    } catch (_) {
      box.textContent = 'Could not load habits.';
    }
  })();

  (async function nutrition() {
    const box = document.getElementById('glance-nutrition');
    try {
      const data = await api.get('/api/nutrition/day?date=' + today);
      const t = data.totals || {};
      const g = data.goals || {};
      box.innerHTML =
        '<strong style="font-size:1.4rem">' + fmt.num(t.calories) + '</strong> ' +
        '<span class="muted">/ ' + fmt.num(g.calories) + ' kcal</span><br>' +
        '<span class="text-sm muted">P ' + fmt.num(t.protein) + ' · C ' + fmt.num(t.carbs) + ' · F ' + fmt.num(t.fat) + '</span>';
    } catch (_) {
      box.textContent = 'Could not load nutrition.';
    }
  })();
})();
