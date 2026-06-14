/**
 * Reel — Visualizer.
 * Web Audio API analyser with multiple render modes and color themes.
 *
 * Modes:  bars, lines, circular, spectrogram, particles, nova, matrix
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
export const VIZ_STYLES = ['bars', 'lines', 'circular', 'spectrogram', 'particles', 'nova', 'matrix'];
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
    default:            drawBars(ctx, w, h, theme, t);
  }
}

// ============================================================
// Mode: Bars (center-mirrored frequency bars)
// ============================================================
function drawBars(ctx, w, h, theme, t) {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  analyser.getByteFrequencyData(freqData);

  // Cap at 64 bars regardless of fftSize to preserve visual density
  const rawBins = Math.floor(analyser.frequencyBinCount * 0.38);
  const usableBins = Math.min(rawBins, 64);
  const binStep = rawBins / usableBins;
  const barWidth = w / (usableBins * 2);
  const centerX = w / 2;

  for (let i = 0; i < usableBins; i++) {
    const binIndex = Math.floor(i * binStep);
    const val = freqData[binIndex] / 255;
    const barHeight = val * h;

    ctx.fillStyle = theme.color(i, usableBins, t);

    const gap = Math.max(1, barWidth * 0.1);
    const bw = barWidth - gap;

    // Right side
    ctx.fillRect(centerX + i * barWidth + gap / 2, h - barHeight, bw, barHeight);
    // Left side (mirror)
    ctx.fillRect(centerX - (i + 1) * barWidth + gap / 2, h - barHeight, bw, barHeight);
  }
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
    const angles = [
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
