/**
 * One-shot sound effects: tiny synth recipes (oscillator sweeps + filtered noise bursts with
 * envelopes) played as voices through the allocator. World sounds are spatialised with a
 * PannerNode relative to the listener (the camera); UI sounds go straight to the `ui` bus.
 *
 * Every node of a voice is created through the Engine (counted) and freed when the allocator
 * expires or steals the voice.
 */
import type { AudioBus, Vec3 } from '../core';
import type { Engine, NoiseColour } from './engine';
import { VoiceAllocator } from './voices';

/** Shortest envelope attack (seconds). */
export const MIN_ATTACK = 0.006;
/** Voice gain = recipe volume × this (world / UI). Deliberately modest — see the mix notes in index.ts. */
export const WORLD_GAIN = 0.8;
export const UI_GAIN = 0.9;

/** Node-graph builder handed to a recipe. Times are seconds relative to the voice start. */
export class Builder {
  readonly nodes: AudioNode[] = [];
  end = 0;
  constructor(
    readonly e: Engine,
    readonly t0: number,
    readonly out: AudioNode,
  ) {}

  private env(g: GainNode, at: number, dur: number, peak: number, attack: number): void {
    const t = this.t0 + at;
    // never faster than MIN_ATTACK: a 3 ms edge on a loud burst reads as a click
    const a = Math.min(Math.max(attack, MIN_ATTACK), dur * 0.5);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, peak * 0.001), t + dur);
    g.gain.setValueAtTime(0, t + dur + 0.005);
    if (at + dur > this.end) this.end = at + dur;
  }

  /** Oscillator sweeping f0→f1 over `dur` with an attack/exponential-decay envelope. */
  tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, at = 0, attack = 0.004): void {
    const e = this.e;
    const o = e.osc(type, f0);
    const g = e.gain(0);
    const t = this.t0 + at;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    this.env(g, at, dur, peak, attack);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.03);
    this.nodes.push(o, g);
  }

  /** Filtered noise burst; the filter frequency sweeps f0→f1. */
  noise(colour: NoiseColour, type: BiquadFilterType, f0: number, f1: number, q: number, dur: number, peak: number, at = 0, attack = 0.003): void {
    const e = this.e;
    const buf = e.noise[colour];
    const s = e.source(buf, true);
    const f = e.filter(type, f0, q);
    const g = e.gain(0);
    const t = this.t0 + at;
    f.frequency.setValueAtTime(Math.max(10, f0), t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    // filtered noise carries far less energy than a full-band burst: make up for it
    this.env(g, at, dur, peak * (type === 'lowpass' ? 1.6 : type === 'highpass' ? 2 : 3), attack);
    s.connect(f);
    f.connect(g);
    g.connect(this.out);
    s.start(t, Math.random() * (buf.duration - 0.05));
    s.stop(t + dur + 0.03);
    this.nodes.push(s, f, g);
  }
}

export interface SfxDef {
  bus: AudioBus;
  /** Allocator priority 0..10. */
  prio: number;
  /** Minimum seconds between two plays of this id (4× speed floods). */
  gap: number;
  vol: number;
  /** `v` = per-play pitch variation factor (≈ 0.9..1.1), `r` = random 0..1. */
  build(b: Builder, v: number, r: number): void;
}

const W = (prio: number, gap: number, vol: number, build: SfxDef['build']): SfxDef => ({ bus: 'sfx', prio, gap, vol, build });
const U = (vol: number, build: SfxDef['build'], gap = 0.03, prio = 6): SfxDef => ({ bus: 'ui', prio, gap, vol, build });

export const SFX: Readonly<Record<string, SfxDef>> = {
  // ---- colony work ----
  dig: W(2, 0.07, 0.5, (b, v) => {
    b.noise('pink', 'bandpass', 1300 * v, 600 * v, 1.4, 0.16, 0.9);
    b.noise('white', 'highpass', 3500, 2500, 0.7, 0.05, 0.25, 0.02);
  }),
  pellet: W(1, 0.09, 0.4, (b, v) => {
    b.tone('sine', 190 * v, 90 * v, 0.07, 0.8);
    b.noise('white', 'bandpass', 2400 * v, 1800, 2, 0.03, 0.4);
  }),
  build: W(2, 0.09, 0.45, (b, v) => {
    b.noise('brown', 'lowpass', 500 * v, 200, 1, 0.12, 1);
    b.tone('sine', 240 * v, 120 * v, 0.06, 0.35, 0.02);
  }),
  pickup: W(2, 0.1, 0.32, (b, v) => {
    b.tone('triangle', 520 * v, 780 * v, 0.07, 0.7);
  }),
  deliver: W(3, 0.12, 0.32, (b, v) => {
    b.tone('triangle', 620 * v, 620 * v, 0.07, 0.6);
    b.tone('triangle', 930 * v, 930 * v, 0.12, 0.6, 0.07);
  }),
  foodFound: W(4, 0.4, 0.34, (b, v) => {
    b.tone('sine', 700 * v, 1050 * v, 0.1, 0.5);
    b.tone('sine', 1050 * v, 1400 * v, 0.16, 0.5, 0.09);
  }),
  drop: W(1, 0.1, 0.3, (b, v) => {
    b.tone('sine', 220 * v, 140 * v, 0.05, 0.7);
  }),
  hatch: W(4, 0.2, 0.36, (b, v) => {
    b.noise('white', 'bandpass', 1800 * v, 3200 * v, 3, 0.05, 0.6);
    b.tone('sine', 480 * v, 960 * v, 0.2, 0.45, 0.04, 0.03);
  }),
  egg: W(1, 0.4, 0.35, (b, v) => {
    b.tone('sine', 880 * v, 660 * v, 0.06, 0.5);
  }),
  // ---- combat ----
  bite: W(5, 0.05, 0.35, (b, v) => {
    b.noise('white', 'highpass', 3200 * v, 3200 * v, 0.9, 0.018, 1);
    b.noise('white', 'bandpass', 5200 * v, 4200, 4, 0.022, 0.8, 0.035);
    b.tone('square', 150 * v, 80, 0.03, 0.2);
  }),
  sting: W(5, 0.06, 0.45, (b, v) => {
    b.tone('sawtooth', 2400 * v, 900 * v, 0.07, 0.35);
    b.noise('white', 'highpass', 5000, 5000, 0.7, 0.03, 0.5);
  }),
  acid: W(5, 0.08, 0.42, (b, v) => {
    b.noise('white', 'bandpass', 6500 * v, 3000, 1.5, 0.28, 0.8, 0, 0.02);
  }),
  glue: W(5, 0.08, 0.45, (b, v) => {
    b.noise('pink', 'bandpass', 500 * v, 1400 * v, 5, 0.18, 1, 0, 0.02);
    b.tone('sine', 300 * v, 180 * v, 0.1, 0.3, 0.05);
  }),
  hit: W(3, 0.06, 0.35, (b, v) => {
    b.tone('sine', 170 * v, 70, 0.06, 0.8);
    b.noise('white', 'bandpass', 1500 * v, 900, 1.5, 0.03, 0.4);
  }),
  stridulate: W(6, 0.25, 0.4, (b, v) => {
    for (let i = 0; i < 6; i++) b.tone('sawtooth', 2300 * v, 2500 * v, 0.022, 0.5, i * 0.034, 0.002);
  }),
  death: W(4, 0.09, 0.4, (b, v) => {
    b.tone('triangle', 420 * v, 110 * v, 0.22, 0.6);
    b.noise('white', 'bandpass', 2600, 800, 2, 0.1, 0.35, 0.02);
  }),
  queenDeath: W(10, 1, 0.35, (b) => {
    b.tone('sine', 220, 55, 1.6, 0.7, 0, 0.02);
    b.tone('triangle', 330, 82, 1.4, 0.35, 0.05, 0.02);
    b.noise('brown', 'lowpass', 400, 80, 1, 1.5, 0.6, 0, 0.05);
  }),
  // ---- creatures ----
  spiderPounce: W(8, 0.3, 0.22, (b, v) => {
    b.noise('pink', 'bandpass', 400 * v, 2600 * v, 1.2, 0.16, 0.8, 0, 0.05);
    b.tone('sine', 120 * v, 45, 0.22, 1, 0.15);
    b.noise('brown', 'lowpass', 600, 150, 1, 0.14, 0.8, 0.15);
  }),
  waspBuzz: W(7, 0.5, 0.3, (b, v, r) => {
    // doppler-ish: approach high, pass, recede low
    const f = 185 * v;
    const dur = 0.9 + r * 0.4;
    b.tone('sawtooth', f * 1.14, f * 0.86, dur, 0.4, 0, dur * 0.4);
    b.tone('sawtooth', f * 1.14 * 1.035, f * 0.86 * 1.035, dur, 0.4, 0, dur * 0.4);
    b.noise('white', 'bandpass', 2600, 1800, 3, dur, 0.15, 0, dur * 0.4);
  }),
  waspSting: W(8, 0.2, 0.3, (b, v) => {
    b.tone('sawtooth', 210 * v, 260 * v, 0.12, 0.5);
    b.noise('white', 'highpass', 4500, 4500, 0.7, 0.035, 0.8, 0.1);
  }),
  beetleThump: W(8, 0.2, 0.8, (b, v) => {
    b.tone('sine', 85 * v, 38, 0.3, 1);
    b.noise('brown', 'lowpass', 300, 90, 1, 0.2, 0.9);
    b.noise('white', 'bandpass', 1200, 700, 1.5, 0.04, 0.25);
  }),
  mantisStrike: W(9, 0.25, 0.2, (b, v) => {
    b.noise('white', 'bandpass', 900 * v, 5200 * v, 1.6, 0.09, 0.8, 0, 0.04);
    b.noise('white', 'highpass', 2800, 2800, 0.7, 0.03, 1, 0.09);
    b.tone('sine', 100 * v, 42, 0.3, 0.9, 0.09);
  }),
  antlionSnap: W(7, 0.25, 0.18, (b, v) => {
    b.noise('pink', 'lowpass', 1800, 300, 1, 0.3, 0.6, 0, 0.1);
    b.noise('white', 'highpass', 3000 * v, 3000, 0.7, 0.02, 1, 0.22);
  }),
  creatureAttack: W(6, 0.15, 0.5, (b, v) => {
    b.noise('white', 'bandpass', 2000 * v, 1200, 2, 0.05, 0.9);
    b.tone('sine', 130 * v, 60, 0.1, 0.6);
  }),
  creatureArrive: W(6, 1.5, 0.4, (b, v) => {
    b.noise('brown', 'lowpass', 250, 120, 1, 0.5, 1, 0, 0.1);
    b.tone('sine', 62 * v, 50, 0.5, 0.5, 0, 0.1);
  }),
  creatureDeath: W(7, 0.3, 0.6, (b, v) => {
    b.tone('sine', 140 * v, 36, 0.5, 0.9);
    b.noise('pink', 'lowpass', 1500, 200, 1, 0.4, 0.5);
  }),
  // ---- weather / world ----
  rainDrop: W(3, 0.08, 0.75, (b, v) => {
    b.tone('sine', 95 * v, 42, 0.22, 1);
    b.noise('white', 'bandpass', 2600 * v, 1300, 1.2, 0.14, 0.5, 0.012);
  }),
  rainTick: W(1, 0.05, 0.3, (b, v) => {
    b.noise('white', 'bandpass', 3800 * v, 2500, 2, 0.03, 0.8);
  }),
  thunder: W(9, 1.5, 0.36, (b, v, r) => {
    b.noise('white', 'highpass', 1800, 600, 0.7, 0.18, 0.7 * (1 - r * 0.6));
    b.noise('brown', 'lowpass', 500 * v, 55, 0.8, 3.4, 1, 0.03, 0.08);
    b.noise('brown', 'lowpass', 180, 40, 0.8, 2.6, 0.7, 0.6, 0.5);
    b.tone('sine', 55, 30, 2.2, 0.45, 0.05, 0.1);
  }),
  floodRush: W(7, 0.8, 0.3, (b, v) => {
    b.noise('pink', 'lowpass', 300, 1500 * v, 0.9, 1.3, 0.9, 0, 0.5);
    b.noise('brown', 'lowpass', 220, 120, 1, 1.3, 0.7, 0, 0.3);
  }),
  drip: W(3, 0.12, 0.4, (b, v) => {
    b.tone('sine', 1400 * v, 520 * v, 0.07, 0.7);
    b.tone('sine', 1700 * v, 700 * v, 0.06, 0.4, 0.16);
  }),
  sporeBurst: W(9, 0.6, 0.32, (b, v) => {
    b.noise('white', 'bandpass', 700, 5200, 2, 0.35, 0.5, 0, 0.1);
    const base = 1480 * v;
    for (const [m, at] of [
      [1, 0.05],
      [1.19, 0.14],
      [1.414, 0.22],
      [1.78, 0.33],
      [2.03, 0.45],
    ]) {
      b.tone('sine', base * m, base * m * 0.985, 2.2, 0.16, at, 0.25);
      b.tone('sine', base * m * 1.013, base * m, 2.2, 0.12, at, 0.25);
    }
  }),
  infect: W(6, 1, 0.3, (b, v) => {
    b.tone('sine', 920 * v, 860 * v, 0.9, 0.3, 0, 0.2);
    b.tone('sine', 975 * v, 1010 * v, 0.9, 0.3, 0, 0.2);
  }),
  wings: W(5, 0.15, 0.35, (b, v) => {
    b.tone('sawtooth', 240 * v, 330 * v, 0.5, 0.25, 0, 0.1);
    b.noise('white', 'bandpass', 3000, 4200, 2, 0.5, 0.2, 0, 0.1);
  }),
  sizzle: W(3, 0.3, 0.3, (b) => {
    b.noise('white', 'highpass', 6000, 4000, 0.7, 0.25, 0.7, 0, 0.02);
  }),
  snip: W(2, 0.1, 0.15, (b, v) => {
    b.noise('white', 'highpass', 4200 * v, 4200, 0.7, 0.012, 1);
    b.noise('white', 'highpass', 3600 * v, 3600, 0.7, 0.016, 0.8, 0.05);
  }),
  // ---- keeper ----
  glassTap: W(9, 0.12, 0.5, (b, v) => {
    b.tone('sine', 1850 * v, 1830 * v, 0.28, 0.5, 0, 0.001);
    b.tone('sine', 2760 * v, 2740 * v, 0.2, 0.3, 0, 0.001);
    b.tone('sine', 160, 90, 0.12, 0.9, 0, 0.001);
    b.noise('white', 'bandpass', 3000, 3000, 2, 0.012, 0.6);
  }),
  keeperDrop: W(8, 0.2, 0.5, (b, v) => {
    b.tone('sine', 72 * v, 34, 0.4, 1);
    b.noise('brown', 'lowpass', 500, 100, 1, 0.3, 1);
    b.noise('white', 'bandpass', 1800, 900, 1, 0.08, 0.3, 0.01);
  }),
  keeperWater: W(8, 0.3, 0.32, (b, v) => {
    for (let i = 0; i < 4; i++) b.tone('sine', (1500 - i * 130) * v, (560 - i * 40) * v, 0.07, 0.6, i * 0.13);
    b.noise('pink', 'lowpass', 900, 400, 1, 0.6, 0.4, 0.1, 0.1);
  }),
  lampSwitch: W(7, 0.2, 0.3, (b) => {
    b.noise('white', 'highpass', 2500, 2500, 0.7, 0.012, 1);
    b.tone('square', 900, 700, 0.02, 0.3);
    b.tone('sine', 100, 100, 0.5, 0.25, 0.03, 0.05);
  }),
  tubeOpen: W(7, 0.5, 0.5, (b) => {
    b.noise('pink', 'bandpass', 500, 900, 3, 0.4, 0.8, 0, 0.1);
    b.tone('sine', 240, 300, 0.25, 0.3, 0.3);
  }),
  shake: W(9, 0.8, 0.3, (b) => {
    b.noise('brown', 'lowpass', 160, 70, 1, 1.2, 1, 0, 0.05);
    for (let i = 0; i < 5; i++) b.tone('sine', 60, 40, 0.14, 0.6, i * 0.2);
  }),
  // ---- possession ----
  possessIn: W(10, 0.2, 0.3, (b) => {
    b.noise('pink', 'bandpass', 300, 3200, 1.6, 0.55, 0.9, 0, 0.3);
    b.tone('sine', 110, 220, 0.5, 0.35, 0, 0.2);
  }),
  possessOut: W(10, 0.2, 0.5, (b) => {
    b.noise('pink', 'bandpass', 3000, 260, 1.6, 0.5, 0.9, 0, 0.06);
    b.tone('sine', 220, 100, 0.45, 0.3, 0, 0.05);
  }),
  // ---- UI ----
  'ui.hover': U(0.2, (b) => b.tone('sine', 1500, 1500, 0.025, 0.6, 0, 0.002), 0.04, 1),
  'ui.tick': U(0.2, (b) => b.tone('sine', 1100, 1100, 0.02, 0.6, 0, 0.002), 0.03, 1),
  'ui.click': U(0.25, (b) => {
    b.tone('triangle', 720, 540, 0.05, 0.8, 0, 0.002);
    b.noise('white', 'highpass', 4000, 4000, 0.7, 0.01, 0.3);
  }),
  'ui.toggle': U(0.22, (b) => {
    b.tone('triangle', 600, 600, 0.04, 0.7, 0, 0.002);
    b.tone('triangle', 900, 900, 0.05, 0.6, 0.045, 0.002);
  }),
  'ui.confirm': U(0.26, (b) => {
    b.tone('triangle', 523, 523, 0.09, 0.7);
    b.tone('triangle', 784, 784, 0.16, 0.7, 0.08);
    b.tone('sine', 1047, 1047, 0.22, 0.4, 0.16);
  }),
  'ui.back': U(0.22, (b) => {
    b.tone('triangle', 660, 660, 0.06, 0.7);
    b.tone('triangle', 440, 440, 0.1, 0.6, 0.06);
  }),
  'ui.error': U(0.24, (b) => {
    b.tone('square', 196, 185, 0.11, 0.4);
    b.tone('square', 147, 139, 0.16, 0.4, 0.12);
  }),
  'ui.open': U(0.2, (b) => {
    b.noise('pink', 'bandpass', 600, 2400, 1.5, 0.14, 0.8, 0, 0.06);
    b.tone('sine', 440, 660, 0.12, 0.4);
  }),
  'ui.close': U(0.2, (b) => {
    b.noise('pink', 'bandpass', 2400, 500, 1.5, 0.14, 0.8, 0, 0.02);
    b.tone('sine', 660, 440, 0.12, 0.4);
  }),
  'ui.order': U(0.24, (b) => {
    b.noise('white', 'highpass', 3600, 3600, 0.7, 0.014, 0.7);
    b.tone('triangle', 880, 1175, 0.08, 0.6, 0.02);
  }),
  'ui.alertInfo': U(0.22, (b) => b.tone('sine', 880, 880, 0.2, 0.6, 0, 0.01), 0.3, 7),
  'ui.alertGood': U(
    0.26,
    (b) => {
      b.tone('sine', 660, 660, 0.14, 0.6);
      b.tone('sine', 990, 990, 0.3, 0.6, 0.12);
    },
    0.3,
    7,
  ),
  'ui.alertWarn': U(
    0.24,
    (b) => {
      b.tone('triangle', 587, 587, 0.13, 0.7);
      b.tone('triangle', 587, 587, 0.2, 0.7, 0.18);
    },
    0.4,
    8,
  ),
  'ui.alertDanger': U(
    0.26,
    (b) => {
      for (let i = 0; i < 3; i++) {
        b.tone('sawtooth', 466, 440, 0.11, 0.4, i * 0.15);
        b.tone('triangle', 233, 220, 0.11, 0.5, i * 0.15);
      }
    },
    0.5,
    9,
  ),
};

export interface PlayOptions {
  /** World position: spatialised + distance-culled. Omit for a head-locked sound. */
  pos?: Vec3 | null;
  gain?: number;
  /** Seconds before the sound starts (thunder travelling). */
  delay?: number;
  /** Extra pitch factor on top of the random variation. */
  pitch?: number;
}

interface Voice {
  nodes: AudioNode[];
}

/** Listener state the sfx player needs for culling (kept in sync by the audio layer). */
export interface Listener {
  x: number;
  y: number;
  z: number;
  /** Reference distance: sounds this far away play at about half volume. */
  ref: number;
  /** Beyond this, world sounds are culled. */
  maxDist: number;
}

export class SfxPlayer {
  readonly allocator: VoiceAllocator;
  readonly played: Record<string, number> = {};
  readonly listener: Listener = { x: 0, y: 0, z: 0, ref: 8, maxDist: 90 };
  private readonly voices = new Map<number, Voice>();

  constructor(private readonly e: Engine) {
    this.allocator = new VoiceAllocator(undefined, (h) => this.freeVoice(h));
  }

  /** Play a recipe. Returns false when culled / rate-limited / out of voices / unknown. */
  play(id: string, opts: PlayOptions = {}): boolean {
    const def = SFX[id];
    if (!def) return false;
    const e = this.e;
    const now = e.now;
    const L = this.listener;
    const pos = def.bus === 'sfx' ? (opts.pos ?? null) : null;
    const dist = pos ? Math.hypot(pos.x - L.x, pos.y - L.y, pos.z - L.z) : 0;
    const delay = Math.max(0, opts.delay ?? 0);
    const r = Math.random();
    const v = (0.92 + 0.16 * Math.random()) * (opts.pitch ?? 1);

    // build detached first so the true duration is known, then ask the allocator
    const out = e.gain(def.vol * (def.bus === 'ui' ? UI_GAIN : WORLD_GAIN) * Math.min(1.5, Math.max(0, opts.gain ?? 1)));
    const b = new Builder(e, now + delay + 0.005, out);
    const req = { id, bus: def.bus, priority: def.prio, dist, maxDist: pos ? L.maxDist : Infinity, duration: 0 };
    // cheap pre-check (no nodes built yet beyond `out`) for cull / rate
    const probe = this.allocator.request({ ...req, duration: 0.001 }, now, def.gap);
    if (!probe.ok) {
      e.free([out]);
      return false;
    }
    this.allocator.release(probe.handle);
    def.build(b, v, r);
    const res = this.allocator.request({ ...req, duration: delay + b.end + 0.08 }, now, 0);
    if (!res.ok) {
      e.free([out, ...b.nodes]);
      return false;
    }
    const nodes: AudioNode[] = [out, ...b.nodes];
    if (pos) {
      const p = e.panner();
      p.refDistance = L.ref;
      p.maxDistance = L.maxDist;
      p.rolloffFactor = 1;
      setPannerPos(p, pos);
      out.connect(p);
      p.connect(e.buses.sfx);
      nodes.push(p);
    } else out.connect(e.buses[def.bus]);
    this.voices.set(res.handle, { nodes });
    this.played[id] = (this.played[id] ?? 0) + 1;
    return true;
  }

  private freeVoice(handle: number): void {
    const v = this.voices.get(handle);
    if (!v) return;
    this.voices.delete(handle);
    this.e.free(v.nodes);
  }

  /** Free voices that finished sounding. */
  update(): void {
    for (const h of this.allocator.expire(this.e.now)) this.freeVoice(h);
  }

  /** Stop world voices (game unbound); `all` also stops UI blips. */
  stop(all = false): void {
    for (const h of this.allocator.clear(all ? undefined : 'sfx')) this.freeVoice(h);
  }
}

function setPannerPos(p: PannerNode, pos: Vec3): void {
  if (p.positionX) {
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
  } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
}

/** Move the WebAudio listener to the camera. */
export function setListener(ctx: BaseAudioContext, pos: Vec3, forward: Vec3, up: Vec3): void {
  const l = ctx.listener;
  if (l.positionX) {
    l.positionX.value = pos.x;
    l.positionY.value = pos.y;
    l.positionZ.value = pos.z;
    l.forwardX.value = forward.x;
    l.forwardY.value = forward.y;
    l.forwardZ.value = forward.z;
    l.upX.value = up.x;
    l.upY.value = up.y;
    l.upZ.value = up.z;
  } else {
    const legacy = l as unknown as { setPosition(x: number, y: number, z: number): void; setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void };
    legacy.setPosition(pos.x, pos.y, pos.z);
    legacy.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}
