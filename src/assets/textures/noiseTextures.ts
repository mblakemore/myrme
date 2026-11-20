import * as THREE from 'three';
import { hash01 } from '../../core';

/**
 * Procedural, tileable noise atlases for the terrain / vegetation / habitat shaders (§4: no
 * binary assets). Generated once on the CPU, uploaded as mip-mapped repeating RGBA8 textures so
 * triplanar detail anti-aliases properly from canopy zoom down to an ant's-eye view.
 *
 *  fbm   R = fbm height            G,B = d(height)/du,dv (signed, 0.5 = 0)   A = independent fbm
 *  cell  R = rounded pebble height G,B = gradient of R                       A = per-cell random id
 *  misc  R = crack network         G = fine grain   B = sparse sparkle dots  A = fibre streaks (run along v)
 *
 * Gradients are stored normalised; multiply by `gradScale` (height units per uv unit) to decode.
 */
export interface NoiseTextures {
  fbm: THREE.DataTexture;
  cell: THREE.DataTexture;
  misc: THREE.DataTexture;
  /** Decode scale for the GB gradient channels of `fbm` and `cell`. */
  fbmGradScale: number;
  cellGradScale: number;
  size: number;
}

/** Cells per tile of the `cell` atlas (pebble pitch in uv = 1 / CELL_GRID). */
export const CELL_GRID = 16;
/** Cells per tile of the crack network in `misc.r`. */
export const CRACK_GRID = 8;

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Periodic 2D value noise on a `period`-cell lattice; x,y in lattice units. */
function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const xa = ((x0 % px) + px) % px;
  const xb = (xa + 1) % px;
  const ya = ((y0 % py) + py) % py;
  const yb = (ya + 1) % py;
  const a = hash01(xa, ya, seed);
  const b = hash01(xb, ya, seed);
  const c = hash01(xa, yb, seed);
  const d = hash01(xb, yb, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbmField(n: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const out = new Float32Array(n * n);
  let amp = 1;
  let norm = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const s = p / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[x + y * n] += amp * vnoise(x * s, y * s, p, p, seed + o * 31);
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

interface Worley {
  f1: Float32Array;
  f2: Float32Array;
  id: Float32Array;
}

/** Tileable Worley noise with `g`×`g` jittered points. Distances in cell units. */
function worley(n: number, g: number, seed: number): Worley {
  const f1 = new Float32Array(n * n);
  const f2 = new Float32Array(n * n);
  const id = new Float32Array(n * n);
  const px = new Float32Array(g * g);
  const py = new Float32Array(g * g);
  for (let j = 0; j < g; j++)
    for (let i = 0; i < g; i++) {
      px[i + j * g] = 0.04 + 0.92 * hash01(i, j, seed);
      py[i + j * g] = 0.04 + 0.92 * hash01(i, j, seed + 7);
    }
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const u = ((x + 0.5) / n) * g;
      const v = ((y + 0.5) / n) * g;
      const cx = Math.floor(u);
      const cy = Math.floor(v);
      let d1 = 9;
      let d2 = 9;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const ix = cx + ox;
          const iy = cy + oy;
          const wi = (((ix % g) + g) % g) + (((iy % g) + g) % g) * g;
          const dx = ix + px[wi] - u;
          const dy = iy + py[wi] - v;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = wi;
          } else if (d < d2) d2 = d;
        }
      const o = x + y * n;
      f1[o] = d1;
      f2[o] = d2;
      id[o] = hash01(best, seed + 99, 3);
    }
  return { f1, f2, id };
}

/** Central-difference gradient (per uv unit), wrapped. Returns [gx, gy, maxAbs]. */
function gradient(h: Float32Array, n: number): { gx: Float32Array; gy: Float32Array; max: number } {
  const gx = new Float32Array(n * n);
  const gy = new Float32Array(n * n);
  let max = 1e-6;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const xl = (x + n - 1) % n;
      const xr = (x + 1) % n;
      const yl = (y + n - 1) % n;
      const yr = (y + 1) % n;
      const dx = (h[xr + y * n] - h[xl + y * n]) * 0.5 * n;
      const dy = (h[x + yr * n] - h[x + yl * n]) * 0.5 * n;
      gx[x + y * n] = dx;
      gy[x + y * n] = dy;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      if (m > max) max = m;
    }
  return { gx, gy, max };
}

function finish(data: Uint8Array, n: number, renderer?: THREE.WebGLRenderer): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const b8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

let cache: NoiseTextures | null = null;
let users = 0;

/** Shared, reference-counted noise atlases. Pair every call with `releaseNoiseTextures()`. */
export function acquireNoiseTextures(renderer?: THREE.WebGLRenderer, size = 512): NoiseTextures {
  users++;
  if (cache) return cache;
  const n = size;

  // ---- fbm ----
  const h = fbmField(n, 4, 7, 11, 0.55);
  const h2 = fbmField(n, 6, 6, 517, 0.5);
  const hg = gradient(h, n);
  const fbm = new Uint8Array(n * n * 4);
  // stretch the fbm to use the full 0..1 range
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  let lo2 = 1;
  let hi2 = 0;
  for (let i = 0; i < h2.length; i++) {
    if (h2[i] < lo2) lo2 = h2[i];
    if (h2[i] > hi2) hi2 = h2[i];
  }
  const hs = 1 / (hi - lo);
  for (let i = 0; i < n * n; i++) {
    fbm[i * 4] = b8((h[i] - lo) * hs);
    fbm[i * 4 + 1] = b8(0.5 + (0.5 * hg.gx[i]) / hg.max);
    fbm[i * 4 + 2] = b8(0.5 + (0.5 * hg.gy[i]) / hg.max);
    fbm[i * 4 + 3] = b8((h2[i] - lo2) / (hi2 - lo2));
  }

  // ---- cell: rounded pebbles ----
  const w = worley(n, CELL_GRID, 23);
  const ph = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    // pebble radius varies per cell; flat-topped dome that falls to 0 before the cell border
    const r = 0.2 + 0.36 * w.id[i] * w.id[i];
    const edge = Math.min(1, (w.f2[i] - w.f1[i]) / 0.22); // 0 on the Voronoi border
    const k = Math.min(1, w.f1[i] / r);
    ph[i] = Math.sqrt(Math.max(0, 1 - k * k)) * smooth(edge);
  }
  const pg = gradient(ph, n);
  const pgMax = pg.max * 0.5; // domes have steep rims: clip the top half for better precision
  const cell = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    cell[i * 4] = b8(ph[i]);
    cell[i * 4 + 1] = b8(0.5 + (0.5 * pg.gx[i]) / pgMax);
    cell[i * 4 + 2] = b8(0.5 + (0.5 * pg.gy[i]) / pgMax);
    cell[i * 4 + 3] = b8(w.id[i]);
  }

  // ---- misc ----
  const cw = worley(n, CRACK_GRID, 71);
  const warp = fbmField(n, 8, 4, 901, 0.5);
  const misc = new Uint8Array(n * n * 4);
  const grainA = fbmField(n, 128, 2, 333, 0.6);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = x + y * n;
      const d = cw.f2[i] - cw.f1[i];
      const width = 0.035 + 0.05 * warp[i];
      const crack = 1 - smooth(Math.min(1, d / width));
      // sparkle: isolated bright texels with a soft 1-texel halo
      let sp = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const r = hash01((x + ox + n) % n, (y + oy + n) % n, 4242);
          if (r > 0.992) sp = Math.max(sp, ox === 0 && oy === 0 ? 1 : 0.35);
        }
      // fibres: noise stretched along v (period 96 × 3), three octaves
      const u = x / n;
      const v = y / n;
      const fib = 0.55 * vnoise(u * 96, v * 3, 96, 3, 5) + 0.3 * vnoise(u * 192, v * 6, 192, 6, 6) + 0.15 * vnoise(u * 384, v * 8, 384, 8, 7);
      misc[i * 4] = b8(crack);
      misc[i * 4 + 1] = b8(0.5 + (grainA[i] - 0.5) * 2.2 + (hash01(x, y, 808) - 0.5) * 0.35);
      misc[i * 4 + 2] = b8(sp);
      misc[i * 4 + 3] = b8(0.5 + (fib - 0.5) * 1.9);
    }

  cache = {
    fbm: finish(fbm, n, renderer),
    cell: finish(cell, n, renderer),
    misc: finish(misc, n, renderer),
    fbmGradScale: hg.max * hs,
    cellGradScale: pgMax,
    size: n,
  };
  return cache;
}

export function releaseNoiseTextures(): void {
  users = Math.max(0, users - 1);
  if (users === 0 && cache) {
    cache.fbm.dispose();
    cache.cell.dispose();
    cache.misc.dispose();
    cache = null;
  }
}
