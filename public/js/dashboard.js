(function () {
  'use strict';

  // ─── DOM ────────────────────────────────────────────
  const uploadForm = document.getElementById('upload-form');
  const dropzone = document.getElementById('dropzone');
  const uploadInput = document.getElementById('upload-input');
  const fileNameEl = document.getElementById('file-name');
  const titleInput = document.getElementById('title-input');
  const sessionInput = document.getElementById('session-input');
  const uploadBtn = document.getElementById('upload-btn');
  const uploadCancel = document.getElementById('upload-cancel');
  const uploadProgress = document.getElementById('upload-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const uploadMessage = document.getElementById('upload-message');

  const videoGrid = document.getElementById('video-grid');
  const listEmpty = document.getElementById('list-empty');
  const listLoading = document.getElementById('list-loading');
  const videoCount = document.getElementById('video-count');
  const refreshBtn = document.getElementById('refresh-btn');

  const modal = document.getElementById('modal');
  const modalVideo = document.getElementById('modal-video');
  const modalTitle = document.getElementById('modal-title');

  const toastEl = document.getElementById('toast');

  // ─── State ──────────────────────────────────────────
  const state = {
    videos: [],
    selectedFile: null,
    uploading: false,
    xhr: null,
  };

  // ─── Boot ───────────────────────────────────────────
  init();

  function init() {
    wireDropzone();
    wireForm();
    wireModal();
    wireRefresh();
    loadVideos();
  }

  // ─── Dropzone ───────────────────────────────────────
  function wireDropzone() {
    // Click → open file picker
    dropzone.addEventListener('click', (e) => {
      if (e.target.tagName !== 'INPUT') uploadInput.click();
    });

    dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        uploadInput.click();
      }
    });

    uploadInput.addEventListener('change', () => {
      if (uploadInput.files[0]) setFile(uploadInput.files[0]);
    });

    ['dragenter', 'dragover'].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.add('is-dragover');
      })
    );

    ['dragleave', 'drop'].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragover');
      })
    );

    dropzone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file) setFile(file);
    });
  }

  function setFile(file) {
    if (!file.type.startsWith('video/')) {
      showUploadMessage('Only video files are allowed.', false);
      return;
    }
    if (file.size > 200 * 1024 * 1024) {
      showUploadMessage('File is larger than 200 MB.', false);
      return;
    }
    state.selectedFile = file;
    fileNameEl.textContent = `${file.name} (${formatBytes(file.size)})`;
    fileNameEl.hidden = false;
    if (!titleInput.value) {
      titleInput.value = file.name.replace(/\.[^.]+$/, '');
    }
    hideUploadMessage();
  }

  // ─── Form ───────────────────────────────────────────
  function wireForm() {
    uploadForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.uploading) return;
      startUpload();
    });

    uploadCancel.addEventListener('click', () => {
      if (state.xhr) state.xhr.abort();
    });
  }

  function startUpload() {
    if (!state.selectedFile) {
      showUploadMessage('Choose a video file first.', false);
      return;
    }
    const title = titleInput.value.trim();
    if (!title) {
      showUploadMessage('Title is required.', false);
      titleInput.focus();
      return;
    }

    const sessionCode = sessionInput.value.trim();
    if (sessionCode && !/^\d{6}$/.test(sessionCode)) {
      showUploadMessage('Session code must be 6 digits.', false);
      return;
    }

    const fd = new FormData();
    fd.append('video', state.selectedFile);
    fd.append('title', title);

    const xhr = new XMLHttpRequest();
    state.xhr = xhr;
    state.uploading = true;

    uploadBtn.disabled = true;
    uploadCancel.hidden = false;
    uploadProgress.hidden = false;
    hideUploadMessage();
    setProgress(0);

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      setProgress(pct);
    });

    xhr.addEventListener('load', async () => {
      state.uploading = false;
      state.xhr = null;
      uploadBtn.disabled = false;
      uploadCancel.hidden = true;

      let res;
      try {
        res = JSON.parse(xhr.responseText);
      } catch {
        res = { ok: false, message: 'Server returned invalid response.' };
      }

      if (xhr.status >= 200 && xhr.status < 300 && res.ok) {
        showUploadMessage(`Uploaded “${res.video.title}” ✓`, true);
        resetForm();
        await loadVideos();

        // If a session code was provided, mark it as active
        if (sessionCode) {
          try {
            await fetch(`/api/videos/${res.video.id}/active`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: sessionCode }),
            });
            showToast(`Sent to session #${sessionCode}`, 'success');
          } catch (err) {
            console.warn('[dashboard] setActive failed:', err);
            showToast('Uploaded, but could not set as active.', 'error');
          }
        }
      } else {
        showUploadMessage(res.message || 'Upload failed.', false);
      }

      setTimeout(() => (uploadProgress.hidden = true), 800);
    });

    xhr.addEventListener('error', () => {
      state.uploading = false;
      state.xhr = null;
      uploadBtn.disabled = false;
      uploadCancel.hidden = true;
      uploadProgress.hidden = true;
      showUploadMessage('Network error while uploading.', false);
    });

    xhr.addEventListener('abort', () => {
      state.uploading = false;
      state.xhr = null;
      uploadBtn.disabled = false;
      uploadCancel.hidden = true;
      uploadProgress.hidden = true;
      showUploadMessage('Upload cancelled.', false);
    });

    xhr.open('POST', '/api/videos');
    xhr.send(fd);
  }

  function setProgress(pct) {
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `Uploading… ${pct}%`;
  }

  function resetForm() {
    uploadForm.reset();
    state.selectedFile = null;
    fileNameEl.hidden = true;
    fileNameEl.textContent = '';
  }

  function showUploadMessage(text, ok) {
    uploadMessage.textContent = text;
    uploadMessage.className = ok ? 'form-message is-success' : 'form-message';
    uploadMessage.hidden = false;
  }

  function hideUploadMessage() {
    uploadMessage.hidden = true;
  }

  // ─── Load videos ────────────────────────────────────
  async function loadVideos() {
    listLoading.hidden = false;
    listEmpty.hidden = true;
    videoGrid.hidden = true;

    try {
      const res = await fetch('/api/videos');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed');

      state.videos = data.videos || [];
      renderList();
    } catch (err) {
      console.error('[dashboard] loadVideos failed:', err);
      listEmpty.hidden = false;
      listEmpty.innerHTML =
        '<div class="empty-icon" aria-hidden="true">⚠</div>' +
        '<p>Could not load videos. Is Firebase configured?</p>';
    } finally {
      listLoading.hidden = true;
    }
  }

  function renderList() {
    videoCount.textContent = String(state.videos.length);

    if (state.videos.length === 0) {
      videoGrid.hidden = true;
      listEmpty.hidden = false;
      return;
    }

    listEmpty.hidden = true;
    videoGrid.hidden = false;
    videoGrid.innerHTML = '';

    for (const v of state.videos) {
      videoGrid.appendChild(renderCard(v));
    }
  }

  function renderCard(v) {
    const li = document.createElement('li');
    li.className = 'video-card';
    li.dataset.id = v.id;

    const thumbUrl = v.thumbnailUrl || '';
    const thumb = thumbUrl
      ? `<img src="${escapeAttr(thumbUrl)}" alt="" loading="lazy" />`
      : '<div class="video-thumb-placeholder">🎬</div>';

    const duration = v.duration ? formatDuration(v.duration) : '';

    li.innerHTML = `
      <div class="video-thumb">
        ${thumb}
        ${duration ? `<span class="video-duration">${duration}</span>` : ''}
      </div>
      <div class="video-body">
        <h3 class="video-title" title="${escapeAttr(v.title)}">${escapeHtml(v.title)}</h3>
        <p class="video-meta">${formatBytes(v.bytes || 0)}</p>
        <div class="video-actions">
          <button class="btn" data-action="preview">Preview</button>
          <button class="btn btn--danger" data-action="delete">Delete</button>
        </div>
      </div>
    `;

    li.querySelector('[data-action="preview"]').addEventListener('click', () => {
      openPreview(v);
    });
    li.querySelector('[data-action="delete"]').addEventListener('click', () => {
      confirmDelete(v);
    });

    return li;
  }

  // ─── Preview modal ──────────────────────────────────
  function openPreview(v) {
    modalTitle.textContent = v.title;
    modalVideo.src = v.url;
    modal.hidden = false;
    modalVideo.play().catch(() => {});
  }

  function wireModal() {
    modal.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', closeModal);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeModal();
    });
  }

  function closeModal() {
    modalVideo.pause();
    modalVideo.removeAttribute('src');
    modalVideo.load();
    modal.hidden = true;
  }

  // ─── Delete ─────────────────────────────────────────
  async function confirmDelete(v) {
    const ok = window.confirm(`Delete “${v.title}”? This cannot be undone.`);
    if (!ok) return;

    try {
      const res = await fetch(`/api/videos/${v.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed');

      showToast('Video deleted.', 'success');
      await loadVideos();
    } catch (err) {
      console.error('[dashboard] delete failed:', err);
      showToast('Could not delete video.', 'error');
    }
  }

  // ─── Refresh ────────────────────────────────────────
  function wireRefresh() {
    refreshBtn.addEventListener('click', loadVideos);
  }

  // ─── Toast ──────────────────────────────────────────
  let toastTimer = null;
  function showToast(text, kind = 'success') {
    toastEl.textContent = text;
    toastEl.className = `toast is-${kind}`;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
  }

  // ─── Helpers ────────────────────────────────────────
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }
})();