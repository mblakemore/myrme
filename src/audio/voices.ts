/**
 * Pure voice allocator: per-bus caps, priorities with stealing, distance culling and per-sound
 * rate limiting. No WebAudio — the sfx layer maps handles to node graphs and frees them when the
 * allocator says a voice was stolen or has expired.
 */
import type { AudioBus } from '../core';

export interface VoiceRequest {
  /** Sound id (rate-limit key, stats). */
  id: string;
  bus: AudioBus;
  /** Higher wins. 0 = ambient detail … 10 = must play. */
  priority: number;
  /** Distance listener → source in world units (0 for non-spatial). */
  dist: number;
  /** Beyond this the request is culled (Infinity = never). */
  maxDist: number;
  /** Seconds until the voice has finished sounding. */
  duration: number;
}

export interface ActiveVoice extends VoiceRequest {
  handle: number;
  start: number;
  end: number;
}

export type VoiceResult = { ok: true; handle: number; stolen: number } | { ok: false; reason: 'culled' | 'rate' | 'full'; handle: 0; stolen: 0 };

export const DEFAULT_CAPS: Readonly<Record<AudioBus, number>> = { ambience: 6, sfx: 24, music: 20, ui: 6 };

/** Linear-ish audibility 1 (at the listener) → 0 (at `maxDist`). */
export function distanceGain(dist: number, ref: number, maxDist: number): number {
  if (!(maxDist > 0) || dist >= maxDist) return 0;
  const g = ref / (ref + Math.max(0, dist));
  const edge = 1 - dist / maxDist;
  return g * Math.min(1, edge * 4);
}

/**
 * How much a voice is worth keeping: priority first, then nearer and younger voices. Used to pick
 * the steal victim (lowest value) and to decide whether a newcomer may steal.
 */
export function voiceValue(v: { priority: number; dist: number; maxDist: number; start: number; end: number }, now: number): number {
  const near = Number.isFinite(v.maxDist) && v.maxDist > 0 ? 1 - Math.min(1, v.dist / v.maxDist) : 1;
  const life = v.end > v.start ? Math.min(1, Math.max(0, (now - v.start) / (v.end - v.start))) : 1;
  return v.priority + near * 0.6 - life * 0.3;
}

export class VoiceAllocator {
  private readonly active = new Map<number, ActiveVoice>();
  private readonly lastPlayed = new Map<string, number>();
  private next = 1;
  /** Requests refused for a full bus plus voices stolen. */
  stolen = 0;
  culled = 0;
  rateLimited = 0;

  constructor(
    readonly caps: Readonly<Record<AudioBus, number>> = DEFAULT_CAPS,
    /** Called when a voice is stolen so its nodes can be freed. */
    private readonly onSteal: (handle: number) => void = () => {},
  ) {}

  /**
   * Ask for a voice at time `now`. `minGap` (seconds) rate-limits sounds sharing `req.id`.
   * Order of checks: distance cull → rate limit → free slot → steal the least valuable voice on
   * the bus if the newcomer is worth more.
   */
  request(req: VoiceRequest, now: number, minGap = 0): VoiceResult {
    if (req.dist > req.maxDist) {
      this.culled++;
      return { ok: false, reason: 'culled', handle: 0, stolen: 0 };
    }
    if (minGap > 0) {
      const last = this.lastPlayed.get(req.id);
      if (last !== undefined && now - last < minGap && now >= last) {
        this.rateLimited++;
        return { ok: false, reason: 'rate', handle: 0, stolen: 0 };
      }
    }
    let stolen = 0;
    if (this.count(req.bus) >= (this.caps[req.bus] ?? 0)) {
      let victim: ActiveVoice | null = null;
      let worst = Infinity;
      for (const v of this.active.values()) {
        if (v.bus !== req.bus) continue;
        const val = voiceValue(v, now);
        if (val < worst) {
          worst = val;
          victim = v;
        }
      }
      const mine = voiceValue({ ...req, start: now, end: now + req.duration }, now);
      this.stolen++;
      if (!victim || worst >= mine) return { ok: false, reason: 'full', handle: 0, stolen: 0 };
      this.active.delete(victim.handle);
      this.onSteal(victim.handle);
      stolen = victim.handle;
    }
    const handle = this.next++;
    this.active.set(handle, { ...req, handle, start: now, end: now + req.duration });
    this.lastPlayed.set(req.id, now);
    return { ok: true, handle, stolen };
  }

  /** Remove finished voices; returns their handles (free the nodes). */
  expire(now: number): number[] {
    const out: number[] = [];
    for (const v of this.active.values()) if (v.end <= now) out.push(v.handle);
    for (const h of out) this.active.delete(h);
    return out;
  }

  release(handle: number): void {
    this.active.delete(handle);
  }

  /** Drop every voice (optionally only one bus); returns the handles. */
  clear(bus?: AudioBus): number[] {
    const out: number[] = [];
    for (const v of this.active.values()) if (!bus || v.bus === bus) out.push(v.handle);
    for (const h of out) this.active.delete(h);
    return out;
  }

  count(bus?: AudioBus): number {
    if (!bus) return this.active.size;
    let n = 0;
    for (const v of this.active.values()) if (v.bus === bus) n++;
    return n;
  }

  /** Forget rate-limit history (context restart). */
  resetRates(): void {
    this.lastPlayed.clear();
  }
}
