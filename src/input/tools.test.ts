import { describe, expect, it } from 'vitest';
import type { Ant, Beacon, CutPlane, RayHit } from '../core';
import { blendCamera, v3slerp } from './cameras';
import { BRUSH_SIZES, beaconUnderCursor, brushCenter, hopCandidates, nextBrushSize, stampSpacing } from './tools';

const hit = (over: Partial<RayHit>): RayHit => ({ pos: { x: 10, y: 20, z: 30 }, normal: { x: 0, y: 1, z: 0 }, dist: 5, solidCell: 1, airCell: 2, material: 1, boundary: false, ...over });

describe('brush', () => {
  it('steps through sizes and clamps', () => {
    expect(nextBrushSize(2, 1)).toBe(2.5);
    expect(nextBrushSize(2, -1)).toBe(1.5);
    expect(nextBrushSize(1.5, -1)).toBe(1.5);
    expect(nextBrushSize(BRUSH_SIZES[BRUSH_SIZES.length - 1], 1)).toBe(BRUSH_SIZES[BRUSH_SIZES.length - 1]);
    expect(BRUSH_SIZES[0]).toBeGreaterThanOrEqual(1.5); // D4 minimum
    expect(stampSpacing(2)).toBeLessThan(2);
  });
  it('dig sinks into the surface, build sits proud of it', () => {
    const d = brushCenter(hit({}), 'dig', 2, null, null)!;
    const b = brushCenter(hit({}), 'build', 2, null, null)!;
    expect(d.center.y).toBeLessThan(20);
    expect(b.center.y).toBeGreaterThan(20);
    expect(d.onCutFace).toBe(false);
  });
  it('centres on the cut plane when painting the cross-section', () => {
    const cut: CutPlane = { enabled: true, axis: 'z', pos: 30, sign: 1 };
    const b = brushCenter(hit({ pos: { x: 10, y: 20, z: 29.98 }, normal: { x: 0, y: 0, z: 1 } }), 'dig', 2.5, cut, null)!;
    expect(b.onCutFace).toBe(true);
    expect(b.center).toEqual({ x: 10, y: 20, z: 30 });
    // an ordinary surface elsewhere is not treated as the cut face
    const o = brushCenter(hit({ pos: { x: 10, y: 20, z: 12 } }), 'dig', 2.5, cut, null)!;
    expect(o.onCutFace).toBe(false);
    // nor is a floor that merely touches the plane
    expect(brushCenter(hit({ pos: { x: 10, y: 20, z: 30 } }), 'dig', 2.5, cut, null)!.onCutFace).toBe(false);
  });
  it('centres mid-slab on farm maps', () => {
    const b = brushCenter(hit({ pos: { x: 10, y: 20, z: 4.9 }, normal: { x: 0, y: 0, z: 1 } }), 'dig', 2, null, { axis: 'z', mid: 2.5 })!;
    expect(b.center).toEqual({ x: 10, y: 20, z: 2.5 });
  });
  it('refuses to dig on an open boundary hit', () => {
    expect(brushCenter(hit({ boundary: true, solidCell: -1 }), 'dig', 2, null, null)).toBeNull();
  });
});

describe('beacon picking', () => {
  const beacons = [
    { id: 5, kind: 'gather', colony: 1, pos: { x: 0, y: 0, z: 0 }, cell: 0, radius: 6, createdTick: 0 },
    { id: 6, kind: 'rally', colony: 1, pos: { x: 10, y: 0, z: 0 }, cell: 0, radius: 6, createdTick: 0 },
  ] as Beacon[];
  const project = (p: { x: number }) => ({ x: p.x * 10, y: 100 });
  it('finds the beacon whose marker is under the cursor', () => {
    expect(beaconUnderCursor(beacons, null, project, 103, 104)).toBe(6);
    expect(beaconUnderCursor(beacons, null, project, 50, 100)).toBe(0);
  });
  it('also matches by world distance when the marker is off-screen', () => {
    expect(beaconUnderCursor(beacons, { x: 0.5, y: 0, z: 0.5 }, () => null, 0, 0)).toBe(5);
    expect(beaconUnderCursor(beacons, { x: 4, y: 0, z: 0 }, () => null, 0, 0)).toBe(0);
  });
});

describe('possession hop', () => {
  const ant = (id: number, x: number, colony = 1, alive = true) => ({ id, alive, colony, pos: { x, y: 0, z: 0 } }) as unknown as Ant;
  const ants = [ant(1, 0), ant(2, 3), ant(3, 1), ant(4, 2, 2), ant(5, 100), ant(6, 4, 1, false)];
  it('lists living nestmates nearest first, within range', () => {
    expect(hopCandidates(ants, ants[0], 1, [])).toEqual([3, 2]);
  });
  it('skips recently visited ants unless nothing else is left', () => {
    expect(hopCandidates(ants, ants[0], 1, [3])).toEqual([2]);
    expect(hopCandidates(ants, ants[0], 1, [2, 3])).toEqual([3, 2]);
  });
});

describe('camera blending', () => {
  it('slerps unit vectors along the great circle, including opposite vectors', () => {
    const out = { x: 0, y: 0, z: 0 };
    v3slerp(out, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.5);
    expect(out.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out.y).toBeCloseTo(Math.SQRT1_2, 6);
    v3slerp(out, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, 0.5);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
    expect(Math.abs(out.y)).toBeLessThan(1e-6);
  });
  it('keeps the blended camera orthonormal', () => {
    const cam = (f: [number, number, number], u: [number, number, number], p: number) => ({ pos: { x: p, y: p, z: p }, forward: { x: f[0], y: f[1], z: f[2] }, up: { x: u[0], y: u[1], z: u[2] }, fov: 45, near: 0.1, far: 900, focus: { x: 0, y: 0, z: 0 }, focusDist: 5 });
    const a = cam([0, 0, -1], [0, 1, 0], 0);
    const b = cam([1, 0, 0], [0, 0, 1], 10);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const o = blendCamera(cam([0, 0, -1], [0, 1, 0], 0), a, b, t);
      expect(Math.hypot(o.forward.x, o.forward.y, o.forward.z)).toBeCloseTo(1, 5);
      expect(Math.hypot(o.up.x, o.up.y, o.up.z)).toBeCloseTo(1, 5);
      expect(o.forward.x * o.up.x + o.forward.y * o.up.y + o.forward.z * o.up.z).toBeCloseTo(0, 5);
      expect(o.pos.x).toBeCloseTo(10 * t, 6);
    }
  });
});
