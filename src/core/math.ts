import type { CameraPose, CameraState, Vec3 } from './contracts';

/** Small vec3 helpers on plain `{x,y,z}` objects. Functions with an `out` parameter never allocate. */

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const v3clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

export function v3set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
export function v3copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}
export function v3add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}
export function v3sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}
export function v3scale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}
/** out = a + b * s */
export function v3addScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}
export const v3dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export function v3cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
export const v3len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const v3lenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export function v3dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function v3distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}
/** Normalises in place into `out`; returns the original length (0 leaves `out` = a). */
export function v3normalize(out: Vec3, a: Vec3): number {
  const l = Math.hypot(a.x, a.y, a.z);
  if (l > 1e-12) {
    const k = 1 / l;
    out.x = a.x * k;
    out.y = a.y * k;
    out.z = a.z * k;
  } else {
    out.x = a.x;
    out.y = a.y;
    out.z = a.z;
  }
  return l;
}
export function v3lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}
/** Normalised lerp of two unit vectors (falls back to `b` when they cancel out). */
export function v3nlerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const z = a.z + (b.z - a.z) * t;
  const l = Math.hypot(x, y, z);
  if (l > 1e-6) {
    out.x = x / l;
    out.y = y / l;
    out.z = z / l;
  } else {
    out.x = b.x;
    out.y = b.y;
    out.z = b.z;
  }
  return out;
}
/** Removes the component of `a` along unit `n` (projects onto the plane ⟂ n). */
export function v3projectOnPlane(out: Vec3, a: Vec3, n: Vec3): Vec3 {
  const d = a.x * n.x + a.y * n.y + a.z * n.z;
  out.x = a.x - n.x * d;
  out.y = a.y - n.y * d;
  out.z = a.z - n.z * d;
  return out;
}
/** Rotates `a` about unit `axis` by `angle` radians (Rodrigues). */
export function v3rotateAbout(out: Vec3, a: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const d = (a.x * axis.x + a.y * axis.y + a.z * axis.z) * (1 - c);
  const cx = axis.y * a.z - axis.z * a.y;
  const cy = axis.z * a.x - axis.x * a.z;
  const cz = axis.x * a.y - axis.y * a.x;
  const x = a.x * c + cx * s + axis.x * d;
  const y = a.y * c + cy * s + axis.y * d;
  const z = a.z * c + cz * s + axis.z * d;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}
/** Any unit vector perpendicular to unit `n`. */
export function v3anyPerp(out: Vec3, n: Vec3): Vec3 {
  if (Math.abs(n.y) < 0.9) v3set(out, n.z, 0, -n.x);
  else v3set(out, 0, -n.z, n.y);
  v3normalize(out, out);
  return out;
}
export const v3isFinite = (a: Vec3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---- camera math on plain CameraState (so input/ui need no three.js) ----------------------

const _r = v3();
const _u = v3();
const _d = v3();

/**
 * World-space ray through a screen point. `ndcX`, `ndcY` in −1..1 (y up). Writes the unit
 * direction to `outDir` and returns it; the origin is `cam.pos`.
 */
export function cameraRay(cam: CameraState, ndcX: number, ndcY: number, aspect: number, outDir: Vec3): Vec3 {
  const t = Math.tan((cam.fov * Math.PI) / 360);
  v3cross(_r, cam.forward, cam.up);
  v3normalize(_r, _r);
  v3cross(_u, _r, cam.forward);
  outDir.x = cam.forward.x + _r.x * ndcX * t * aspect + _u.x * ndcY * t;
  outDir.y = cam.forward.y + _r.y * ndcX * t * aspect + _u.y * ndcY * t;
  outDir.z = cam.forward.z + _r.z * ndcX * t * aspect + _u.z * ndcY * t;
  v3normalize(outDir, outDir);
  return outDir;
}

/**
 * Projects a world point to NDC (x, y in −1..1, y up; z = view depth along forward).
 * Returns false if the point is behind the camera.
 */
export function projectToNdc(cam: CameraState, p: Vec3, aspect: number, out: Vec3): boolean {
  const t = Math.tan((cam.fov * Math.PI) / 360);
  v3cross(_r, cam.forward, cam.up);
  v3normalize(_r, _r);
  v3cross(_u, _r, cam.forward);
  v3sub(_d, p, cam.pos);
  const z = v3dot(_d, cam.forward);
  out.z = z;
  if (z <= 1e-6) return false;
  out.x = v3dot(_d, _r) / (z * t * aspect);
  out.y = v3dot(_d, _u) / (z * t);
  return true;
}

/** Fills a CameraState from a pos/target pose (world-up camera). */
export function cameraFromPose(pose: CameraPose, out: CameraState): CameraState {
  v3set(out.pos, pose.pos[0], pose.pos[1], pose.pos[2]);
  v3set(out.focus, pose.target[0], pose.target[1], pose.target[2]);
  v3sub(out.forward, out.focus, out.pos);
  out.focusDist = v3normalize(out.forward, out.forward);
  // Up = world up made perpendicular to forward (falls back to +z when looking straight down).
  v3set(out.up, 0, 1, 0);
  v3projectOnPlane(out.up, out.up, out.forward);
  if (v3normalize(out.up, out.up) < 1e-4) v3set(out.up, 0, 0, -1);
  if (pose.fov) out.fov = pose.fov;
  return out;
}

export function makeCameraState(): CameraState {
  return { pos: v3(0, 10, 10), forward: v3(0, -0.7071, -0.7071), up: v3(0, 0.7071, -0.7071), fov: 45, near: 0.1, far: 600, focus: v3(), focusDist: 14 };
}

/** FNV-1a accumulator for state hashing. */
export class Hasher {
  private h = 0x811c9dc5;
  private readonly f = new Float32Array(1);
  private readonly u = new Uint32Array(this.f.buffer);
  int(n: number): this {
    let h = this.h;
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
    this.h = h;
    return this;
  }
  float(x: number): this {
    this.f[0] = x;
    return this.int(this.u[0]);
  }
  vec(v: Vec3): this {
    return this.float(v.x).float(v.y).float(v.z);
  }
  digest(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}
