import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Cover } from './components';
import './visualizer.css';

const width = 480;
const height = 300;
const turn = 2 * Math.PI;
type Levels = readonly [energy: number, low: number, mid: number, high: number];
type Painter = (
  ctx: CanvasRenderingContext2D,
  phase: number,
  levels: Levels,
) => void;

const aurora: Painter = (ctx, phase, [energy, low, mid, high]) => {
  const colors = ctx.createLinearGradient(0, 0, width, height);
  colors.addColorStop(0, '#8e73ff');
  colors.addColorStop(0.42, '#e9aaff');
  colors.addColorStop(0.69, '#77a7ff');
  colors.addColorStop(1, '#84ffe2');
  ctx.strokeStyle = colors;
  for (let line = 0; line < 16; line++) {
    const spread = (line - 7.5) / 7.5;
    const accent = line % 5 === 0;
    ctx.lineWidth = (accent ? 1.2 : 0.65) + energy * (accent ? 1.2 : 0.35);
    ctx.globalAlpha =
      (accent ? 0.23 : 0.09) + energy * (accent ? 0.61 : 0.27 + high * 0.14);
    ctx.beginPath();
    for (let step = 0; step <= 60; step++) {
      const x = step / 60;
      const envelope = Math.sin(Math.PI * x);
      const wave =
        Math.sin(x * 8.1 + phase) * (5 + energy * (55 + 28 * low)) +
        Math.sin(x * 15 - phase * 1.3 + spread * 0.5) *
          (2 + energy * (11 + 17 * mid));
      const fan = spread * (7 + energy * (27 + mid * 20));
      const y = height * (0.73 - 0.46 * x) + envelope * (wave + fan);
      if (step === 0) ctx.moveTo(0, y);
      else ctx.lineTo(x * width, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

const orbit: Painter = (ctx, phase, [energy, low, mid, high]) => {
  const centerX = width / 2;
  const centerY = height / 2;
  ctx.strokeStyle = '#9187c7';
  ctx.globalAlpha = 0.09 + 0.15 * energy;
  ctx.lineWidth = 0.7;
  for (const radius of [66, 96, 126]) {
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, turn);
    ctx.stroke();
  }
  const colors = ['#b8baff', '#f18fd8', '#ab8cff'];
  for (let line = 0; line < 11; line++) {
    const spread = (line - 5) / 5;
    ctx.strokeStyle = colors[line % colors.length];
    const accent = line % 3 === 0;
    ctx.lineWidth = (accent ? 1.1 : 0.65) + energy * (accent ? 1 : 0.4);
    ctx.globalAlpha =
      (accent ? 0.22 : 0.09) + energy * (accent ? 0.64 : 0.29 + high * 0.1);
    ctx.beginPath();
    for (let step = 0; step <= 104; step++) {
      const angle = (turn * step) / 104;
      const radius =
        46 +
        line * (0.8 + energy * 1.05) +
        energy * (34 + low * 14) +
        (2 + energy * (16 + mid * 15)) *
          Math.sin(angle * 5 + phase + spread * 0.7) +
        energy * (2 + high * 7) * Math.sin(angle * 9 - phase);
      const x = centerX + radius * Math.cos(angle + spread * 0.13);
      const y = centerY + radius * Math.sin(angle + spread * 0.13);
      if (step === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

const horizon: Painter = (ctx, phase, [energy, low, mid, high]) => {
  const center = width / 2;
  const skyline = height * 0.59;
  const sunY = skyline - 44;
  const radius = 30 + energy * (17 + 10 * low);
  const sun = ctx.createLinearGradient(0, sunY - radius, 0, sunY + radius);
  sun.addColorStop(0, '#ffd599');
  sun.addColorStop(1, '#ee75b8');
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, sunY, radius, 0, turn);
  ctx.clip();
  ctx.fillStyle = sun;
  ctx.globalAlpha = 0.35 + 0.48 * energy;
  ctx.fillRect(center - radius, sunY - radius, radius * 2, radius * 2);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-out';
  for (let line = 0; line < 5; line++)
    ctx.fillRect(center - radius, sunY + line * 9, radius * 2, 1 + line * 0.6);
  ctx.restore();
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = '#9f71e5';
  ctx.globalAlpha = 0.13 + 0.24 * energy;
  for (let line = -9; line <= 9; line++) {
    ctx.beginPath();
    ctx.moveTo(center + line * 5, skyline);
    ctx.lineTo(center + line * 62, height);
    ctx.stroke();
  }
  for (let line = 0; line < 8; line++) {
    const distance = (line / 8 + phase * 0.19) % 1;
    const y = skyline + (height - skyline) * distance ** 2.35;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let line = 0; line < 6; line++) {
    const depth = line / 5;
    ctx.strokeStyle = line % 2 ? '#ffa3db' : '#b88bff';
    ctx.lineWidth = (line === 5 ? 1.1 : 0.7) + 0.8 * energy;
    ctx.globalAlpha = 0.12 + depth * 0.19 + energy * (0.22 + 0.35 * depth);
    ctx.beginPath();
    for (let step = 0; step <= 64; step++) {
      const x = step / 64;
      const wave =
        Math.sin(x * 29 + phase * 1.55 + depth * 2) *
          (2 + energy * (21 + 22 * low)) +
        Math.sin(x * 71 - phase) * energy * (4 + 13 * mid) +
        Math.cos(x * 113 + phase) * energy * 8 * high;
      const y =
        skyline + depth * 39 - Math.abs(wave) * (0.24 + Math.abs(2 * x - 1));
      if (step === 0) ctx.moveTo(0, y);
      else ctx.lineTo(width * x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
};

const styles = {
  aurora: { name: 'Aurora Ribbons', paint: aurora },
  orbit: { name: 'Orbit Bloom', paint: orbit },
  horizon: { name: 'Neon Horizon', paint: horizon },
};
export type VisualizerStyle = keyof typeof styles;

function startDrawing(
  ctx: CanvasRenderingContext2D,
  analyser: AnalyserNode,
  paint: Painter,
) {
  const data = new Uint8Array(analyser.frequencyBinCount);
  const waveform = new Float32Array(analyser.fftSize);
  const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
  const ranges = ([55, 250, 2000, 9000] as const).map((hz) =>
    Math.min(data.length, Math.ceil(hz / hzPerBin)),
  );
  function level(start: number, end: number) {
    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, data[i]);
    return peak / 255;
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const interval = reduced ? 100 : 40;
  let last = performance.now() - interval;
  let phase = 2.7;
  let energy = 0;
  let paintedSilence = false;
  let timer: ReturnType<typeof setTimeout>;
  function draw() {
    if (document.hidden) return;
    const now = performance.now();
    const elapsed = Math.min(now - last, 250);
    last = now;
    analyser.getFloatTimeDomainData(waveform);
    let squared = 0;
    let peak = 0;
    for (const sample of waveform) {
      squared += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    // A short waveform window follows the song's dynamics. Spectrum only shapes the motion.
    const rms = Math.sqrt(squared / waveform.length);
    const amplitude = 0.82 * rms + 0.18 * peak;
    const target = Math.min(
      1,
      Math.sqrt(Math.max(0, (amplitude - 0.004) * 2.8)),
    );
    const response = target > energy ? 18 : 85;
    energy = target + (energy - target) * Math.exp(-elapsed / response);
    if (target === 0 && energy < 0.018) energy = 0;
    if (energy > 0 || !paintedSilence) {
      if (energy > 0) analyser.getByteFrequencyData(data);
      phase += (elapsed / 1000) * (reduced ? 0.5 : 1.9) * energy;
      ctx.clearRect(0, 0, width, height);
      paint(ctx, phase, [
        energy,
        level(ranges[0], ranges[1]),
        level(ranges[1], ranges[2]),
        level(ranges[2], ranges[3]),
      ]);
      paintedSilence = energy === 0;
    }
    timer = setTimeout(draw, interval);
  }
  draw();
  return () => {
    clearTimeout(timer);
    ctx.clearRect(0, 0, width, height);
  };
}

export default function Visualizer({
  artwork,
  playing,
  watchAnalyser,
  style,
  onStyleChange,
  onClose,
}: {
  artwork: string;
  playing: boolean;
  watchAnalyser: (
    onChange: (analyser: AnalyserNode | null) => void,
  ) => (() => void) | undefined;
  style: VisualizerStyle;
  onStyleChange: (style: VisualizerStyle) => void;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const { paint } = styles[style];
  useEffect(() => {
    if (!playing || document.hidden) return;
    return watchAnalyser(setAnalyser);
  }, [playing, watchAnalyser]);
  useEffect(() => {
    if (!playing || !analyser) return;
    const ctx = canvas.current?.getContext('2d');
    if (ctx) return startDrawing(ctx, analyser, paint);
  }, [playing, analyser, paint]);

  return (
    <section
      className="music-visualizer"
      aria-label="Music visualizer"
      data-style={style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <Cover className="visualizer-artwork" src={artwork} alt="" />
      <canvas ref={canvas} width={width} height={height} aria-hidden="true" />
      <div className="visualizer-controls">
        <button
          type="button"
          className="back-library"
          onClick={onClose}
          autoFocus
        >
          <ArrowLeft size={21} aria-hidden="true" /> Now Playing
        </button>
        <select
          aria-label="Visualization style"
          value={style}
          onChange={(event) =>
            onStyleChange(event.target.value as VisualizerStyle)
          }
        >
          {Object.entries(styles).map(([key, option]) => (
            <option key={key} value={key}>
              {option.name}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
