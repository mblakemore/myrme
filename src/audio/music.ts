/**
 * Adaptive generative music — subtle modal pads and plucks through a small feedback delay network
 * (convolver-less reverb), with intensity layers per mood:
 *
 *   menu       lydian arpeggio motif over warm pads
 *   calm       dorian pads, sparse plucks
 *   night      aeolian, lower and sparser
 *   danger     phrygian, faster pulse, chitin-click percussion + bass throb scaled by intensity
 *   infection  detuned, tritone-heavy unease
 *   victory / defeat   stingers (`stinger()`), then a quiet matching bed
 *
 * `update()` schedules notes a short look-ahead in front of the context clock; nothing runs when
 * music is disabled. All note nodes are counted and freed after their release.
 */
import type { MusicMood } from '../core';
import type { Engine } from './engine';

const SCALES: Record<Exclude<MusicMood, 'off'>, readonly number[]> = {
  menu: [0, 2, 4, 6, 7, 9, 11],
  calm: [0, 2, 3, 5, 7, 9, 10],
  night: [0, 2, 3, 5, 7, 8, 10],
  danger: [0, 1, 3, 5, 7, 8, 10],
  infection: [0, 1, 3, 5, 6, 8, 10],
  victory: [0, 2, 4, 5, 7, 9, 11],
  defeat: [0, 2, 3, 5, 7, 8, 10],
};
/** MIDI root, tempo (bpm of the eighth-note grid /2), chord progression (scale degrees). */
const MOODS: Record<Exclude<MusicMood, 'off'>, { root: number; bpm: number; prog: readonly number[]; pluck: number; detune: number }> = {
  menu: { root: 50, bpm: 66, prog: [0, 4, 3, 5], pluck: 0.5, detune: 6 },
  calm: { root: 48, bpm: 58, prog: [0, 3, 6, 4], pluck: 0.16, detune: 6 },
  night: { root: 45, bpm: 48, prog: [0, 5, 3, 0], pluck: 0.09, detune: 8 },
  danger: { root: 43, bpm: 92, prog: [0, 1, 0, 5], pluck: 0.2, detune: 10 },
  infection: { root: 46, bpm: 52, prog: [0, 4, 1, 4], pluck: 0.14, detune: 38 },
  victory: { root: 48, bpm: 60, prog: [0, 3, 4, 0], pluck: 0.25, detune: 5 },
  defeat: { root: 45, bpm: 44, prog: [0, 5, 3, 4], pluck: 0.05, detune: 9 },
};
const MENU_MOTIF = [0, 4, 2, 6, 4, 2, 7, 4]; // chord-relative scale steps, one per eighth
const CLICK_PATTERN = [1, 0, 0.5, 0, 1, 0.4, 0, 0.6];

const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

interface Note {
  nodes: AudioNode[];
  end: number;
}

export class Music {
  mood: MusicMood = 'off';
  intensity = 0;
  enabled = true;
  /** Notes scheduled since the context started. */
  notes = 0;

  private readonly out: GainNode;
  private readonly send: GainNode;
  private readonly fixed: AudioNode[] = [];
  private live: Note[] = [];
  private nextStep = 0;
  private step = 0;
  private chord = 0;
  private playing: MusicMood = 'off';
  private rand: () => number = Math.random;

  constructor(
    private readonly e: Engine,
    rand?: () => number,
  ) {
    if (rand) this.rand = rand;
    this.out = e.gain(0.6);
    this.out.connect(e.buses.music);
    this.send = e.gain(0.3);
    this.fixed.push(this.out, this.send);
    this.buildReverb();
  }

  /** 4-line feedback delay network with a Hadamard mix and damping in the loop. */
  private buildReverb(): void {
    const e = this.e;
    const times = [0.0437, 0.0571, 0.0713, 0.0897];
    // Measured in Chromium: with fb 0.7 and the damping biquads at Q 0.5 this loop is UNSTABLE (the
    // tail grows ~×10 every 2 s until the limiter is pinned). fb 0.6 with Q −3 dB decays ≈ 35 dB/s.
    const fb = 0.6;
    const H = [
      [1, 1, 1, 1],
      [1, -1, 1, -1],
      [1, 1, -1, -1],
      [1, -1, -1, 1],
    ];
    const wet = e.gain(0.35);
    wet.connect(this.out);
    const ins = times.map(() => e.gain(1));
    const delays = times.map((t) => e.delay(t));
    const damps = times.map(() => e.filter('lowpass', 3200, -3));
    this.fixed.push(wet, ...ins, ...delays, ...damps);
    for (let i = 0; i < 4; i++) {
      this.send.connect(ins[i]);
      ins[i].connect(delays[i]);
      delays[i].connect(damps[i]);
      damps[i].connect(wet);
    }
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const g = e.gain(H[i][j] * 0.5 * fb);
        damps[j].connect(g);
        g.connect(ins[i]);
        this.fixed.push(g);
      }
    }
  }

  get activeNotes(): number {
    return this.live.length;
  }

  private degree(mood: Exclude<MusicMood, 'off'>, deg: number, octave: number): number {
    const sc = SCALES[mood];
    const n = sc.length;
    const o = Math.floor(deg / n);
    return midiHz(MOODS[mood].root + sc[((deg % n) + n) % n] + 12 * (o + octave));
  }

  private voice(type: OscillatorType, freq: number, t: number, attack: number, hold: number, release: number, peak: number, detuneCents: number, cutoff: number, wet: number): void {
    const e = this.e;
    if (this.live.length >= 20) return;
    const g = e.gain(0);
    const f = e.filter('lowpass', cutoff, 0.6);
    const o1 = e.osc(type, freq);
    const nodes: AudioNode[] = [g, f, o1];
    o1.connect(f);
    if (detuneCents > 0) {
      const o2 = e.osc(type === 'sine' ? 'triangle' : 'sine', freq);
      o2.detune.value = detuneCents;
      o1.detune.value = -detuneCents * 0.5;
      o2.connect(f);
      o2.start(t);
      o2.stop(t + attack + hold + release + 0.1);
      nodes.push(o2);
    }
    f.connect(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-4, peak * 0.002), t + attack + hold + release);
    g.connect(this.out);
    if (wet > 0) {
      const s = e.gain(wet);
      g.connect(s);
      s.connect(this.send);
      nodes.push(s);
    }
    o1.start(t);
    o1.stop(t + attack + hold + release + 0.1);
    // keep the note until the reverb tail has mostly gone
    this.live.push({ nodes, end: t + attack + hold + release + 0.15 });
    this.notes++;
  }

  private click(t: number, peak: number): void {
    const e = this.e;
    if (this.live.length >= 20) return;
    const s = e.source(e.noise.white, true);
    const f = e.filter('bandpass', 2400 + this.rand() * 1600, 3);
    const g = e.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.003);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.035);
    s.connect(f);
    f.connect(g);
    g.connect(this.out);
    const w = e.gain(0.4);
    g.connect(w);
    w.connect(this.send);
    s.start(t, this.rand() * 1.5);
    s.stop(t + 0.05);
    this.live.push({ nodes: [s, f, g, w], end: t + 0.1 });
    this.notes++;
  }

  /** One eighth-note step of the current mood at context time `t`. */
  private scheduleStep(t: number): void {
    const mood = this.playing;
    if (mood === 'off') return;
    const m = MOODS[mood];
    const dur = 60 / m.bpm / 2;
    const I = this.intensity;
    const s = this.step;
    if (s % 16 === 0) {
      this.chord = m.prog[Math.floor(s / 16) % m.prog.length];
      const len = dur * 16;
      const tones = mood === 'infection' ? [0, 2, 3] : mood === 'danger' ? [0, 2, 4] : [0, 2, 4, 6];
      const peak = mood === 'danger' ? 0.035 + 0.03 * I : mood === 'menu' ? 0.04 : mood === 'night' ? 0.045 : 0.06;
      tones.forEach((d, i) => this.voice(i === 0 ? 'triangle' : 'sine', this.degree(mood, this.chord + d, i === 0 ? 0 : 1), t + i * 0.05, len * 0.3, len * 0.5, len * 0.45, peak * (i === 0 ? 1.2 : 1), m.detune, mood === 'night' || mood === 'defeat' ? 700 : 1100, 0.6));
    }
    // plucks
    if (mood === 'menu') {
      if (s % 2 === 0 || this.rand() < 0.2) {
        const d = MENU_MOTIF[s % 8] + (this.rand() < 0.15 ? 1 : 0);
        this.voice('triangle', this.degree(mood, this.chord + d, 2), t, 0.006, 0.02, 1.1, 0.028, 3, 2600, 0.9);
      }
    } else if (this.rand() < m.pluck * (0.6 + 0.8 * I)) {
      const d = [0, 2, 4, 7, 9][Math.floor(this.rand() * 5)];
      this.voice('triangle', this.degree(mood, this.chord + d, mood === 'night' || mood === 'defeat' ? 1 : 2), t, 0.006, 0.02, mood === 'night' ? 1.8 : 1.2, 0.06, m.detune * 0.4, 2200, 1);
    }
    if (mood === 'danger') {
      const c = CLICK_PATTERN[s % 8];
      if (c > 0 && (c >= 1 || I > 0.35) && I > 0.1) this.click(t, 0.1 * c * (0.4 + 0.6 * I));
      if (I > 0.6 && s % 2 === 1 && this.rand() < 0.5) this.click(t + dur * 0.5, 0.05);
      if (s % 4 === 0) this.voice('sine', this.degree(mood, this.chord, -1), t, 0.01, 0.05, dur * 2.5, 0.06 * (0.4 + 0.6 * I), 0, 300, 0.15);
    }
    this.step++;
  }

  /** Schedule everything in `[now, until)`; call every frame (or once for an offline render). */
  schedule(until: number): void {
    const e = this.e;
    const now = e.now;
    // free finished notes
    if (this.live.length) {
      const keep: Note[] = [];
      for (const n of this.live) {
        if (n.end <= now) e.free(n.nodes);
        else keep.push(n);
      }
      this.live = keep;
    }
    const want: MusicMood = this.enabled ? this.mood : 'off';
    if (want !== this.playing) {
      this.playing = want;
      // start the new mood on a fresh bar, shortly after now
      this.step = 0;
      this.nextStep = Math.max(this.nextStep, now + 0.05);
    }
    if (this.playing === 'off') {
      this.nextStep = now;
      return;
    }
    if (this.nextStep < now - 0.5) this.nextStep = now + 0.05; // tab was hidden: do not catch up
    const dur = 60 / MOODS[this.playing].bpm / 2;
    let guard = 0;
    while (this.nextStep < until && guard++ < 64) {
      this.scheduleStep(this.nextStep);
      this.nextStep += dur;
    }
  }

  /** One-off flourish; the caller latches the matching mood afterwards. */
  stinger(kind: 'victory' | 'defeat'): void {
    if (!this.enabled) return;
    const t = this.e.now + 0.05;
    if (kind === 'victory') {
      [0, 2, 4, 7, 9, 11, 14].forEach((d, i) => this.voice('triangle', this.degree('victory', d, 1), t + i * 0.11, 0.008, 0.05, 1.4, 0.08, 4, 3000, 1));
      [0, 2, 4].forEach((d) => this.voice('sine', this.degree('victory', d, 1), t + 0.8, 0.4, 1.6, 2.5, 0.06, 6, 1500, 0.8));
    } else {
      [7, 5, 4, 2, 0].forEach((d, i) => this.voice('triangle', this.degree('defeat', d, 1), t + i * 0.42, 0.02, 0.1, 2, 0.065, 8, 1400, 1));
      this.voice('sine', this.degree('defeat', 0, -1), t, 0.6, 2.5, 3, 0.08, 12, 400, 0.4);
    }
    // push the bed back so the stinger is heard on its own
    this.nextStep = Math.max(this.nextStep, t + (kind === 'victory' ? 2.2 : 3.2));
    this.step = 0;
  }

  /** Drop every sounding note now. */
  stop(): void {
    for (const n of this.live) this.e.free(n.nodes);
    this.live = [];
    this.playing = 'off';
  }

  dispose(): void {
    this.stop();
    this.e.free(this.fixed);
    this.fixed.length = 0;
  }
}
