import { describe, expect, it } from 'vitest';
import { Mat } from '../core';
import { createWorld } from './VoxelWorld';
import { getMap } from './maps';

function ground() {
  const w = createWorld(32, 32, 32, 'open');
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setCell(x, y, z, 10 - (y + 0.5), y < 4 ? Mat.Rock : Mat.Soil);
  w.markAllDirty();
  return w;
}

describe('raycast', () => {
  it('hits a flat floor at the isosurface with an upward normal', () => {
    const w = ground();
    const hit = w.raycast({ x: 16, y: 25, z: 16 }, { x: 0, y: -1, z: 0 }, 100)!;
    expect(hit).not.toBeNull();
    expect(hit.pos.y).toBeCloseTo(10, 1);
    expect(hit.dist).toBeCloseTo(15, 1);
    expect(hit.normal.y).toBeGreaterThan(0.99);
    expect(hit.material).toBe(Mat.Soil);
    expect(hit.boundary).toBe(false);
    expect(w.isSolid(...coords(w, hit.solidCell))).toBe(true);
    expect(w.isSolid(...coords(w, hit.airCell))).toBe(false);
  });

  it('hits at an angle, respects maxDist and misses the sky', () => {
    const w = ground();
    const d = { x: 1, y: -1, z: 0.5 };
    const hit = w.raycast({ x: 5, y: 20, z: 5 }, d, 100)!;
    expect(hit.pos.y).toBeCloseTo(10, 1);
    expect(hit.pos.x).toBeCloseTo(15, 1);
    expect(w.raycast({ x: 5, y: 20, z: 5 }, d, 5)).toBeNull();
    expect(w.raycast({ x: 5, y: 20, z: 5 }, { x: 0, y: 1, z: 0 }, 100)).toBeNull();
    expect(w.raycast({ x: 5, y: 20, z: 5 }, { x: 1, y: 0, z: 0 }, 100)).toBeNull(); // open side
  });

  it('hits the inside of a dug cavity', () => {
    const w = ground();
    w.dig({ x: 16, y: 5, z: 16 }, 3);
    const hit = w.raycast({ x: 16, y: 5, z: 16 }, { x: 1, y: 0, z: 0 }, 20)!;
    expect(hit.pos.x).toBeCloseTo(19, 0);
    expect(hit.normal.x).toBeLessThan(-0.9);
  });

  it('visual rays may start outside the world and hit the diorama side', () => {
    const w = ground();
    const hit = w.raycast({ x: -20, y: 5, z: 16 }, { x: 1, y: 0, z: 0 }, 100, { visual: true })!;
    expect(hit.pos.x).toBeCloseTo(0, 0);
    expect(hit.normal.x).toBeLessThan(-0.9);
  });

  it('gel farm: visual rays hit the gel face, pass into tunnels and resolve on the back pane', () => {
    const map = getMap('gelFarm').generate(1, { faction: 'gardenAnt' });
    const w = map.world;
    const from = (x: number, y: number) => w.raycast({ x, y, z: w.sz + 30 }, { x: 0, y: 0, z: -1 }, 200, { visual: true });
    const face = from(4, 6)!; // solid gel, bottom-left
    expect(face.pos.z).toBeCloseTo(w.sz, 0);
    expect(face.material).toBe(Mat.Gel);
    const spawn = map.spawns[0].pos;
    const tunnel = from(spawn.x, spawn.y + 2)!; // inside the chamber
    expect(tunnel.boundary).toBe(true);
    expect(tunnel.pos.z).toBeCloseTo(0, 1);
    expect(tunnel.airCell).toBeGreaterThanOrEqual(0);
    // physics ray from inside the chamber stops on the pane
    const inner = w.raycast({ x: spawn.x, y: spawn.y + 2, z: 2 }, { x: 0, y: 0, z: 1 }, 50)!;
    expect(inner.pos.z).toBeCloseTo(w.sz, 1);
  });

  it('visual rays honour the cutaway plane', () => {
    const w = ground();
    const cut = { enabled: true, axis: 'y' as const, pos: 6, sign: 1 as const };
    const hit = w.raycast({ x: 16, y: 25, z: 16 }, { x: 0, y: -1, z: 0 }, 100, { visual: true, cut })!;
    expect(hit.pos.y).toBeCloseTo(6, 1);
  });
});

function coords(w: ReturnType<typeof createWorld>, cell: number): [number, number, number] {
  const c = w.cellCoords(cell, { x: 0, y: 0, z: 0 });
  return [c.x, c.y, c.z];
}
