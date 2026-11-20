import { describe, expect, it } from 'vitest';
import { MAT_CHANNELS, Mat, type CutPlane, type VoxelWorld } from '../core';
import { createWorld } from './VoxelWorld';
import { getMap } from './maps';
import { meshChunk } from './mesher';

/** Welds all chunk meshes by position and returns edge-use statistics. */
function weld(world: VoxelWorld, cut: CutPlane | null = null) {
  const edges = new Map<string, number>();
  let tris = 0;
  let verts = 0;
  let badNormals = 0;
  let inward = 0;
  const key = (x: number, y: number, z: number) => `${Math.round(x * 4096)},${Math.round(y * 4096)},${Math.round(z * 4096)}`;
  const n = world.ncx * world.ncy * world.ncz;
  for (let ci = 0; ci < n; ci++) {
    const m = meshChunk(world, ci, { cut });
    verts += m.vertexCount;
    tris += m.triangleCount;
    expect(m.positions.length).toBe(m.vertexCount * 3);
    expect(m.matWeights.length).toBe(m.vertexCount * MAT_CHANNELS);
    for (let v = 0; v < m.vertexCount; v++) {
      const l = Math.hypot(m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]);
      if (Math.abs(l - 1) > 1e-3) badNormals++;
    }
    for (let t = 0; t < m.indices.length; t += 3) {
      const ids = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      const k = ids.map((i) => key(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]));
      // geometric normal must agree with the gradient normals (winding / inverted-normal check)
      const p = ids.map((i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
      const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      let d = 0;
      for (const i of ids) d += gx * m.normals[i * 3] + gy * m.normals[i * 3 + 1] + gz * m.normals[i * 3 + 2];
      if (d < 0) inward++;
      for (let e = 0; e < 3; e++) {
        const a = k[e];
        const b = k[(e + 1) % 3];
        if (a === b) continue; // degenerate
        // directed edge: a closed, consistently wound surface uses each directed edge once
        const dk = `${a}>${b}`;
        edges.set(dk, (edges.get(dk) ?? 0) + 1);
      }
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const [dk, c] of edges) {
    const [a, b] = dk.split('>');
    const rev = edges.get(`${b}>${a}`) ?? 0;
    if (rev === 0) boundary++;
    if (c !== rev) nonManifold++;
  }
  return { tris, verts, boundary, nonManifold, badNormals, inward };
}

describe('surface-nets mesher', () => {
  it('is watertight for a sphere spanning 8 chunks', () => {
    const w = createWorld(48, 48, 48, 'open');
    for (let y = 0; y < 48; y++) for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) w.setCell(x, y, z, 9.3 - Math.hypot(x + 0.5 - 16.2, y + 0.5 - 15.7, z + 0.5 - 16.4), Mat.Soil);
    w.markAllDirty();
    const r = weld(w);
    expect(r.tris).toBeGreaterThan(1000);
    expect(r.boundary).toBe(0);
    expect(r.nonManifold).toBe(0);
    expect(r.badNormals).toBe(0);
    expect(r.inward).toBe(0);
  });

  it('vertices lie on the isosurface and normals point outward', () => {
    const w = createWorld(32, 32, 32, 'open');
    const c = 16;
    for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setCell(x, y, z, 8 - Math.hypot(x + 0.5 - c, y + 0.5 - c, z + 0.5 - c), Mat.Rock);
    w.markAllDirty();
    for (let ci = 0; ci < 8; ci++) {
      const m = meshChunk(w, ci);
      for (let v = 0; v < m.vertexCount; v++) {
        const x = m.positions[v * 3] - c, y = m.positions[v * 3 + 1] - c, z = m.positions[v * 3 + 2] - c;
        const r = Math.hypot(x, y, z);
        expect(Math.abs(r - 8)).toBeLessThan(0.2);
        const dot = (x * m.normals[v * 3] + y * m.normals[v * 3 + 1] + z * m.normals[v * 3 + 2]) / r;
        expect(dot).toBeGreaterThan(0.95);
        expect(m.matWeights[v * MAT_CHANNELS + Mat.Rock]).toBe(255);
      }
    }
  });

  it('whole fixture maps are closed surfaces (diorama block / slab against panes)', () => {
    for (const id of ['meadow', 'gelFarm'] as const) {
      const map = getMap(id).generate(3, { faction: 'gardenAnt', small: true });
      const r = weld(map.world);
      expect(r.tris).toBeGreaterThan(5000);
      expect(r.boundary).toBe(0);
      expect(r.badNormals).toBe(0);
    }
  });

  it('cutaway caps the cross-section and hides everything past the plane (D9)', () => {
    const map = getMap('meadow').generate(3, { faction: 'gardenAnt', small: true });
    const cut: CutPlane = { enabled: true, axis: 'z', pos: 30, sign: 1 };
    const r = weld(map.world, cut);
    expect(r.boundary).toBe(0); // still closed: the cut is capped
    const w = map.world;
    for (let ci = 0; ci < w.ncx * w.ncy * w.ncz; ci++) {
      const m = meshChunk(w, ci, { cut });
      for (let v = 0; v < m.vertexCount; v++) expect(m.positions[v * 3 + 2]).toBeLessThan(30.51);
    }
  });

  it('is a pure function', () => {
    const map = getMap('gelFarm').generate(3, { faction: 'gardenAnt', small: true });
    const a = meshChunk(map.world, 5);
    const b = meshChunk(map.world, 5);
    expect(a.vertexCount).toBeGreaterThan(0);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
});
