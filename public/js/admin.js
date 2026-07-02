/* =========================================================================
   Site Admin — client behaviour.
   Landing-page editor, site settings, and a projects manager. All server
   data arrives via App.readData; all mutations go through App.api.
   ========================================================================= */
(function () {
  'use strict';

  var App = window.App;
  var api = App.api;
  var el = App.el;

  var boot = App.readData('admin-bootstrap') || {};
  var LINK_ICONS = Array.isArray(boot.linkIcons) && boot.linkIcons.length
    ? boot.linkIcons
    : ['file', 'star', 'grid', 'link', 'mail', 'github', 'globe', 'book', 'code', 'heart'];

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function $(sel, root) { return App.$(sel, root); }

  function clampNum(v, lo, hi, fallback) {
    var n = Number(v);
    if (!Number.isFinite(n)) n = fallback;
    return Math.max(lo, Math.min(hi, n));
  }

  function slugify(raw) {
    return String(raw == null ? '' : raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function isVideoMime(name) {
    return /\.(mp4|webm|ogg|mov|m4v)$/i.test(String(name || ''));
  }

  // Upload a File to /api/media, returning {id, url}.
  function uploadMedia(file) {
    var fd = new FormData();
    fd.append('file', file);
    return api.upload('/api/media', fd);
  }

  // =====================================================================
  // 1) LANDING PAGE
  // =====================================================================
  var landing = boot.landing || {};

  var lTitle = $('#landing-title-input');
  var lSubtitle = $('#landing-subtitle-input');
  var lBgType = $('#landing-bgtype');
  var lOverlay = $('#landing-overlay');
  var lOverlayVal = $('#landing-overlay-val');
  var lBgUrl = $('#landing-bgurl');
  var lMediaId = $('#landing-media-id');
  var lMediaPreview = $('#landing-media-preview');
  var lMediaClear = $('#landing-media-clear');
  var lUpload = $('#landing-upload');
  var lUploadLabel = $('#landing-upload-label');
  var lMediaField = $('#landing-media-field');
  var lLinks = $('#landing-links');
  var lAddLink = $('#landing-add-link');
  var landingForm = $('#landing-form');

  function renderLandingMediaPreview() {
    var id = lMediaId.value ? Number(lMediaId.value) : null;
    lMediaPreview.innerHTML = '';
    if (!id) {
      lMediaPreview.appendChild(el('span', { class: 'admin-media__empty muted text-sm' }, ['No file uploaded']));
      lMediaClear.hidden = true;
      return;
    }
    var src = '/media/' + id;
    var type = lBgType.value;
    var node;
    if (type === 'video') {
      node = el('video', { class: 'admin-media__media', src: src, muted: 'muted', loop: 'loop', playsinline: 'playsinline', autoplay: 'autoplay' });
    } else {
      node = el('img', { class: 'admin-media__media', src: src, alt: 'Background preview' });
    }
    lMediaPreview.appendChild(node);
    lMediaClear.hidden = false;
  }

  // Reflect the background type onto which controls are relevant.
  function syncBgTypeUi() {
    var type = lBgType.value;
    var needsMedia = type === 'image' || type === 'video';
    lMediaField.classList.toggle('is-dim', !needsMedia);
    renderLandingMediaPreview();
  }

  function makeLinkRow(link) {
    link = link || {};
    var labelInput = el('input', {
      type: 'text', class: 'admin-link__label', value: link.label || '',
      placeholder: 'Label', maxlength: '120', 'aria-label': 'Link label',
    });
    var hrefInput = el('input', {
      type: 'text', class: 'admin-link__href', value: link.href || '',
      placeholder: 'https://… or /path', maxlength: '2000', 'aria-label': 'Link URL',
    });
    var iconSelect = el('select', { class: 'admin-link__icon', 'aria-label': 'Link icon' },
      [el('option', { value: '' }, ['— icon —'])].concat(
        LINK_ICONS.map(function (ic) {
          return el('option', { value: ic, selected: link.icon === ic ? 'selected' : null }, [ic]);
        })
      )
    );
    var removeBtn = el('button', {
      type: 'button', class: 'btn btn--ghost btn--icon admin-link__remove',
      'aria-label': 'Remove link',
      onClick: function () { row.remove(); },
    }, ['×']);

    var row = el('div', { class: 'admin-link' }, [labelInput, hrefInput, iconSelect, removeBtn]);
    return row;
  }

  function collectLinks() {
    return App.$$('.admin-link', lLinks).map(function (row) {
      return {
        label: $('.admin-link__label', row).value.trim(),
        href: $('.admin-link__href', row).value.trim(),
        icon: $('.admin-link__icon', row).value,
      };
    }).filter(function (l) { return l.label && l.href; });
  }

  function populateLanding() {
    lTitle.value = landing.title || '';
    lSubtitle.value = landing.subtitle || '';
    lBgType.value = ['image', 'video', 'gradient'].indexOf(landing.background_type) >= 0
      ? landing.background_type : 'gradient';
    var ov = clampNum(landing.overlay, 0, 1, 0.45);
    lOverlay.value = String(ov);
    lOverlayVal.textContent = ov.toFixed(2);
    lBgUrl.value = landing.background_url || '';
    lMediaId.value = landing.background_media_id != null ? String(landing.background_media_id) : '';

    lLinks.innerHTML = '';
    var links = Array.isArray(landing.links) ? landing.links : [];
    if (links.length === 0) links = [{}];
    links.forEach(function (link) { lLinks.appendChild(makeLinkRow(link)); });

    syncBgTypeUi();
  }

  function wireLanding() {
    lOverlay.addEventListener('input', function () {
      lOverlayVal.textContent = clampNum(lOverlay.value, 0, 1, 0.45).toFixed(2);
    });
    lBgType.addEventListener('change', syncBgTypeUi);

    lAddLink.addEventListener('click', function () {
      lLinks.appendChild(makeLinkRow({}));
    });

    lMediaClear.addEventListener('click', function () {
      lMediaId.value = '';
      lUpload.value = '';
      lUploadLabel.textContent = 'Upload file…';
      renderLandingMediaPreview();
    });

    lUpload.addEventListener('change', function () {
      var file = lUpload.files && lUpload.files[0];
      if (!file) return;
      lUploadLabel.textContent = 'Uploading…';
      uploadMedia(file).then(function (res) {
        lMediaId.value = String(res.id);
        // If the user uploads a video while type is image (or vice-versa),
        // nudge the type so the preview + public page match the file.
        if (isVideoMime(file.name) && lBgType.value !== 'video') {
          lBgType.value = 'video';
        } else if (!isVideoMime(file.name) && lBgType.value === 'video') {
          lBgType.value = 'image';
        } else if (lBgType.value === 'gradient') {
          lBgType.value = isVideoMime(file.name) ? 'video' : 'image';
        }
        lUploadLabel.textContent = 'Replace file…';
        syncBgTypeUi();
        App.toast.success('File uploaded.');
      }).catch(function (err) {
        lUploadLabel.textContent = 'Upload file…';
        App.toast.error(err.message || 'Upload failed.');
      }).then(function () { lUpload.value = ''; });
    });

    landingForm.addEventListener('submit', function (e) {
      e.preventDefault();
      saveLanding();
    });
  }

  function saveLanding() {
    var btn = $('#landing-save');
    var value = {
      title: lTitle.value.trim(),
      subtitle: lSubtitle.value.trim(),
      background_type: lBgType.value,
      background_media_id: lMediaId.value ? Number(lMediaId.value) : null,
      background_url: lBgUrl.value.trim(),
      overlay: clampNum(lOverlay.value, 0, 1, 0.45),
      links: collectLinks(),
    };
    btn.disabled = true;
    api.put('/api/admin/settings', { key: 'landing', value: value })
      .then(function (res) {
        landing = (res && res.value) || value;
        populateLanding();
        App.toast.success('Landing page saved.');
      })
      .catch(function (err) { App.toast.error(err.message || 'Save failed.'); })
      .then(function () { btn.disabled = false; });
  }

  // =====================================================================
  // 2) SITE SETTINGS
  // =====================================================================
  var site = boot.site || {};
  var siteForm = $('#site-form');
  var siteBrand = $('#site-brand');
  var siteFooter = $('#site-footer');

  function populateSite() {
    siteBrand.value = site.brand || '';
    siteFooter.value = site.footer_text || '';
  }

  function wireSite() {
    siteForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('#site-save');
      var value = { brand: siteBrand.value.trim(), footer_text: siteFooter.value.trim() };
      btn.disabled = true;
      api.put('/api/admin/settings', { key: 'site', value: value })
        .then(function (res) {
          site = (res && res.value) || value;
          populateSite();
          App.toast.success('Site settings saved.');
        })
        .catch(function (err) { App.toast.error(err.message || 'Save failed.'); })
        .then(function () { btn.disabled = false; });
    });
  }

  // =====================================================================
  // 3) PROJECTS
  // =====================================================================
  var projectsList = $('#projects-list');
  var projects = [];

  function loadProjects() {
    return api.get('/api/admin/projects')
      .then(function (rows) {
        projects = Array.isArray(rows) ? rows : [];
        renderProjects();
      })
      .catch(function (err) {
        projectsList.innerHTML = '';
        projectsList.appendChild(el('div', { class: 'empty' }, [err.message || 'Failed to load projects.']));
      });
  }

  function projectCover(p) {
    if (p.cover) {
      return el('div', { class: 'admin-project__cover' }, [
        el('img', { src: p.cover, alt: '', loading: 'lazy' }),
      ]);
    }
    return el('div', { class: 'admin-project__cover admin-project__cover--empty', 'aria-hidden': 'true' }, [
      el('span', {}, [(p.title || '?').slice(0, 1).toUpperCase()]),
    ]);
  }

  function renderProjects() {
    projectsList.innerHTML = '';
    if (projects.length === 0) {
      projectsList.appendChild(el('div', { class: 'empty' }, ['No projects yet. Click “New project” to add one.']));
      return;
    }

    projects.forEach(function (p) {
      var isPhotos = p.kind === 'photos' || p.slug === 'photos';

      var badges = [];
      if (isPhotos) badges.push(el('span', { class: 'badge badge--brand' }, ['Built-in']));
      badges.push(
        p.published
          ? el('span', { class: 'badge badge--success' }, ['Published'])
          : el('span', { class: 'badge badge--warn' }, ['Draft'])
      );

      var meta = [
        el('span', { class: 'mono text-xs muted' }, ['/' + p.slug]),
        el('span', { class: 'text-xs faint' }, ['pos ' + p.position]),
      ];
      if (p.external_url) meta.push(el('span', { class: 'text-xs faint' }, ['↗ link']));

      var actions = el('div', { class: 'admin-project__actions' }, [
        // Only published projects are served publicly; a draft would 404.
        p.published
          ? el('a', { class: 'btn btn--ghost btn--sm', href: '/projects/' + p.slug, target: '_blank', rel: 'noopener' }, ['View'])
          : null,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', onClick: function () { openProjectModal(p); } }, ['Edit']),
        isPhotos ? null : el('button', {
          class: 'btn btn--ghost btn--sm btn--quiet-danger', type: 'button',
          onClick: function () { deleteProject(p); },
        }, ['Delete']),
      ]);

      var card = el('div', { class: 'admin-project' + (p.published ? '' : ' is-draft') }, [
        projectCover(p),
        el('div', { class: 'admin-project__body' }, [
          el('div', { class: 'admin-project__head' }, [
            el('h3', { class: 'admin-project__title' }, [p.title || '(untitled)']),
            el('div', { class: 'admin-project__badges' }, badges),
          ]),
          p.summary ? el('p', { class: 'admin-project__summary muted text-sm' }, [p.summary]) : null,
          el('div', { class: 'admin-project__meta' }, meta),
        ]),
        actions,
      ]);

      projectsList.appendChild(card);
    });
  }

  function deleteProject(p) {
    App.confirm('Delete “' + (p.title || 'this project') + '”? This cannot be undone.', { danger: true, confirmLabel: 'Delete' })
      .then(function (ok) {
        if (!ok) return;
        api.del('/api/admin/projects/' + p.id)
          .then(function () {
            projects = projects.filter(function (x) { return x.id !== p.id; });
            renderProjects();
            App.toast.success('Project deleted.');
          })
          .catch(function (err) { App.toast.error(err.message || 'Delete failed.'); });
      });
  }

  // --- Project add/edit modal ------------------------------------------
  function openProjectModal(project) {
    var isNew = !project;
    var p = project || {
      title: '', slug: '', summary: '', description: '',
      image_url: '', image_media_id: null, external_url: '',
      position: 0, published: true, kind: 'standard',
    };
    var isPhotos = p.kind === 'photos' || p.slug === 'photos';

    // Mutable draft for the cover media id (uploaded during editing).
    var draftMediaId = p.image_media_id != null ? Number(p.image_media_id) : null;
    var slugTouched = !isNew; // don't auto-suggest over an existing slug

    var refs = {};

    var modal = App.modal({
      title: isNew ? 'New project' : 'Edit project',
      wide: true,
      submitLabel: isNew ? 'Create' : 'Save',
      body: function (node) {
        node.appendChild(buildProjectForm());
      },
      onSubmit: function (close) {
        return submitProject(close);
      },
    });

    function buildProjectForm() {
      var wrap = el('div', { class: 'stack admin-modal' });

      // Title
      refs.title = el('input', { type: 'text', value: p.title || '', maxlength: '200', placeholder: 'Project title' });
      wrap.appendChild(field('Title', refs.title));

      // Slug (hidden for photos)
      if (!isPhotos) {
        refs.slug = el('input', { type: 'text', value: p.slug || '', maxlength: '200', placeholder: 'auto-from-title', class: 'mono' });
        refs.slug.addEventListener('input', function () { slugTouched = true; });
        refs.title.addEventListener('input', function () {
          if (!slugTouched) refs.slug.value = slugify(refs.title.value);
        });
        var slugField = field('Slug', refs.slug);
        slugField.appendChild(el('p', { class: 'help' }, ['The URL path: /projects/<slug>. Lowercase letters, numbers, and dashes.']));
        wrap.appendChild(slugField);
      }

      // Summary
      refs.summary = el('input', { type: 'text', value: p.summary || '', maxlength: '500', placeholder: 'One-line summary' });
      wrap.appendChild(field('Summary', refs.summary));

      // Description
      refs.description = el('textarea', { rows: '5', maxlength: '20000', placeholder: 'Full description (shown on the project page)' });
      refs.description.value = p.description || '';
      wrap.appendChild(field('Description', refs.description));

      // Cover image (hidden for photos; the reel manages its own images)
      if (!isPhotos) {
        wrap.appendChild(buildCoverField());

        refs.externalUrl = el('input', { type: 'url', value: p.external_url || '', maxlength: '2000', placeholder: 'https://… (optional)' });
        var extField = field('External URL', refs.externalUrl);
        extField.appendChild(el('p', { class: 'help' }, ['Optional. Links the project card straight to an external site.']));
        wrap.appendChild(extField);
      }

      // Position + published row
      refs.position = el('input', { type: 'number', value: String(p.position != null ? p.position : 0), step: '1' });
      refs.published = el('input', { type: 'checkbox' });
      refs.published.checked = p.published !== false;

      var posField = field('Position', refs.position);
      posField.classList.add('admin-modal__pos');

      var pubField = el('div', { class: 'field field--inline admin-modal__pub' }, [
        refs.published,
        el('label', { class: 'admin-inline-label' }, ['Published (visible on the public site)']),
      ]);

      wrap.appendChild(el('div', { class: 'admin-modal__row' }, [posField, pubField]));

      return wrap;
    }

    function buildCoverField() {
      var preview = el('div', { class: 'admin-media__preview admin-media__preview--sm', id: 'proj-cover-preview' });
      var clearBtn = el('button', {
        type: 'button', class: 'btn btn--ghost btn--sm',
        onClick: function () { draftMediaId = null; refs._renderCover(); },
      }, ['Remove']);
      var fileInput = el('input', { type: 'file', accept: 'image/*', hidden: 'hidden' });
      var uploadLabel = el('span', {}, ['Upload image…']);
      var uploadBtn = el('label', { class: 'btn btn--subtle btn--sm admin-upload' }, [uploadLabel, fileInput]);

      refs.imageUrl = el('input', { type: 'url', value: p.image_url || '', maxlength: '2000', placeholder: 'https://… (optional)' });
      refs.imageUrl.addEventListener('input', renderCover);

      fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        uploadLabel.textContent = 'Uploading…';
        uploadMedia(file).then(function (res) {
          draftMediaId = res.id;
          uploadLabel.textContent = 'Replace image…';
          renderCover();
          App.toast.success('Image uploaded.');
        }).catch(function (err) {
          uploadLabel.textContent = 'Upload image…';
          App.toast.error(err.message || 'Upload failed.');
        }).then(function () { fileInput.value = ''; });
      });

      refs._renderCover = function renderCoverImpl() {
        preview.innerHTML = '';
        var src = draftMediaId ? '/media/' + draftMediaId : (refs.imageUrl.value.trim() || null);
        if (src) {
          preview.appendChild(el('img', { class: 'admin-media__media', src: src, alt: 'Cover preview' }));
          clearBtn.hidden = !draftMediaId;
        } else {
          preview.appendChild(el('span', { class: 'admin-media__empty muted text-sm' }, ['No cover image']));
          clearBtn.hidden = true;
        }
      };

      function renderCover() { refs._renderCover(); }
      renderCover();

      var coverWrap = el('div', { class: 'field' }, [
        el('label', {}, ['Cover image']),
        el('div', { class: 'admin-media' }, [
          preview,
          el('div', { class: 'admin-media__actions' }, [uploadBtn, clearBtn]),
        ]),
        el('div', { class: 'admin-cover-url' }, [
          el('label', { class: 'text-xs muted' }, ['…or image URL']),
          refs.imageUrl,
        ]),
        el('p', { class: 'help' }, ['An uploaded image takes priority over the URL.']),
      ]);
      return coverWrap;
    }

    function field(labelText, control) {
      return el('div', { class: 'field' }, [
        el('label', {}, [labelText]),
        control,
      ]);
    }

    function submitProject(close) {
      var title = refs.title.value.trim();
      if (!title) {
        App.toast.error('A title is required.');
        return Promise.reject(new Error('A title is required.'));
      }

      var payload = {
        title: title,
        summary: refs.summary.value.trim(),
        description: refs.description.value.trim(),
        position: Number(refs.position.value) || 0,
        published: refs.published.checked,
      };

      if (!isPhotos) {
        payload.slug = refs.slug.value.trim();
        payload.image_url = refs.imageUrl.value.trim();
        payload.image_media_id = draftMediaId;
        payload.external_url = refs.externalUrl.value.trim();
      }

      var req = isNew
        ? api.post('/api/admin/projects', payload)
        : api.put('/api/admin/projects/' + p.id, payload);

      return req.then(function (saved) {
        upsertProject(saved);
        renderProjects();
        close();
        App.toast.success(isNew ? 'Project created.' : 'Project saved.');
      });
    }
  }

  function upsertProject(saved) {
    var idx = projects.findIndex(function (x) { return x.id === saved.id; });
    if (idx >= 0) projects[idx] = saved;
    else projects.push(saved);
    projects.sort(function (a, b) {
      if (a.position !== b.position) return a.position - b.position;
      return a.id - b.id;
    });
  }

  function wireProjects() {
    $('#project-add').addEventListener('click', function () { openProjectModal(null); });
  }

  // =====================================================================
  // Init
  // =====================================================================
  function init() {
    populateLanding();
    wireLanding();
    populateSite();
    wireSite();
    wireProjects();
    loadProjects();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
