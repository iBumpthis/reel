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
      // Don't seek if clicking edit buttons
      if (e.target.closest('.marker-edit-actions')) return;
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
// Inline label editing
// ============================================================
function startInlineEdit(idx, row) {
  const mk = state.markers[idx];
  const labelEl = row.querySelector('.marker-label');
  const original = mk.label;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'marker-label-input';
  input.value = original;

  labelEl.replaceWith(input);
  input.focus();
  input.select();

  async function save() {
    const newLabel = input.value.trim();
    if (!newLabel || newLabel === original) {
      cancel();
      return;
    }

    mk.label = newLabel;
    // Replace all markers on backend
    try {
      await api.setMarkers(state.mediaId, {
        markers: state.markers.map((m, i) => ({
          startSeconds: m.startSeconds,
          endSeconds: m.endSeconds,
          label: m.label,
          sortOrder: i,
        })),
      });

      const span = document.createElement('span');
      span.className = 'marker-label';
      span.textContent = newLabel;
      input.replaceWith(span);
      toast('Marker updated', 'success');
    } catch (err) {
      mk.label = original;
      cancel();
      toast(`Save failed: ${err.message}`, 'error');
    }
  }

  function cancel() {
    const span = document.createElement('span');
    span.className = 'marker-label';
    span.textContent = original;
    input.replaceWith(span);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  input.addEventListener('blur', () => {
    // Small delay to let keydown fire first
    setTimeout(() => {
      if (document.contains(input)) save();
    }, 50);
  });
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
    renderMarkers();
    toast('Marker deleted', 'success');
  } catch (err) {
    state.markers.splice(idx, 0, ...removed);
    renderMarkers();
    toast(`Delete failed: ${err.message}`, 'error');
  }
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
