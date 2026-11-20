/**
 * WebAudio graph skeleton: buses → (world low-shelf + low-pass for closeness / muffle) → master →
 * limiter → destination, shared noise buffers, and node accounting (`nodes` is what
 * `AudioStats.nodes` reports — every node made through the helpers is counted until `free`d).
 *
 *   ambience ─┐
 *   sfx ──────┴→ worldShelf → worldLP ─┐
 *   music ─────────────────────────────┼→ master → air LP → compressor → trim → soft clip → destination
 *   ui ────────────────────────────────┘
 *
 * Works on any BaseAudioContext, so the same code renders into an OfflineAudioContext for tests.
 */
import type { AudioBus } from '../core';
import { brownNoise, makeRand, pinkNoise, whiteNoise } from './dsp';
import { muffleCutoff } from './mix';

export type NoiseColour = 'white' | 'pink' | 'brown';

/** Nothing above this reaches the speakers at full level (no harsh highs from noise bursts / saws). */
export const AIR_CUTOFF = 8500;
/** Gain after the compressor: removes its automatic make-up gain and leaves headroom. */
export const OUTPUT_TRIM = 0.5;
/** Absolute output ceiling enforced by the soft clipper. */
export const CEILING = 0.9;

/** Transparent below ~half scale, then bends smoothly into ±CEILING (inputs beyond ±1 clamp there). */
export function softClipCurve(n = 2049): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = 1.6;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = (CEILING * Math.tanh(k * x)) / norm;
  }
  return curve;
}

export class Engine {
  nodes = 0;
  readonly master: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly air: BiquadFilterNode;
  readonly trim: GainNode;
  readonly clip: WaveShaperNode;
  readonly worldShelf: BiquadFilterNode;
  readonly worldLP: BiquadFilterNode;
  readonly buses: Record<AudioBus, GainNode>;
  readonly noise: Record<NoiseColour, AudioBuffer>;
  /** Until this context time the muffle filter is owned by a possession sweep. */
  private sweepUntil = 0;
  private lastCutoff = -1;
  private lastShelf = -99;

  constructor(readonly ctx: BaseAudioContext) {
    this.master = this.gain(1);
    // master → air low-pass → compressor → fixed trim → soft clipper → destination.
    // Chromium's DynamicsCompressor adds automatic make-up gain (several dB with these settings)
    // and lets fast transients through, so it cannot be the last stage: the trim takes the make-up
    // back out and the waveshaper is a hard guarantee that |output| stays below CEILING.
    this.air = this.filter('lowpass', AIR_CUTOFF, 0.5);
    this.limiter = this.track(ctx.createDynamicsCompressor());
    this.limiter.threshold.value = -16;
    this.limiter.knee.value = 10;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.trim = this.gain(OUTPUT_TRIM);
    this.clip = this.track(ctx.createWaveShaper());
    this.clip.curve = softClipCurve();
    this.clip.oversample = '2x';
    this.master.connect(this.air);
    this.air.connect(this.limiter);
    this.limiter.connect(this.trim);
    this.trim.connect(this.clip);
    this.clip.connect(ctx.destination);
    this.worldShelf = this.filter('lowshelf', 180, 0.7);
    this.worldShelf.gain.value = 0;
    this.worldLP = this.filter('lowpass', 18000, 0.5);
    this.worldShelf.connect(this.worldLP);
    this.worldLP.connect(this.master);
    this.buses = { ambience: this.gain(1), sfx: this.gain(1), music: this.gain(1), ui: this.gain(1) };
    this.buses.ambience.connect(this.worldShelf);
    this.buses.sfx.connect(this.worldShelf);
    this.buses.music.connect(this.master);
    this.buses.ui.connect(this.master);
    const n = Math.floor(ctx.sampleRate * 2);
    const rand = makeRand(4242);
    this.noise = {
      white: this.buffer(whiteNoise(n, rand), ctx.sampleRate),
      pink: this.buffer(pinkNoise(n, rand), ctx.sampleRate),
      brown: this.buffer(brownNoise(n, rand), ctx.sampleRate),
    };
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  // ---- node factories (all counted) ----------------------------------------------------------

  track<T extends AudioNode>(node: T): T {
    this.nodes++;
    return node;
  }
  gain(value = 1): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = value;
    return g;
  }
  osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = this.track(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    return o;
  }
  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.track(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }
  source(buffer: AudioBuffer, loop = false): AudioBufferSourceNode {
    const s = this.track(this.ctx.createBufferSource());
    s.buffer = buffer;
    s.loop = loop;
    return s;
  }
  delay(seconds: number): DelayNode {
    const d = this.track(this.ctx.createDelay(Math.max(0.05, seconds * 1.5)));
    d.delayTime.value = seconds;
    return d;
  }
  panner(): PannerNode {
    const p = this.track(this.ctx.createPanner());
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    return p;
  }
  buffer(data: Float32Array, sampleRate: number): AudioBuffer {
    const b = this.ctx.createBuffer(1, data.length, sampleRate);
    b.getChannelData(0).set(data);
    return b;
  }

  /** Stop (if it is a source) and disconnect nodes, and take them off the count. */
  free(nodes: readonly AudioNode[]): void {
    for (const n of nodes) {
      try {
        (n as Partial<AudioScheduledSourceNode>).stop?.();
      } catch {
        /* never started / already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
      this.nodes--;
    }
  }

  // ---- world tone --------------------------------------------------------------------------

  /** Muffle 0..1 → world low-pass; closeness 0..1 → a few dB of low shelf (closer = bassier). */
  setWorldTone(muffle: number, closeness: number): void {
    const t = this.now;
    const shelf = Math.round(closeness * 50) / 10; // 0..5 dB in 0.1 steps
    if (shelf !== this.lastShelf) {
      this.lastShelf = shelf;
      this.worldShelf.gain.setTargetAtTime(shelf, t, 0.3);
    }
    if (t < this.sweepUntil) return;
    const cutoff = Math.round(muffleCutoff(muffle) / 20) * 20;
    if (cutoff !== this.lastCutoff) {
      this.lastCutoff = cutoff;
      this.worldLP.frequency.setTargetAtTime(cutoff, t, 0.25);
    }
  }

  /** Possession whoosh: dip the world low-pass, then let it open towards the current target. */
  sweepWorld(from: number, seconds: number, muffleAfter: number): void {
    const t = this.now;
    const f = this.worldLP.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(Math.max(120, from), t);
    f.exponentialRampToValueAtTime(muffleCutoff(muffleAfter), t + seconds);
    this.sweepUntil = t + seconds;
    this.lastCutoff = -1;
  }

  close(): void {
    const ctx = this.ctx as Partial<AudioContext>;
    try {
      this.limiter.disconnect();
      this.clip.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (ctx.state !== 'closed') void ctx.close?.().catch(() => {});
    } catch {
      /* ignore */
    }
    this.nodes = 0;
  }
}

/** The AudioContext constructor, or null where WebAudio does not exist (node, old browsers). */
export function audioContextCtor(): (new () => AudioContext) | null {
  const g = globalThis as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}
