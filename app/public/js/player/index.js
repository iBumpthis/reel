/**
 * Reel — Player page orchestrator.
 * Loads media, initializes modules, handles global keyboard shortcuts.
 */
import * as api from '../shared/api.js';
import { toast, fmtTime } from '../shared/utils.js';
import { initControls, cleanupControls } from './controls.js';
import { cleanupVisualizer } from './visualizer.js';
import { initModes, setMode, cycleVizStyle, cycleTheme, toggleTrails } from './modes.js';
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
  trails: false,
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

/**
 * Build the artist portion of the player title as per-member deep links into
 * the filtered library (Stage B). `members` is the relational artist list
 * (media.artists); `displayArtist` is the rendered string (media.artist), which
 * for a b2b set is the members joined by the configured separator in filename
 * order. We walk the display string and link each member where it appears,
 * keeping the literal separators as plain text — so the visible label is byte-
 * identical to the old fused string, just with the artist(s) now clickable.
 *
 * Safe degradation: with no structured members (solo-from-filename, or a hand-
 * edited display that hasn't been re-synced into the relation), or if any member
 * can't be located in the display string, the whole artist renders as plain
 * text with no links rather than risk a garbled or dead-ended link.
 */
function buildArtistNodes(displayArtist, members) {
  const frag = document.createDocumentFragment();
  if (!Array.isArray(members) || members.length === 0) {
    frag.appendChild(document.createTextNode(displayArtist));
    return frag;
  }
  const out = document.createDocumentFragment();
  let remaining = displayArtist;
  for (const member of members) {
    // Each member is { name (literal, as it appears in the display string),
    // canonical (the filter target) }. Walk on the literal so a "REZZ"-cased
    // file still reconstructs; link to the canonical so the filter resolves.
    // Tolerate a bare string (older payload) by treating name === canonical.
    const name = typeof member === 'string' ? member : member.name;
    const canonical = typeof member === 'string' ? member : (member.canonical ?? member.name);
    const idx = remaining.indexOf(name);
    if (idx === -1) {
      // Display drifted from the relation — fall back to plain text entirely.
      const plain = document.createDocumentFragment();
      plain.appendChild(document.createTextNode(displayArtist));
      return plain;
    }
    if (idx > 0) out.appendChild(document.createTextNode(remaining.slice(0, idx)));
    const a = document.createElement('a');
    a.href = `/?artist=${encodeURIComponent(canonical)}`;
    a.className = 'player-artist-link';
    a.textContent = name;
    out.appendChild(a);
    remaining = remaining.slice(idx + name.length);
  }
  if (remaining) out.appendChild(document.createTextNode(remaining));
  return out;
}

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

    // Title display. The artist portion is rendered as per-member deep links
    // into the filtered library (/?artist=<name>); a b2b set gets one link per
    // member. media.artists (relational, Stage B) drives the links; the display
    // string is walked to reconstruct separators. document.title stays plain.
    const display = media.title || media.filename;
    els.playerTitle.textContent = '';
    if (media.artist) {
      els.playerTitle.appendChild(buildArtistNodes(media.artist, media.artists));
      els.playerTitle.appendChild(document.createTextNode(` — ${display}`));
    } else {
      els.playerTitle.textContent = display;
    }
    const parts = [media.year, media.libraryName, (media.ext || '').toUpperCase()].filter(Boolean);
    els.playerSub.textContent = parts.join(' · ');

    // Set document title
    document.title = `Reel — ${media.artist ? `${media.artist} — ` : ''}${display}`;

    // Set source
    els.player.src = media.streamUrl;

    // Media error handling — decode errors get mid-stream recovery
    // (see handleMediaError below). Other errors surface and stop.
    els.player.addEventListener('error', handleMediaError);

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
// Media error handling + mid-stream decode recovery
//
// MEDIA_ERR_DECODE (code 3) covers two very different failures:
//   - Codec incompatibility: the browser can't decode the format at all.
//     Fires almost immediately (within the first couple seconds). Seeking
//     past won't help — the whole stream is undecodable. Surface and stop.
//   - Mid-stream corruption: a bad segment baked into the source (common
//     from some yt-dlp backup captures). Fires during active playback.
//     Often recoverable by reloading and seeking a few seconds past the
//     bad spot.
// We split on a time threshold: an error before DECODE_CODEC_THRESHOLD is
// treated as a codec problem; at or after it, as recoverable corruption.
//
// The MediaElementAudioSourceNode (if the visualizer is active) stays bound
// to the <video> element across src reassignment, so reloading does NOT
// break the audio graph — no need to rebuild it.
// ============================================================
const DECODE_RETRY_CAP = 5;        // max recovery attempts per page load
const DECODE_RECOVERY_SKIP = 3;    // seconds to seek past the bad segment
const DECODE_COOLDOWN_MS = 1000;   // min gap between recovery attempts
const DECODE_CODEC_THRESHOLD = 2;  // errors before this point = codec, not corruption

let decodeRetries = 0;
let lastRecoveryAt = 0;

function handleMediaError() {
  const err = els.player.error;
  if (!err) return;

  // Non-decode errors: surface and stop (no recovery path applies).
  if (err.code !== 3 /* MEDIA_ERR_DECODE */) {
    const messages = {
      1: 'Playback aborted',
      2: 'Network error — file may be inaccessible',
      4: 'Format not supported — browser cannot play this file type',
    };
    const msg = messages[err.code] || `Playback error (code ${err.code})`;
    toast(err.message ? `${msg}: ${err.message}` : msg, 'error');
    console.error('[reel] Media error:', err.code, err.message);
    return;
  }

  const pos = els.player.currentTime || 0;

  // Early decode error → codec the browser can't handle. Seeking won't fix it.
  if (pos < DECODE_CODEC_THRESHOLD) {
    toast('Decode error — codec may not be supported by this browser', 'error');
    console.error(`[reel] Decode error (codec incompatibility) at ${pos.toFixed(2)}s`);
    return;
  }

  // Debounce rapid-fire errors so an in-flight recovery can settle before
  // we count another attempt against the cap.
  const now = performance.now();
  if (now - lastRecoveryAt < DECODE_COOLDOWN_MS) {
    console.warn('[reel] Decode error within cooldown window, ignoring');
    return;
  }
  lastRecoveryAt = now;

  if (decodeRetries >= DECODE_RETRY_CAP) {
    toast('Too many decode errors — file may be corrupt', 'error');
    console.error(`[reel] Decode recovery exhausted after ${decodeRetries} attempt(s)`);
    return;
  }

  decodeRetries++;
  const resumePos = pos + DECODE_RECOVERY_SKIP;
  console.warn(
    `[reel] Mid-stream decode error at ${fmtTime(pos)} — ` +
    `recovery attempt ${decodeRetries}/${DECODE_RETRY_CAP}, seeking to ${fmtTime(resumePos)}`
  );
  recoverFromDecodeError(resumePos, pos);
}

function recoverFromDecodeError(resumePos, errorPos) {
  const wasPlaying = !els.player.paused;
  const duration = els.player.duration;

  // Corruption near EOF — skip target past the end. Don't loop on it.
  if (Number.isFinite(duration) && resumePos >= duration) {
    toast('Reached end of file after decode error', 'error');
    console.warn(`[reel] Skip target ${fmtTime(resumePos)} past duration, stopping recovery`);
    return;
  }

  // Reload the source, then seek past the bad segment once metadata is back.
  els.player.src = state.media.streamUrl;
  els.player.load();

  els.player.addEventListener('loadedmetadata', () => {
    try {
      els.player.currentTime = resumePos;
    } catch (e) {
      console.error('[reel] Seek after recovery failed:', e);
    }
    if (wasPlaying) els.player.play().catch(() => {});
    toast(`Skipped bad segment at ${fmtTime(errorPos)}`, 'error');
  }, { once: true });
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
      await copyToClipboard(text);
      toast(`${state.markers.length} marker${state.markers.length !== 1 ? 's' : ''} copied to clipboard`, 'success');
    } catch (err) {
      toast(`Export failed: ${err.message}`, 'error');
    }
  });
}

/** Copy text to clipboard with fallback for non-secure (HTTP) contexts. */
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback: temporary textarea + execCommand
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
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
    case 'v':
    case 'V':
      // If not in visualizer mode, enter it. If already there, cycle style.
      if (state.currentMode !== 'visualizer') {
        setMode('visualizer');
      } else {
        cycleVizStyle(e.shiftKey ? -1 : 1);
      }
      break;
    case 't':
    case 'T':
      // Cycle color theme
      cycleTheme(e.shiftKey ? -1 : 1);
      break;
    case 'g':
    case 'G':
      // Toggle Trails modifier (per-mode persistence). Only meaningful in
      // visualizer mode. Delegates to the shared toggleTrails so the flag,
      // the modifiers-button highlight, and the toast stay in sync — the
      // visualizer-only guard here preserves the original key behavior.
      if (state.currentMode === 'visualizer') {
        toggleTrails();
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
