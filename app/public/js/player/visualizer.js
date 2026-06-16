/**
 * Reel — Visualizer.
 * Web Audio API analyser with multiple render modes and color themes.
 *
 * Modes:  bars, lines, circular, spectrogram, particles, nova, matrix, terminal
 * Themes: muted, colorful, rgb, neon, fire, matrix, ocean
 *
 * Copyright (c) 2026 iBumpthis
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

let state, els;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let vizAnimFrame = null;
let freqData = null;
let waveData = null;

// Ordered lists for keyboard cycling
export const VIZ_STYLES = ['bars', 'lines', 'circular', 'spectrogram', 'particles', 'nova', 'matrix', 'terminal'];
export const THEME_NAMES = ['muted', 'colorful', 'rgb', 'neon', 'fire', 'matrix', 'ocean'];

// ============================================================
// Themes — each provides bg, color(i, count, t), and
// amplitudeColor(value) for spectrogram mapping (0-255)
// ============================================================
const VIZ_THEMES = {
  muted: {
    bg: 'rgba(0, 0, 0, 0.92)',
    color: (i, count, _t) => {
      const pct = i / count;
      const r = Math.round(120 + pct * 60);
      const g = Math.round(130 + pct * 50);
      const b = Math.round(145 + pct * 40);
      return `rgb(${r}, ${g}, ${b})`;
    },
    amplitudeColor: (v) => {
      const pct = v / 255;
      return `rgb(${Math.round(60 + pct * 120)}, ${Math.round(65 + pct * 115)}, ${Math.round(75 + pct * 110)})`;
    },
  },
  colorful: {
    bg: 'rgba(0, 0, 0, 0.92)',
    color: (i, count, _t) => {
      const hue = (i / count) * 280 + 200;
      return `hsl(${hue % 360}, 72%, 58%)`;
    },
    amplitudeColor: (v) => {
      const hue = (v / 255) * 280 + 200;
      return `hsl(${hue % 360}, 72%, ${10 + (v / 255) * 52}%)`;
    },
  },
  rgb: {
    bg: 'rgba(0, 0, 0, 0.95)',
    color: (i, count, t) => {
      const hue = ((i / count) * 360 + t * 40) % 360;
      return `hsl(${hue}, 90%, 55%)`;
    },
    amplitudeColor: (v) => {
      const hue = (v / 255) * 360;
      return `hsl(${hue}, 90%, ${8 + (v / 255) * 50}%)`;
    },
  },
  neon: {
    bg: 'rgba(0, 0, 0, 0.93)',
    color: (i, count, t) => {
      // Cyan → magenta sweep with time drift
      const hue = (i / count) * 80 + 170 + Math.sin(t * 0.5) * 20;
      return `hsl(${hue % 360}, 100%, 60%)`;
    },
    amplitudeColor: (v) => {
      const pct = v / 255;
      const hue = pct * 80 + 170;
      return `hsl(${hue % 360}, 100%, ${6 + pct * 56}%)`;
    },
  },
  fire: {
    bg: 'rgba(0, 0, 0, 0.92)',
    color: (i, count, _t) => {
      const pct = i / count;
      // Dark red → orange → bright yellow
      const r = 255;
      const g = Math.round(pct * 200);
      const b = Math.round(pct * pct * 60);
      return `rgb(${r}, ${g}, ${b})`;
    },
    amplitudeColor: (v) => {
      const pct = v / 255;
      return `rgb(${Math.round(40 + pct * 215)}, ${Math.round(pct * pct * 200)}, ${Math.round(pct * pct * pct * 60)})`;
    },
  },
  matrix: {
    bg: 'rgba(0, 0, 0, 0.92)',
    color: (i, count, _t) => {
      const pct = i / count;
      return `rgb(0, ${Math.round(80 + pct * 175)}, ${Math.round(pct * 30)})`;
    },
    amplitudeColor: (v) => {
      const pct = v / 255;
      return `rgb(0, ${Math.round(15 + pct * 240)}, ${Math.round(pct * 25)})`;
    },
  },
  ocean: {
    bg: 'rgba(0, 0, 0, 0.92)',
    color: (i, count, t) => {
      const pct = i / count;
      const shift = Math.sin(t * 0.3) * 15;
      const r = Math.round(pct * 20);
      const g = Math.round(70 + pct * 130 + shift);
      const b = Math.round(130 + pct * 125);
      return `rgb(${r}, ${Math.min(255, g)}, ${Math.min(255, b)})`;
    },
    amplitudeColor: (v) => {
      const pct = v / 255;
      return `rgb(${Math.round(pct * 15)}, ${Math.round(20 + pct * 140)}, ${Math.round(40 + pct * 180)})`;
    },
  },
};

export { VIZ_THEMES };

// ============================================================
// Audio context + analyser — lazy, one-time setup
// ============================================================
export function ensureAudioContext() {
  if (audioCtx && sourceNode) return true;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.85;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    waveData = new Uint8Array(analyser.fftSize);

    sourceNode = audioCtx.createMediaElementSource(els.player);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);

    return true;
  } catch (e) {
    console.error('[reel] AudioContext init failed:', e);
    return false;
  }
}

export function resumeAudioContext() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// ============================================================
// Particle system (lazy init)
// ============================================================
const PARTICLE_COUNT = 180;
let particles = [];
let particlesW = 0;
let particlesH = 0;

function ensureParticles(w, h) {
  if (particles.length === PARTICLE_COUNT && particlesW === w && particlesH === h) return;
  particlesW = w;
  particlesH = h;
  particles = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.5) * 1.5,
      size: Math.random() * 3.2 + 1.2,
      bin: Math.floor(Math.random() * 64),
    });
  }
}

// ============================================================
// Spectrogram state
// ============================================================
let spectroLastW = 0;
let spectroLastH = 0;
const SPECTRO_SCROLL_PX = 2;

// ============================================================
// Matrix Rain state
// ============================================================
const MATRIX_CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF';
const MATRIX_COL_COUNT = 64;
const MATRIX_TRAIL_LEN = 22;
let matrixColumns = [];
let matrixLastW = 0;
let matrixLastH = 0;
let matrixCharH = 0;

function ensureMatrix(w, h) {
  const charH = Math.max(14, Math.floor(h / 35));

  if (matrixColumns.length === MATRIX_COL_COUNT && matrixLastW === w && matrixLastH === h) return;
  matrixLastW = w;
  matrixLastH = h;
  matrixCharH = charH;

  const colWidth = w / MATRIX_COL_COUNT;
  const maxRows = Math.ceil(h / charH) + MATRIX_TRAIL_LEN + 5;

  matrixColumns = [];
  for (let i = 0; i < MATRIX_COL_COUNT; i++) {
    const chars = [];
    for (let r = 0; r < maxRows; r++) {
      chars.push(MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]);
    }
    matrixColumns.push({
      chars,
      headY: Math.random() * (h + charH * MATRIX_TRAIL_LEN),
      speed: (0.6 + Math.random() * 1.4) * charH / 18,
      x: i * colWidth + colWidth / 2,
    });
  }
}

// ============================================================
// Draw loop
// ============================================================
function draw() {
  vizAnimFrame = requestAnimationFrame(draw);

  const canvas = els.vizCanvas;
  const ctx = canvas.getContext('2d');

  // Sync canvas resolution to display size
  // Note: getBoundingClientRect() returns floats but canvas.width/height
  // are integers. Without rounding, the comparison fires every frame,
  // re-clearing the canvas — fatal for spectrogram which accumulates.
  const rect = canvas.getBoundingClientRect();
  const rectW = Math.round(rect.width);
  const rectH = Math.round(rect.height);
  if (canvas.width !== rectW || canvas.height !== rectH) {
    canvas.width = rectW;
    canvas.height = rectH;
  }

  const w = canvas.width;
  const h = canvas.height;
  const theme = VIZ_THEMES[state.currentTheme] || VIZ_THEMES.rgb;
  const t = performance.now() / 1000;

  switch (state.vizStyle) {
    case 'bars':        drawBars(ctx, w, h, theme, t); break;
    case 'lines':       drawLines(ctx, w, h, theme, t); break;
    case 'circular':    drawCircular(ctx, w, h, theme, t); break;
    case 'spectrogram': drawSpectrogram(ctx, w, h, theme, t); break;
    case 'particles':   drawParticles(ctx, w, h, theme, t); break;
    case 'nova':        drawNova(ctx, w, h, theme, t); break;
    case 'matrix':      drawMatrix(ctx, w, h, theme, t); break;
    case 'terminal':    drawTerminal(ctx, w, h, theme, t); break;
    default:            drawBars(ctx, w, h, theme, t);
  }
}

// ============================================================
// Mode: Bars (linear end-to-end spectrum with reflection)
// ============================================================
// Redesigned v1.9.1. Replaces the prior center-mirrored layout with a
// single linear spectrum sweep: bass at the left edge, treble at the
// right, spanning the full width end-to-end (Radial's treatment, but
// unrolled flat). Main band fills the top 2/3; a dimmed, shortened
// reflection drops into the bottom 1/3 across a thin baseline. White-hot
// tips mark peaks at the frame cap (the Matrix/Terminal double-draw).
//
// BIN-RANGE CAP (ported from the old Bars / Radial — do NOT drop this):
// only the lower BARS_BIN_RANGE fraction of FFT bins is sampled. In lossy
// MP4 the upper register is gone, so those bins are flat near-zero noise;
// sampling only the populated low band is what fills the frame. Without
// it the real spectrum collapses into the left third and the rest of the
// width shows dead bins. This is a truncation, not interpolation —
// deliberately absent in Terminal, which shows the true (dead-topped)
// spectrum against fixed Hz labels.
const BARS_MAX = 96;             // bar-count cap (visual density)
const BARS_BIN_RANGE = 0.38;     // fraction of FFT bins sampled — see note above
const BARS_BASELINE = 2 / 3;     // main band height as a fraction of canvas height
const BARS_REFLECT_SCALE = 0.5;  // reflection length vs main (also fits it in the 1/3 band)
const BARS_REFLECT_ALPHA = 0.28; // reflection dimming
const BARS_PEAK_THRESHOLD = 0.82; // amplitude past which the white-hot tip appears
const BARS_CORNER = 4;            // max rounded-corner radius (px)

// roundRect is not on every target's CanvasRenderingContext2D (some
// embedded / older browsers — the Xbox Edge clone among Reel's targets).
// Detect once; fall back to square corners where absent.
const HAS_ROUND_RECT = typeof CanvasRenderingContext2D !== 'undefined'
  && typeof CanvasRenderingContext2D.prototype.roundRect === 'function';

// Fill a vertical bar segment, rounding only the outer end (roundTop:
// true rounds the top, false rounds the bottom) so main + reflection
// meet flush at the baseline.
function barSegment(ctx, x, y, bw, bh, r, roundTop) {
  if (bh <= 0.5) return;
  if (HAS_ROUND_RECT && r > 0.5) {
    const rad = Math.min(r, bw / 2, bh);
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, roundTop ? [rad, rad, 0, 0] : [0, 0, rad, rad]);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, bw, bh);
  }
}

function drawBars(ctx, w, h, theme, t) {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  analyser.getByteFrequencyData(freqData);

  const rawBins = Math.max(1, Math.floor(analyser.frequencyBinCount * BARS_BIN_RANGE));
  const bars = Math.min(rawBins, BARS_MAX);
  const binStep = rawBins / bars;

  const baseY = h * BARS_BASELINE;   // baseline / "water line"
  const maxMainLen = baseY;          // a full-amplitude bar reaches the top
  const slot = w / bars;
  const gap = Math.max(1, slot * 0.18);
  const bw = Math.max(1, slot - gap);
  const radius = Math.min(bw / 2, BARS_CORNER);
  const tipLen = Math.max(3, h * 0.012); // fixed-height white peak cap

  for (let i = 0; i < bars; i++) {
    const binIndex = Math.floor(i * binStep);
    const val = freqData[binIndex] / 255;
    const barLen = val * maxMainLen;
    if (barLen < 0.5) continue;

    const x = i * slot + gap / 2;
    const color = theme.color(i, bars, t);

    // Main bar — grows up from the baseline
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = color;
    barSegment(ctx, x, baseY - barLen, bw, barLen, radius, true);

    // White-hot tip — double-draw on genuine peaks only, alpha scaled by
    // how far past threshold the bar pushes (same technique as Matrix).
    if (val > BARS_PEAK_THRESHOLD) {
      const cap = Math.min(barLen, tipLen);
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = Math.min(0.95, (val - BARS_PEAK_THRESHOLD) / (1 - BARS_PEAK_THRESHOLD));
      barSegment(ctx, x, baseY - barLen, bw, cap, radius, true);
    }

    // Reflection — dimmed + shortened, grows down from the baseline
    ctx.fillStyle = color;
    ctx.globalAlpha = BARS_REFLECT_ALPHA;
    barSegment(ctx, x, baseY, bw, barLen * BARS_REFLECT_SCALE, radius, false);
  }

  // Baseline separator — thin, dim, theme-tinted
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = theme.color(0, bars, t);
  ctx.fillRect(0, baseY - 0.5, w, 1);

  ctx.globalAlpha = 1.0;
}

// ============================================================
// Mode: Lines (layered waveform with persistence decay)
// ============================================================
function drawLines(ctx, w, h, theme, t) {
  // Persistence decay — partial clear creates trailing effect
  ctx.fillStyle = 'rgba(0, 0, 0, 0.11)';
  ctx.fillRect(0, 0, w, h);

  analyser.getByteTimeDomainData(waveData);

  const count = waveData.length;
  const centerY = h / 2;

  // Layered copies with large Y offsets — fills the full canvas height.
  // Wide spacing keeps layers visually distinct rather than smearing
  // into a solid mass when the music hits hard.
  const layers = [
    { offset: 0,    alpha: 1.0  },
    { offset: -50,  alpha: 0.5  },
    { offset:  50,  alpha: 0.5  },
    { offset: -110, alpha: 0.25 },
    { offset:  110, alpha: 0.25 },
    { offset: -170, alpha: 0.08 },
    { offset:  170, alpha: 0.08 },
  ];

  for (const layer of layers) {
    ctx.globalAlpha = layer.alpha;
    ctx.strokeStyle = theme.color(Math.floor(count / 2), count, t);
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let i = 0; i < count; i++) {
      const x = (i / (count - 1)) * w;
      const amplitude = ((waveData[i] / 128) - 1) * (h * 0.45);
      const y = centerY + layer.offset + amplitude;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();
  }

  ctx.globalAlpha = 1.0;
}

// ============================================================
// Mode: Circular (radial frequency bars, mirrored for symmetry)
// ============================================================
function drawCircular(ctx, w, h, theme, t) {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  analyser.getByteFrequencyData(freqData);

  const centerX = w / 2;
  const centerY = h / 2;
  const baseRadius = Math.min(w, h) * 0.22;
  const maxBarLen = Math.min(w, h) * 0.28;

  // Mirror: use ~48 bins, draw clockwise + counter-clockwise from top
  // Bass at 12 o'clock, high freq meets at 6 o'clock
  const rawBins = analyser.frequencyBinCount;
  const halfBins = Math.min(Math.floor(rawBins * 0.4), 48);
  const binStep = Math.floor(rawBins * 0.4) / halfBins;
  const totalPositions = halfBins * 2;
  const arcWidth = Math.max(1.5, (Math.PI * 2 * baseRadius / totalPositions) * 0.65);

  for (let i = 0; i < halfBins; i++) {
    const binIndex = Math.floor(i * binStep);
    const val = freqData[binIndex] / 255;
    const barLen = val * maxBarLen;

    // Angle from top: right side goes clockwise, left side mirrors
    // Use (halfBins - 1) so the last bin lands exactly at 6 o'clock
    const angleOffset = (i / (halfBins - 1)) * Math.PI;
    // At the poles both mirrored angles resolve to the same point
    // (i === 0 → 12 o'clock, i === halfBins-1 → 6 o'clock). Drawing them
    // twice is invisible for the opaque outer bars but compounds the
    // 0.35-alpha inner mirror to ~0.58, leaving two over-bright anchor
    // spires. Draw the poles once so every inner mirror shares one alpha.
    const isPole = (i === 0 || i === halfBins - 1);
    const angles = isPole
      ? [-Math.PI / 2 + angleOffset]
      : [
          -Math.PI / 2 + angleOffset,  // right half (clockwise from top)
          -Math.PI / 2 - angleOffset,  // left half (counter-clockwise from top)
        ];

    for (const angle of angles) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      ctx.strokeStyle = theme.color(i, halfBins, t);
      ctx.lineWidth = arcWidth;
      ctx.lineCap = 'round';

      // Outer bars
      ctx.beginPath();
      ctx.moveTo(centerX + cos * baseRadius, centerY + sin * baseRadius);
      ctx.lineTo(centerX + cos * (baseRadius + barLen), centerY + sin * (baseRadius + barLen));
      ctx.stroke();

      // Inner mirror (shorter, dimmer)
      ctx.globalAlpha = 0.35;
      const innerLen = val * maxBarLen * 0.4;
      ctx.beginPath();
      ctx.moveTo(centerX + cos * baseRadius, centerY + sin * baseRadius);
      ctx.lineTo(centerX + cos * (baseRadius - innerLen), centerY + sin * (baseRadius - innerLen));
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }
  }

  // Center ring outline
  ctx.strokeStyle = theme.color(0, halfBins, t);
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(centerX, centerY, baseRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1.0;
}

// ============================================================
// Mode: Spectrogram (scrolling time × frequency heatmap)
// ============================================================
function drawSpectrogram(ctx, w, h, theme, t) {
  // Clear on size change or first entry
  if (w !== spectroLastW || h !== spectroLastH) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    spectroLastW = w;
    spectroLastH = h;
  }

  // Shift existing content left
  const imageData = ctx.getImageData(SPECTRO_SCROLL_PX, 0, w - SPECTRO_SCROLL_PX, h);
  ctx.putImageData(imageData, 0, 0);

  // Clear the new column area
  ctx.fillStyle = '#000';
  ctx.fillRect(w - SPECTRO_SCROLL_PX, 0, SPECTRO_SCROLL_PX, h);

  analyser.getByteFrequencyData(freqData);

  // Map frequency bins to vertical pixels — low freq at bottom
  // Use lower ~60% of bins (above that is mostly silence for music)
  const usableBins = Math.floor(analyser.frequencyBinCount * 0.6);
  const sliceHeight = h / usableBins;

  for (let i = 0; i < usableBins; i++) {
    const val = freqData[i];
    if (val < 3) continue; // skip silence for performance

    const y = h - (i + 1) * sliceHeight;
    // Color from frequency position (via theme), intensity from amplitude
    ctx.fillStyle = theme.color(i, usableBins, t);
    ctx.globalAlpha = Math.max(0.08, (val / 255) * (val / 255));
    ctx.fillRect(w - SPECTRO_SCROLL_PX, y, SPECTRO_SCROLL_PX, Math.ceil(sliceHeight));
  }
  ctx.globalAlpha = 1.0;
}

// ============================================================
// Mode: Particles (audio-reactive particle field)
// ============================================================
function drawParticles(ctx, w, h, theme, t) {
  // Persistence trail
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.fillRect(0, 0, w, h);

  ensureParticles(w, h);
  analyser.getByteFrequencyData(freqData);

  // Energy bands
  const binCount = analyser.frequencyBinCount;
  const bassEnd = Math.floor(binCount * 0.08);
  const midStart = Math.floor(binCount * 0.08);
  const midEnd = Math.floor(binCount * 0.3);

  let bassEnergy = 0;
  for (let i = 0; i < bassEnd; i++) bassEnergy += freqData[i];
  bassEnergy = bassEnergy / Math.max(1, bassEnd) / 255;

  let midEnergy = 0;
  for (let i = midStart; i < midEnd; i++) midEnergy += freqData[i];
  midEnergy = midEnergy / Math.max(1, midEnd - midStart) / 255;

  const force = bassEnergy * 3.5;

  for (const p of particles) {
    // Audio-reactive force
    p.vx += (Math.random() - 0.5) * force;
    p.vy += (Math.random() - 0.5) * force;

    // Slight gravity toward center when bass is low
    if (bassEnergy < 0.15) {
      p.vx += (w / 2 - p.x) * 0.0003;
      p.vy += (h / 2 - p.y) * 0.0003;
    }

    // Damping
    p.vx *= 0.965;
    p.vy *= 0.965;
    p.x += p.vx;
    p.y += p.vy;

    // Wrap edges
    if (p.x < 0) p.x += w;
    if (p.x > w) p.x -= w;
    if (p.y < 0) p.y += h;
    if (p.y > h) p.y -= h;

    // Size reacts to bass
    const size = p.size * (1 + bassEnergy * 4.5);

    // Color from theme using particle's assigned bin
    const colorIdx = Math.min(p.bin, 63);
    ctx.fillStyle = theme.color(colorIdx, 64, t);
    ctx.globalAlpha = 0.4 + midEnergy * 0.55;

    ctx.beginPath();
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1.0;
}

// ============================================================
// Mode: Nova (particles on steroids — big glowing orbs)
// ============================================================
const NOVA_COUNT = 100;
let novaParticles = [];
let novaW = 0;
let novaH = 0;

function ensureNova(w, h) {
  if (novaParticles.length === NOVA_COUNT && novaW === w && novaH === h) return;
  novaW = w;
  novaH = h;
  novaParticles = [];
  for (let i = 0; i < NOVA_COUNT; i++) {
    novaParticles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 1.2,
      vy: (Math.random() - 0.5) * 1.2,
      size: Math.random() * 5 + 3,
      bin: Math.floor(Math.random() * 64),
    });
  }
}

function drawNova(ctx, w, h, theme, t) {
  // Slower trail decay — orbs leave longer streaks
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, w, h);

  ensureNova(w, h);
  analyser.getByteFrequencyData(freqData);

  const binCount = analyser.frequencyBinCount;
  const bassEnd = Math.floor(binCount * 0.08);
  const midStart = Math.floor(binCount * 0.08);
  const midEnd = Math.floor(binCount * 0.3);

  let bassEnergy = 0;
  for (let i = 0; i < bassEnd; i++) bassEnergy += freqData[i];
  bassEnergy = bassEnergy / Math.max(1, bassEnd) / 255;

  let midEnergy = 0;
  for (let i = midStart; i < midEnd; i++) midEnergy += freqData[i];
  midEnergy = midEnergy / Math.max(1, midEnd - midStart) / 255;

  const force = bassEnergy * 5;

  for (const p of novaParticles) {
    p.vx += (Math.random() - 0.5) * force;
    p.vy += (Math.random() - 0.5) * force;

    // Stronger center gravity during silence
    if (bassEnergy < 0.12) {
      p.vx += (w / 2 - p.x) * 0.0005;
      p.vy += (h / 2 - p.y) * 0.0005;
    }

    p.vx *= 0.96;
    p.vy *= 0.96;
    p.x += p.vx;
    p.y += p.vy;

    if (p.x < 0) p.x += w;
    if (p.x > w) p.x -= w;
    if (p.y < 0) p.y += h;
    if (p.y > h) p.y -= h;

    // Much bigger expansion — 2-3x larger than regular particles
    const size = p.size * (1 + bassEnergy * 7);

    const colorIdx = Math.min(p.bin, 63);
    ctx.fillStyle = theme.color(colorIdx, 64, t);

    // Outer glow halo
    ctx.globalAlpha = 0.06 + midEnergy * 0.08;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size * 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Mid glow
    ctx.globalAlpha = 0.15 + midEnergy * 0.2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Core
    ctx.globalAlpha = 0.5 + midEnergy * 0.45;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1.0;
}

// ============================================================
// Mode: Matrix Rain (falling characters, frequency-driven brightness)
//
// Each column maps to a frequency bin (same layout as bars). Characters
// fall continuously; their brightness comes from the amplitude at that
// bin with an aggressive cubic falloff so quiet bins produce invisible
// columns. Music's natural frequency distribution creates organic gaps.
//
// Performance: cubic falloff skips ~60-70% of columns per frame. Visible
// columns draw ~8-15 characters via fillText. Typical draw count is
// 300-500 fillText calls/frame — well within budget. If profiling shows
// issues on weak devices, pre-rendering characters to a sprite sheet
// (drawImage instead of fillText) is the optimization path.
// ============================================================
function drawMatrix(ctx, w, h, theme, t) {
  // Slow trail decay — characters leave persistent tails
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.fillRect(0, 0, w, h);

  ensureMatrix(w, h);
  analyser.getByteFrequencyData(freqData);

  // Same bin subsampling as bars mode
  const rawBins = Math.floor(analyser.frequencyBinCount * 0.38);
  const binStep = rawBins / MATRIX_COL_COUNT;

  ctx.font = `bold ${matrixCharH}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i < MATRIX_COL_COUNT; i++) {
    const col = matrixColumns[i];
    const binIndex = Math.floor(i * binStep);
    const amplitude = freqData[binIndex] / 255;

    // Aggressive cubic falloff — only strongly active bins are visible
    const brightness = amplitude * amplitude * amplitude;

    // Advance the rain regardless of visibility
    col.headY += col.speed;

    // Occasional character mutation for the flicker effect
    if (Math.random() < 0.03) {
      const mutIdx = Math.floor(Math.random() * col.chars.length);
      col.chars[mutIdx] = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
    }

    // Reset when the trail has fully exited the canvas
    if (col.headY > h + matrixCharH * (MATRIX_TRAIL_LEN + 2)) {
      col.headY = -matrixCharH * Math.floor(Math.random() * 8);
      // Refresh character set on reset
      for (let r = 0; r < col.chars.length; r++) {
        col.chars[r] = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
      }
    }

    // Skip drawing for invisible columns
    if (brightness < 0.008) continue;

    const color = theme.color(i, MATRIX_COL_COUNT, t);
    ctx.fillStyle = color;

    // Draw the falling trail: head is brightest, fading behind
    const headRow = Math.floor(col.headY / matrixCharH);

    for (let r = 0; r < MATRIX_TRAIL_LEN; r++) {
      const rowY = (headRow - r) * matrixCharH;

      // Clip to canvas bounds
      if (rowY < -matrixCharH || rowY > h) continue;

      // Trail fade: head is full brightness, rest starts at 0.7 and decays.
      // The 30% drop from head to second character makes the leading edge pop.
      let trailAlpha;
      if (r === 0) {
        trailAlpha = 1.0;
      } else {
        trailAlpha = 0.7 * Math.pow(1 - (r - 1) / (MATRIX_TRAIL_LEN - 1), 1.5);
      }
      const alpha = brightness * trailAlpha;
      if (alpha < 0.02) continue;

      ctx.globalAlpha = alpha;
      const charIdx = ((headRow - r) % col.chars.length + col.chars.length) % col.chars.length;
      ctx.fillText(col.chars[charIdx], col.x, rowY);

      // White-hot head on peaks — only strong amplitudes push through
      // the cubic falloff to reach the 0.15 threshold, so most heads
      // stay in theme color and only genuine peaks go white.
      if (r === 0 && brightness > 0.15) {
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = Math.min(0.95, (brightness - 0.15) * 1.2);
        ctx.fillText(col.chars[charIdx], col.x, rowY);
        ctx.fillStyle = color;
      }
    }
  }

  ctx.globalAlpha = 1.0;
}

// ============================================================
// Mode: Terminal (scrolling bash-style frequency display)
//
// A bash terminal aesthetic. Lines scroll bottom-to-top. Each
// line is a prompt + 16 frequency bin labels whose brightness
// maps to amplitude. An easter egg system injects shell commands,
// fake errors, and interactive output at random intervals.
//
// Performance: ~37 visible lines × (1 prompt + 16 labels) = ~629
// fillText calls/frame. Comparable to Matrix Rain. Easter egg
// lines are cheaper (single fillText for output strings).
//
// OLED protection: scrolling cycles every pixel position. Easter
// eggs break the prompt pattern at the left edge. Some eggs use
// alternate prompts (root@reel:#) to shift left-edge characters.
// ============================================================
const TERM_PROMPT = 'visualizer@reel:~$ ';
const TERM_ROOT_PROMPT = 'root@reel:~# ';
const TERM_FREQ_LABELS = ['20', '32', '50', '80', '125', '200', '315', '500', '800', '1.2k', '2k', '3.2k', '5k', '8k', '12k', '16k'];
// Target frequencies in Hz for bin mapping
const TERM_FREQ_HZ = [20, 32, 50, 80, 125, 200, 315, 500, 800, 1200, 2000, 3200, 5000, 8000, 12000, 16000];
const TERM_LINE_INTERVAL = 125; // ms base between lines
const TERM_MAX_LINES = 200;
const TERM_SINGLE_EGG_CHANCE = 1 / 150;
const TERM_MULTI_EGG_CHANCE = 1 / 400;
const TERM_EGG_COOLDOWN = 12; // minimum lines between eggs

let termLines = [];
let termLastLineTime = 0;
let termCharH = 0;
let termLastW = 0;
let termLastH = 0;
let termEggCooldown = 0;
let termEggQueue = [];
let termBinIndices = null; // cached bin index map
let termLastSampleRate = 0;

// ---- Frequency bin mapping ----
function ensureTermBins() {
  const sr = audioCtx ? audioCtx.sampleRate : 44100;
  if (termBinIndices && termLastSampleRate === sr) return;
  termLastSampleRate = sr;
  const fftSize = analyser ? analyser.fftSize : 2048;
  termBinIndices = TERM_FREQ_HZ.map(freq => {
    const bin = Math.round(freq * fftSize / sr);
    return Math.min(bin, (fftSize / 2) - 1);
  });
}

function ensureTerminal(w, h) {
  const charH = Math.max(14, Math.floor(h / 35));
  if (termLastW === w && termLastH === h && termCharH === charH) return;
  termLastW = w;
  termLastH = h;
  termCharH = charH;
  // Reset lines on resize — fresh canvas
  termLines = [];
  termLastLineTime = 0;
  termEggCooldown = 0;
  termEggQueue = [];
}

// ---- Easter egg definitions ----
// Each egg: { type: 'single'|'multi', lines: fn(state, els) => array of line objects }
// Line object: { text, prompt?, isOutput? }
// prompt defaults to TERM_PROMPT for command lines; omitted for output-only lines.

function makeEggLines(cmd, output, prompt) {
  const lines = [{ text: cmd, prompt: prompt || TERM_PROMPT }];
  if (output !== undefined && output !== null) {
    const outputs = Array.isArray(output) ? output : [output];
    for (const o of outputs) {
      lines.push({ text: o, isOutput: true });
    }
  }
  return lines;
}

function getTermSingleEggs() {
  return [
    () => makeEggLines('whoami', 'visualizer@reel'),
    () => makeEggLines('pwd', '/media/music'),
    () => makeEggLines('echo $SHELL', '/bin/bash'),
    () => makeEggLines('echo "Hello, World!"', 'Hello, World!'),
    () => makeEggLines("alias play='listen --with-feeling'"),
    () => makeEggLines('cat /dev/urandom | head -1', generateGarbage()),
    () => makeEggLines('ping 127.0.0.1', '64 bytes from 127.0.0.1: time=0.042ms'),
    () => makeEggLines('man bass', 'No manual entry for bass'),
    () => makeEggLines('which visualizer', '/usr/local/bin/reel'),
    () => makeEggLines('true && echo "bass dropped"', 'bass dropped'),
    () => makeEggLines('echo $((RANDOM % 128))', String(Math.floor(Math.random() * 128))),
    () => makeEggLines('lls', 'bash: lls: command not found'),
    () => makeEggLines('sl', 'bash: sl: command not found'),
    () => makeEggLines('dir', 'bash: dir: command not found'),
    () => makeEggLines('cls', 'bash: cls: command not found'),
    () => makeEggLines('cowsay moo', 'bash: cowsay: command not found'),
    () => makeEggLines('ipconfig /all', '-bash: ipconfig: No such file or directory'),
    () => makeEggLines('Get-Process -Name "reel"', 'Get-Process: command not found'),
    // cat /proc/uptime — raw seconds
    () => {
      const ct = els.player ? els.player.currentTime : 0;
      const idle = (ct * 0.03).toFixed(2);
      return makeEggLines('cat /proc/uptime', `${ct.toFixed(2)} ${idle}`);
    },
  ];
}

function getTermMultiEggs(state, els) {
  return [
    // uptime (2 lines)
    () => {
      const ct = els.player ? els.player.currentTime : 0;
      const mins = Math.floor(ct / 60);
      const secs = Math.floor(ct % 60);
      const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
      // Load averages from bass/mid/high energy
      analyser.getByteFrequencyData(freqData);
      const binCount = analyser.frequencyBinCount;
      const bassEnd = Math.floor(binCount * 0.08);
      const midEnd = Math.floor(binCount * 0.3);
      const highEnd = Math.floor(binCount * 0.6);
      let bass = 0, mid = 0, high = 0;
      for (let i = 0; i < bassEnd; i++) bass += freqData[i];
      bass = (bass / Math.max(1, bassEnd) / 255).toFixed(2);
      for (let i = bassEnd; i < midEnd; i++) mid += freqData[i];
      mid = (mid / Math.max(1, midEnd - bassEnd) / 255).toFixed(2);
      for (let i = midEnd; i < highEnd; i++) high += freqData[i];
      high = (high / Math.max(1, highEnd - midEnd) / 255).toFixed(2);
      return makeEggLines('uptime', ` up ${timeStr}, 1 user, load average: ${bass} ${mid} ${high}`);
    },
    // stat now_playing (4 lines)
    () => {
      const m = state.media || {};
      const fname = [m.artist, m.title || m.filename].filter(Boolean).join(' - ');
      const ext = m.ext ? `.${m.ext}` : '';
      const size = m.sizeBytes || 0;
      const blocks = Math.ceil(size / 512);
      return makeEggLines('stat now_playing', [
        `  File: ${fname}${ext}`,
        `  Size: ${size}    Blocks: ${blocks}    IO Block: 4096`,
        `  Access: (0644/-rw-r--r--)`,
      ]);
    },
    // ssh visualizer@reel (5 lines)
    () => makeEggLines('ssh visualizer@reel', [
      "The authenticity of host 'reel (127.0.1.1)' can't be established.",
      'Key fingerprint is... wait',
      "You're already here?",
      'Host key verification failed.',
    ]),
    // Fake segfault (2 lines — no command, just output)
    () => [
      { text: 'Segmentation fault (core dumped)', isOutput: true },
      { text: '', prompt: TERM_PROMPT, isOutput: true },
    ],
    // sudo rm -rf /silence — 10 blank lines then root prompt return
    () => {
      const lines = [{ text: 'sudo rm -rf /silence', prompt: TERM_PROMPT }];
      for (let i = 0; i < 10; i++) lines.push({ text: '', isOutput: true });
      lines.push({ text: '', prompt: TERM_ROOT_PROMPT });
      return lines;
    },
    // apt reel (2 lines)
    () => makeEggLines('apt reel', 'ASCII Tape Cassette?'),
    // aptitude reel — "no easter eggs" (2 lines)
    () => makeEggLines('aptitude reel', 'There are no Easter Eggs in this program.'),
    // aptitude -vvvvvvv reel — ASCII tape cassette (~9 lines)
    // Interior width = 26 chars between │s, matching top/bottom borders
    () => makeEggLines('aptitude -vvvvvvv reel', [
      '   \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
      '   \u2502  \u256d\u2500\u2500\u2500\u2500\u256e  R E E L  \u256d\u2500\u2500\u2500\u2500\u256e \u2502',
      '   \u2502  \u2502 \u25ce  \u2502           \u2502  \u25ce \u2502 \u2502',
      '   \u2502  \u2570\u2500\u2500\u2500\u2500\u256f           \u2570\u2500\u2500\u2500\u2500\u256f \u2502',
      '   \u2502 \u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 \u2502',
      '   \u2502  \u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594\u2594  \u2502',
      '   \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
    ]),
    // claude && /skill quote — movie quotes from hacker/sci-fi films
    () => {
      const quotes = [
        // Hackers
        ['There is no right and wrong.', "There's only fun and boring."],
        ['The pool on the roof must have a leak.'],
        ["So, uh, what's your interest in Kate Libby, eh?", 'Academic? Purely sexual?', 'Homicidal.'],
        ['Remember, hacking is more than just a crime.', "It's a survival trait."],
        ['HACK THE PLANET!'],
        // Tron
        ['End of line.', '.', '.', '.', '.', '.', '.', '.', '.', '.', '.'],
        ['Greetings, programs.'],
        ["That's Tron. He fights for the Users."],
        ['Flynn! Am I still to create the perfect system?', '...Yeah?'],
        ['I fight for the Users!'],
        // The Matrix
        ["No, Neo. I'm trying to tell you that", "when you're ready, you won't have to."],
        ['You have to let it all go, Neo.', 'Fear, doubt, and disbelief. Free your mind.'],
        ['There is no spoon.'],
        ["Never send a human to do a machine's job."],
        ['Did you know that the first Matrix was designed to be a perfect human world? Where none suffered, where everyone would be happy. It was a disaster. No one would accept the program.'],
        // WarGames
        ['Greetings, Professor Falken.'],
        ['A strange game.', 'The only winning move is not to play.', 'How about a nice game of chess?'],
        ['Listen carefully. Path. Follow path. Gate. Open gate. Through gate. Close gate. Last ferry 6:37. Run. Run. Run.'],
        ["I loved it when you nuked Las Vegas. Suitably biblical ending to the place, don't you think?"],
        // WarGames — stalemate with tic-tac-toe
        [' X \u2502 O \u2502 X ', '\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u253c\u2500\u2500\u2500', ' O \u2502 X \u2502 O ', '\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u253c\u2500\u2500\u2500', ' X \u2502 O \u2502 X ', '', 'A strange game.', 'The only winning move is not to play.'],
      ];
      const q = quotes[Math.floor(Math.random() * quotes.length)];
      return makeEggLines('claude && /skill quote', q);
    },
  ];
}

function generateGarbage() {
  const chars = '█▓▒░╔╗╚╝║═┌┐└┘│─┬┴├┤┼▲▼◄►◊○●□■♦♣♥♠@#$%^&*~`;:?/|\\';
  let s = '';
  const len = 30 + Math.floor(Math.random() * 30);
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ---- Terminal draw ----
function drawTerminal(ctx, w, h, theme, t) {
  // Full clear — no persistence trail for terminal
  ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
  ctx.fillRect(0, 0, w, h);

  ensureTerminal(w, h);
  ensureTermBins();
  analyser.getByteFrequencyData(freqData);

  const now = performance.now();
  const charH = termCharH;
  const lineSpacing = Math.floor(charH * 1.3);
  const maxVisible = Math.ceil(h / lineSpacing) + 2;

  ctx.font = `${charH}px monospace`;
  ctx.textBaseline = 'top';

  // ---- Add new line(s) on tick ----
  if (termLastLineTime === 0) termLastLineTime = now;

  while (now - termLastLineTime >= TERM_LINE_INTERVAL) {
    termLastLineTime += TERM_LINE_INTERVAL;

    // Check egg queue first (multi-line eggs feed one line per tick)
    if (termEggQueue.length > 0) {
      termLines.push(termEggQueue.shift());
      if (termEggCooldown > 0) termEggCooldown--;
    } else {
      // Try easter egg
      let egged = false;
      if (termEggCooldown <= 0) {
        if (Math.random() < TERM_MULTI_EGG_CHANCE) {
          const pool = getTermMultiEggs(state, els);
          const egg = pool[Math.floor(Math.random() * pool.length)];
          const lines = egg();
          // First line goes now, rest queue
          termLines.push(lines[0]);
          for (let i = 1; i < lines.length; i++) termEggQueue.push(lines[i]);
          termEggCooldown = TERM_EGG_COOLDOWN;
          egged = true;
        } else if (Math.random() < TERM_SINGLE_EGG_CHANCE) {
          const pool = getTermSingleEggs();
          const egg = pool[Math.floor(Math.random() * pool.length)];
          const lines = egg();
          termLines.push(lines[0]);
          for (let i = 1; i < lines.length; i++) termEggQueue.push(lines[i]);
          termEggCooldown = TERM_EGG_COOLDOWN;
          egged = true;
        }
      } else {
        termEggCooldown--;
      }

      if (!egged) {
        // Normal frequency line — snapshot current amplitudes
        const amps = new Float32Array(16);
        for (let b = 0; b < 16; b++) {
          amps[b] = freqData[termBinIndices[b]] / 255;
        }
        termLines.push({ type: 'freq', amps });
      }
    }

    // Trim old lines
    if (termLines.length > TERM_MAX_LINES) {
      termLines.splice(0, termLines.length - TERM_MAX_LINES);
    }
  }

  // ---- Render visible lines bottom-to-top ----
  const totalLines = termLines.length;
  const startIdx = Math.max(0, totalLines - maxVisible);
  // Prompt uses a fixed neutral grey — readable on all theme backgrounds.
  // Dim frequency labels still use the theme color for visual coherence.
  const dimLabelColor = theme.color(0, 16, t);

  // Measure prompt width once
  ctx.font = `${charH}px monospace`;
  const promptWidth = ctx.measureText(TERM_PROMPT).width;
  const labelAreaWidth = w - promptWidth - 10; // 10px right margin
  const labelSlotWidth = labelAreaWidth / 16;

  for (let i = startIdx; i < totalLines; i++) {
    const line = termLines[i];
    const row = i - startIdx;
    // Lines render from bottom: newest at bottom, oldest at top
    const y = h - (totalLines - i) * lineSpacing;

    if (y < -lineSpacing || y > h + lineSpacing) continue;

    if (line.type === 'freq') {
      // Prompt prefix — fixed neutral grey, theme-independent
      ctx.fillStyle = '#8a959e';
      ctx.globalAlpha = 0.55;
      ctx.textAlign = 'left';
      ctx.fillText(TERM_PROMPT, 4, y);

      // Frequency labels — brightness from stored amplitude
      for (let b = 0; b < 16; b++) {
        const amp = line.amps[b];
        // Gentler falloff than Matrix — square instead of cubic
        const brightness = amp * amp;
        if (brightness < 0.01) {
          // Still show label very dimly for the terminal aesthetic
          ctx.fillStyle = dimLabelColor;
          ctx.globalAlpha = 0.08;
        } else {
          ctx.fillStyle = theme.color(b, 16, t);
          ctx.globalAlpha = 0.15 + brightness * 0.85;
        }
        const lx = promptWidth + 4 + b * labelSlotWidth;
        ctx.textAlign = 'center';
        ctx.fillText(TERM_FREQ_LABELS[b], lx + labelSlotWidth / 2, y);

        // White-hot overlay on peaks — same technique as Matrix Rain heads
        if (brightness > 0.5) {
          ctx.fillStyle = '#fff';
          ctx.globalAlpha = Math.min(0.9, (brightness - 0.5) * 1.8);
          ctx.fillText(TERM_FREQ_LABELS[b], lx + labelSlotWidth / 2, y);
        }
      }
    } else {
      // Easter egg line
      const prompt = line.prompt || '';
      const text = line.text || '';

      if (prompt) {
        // Command line: prompt in neutral grey
        ctx.fillStyle = '#8a959e';
        ctx.globalAlpha = 0.55;
        ctx.textAlign = 'left';
        ctx.fillText(prompt, 4, y);

        if (text) {
          ctx.fillStyle = theme.color(8, 16, t);
          ctx.globalAlpha = 0.8;
          const px = ctx.measureText(prompt).width + 4;
          ctx.fillText(text, px, y);
        }
      } else if (line.isOutput) {
        // Output-only line (no prompt)
        ctx.fillStyle = theme.color(8, 16, t);
        ctx.globalAlpha = 0.75;
        ctx.textAlign = 'left';
        ctx.fillText(text, 4, y);
      }
    }
  }

  ctx.globalAlpha = 1.0;
  ctx.textAlign = 'left';
}

// ============================================================
// Start / stop
// ============================================================
export function startViz() {
  if (vizAnimFrame) return;
  draw();
}

export function stopViz() {
  if (vizAnimFrame) {
    cancelAnimationFrame(vizAnimFrame);
    vizAnimFrame = null;
  }
}

// ============================================================
// Init / cleanup
// ============================================================
export function initVisualizer(_state, _els) {
  state = _state;
  els = _els;
}

export function cleanupVisualizer() {
  stopViz();
  if (audioCtx) {
    audioCtx.close().catch(() => {});
  }
}
