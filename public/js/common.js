/* =========================================================================
   Self Tracker — shared frontend helpers, exposed as window.App
   No build step, no framework. Every feature page uses these.
   ========================================================================= */
(function () {
  'use strict';

  // --- Fetch wrapper: JSON in, JSON out, throws on non-2xx --------------
  async function api(url, options = {}) {
    const opts = { headers: {}, ...options };
    if (opts.body !== undefined && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    opts.headers['Accept'] = 'application/json';
    const res = await fetch(url, opts);
    if (res.status === 401) {
      // Session expired — bounce to login.
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
      throw new Error('Not authenticated');
    }
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = text; }
    }
    if (!res.ok) {
      const message = (data && data.error) || res.statusText || 'Request failed';
      const err = new Error(message);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  api.get = (url) => api(url);
  api.post = (url, body) => api(url, { method: 'POST', body });
  api.put = (url, body) => api(url, { method: 'PUT', body });
  api.patch = (url, body) => api(url, { method: 'PATCH', body });
  api.del = (url) => api(url, { method: 'DELETE' });
  api.upload = (url, formData, method = 'POST') => api(url, { method, body: formData });

  // --- Toasts -----------------------------------------------------------
  function toast(message, type = '') {
    const root = document.getElementById('toast-root');
    if (!root) { console.log('[toast]', message); return; }
    const node = document.createElement('div');
    node.className = 'toast' + (type ? ' toast--' + type : '');
    node.textContent = message;
    root.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .3s ease';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 300);
    }, type === 'error' ? 5000 : 3000);
  }
  toast.success = (m) => toast(m, 'success');
  toast.error = (m) => toast(m, 'error');

  // --- Tiny DOM builder: el('div', {class:'x'}, [children]) --------------
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else node.setAttribute(k, v);
    }
    const kids = Array.isArray(children) ? children : [children];
    for (const c of kids) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // --- Modal ------------------------------------------------------------
  // App.modal({ title, body(node) | bodyHtml, onSubmit, submitLabel, wide })
  // Returns a controller with .close(). body/onSubmit receive helpers.
  function modal(opts = {}) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const dialog = el('div', { class: 'modal' + (opts.wide ? ' modal--wide' : '') });
    const bodyWrap = el('div', { class: 'modal__body' });

    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    const head = el('div', { class: 'modal__head' }, [
      el('h3', { text: opts.title || '' }),
      el('button', { class: 'modal__close', type: 'button', 'aria-label': 'Close', onClick: close }, ['×']),
    ]);

    if (typeof opts.body === 'function') opts.body(bodyWrap);
    else if (opts.bodyHtml) bodyWrap.innerHTML = opts.bodyHtml;

    dialog.appendChild(head);
    dialog.appendChild(bodyWrap);

    if (opts.onSubmit || opts.footer) {
      const foot = el('div', { class: 'modal__foot' });
      if (opts.footer) opts.footer(foot, close);
      else {
        foot.appendChild(el('button', { class: 'btn btn--ghost', type: 'button', onClick: close }, [opts.cancelLabel || 'Cancel']));
        const submit = el('button', { class: 'btn', type: 'button' }, [opts.submitLabel || 'Save']);
        submit.addEventListener('click', async () => {
          submit.disabled = true;
          try { await opts.onSubmit(close, dialog); }
          catch (err) { toast.error(err.message || 'Failed'); submit.disabled = false; }
        });
        foot.appendChild(submit);
      }
      dialog.appendChild(foot);
    }

    backdrop.appendChild(dialog);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    const firstInput = dialog.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
    return { close, dialog, body: bodyWrap };
  }

  // --- Confirm dialog ---------------------------------------------------
  function confirmDialog(message, { danger = true, confirmLabel = 'Delete' } = {}) {
    return new Promise((resolve) => {
      modal({
        title: 'Are you sure?',
        body: (node) => { node.appendChild(el('p', { text: message, class: 'muted' })); },
        footer: (foot, close) => {
          foot.appendChild(el('button', { class: 'btn btn--ghost', onClick: () => { close(); resolve(false); } }, ['Cancel']));
          foot.appendChild(el('button', { class: 'btn ' + (danger ? 'btn--danger' : ''), onClick: () => { close(); resolve(true); } }, [confirmLabel]));
        },
      });
    });
  }

  // --- Data passed from the server via <script type="application/json"> --
  function readData(id) {
    const node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (_) { return null; }
  }

  // --- Formatting -------------------------------------------------------
  const fmt = {
    num(n, digits = 0) {
      if (n === null || n === undefined || n === '') return '—';
      const v = Number(n);
      return Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
    },
    // Local YYYY-MM-DD (avoids UTC off-by-one from toISOString).
    isoDate(d = new Date()) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    },
    parseDate(iso) {
      const [y, m, d] = String(iso).split('-').map(Number);
      return new Date(y, (m || 1) - 1, d || 1);
    },
    prettyDate(iso, opts = { month: 'short', day: 'numeric' }) {
      return fmt.parseDate(iso).toLocaleDateString(undefined, opts);
    },
    addDays(iso, n) {
      const d = fmt.parseDate(iso);
      d.setDate(d.getDate() + n);
      return fmt.isoDate(d);
    },
  };

  window.App = { api, toast, el, $, $$, modal, confirm: confirmDialog, readData, fmt };
})();
