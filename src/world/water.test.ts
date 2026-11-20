import { describe, expect, it } from 'vitest';
import { Mat } from '../core';
import { makeBlock } from '../sim/systems/weatherTestWorld';
import { createWater } from './water';

const run = (water: ReturnType<typeof createWater>, ticks: number, drainScale = 0): void => {
  for (let i = 0; i < ticks; i++) water.step(1 / 30, drainScale);
};

describe('water field (D17)', () => {
  it('conserves volume while flowing', () => {
    // one room 8×4×8 with a rock shell (no absorption)
    const w = makeBlock(12, 10, 12, Mat.Rock, [[2, 2, 2, 9, 6, 9]]);
    const water = createWater(w);
    let added = 0;
    for (let i = 0; i < 40; i++) {
      added += water.inject(w.index(5, 6, 5), 1.5);
      run(water, 5);
      expect(water.totalVolume()).toBeCloseTo(added, 6);
    }
    run(water, 600);
    expect(water.totalVolume()).toBeCloseTo(added, 6);
    expect(water.totalAdded - water.totalDrained).toBeCloseTo(water.totalVolume(), 6);
    // 60 voxels over a 64-cell floor: a level sheet on the bottom layer, nothing above it
    expect(water.depthAt(w.index(5, 2, 5))).toBeGreaterThan(0.8);
    expect(water.depthAt(w.index(2, 2, 2))).toBeGreaterThan(0.8);
    expect(water.depthAt(w.index(5, 4, 5))).toBe(0);
    expect(water.activeCount).toBe(0);
  });

  it('fills the lowest connected chamber first, then rises (and pushes up the far leg of a U)', () => {
    // upper chamber A, a corridor, a shaft down into lower chamber B
    const boxes: [number, number, number, number, number, number][] = [
      [2, 12, 4, 7, 14, 9], // A (floor y=12)
      [8, 12, 6, 13, 13, 7], // corridor at A's floor level
      [12, 4, 6, 13, 12, 7], // shaft down
      [10, 2, 4, 17, 4, 9], // B (floor y=2)
    ];
    const w = makeBlock(20, 18, 14, Mat.Rock, boxes);
    const water = createWater(w);
    const volB = 8 * 3 * 6;
    let added = 0;
    for (let i = 0; i < 60; i++) {
      added += water.inject(w.index(4, 14, 6), 1);
      run(water, 20);
    }
    run(water, 900);
    // 60 voxels: all of it ran down into B, A is (nearly) dry
    let inA = 0;
    let inB = 0;
    water.forEachFlooded((cell, d) => {
      const y = Math.floor(cell / (w.sx * w.sz));
      if (y >= 12) inA += d;
      else if (y <= 4) inB += d;
    });
    expect(inB).toBeGreaterThan(added * 0.9);
    expect(inA).toBeLessThan(added * 0.08);
    expect(water.isFlooded(w.index(11, 2, 5))).toBe(true);
    // keep pouring: B fills completely, then the shaft, only then A floods
    for (let i = 0; i < 260; i++) {
      added += water.inject(w.index(4, 14, 6), 1);
      run(water, 12);
    }
    run(water, 1500);
    expect(added).toBeGreaterThan(volB + 40);
    expect(water.depthAt(w.index(16, 4, 8))).toBeGreaterThan(0.95); // far top corner of B, away from the shaft
    expect(water.isFlooded(w.index(4, 12, 6))).toBe(true);
    // exact books (dust and dried films are accounted as drained)
    expect(water.totalAdded - water.totalDrained).toBeCloseTo(water.totalVolume(), 6);
    expect(Math.abs(water.totalVolume() - added)).toBeLessThan(0.1);
  });

  it('drains at a rate set by the material it touches', () => {
    const left: Record<string, number> = {};
    for (const [name, mat] of [['sand', Mat.Sand], ['soil', Mat.Soil], ['clay', Mat.Clay], ['rock', Mat.Rock], ['gel', Mat.Gel]] as const) {
      const w = makeBlock(10, 8, 10, mat, [[2, 2, 2, 7, 5, 7]], 'open');
      const water = createWater(w);
      for (let i = 0; i < 36; i++) water.inject(w.index(4, 4, 4), 1);
      run(water, 300, 0);
      const before = water.totalVolume();
      expect(before).toBeCloseTo(36, 2);
      run(water, 900, 1); // 30 s of draining
      left[name] = water.totalVolume() / before;
      expect(water.totalAdded - water.totalDrained).toBeCloseTo(water.totalVolume(), 5);
    }
    expect(left.sand).toBeLessThan(left.soil);
    expect(left.soil).toBeLessThan(left.clay);
    expect(left.clay).toBeLessThan(1);
    expect(left.rock).toBeCloseTo(1, 6);
    expect(left.gel).toBeCloseTo(1, 6);
    expect(left.sand).toBeLessThan(0.3);
  });

  it('floods a two-chamber nest and drains it dry afterwards', () => {
    const boxes: [number, number, number, number, number, number][] = [
      [8, 14, 6, 9, 19, 7], // entrance shaft from the top (open sky above y=19)
      [4, 11, 4, 11, 13, 9], // upper chamber
      [10, 6, 6, 11, 10, 7], // shaft down
      [8, 3, 4, 15, 5, 9], // lower chamber
    ];
    const w = makeBlock(20, 20, 14, Mat.Soil, boxes, 'open');
    const water = createWater(w);
    let versions = water.version;
    for (let i = 0; i < 120; i++) {
      water.inject(w.index(8, 19, 6), 1);
      run(water, 10, 0.3);
    }
    expect(water.version).toBeGreaterThan(versions);
    versions = water.version;
    expect(water.isFlooded(w.index(12, 3, 6))).toBe(true); // lower chamber under water
    let surfaces = 0;
    water.forEachSurface((_cell, level) => {
      surfaces++;
      expect(level).toBeGreaterThan(3);
    });
    expect(surfaces).toBeGreaterThan(10);
    expect(water.surfaceAbove(w.index(12, 3, 6))).toBeGreaterThan(3.9);
    // rain stops: everything soaks away
    run(water, 30 * 400, 1);
    expect(water.floodedCount).toBe(0);
    expect(water.totalVolume()).toBe(0);
    expect(water.totalDrained).toBeCloseTo(water.totalAdded, 5);
    expect(water.version).toBeGreaterThan(versions);
  });

  it('refuses water into solid and reports what a sealed pocket accepts', () => {
    const w = makeBlock(8, 8, 8, Mat.Rock, [[3, 3, 3, 4, 4, 4]]);
    const water = createWater(w);
    expect(water.inject(w.index(0, 0, 0), 1)).toBe(0);
    let got = 0;
    for (let i = 0; i < 12; i++) got += water.inject(w.index(3, 3, 3), 1);
    expect(got).toBeCloseTo(8, 5); // the pocket holds 8 voxels
    expect(water.take(w.index(3, 4, 3), 0.25)).toBeCloseTo(0.25, 6);
    expect(water.totalVolume()).toBeCloseTo(7.75, 5);
  });
});
