/**
 * Reel — Player page orchestrator.
 * Loads media, initializes modules, handles global keyboard shortcuts.
 */
import * as api from '../shared/api.js';
import { toast } from '../shared/utils.js';
import { initControls, cleanupControls } from './controls.js';
import { cleanupVisualizer } from './visualizer.js';
import { initModes } from './modes.js';
import { initMarkers, cleanupMarkers } from './markers.js';
import { initBrowse } from './browse.js';

// ============================================================
// Shared state — modules get a reference to this
// ============================================================
export const state = {
  mediaId: null,
  media: null,
  markers: [],
  currentMode: 'video',
  currentTheme: 'rgb',
  vizStyle: 'bars',
  fileExt: '',
};

// DOM refs used across modules
export const els = {
  player: document.getElementById('player'),
  playbackFrame: document.getElementById('playbackFrame'),
  vizCanvas: document.getElementById('vizCanvas'),
  playerTitle: document.getElementById('playerTitle'),
  playerSub: document.getElementById('playerSub'),
  toastContainer: document.getElementById('toastContainer'),
};

// ============================================================
// Version
// ============================================================
api.getHealth().then(d => {
  document.getElementById('appVersion').textContent = `v${d.version ?? ''}`;
}).catch(() => {});

// ============================================================
// Load media + init
// ============================================================
const id = new URLSearchParams(location.search).get('id');
state.mediaId = id;

async function load() {
  if (!id) {
    els.playerTitle.textContent = 'No media selected';
    return;
  }

  try {
    const media = await api.getMedia(id);
    state.media = media;
    state.fileExt = (media.ext || '').toLowerCase();
    state.markers = media.markers || [];

    // Title display
    const display = media.title || media.filename;
    els.playerTitle.textContent = media.artist
      ? `${media.artist} — ${display}`
      : display;
    const parts = [media.year, media.libraryName, media.ext.toUpperCase()].filter(Boolean);
    els.playerSub.textContent = parts.join(' · ');

    // Set document title
    document.title = `Reel — ${media.artist ? `${media.artist} — ` : ''}${display}`;

    // Set source
    els.player.src = media.streamUrl;

    // Codec error detection
    els.player.addEventListener('error', () => {
      const err = els.player.error;
      if (!err) return;
      const messages = {
        1: 'Playback aborted',
        2: 'Network error — file may be inaccessible',
        3: 'Decode error — codec may not be supported by this browser',
        4: 'Format not supported — browser cannot play this file type',
      };
      const msg = messages[err.code] || `Playback error (code ${err.code})`;
      const detail = err.message ? `${msg}: ${err.message}` : msg;
      toast(detail, 'error');
      console.error('[reel] Media error:', err.code, err.message);
    });

    // Description
    syncDescription(media.description);

    // Default mode
    const defaultMode = media.defaultPlaybackMode || 'video';

    // Init modules
    initControls(state, els);
    initModes(state, els, defaultMode);
    initMarkers(state, els);
    initBrowse(state, els);
    initDescription();
    initExportMarkers();
    initImport();

  } catch (err) {
    els.playerTitle.textContent = 'Not found';
    console.error('[reel] Load failed:', err);
  }
}

// ============================================================
// Description overlay
// ============================================================
const elDescDisplay = document.getElementById('descDisplay');
const elDescContent = document.getElementById('descContent');
const elDescOverlay = document.getElementById('descOverlay');
const elDescText = document.getElementById('descText');
const elDescStatus = document.getElementById('descStatus');

function syncDescription(text) {
  const trimmed = (text || '').trim();
  if (trimmed) {
    elDescContent.textContent = trimmed;
    elDescDisplay.classList.remove('hidden');
  } else {
    elDescDisplay.classList.add('hidden');
  }
}

function initDescription() {
  document.getElementById('openDescOverlay').addEventListener('click', () => {
    elDescText.value = state.media?.description ?? '';
    elDescOverlay.classList.remove('hidden');
    elDescText.focus();
  });

  document.getElementById('descSave').addEventListener('click', async () => {
    elDescStatus.textContent = 'Saving…';
    try {
      await api.updateMedia(state.mediaId, { description: elDescText.value });
      state.media.description = elDescText.value;
      syncDescription(elDescText.value);
      elDescStatus.textContent = '';
      elDescOverlay.classList.add('hidden');
      toast('Saved', 'success');
    } catch (err) {
      elDescStatus.textContent = `Error: ${err.message}`;
    }
  });
}

// ============================================================
// Export markers
// ============================================================
function initExportMarkers() {
  document.getElementById('exportMarkers').addEventListener('click', async () => {
    if (!state.markers || state.markers.length === 0) {
      toast('No markers to export', 'error');
      return;
    }

    try {
      const text = await api.exportMarkers(state.mediaId);
      // Copy to clipboard
      await navigator.clipboard.writeText(text);
      toast(`${state.markers.length} marker${state.markers.length !== 1 ? 's' : ''} copied to clipboard`, 'success');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'error');
    }
  });
}

// ============================================================
// Import markers overlay
// ============================================================
const elImportOverlay = document.getElementById('importOverlay');
const elImportText = document.getElementById('importText');
const elImportStatus = document.getElementById('importStatus');
const elImportBtn = document.getElementById('importBtn');

function initImport() {
  document.getElementById('openImportOverlay').addEventListener('click', () => {
    elImportOverlay.classList.remove('hidden');
    elImportText.focus();
  });

  elImportBtn.addEventListener('click', async () => {
    const text = elImportText.value.trim();
    if (!text) {
      elImportStatus.textContent = 'Paste a tracklist first';
      return;
    }

    elImportBtn.disabled = true;
    elImportStatus.textContent = 'Importing…';

    try {
      const result = await api.setMarkers(state.mediaId, { markerText: text });
      const saved = result.saved?.markerCount ?? 0;
      const errs = result.importErrors?.length ?? 0;
      const msg = `${saved} marker${saved !== 1 ? 's' : ''}${errs ? ` (${errs} skipped)` : ''}`;
      elImportStatus.textContent = '';
      elImportOverlay.classList.add('hidden');
      toast(`Imported ${msg}`, 'success');

      // Reload media to get fresh markers
      const media = await api.getMedia(state.mediaId);
      state.media = media;
      state.markers = media.markers || [];
      initMarkers(state, els);
    } catch (err) {
      elImportStatus.textContent = `Error: ${err.message}`;
    } finally {
      elImportBtn.disabled = false;
    }
  });
}

// ============================================================
// Close overlays — generic data-close handler
// ============================================================
document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => {
    const targetId = el.dataset.close;
    document.getElementById(targetId).classList.add('hidden');
  });
});

// ============================================================
// Global keyboard shortcuts
// ============================================================
document.addEventListener('keydown', (e) => {
  // Don't fire when typing in inputs
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      els.player.paused ? els.player.play() : els.player.pause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      els.player.currentTime = Math.max(0, els.player.currentTime - 5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      els.player.currentTime = Math.min(els.player.duration || 0, els.player.currentTime + 5);
      break;
    case 'ArrowUp':
      e.preventDefault();
      els.player.volume = Math.min(1, els.player.volume + 0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      els.player.volume = Math.max(0, els.player.volume - 0.05);
      break;
    case 'm':
    case 'M':
      els.player.muted = !els.player.muted;
      break;
    case 'f':
    case 'F':
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        els.playbackFrame.requestFullscreen().catch(() => {});
      }
      break;
    case 'Escape':
      // Close any open overlay
      document.querySelectorAll('.overlay:not(.hidden)').forEach(o => o.classList.add('hidden'));
      break;
  }
});

// ============================================================
// Cleanup
// ============================================================
window.addEventListener('beforeunload', () => {
  cleanupControls();
  cleanupMarkers();
  cleanupVisualizer();
});

// ============================================================
// Boot
// ============================================================
load();
