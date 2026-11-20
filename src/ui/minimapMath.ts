import { cameraRay, v3, type CameraState, type Vec2, type Vec3 } from '../core';

/**
 * Pure minimap math (no DOM): world ↔ minimap projection for outdoor (top-down x/z) and farm
 * (side-on, the pane plane) maps, the camera footprint polygon, and terrain tinting.
 */

export interface WorldDims {
  sx: number;
  sy: number;
  sz: number;
}

export interface MiniOptions {
  /** Farm map: side-on view of the pane plane. */
  slab: boolean;
  /** Axis perpendicular to the panes (slab maps). */
  slabAxis: 'x' | 'z';
  /** Canvas size in pixels. */
  w: number;
  h: number;
  /** Flip the horizontal axis (looking through the other pane). */
  mirror?: boolean;
}

export interface MiniProjection {
  readonly mode: 'top' | 'side';
  readonly w: number;
  readonly h: number;
  /** World axis shown horizontally. */
  readonly uAxis: 'x' | 'z';
  /** World axis shown vertically (`z` grows downwards, `y` grows upwards). */
  readonly vAxis: 'z' | 'y';
  /** Pixels per world unit. */
  readonly scale: number;
  /** Pixel offset of the world origin corner (letterboxing). */
  readonly ox: number;
  readonly oy: number;
  readonly uSize: number;
  readonly vSize: number;
  readonly mirror: boolean;
  /** Coordinate of the plane the side view shows (mid-slab), 0 for top-down. */
  readonly depth: number;
  toMap(p: Vec3, out: Vec2): Vec2;
  /** Inverse. Top-down leaves `out.y` = 0; side-on sets the slab axis to mid-slab. */
  toWorld(mx: number, my: number, out: Vec3): Vec3;
}

export function makeMiniProjection(dims: WorldDims, opts: MiniOptions): MiniProjection {
  const side = opts.slab;
  const uAxis: 'x' | 'z' = side ? (opts.slabAxis === 'z' ? 'x' : 'z') : 'x';
  const vAxis: 'z' | 'y' = side ? 'y' : 'z';
  const uSize = uAxis === 'x' ? dims.sx : dims.sz;
  const vSize = side ? dims.sy : dims.sz;
  const scale = Math.min(opts.w / Math.max(1, uSize), opts.h / Math.max(1, vSize));
  const ox = (opts.w - uSize * scale) / 2;
  const oy = (opts.h - vSize * scale) / 2;
  const mirror = !!opts.mirror;
  const depth = side ? (opts.slabAxis === 'z' ? dims.sz : dims.sx) / 2 : 0;
  return {
    mode: side ? 'side' : 'top',
    w: opts.w,
    h: opts.h,
    uAxis,
    vAxis,
    scale,
    ox,
    oy,
    uSize,
    vSize,
    mirror,
    depth,
    toMap(p, out) {
      let u = uAxis === 'x' ? p.x : p.z;
      if (mirror) u = uSize - u;
      out.x = ox + u * scale;
      out.y = side ? oy + (vSize - p.y) * scale : oy + p.z * scale;
      return out;
    },
    toWorld(mx, my, out) {
      let u = (mx - ox) / scale;
      if (mirror) u = uSize - u;
      u = Math.min(uSize, Math.max(0, u));
      const v = Math.min(vSize, Math.max(0, (my - oy) / scale));
      if (side) {
        out.y = vSize - v;
        if (uAxis === 'x') {
          out.x = u;
          out.z = depth;
        } else {
          out.z = u;
          out.x = depth;
        }
      } else {
        out.x = u;
        out.y = 0;
        out.z = v;
      }
      return out;
    },
  };
}

/**
 * Canvas size (px) for a minimap that fits `maxW` × `maxH` while keeping the world aspect.
 * Very elongated worlds are letterboxed rather than shrunk below `minFrac` of the box.
 */
export function miniCanvasSize(dims: WorldDims, slab: boolean, slabAxis: 'x' | 'z', maxW: number, maxH: number, minFrac = 0.45): { w: number; h: number } {
  const u = slab ? (slabAxis === 'z' ? dims.sx : dims.sz) : dims.sx;
  const v = slab ? dims.sy : dims.sz;
  const aspect = Math.max(1e-3, u / Math.max(1, v));
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { w: Math.round(Math.max(w, maxW * minFrac)), h: Math.round(Math.max(h, maxH * minFrac)) };
}

const _dir = v3();
const CORNERS: readonly [number, number][] = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
];

/**
 * Camera footprint: the four view-corner rays intersected with an axis-aligned plane
 * (`axis` = `coord`). Rays that miss the plane (parallel or pointing away) or hit it beyond
 * `maxDist` are cut off at `maxDist` along the ray, so the polygon stays finite and ordered
 * (top-left, top-right, bottom-right, bottom-left).
 */
export function frustumOnPlane(cam: CameraState, aspect: number, axis: 'x' | 'y' | 'z', coord: number, maxDist: number, out: Vec3[] = []): Vec3[] {
  for (let i = 0; i < 4; i++) {
    cameraRay(cam, CORNERS[i][0], CORNERS[i][1], aspect, _dir);
    const o = cam.pos[axis];
    const d = _dir[axis];
    let t = Math.abs(d) > 1e-6 ? (coord - o) / d : -1;
    if (t <= 0 || t > maxDist) t = maxDist;
    const p = out[i] ?? (out[i] = v3());
    p.x = cam.pos.x + _dir.x * t;
    p.y = cam.pos.y + _dir.y * t;
    p.z = cam.pos.z + _dir.z * t;
  }
  out.length = 4;
  return out;
}

/** Minimal world surface the terrain layer needs (structural subset of `VoxelWorld`). */
export interface MiniWorld extends WorldDims {
  isSolid(x: number, y: number, z: number): boolean;
  materialAt(x: number, y: number, z: number): number;
}

/** y of the topmost solid cell in a column (−1 if the column is empty). */
export function columnTop(world: MiniWorld, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= world.sx || z >= world.sz) return -1;
  for (let y = world.sy - 1; y >= 0; y--) if (world.isSolid(x, y, z)) return y;
  return -1;
}

/** Material albedo (0..1 rgb) → minimap byte colour, brightened with height (0..1). */
export function tintByHeight(color: readonly [number, number, number], height01: number, out: [number, number, number]): [number, number, number] {
  const k = 0.55 + 0.6 * Math.min(1, Math.max(0, height01));
  out[0] = Math.min(255, Math.round(color[0] * 255 * k));
  out[1] = Math.min(255, Math.round(color[1] * 255 * k));
  out[2] = Math.min(255, Math.round(color[2] * 255 * k));
  return out;
}
