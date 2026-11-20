import {
  cameraFromPose,
  clamp,
  v3,
  v3addScaled,
  v3copy,
  v3cross,
  v3dot,
  v3normalize,
  v3projectOnPlane,
  v3rotateAbout,
  v3set,
  type Ant,
  type CameraPose,
  type CameraState,
  type CutPlane,
  type MapGenResult,
  type Vec3,
  type VoxelWorld,
} from '../core';

/**
 * Camera rigs (§5.4, D14). Each rig owns a goal state (what the player asked for) and a smoothed
 * current state (what is shown) and writes a plain `CameraState`; the Renderer copies that to the
 * three.js camera. No three.js here.
 */

const _a = v3();
const _b = v3();
const _r = v3();
const _p = v3();

/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate: number, dt: number): number => (dt <= 0 ? 0 : 1 - Math.exp(-rate * dt));

/** Spherical interpolation of unit vectors (falls back to `b` for opposite vectors). */
export function v3slerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  const d = clamp(v3dot(a, b), -1, 1);
  if (d > 0.9995) {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    v3normalize(out, out);
    return out;
  }
  if (d < -0.9995) {
    // antiparallel: rotate about any perpendicular axis
    const ax = Math.abs(a.y) < 0.9 ? v3set(_p, a.z, 0, -a.x) : v3set(_p, 0, -a.z, a.y);
    v3normalize(ax, ax);
    return v3rotateAbout(out, a, ax, Math.PI * t);
  }
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  const x = a.x * wa + b.x * wb;
  const y = a.y * wa + b.y * wb;
  const z = a.z * wa + b.z * wb;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyCamera(out: CameraState, a: CameraState): CameraState {
  v3copy(out.pos, a.pos);
  v3copy(out.forward, a.forward);
  v3copy(out.up, a.up);
  v3copy(out.focus, a.focus);
  out.fov = a.fov;
  out.near = a.near;
  out.far = a.far;
  out.focusDist = a.focusDist;
  return out;
}

/** `out = mix(from, to, t)` with spherical blending of the orientation. `out` may alias `to`. */
export function blendCamera(out: CameraState, from: CameraState, to: CameraState, t: number): CameraState {
  const u = 1 - t;
  v3set(out.pos, from.pos.x * u + to.pos.x * t, from.pos.y * u + to.pos.y * t, from.pos.z * u + to.pos.z * t);
  v3set(out.focus, from.focus.x * u + to.focus.x * t, from.focus.y * u + to.focus.y * t, from.focus.z * u + to.focus.z * t);
  v3slerp(out.forward, from.forward, to.forward, t);
  v3slerp(out.up, from.up, to.up, t);
  v3projectOnPlane(out.up, out.up, out.forward);
  if (v3normalize(out.up, out.up) < 1e-4) v3copy(out.up, to.up);
  out.fov = from.fov * u + to.fov * t;
  out.near = from.near * u + to.near * t;
  out.far = from.far * u + to.far * t;
  out.focusDist = from.focusDist * u + to.focusDist * t;
  return out;
}

/** Timed blend from a captured camera to whatever the active rig produces (fly-in / fly-out). */
export class CameraBlend {
  private readonly from: CameraState = { pos: v3(), forward: v3(0, 0, -1), up: v3(0, 1, 0), fov: 45, near: 0.1, far: 900, focus: v3(), focusDist: 1 };
  private t = 1;
  private dur = 0.6;

  get active(): boolean {
    return this.t < 1;
  }
  /** 0 at the start of a transition, 1 when settled. */
  get progress(): number {
    return this.t;
  }

  /** Capture `cam` as the start of a blend lasting `dur` seconds. */
  start(cam: CameraState, dur: number): void {
    copyCamera(this.from, cam);
    this.dur = Math.max(0.05, dur);
    this.t = 0;
  }

  finish(): void {
    this.t = 1;
  }

  /** Advance and blend `cam` (already written by the rig) with the captured start. */
  apply(cam: CameraState, dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / this.dur);
    if (this.t >= 1) return;
    const e = this.t * this.t * (3 - 2 * this.t);
    blendCamera(cam, this.from, cam, e);
  }
}

function hiddenByCut(p: Vec3, cut: CutPlane | null): boolean {
  if (!cut || !cut.enabled) return false;
  const c = cut.axis === 'x' ? p.x : cut.axis === 'y' ? p.y : p.z;
  return cut.sign * (c - cut.pos) > 0;
}

function setFromOrbit(cam: CameraState, pivot: Vec3, dist: number, yaw: number, pitch: number): void {
  // yaw 0 looks towards −z; pitch > 0 looks down
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = -Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;
  v3set(cam.forward, fx, fy, fz);
  v3set(cam.pos, pivot.x - fx * dist, pivot.y - fy * dist, pivot.z - fz * dist);
  v3set(cam.up, 0, 1, 0);
  v3projectOnPlane(cam.up, cam.up, cam.forward);
  if (v3normalize(cam.up, cam.up) < 1e-4) v3set(cam.up, -Math.sin(yaw), 0, -Math.cos(yaw));
  v3copy(cam.focus, pivot);
  cam.focusDist = dist;
}

function poseOrbit(pose: CameraPose): { dist: number; yaw: number; pitch: number } {
  const dx = pose.target[0] - pose.pos[0];
  const dy = pose.target[1] - pose.pos[1];
  const dz = pose.target[2] - pose.pos[2];
  const dist = Math.hypot(dx, dy, dz) || 1;
  return { dist, yaw: Math.atan2(-dx, -dz), pitch: Math.asin(clamp(-dy / dist, -1, 1)) };
}

export const RTS_PITCH_MIN = 0.04;
export const RTS_PITCH_MAX = 1.5;

/**
 * RTS orbit camera. Damped pan / zoom / orbit around a focus point that rides the terrain;
 * zooms from a canopy overview down to macro distance, towards the cursor; never ends up inside
 * terrain (the boom is pulled in while the eye would be in solid). With a cutaway active the
 * focus lives on the cut plane and panning moves along the exposed cross-section.
 */
export class RtsRig {
  /** Goal state. */
  readonly target = v3();
  dist = 40;
  yaw = 0;
  pitch = 0.75;
  /** Smoothed state. */
  private readonly cTarget = v3();
  private cDist = 40;
  private cYaw = 0;
  private cPitch = 0.75;
  /** Boom length actually used after terrain collision (≤ cDist). */
  private boom = 40;
  /** Visible ground height under the focus, fed by the input layer (null = unknown / disabled). */
  groundY: number | null = null;
  readonly minDist = 1.6;
  readonly maxDist: number;
  /** Pitch to restore when the cutaway is switched off again. */
  private savedPitch: number | null = null;

  constructor(private readonly world: VoxelWorld) {
    this.maxDist = Math.max(120, Math.hypot(world.sx, world.sz) * 0.9);
    v3set(this.target, world.sx / 2, world.sy / 2, world.sz / 2);
    this.snap();
  }

  get currentDist(): number {
    return this.cDist;
  }
  get currentYaw(): number {
    return this.cYaw;
  }

  fromPose(pose: CameraPose): void {
    // the rig looks at a pivot 0.3 above its target (see `pivot`)
    v3set(this.target, pose.target[0], pose.target[1] - 0.3, pose.target[2]);
    const o = poseOrbit(pose);
    this.dist = clamp(o.dist, this.minDist, this.maxDist);
    this.yaw = o.yaw;
    this.pitch = clamp(o.pitch, RTS_PITCH_MIN, RTS_PITCH_MAX);
    this.savedPitch = null;
    this.snap();
  }

  /** Snap the smoothed state onto the goal. */
  snap(): void {
    v3copy(this.cTarget, this.target);
    this.cDist = this.boom = this.dist;
    this.cYaw = this.yaw;
    this.cPitch = this.pitch;
  }

  private clampTarget(cut: CutPlane | null): void {
    const w = this.world;
    const t = this.target;
    t.x = clamp(t.x, 0, w.sx);
    t.y = clamp(t.y, 0, w.sy);
    t.z = clamp(t.z, 0, w.sz);
    if (cut && cut.enabled) {
      if (cut.axis === 'x') t.x = cut.pos;
      else if (cut.axis === 'y') t.y = cut.pos;
      else t.z = cut.pos;
    }
  }

  /**
   * Pan by `right` / `fwd` (−1..1) scaled by `amount` world units. Without a cutaway this moves
   * over the ground plane; with a vertical cut plane it moves along the cross-section (W/S = up /
   * down the face as seen on screen).
   */
  pan(right: number, fwd: number, amount: number, cut: CutPlane | null): void {
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const t = this.target;
    if (cut && cut.enabled && cut.axis !== 'y') {
      const sp = Math.sin(this.pitch);
      const cp = Math.cos(this.pitch);
      // screen right / screen up projected onto the cut plane
      v3set(_a, cy, 0, -sy);
      v3set(_b, -sy * sp, cp, -cy * sp);
      if (cut.axis === 'x') _a.x = _b.x = 0;
      else _a.z = _b.z = 0;
      const la = v3normalize(_a, _a);
      const lb = v3normalize(_b, _b);
      if (la > 0.05) v3addScaled(t, t, _a, right * amount);
      if (lb > 0.05) v3addScaled(t, t, _b, fwd * amount);
    } else {
      // forward on the ground plane = (−sin yaw, −cos yaw); right = (cos yaw, −sin yaw)
      t.x += (cy * right - sy * fwd) * amount;
      t.z += (-sy * right - cy * fwd) * amount;
    }
    this.clampTarget(cut);
  }

  orbit(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, RTS_PITCH_MIN, RTS_PITCH_MAX);
    if (dPitch !== 0) this.savedPitch = null;
  }

  /**
   * Multiply the distance by `factor`, keeping `anchor` (the world point under the cursor) fixed
   * on screen by sliding the focus towards / away from it.
   */
  zoomAt(factor: number, anchor: Vec3 | null, cut: CutPlane | null): void {
    const nd = clamp(this.dist * factor, this.minDist, this.maxDist);
    const f = nd / this.dist;
    this.dist = nd;
    if (anchor && f !== 1) {
      const t = this.target;
      t.x = anchor.x + (t.x - anchor.x) * f;
      t.z = anchor.z + (t.z - anchor.z) * f;
      t.y = anchor.y + (t.y - anchor.y) * f;
      this.clampTarget(cut);
    }
  }

  /** Look at a world position (optionally from a new distance). Smoothed unless snapped. */
  lookAt(pos: Vec3, dist: number | null, cut: CutPlane | null): void {
    v3copy(this.target, pos);
    if (dist !== null) this.dist = clamp(dist, this.minDist, this.maxDist);
    this.clampTarget(cut);
  }

  /**
   * Cutaway switched on: tilt down and swing round to face the cross-section roughly square-on
   * (`squareYaw` = yaw that looks straight at the cut face; an oblique view shows mostly the
   * world's side wall); off: restore the old pitch.
   */
  onCutToggle(enabled: boolean, vertical: boolean, squareYaw: number | null = null): void {
    if (enabled && vertical) {
      if (this.pitch > 0.5) {
        this.savedPitch = this.pitch;
        this.pitch = 0.34;
      }
      if (squareYaw !== null) {
        // nearest equivalent of the square-on yaw, then keep at most a little parallax
        const d = Math.atan2(Math.sin(this.yaw - squareYaw), Math.cos(this.yaw - squareYaw));
        this.yaw = this.yaw - d + clamp(d, -0.22, 0.22);
      }
    } else if (!enabled && this.savedPitch !== null) {
      this.pitch = this.savedPitch;
      this.savedPitch = null;
    }
  }

  /** Advance the smoothing by `dt` seconds (0 = snap) and resolve terrain collision. */
  update(dt: number, cut: CutPlane | null): void {
    const cutOn = !!cut && cut.enabled;
    if (!cutOn && this.groundY !== null) {
      // ride the visible ground (goal eases, so cresting a pebble is not a jolt)
      this.target.y += (this.groundY - this.target.y) * (dt <= 0 ? 1 : damp(7, dt));
    }
    if (dt <= 0) {
      this.snap();
    } else {
      const kt = damp(11, dt);
      this.cTarget.x += (this.target.x - this.cTarget.x) * kt;
      this.cTarget.y += (this.target.y - this.cTarget.y) * kt;
      this.cTarget.z += (this.target.z - this.cTarget.z) * kt;
      this.cDist += (this.dist - this.cDist) * damp(10, dt);
      this.cYaw += (this.yaw - this.cYaw) * damp(13, dt);
      this.cPitch += (this.pitch - this.cPitch) * damp(13, dt);
    }
    // --- collision: the eye may not sit inside (or hug) solid terrain ---
    const want = this.resolveBoom(cut);
    if (dt <= 0 || want < this.boom) this.boom = want;
    else this.boom += (want - this.boom) * damp(5, dt);
    this.boom = Math.min(this.boom, this.cDist);
  }

  private pivot(out: Vec3): Vec3 {
    // look slightly above the surface so a flat macro view keeps the eye clear of the ground
    return v3set(out, this.cTarget.x, this.cTarget.y + 0.3, this.cTarget.z);
  }

  private eyeClear(p: Vec3, cut: CutPlane | null): boolean {
    return hiddenByCut(p, cut) || this.world.sampleVisual(p.x, p.y, p.z) < -0.3;
  }

  private resolveBoom(cut: CutPlane | null): number {
    const cp = Math.cos(this.cPitch);
    const bx = Math.sin(this.cYaw) * cp;
    const by = Math.sin(this.cPitch);
    const bz = Math.cos(this.cYaw) * cp;
    this.pivot(_b);
    let d = this.cDist;
    v3set(_p, _b.x + bx * d, _b.y + by * d, _b.z + bz * d);
    if (this.eyeClear(_p, cut)) return d;
    const step = Math.max(0.2, d * 0.03);
    for (let i = 0; i < 64 && d > 0.6; i++) {
      d -= step;
      v3set(_p, _b.x + bx * d, _b.y + by * d, _b.z + bz * d);
      if (this.eyeClear(_p, cut)) return Math.max(0.6, d - step * 0.5);
    }
    return this.cDist; // focus itself is buried (e.g. following an ant underground): leave it
  }

  apply(cam: CameraState): void {
    setFromOrbit(cam, this.pivot(_b), this.boom, this.cYaw, this.cPitch);
    cam.fov = 45;
    cam.near = Math.max(0.05, this.boom * 0.02);
    cam.far = 900;
  }
}

/**
 * Farm slab camera: faces a pane, pans / zooms in the pane plane, with a slight parallax orbit.
 * `flip()` swings around to look through the other pane.
 */
export class SlabRig {
  /** Goal state. */
  readonly target = v3();
  dist = 70;
  /** Orbit offsets from square-on (radians). */
  yawOff = 0;
  pitch = 0;
  /** +1: camera on the +axis side of the slab; −1: the other pane. */
  side: 1 | -1 = 1;
  private readonly cTarget = v3();
  private cDist = 70;
  private cYawOff = 0;
  private cPitch = 0;
  /** Smoothed swing angle of a flip: 0 for side +1, π for side −1. */
  private cSwing = 0;
  readonly minDist = 3.5;
  readonly maxDist: number;
  readonly maxYaw = 0.6;
  readonly maxPitch = 0.4;

  constructor(
    private readonly world: VoxelWorld,
    private readonly axis: 'x' | 'z' = 'z',
  ) {
    this.maxDist = Math.max(100, Math.max(world.sx, world.sy, world.sz) * 1.6);
    v3set(this.target, world.sx / 2, world.sy / 2, world.sz / 2);
    this.snap();
  }

  get currentDist(): number {
    return this.cDist;
  }

  /** Yaw of a square-on view for the current side (yaw 0 looks towards −z). */
  private baseYaw(): number {
    return this.axis === 'z' ? 0 : Math.PI / 2;
  }

  private pin(): void {
    const w = this.world;
    const t = this.target;
    t.x = clamp(t.x, 0, w.sx);
    t.y = clamp(t.y, 0, w.sy);
    t.z = clamp(t.z, 0, w.sz);
    if (this.axis === 'z') t.z = w.sz / 2;
    else t.x = w.sx / 2;
  }

  fromPose(pose: CameraPose): void {
    v3set(this.target, pose.target[0], pose.target[1], pose.target[2]);
    this.pin();
    const o = poseOrbit(pose);
    this.dist = clamp(o.dist, this.minDist, this.maxDist);
    // which side of the slab is the camera on?
    const off = this.axis === 'z' ? pose.pos[2] - this.world.sz / 2 : pose.pos[0] - this.world.sx / 2;
    this.side = off >= 0 ? 1 : -1;
    let rel = o.yaw - this.baseYaw() - (this.side < 0 ? Math.PI : 0);
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    this.yawOff = clamp(rel, -this.maxYaw, this.maxYaw);
    this.pitch = clamp(o.pitch, -this.maxPitch, this.maxPitch);
    this.snap();
  }

  snap(): void {
    v3copy(this.cTarget, this.target);
    this.cDist = this.dist;
    this.cYawOff = this.yawOff;
    this.cPitch = this.pitch;
    this.cSwing = this.side > 0 ? 0 : Math.PI;
  }

  /** Pan along the pane: `right` is screen-right for the current side, `up` is world up. */
  pan(right: number, up: number, amount: number): void {
    const s = right * amount * this.side;
    if (this.axis === 'z') this.target.x += s;
    else this.target.z -= s;
    this.target.y += up * amount;
    this.pin();
  }

  orbit(dYaw: number, dPitch: number): void {
    this.yawOff = clamp(this.yawOff + dYaw, -this.maxYaw, this.maxYaw);
    this.pitch = clamp(this.pitch + dPitch, -this.maxPitch, this.maxPitch);
  }

  zoomAt(factor: number, anchor: Vec3 | null): void {
    const nd = clamp(this.dist * factor, this.minDist, this.maxDist);
    const f = nd / this.dist;
    this.dist = nd;
    if (anchor && f !== 1) {
      const t = this.target;
      t.x = anchor.x + (t.x - anchor.x) * f;
      t.y = anchor.y + (t.y - anchor.y) * f;
      t.z = anchor.z + (t.z - anchor.z) * f;
      this.pin();
    }
  }

  lookAt(pos: Vec3, dist: number | null): void {
    v3copy(this.target, pos);
    if (dist !== null) this.dist = clamp(dist, this.minDist, this.maxDist);
    this.pin();
  }

  flip(): void {
    this.side = this.side > 0 ? -1 : 1;
    this.yawOff = -this.yawOff;
  }

  update(dt: number): void {
    if (dt <= 0) {
      this.snap();
      return;
    }
    const kt = damp(11, dt);
    this.cTarget.x += (this.target.x - this.cTarget.x) * kt;
    this.cTarget.y += (this.target.y - this.cTarget.y) * kt;
    this.cTarget.z += (this.target.z - this.cTarget.z) * kt;
    this.cDist += (this.dist - this.cDist) * damp(10, dt);
    this.cYawOff += (this.yawOff - this.cYawOff) * damp(12, dt);
    this.cPitch += (this.pitch - this.cPitch) * damp(12, dt);
    this.cSwing += ((this.side > 0 ? 0 : Math.PI) - this.cSwing) * damp(5, dt);
  }

  apply(cam: CameraState): void {
    setFromOrbit(cam, this.cTarget, this.cDist, this.baseYaw() + this.cSwing + this.cYawOff, this.cPitch);
    cam.fov = 40;
    cam.near = Math.max(0.05, this.cDist * 0.02);
    cam.far = 900;
  }
}

export const POSSESS_PITCH_DEFAULT = 0.42;

/**
 * Possession camera (D14). The view frame is built from a camera-local `up` that slerps towards
 * the ant's up (so walking over an edge or onto a ceiling rolls the view smoothly, never snapping
 * or flipping) and the ant's heading — yaw lives in the ant's `forward`, which the sim rotates
 * about its local up, never as a world Euler angle. Mouse yaw is additionally applied to the
 * camera at once as a decaying lead so looking around does not wait for the 30 Hz sim. Pitch is a
 * camera-only angle about the local right axis. The third-person boom is shortened by a voxel
 * raycast; near plane is 0.02.
 */
export class PossessRig {
  private readonly camUp = v3(0, 1, 0);
  private readonly fwd = v3(0, 0, -1);
  pitch = POSSESS_PITCH_DEFAULT;
  firstPerson = false;
  private inited = false;
  /** Yaw already sent to the sim but not yet visible in the ant's (smoothed) heading. */
  private yawLead = 0;
  private boom = -1;
  /** Extra downward pitch (smoothed) taken when terrain blocks the boom at the player's pitch. */
  private lift = 0;

  reset(): void {
    this.inited = false;
    this.lift = 0;
    this.pitch = POSSESS_PITCH_DEFAULT;
    this.yawLead = 0;
    this.boom = -1;
  }

  /** Mouse / key look: `yaw` > 0 turns right (same sign as `possessInput.yawDelta`). */
  addLook(yaw: number, pitch: number): void {
    this.yawLead = clamp(this.yawLead + yaw, -1.2, 1.2);
    this.pitch = clamp(this.pitch + pitch, -1.1, 1.3);
  }

  /** Interpolated ant pose → camera. `dt` = 0 snaps the smoothing. */
  apply(cam: CameraState, ant: Readonly<Ant>, alpha: number, dt: number, world: VoxelWorld, length: number): void {
    const b = 1 - alpha;
    const px = ant.prevPos.x * b + ant.pos.x * alpha;
    const py = ant.prevPos.y * b + ant.pos.y * alpha;
    const pz = ant.prevPos.z * b + ant.pos.z * alpha;
    v3set(_a, ant.prevUp.x * b + ant.up.x * alpha, ant.prevUp.y * b + ant.up.y * alpha, ant.prevUp.z * b + ant.up.z * alpha);
    if (v3normalize(_a, _a) < 1e-6) v3copy(_a, ant.up);
    v3set(_b, ant.prevForward.x * b + ant.forward.x * alpha, ant.prevForward.y * b + ant.forward.y * alpha, ant.prevForward.z * b + ant.forward.z * alpha);
    if (v3normalize(_b, _b) < 1e-6) v3copy(_b, ant.forward);

    const snap = !this.inited || dt <= 0;
    if (snap) {
      v3copy(this.camUp, _a);
      v3copy(this.fwd, _b);
      this.yawLead = 0;
      this.inited = true;
    } else {
      v3slerp(this.camUp, this.camUp, _a, damp(this.firstPerson ? 10 : 6, dt));
      const k = damp(14, dt);
      v3slerp(this.fwd, this.fwd, _b, k);
      this.yawLead *= 1 - k; // the lead hands over to the real heading at the same rate
    }
    // heading ⟂ camera up, plus the not-yet-simulated part of the mouse yaw
    v3projectOnPlane(_b, this.fwd, this.camUp);
    if (v3normalize(_b, _b) < 1e-4) {
      v3projectOnPlane(_b, cam.forward, this.camUp);
      if (v3normalize(_b, _b) < 1e-4) v3set(_b, this.camUp.y, -this.camUp.x, 0), v3normalize(_b, _b);
    }
    if (this.yawLead !== 0) v3rotateAbout(_b, _b, this.camUp, -this.yawLead);
    v3cross(_r, _b, this.camUp); // right
    v3normalize(_r, _r);

    if (this.firstPerson) {
      // eye at the head, looking along the heading with a mild pitch
      const eyePitch = clamp(this.pitch - POSSESS_PITCH_DEFAULT, -1.0, 1.0);
      v3rotateAbout(cam.forward, _b, _r, -eyePitch);
      v3cross(cam.up, _r, cam.forward);
      v3set(cam.pos, px + this.camUp.x * 0.14 * length + _b.x * 0.4 * length, py + this.camUp.y * 0.14 * length + _b.y * 0.4 * length, pz + this.camUp.z * 0.14 * length + _b.z * 0.4 * length);
      v3addScaled(cam.focus, cam.pos, cam.forward, 3);
      cam.focusDist = 3;
      cam.fov = 78;
      this.boom = -1;
    } else {
      // pivot slightly above the ant; boom back along the view direction
      v3set(cam.focus, px + this.camUp.x * 0.35 * length, py + this.camUp.y * 0.35 * length, pz + this.camUp.z * 0.35 * length);
      const full = 4.2 * length;
      // Terrain behind the ant (the slope it just came down, a tunnel wall) would pull the boom
      // right into the ant: look for a steeper view first and only then shorten the boom.
      let liftGoal = 0;
      let bestD = -1;
      for (let i = 0; i < 4; i++) {
        const lift = Math.min(i * 0.32, Math.max(0, 1.35 - this.pitch));
        v3rotateAbout(_a, _b, _r, -(this.pitch + lift));
        v3set(_a, -_a.x, -_a.y, -_a.z);
        const h = world.raycast(cam.focus, _a, full + 0.3);
        const d = h ? h.dist : full + 0.3;
        if (d > bestD + 0.05) {
          bestD = d;
          liftGoal = lift;
        }
        if (d >= full * 0.8) break;
      }
      if (snap) this.lift = liftGoal;
      else this.lift += (liftGoal - this.lift) * damp(4, dt);
      v3rotateAbout(cam.forward, _b, _r, -(this.pitch + this.lift)); // pitch > 0 looks down at the ant
      v3cross(cam.up, _r, cam.forward);
      let want = full;
      v3set(_a, -cam.forward.x, -cam.forward.y, -cam.forward.z);
      const hit = world.raycast(cam.focus, _a, full + 0.3);
      if (hit) want = Math.max(0.25, hit.dist - 0.25);
      // pull in at once (never clip), ease back out
      if (snap || this.boom < 0 || want < this.boom) this.boom = want;
      else this.boom += (want - this.boom) * damp(5, dt);
      v3addScaled(cam.pos, cam.focus, _a, this.boom);
      cam.focusDist = this.boom;
      cam.fov = 55;
    }
    v3normalize(cam.up, cam.up);
    cam.near = 0.02;
    cam.far = 400;
  }
}

/** Applies an exact pose (shots / debug). */
export function applyPose(cam: CameraState, pose: CameraPose): void {
  cam.fov = pose.fov ?? 45;
  cameraFromPose(pose, cam);
  cam.near = Math.max(0.05, cam.focusDist * 0.02);
  cam.far = 900;
}

export function resolvePose(map: MapGenResult, pose: CameraPose | string): CameraPose | null {
  if (typeof pose !== 'string') return pose;
  return map.shotPoses[pose] ?? null;
}
