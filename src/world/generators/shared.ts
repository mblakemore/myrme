import {
  ISO,
  Mat,
  WALK_MIN_DENSITY,
  type CameraPose,
  type CellIndex,
  type EnvironmentDef,
  type FoodSpawn,
  type MapExtras,
  type MapFlags,
  type MapGenOptions,
  type MapGenOptionsA1,
  type MapSite,
  type MapSiteKind,
  type MapSizePreset,
  type MaterialId,
  type Rng,
  type Vec3,
  type VoxelWorld,
} from '../../core';

// =====================================================================================
// Signed-distance toolkit. Convention everywhere in the generators: distances are in voxels
// and POSITIVE INSIDE solid (same sign as the stored density, D3).
// =====================================================================================

export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/** A bounded solid: `d` is its signed distance (+ inside), `box` bounds where `d > -2`. */
export interface Shape {
  box: Box;
  d(x: number, y: number, z: number): number;
}

/** Smooth maximum (smooth union of + inside fields). Fillet radius ≈ k. */
export function smax(a: number, b: number, k: number): number {
  if (k <= 0) return a > b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a > b ? a : b) + h * h * k * 0.25;
}

/** Smooth minimum (smooth intersection / subtraction). */
export function smin(a: number, b: number, k: number): number {
  return -smax(-a, -b, k);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function vlerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export function vdist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function padBox(b: Box, p: number): Box {
  return { x0: b.x0 - p, y0: b.y0 - p, z0: b.z0 - p, x1: b.x1 + p, y1: b.y1 + p, z1: b.z1 + p };
}

export function unionBox(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    z0: Math.min(a.z0, b.z0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    z1: Math.max(a.z1, b.z1),
  };
}

export function capsuleBox(a: Vec3, b: Vec3, r: number): Box {
  return {
    x0: Math.min(a.x, b.x) - r,
    y0: Math.min(a.y, b.y) - r,
    z0: Math.min(a.z, b.z) - r,
    x1: Math.max(a.x, b.x) + r,
    y1: Math.max(a.y, b.y) + r,
    z1: Math.max(a.z, b.z) + r,
  };
}

export function distToSegment(x: number, y: number, z: number, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((x - a.x) * abx + (y - a.y) * aby + (z - a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - a.x - abx * t, y - a.y - aby * t, z - a.z - abz * t);
}

export function sphere(c: Vec3, r: number): Shape {
  return {
    box: { x0: c.x - r - 2, y0: c.y - r - 2, z0: c.z - r - 2, x1: c.x + r + 2, y1: c.y + r + 2, z1: c.z + r + 2 },
    d: (x, y, z) => r - Math.hypot(x - c.x, y - c.y, z - c.z),
  };
}

/** Ellipsoid with a first-order distance estimate (unit gradient at the surface even when flat). */
export function ellipsoid(c: Vec3, rx: number, ry: number, rz: number): Shape {
  const rmin = Math.min(rx, ry, rz);
  const ix = 1 / rx;
  const iy = 1 / ry;
  const iz = 1 / rz;
  return {
    box: { x0: c.x - rx - 2, y0: c.y - ry - 2, z0: c.z - rz - 2, x1: c.x + rx + 2, y1: c.y + ry + 2, z1: c.z + rz + 2 },
    d: (x, y, z) => {
      const px = (x - c.x) * ix;
      const py = (y - c.y) * iy;
      const pz = (z - c.z) * iz;
      const k0 = Math.sqrt(px * px + py * py + pz * pz);
      const k1 = Math.sqrt(px * px * ix * ix + py * py * iy * iy + pz * pz * iz * iz);
      if (k1 < 1e-6) return rmin;
      const d = (k0 * (1 - k0)) / k1;
      return d > rmin ? rmin : d;
    },
  };
}

/** Capsule from `a` to `b`; the radius tapers linearly from `ra` to `rb`. */
export function capsule(a: Vec3, b: Vec3, ra: number, rb = ra): Shape {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const il2 = l2 > 0 ? 1 / l2 : 0;
  return {
    box: capsuleBox(a, b, Math.max(ra, rb) + 2),
    d: (x, y, z) => {
      let t = ((x - a.x) * abx + (y - a.y) * aby + (z - a.z) * abz) * il2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return ra + (rb - ra) * t - Math.hypot(x - a.x - abx * t, y - a.y - aby * t, z - a.z - abz * t);
    },
  };
}

/** Axis-aligned box with half extents (hx, hy, hz) and rounded edges of radius `round`. */
export function roundBox(c: Vec3, hx: number, hy: number, hz: number, round = 0): Shape {
  const ex = hx - round;
  const ey = hy - round;
  const ez = hz - round;
  return {
    box: { x0: c.x - hx - 2, y0: c.y - hy - 2, z0: c.z - hz - 2, x1: c.x + hx + 2, y1: c.y + hy + 2, z1: c.z + hz + 2 },
    d: (x, y, z) => {
      const qx = Math.abs(x - c.x) - ex;
      const qy = Math.abs(y - c.y) - ey;
      const qz = Math.abs(z - c.z) - ez;
      const ox = qx > 0 ? qx : 0;
      const oy = qy > 0 ? qy : 0;
      const oz = qz > 0 ? qz : 0;
      const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
      const inside = Math.min(Math.max(qx, qy, qz), 0);
      return round - (outside + inside);
    },
  };
}

/** Vertical cylinder (axis along y) with rounded rims. */
export function cylinderY(c: Vec3, r: number, halfHeight: number, round = 0.6): Shape {
  return {
    box: { x0: c.x - r - 2, y0: c.y - halfHeight - 2, z0: c.z - r - 2, x1: c.x + r + 2, y1: c.y + halfHeight + 2, z1: c.z + r + 2 },
    d: (x, y, z) => {
      const qr = Math.hypot(x - c.x, z - c.z) - (r - round);
      const qy = Math.abs(y - c.y) - (halfHeight - round);
      const outside = Math.hypot(Math.max(qr, 0), Math.max(qy, 0));
      return round - (outside + Math.min(Math.max(qr, qy), 0));
    },
  };
}

/** Smooth union of several shapes into one. */
export function unionOf(shapes: Shape[], k = 0): Shape {
  let box = shapes[0].box;
  for (let i = 1; i < shapes.length; i++) box = unionBox(box, shapes[i].box);
  return {
    box: padBox(box, k * 0.5),
    d: (x, y, z) => {
      let v = -1e9;
      for (let i = 0; i < shapes.length; i++) {
        const b = shapes[i].box;
        // outside a member's padded box its distance is ≤ -2: irrelevant unless nothing else is near
        if (x < b.x0 - k || x > b.x1 + k || y < b.y0 - k || y > b.y1 + k || z < b.z0 - k || z > b.z1 + k) {
          if (v < -4) v = Math.max(v, -4);
          continue;
        }
        v = smax(v, shapes[i].d(x, y, z), k);
      }
      return v;
    },
  };
}

/** Keep only the part of `s` on one side of a horizontal plane (`above` = keep y > plane). */
export function clipY(s: Shape, plane: number, above: boolean, k = 0): Shape {
  return {
    box: s.box,
    d: (x, y, z) => smin(s.d(x, y, z), above ? y - plane : plane - y, k),
  };
}

/** Keep the part of `s` behind the plane through `p` with unit normal `n` (flat sawn ends). */
export function clipPlane(s: Shape, p: Vec3, n: Vec3, k = 0): Shape {
  return {
    box: s.box,
    d: (x, y, z) => smin(s.d(x, y, z), -((x - p.x) * n.x + (y - p.y) * n.y + (z - p.z) * n.z), k),
  };
}

/** Displace a shape's surface by `amp * f(x, y, z)` (keep amp × frequency well below 1). */
export function displaced(s: Shape, f: (x: number, y: number, z: number) => number, amp: number): Shape {
  return { box: padBox(s.box, amp), d: (x, y, z) => s.d(x, y, z) + amp * f(x, y, z) };
}

/** Chain of tapered capsules through `pts` (radius r0 at the first point → r1 at the last). */
export function chain(pts: Vec3[], r0: number, r1 = r0): Shape {
  const segs: Shape[] = [];
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) segs.push(capsule(pts[i], pts[i + 1], lerp(r0, r1, i / n), lerp(r0, r1, (i + 1) / n)));
  return unionOf(segs, 0);
}

/** Sample a quadratic Bézier into `n + 1` points. */
export function bezier(p0: Vec3, p1: Vec3, p2: Vec3, n: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * t * (1 - t);
    const c = t * t;
    out.push({ x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y, z: a * p0.z + b * p1.z + c * p2.z });
  }
  return out;
}

// =====================================================================================
// Heightfields
// =====================================================================================

/** Heightfield sampled at cell centres, with the slope factor that turns Δy into distance. */
export interface HeightField {
  readonly sx: number;
  readonly sz: number;
  readonly h: Float32Array;
  readonly inv: Float32Array;
  /** Bilinear height at a world position. */
  at(x: number, z: number): number;
}

export function buildHeightField(sx: number, sz: number, fn: (x: number, z: number) => number): HeightField {
  const h = new Float32Array(sx * sz);
  const inv = new Float32Array(sx * sz);
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) h[x + sx * z] = fn(x + 0.5, z + 0.5);
  for (let z = 0; z < sz; z++)
    for (let x = 0; x < sx; x++) {
      const xa = x > 0 ? x - 1 : x;
      const xb = x < sx - 1 ? x + 1 : x;
      const za = z > 0 ? z - 1 : z;
      const zb = z < sz - 1 ? z + 1 : z;
      const gx = (h[xb + sx * z] - h[xa + sx * z]) / (xb - xa || 1);
      const gz = (h[x + sx * zb] - h[x + sx * za]) / (zb - za || 1);
      inv[x + sx * z] = 1 / Math.sqrt(1 + gx * gx + gz * gz);
    }
  return {
    sx,
    sz,
    h,
    inv,
    at(x, z) {
      const fx = clamp(x - 0.5, 0, sx - 1.001);
      const fz = clamp(z - 0.5, 0, sz - 1.001);
      const x0 = Math.floor(fx);
      const z0 = Math.floor(fz);
      const tx = fx - x0;
      const tz = fz - z0;
      const i = x0 + sx * z0;
      const a = h[i] + (h[i + 1] - h[i]) * tx;
      const b = h[i + sx] + (h[i + sx + 1] - h[i + sx]) * tx;
      return a + (b - a) * tz;
    },
  };
}

// =====================================================================================
// Canvas
// =====================================================================================

type MatArg = MaterialId | ((x: number, y: number, z: number) => MaterialId);

/**
 * Generator scratch canvas: a float signed-distance field (+ = solid, in voxels) with CSG
 * helpers. Generators compose shapes here and `commit` once into the VoxelWorld, which keeps
 * the stored density a proper clamped distance field (D3) — never write binary densities.
 *
 * Geometry rules learned in M0 (see movementCrawl / nav `wellFormed`): concave junctions must
 * stay obtuse (≥ ~100°). `blend` with k ≈ 2–3 fillets a prop into whatever it touches, which is
 * what keeps stems, logs and rocks crawlable where they meet the ground.
 */
export class SdfCanvas {
  readonly sdf: Float32Array;
  readonly mat: Uint8Array;

  constructor(
    readonly sx: number,
    readonly sy: number,
    readonly sz: number,
  ) {
    this.sdf = new Float32Array(sx * sy * sz).fill(-2);
    this.mat = new Uint8Array(sx * sy * sz);
  }

  index(x: number, y: number, z: number): number {
    return x + this.sx * (z + this.sz * y);
  }

  /**
   * Union a solid given by `dist(x, y, z)` (signed distance at a cell centre, + inside) within
   * an inclusive cell box. Cells that become solid take `material` (number or per-cell fn).
   */
  addSolid(box: Box, dist: (x: number, y: number, z: number) => number, material: MatArg, overwriteMaterial = false): void {
    this.forBox(box, (x, y, z, i) => {
      const d = dist(x + 0.5, y + 0.5, z + 0.5);
      const old = this.sdf[i];
      if (d > old) this.sdf[i] = d;
      if (d >= 0 && (old < 0 || overwriteMaterial)) this.mat[i] = typeof material === 'number' ? material : material(x, y, z);
    });
  }

  /** Subtract a shape given by its signed distance (+ inside the removed volume). */
  carve(box: Box, dist: (x: number, y: number, z: number) => number): void {
    this.forBox(box, (x, y, z, i) => {
      const d = -dist(x + 0.5, y + 0.5, z + 0.5);
      if (d < this.sdf[i]) this.sdf[i] = d;
    });
  }

  /**
   * Smooth-union a shape into the canvas. Cells inside the shape take `material`; the fillet
   * between the shape and what was there takes whichever is nearer.
   */
  blend(shape: Shape, material: MatArg, k = 0): void {
    const sdf = this.sdf;
    const mat = this.mat;
    this.forBox(k > 0 ? padBox(shape.box, k) : shape.box, (x, y, z, i) => {
      const d = shape.d(x + 0.5, y + 0.5, z + 0.5);
      if (d < -k - 2.5) return;
      const old = sdf[i];
      const v = smax(old, d, k);
      if (v > old) sdf[i] = v;
      if (v >= 0 && (d >= 0 || mat[i] === 0 || (old < 0 && d >= old))) mat[i] = typeof material === 'number' ? material : material(x, y, z);
    });
  }

  /** Smooth-subtract a shape (rounded tunnel mouths / chamber junctions with k ≈ 1). */
  cut(shape: Shape, k = 0): void {
    const sdf = this.sdf;
    this.forBox(k > 0 ? padBox(shape.box, k) : shape.box, (x, y, z, i) => {
      const d = -shape.d(x + 0.5, y + 0.5, z + 0.5);
      if (d > k + 2.5) return;
      const v = smin(sdf[i], d, k);
      if (v < sdf[i]) sdf[i] = v;
    });
  }

  /** Re-material existing solid cells: `fn` returns the new material or -1 to keep. */
  paint(box: Box, fn: (x: number, y: number, z: number, current: MaterialId, sdf: number) => number): void {
    this.forBox(box, (x, y, z, i) => {
      if (this.sdf[i] < 0) return;
      const m = fn(x, y, z, this.mat[i] as MaterialId, this.sdf[i]);
      if (m >= 0) this.mat[i] = m;
    });
  }

  /** Fill everything below a heightfield. `material(x, y, z, depth)`; depth = voxels below the surface. */
  fillTerrain(hf: HeightField, material: (x: number, y: number, z: number, depth: number) => MaterialId): void {
    const { sx, sy, sz } = this;
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        const h = hf.h[x + sx * z];
        const inv = hf.inv[x + sx * z];
        const yTop = Math.min(sy - 1, Math.ceil(h + 3));
        for (let y = 0; y <= yTop; y++) {
          const i = x + sx * (z + sz * y);
          const depth = h - (y + 0.5);
          const d = depth * inv;
          if (d > this.sdf[i]) this.sdf[i] = d;
          if (d >= 0) this.mat[i] = material(x, y, z, depth);
        }
      }
  }

  /** Height of the topmost surface in the column containing (x, z), scanning down from `fromY`. */
  topY(x: number, z: number, fromY = this.sy - 1): number {
    const ix = clamp(Math.floor(x), 0, this.sx - 1);
    const iz = clamp(Math.floor(z), 0, this.sz - 1);
    let above = -2;
    for (let y = Math.min(this.sy - 1, Math.floor(fromY)); y >= 0; y--) {
      const s = this.sdf[ix + this.sx * (iz + this.sz * y)];
      if (s >= 0) return y + 0.5 + s / (s - Math.max(above, -2) || 1);
      above = s;
    }
    return 0;
  }

  forBox(box: Box, fn: (x: number, y: number, z: number, i: number) => void): void {
    const x0 = Math.max(0, Math.floor(box.x0));
    const y0 = Math.max(0, Math.floor(box.y0));
    const z0 = Math.max(0, Math.floor(box.z0));
    const x1 = Math.min(this.sx - 1, Math.ceil(box.x1));
    const y1 = Math.min(this.sy - 1, Math.ceil(box.y1));
    const z1 = Math.min(this.sz - 1, Math.ceil(box.z1));
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) fn(x, y, z, x + this.sx * (z + this.sz * y));
  }

  fullBox(): Box {
    return { x0: 0, y0: 0, z0: 0, x1: this.sx - 1, y1: this.sy - 1, z1: this.sz - 1 };
  }

  /** Solid capsule (stems, logs, twigs). */
  addCapsule(a: Vec3, b: Vec3, radius: number, material: MaterialId): void {
    this.addSolid(capsuleBox(a, b, radius + 2), (x, y, z) => radius - distToSegment(x, y, z, a, b), material, true);
  }

  /** Carved capsule (tunnels). */
  carveCapsule(a: Vec3, b: Vec3, radius: number): void {
    this.carve(capsuleBox(a, b, radius + 2), (x, y, z) => radius - distToSegment(x, y, z, a, b));
  }

  /** Carved ellipsoid (chambers). `ry` may differ from the horizontal radius. */
  carveEllipsoid(c: Vec3, rx: number, ry: number, rz: number): void {
    const s = ellipsoid(c, rx, ry, rz);
    this.carve(s.box, s.d);
  }

  /** Write the canvas into a world (applies the glass bake) and mark everything dirty. Returns the solid cell count. */
  commit(world: VoxelWorld, fallback: MaterialId = Mat.Soil): number {
    let solid = 0;
    for (let y = 0; y < this.sy; y++)
      for (let z = 0; z < this.sz; z++)
        for (let x = 0; x < this.sx; x++) {
          const i = x + this.sx * (z + this.sz * y);
          world.setCell(x, y, z, this.sdf[i], (this.mat[i] || fallback) as MaterialId);
          if (this.sdf[i] >= 0) solid++;
        }
    world.markAllDirty();
    return solid;
  }
}

// =====================================================================================
// Placement
// =====================================================================================

/** Keeps props from piling onto each other or onto reserved ground (nest entrances, pits). */
export class Placer {
  private zones: { x: number; z: number; r: number }[] = [];

  constructor(
    readonly sx: number,
    readonly sz: number,
  ) {}

  reserve(x: number, z: number, r: number): void {
    this.zones.push({ x, z, r });
  }

  isFree(x: number, z: number, r: number, edge = 4): boolean {
    if (x < edge + r || z < edge + r || x > this.sx - edge - r || z > this.sz - edge - r) return false;
    for (const q of this.zones) if (Math.hypot(q.x - x, q.z - z) < q.r + r) return false;
    return true;
  }

  /**
   * Find a free spot (and reserve it). `around` restricts the search to a ring around a point;
   * `accept` adds a custom test. Returns null if nothing fits after `tries` attempts.
   */
  find(
    rng: Rng,
    r: number,
    o: { around?: { x: number; z: number; min: number; max: number }; accept?: (x: number, z: number) => boolean; tries?: number; edge?: number; reserve?: number } = {},
  ): { x: number; z: number } | null {
    const tries = o.tries ?? 40;
    for (let t = 0; t < tries; t++) {
      let x: number;
      let z: number;
      if (o.around) {
        const a = rng.range(0, Math.PI * 2);
        const d = rng.range(o.around.min, o.around.max);
        x = o.around.x + Math.cos(a) * d;
        z = o.around.z + Math.sin(a) * d;
      } else {
        x = rng.range(0, this.sx);
        z = rng.range(0, this.sz);
      }
      if (!this.isFree(x, z, r, o.edge ?? 4)) continue;
      if (o.accept && !o.accept(x, z)) continue;
      this.reserve(x, z, o.reserve ?? r);
      return { x, z };
    }
    return null;
  }
}

// =====================================================================================
// Post-commit queries: surface snapping and reachability
// =====================================================================================

/** y of the topmost surface in a world column (scanning down from `fromY`). */
export function surfaceY(world: VoxelWorld, x: number, z: number, fromY = world.sy - 1): number {
  const ix = clamp(Math.floor(x), 0, world.sx - 1);
  const iz = clamp(Math.floor(z), 0, world.sz - 1);
  let above = 0;
  for (let y = Math.min(world.sy - 1, Math.floor(fromY)); y >= 0; y--) {
    const d = world.density[world.index(ix, y, iz)];
    if (d >= ISO) return y + 0.5 + (d - ISO) / (d - above || 1);
    above = d;
  }
  return 0;
}

/**
 * Flood of the walkable cells connected to a start position, using the same rule as
 * `world/nav.ts` (density band + well-formed gradient + corner rule). Generators use it to
 * guarantee that food and entrances are reachable from the nest; the tests re-check with nav.
 */
export class Reach {
  readonly mark: Uint8Array;
  count = 0;
  /** Highest reachable cell y. */
  maxY = 0;
  private readonly w: VoxelWorld;

  constructor(world: VoxelWorld, from: Vec3) {
    this.w = world;
    const { sx, sy, sz } = world;
    this.mark = new Uint8Array(sx * sy * sz);
    const start = this.nearestWalkable(from, 8);
    if (start < 0) return;
    const queue = new Int32Array(sx * sy * sz >> 1);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    this.mark[start] = 1;
    const den = world.density;
    while (head < tail) {
      const c = queue[head++];
      this.count++;
      const y = Math.floor(c / (sx * sz));
      const r = c - y * sx * sz;
      const z = Math.floor(r / sx);
      const x = r - z * sx;
      if (y > this.maxY) this.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= sy) continue;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = z + dz;
          if (nz < 0 || nz >= sz) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= sx || (!dx && !dy && !dz)) continue;
            const n = nx + sx * (nz + sz * ny);
            if (this.mark[n]) continue;
            const axes = (dx ? 1 : 0) + (dy ? 1 : 0) + (dz ? 1 : 0);
            if (axes > 1) {
              // corner rule: at least one axis-aligned intermediate cell must be air
              let open = false;
              if (dx && den[c + dx] < ISO) open = true;
              else if (dz && den[c + dz * sx] < ISO) open = true;
              else if (dy && den[c + dy * sx * sz] < ISO) open = true;
              if (!open) continue;
            }
            if (!this.walkable(nx, ny, nz)) continue;
            this.mark[n] = 1;
            if (tail < queue.length) queue[tail++] = n;
          }
        }
      }
    }
  }

  walkable(x: number, y: number, z: number): boolean {
    const w = this.w;
    const d = w.density[w.index(x, y, z)];
    if (d >= ISO || d < WALK_MIN_DENSITY) return false;
    const gx = w.densityAt(x + 1, y, z) - w.densityAt(x - 1, y, z);
    const gy = w.densityAt(x, y + 1, z) - w.densityAt(x, y - 1, z);
    const gz = w.densityAt(x, y, z + 1) - w.densityAt(x, y, z - 1);
    return gx * gx + gy * gy + gz * gz >= 64 * 64;
  }

  private nearestWalkable(p: Vec3, maxR: number): CellIndex {
    return this.search(p, maxR, false);
  }

  /** Nearest REACHABLE cell to `p` within `maxR` (Chebyshev), or -1. */
  nearest(p: Vec3, maxR: number): CellIndex {
    return this.search(p, maxR, true);
  }

  private search(p: Vec3, maxR: number, reachable: boolean): CellIndex {
    const w = this.w;
    const ix = clamp(Math.floor(p.x), 0, w.sx - 1);
    const iy = clamp(Math.floor(p.y), 0, w.sy - 1);
    const iz = clamp(Math.floor(p.z), 0, w.sz - 1);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= maxR && best < 0; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dz = -r; dz <= r; dz++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const x = ix + dx;
            const y = iy + dy;
            const z = iz + dz;
            if (!w.inBounds(x, y, z)) continue;
            const c = w.index(x, y, z);
            if (reachable ? !this.mark[c] : !this.walkable(x, y, z)) continue;
            const d = (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2 + (z + 0.5 - p.z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
    }
    return best;
  }

  /** Is there a reachable cell within `r` of `p`? */
  has(p: Vec3, r = 2): boolean {
    return this.nearest(p, r) >= 0;
  }

  /** Move `p` onto the nearest reachable cell centre (within `maxR`). Returns false if none. */
  snap(p: Vec3, maxR = 10): boolean {
    const c = this.nearest(p, maxR);
    if (c < 0) return false;
    this.w.cellCenter(c, p);
    return true;
  }
}

/**
 * Keep only reachable food: each source is snapped to the nearest cell connected to the nest
 * (within `maxR`), sources with no reachable cell nearby are dropped.
 */
export function settleFood(reach: Reach, foods: FoodSpawn[], maxR = 10): FoodSpawn[] {
  return foods.filter((f) => reach.snap(f.pos, maxR));
}

// =====================================================================================
// Result scaffolding
// =====================================================================================

export function sizePreset(opts: MapGenOptions): MapSizePreset {
  if (opts.small) return 'small';
  return (opts as MapGenOptionsA1).size ?? 'medium';
}

/** Horizontal extent of outdoor maps per preset (height is always OUTDOOR_HEIGHT). */
export const OUTDOOR_SIZE: Record<MapSizePreset, number> = { small: 96, medium: 160, large: 192 };
export const OUTDOOR_HEIGHT = 64;

export function newExtras(size: MapSizePreset): MapExtras {
  return { size, materialTints: {}, strata: [], sites: [], chambers: [], tunnels: [], slabThickness: 0, surfaceY: 0, solidCells: 0 };
}

export function site(kind: MapSiteKind, pos: Vec3, radius: number, end: Vec3 = pos, level = 0): MapSite {
  return { kind, pos: { ...pos }, radius, end: { ...end }, level };
}

export function pose(pos: Vec3 | [number, number, number], target: Vec3 | [number, number, number], extra: Partial<CameraPose> = {}): CameraPose {
  const p = Array.isArray(pos) ? pos : ([pos.x, pos.y, pos.z] as [number, number, number]);
  const t = Array.isArray(target) ? target : ([target.x, target.y, target.z] as [number, number, number]);
  return { pos: [r2(p[0]), r2(p[1]), r2(p[2])], target: [r2(t[0]), r2(t[1]), r2(t[2])], cut: null, ...extra };
}

/**
 * Camera pose orbiting `target` (yaw 0 looks along -z, i.e. from the +z side; pitch 0 is level).
 * With a `world`, the pitch is raised until the line of sight from the camera to the target is clear of terrain,
 * so generated beauty poses never end up inside a hill or behind a boulder. `subject` is the
 * radius around the target that may be solid (the thing being looked at).
 */
export function orbitPose(world: VoxelWorld | null, target: Vec3, yawDeg: number, pitchDeg: number, dist: number, extra: Partial<CameraPose> = {}, subject = 5): CameraPose {
  const yaw = (yawDeg * Math.PI) / 180;
  let best: Vec3 = target;
  for (let pd = pitchDeg; pd <= 85; pd += 6) {
    const p = (pd * Math.PI) / 180;
    const cam = vec(target.x + Math.sin(yaw) * Math.cos(p) * dist, target.y + Math.sin(p) * dist, target.z + Math.cos(yaw) * Math.cos(p) * dist);
    best = cam;
    if (!world) break;
    let clear = true;
    const n = Math.ceil(dist / 1.5);
    for (let i = 0; i < n && clear; i++) {
      const t = i / n;
      if ((1 - t) * dist < subject) break; // the last few voxels belong to the subject
      const x = cam.x + (target.x - cam.x) * t;
      const y = cam.y + (target.y - cam.y) * t;
      const z = cam.z + (target.z - cam.z) * t;
      if (y >= world.sy - 1 || x < 1 || z < 1 || x > world.sx - 1 || z > world.sz - 1) continue; // outside the block: open air
      if (world.sample(x, y, z) > -0.6) clear = false;
    }
    if (clear) break;
  }
  return pose(best, target, extra);
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function norm(x: number, y: number, z: number): Vec3 {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
}

export function outdoorEnvironment(): EnvironmentDef {
  return {
    backdrop: 'sky',
    sunDir: norm(0.45, 0.8, 0.35),
    sunColor: [1.0, 0.95, 0.84],
    sunIntensity: 2.6,
    skyTop: [0.2, 0.45, 0.88],
    skyHorizon: [0.7, 0.82, 0.93],
    groundColor: [0.3, 0.25, 0.18],
    ambientIntensity: 0.5,
    fogColor: [0.7, 0.81, 0.92],
    fogDensity: 0.0022,
    dayLength: 480,
    baseTemperature: 22,
    rainChance: 0.3,
  };
}

/** Under the canopy: low green-gold light, humid haze, frequent rain. */
export function forestEnvironment(): EnvironmentDef {
  return {
    backdrop: 'sky',
    sunDir: norm(-0.5, 0.62, 0.42),
    sunColor: [1.0, 0.9, 0.66],
    sunIntensity: 2.1,
    skyTop: [0.1, 0.26, 0.2],
    skyHorizon: [0.42, 0.56, 0.4],
    groundColor: [0.14, 0.13, 0.08],
    ambientIntensity: 0.42,
    fogColor: [0.36, 0.47, 0.36],
    fogDensity: 0.0052,
    dayLength: 480,
    baseTemperature: 17,
    rainChance: 0.55,
  };
}

/** Hard high sun, pale sky, heat haze, almost never rains. */
export function desertEnvironment(): EnvironmentDef {
  return {
    backdrop: 'sky',
    sunDir: norm(0.3, 0.9, -0.25),
    sunColor: [1.0, 0.93, 0.78],
    sunIntensity: 3.3,
    skyTop: [0.24, 0.5, 0.86],
    skyHorizon: [0.93, 0.84, 0.68],
    groundColor: [0.5, 0.4, 0.26],
    ambientIntensity: 0.58,
    fogColor: [0.93, 0.83, 0.67],
    fogDensity: 0.003,
    dayLength: 480,
    baseTemperature: 36,
    rainChance: 0.04,
  };
}

export function roomEnvironment(): EnvironmentDef {
  return {
    backdrop: 'room',
    sunDir: norm(0.3, 0.75, 0.6),
    sunColor: [1.0, 0.93, 0.82],
    sunIntensity: 1.8,
    skyTop: [0.07, 0.08, 0.11],
    skyHorizon: [0.2, 0.18, 0.18],
    groundColor: [0.13, 0.1, 0.085],
    ambientIntensity: 0.75,
    fogColor: [0.12, 0.12, 0.14],
    fogDensity: 0,
    dayLength: 0,
    baseTemperature: 23,
    rainChance: 0,
  };
}

export function outdoorFlags(): MapFlags {
  return { slab: false, slabAxis: 'z', weather: true, dayNight: true, keeperEvents: false, predators: true, rivals: true };
}

export function farmFlags(): MapFlags {
  return { slab: true, slabAxis: 'z', weather: false, dayNight: false, keeperEvents: true, predators: false, rivals: false };
}
