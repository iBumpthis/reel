/**
 * Reel — Playback mode switching.
 * Video / audio / visualizer modes, theme + style selector visibility.
 */
import { ensureAudioContext, resumeAudioContext, startViz, stopViz, initVisualizer } from './visualizer.js';

let state, els;

const AUDIO_ONLY_EXTS = new Set([
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma', 'opus',
]);

const elVizOptions = document.getElementById('vizOptions');
const elModeNotice = document.getElementById('modeNotice');
const modeBtns = document.querySelectorAll('.mode-btn');
const vizStyleBtns = document.querySelectorAll('.viz-style-btn');
const themeBtns = document.querySelectorAll('.theme-btn');

// Markers panel height sync — match to playback frame height
const elMarkersScroll = document.getElementById('markersScroll');
let markersCollapsed = false;

function syncMarkersHeight() {
  if (markersCollapsed) return;
  let targetHeight;
  if (state.currentMode === 'audio') {
    targetHeight = window.innerHeight * 0.5;
  } else {
    targetHeight = els.playbackFrame.getBoundingClientRect().height;
  }
  if (targetHeight > 0) {
    // Subtract the markers header height so the panel doesn't extend below the video
    const headerEl = document.querySelector('.markers-panel-header');
    const headerHeight = headerEl ? headerEl.getBoundingClientRect().height + 8 : 40;
    elMarkersScroll.style.maxHeight = Math.max(100, targetHeight - headerHeight) + 'px';
  }
}

// ============================================================
// Mode switching
// ============================================================
export function setMode(mode) {
  const prevMode = state.currentMode;
  state.currentMode = mode;

  modeBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  elVizOptions.classList.toggle('hidden', mode !== 'visualizer');
  elModeNotice.classList.add('hidden');
  elModeNotice.textContent = '';

  if (mode === 'video') {
    stopViz();
    els.playbackFrame.classList.remove('mode-audio', 'mode-visualizer');
    els.playbackFrame.classList.add('mode-video');

    if (AUDIO_ONLY_EXTS.has(state.fileExt)) {
      showNotice('Audio file — no video track available');
    }

  } else if (mode === 'audio') {
    stopViz();
    els.playbackFrame.classList.remove('mode-video', 'mode-visualizer');
    els.playbackFrame.classList.add('mode-audio');

  } else if (mode === 'visualizer') {
    const ok = ensureAudioContext();
    if (!ok) {
      showNotice('Could not initialize audio — browser may not support Web Audio API');
      state.currentMode = prevMode;
      modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === prevMode));
      return;
    }

    resumeAudioContext();
    els.playbackFrame.classList.remove('mode-video', 'mode-audio');
    els.playbackFrame.classList.add('mode-visualizer');
    startViz();
  }

  syncMarkersHeight();
}

function showNotice(msg) {
  elModeNotice.textContent = msg;
  elModeNotice.classList.remove('hidden');
}

// ============================================================
// Init
// ============================================================
export function initModes(_state, _els, defaultMode) {
  state = _state;
  els = _els;

  initVisualizer(state, els);

  // Mode buttons
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  // Viz style buttons
  vizStyleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      state.vizStyle = btn.dataset.style;
      vizStyleBtns.forEach(b => b.classList.toggle('active', b.dataset.style === state.vizStyle));
    });
  });

  // Theme buttons
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      state.currentTheme = btn.dataset.theme;
      themeBtns.forEach(b => b.classList.toggle('active', b.dataset.theme === state.currentTheme));
    });
  });

  // Markers panel collapse toggle
  const elMarkersToggle = document.getElementById('markersToggle');
  const elPanelHeader = document.querySelector('.markers-panel-header');

  elMarkersToggle.addEventListener('click', () => {
    markersCollapsed = !markersCollapsed;
    elMarkersScroll.classList.toggle('collapsed', markersCollapsed);
    elPanelHeader.classList.toggle('collapsed', markersCollapsed);
    elMarkersToggle.textContent = markersCollapsed ? 'expand' : 'collapse';

    const layout = document.querySelector('.player-layout');
    if (markersCollapsed) {
      // Fixed pixel width sized to the toggle button. An `auto` column
      // sizes to max-content of the hidden marker rows (max-height: 0
      // collapses height, not width), so long marker labels would steal
      // width from the player column. Fixed→fixed also lets the
      // grid-template-columns transition animate (length↔auto doesn't).
      const btnWidth = Math.ceil(elMarkersToggle.getBoundingClientRect().width);
      layout.style.setProperty('--markers-width', `${btnWidth}px`);
      document.getElementById('markersPanel').classList.add('panel-collapsed');
    } else {
      layout.style.setProperty('--markers-width', '300px');
      document.getElementById('markersPanel').classList.remove('panel-collapsed');
      setTimeout(syncMarkersHeight, 260);
    }
  });

  // Sync markers height to playback frame
  const resizeObserver = new ResizeObserver(() => syncMarkersHeight());
  resizeObserver.observe(els.playbackFrame);
  window.addEventListener('resize', syncMarkersHeight);

  // Set default mode
  setMode(defaultMode);

  // Sync once after video metadata loads
  els.player.addEventListener('loadedmetadata', syncMarkersHeight, { once: true });
}
