/* =========================================================================
   Photos — Instagram-style reel + admin upload / manage.
   Public read; admin controls appear when the viewer is authenticated.
   ========================================================================= */
(function () {
  'use strict';

  const App = window.App;
  const { el, api, toast } = App;

  const data = App.readData('photos-data') || {};
  const isAuthed = Boolean(data.isAuthed);
  const project = data.project || {};
  const slug = project.slug || 'photos';

  const gridEl = App.$('#photos-grid');
  const statusEl = App.$('#photos-status');
  const uploadBtn = App.$('#photos-upload-btn');

  // Current feed, kept in memory so the lightbox can navigate without refetching.
  let photos = [];

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------
  async function load() {
    try {
      photos = await api.get('/api/photos?project=' + encodeURIComponent(slug));
      render();
    } catch (err) {
      statusEl.hidden = false;
      gridEl.hidden = true;
      statusEl.textContent = err.message || 'Could not load photos.';
    }
  }

  // ---------------------------------------------------------------------
  // Grid rendering
  // ---------------------------------------------------------------------
  function render() {
    gridEl.textContent = '';

    if (!photos.length) {
      statusEl.hidden = false;
      gridEl.hidden = true;
      statusEl.textContent = isAuthed
        ? 'No photos yet. Use “Upload photos” to add your first one.'
        : 'No photos have been posted yet.';
      return;
    }

    statusEl.hidden = true;
    gridEl.hidden = false;

    photos.forEach((photo, index) => {
      gridEl.appendChild(buildTile(photo, index));
    });
  }

  function buildTile(photo, index) {
    const img = el('img', {
      class: 'photo-tile__img',
      src: photo.url,
      alt: photo.caption || 'Photo',
      loading: 'lazy',
      decoding: 'async',
    });

    // The clickable image area is the button; admin controls sit beside it in
    // the wrapper so we never nest interactive elements inside a <button>.
    const openBtn = el(
      'button',
      {
        type: 'button',
        class: 'photo-tile__open',
        'aria-label': photo.caption ? 'View photo: ' + photo.caption : 'View photo',
        onClick: () => openLightbox(index),
      },
      [img]
    );

    const tile = el('div', { class: 'photo-tile' }, [openBtn]);

    if (photo.caption) {
      tile.appendChild(el('span', { class: 'photo-tile__caption', text: photo.caption }));
    }

    if (isAuthed) {
      const del = el(
        'button',
        {
          type: 'button',
          class: 'photo-tile__del',
          title: 'Delete photo',
          'aria-label': 'Delete photo',
          onClick: (e) => {
            e.stopPropagation();
            deletePhoto(photo);
          },
        },
        ['×']
      );
      tile.appendChild(del);
    }

    return tile;
  }

  // ---------------------------------------------------------------------
  // Lightbox
  // ---------------------------------------------------------------------
  let lightbox = null; // { backdrop, imgEl, captionEl, index }

  function openLightbox(index) {
    if (!photos.length) return;
    if (lightbox) closeLightbox();

    const imgEl = el('img', { class: 'lightbox__img', alt: '' });
    const captionEl = el('div', { class: 'lightbox__caption' });

    const closeBtn = el(
      'button',
      { type: 'button', class: 'lightbox__close', 'aria-label': 'Close', onClick: closeLightbox },
      ['×']
    );
    const prevBtn = el(
      'button',
      { type: 'button', class: 'lightbox__nav lightbox__nav--prev', 'aria-label': 'Previous', onClick: (e) => { e.stopPropagation(); step(-1); } },
      ['‹']
    );
    const nextBtn = el(
      'button',
      { type: 'button', class: 'lightbox__nav lightbox__nav--next', 'aria-label': 'Next', onClick: (e) => { e.stopPropagation(); step(1); } },
      ['›']
    );

    const stage = el('div', { class: 'lightbox__stage' }, [imgEl]);
    const figure = el('figure', { class: 'lightbox__figure' }, [stage, captionEl]);

    const adminBar = el('div', { class: 'lightbox__admin' });
    if (isAuthed) {
      adminBar.appendChild(
        el('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: (e) => { e.stopPropagation(); editCaptionFromLightbox(); } }, ['Edit caption'])
      );
      adminBar.appendChild(
        el('button', { type: 'button', class: 'btn btn--danger btn--sm', onClick: (e) => { e.stopPropagation(); deleteFromLightbox(); } }, ['Delete'])
      );
    }

    const inner = el('div', { class: 'lightbox__inner', onClick: (e) => e.stopPropagation() }, [
      closeBtn,
      prevBtn,
      nextBtn,
      figure,
      adminBar,
    ]);

    const backdrop = el(
      'div',
      { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo viewer', onClick: closeLightbox },
      [inner]
    );

    lightbox = { backdrop, imgEl, captionEl, prevBtn, nextBtn, index: -1 };

    document.body.appendChild(backdrop);
    document.body.classList.add('photos-lightbox-open');
    document.addEventListener('keydown', onLightboxKey);
    setupSwipe(stage);

    showAt(index);
    // Focus the close button so keyboard users can act immediately.
    closeBtn.focus();
  }

  function showAt(index) {
    if (!lightbox) return;
    const total = photos.length;
    if (!total) { closeLightbox(); return; }
    // Clamp into range (feed may have shrunk after a delete).
    const i = Math.max(0, Math.min(index, total - 1));
    const photo = photos[i];
    lightbox.index = i;
    lightbox.imgEl.src = photo.url;
    lightbox.imgEl.alt = photo.caption || 'Photo';
    lightbox.captionEl.textContent = photo.caption || '';
    lightbox.captionEl.hidden = !photo.caption;

    const single = total <= 1;
    lightbox.prevBtn.hidden = single;
    lightbox.nextBtn.hidden = single;
  }

  function step(delta) {
    if (!lightbox || photos.length <= 1) return;
    const total = photos.length;
    const next = (lightbox.index + delta + total) % total;
    showAt(next);
  }

  function closeLightbox() {
    if (!lightbox) return;
    document.removeEventListener('keydown', onLightboxKey);
    lightbox.backdrop.remove();
    document.body.classList.remove('photos-lightbox-open');
    lightbox = null;
  }

  function onLightboxKey(e) {
    if (!lightbox) return;
    if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  }

  // Basic touch swipe for the feed feel on mobile.
  function setupSwipe(node) {
    let startX = 0;
    let active = false;
    node.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      active = true;
      startX = e.touches[0].clientX;
    }, { passive: true });
    node.addEventListener('touchend', (e) => {
      if (!active) return;
      active = false;
      const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : startX) - startX;
      if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function currentPhoto() {
    return lightbox ? photos[lightbox.index] : null;
  }

  function editCaptionFromLightbox() {
    const photo = currentPhoto();
    if (photo) editCaption(photo);
  }

  function deleteFromLightbox() {
    const photo = currentPhoto();
    if (photo) deletePhoto(photo);
  }

  // ---------------------------------------------------------------------
  // Admin: upload
  // ---------------------------------------------------------------------
  function openUploadModal() {
    let fileInput;
    let captionInput;

    App.modal({
      title: 'Upload photos',
      body: (node) => {
        const fileField = el('label', { class: 'field' }, [
          el('span', { text: 'Images' }),
        ]);
        fileInput = el('input', {
          type: 'file',
          accept: 'image/*',
          multiple: true,
        });
        fileField.appendChild(fileInput);
        fileField.appendChild(
          el('span', { class: 'help', text: 'Select one or more images (JPEG, PNG, GIF, WebP). Max 12MB each.' })
        );

        const captionField = el('label', { class: 'field' }, [
          el('span', { text: 'Caption (optional)' }),
        ]);
        captionInput = el('input', {
          type: 'text',
          placeholder: 'A caption applied to all selected photos',
          maxlength: '500',
        });
        captionField.appendChild(captionInput);

        node.appendChild(fileField);
        node.appendChild(captionField);
      },
      submitLabel: 'Upload',
      onSubmit: async (close) => {
        const files = fileInput.files;
        if (!files || files.length === 0) {
          // The modal wrapper toasts thrown errors, so surface it there.
          throw new Error('Choose at least one image.');
        }

        const form = new FormData();
        for (const file of files) form.append('photos', file);
        form.append('project', slug);
        const caption = captionInput.value.trim();
        if (caption) form.append('caption', caption);

        const created = await api.upload('/api/photos', form);
        // Prepend newest first to match the feed ordering.
        const list = Array.isArray(created) ? created : [];
        photos = list.concat(photos);
        render();
        close();
        toast.success(
          list.length === 1 ? 'Photo uploaded.' : list.length + ' photos uploaded.'
        );
      },
    });
  }

  // ---------------------------------------------------------------------
  // Admin: edit caption
  // ---------------------------------------------------------------------
  function editCaption(photo) {
    let input;
    App.modal({
      title: 'Edit caption',
      body: (node) => {
        const field = el('label', { class: 'field' }, [el('span', { text: 'Caption' })]);
        input = el('textarea', { rows: '3', maxlength: '500', placeholder: 'Write a caption…' });
        input.value = photo.caption || '';
        field.appendChild(input);
        node.appendChild(field);
      },
      submitLabel: 'Save',
      onSubmit: async (close) => {
        const updated = await api.put('/api/photos/' + photo.id, { caption: input.value.trim() });
        applyUpdate(updated);
        close();
        toast.success('Caption saved.');
      },
    });
  }

  function applyUpdate(updated) {
    if (!updated || !updated.id) return;
    const idx = photos.findIndex((p) => p.id === updated.id);
    if (idx !== -1) {
      photos[idx] = updated;
      render();
      if (lightbox) showAt(lightbox.index);
    }
  }

  // ---------------------------------------------------------------------
  // Admin: delete
  // ---------------------------------------------------------------------
  async function deletePhoto(photo) {
    const ok = await App.confirm('Delete this photo? This cannot be undone.', {
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;

    try {
      await api.del('/api/photos/' + photo.id);
    } catch (err) {
      toast.error(err.message || 'Delete failed.');
      return;
    }

    const wasIndex = photos.findIndex((p) => p.id === photo.id);
    photos = photos.filter((p) => p.id !== photo.id);
    render();

    if (lightbox) {
      if (!photos.length) closeLightbox();
      else showAt(Math.min(wasIndex, photos.length - 1));
    }
    toast.success('Photo deleted.');
  }

  // ---------------------------------------------------------------------
  // Wire up
  // ---------------------------------------------------------------------
  if (uploadBtn) uploadBtn.addEventListener('click', openUploadModal);

  load();
})();
