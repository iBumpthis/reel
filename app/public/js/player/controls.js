/**
 * Reel — Custom player controls.
 * Play/pause, seek, volume, fullscreen, playback speed, frame click.
 */
import { fmtTime } from '../shared/utils.js';

let state, els;
let isSeeking = false;
let fsIdleTimer = null;

const elControls = document.getElementById('playerControls');
const elPlay = document.getElementById('ccPlay');
const elPlayIcon = document.getElementById('ccPlayIcon');
const elPauseIcon = document.getElementById('ccPauseIcon');
const elSeek = document.getElementById('ccSeek');
const elTimeCurrent = document.getElementById('ccTimeCurrent');
const elTimeDuration = document.getElementById('ccTimeDuration');
const elVolume = document.getElementById('ccVolume');
const elSpeed = document.getElementById('ccSpeed');
const elFullscreen = document.getElementById('ccFullscreen');
const elFsEnter = document.getElementById('ccFsEnter');
const elFsExit = document.getElementById('ccFsExit');

// ============================================================
// Play / pause
// ============================================================
function onPlayClick() {
  els.player.paused ? els.player.play() : els.player.pause();
}

function onPlay() {
  elPlayIcon.classList.add('hidden');
  elPauseIcon.classList.remove('hidden');
}

function onPause() {
  elPlayIcon.classList.remove('hidden');
  elPauseIcon.classList.add('hidden');
}

// ============================================================
// Seek bar
// ============================================================
function onTimeUpdate() {
  if (!isSeeking && els.player.duration) {
    elSeek.value = (els.player.currentTime / els.player.duration) * 100;
    elTimeCurrent.textContent = fmtTime(els.player.currentTime);
  }
}

function onSeekStart() { isSeeking = true; }
function onSeekInput() {
  if (els.player.duration) {
    elTimeCurrent.textContent = fmtTime((elSeek.value / 100) * els.player.duration);
  }
}
function onSeekChange() {
  if (els.player.duration) {
    els.player.currentTime = (elSeek.value / 100) * els.player.duration;
  }
  isSeeking = false;
}

function onLoadedMetadata() {
  elTimeDuration.textContent = fmtTime(els.player.duration);
}

// ============================================================
// Volume
// ============================================================
function onVolumeInput() {
  els.player.volume = Number(elVolume.value);
}

// ============================================================
// Speed
// ============================================================
function onSpeedChange() {
  els.player.playbackRate = Number(elSpeed.value);
}

// ============================================================
// Fullscreen
// ============================================================
function onFullscreenClick() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    els.playbackFrame.requestFullscreen().catch(err => {
      console.warn('[reel] Fullscreen failed:', err);
    });
  }
}

function onFullscreenChange() {
  const isFs = !!document.fullscreenElement;
  elFsEnter.classList.toggle('hidden', isFs);
  elFsExit.classList.toggle('hidden', !isFs);

  if (!isFs) {
    clearTimeout(fsIdleTimer);
    elControls.classList.remove('cc-visible');
  }
}

// ============================================================
// Fullscreen idle timer — show controls on mouse movement
// ============================================================
function onFrameMouseMove() {
  if (!document.fullscreenElement) return;
  elControls.classList.add('cc-visible');
  clearTimeout(fsIdleTimer);
  fsIdleTimer = setTimeout(() => {
    elControls.classList.remove('cc-visible');
  }, 3000);
}

// ============================================================
// Frame click → play/pause (guard against control bar clicks)
// ============================================================
function onFrameClick(e) {
  if (!elControls.contains(e.target)) {
    els.player.paused ? els.player.play() : els.player.pause();
  }
  // Reset fullscreen idle timer on any click
  if (document.fullscreenElement) {
    elControls.classList.add('cc-visible');
    clearTimeout(fsIdleTimer);
    fsIdleTimer = setTimeout(() => {
      elControls.classList.remove('cc-visible');
    }, 3000);
  }
}

// ============================================================
// Init / cleanup
// ============================================================
export function initControls(_state, _els) {
  state = _state;
  els = _els;

  elPlay.addEventListener('click', onPlayClick);
  els.player.addEventListener('play', onPlay);
  els.player.addEventListener('pause', onPause);
  els.player.addEventListener('timeupdate', onTimeUpdate);
  els.player.addEventListener('loadedmetadata', onLoadedMetadata);

  elSeek.addEventListener('mousedown', onSeekStart);
  elSeek.addEventListener('touchstart', onSeekStart, { passive: true });
  elSeek.addEventListener('input', onSeekInput);
  elSeek.addEventListener('change', onSeekChange);

  elVolume.addEventListener('input', onVolumeInput);
  elSpeed.addEventListener('change', onSpeedChange);

  elFullscreen.addEventListener('click', onFullscreenClick);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  els.playbackFrame.addEventListener('mousemove', onFrameMouseMove);
  els.playbackFrame.addEventListener('click', onFrameClick);
}

export function cleanupControls() {
  clearTimeout(fsIdleTimer);
}
