import { createNoise2D, createNoise3D } from 'simplex-noise';
import { hash01, type Rng } from '../core';

/** Result of a 2D cellular (Worley) lookup. */
export interface CellSample {
  /** Distance to the nearest feature point. */
  f1: number;
  /** Distance to the border between the two nearest cells (0 on a Voronoi edge). */
  edge: number;
  /** Stable 0..1 id of the nearest cell. */
  id: number;
}

/** Seeded noise helpers for generators (A1). All outputs are deterministic for a given `rng`. */
export interface Noise {
  n2(x: number, y: number): number;
  n3(x: number, y: number, z: number): number;
  /** Fractal 2D noise in about [-1, 1]. */
  fbm2(x: number, y: number, octaves?: number): number;
  /** Fractal 3D noise in about [-1, 1]. */
  fbm3(x: number, y: number, z: number, octaves?: number): number;
  /** Ridged fractal 2D noise in [0, 1]; 1 on the crests. */
  ridged2(x: number, y: number, octaves?: number): number;
  /** 2D cellular noise with unit-sized cells (scale the inputs). Writes into and returns `out`. */
  cell2(x: number, y: number, out?: CellSample): CellSample;
}

const scratch: CellSample = { f1: 0, edge: 0, id: 0 };

export function createNoise(rng: Rng): Noise {
  const n2 = createNoise2D(() => rng.next());
  const n3 = createNoise3D(() => rng.next());
  const cellSeed = Math.floor(rng.next() * 0x7fffffff);
  return {
    n2,
    n3,
    fbm2(x, y, octaves = 4) {
      let a = 1;
      let f = 1;
      let s = 0;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        s += a * n2(x * f, y * f);
        norm += a;
        a *= 0.5;
        f *= 2;
      }
      return s / norm;
    },
    fbm3(x, y, z, octaves = 3) {
      let a = 1;
      let f = 1;
      let s = 0;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        s += a * n3(x * f, y * f, z * f);
        norm += a;
        a *= 0.5;
        f *= 2;
      }
      return s / norm;
    },
    ridged2(x, y, octaves = 3) {
      let a = 1;
      let f = 1;
      let s = 0;
      let norm = 0;
      for (let o = 0; o < octaves; o++) {
        const r = 1 - Math.abs(n2(x * f + o * 17.3, y * f - o * 9.1));
        s += a * r * r;
        norm += a;
        a *= 0.5;
        f *= 2;
      }
      return s / norm;
    },
    cell2(x, y, out = scratch) {
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      let b1 = Infinity;
      let p1x = 0;
      let p1y = 0;
      let id = 0;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const cx = ix + i;
          const cy = iy + j;
          const px = cx + 0.15 + 0.7 * hash01(cx, cy, cellSeed);
          const py = cy + 0.15 + 0.7 * hash01(cx, cy, cellSeed + 1);
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          if (d < b1) {
            b1 = d;
            p1x = px;
            p1y = py;
            id = hash01(cx, cy, cellSeed + 2);
          }
        }
      // distance to the nearest bisector between the closest point and any other point
      let edge = Infinity;
      for (let j = -2; j <= 2; j++)
        for (let i = -2; i <= 2; i++) {
          const cx = ix + i;
          const cy = iy + j;
          const px = cx + 0.15 + 0.7 * hash01(cx, cy, cellSeed);
          const py = cy + 0.15 + 0.7 * hash01(cx, cy, cellSeed + 1);
          const dx = px - p1x;
          const dy = py - p1y;
          const l = Math.hypot(dx, dy);
          if (l < 1e-6) continue;
          const e = (((px + p1x) / 2 - x) * dx + ((py + p1y) / 2 - y) * dy) / l;
          if (e < edge) edge = e;
        }
      out.f1 = Math.sqrt(b1);
      out.edge = edge;
      out.id = id;
      return out;
    },
  };
}
