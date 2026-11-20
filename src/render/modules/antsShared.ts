import type { Ant, CameraState, Mover, ViewState, VoxelWorld } from '../../core';

/**
 * Small runtime helpers shared by the A4 modules (ants, brood, items, selection) and usable by
 * B4's creature module: pose → matrix writers, manual frustum test, far-zoom scale
 * exaggeration, and the per-ant render state store. No allocation in any per-frame path.
 */

/** Writes a mover's interpolated transform (column-major) into `out` at `offset`. */
export function writeMoverMatrix(m: Readonly<Mover>, alpha: number, scale: number, out: Float32Array | number[], offset: number, lift = 0): void {
  const b = 1 - alpha;
  let ux = m.prevUp.x * b + m.up.x * alpha;
  let uy = m.prevUp.y * b + m.up.y * alpha;
  let uz = m.prevUp.z * b + m.up.z * alpha;
  let l = Math.hypot(ux, uy, uz) || 1;
  ux /= l;
  uy /= l;
  uz /= l;
  let fx = m.prevForward.x * b + m.forward.x * alpha;
  let fy = m.prevForward.y * b + m.forward.y * alpha;
  let fz = m.prevForward.z * b + m.forward.z * alpha;
  const d = fx * ux + fy * uy + fz * uz;
  fx -= ux * d;
  fy -= uy * d;
  fz -= uz * d;
  l = Math.hypot(fx, fy, fz);
  if (l < 1e-5) {
    fx = m.forward.x;
    fy = m.forward.y;
    fz = m.forward.z;
    l = Math.hypot(fx, fy, fz) || 1;
  }
  fx /= l;
  fy /= l;
  fz /= l;
  // right = up × forward
  const rx = uy * fz - uz * fy;
  const ry = uz * fx - ux * fz;
  const rz = ux * fy - uy * fx;
  const px = m.prevPos.x * b + m.pos.x * alpha + ux * lift;
  const py = m.prevPos.y * b + m.pos.y * alpha + uy * lift;
  const pz = m.prevPos.z * b + m.pos.z * alpha + uz * lift;
  out[offset] = rx * scale;
  out[offset + 1] = ry * scale;
  out[offset + 2] = rz * scale;
  out[offset + 3] = 0;
  out[offset + 4] = ux * scale;
  out[offset + 5] = uy * scale;
  out[offset + 6] = uz * scale;
  out[offset + 7] = 0;
  out[offset + 8] = fx * scale;
  out[offset + 9] = fy * scale;
  out[offset + 10] = fz * scale;
  out[offset + 11] = 0;
  out[offset + 12] = px;
  out[offset + 13] = py;
  out[offset + 14] = pz;
  out[offset + 15] = 1;
}

/**
 * Composes `out[offset..]` = M × T(local) × R × S(scale), where M is a 4×4 already stored in
 * `m[mOff..]` (e.g. a carrier's body matrix). R is given by pitch (about local X) and yaw (about
 * local Y). Used to attach carried things at the mandibles.
 */
export function writeAttachedMatrix(m: Float32Array | number[], mOff: number, lx: number, ly: number, lz: number, pitch: number, yaw: number, scale: number, out: Float32Array | number[], offset: number): void {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // R = Ry(yaw) · Rx(pitch), columns:
  const r00 = cy;
  const r10 = 0;
  const r20 = -sy;
  const r01 = sy * sp;
  const r11 = cp;
  const r21 = cy * sp;
  const r02 = sy * cp;
  const r12 = -sp;
  const r22 = cy * cp;
  const a0 = m[mOff];
  const a1 = m[mOff + 1];
  const a2 = m[mOff + 2];
  const b0 = m[mOff + 4];
  const b1 = m[mOff + 5];
  const b2 = m[mOff + 6];
  const c0 = m[mOff + 8];
  const c1 = m[mOff + 9];
  const c2 = m[mOff + 10];
  // the carrier matrix is scaled by its length; normalise so `scale` is in world units
  const ml = Math.hypot(a0, a1, a2) || 1;
  const k = scale / ml;
  out[offset] = (a0 * r00 + b0 * r10 + c0 * r20) * k;
  out[offset + 1] = (a1 * r00 + b1 * r10 + c1 * r20) * k;
  out[offset + 2] = (a2 * r00 + b2 * r10 + c2 * r20) * k;
  out[offset + 3] = 0;
  out[offset + 4] = (a0 * r01 + b0 * r11 + c0 * r21) * k;
  out[offset + 5] = (a1 * r01 + b1 * r11 + c1 * r21) * k;
  out[offset + 6] = (a2 * r01 + b2 * r11 + c2 * r21) * k;
  out[offset + 7] = 0;
  out[offset + 8] = (a0 * r02 + b0 * r12 + c0 * r22) * k;
  out[offset + 9] = (a1 * r02 + b1 * r12 + c1 * r22) * k;
  out[offset + 10] = (a2 * r02 + b2 * r12 + c2 * r22) * k;
  out[offset + 11] = 0;
  out[offset + 12] = a0 * lx + b0 * ly + c0 * lz + m[mOff + 12];
  out[offset + 13] = a1 * lx + b1 * ly + c1 * lz + m[mOff + 13];
  out[offset + 14] = a2 * lx + b2 * ly + c2 * lz + m[mOff + 14];
  out[offset + 15] = 1;
}

/**
 * Matrix for something resting on a surface: Y = `up`, heading from `yaw` (radians, arbitrary
 * but stable reference), non-uniform scale (sx, sy, sz), origin lifted `lift` along up.
 */
export function writeSurfaceMatrix(px: number, py: number, pz: number, ux: number, uy: number, uz: number, yaw: number, sx: number, sy: number, sz: number, lift: number, out: Float32Array | number[], offset: number): void {
  let l = Math.hypot(ux, uy, uz);
  if (l < 1e-5) {
    ux = 0;
    uy = 1;
    uz = 0;
    l = 1;
  }
  ux /= l;
  uy /= l;
  uz /= l;
  // any tangent
  let tx: number;
  let ty: number;
  let tz: number;
  if (Math.abs(uy) < 0.9) {
    tx = uz;
    ty = 0;
    tz = -ux;
  } else {
    tx = 0;
    ty = -uz;
    tz = uy;
  }
  l = Math.hypot(tx, ty, tz) || 1;
  tx /= l;
  ty /= l;
  tz /= l;
  // bitangent = up × t
  const bx = uy * tz - uz * ty;
  const by = uz * tx - ux * tz;
  const bz = ux * ty - uy * tx;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // forward = t·c + b·s ; right = up × forward
  const fx = tx * c + bx * s;
  const fy = ty * c + by * s;
  const fz = tz * c + bz * s;
  const rx = uy * fz - uz * fy;
  const ry = uz * fx - ux * fz;
  const rz = ux * fy - uy * fx;
  out[offset] = rx * sx;
  out[offset + 1] = ry * sx;
  out[offset + 2] = rz * sx;
  out[offset + 3] = 0;
  out[offset + 4] = ux * sy;
  out[offset + 5] = uy * sy;
  out[offset + 6] = uz * sy;
  out[offset + 7] = 0;
  out[offset + 8] = fx * sz;
  out[offset + 9] = fy * sz;
  out[offset + 10] = fz * sz;
  out[offset + 11] = 0;
  out[offset + 12] = px + ux * lift;
  out[offset + 13] = py + uy * lift;
  out[offset + 14] = pz + uz * lift;
  out[offset + 15] = 1;
}

/** Camera-space sphere test built from the plain CameraState (no three.js matrices needed). */
export class ViewCuller {
  private px = 0;
  private py = 0;
  private pz = 0;
  private fx = 0;
  private fy = 0;
  private fz = 1;
  private ux = 0;
  private uy = 1;
  private uz = 0;
  private rx = 1;
  private ry = 0;
  private rz = 0;
  private tanY = 1;
  private tanX = 1;
  private secY = 1;
  private secX = 1;
  private far = 1000;
  /** Pixels covered by one world unit at distance 1. */
  pxScale = 500;

  set(cam: Readonly<CameraState>, aspect: number, viewportHeightPx: number): void {
    this.px = cam.pos.x;
    this.py = cam.pos.y;
    this.pz = cam.pos.z;
    this.fx = cam.forward.x;
    this.fy = cam.forward.y;
    this.fz = cam.forward.z;
    // right = forward × up, then re-derive up so the basis is orthonormal
    let rx = this.fy * cam.up.z - this.fz * cam.up.y;
    let ry = this.fz * cam.up.x - this.fx * cam.up.z;
    let rz = this.fx * cam.up.y - this.fy * cam.up.x;
    const l = Math.hypot(rx, ry, rz) || 1;
    rx /= l;
    ry /= l;
    rz /= l;
    this.rx = rx;
    this.ry = ry;
    this.rz = rz;
    this.ux = ry * this.fz - rz * this.fy;
    this.uy = rz * this.fx - rx * this.fz;
    this.uz = rx * this.fy - ry * this.fx;
    this.tanY = Math.tan((cam.fov * Math.PI) / 360);
    this.tanX = this.tanY * aspect;
    this.secY = Math.hypot(1, this.tanY);
    this.secX = Math.hypot(1, this.tanX);
    this.far = cam.far;
    this.pxScale = viewportHeightPx / (2 * this.tanY);
  }

  /** Distance along the view axis, or −1 if the sphere is outside the frustum. */
  depthIfVisible(x: number, y: number, z: number, r: number): number {
    const dx = x - this.px;
    const dy = y - this.py;
    const dz = z - this.pz;
    const zc = dx * this.fx + dy * this.fy + dz * this.fz;
    if (zc < -r || zc > this.far + r) return -1;
    const xc = dx * this.rx + dy * this.ry + dz * this.rz;
    if (Math.abs(xc) > zc * this.tanX + r * this.secX) return -1;
    const yc = dx * this.ux + dy * this.uy + dz * this.uz;
    if (Math.abs(yc) > zc * this.tanY + r * this.secY) return -1;
    return Math.max(zc, 1e-3);
  }

  dist(x: number, y: number, z: number): number {
    return Math.hypot(x - this.px, y - this.py, z - this.pz);
  }
}

/**
 * Readability aid: at far RTS zoom ants are drawn slightly larger than life (up to +70%).
 * Everything attached to an ant (carried items, rings) must use the same factor.
 */
export function farScale(view: Readonly<ViewState>, dist: number): number {
  if (view.mode === 'possess') return 1;
  const t = (dist - 26) / 90;
  return t <= 0 ? 1 : 1 + 0.7 * (t >= 1 ? 1 : t * t * (3 - 2 * t));
}

/** Per-ant render-side state, indexed by entity id (ids are never reused, D-§5.2). */
export class AntStateStore {
  cap = 0;
  /** Gait phase in cycles (fractional part). */
  odo = new Float32Array(0);
  /** Smoothed speed 0..1. */
  spd = new Float32Array(0);
  /** Animation-clock time of the last bite / hit taken. */
  biteAt = new Float32Array(0);
  hurtAt = new Float32Array(0);
  /** Smoothed carry pose 0..1. */
  carry = new Float32Array(0);
  /** Sun exposure 0..1 (−1 = not sampled yet). */
  sun = new Float32Array(0);
  /** Smoothed grapple-cling amount 0..1 (latched onto a creature's body). */
  cling = new Float32Array(0);

  ensure(id: number): void {
    if (id < this.cap) return;
    const cap = Math.max(1024, Math.ceil((id + 1) * 1.5));
    const grow = (old: Float32Array, fill: number): Float32Array<ArrayBuffer> => {
      const a = new Float32Array(cap);
      if (fill !== 0) a.fill(fill, old.length);
      a.set(old);
      return a;
    };
    this.odo = grow(this.odo, 0);
    this.spd = grow(this.spd, 0);
    this.biteAt = grow(this.biteAt, -1e6);
    this.hurtAt = grow(this.hurtAt, -1e6);
    this.carry = grow(this.carry, 0);
    this.sun = grow(this.sun, -1);
    this.cling = grow(this.cling, 0);
    this.cap = cap;
  }

  reset(): void {
    this.cap = 0;
    this.odo = new Float32Array(0);
    this.spd = new Float32Array(0);
    this.biteAt = new Float32Array(0);
    this.hurtAt = new Float32Array(0);
    this.carry = new Float32Array(0);
    this.sun = new Float32Array(0);
  }
}

/** The one store, written by the ants module, readable by brood/items/selection. */
export const antState = new AntStateStore();

const rayO = { x: 0, y: 0, z: 0 };
const rayD = { x: 0, y: 1, z: 0 };
const RAY_VISUAL = { visual: true } as const;

/**
 * How exposed a point is to the sun: one voxel ray towards it (visual semantics, so glass panes
 * do not count as blockers). 1 = open sky, 0 = something solid in the way within 70 units.
 */
export function sunExposure(world: VoxelWorld, x: number, y: number, z: number, sx: number, sy: number, sz: number): number {
  // start a little off the surface the creature stands on
  rayO.x = x + sx * 0.35;
  rayO.y = y + sy * 0.35;
  rayO.z = z + sz * 0.35;
  rayD.x = sx;
  rayD.y = sy;
  rayD.z = sz;
  const hit = world.raycast(rayO, rayD, 70, RAY_VISUAL);
  return hit && !hit.boundary ? 0 : 1;
}

/** 0..1 visual infection amount from the sim's stage. */
export function infectionAmount(a: Readonly<Ant>): number {
  switch (a.infection.stage) {
    case 'none':
      return 0;
    case 'exposed':
      return 0.08;
    case 'incubating':
      return 0.25;
    case 'erratic':
      return 0.5;
    case 'summit':
      return 0.7;
    case 'gripped':
      return 0.85;
    default:
      return 1;
  }
}

/** Rotates the basis of a column-major matrix at `o` about its own X (right) axis: positive = nose up. */
export function pitchMatrix(m: Float32Array | number[], o: number, ang: number): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  for (let i = 0; i < 3; i++) {
    const y = m[o + 4 + i];
    const z = m[o + 8 + i];
    m[o + 4 + i] = y * c - z * s;
    m[o + 8 + i] = y * s + z * c;
  }
}

/** Rotates the basis about its own Z (forward) axis: roll. */
export function rollMatrix(m: Float32Array | number[], o: number, ang: number): void {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  for (let i = 0; i < 3; i++) {
    const x = m[o + i];
    const y = m[o + 4 + i];
    m[o + i] = x * c + y * s;
    m[o + 4 + i] = -x * s + y * c;
  }
}

/**
 * Far-zoom scale for SMALL things (brood, loose items, food pieces): the ant exaggeration, raised
 * further so the object never drops below `minPx` on screen (capped at ×2.6) — at whole-nest zoom
 * an egg pile or a crumb must still read as a pile or a crumb. `px` = unscaled size in pixels.
 */
export function readableScale(view: Readonly<ViewState>, dist: number, px: number, minPx: number): number {
  if (view.mode === 'possess') return 1;
  const ex = farScale(view, dist);
  if (px >= minPx) return ex;
  const want = minPx / Math.max(px, 0.05);
  return Math.max(ex, want > 2.6 ? 2.6 : want);
}
