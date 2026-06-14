/**
 * Reel — Playback mode switching.
 * Video / audio / visualizer modes, viz style + theme selection,
 * fullscreen viz controls, keyboard cycling, randomizer.
 */
import { ensureAudioContext, resumeAudioContext, startViz, stopViz, initVisualizer, VIZ_STYLES, THEME_NAMES } from './visualizer.js';

let state, els;

const AUDIO_ONLY_EXTS = new Set([
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma', 'opus',
]);

const elModeNotice = document.getElementById('modeNotice');
const modeBtns = document.querySelectorAll('.mode-btn');
// These selectors capture both the main toolbar AND fullscreen viz bar buttons
// because they share the same class names.
const vizStyleBtns = document.querySelectorAll('.viz-style-btn');
const themeBtns = document.querySelectorAll('.theme-btn');

// Fullscreen viz bar element
const elFsVizBar = document.getElementById('fsVizBar');

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
// Viz style + theme setters (sync all buttons)
// ============================================================
function setVizStyle(style) {
  state.vizStyle = style;
  vizStyleBtns.forEach(b => b.classList.toggle('active', b.dataset.style === style));
}

function setTheme(theme) {
  state.currentTheme = theme;
  themeBtns.forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

// ============================================================
// Cycling (for keyboard shortcuts)
// ============================================================
export function cycleVizStyle(direction = 1) {
  const idx = VIZ_STYLES.indexOf(state.vizStyle);
  const next = (idx + direction + VIZ_STYLES.length) % VIZ_STYLES.length;
  setVizStyle(VIZ_STYLES[next]);
}

export function cycleTheme(direction = 1) {
  const idx = THEME_NAMES.indexOf(state.currentTheme);
  const next = (idx + direction + THEME_NAMES.length) % THEME_NAMES.length;
  setTheme(THEME_NAMES[next]);
}

// ============================================================
// Randomizer — random style + theme (excluding current)
// ============================================================
function randomize() {
  const otherStyles = VIZ_STYLES.filter(s => s !== state.vizStyle);
  const otherThemes = THEME_NAMES.filter(t => t !== state.currentTheme);
  setVizStyle(otherStyles[Math.floor(Math.random() * otherStyles.length)]);
  setTheme(otherThemes[Math.floor(Math.random() * otherThemes.length)]);
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

  // Set initial active states from JS (covers both toolbar + FS buttons)
  vizStyleBtns.forEach(b => b.classList.toggle('active', b.dataset.style === state.vizStyle));
  themeBtns.forEach(b => b.classList.toggle('active', b.dataset.theme === state.currentTheme));

  // Mode buttons — visualizer button doubles as randomizer when already active
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === 'visualizer' && state.currentMode === 'visualizer') {
        randomize();
      } else {
        setMode(btn.dataset.mode);
      }
    });
  });

  // Viz style buttons (both main toolbar and fullscreen bar)
  // Clicking a style button while not in visualizer mode enters it automatically.
  vizStyleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setVizStyle(btn.dataset.style);
      if (state.currentMode !== 'visualizer') {
        setMode('visualizer');
      }
    });
  });

  // Theme buttons (both main toolbar and fullscreen bar)
  themeBtns.forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
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
