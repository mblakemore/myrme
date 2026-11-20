/**
 * Ambience engine: one persistent looping bed per `AmbienceLayerId` (pre-rendered by `dsp.ts`),
 * each behind its own gain that is crossfaded towards the mix targets from `mix.ts`. No per-frame
 * node churn: beds are built once (one per frame after the context starts, to avoid a hitch) and
 * only their gains are automated.
 */
import type { AmbienceLayerId } from '../core';
import { BED_RATE, renderBed } from './dsp';
import type { Engine } from './engine';
import { LAYER_IDS } from './mix';

interface Bed {
  src: AudioBufferSourceNode;
  gain: GainNode;
  /** Last value handed to the gain automation. */
  sent: number;
}

/**
 * Fixed scale between a mix target (0..1, what `stats().ambience` reports) and the bed's real gain.
 * The pre-rendered beds are normalised hot (rms ≈ 0.3) and up to six play at once, so the mix
 * targets alone would bury everything else.
 */
export const BED_GAIN = 0.32;

/** Crossfade time constants (seconds): weather beds move slower than the underground crossfade. */
const TAU: Partial<Record<AmbienceLayerId, number>> = { underground: 0.35, skitter: 0.3, rain: 1.2, rainClose: 0.5, birds: 2, crickets: 2, gusts: 0.8 };

export class Ambience {
  private readonly beds = new Map<AmbienceLayerId, Bed>();
  private readonly queue: AmbienceLayerId[] = [...LAYER_IDS];

  constructor(private readonly e: Engine) {}

  get ready(): boolean {
    return this.queue.length === 0;
  }

  /** Build the next pending bed (call once per frame until `ready`). */
  buildNext(): void {
    const id = this.queue.shift();
    if (!id) return;
    const e = this.e;
    const src = e.source(e.buffer(renderBed(id, BED_RATE), BED_RATE), true);
    const gain = e.gain(0);
    src.connect(gain);
    gain.connect(e.buses.ambience);
    src.start(e.now, Math.random() * src.buffer!.duration);
    this.beds.set(id, { src, gain, sent: 0 });
  }

  /** Crossfade towards `targets` (0..1 per layer). `gust` 0..1 modulates the gust bed. */
  apply(targets: Readonly<Record<AmbienceLayerId, number>>, gust: number, rain: number): void {
    const t = this.e.now;
    for (const [id, bed] of this.beds) {
      let v = targets[id] ?? 0;
      if (id === 'gusts') v *= 0.3 + 0.7 * gust;
      if (Math.abs(v - bed.sent) < 0.012 && !(v === 0 && bed.sent !== 0)) continue;
      bed.sent = v;
      bed.gain.gain.setTargetAtTime(v * BED_GAIN, t, TAU[id] ?? 0.9);
    }
    // heavier rain = denser, brighter patter
    const rainBed = this.beds.get('rain');
    if (rainBed) {
      const rate = Math.round((0.88 + 0.3 * rain) * 50) / 50;
      if (rainBed.src.playbackRate.value !== rate) rainBed.src.playbackRate.value = rate;
    }
  }

  /** Beds currently mixed in. */
  active(): number {
    let n = 0;
    for (const b of this.beds.values()) if (b.sent > 0.01) n++;
    return n;
  }

  /** Fade everything out quickly (game unbound). */
  silence(): void {
    const t = this.e.now;
    for (const bed of this.beds.values()) {
      if (bed.sent === 0) continue;
      bed.sent = 0;
      bed.gain.gain.setTargetAtTime(0, t, 0.15);
    }
  }

  dispose(): void {
    for (const bed of this.beds.values()) this.e.free([bed.src, bed.gain]);
    this.beds.clear();
    this.queue.length = 0;
  }
}
