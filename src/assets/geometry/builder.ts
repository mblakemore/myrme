import * as THREE from 'three';
import type { BodyPartId, CreatureRig } from '../../core';

/**
 * Procedural organic mesh builder (A4). Everything is made of two primitives:
 *  - `blob`: a lofted body segment — elliptical rings along an axis with radius profiles
 *    (smooth closed forms: heads, mesosomas, gasters, eyes, eggs…),
 *  - `limb`: a tapered tube along a polyline with parallel-transport frames (legs, antennae,
 *    mandibles, spines).
 * Vertices carry the shared creature attribute layout (see `core/contracts/a4.ts`):
 * `aBody` (part, limb, weight, ao), `aPivot`, `color`. Normals are smooth per primitive.
 */

export type V3 = [number, number, number];
export type RGB = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const gauss = (x: number, s: number): number => Math.exp(-(x * x) / (2 * s * s));

/**
 * Asymmetric super-ellipse profile, 0 at t=0 and t=1, 1 at `peak`. Exponents: 0.5 = ellipse,
 * larger = pointier, smaller = blunter.
 */
export function prof(t: number, peak = 0.5, ea = 0.5, eb = 0.5): number {
  if (t <= 0 || t >= 1) return 0;
  if (t < peak) {
    const u = (peak - t) / peak;
    return Math.pow(1 - u * u, ea);
  }
  const u = (t - peak) / (1 - peak);
  return Math.pow(1 - u * u, eb);
}

/** Deterministic hash noise for shape jitter (no Math.random: geometry must be reproducible). */
export function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise in 0..1. */
export function vnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const h = (a: number, b: number, c: number): number => hash1(a * 1.0 + b * 57.0 + c * 113.0);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(h(ix, iy, iz), h(ix + 1, iy, iz), sx), l(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), sx), sy),
    l(l(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), sx), l(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), sx), sy),
    sz,
  );
}

export interface BlobOpts {
  /** Axis start and end. */
  a: V3;
  b: V3;
  rings: number;
  radial: number;
  /** Half-width along the frame's right axis, per t (0 at a → 1 at b). */
  rx: (t: number) => number;
  /** Half-height along the frame's up axis (defaults to rx). */
  ry?: (t: number) => number;
  /** Ring centre offset [right, up] per t. */
  off?: (t: number) => [number, number];
  /** Radius multiplier per angle (π/2 = top, −π/2 = bottom) and t. */
  shape?: (theta: number, t: number) => number;
  /** Up hint (default +Y). */
  up?: V3;
  /** Limb/gaster weight per t (default 0). */
  w?: (t: number) => number;
  /** AO multiplier per t (default: darker towards both ends). */
  ao?: (t: number) => number;
  col?: RGB | ((t: number, theta: number) => RGB);
  /** Uniform ring spacing instead of cosine spacing. */
  even?: boolean;
}

export interface LimbOpts {
  pts: V3[];
  /** Radius per point (or one for all). */
  r: number[] | number;
  /** Weight per point (default 0..1 by index). */
  w?: number[];
  radial: number;
  /** Cross-section flattening: up radius = r × flat (default 1). */
  flat?: number;
  up?: V3;
  /** Catmull-Rom subdivisions per span (0 = angular joints). */
  smooth?: number;
  col?: RGB | RGB[];
  /** AO per point (default 0.6 at the root → 1 at the tip). */
  ao?: number[];
}

const WHITE: RGB = [1, 1, 1];

export class GeoBuilder {
  private pos: number[] = [];
  private body: number[] = [];
  private piv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private nrm: number[] = [];
  /** Vertices whose normal must not be re-smoothed with the underside AO term (flat membranes). */
  part: BodyPartId = 1;
  limbIndex = 0;
  pivot: V3 = [0, 0, 0];
  /** Index offset where the translucent (wing) triangles start; they must be built last. */
  private blendStart = -1;

  /** Everything built after this call goes into material group 1 (alpha-blended membranes). */
  beginBlend(): void {
    if (this.blendStart < 0) this.blendStart = this.idx.length;
  }

  set(part: BodyPartId, limbIndex = 0, pivot: V3 = [0, 0, 0]): this {
    this.part = part;
    this.limbIndex = limbIndex;
    this.pivot = pivot;
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(p: V3, w: number, ao: number, col: RGB): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(0, 0, 0);
    this.body.push(this.part, this.limbIndex, w, ao);
    this.piv.push(this.pivot[0], this.pivot[1], this.pivot[2]);
    this.col.push(col[0], col[1], col[2]);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Lofts rings (each either a full ring start index or a single pole vertex). */
  private connect(rings: { start: number; n: number }[]): void {
    for (let i = 0; i + 1 < rings.length; i++) {
      const r0 = rings[i];
      const r1 = rings[i + 1];
      if (r0.n === 1 && r1.n === 1) continue;
      if (r0.n === 1) {
        for (let j = 0; j < r1.n; j++) this.tri(r0.start, r1.start + ((j + 1) % r1.n), r1.start + j);
      } else if (r1.n === 1) {
        for (let j = 0; j < r0.n; j++) this.tri(r0.start + j, r0.start + ((j + 1) % r0.n), r1.start);
      } else {
        const n = r0.n;
        for (let j = 0; j < n; j++) {
          const j1 = (j + 1) % n;
          this.tri(r0.start + j, r0.start + j1, r1.start + j);
          this.tri(r0.start + j1, r1.start + j1, r1.start + j);
        }
      }
    }
  }

  /** Lofted closed body segment. */
  blob(o: BlobOpts): void {
    const t3 = norm(sub(o.b, o.a));
    let right = cross(o.up ?? [0, 1, 0], t3);
    if (len(right) < 1e-4) right = cross([1, 0, 0], t3);
    right = norm(right);
    const up = cross(t3, right);
    const rings: { start: number; n: number }[] = [];
    for (let i = 0; i <= o.rings; i++) {
      const u = i / o.rings;
      const t = o.even ? u : 0.5 - 0.5 * Math.cos(Math.PI * u);
      const rx = o.rx(t);
      const ry = (o.ry ?? o.rx)(t);
      const off = o.off ? o.off(t) : [0, 0];
      const c = add(add(mix3(o.a, o.b, t), mul(right, off[0])), mul(up, off[1]));
      const w = o.w ? o.w(t) : 0;
      const ao = o.ao ? o.ao(t) : 0.72 + 0.28 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
      if (rx < 1e-5 && ry < 1e-5) {
        const col = typeof o.col === 'function' ? o.col(t, Math.PI / 2) : (o.col ?? WHITE);
        rings.push({ start: this.vert(c, w, ao, col), n: 1 });
        continue;
      }
      const start = this.vertexCount;
      for (let j = 0; j < o.radial; j++) {
        const th = (j / o.radial) * Math.PI * 2;
        const s = o.shape ? o.shape(th, t) : 1;
        const p = add(add(c, mul(right, Math.cos(th) * rx * s)), mul(up, Math.sin(th) * ry * s));
        const col = typeof o.col === 'function' ? o.col(t, th) : (o.col ?? WHITE);
        this.vert(p, w, ao, col);
      }
      rings.push({ start, n: o.radial });
    }
    this.connect(rings);
  }

  /** Tapered tube along a polyline, capped with poles at both ends. */
  limb(o: LimbOpts): void {
    let pts = o.pts;
    let rad = typeof o.r === 'number' ? pts.map(() => o.r as number) : o.r;
    let ws = o.w ?? pts.map((_, i) => i / (pts.length - 1));
    let cols: RGB[] = Array.isArray(o.col) && Array.isArray(o.col[0]) ? (o.col as RGB[]) : pts.map(() => (o.col as RGB | undefined) ?? WHITE);
    let aos = o.ao ?? pts.map((_, i) => 0.62 + 0.38 * Math.min(1, (i / (pts.length - 1)) * 2));
    const sm = o.smooth ?? 0;
    if (sm > 0 && pts.length > 2) {
      const np: V3[] = [];
      const nr: number[] = [];
      const nw: number[] = [];
      const nc: RGB[] = [];
      const na: number[] = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        for (let k = 0; k <= sm; k++) {
          const t = k / (sm + 1);
          const t2 = t * t;
          const t3 = t2 * t;
          const cr = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
          np.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1]), cr(p0[2], p1[2], p2[2], p3[2])]);
          nr.push(lerp(rad[i], rad[i + 1], t));
          nw.push(lerp(ws[i], ws[i + 1], t));
          nc.push(mix3(cols[i], cols[i + 1], t));
          na.push(lerp(aos[i], aos[i + 1], t));
        }
      }
      const L = pts.length - 1;
      np.push(pts[L]);
      nr.push(rad[L]);
      nw.push(ws[L]);
      nc.push(cols[L]);
      na.push(aos[L]);
      pts = np;
      rad = nr;
      ws = nw;
      cols = nc;
      aos = na;
    }
    const n = pts.length;
    const flat = o.flat ?? 1;
    let tPrev = norm(sub(pts[1], pts[0]));
    let right = cross(o.up ?? [0, 1, 0], tPrev);
    if (len(right) < 1e-3) right = cross([1, 0, 0], tPrev);
    if (len(right) < 1e-3) right = cross([0, 0, 1], tPrev);
    right = norm(right);
    const rings: { start: number; n: number }[] = [];
    rings.push({ start: this.vert(sub(pts[0], mul(tPrev, rad[0] * 0.6)), ws[0], aos[0], cols[0]), n: 1 });
    const ring = (c: V3, t: V3, i: number, miter: number): void => {
      // parallel transport
      right = sub(right, mul(t, dot(right, t)));
      right = len(right) < 1e-4 ? norm(cross([0.3, 1, 0.2], t)) : norm(right);
      const up = cross(t, right);
      const start = this.vertexCount;
      for (let j = 0; j < o.radial; j++) {
        const th = (j / o.radial) * Math.PI * 2;
        const p = add(add(c, mul(right, Math.cos(th) * rad[i] * miter)), mul(up, Math.sin(th) * rad[i] * flat * miter));
        this.vert(p, ws[i], aos[i], cols[i]);
      }
      rings.push({ start, n: o.radial });
    };
    for (let i = 0; i < n; i++) {
      const tin = i > 0 ? norm(sub(pts[i], pts[i - 1])) : norm(sub(pts[1], pts[0]));
      const tout = i < n - 1 ? norm(sub(pts[i + 1], pts[i])) : tin;
      const bend = dot(tin, tout);
      if (bend < 0.6 && o.radial > 3) {
        // sharp joint: two rings, one square to each segment, so the tube is not pinched flat
        const k = rad[i] * 0.35;
        ring(sub(pts[i], mul(tin, k)), tin, i, 1);
        ring(add(pts[i], mul(tout, k)), tout, i, 1);
      } else {
        let t = add(tin, tout);
        t = len(t) < 1e-4 ? tout : norm(t);
        // widen mitred joints so the tube keeps its thickness through a bend
        ring(pts[i], t, i, 1 / Math.max(0.6, dot(t, tout)));
      }
      tPrev = tout;
    }
    rings.push({ start: this.vert(add(pts[n - 1], mul(tPrev, rad[n - 1] * 0.6)), ws[n - 1], aos[n - 1], cols[n - 1]), n: 1 });
    this.connect(rings);
  }

  /**
   * Two-sided membrane patch from a grid of points (wings, leaf fragments). `vein(u,v)` goes to
   * the AO channel (the material reads it as opacity/vein strength for wings).
   */
  sheet(nu: number, nv: number, at: (u: number, v: number) => V3, w: (u: number, v: number) => number, vein: (u: number, v: number) => number, col: RGB | ((u: number, v: number) => RGB)): void {
    for (let side = 0; side < 2; side++) {
      const start = this.vertexCount;
      for (let i = 0; i <= nu; i++) {
        for (let j = 0; j <= nv; j++) {
          const u = i / nu;
          const v = j / nv;
          this.vert(at(u, v), w(u, v), vein(u, v), typeof col === 'function' ? col(u, v) : col);
        }
      }
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
          const a = start + i * (nv + 1) + j;
          const b = a + 1;
          const c = a + (nv + 1);
          const d = c + 1;
          if (side === 0) {
            this.tri(a, c, b);
            this.tri(b, c, d);
          } else {
            this.tri(a, b, c);
            this.tri(b, d, c);
          }
        }
      }
    }
  }

  build(rig: Partial<CreatureRig> = {}, undersideAo = true): THREE.BufferGeometry {
    const nv = this.pos.length / 3;
    const P = this.pos;
    const N = this.nrm;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i] * 3;
      const b = this.idx[i + 1] * 3;
      const c = this.idx[i + 2] * 3;
      const e1x = P[b] - P[a];
      const e1y = P[b + 1] - P[a + 1];
      const e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a];
      const e2y = P[c + 1] - P[a + 1];
      const e2z = P[c + 2] - P[a + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        N[v] += nx;
        N[v + 1] += ny;
        N[v + 2] += nz;
      }
    }
    for (let i = 0; i < nv; i++) {
      const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
      N[i * 3] /= l;
      N[i * 3 + 1] /= l;
      N[i * 3 + 2] /= l;
      // cheap baked occlusion: undersides receive less sky (wings keep their vein channel)
      if (undersideAo && this.body[i * 4] !== 8) this.body[i * 4 + 3] *= 0.7 + 0.3 * sstep(-0.9, 0.5, N[i * 3 + 1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aBody', new THREE.BufferAttribute(new Float32Array(this.body), 4));
    g.setAttribute('aPivot', new THREE.BufferAttribute(new Float32Array(this.piv), 3));
    g.setIndex(nv > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    // animation moves vertices: keep a generous static bound (instances are culled manually anyway)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1.6);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-1.6, -1.6, -1.6), new THREE.Vector3(1.6, 1.6, 1.6));
    const full: CreatureRig = {
      neck: [0, 0, 0.2],
      waist: [0, 0, -0.1],
      legs: 6,
      stride: 0.6,
      duty: 0.6,
      lift: 0.07,
      crawl: 0,
      marker: [0.1, -0.25, 0, 0],
      mouth: [0, -0.02, 0.58],
      ...rig,
      triangles: this.idx.length / 3,
    };
    g.userData.rig = full;
    if (this.blendStart >= 0 && this.blendStart < this.idx.length) {
      g.addGroup(0, this.blendStart, 0);
      g.addGroup(this.blendStart, this.idx.length - this.blendStart, 1);
    }
    return g;
  }
}
