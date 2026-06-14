/**
 * Reel — Visualizer.
 * Web Audio API analyser with multiple render modes and color themes.
 *
 * Modes:  bars, lines, circular, spectrogram, particles
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
    case 'bars':       drawBars(ctx, w, h, theme, t); break;
    case 'lines':      drawLines(ctx, w, h, theme, t); break;
    case 'circular':   drawCircular(ctx, w, h, theme, t); break;
    case 'spectrogram': drawSpectrogram(ctx, w, h, theme, t); break;
    case 'particles':  drawParticles(ctx, w, h, theme, t); break;
    default:           drawBars(ctx, w, h, theme, t);
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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  ctx.fillRect(0, 0, w, h);

  analyser.getByteTimeDomainData(waveData);

  const count = waveData.length;
  const centerY = h / 2;

  // Layered copies with Y offset — center full opacity, outers fade
  const layers = [
    { offset: 0,   alpha: 1.0  },
    { offset: -22, alpha: 0.45 },
    { offset:  22, alpha: 0.45 },
    { offset: -44, alpha: 0.15 },
    { offset:  44, alpha: 0.15 },
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
    const angleOffset = (i / halfBins) * Math.PI;
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
  ctx.strokeStyle = theme.color(0, usableBins, t);
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
function drawSpectrogram(ctx, w, h, theme, _t) {
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
    ctx.fillStyle = theme.amplitudeColor(val);
    ctx.fillRect(w - SPECTRO_SCROLL_PX, y, SPECTRO_SCROLL_PX, Math.ceil(sliceHeight));
  }
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
