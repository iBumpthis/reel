/**
 * Reel — Visualizer.
 * Web Audio API analyser, frequency bars + waveform lines with persistence.
 */

let state, els;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let vizAnimFrame = null;
let freqData = null;
let waveData = null;

// ============================================================
// Themes — each returns a bar/line color given position + time
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
  },
  colorful: {
    bg: 'rgba(0, 0, 0, 0.92)',
    color: (i, count, _t) => {
      const hue = (i / count) * 280 + 200;
      return `hsl(${hue % 360}, 72%, 58%)`;
    },
  },
  rgb: {
    bg: 'rgba(0, 0, 0, 0.95)',
    color: (i, count, t) => {
      const hue = ((i / count) * 360 + t * 40) % 360;
      return `hsl(${hue}, 90%, 55%)`;
    },
  },
};

// ============================================================
// Audio context + analyser — lazy, one-time setup
// ============================================================
export function ensureAudioContext() {
  if (audioCtx && sourceNode) return true;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.88;
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
// Draw loop
// ============================================================
function draw() {
  vizAnimFrame = requestAnimationFrame(draw);

  const canvas = els.vizCanvas;
  const ctx = canvas.getContext('2d');

  // Sync canvas resolution to display size
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  const w = canvas.width;
  const h = canvas.height;
  const theme = VIZ_THEMES[state.currentTheme] || VIZ_THEMES.rgb;
  const t = performance.now() / 1000;

  if (state.vizStyle === 'bars') {
    drawBars(ctx, w, h, theme, t);
  } else {
    drawLines(ctx, w, h, theme, t);
  }
}

function drawBars(ctx, w, h, theme, t) {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  analyser.getByteFrequencyData(freqData);

  const usableBins = Math.floor(analyser.frequencyBinCount * 0.38);
  const barWidth = w / (usableBins * 2);
  const centerX = w / 2;

  for (let i = 0; i < usableBins; i++) {
    const val = freqData[i] / 255;
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

function drawLines(ctx, w, h, theme, t) {
  // Persistence decay — partial clear creates trailing effect
  ctx.fillStyle = 'rgba(0, 0, 0, 0.11)';
  ctx.fillRect(0, 0, w, h);

  analyser.getByteTimeDomainData(waveData);

  const count = waveData.length;
  const centerY = h / 2;

  // Layered copies with Y offset — center full opacity, outers fade
  const layers = [
    { offset: 0,   alpha: 1.0  },
    { offset: -18, alpha: 0.55 },
    { offset:  18, alpha: 0.55 },
    { offset: -36, alpha: 0.3  },
    { offset:  36, alpha: 0.3  },
    { offset: -54, alpha: 0.1  },
    { offset:  54, alpha: 0.1  },
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
