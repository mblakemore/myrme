import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, ISO, Mat, type MaterialId } from '../core';
import { createWorld } from './VoxelWorld';

function solidWorld(sx = 48, sy = 48, sz = 48, boundary: 'open' | 'glass' = 'open', mat: MaterialId = Mat.Soil) {
  const w = createWorld(sx, sy, sz, boundary);
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) w.setCell(x, y, z, 2, mat);
  w.markAllDirty();
  return w;
}

describe('VoxelWorld', () => {
  it('uses the D2 index and round-trips coordinates', () => {
    const w = createWorld(10, 7, 5, 'open');
    expect(w.index(3, 2, 4)).toBe(3 + 10 * (4 + 5 * 2));
    const c = w.cellCoords(w.index(3, 2, 4), { x: 0, y: 0, z: 0 });
    expect(c).toEqual({ x: 3, y: 2, z: 4 });
    expect(w.cellAt(3.9, 2.1, 4.5)).toBe(w.index(3, 2, 4));
    expect(w.cellAt(-0.1, 0, 0)).toBe(-1);
  });

  it('dig carves a sphere as a signed distance field, reports removed cells and bumps versions', () => {
    const w = solidWorld();
    const v0 = w.version;
    const res = w.dig({ x: 24, y: 24, z: 24 }, 3);
    expect(w.version).toBe(v0 + 1);
    expect(res.removedByMaterial[Mat.Soil]).toBeGreaterThan(80); // ~4/3·π·27 ≈ 113
    expect(res.removedByMaterial[Mat.Soil]).toBeLessThan(140);
    expect(w.isSolid(24, 24, 24)).toBe(false);
    expect(w.isSolid(24, 24, 29)).toBe(true);
    expect(w.materialAt(24, 24, 24)).toBe(Mat.Air);
    // density is a distance, not binary: the surface sits ~3 voxels from the centre
    expect(w.sample(24, 24, 24)).toBeLessThan(-1.9);
    expect(Math.abs(w.sample(27, 24, 24))).toBeLessThan(0.15);
    expect(Math.abs(w.sample(24, 21, 24))).toBeLessThan(0.15);
    // gradient points into the solid (away from the cavity centre)
    const g = w.gradient(27, 24, 24, { x: 0, y: 0, z: 0 });
    expect(g.x).toBeGreaterThan(0.7);
    expect(Math.abs(g.y)).toBeLessThan(0.1);
  });

  it('clamps the brush radius to 1.5 (D4)', () => {
    const w = solidWorld();
    w.dig({ x: 24.5, y: 24.5, z: 24.5 }, 0.2);
    expect(Math.abs(w.sample(26, 24.5, 24.5))).toBeLessThan(0.2);
  });

  it('dirties only chunks near the edit, including border neighbours', () => {
    const w = solidWorld();
    const before = w.chunkVersion.slice();
    // centre of chunk (1,1,1): only that chunk
    const mid = w.dig({ x: 24, y: 24, z: 24 }, 1.5);
    expect(mid.changedChunks).toEqual([w.chunkIndexOfCell(24, 24, 24)]);
    // near the x border between chunk 0 and 1: both chunks
    const edge = w.dig({ x: CHUNK_SIZE + 0.5, y: 8, z: 8 }, 1.5);
    expect(edge.changedChunks.sort()).toEqual([w.chunkIndexOfCell(8, 8, 8), w.chunkIndexOfCell(24, 8, 8)].sort());
    for (let i = 0; i < before.length; i++) {
      const touched = mid.changedChunks.includes(i) || edge.changedChunks.includes(i);
      expect(w.chunkVersion[i] > before[i]).toBe(touched);
    }
  });

  it('refuses to dig rock by default and no-op edits do not bump the version', () => {
    const w = solidWorld(32, 32, 32, 'open', Mat.Rock);
    const v = w.version;
    const res = w.dig({ x: 16, y: 16, z: 16 }, 3);
    expect(res.touchedCells).toBe(0);
    expect(w.version).toBe(v);
    expect(w.isSolid(16, 16, 16)).toBe(true);
  });

  it('fill adds material, keeps existing materials and refuses occupied cells', () => {
    const w = solidWorld();
    w.dig({ x: 24, y: 24, z: 24 }, 4);
    const occupied = w.index(24, 24, 24);
    const res = w.fill({ x: 24, y: 24, z: 24 }, 2, Mat.Mud, { isOccupied: (c) => c === occupied });
    expect(res.addedCells).toBeGreaterThan(10);
    expect(w.isSolid(24, 24, 24)).toBe(false); // refused
    expect(w.isSolid(25, 24, 24)).toBe(true);
    expect(w.materialAt(25, 24, 24)).toBe(Mat.Mud);
    expect(w.materialAt(24, 24, 30)).toBe(Mat.Soil); // untouched
    expect(res.removedByMaterial.every((n) => n === 0)).toBe(true);
  });

  it('notifies edit listeners', () => {
    const w = solidWorld();
    let calls = 0;
    const off = w.onEdit(() => calls++);
    w.dig({ x: 10, y: 10, z: 10 }, 2);
    off();
    w.dig({ x: 30, y: 30, z: 30 }, 2);
    expect(calls).toBe(1);
  });

  it('open boundary: floor solid, sky air, sides clamp (D6)', () => {
    const w = solidWorld(16, 16, 16);
    expect(w.densityAt(5, -1, 5)).toBe(255);
    expect(w.densityAt(5, 16, 5)).toBe(0);
    expect(w.densityAt(-3, 5, 5)).toBe(w.densityAt(0, 5, 5));
    expect(w.densityVisual(-1, 5, 5)).toBe(0);
  });

  it('glass boundary: panes are baked in as solid half-spaces (D6)', () => {
    const w = createWorld(16, 16, 4, 'glass'); // empty slab of air
    expect(w.density[w.index(8, 8, 0)]).toBeLessThan(ISO);
    expect(w.densityAt(8, 8, -1)).toBeGreaterThanOrEqual(ISO);
    // the pane surface lies at z = 0 and z = 4 for sampling
    expect(Math.abs(w.sample(8, 8, 0))).toBeLessThan(0.05);
    expect(Math.abs(w.sample(8, 8, 4))).toBeLessThan(0.05);
    expect(w.sample(8, 8, 2)).toBeLessThan(-1);
    // digging cannot erase the pane
    w.dig({ x: 8, y: 8, z: 0.5 }, 3);
    expect(Math.abs(w.sample(8, 8, 0))).toBeLessThan(0.05);
    // but visually out of bounds is air
    expect(w.sampleVisual(8, 8, -0.4)).toBeLessThan(0);
  });
});
