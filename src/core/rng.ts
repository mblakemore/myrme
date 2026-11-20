import type { Rng } from './contracts';

/** FNV-1a 32-bit over a string or number label. */
export function hashLabel(label: string | number): number {
  const s = String(label);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stateless integer hash (for per-cell / per-id randomness without a stream). Returns [0,1). */
export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Seeded, forkable PRNG (mulberry32). Deterministic across platforms. `fork(label)` derives an
 * independent stream from the ORIGINAL seed + label, so adding draws to one stream never shifts
 * another (each system/generator should fork its own).
 */
export class SeededRng implements Rng {
  private s: number;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.s = this.seed;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  fork(label: string | number): SeededRng {
    return new SeededRng((Math.imul(this.seed ^ 0x9e3779b9, 0x85ebca6b) ^ hashLabel(label)) >>> 0);
  }

  state(): number {
    return this.s >>> 0;
  }
}
