/**
 * Pure DSP: noise colours, filters, one-shot renderers and the pre-rendered ambience beds. No
 * WebAudio here — everything renders into Float32Arrays (unit-testable in node). The engine wraps
 * the results in AudioBuffers; beds are rendered at `BED_RATE` (resampled on playback) to keep
 * memory small.
 */
import type { AmbienceLayerId } from '../core';

export const BED_RATE = 24000;

export type Rand = () => number;

/** mulberry32 — audio never touches the sim RNG. */
export function makeRand(seed: number): Rand {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function whiteNoise(n: number, rand: Rand): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** Paul Kellet's economy pink filter over white noise. */
export function pinkNoise(n: number, rand: Rand): Float32Array {
  const out = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
  return normalize(out, 0.98);
}

export function brownNoise(n: number, rand: Rand): Float32Array {
  const out = new Float32Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = (v + (rand() * 2 - 1) * 0.02) * 0.998;
    out[i] = v;
  }
  return normalize(out, 0.98);
}

export type FilterMode = 'lp' | 'hp' | 'bp';

/**
 * Chamberlin state-variable filter, in place, run 2× oversampled so it stays stable up to
 * ~0.4·sr. `freq` may be a per-sample function (sweeps).
 */
export function svf(buf: Float32Array, sr: number, mode: FilterMode, freq: number | ((i: number) => number), q = 0.7): Float32Array {
  let low = 0;
  let band = 0;
  let high = 0;
  const damp = Math.min(1.9, 1 / Math.max(0.3, q));
  const coef = (hz: number): number => 2 * Math.sin((Math.PI * Math.min(Math.max(hz, 5), sr * 0.4)) / (sr * 2));
  const fixed = typeof freq === 'number' ? coef(freq) : 0;
  for (let i = 0; i < buf.length; i++) {
    const f = typeof freq === 'number' ? fixed : coef(freq(i));
    const x = buf[i];
    for (let k = 0; k < 2; k++) {
      low += f * band;
      high = x - low - damp * band;
      band += f * high;
    }
    buf[i] = mode === 'lp' ? low : mode === 'hp' ? high : band;
  }
  return buf;
}

export function scale(buf: Float32Array, g: number): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/** Scale so the absolute peak equals `peak` (silence stays silence). */
export function normalize(buf: Float32Array, peak = 0.9): Float32Array {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  return m > 1e-9 ? scale(buf, peak / m) : buf;
}

/** Mix `src` into `dst` starting at sample `at` (clipped to the buffer; `wrap` loops around). */
export function mixInto(dst: Float32Array, src: Float32Array, at: number, gain = 1, wrap = false): void {
  const n = dst.length;
  for (let i = 0; i < src.length; i++) {
    let j = at + i;
    if (j >= n) {
      if (!wrap) break;
      j %= n;
    }
    if (j >= 0) dst[j] += src[i] * gain;
  }
}

/** Crossfade the tail into the head so the (shortened) buffer loops seamlessly. */
export function makeLoopable(buf: Float32Array, fade: number): Float32Array {
  const n = buf.length - fade;
  if (fade <= 0 || n <= fade) return buf;
  const out = buf.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    // equal-power crossfade between the tail (fading out) and the head (fading in)
    out[i] = buf[i] * Math.sin((t * Math.PI) / 2) + buf[n + i] * Math.cos((t * Math.PI) / 2);
  }
  return out;
}

export interface BufferStats {
  peak: number;
  rms: number;
  nan: number;
  length: number;
}

export function analyze(buf: Float32Array): BufferStats {
  let peak = 0;
  let sum = 0;
  let nan = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!Number.isFinite(v)) {
      nan++;
      continue;
    }
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, buf.length)), nan, length: buf.length };
}

// ---- one-shot renderers ---------------------------------------------------------------------

/** Sine sweep f0→f1 (exponential) with a smooth attack/decay envelope. */
export function renderChirp(sr: number, f0: number, f1: number, dur: number, attack = 0.15): Float32Array {
  const n = Math.max(1, Math.floor(sr * dur));
  const out = new Float32Array(n);
  let phase = 0;
  const ratio = f1 / f0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += (2 * Math.PI * f0 * Math.pow(ratio, t)) / sr;
    const env = t < attack ? t / attack : Math.pow(1 - (t - attack) / (1 - attack), 1.6);
    out[i] = Math.sin(phase) * env;
  }
  return out;
}

/** Very short filtered-noise click (chitin tick, clock tick). */
export function renderClick(sr: number, freq: number, dur: number, rand: Rand): Float32Array {
  const n = Math.max(8, Math.floor(sr * dur));
  const out = whiteNoise(n, rand);
  svf(out, sr, 'bp', freq, 2.5);
  for (let i = 0; i < n; i++) out[i] *= Math.pow(1 - i / n, 3);
  return normalize(out, 1);
}

/** Low thud: decaying sine dropping in pitch plus a soft noise transient. */
export function renderThud(sr: number, freq: number, dur: number, rand: Rand): Float32Array {
  const n = Math.max(8, Math.floor(sr * dur));
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += (2 * Math.PI * freq * (1 - 0.5 * t)) / sr;
    out[i] = Math.sin(phase) * Math.pow(1 - t, 2.5) + (rand() * 2 - 1) * 0.25 * Math.pow(1 - t, 12);
  }
  return normalize(out, 1);
}

// ---- ambience beds ----------------------------------------------------------------------------

/** Slow loop-periodic swell 0..1: a few sines whose periods divide the loop length. */
function swell(i: number, n: number, rand: [number, number, number], depth: number): number {
  const p = (i / n) * Math.PI * 2;
  const v = 0.5 + 0.25 * Math.sin(p + rand[0] * 6.28) + 0.15 * Math.sin(2 * p + rand[1] * 6.28) + 0.1 * Math.sin(3 * p + rand[2] * 6.28);
  return 1 - depth + depth * v;
}

const sec = (s: number, sr: number): number => Math.floor(s * sr);

function windBed(sr: number, rand: Rand, seconds: number, colour: 'pink' | 'brown' | 'white', mode: FilterMode, f: number, q: number, depth: number, whistle = 0): Float32Array {
  const fade = sec(0.4, sr);
  const n = sec(seconds, sr) + fade;
  const src = colour === 'pink' ? pinkNoise(n, rand) : colour === 'brown' ? brownNoise(n, rand) : whiteNoise(n, rand);
  const loopN = n - fade;
  const ph: [number, number, number] = [rand(), rand(), rand()];
  const ph2: [number, number, number] = [rand(), rand(), rand()];
  if (whistle > 0) svf(src, sr, mode, (i) => f * (1 + whistle * (swell(i % loopN, loopN, ph2, 1) - 0.5)), q);
  else svf(src, sr, mode, f, q);
  for (let i = 0; i < n; i++) src[i] *= swell(i % loopN, loopN, ph, depth);
  return normalize(makeLoopable(src, fade), 0.8);
}

const BED_SEEDS: Record<AmbienceLayerId, number> = {
  breeze: 11,
  birds: 12,
  insects: 13,
  crickets: 14,
  nightWind: 15,
  forest: 16,
  desertWind: 17,
  underground: 18,
  skitter: 19,
  roomTone: 20,
  clockTick: 21,
  lampHum: 22,
  rain: 23,
  rainClose: 24,
  gusts: 25,
  flood: 26,
};

/** Render one loopable ambience bed (mono, peak ≤ 0.9). Deterministic per layer. */
export function renderBed(id: AmbienceLayerId, sr = BED_RATE): Float32Array {
  const rand = makeRand(BED_SEEDS[id] * 7919);
  switch (id) {
    case 'breeze':
      return windBed(sr, rand, 7, 'pink', 'lp', 650, 0.7, 0.55);
    case 'nightWind':
      return windBed(sr, rand, 8, 'brown', 'lp', 320, 0.7, 0.6);
    case 'desertWind':
      return windBed(sr, rand, 8.5, 'white', 'bp', 850, 2.2, 0.6, 0.7);
    case 'gusts':
      return windBed(sr, rand, 6.5, 'pink', 'bp', 420, 1.1, 0.8, 0.9);
    case 'underground': {
      const b = windBed(sr, rand, 6, 'brown', 'lp', 95, 0.9, 0.35);
      return normalize(b, 0.85);
    }
    case 'roomTone': {
      const b = windBed(sr, rand, 5, 'pink', 'lp', 260, 0.7, 0.15);
      for (let i = 0; i < b.length; i++) b[i] += 0.05 * Math.sin((2 * Math.PI * 100 * i) / sr);
      return normalize(b, 0.7);
    }
    case 'lampHum': {
      // whole number of 100 Hz periods in 2 s → seamless without a crossfade
      const n = sec(2, sr);
      const out = pinkNoise(n, rand);
      svf(out, sr, 'hp', 3000, 0.7);
      for (let i = 0; i < n; i++) {
        const p = (2 * Math.PI * i) / sr;
        out[i] = out[i] * 0.04 + 0.5 * Math.sin(100 * p) + 0.22 * Math.sin(200 * p + 0.4) + 0.12 * Math.sin(300 * p + 1.1) + 0.05 * Math.sin(500 * p);
      }
      return normalize(out, 0.6);
    }
    case 'clockTick': {
      const out = new Float32Array(sec(2, sr));
      mixInto(out, renderClick(sr, 2300, 0.03, rand), sec(0.02, sr), 0.9);
      mixInto(out, renderClick(sr, 1700, 0.035, rand), sec(1.02, sr), 0.75);
      svf(out, sr, 'lp', 3500, 0.7);
      return normalize(out, 0.7);
    }
    case 'birds': {
      const out = new Float32Array(sec(9, sr));
      for (let k = 0; k < 8; k++) {
        let at = sec(0.3 + rand() * 8, sr);
        const base = 2400 + rand() * 2600;
        const g = 0.2 + rand() * 0.6;
        const notes = 2 + Math.floor(rand() * 4);
        for (let j = 0; j < notes; j++) {
          const up = rand() > 0.4;
          const f = base * (0.9 + rand() * 0.3);
          const dur = 0.05 + rand() * 0.09;
          mixInto(out, renderChirp(sr, f, f * (up ? 1.35 : 0.75), dur, 0.25), at, g, true);
          at += sec(dur + 0.03 + rand() * 0.07, sr);
        }
      }
      svf(out, sr, 'lp', 6000, 0.7); // distance
      return normalize(out, 0.8);
    }
    case 'crickets': {
      const out = new Float32Array(sec(4.05, sr));
      for (const [freq, period, off, g] of [
        [4300, 0.45, 0.02, 0.8],
        [3900, 0.675, 0.2, 0.5],
        [4750, 0.81, 0.33, 0.35],
      ] as const) {
        const pulse = renderChirp(sr, freq, freq * 1.02, 0.018, 0.3);
        for (let t = off; t < 4.05 - 0.12; t += period) for (let p = 0; p < 3; p++) mixInto(out, pulse, sec(t + p * 0.03, sr), g);
      }
      return normalize(out, 0.7);
    }
    case 'insects': {
      const fade = sec(0.3, sr);
      const n = sec(5, sr) + fade;
      const out = whiteNoise(n, rand);
      svf(out, sr, 'bp', 5600, 9);
      const loopN = n - fade;
      const ph: [number, number, number] = [rand(), rand(), rand()];
      for (let i = 0; i < n; i++) {
        const trem = 0.55 + 0.45 * Math.sin((2 * Math.PI * 42 * i) / sr);
        out[i] = (out[i] * trem + 0.02 * Math.sin((2 * Math.PI * 4200 * i) / sr)) * swell(i % loopN, loopN, ph, 0.7);
      }
      return normalize(makeLoopable(out, fade), 0.6);
    }
    case 'forest': {
      const out = windBed(sr, rand, 10, 'pink', 'lp', 900, 0.7, 0.4);
      scale(out, 0.6);
      // creaks: stick-slip low sweeps
      for (let k = 0; k < 3; k++) {
        const dur = 0.5 + rand() * 0.6;
        const c = renderChirp(sr, 70 + rand() * 40, 110 + rand() * 60, dur, 0.3);
        const rate = 18 + rand() * 14;
        for (let i = 0; i < c.length; i++) c[i] *= Math.pow(0.5 + 0.5 * Math.sin((2 * Math.PI * rate * i) / sr), 4);
        mixInto(out, c, sec(1 + k * 3 + rand() * 1.5, sr), 0.5, true);
      }
      // leaf rustles
      for (let k = 0; k < 5; k++) {
        const r = whiteNoise(sec(0.25 + rand() * 0.3, sr), rand);
        svf(r, sr, 'hp', 3000, 0.7);
        for (let i = 0; i < r.length; i++) r[i] *= Math.sin((Math.PI * i) / r.length) ** 2 * (0.4 + 0.6 * rand());
        mixInto(out, r, sec(rand() * 9.5, sr), 0.18, true);
      }
      return normalize(out, 0.8);
    }
    case 'skitter': {
      const out = new Float32Array(sec(3, sr));
      for (let k = 0; k < 16; k++) {
        let at = sec(rand() * 2.9, sr);
        const taps = 3 + Math.floor(rand() * 6);
        const g = 0.25 + rand() * 0.75;
        for (let j = 0; j < taps; j++) {
          mixInto(out, renderClick(sr, 2500 + rand() * 4000, 0.004 + rand() * 0.004, rand), at, g, true);
          at += sec(0.018 + rand() * 0.03, sr);
        }
      }
      return normalize(out, 0.7);
    }
    case 'rain': {
      const fade = sec(0.4, sr);
      const n = sec(6, sr) + fade;
      const hiss = whiteNoise(n, rand);
      svf(hiss, sr, 'hp', 1800, 0.7);
      const body = pinkNoise(n, rand);
      svf(body, sr, 'lp', 3500, 0.7);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = hiss[i] * 0.35 + body[i] * 0.9;
      // patter: dense tiny drops
      for (let k = 0; k < 420; k++) mixInto(out, renderClick(sr, 1500 + rand() * 5000, 0.006, rand), Math.floor(rand() * (n - 200)), 0.25 + rand() * 0.5);
      return normalize(makeLoopable(out, fade), 0.8);
    }
    case 'rainClose': {
      const out = new Float32Array(sec(5, sr));
      for (let k = 0; k < 14; k++) {
        const at = sec(rand() * 4.6, sr);
        const g = 0.35 + rand() * 0.65;
        mixInto(out, renderThud(sr, 70 + rand() * 60, 0.22, rand), at, g, true);
        const splash = whiteNoise(sec(0.12, sr), rand);
        svf(splash, sr, 'bp', 2200 + rand() * 1500, 1.2);
        for (let i = 0; i < splash.length; i++) splash[i] *= Math.pow(1 - i / splash.length, 2);
        mixInto(out, splash, at + sec(0.015, sr), g * 0.6, true);
      }
      return normalize(out, 0.85);
    }
    case 'flood': {
      const out = windBed(sr, rand, 6, 'pink', 'lp', 520, 0.8, 0.45);
      for (let k = 0; k < 40; k++) {
        const f = 180 + rand() * 500;
        mixInto(out, renderChirp(sr, f, f * (1.3 + rand() * 0.6), 0.04 + rand() * 0.05, 0.3), Math.floor(rand() * out.length), 0.2 + rand() * 0.25, true);
      }
      return normalize(out, 0.8);
    }
  }
}

export const BED_IDS: readonly AmbienceLayerId[] = Object.keys(BED_SEEDS) as AmbienceLayerId[];
