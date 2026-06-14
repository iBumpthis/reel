/**
 * Reel — Markers.
 * Marker list, now-playing strip, active marker tracking,
 * fullscreen toast, inline editing, click-to-seek.
 */
import { fmtTime, escHtml, toast } from '../shared/utils.js';
import * as api from '../shared/api.js';

let state, els;
let lastActiveIdx = -1;
let fsToastTimer = null;

const elMarkersList = document.getElementById('markersList');
const elNowPlaying = document.getElementById('nowPlaying');
const elNpPrev = document.getElementById('npPrev');
const elNpCurrent = document.getElementById('npCurrent');
const elNpNext = document.getElementById('npNext');
const elFsToast = document.getElementById('fsToast');

// ============================================================
// Render marker list
// ============================================================
function renderMarkers() {
  elMarkersList.innerHTML = '';

  if (state.markers.length === 0) {
    elMarkersList.innerHTML = '<div class="markers-empty">No markers</div>';
    elNowPlaying.classList.add('hidden');
    return;
  }

  for (let i = 0; i < state.markers.length; i++) {
    const mk = state.markers[i];
    const row = document.createElement('div');
    row.className = 'marker-row';
    row.dataset.index = i;

    row.innerHTML = `
      <span class="marker-time">${fmtTime(mk.startSeconds)}</span>
      <span class="marker-label">${escHtml(mk.label)}</span>
      <span class="marker-edit-actions">
        <button class="marker-edit-btn" data-action="edit" title="Edit label">✎</button>
        <button class="marker-edit-btn danger" data-action="delete" title="Delete">×</button>
      </span>`;

    // Click row → seek to marker
    row.addEventListener('click', (e) => {
      // Don't seek if clicking edit buttons or inline edit inputs
      if (e.target.closest('.marker-edit-actions')) return;
      if (e.target.tagName === 'INPUT') return;
      els.player.currentTime = mk.startSeconds;
      els.player.play();
    });

    // Edit button
    row.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineEdit(i, row);
    });

    // Delete button
    row.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMarker(i);
    });

    elMarkersList.appendChild(row);
  }

  // Set initial now-playing state
  lastActiveIdx = -1;
  if (state.markers.length > 0) {
    if (state.markers[0].startSeconds === 0 && els.player.currentTime >= 0) {
      updateNowPlaying(getActiveMarkerIdx(els.player.currentTime));
    } else {
      renderPreparedState();
    }
  }
}

// ============================================================
// Inline marker editing (label + timestamp)
// ============================================================
function startInlineEdit(idx, row) {
  const mk = state.markers[idx];
  const originalLabel = mk.label;
  const originalStart = mk.startSeconds;

  // Replace the row content with edit fields
  const timeEl = row.querySelector('.marker-time');
  const labelEl = row.querySelector('.marker-label');
  const actionsEl = row.querySelector('.marker-edit-actions');

  // Time input
  const timeInput = document.createElement('input');
  timeInput.type = 'text';
  timeInput.className = 'marker-time-input';
  timeInput.value = fmtTime(originalStart);
  timeInput.title = 'Timestamp (M:SS or H:MM:SS)';
  timeEl.replaceWith(timeInput);

  // Label input
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'marker-label-input';
  labelInput.value = originalLabel;
  labelEl.replaceWith(labelInput);

  // Replace action buttons with save/cancel
  actionsEl.innerHTML = `
    <button class="marker-edit-btn save" data-action="save" title="Save (Enter)">✓</button>
    <button class="marker-edit-btn" data-action="cancel" title="Cancel (Esc)">✕</button>`;
  actionsEl.style.opacity = '1';

  labelInput.focus();
  labelInput.select();

  async function save() {
    const newLabel = labelInput.value.trim();
    const newTimeStr = timeInput.value.trim();

    if (!newLabel) { cancel(); return; }

    // Parse the time input
    const newStart = parseTimeInput(newTimeStr);
    if (newStart === null) {
      timeInput.classList.add('input-error');
      toast('Invalid time format (use M:SS or H:MM:SS)', 'error');
      timeInput.focus();
      return;
    }

    const labelChanged = newLabel !== originalLabel;
    const timeChanged = newStart !== originalStart;

    if (!labelChanged && !timeChanged) { cancel(); return; }

    // Build patch body
    const patch = {};
    if (labelChanged) patch.label = newLabel;
    if (timeChanged) patch.startSeconds = newStart;

    try {
      await api.patchMarker(state.mediaId, mk.id, patch);

      mk.label = newLabel;
      mk.startSeconds = newStart;

      // If time changed, re-sort markers and re-render full list
      if (timeChanged) {
        state.markers.sort((a, b) => a.startSeconds - b.startSeconds);
        renderMarkers();
      } else {
        restoreRow(row, idx);
      }
      toast('Marker updated', 'success');
    } catch (err) {
      cancel();
      toast(`Save failed: ${err.message}`, 'error');
    }
  }

  function cancel() {
    restoreRow(row, idx);
  }

  function restoreRow(row, idx) {
    const mk = state.markers[idx];
    const timeSpan = document.createElement('span');
    timeSpan.className = 'marker-time';
    timeSpan.textContent = fmtTime(mk.startSeconds);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'marker-label';
    labelSpan.textContent = mk.label;

    const currentTime = row.querySelector('.marker-time-input');
    const currentLabel = row.querySelector('.marker-label-input');
    if (currentTime) currentTime.replaceWith(timeSpan);
    if (currentLabel) currentLabel.replaceWith(labelSpan);

    actionsEl.innerHTML = `
      <button class="marker-edit-btn" data-action="edit" title="Edit label">✎</button>
      <button class="marker-edit-btn danger" data-action="delete" title="Delete">×</button>`;
    actionsEl.style.opacity = '';

    // Re-bind edit/delete handlers
    actionsEl.querySelector('[data-action="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineEdit(idx, row);
    });
    actionsEl.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMarker(idx);
    });
  }

  // Keyboard handlers on both inputs
  [timeInput, labelInput].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  });

  // Save/cancel button handlers
  actionsEl.querySelector('[data-action="save"]').addEventListener('click', (e) => {
    e.stopPropagation();
    save();
  });
  actionsEl.querySelector('[data-action="cancel"]').addEventListener('click', (e) => {
    e.stopPropagation();
    cancel();
  });
}

/**
 * Parse a time string input (M:SS or H:MM:SS) into seconds.
 * Returns null if invalid.
 */
function parseTimeInput(str) {
  const parts = str.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;

  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (h < 0 || m < 0 || m > 59 || s < 0 || s > 59) return null;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    if (m < 0 || s < 0 || s > 59) return null;
    return m * 60 + s;
  }
  return null;
}

// ============================================================
// Delete marker
// ============================================================
async function deleteMarker(idx) {
  const removed = state.markers.splice(idx, 1);

  if (state.markers.length === 0) {
    // Clear all markers on backend
    try {
      await api.clearMarkers(state.mediaId);
      renderMarkers();
      toast('Marker deleted', 'success');
    } catch (err) {
      // Restore
      state.markers.splice(idx, 0, ...removed);
      renderMarkers();
      toast(`Delete failed: ${err.message}`, 'error');
    }
    return;
  }

  try {
    await api.setMarkers(state.mediaId, {
      markers: state.markers.map((m, i) => ({
        startSeconds: m.startSeconds,
        endSeconds: m.endSeconds,
        label: m.label,
        sortOrder: i,
      })),
    });

    // Reload markers from server to get fresh IDs —
    // replace-all POST re-inserts rows, invalidating old IDs.
    // Without this, a PATCH after delete would target a stale ID.
    await reloadMarkers();
    toast('Marker deleted', 'success');
  } catch (err) {
    state.markers.splice(idx, 0, ...removed);
    renderMarkers();
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

/**
 * Reload markers from server into state and re-render.
 * Called after operations that invalidate marker IDs (delete, import).
 */
async function reloadMarkers() {
  const media = await api.getMedia(state.mediaId);
  state.markers = media.markers || [];
  renderMarkers();
}

// ============================================================
// Active marker tracking
// ============================================================
function getActiveMarkerIdx(currentTime) {
  if (!state.markers.length) return -1;
  let idx = -1;
  for (let i = 0; i < state.markers.length; i++) {
    if (state.markers[i].startSeconds <= currentTime) idx = i;
    else break;
  }
  return idx;
}

function onTimeUpdate() {
  const idx = getActiveMarkerIdx(els.player.currentTime);
  updateNowPlaying(idx);
}

// ============================================================
// Now playing strip
// ============================================================

// The current pill is a flex box with a fixed two-line height; the
// label goes in an inner .np-label span that carries the line clamp.
// Writing textContent directly on the pill would blow the span away.
function setNpCurrentLabel(text) {
  let span = elNpCurrent.querySelector('.np-label');
  if (!span) {
    elNpCurrent.textContent = '';
    span = document.createElement('span');
    span.className = 'np-label';
    elNpCurrent.appendChild(span);
  }
  span.textContent = text;
}

function renderPreparedState() {
  elNowPlaying.classList.remove('hidden');
  elNpPrev.style.visibility = 'hidden';
  elNpPrev.textContent = '';
  elNpPrev.onclick = null;

  const first = state.markers[0];
  elNpCurrent.classList.add('np-current', 'prepared');
  elNpCurrent.classList.remove('np-adjacent');
  setNpCurrentLabel(`${fmtTime(first.startSeconds)} ${first.label}`);
  elNpCurrent.onclick = () => { els.player.currentTime = first.startSeconds; els.player.play(); };

  const next = state.markers.length > 1 ? state.markers[1] : null;
  elNpNext.textContent = next ? `${fmtTime(next.startSeconds)} ${next.label}` : '';
  elNpNext.style.visibility = next ? 'visible' : 'hidden';
  elNpNext.onclick = next ? () => { els.player.currentTime = next.startSeconds; els.player.play(); } : null;
}

function updateNowPlaying(idx) {
  if (idx === lastActiveIdx) return;
  lastActiveIdx = idx;

  // Highlight active marker in list
  const rows = elMarkersList.querySelectorAll('.marker-row');
  rows.forEach((el, i) => el.classList.toggle('active', i === idx));

  if (idx === -1) {
    if (state.markers.length > 0) {
      renderPreparedState();
    } else {
      elNowPlaying.classList.add('hidden');
    }
    return;
  }

  elNowPlaying.classList.remove('hidden');
  elNpCurrent.classList.add('np-current');
  elNpCurrent.classList.remove('np-adjacent', 'prepared');

  const prev = idx > 0 ? state.markers[idx - 1] : null;
  const current = state.markers[idx];
  const next = idx < state.markers.length - 1 ? state.markers[idx + 1] : null;

  elNpPrev.textContent = prev ? `${fmtTime(prev.startSeconds)} ${prev.label}` : '';
  elNpPrev.style.visibility = prev ? 'visible' : 'hidden';
  elNpPrev.onclick = prev ? () => { els.player.currentTime = prev.startSeconds; els.player.play(); } : null;

  setNpCurrentLabel(`${fmtTime(current.startSeconds)} ${current.label}`);
  elNpCurrent.onclick = () => { els.player.currentTime = current.startSeconds; els.player.play(); };

  elNpNext.textContent = next ? `${fmtTime(next.startSeconds)} ${next.label}` : '';
  elNpNext.style.visibility = next ? 'visible' : 'hidden';
  elNpNext.onclick = next ? () => { els.player.currentTime = next.startSeconds; els.player.play(); } : null;

  // Fullscreen toast
  showFsToast(current);
}

// ============================================================
// Fullscreen marker toast
// ============================================================
function showFsToast(marker) {
  if (!document.fullscreenElement) return;
  if (!state.markers || state.markers.length === 0) return;

  const label = marker.label || fmtTime(marker.startSeconds);
  elFsToast.textContent = label;
  elFsToast.classList.remove('hidden');

  if (fsToastTimer) clearTimeout(fsToastTimer);
  fsToastTimer = setTimeout(() => {
    elFsToast.classList.add('hidden');
    fsToastTimer = null;
  }, 4500);
}

// ============================================================
// Init / cleanup
// ============================================================
export function initMarkers(_state, _els) {
  state = _state;
  els = _els;

  renderMarkers();

  // Remove any previous listener before adding (handles re-init after import)
  els.player.removeEventListener('timeupdate', onTimeUpdate);
  els.player.addEventListener('timeupdate', onTimeUpdate);
}

export function cleanupMarkers() {
  if (fsToastTimer) clearTimeout(fsToastTimer);
}
