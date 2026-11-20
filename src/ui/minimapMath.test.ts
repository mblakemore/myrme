import { describe, expect, it } from 'vitest';
import { cameraFromPose, makeCameraState, v3 } from '../core';
import { columnTop, frustumOnPlane, makeMiniProjection, miniCanvasSize, tintByHeight, type MiniWorld } from './minimapMath';

const dims = { sx: 192, sy: 64, sz: 96 };

describe('minimap projection', () => {
  it('top-down fits the world, keeps aspect and round-trips', () => {
    const p = makeMiniProjection(dims, { slab: false, slabAxis: 'z', w: 200, h: 200 });
    expect(p.mode).toBe('top');
    expect(p.scale).toBeCloseTo(200 / 192);
    expect(p.ox).toBeCloseTo(0);
    expect(p.oy).toBeCloseTo((200 - 96 * p.scale) / 2);
    const m = p.toMap(v3(48, 10, 24), { x: 0, y: 0 });
    expect(m.x).toBeCloseTo(48 * p.scale);
    expect(m.y).toBeCloseTo(p.oy + 24 * p.scale);
    const w = p.toWorld(m.x, m.y, v3());
    expect(w.x).toBeCloseTo(48);
    expect(w.z).toBeCloseTo(24);
    expect(w.y).toBe(0);
  });

  it('clamps toWorld to the world box', () => {
    const p = makeMiniProjection(dims, { slab: false, slabAxis: 'z', w: 200, h: 200 });
    const w = p.toWorld(-50, 9999, v3());
    expect(w.x).toBe(0);
    expect(w.z).toBe(96);
  });

  it('side-on (slab axis z): x across, y up, depth mid-slab', () => {
    const farm = { sx: 96, sy: 64, sz: 5 };
    const p = makeMiniProjection(farm, { slab: true, slabAxis: 'z', w: 192, h: 128 });
    expect(p.mode).toBe('side');
    expect(p.uAxis).toBe('x');
    const top = p.toMap(v3(0, 64, 2), { x: 0, y: 0 });
    const bottom = p.toMap(v3(96, 0, 2), { x: 0, y: 0 });
    expect(top.x).toBeCloseTo(0);
    expect(top.y).toBeCloseTo(0);
    expect(bottom.x).toBeCloseTo(192);
    expect(bottom.y).toBeCloseTo(128);
    const w = p.toWorld(96, 32, v3());
    expect(w.x).toBeCloseTo(48);
    expect(w.y).toBeCloseTo(48);
    expect(w.z).toBeCloseTo(2.5);
  });

  it('side-on with slab axis x uses z as the horizontal axis', () => {
    const farm = { sx: 5, sy: 40, sz: 80 };
    const p = makeMiniProjection(farm, { slab: true, slabAxis: 'x', w: 160, h: 80 });
    expect(p.uAxis).toBe('z');
    const w = p.toWorld(40, 40, v3());
    expect(w.z).toBeCloseTo(20);
    expect(w.x).toBeCloseTo(2.5);
    expect(w.y).toBeCloseTo(20);
  });

  it('mirror flips the horizontal axis both ways', () => {
    const farm = { sx: 96, sy: 64, sz: 5 };
    const p = makeMiniProjection(farm, { slab: true, slabAxis: 'z', w: 192, h: 128, mirror: true });
    const m = p.toMap(v3(10, 32, 2), { x: 0, y: 0 });
    expect(m.x).toBeCloseTo((96 - 10) * 2);
    const w = p.toWorld(m.x, m.y, v3());
    expect(w.x).toBeCloseTo(10);
    expect(w.y).toBeCloseTo(32);
  });

  it('canvas size keeps aspect inside the box', () => {
    expect(miniCanvasSize({ sx: 100, sy: 50, sz: 100 }, false, 'z', 150, 150)).toEqual({ w: 150, h: 150 });
    expect(miniCanvasSize({ sx: 96, sy: 48, sz: 5 }, true, 'z', 200, 150)).toEqual({ w: 200, h: 100 });
    // extreme aspect is letterboxed, not squashed to nothing
    const s = miniCanvasSize({ sx: 400, sy: 20, sz: 5 }, true, 'z', 200, 100);
    expect(s.w).toBe(200);
    expect(s.h).toBe(45);
  });
});

describe('camera footprint', () => {
  it('straight-down camera gives a symmetric rectangle on the ground plane', () => {
    const cam = cameraFromPose({ pos: [50, 40, 50], target: [50, 0, 50] }, makeCameraState());
    cam.fov = 90;
    const poly = frustumOnPlane(cam, 2, 'y', 0, 1000);
    expect(poly).toHaveLength(4);
    for (const p of poly) expect(p.y).toBeCloseTo(0, 4);
    const xs = poly.map((p) => p.x);
    const zs = poly.map((p) => p.z);
    // fov 90 at height 40: half-height 40, half-width 80 (aspect 2); which axis is which depends on the up vector
    const ex = (Math.max(...xs) - Math.min(...xs)) / 2;
    const ez = (Math.max(...zs) - Math.min(...zs)) / 2;
    expect([Math.round(ex), Math.round(ez)].sort((a, b) => a - b)).toEqual([40, 80]);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(50, 3);
    expect((Math.max(...zs) + Math.min(...zs)) / 2).toBeCloseTo(50, 3);
  });

  it('rays that miss the plane are cut at maxDist', () => {
    // looking at the horizon: the top corners point upwards and never reach y = 0
    const cam = cameraFromPose({ pos: [0, 5, 0], target: [0, 5, -10] }, makeCameraState());
    const poly = frustumOnPlane(cam, 1.6, 'y', 0, 60);
    for (const p of poly) {
      const d = Math.hypot(p.x - cam.pos.x, p.y - cam.pos.y, p.z - cam.pos.z);
      expect(d).toBeLessThanOrEqual(60 + 1e-6);
    }
    expect(poly[0].y).toBeGreaterThan(5); // top-left went up
    expect(poly[2].y).toBeCloseTo(0, 4); // bottom-right hit the ground
  });

  it('side plane (farm pane) footprint', () => {
    const cam = cameraFromPose({ pos: [48, 30, 40], target: [48, 30, 2] }, makeCameraState());
    const poly = frustumOnPlane(cam, 16 / 9, 'z', 2, 500);
    for (const p of poly) expect(p.z).toBeCloseTo(2, 4);
    expect(poly[0].x).toBeLessThan(poly[1].x);
    expect(poly[0].y).toBeGreaterThan(poly[3].y);
  });
});

describe('terrain helpers', () => {
  const world: MiniWorld = {
    sx: 4,
    sy: 8,
    sz: 4,
    isSolid: (x, y, z) => y <= x + z,
    materialAt: () => 1,
  };
  it('columnTop finds the highest solid cell', () => {
    expect(columnTop(world, 0, 0)).toBe(0);
    expect(columnTop(world, 2, 1)).toBe(3);
    expect(columnTop(world, 3, 3)).toBe(6);
    expect(columnTop(world, 9, 0)).toBe(-1);
  });
  it('tintByHeight brightens with height and clamps', () => {
    const lo = tintByHeight([0.5, 0.4, 0.2], 0, [0, 0, 0]).slice();
    const hi = tintByHeight([0.5, 0.4, 0.2], 1, [0, 0, 0]).slice();
    expect(hi[0]).toBeGreaterThan(lo[0]);
    expect(tintByHeight([1, 1, 1], 1, [0, 0, 0])).toEqual([255, 255, 255]);
  });
});
