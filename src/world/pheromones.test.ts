import { describe, expect, it } from 'vitest';
import { Mat, Phero, SeededRng, type PheroChannel, type TrailSense } from '../core';
import { createWorld } from './VoxelWorld';
import { PHERO_MAX, createPheromones } from './pheromones';

describe('pheromones', () => {
  it('deposits, samples per colony+channel and clamps to the channel max', () => {
    const p = createPheromones();
    p.deposit(1, Phero.food, 100, 2);
    p.deposit(1, Phero.food, 100, 1);
    p.deposit(2, Phero.food, 100, 5);
    p.deposit(1, Phero.alarm, 100, 4);
    expect(p.sample(1, Phero.food, 100)).toBeCloseTo(3);
    expect(p.sample(2, Phero.food, 100)).toBeCloseTo(5);
    expect(p.sample(1, Phero.alarm, 100)).toBeCloseTo(4);
    expect(p.sample(1, Phero.food, 101)).toBe(0);
    p.deposit(1, Phero.food, 100, 1e6);
    expect(p.sample(1, Phero.food, 100)).toBe(PHERO_MAX[Phero.food]);
  });

  it('evaporates multiplicatively and frees dead entries', () => {
    const p = createPheromones();
    for (let c = 0; c < 50; c++) p.deposit(1, Phero.alarm, c, 1 + c * 0.1);
    expect(p.activeCount(1, Phero.alarm)).toBe(50);
    const before = p.sample(1, Phero.alarm, 10);
    p.evaporate();
    const after = p.sample(1, Phero.alarm, 10);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(before * 0.5);
    for (let i = 0; i < 200; i++) p.evaporate();
    expect(p.activeCount(1, Phero.alarm)).toBe(0);
    expect(p.sample(1, Phero.alarm, 10)).toBe(0);
    // faster decay with scale
    const q = createPheromones();
    q.deposit(1, Phero.trail, 1, 5);
    q.deposit(1, Phero.trail, 2, 5);
    q.evaporate(1);
    const slow = q.sample(1, Phero.trail, 1);
    q.evaporate(4);
    expect(q.sample(1, Phero.trail, 1)).toBeLessThan(slow * 0.97);
  });

  it('forEachActive visits exactly the live cells; clearCell removes all channels and colonies', () => {
    const p = createPheromones();
    p.deposit(1, Phero.trail, 7, 1);
    p.deposit(1, Phero.trail, 8, 2);
    p.deposit(1, Phero.trail, 9, 3);
    p.deposit(2, Phero.dig, 8, 1);
    p.clearCell(8);
    const seen = new Map<number, number>();
    p.forEachActive(1, Phero.trail, (cell, v) => seen.set(cell, v));
    expect([...seen.keys()].sort()).toEqual([7, 9]);
    expect(seen.get(9)).toBeCloseTo(3);
    expect(p.sample(2, Phero.dig, 8)).toBe(0);
    expect(p.activeCount(1, Phero.trail)).toBe(2);
    // pool stays consistent after swap-remove
    p.deposit(1, Phero.trail, 8, 4);
    expect(p.sample(1, Phero.trail, 8)).toBeCloseTo(4);
    expect(p.sample(1, Phero.trail, 7)).toBeCloseTo(1);
  });
});

describe('pheromone store (A2a)', () => {
  it('per-channel rates, caps and floor come from configure()', () => {
    const p = createPheromones();
    p.configure({ keep: [0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 1], max: [4, 10, 10, 10, 10, 10, 10, 2], floor: 0.1 });
    p.deposit(1, Phero.food, 5, 100);
    p.deposit(1, Phero.trail, 5, 100);
    expect(p.sample(1, Phero.food, 5)).toBe(4);
    expect(p.sample(1, Phero.trail, 5)).toBe(2);
    expect(p.maxOf(Phero.food)).toBe(4);
    p.evaporate();
    expect(p.sample(1, Phero.food, 5)).toBeCloseTo(2);
    expect(p.sample(1, Phero.trail, 5)).toBe(2); // keep 1 = never fades
    for (let i = 0; i < 5; i++) p.evaporate(); // 4 · 0.5^6 = 0.0625 < floor
    expect(p.sample(1, Phero.food, 5)).toBe(0);
    expect(p.activeCount(1, Phero.food)).toBe(0);
    // global and per-channel multipliers
    p.setChannelScale(Phero.alarm, 3);
    p.deposit(1, Phero.alarm, 1, 10);
    p.deposit(1, Phero.death, 1, 10);
    p.evaporate();
    expect(p.sample(1, Phero.alarm, 1)).toBeCloseTo(10 * 0.9 ** 3, 4);
    expect(p.sample(1, Phero.death, 1)).toBeCloseTo(9, 4);
    p.setDecayScale(2);
    p.evaporate();
    expect(p.sample(1, Phero.death, 1)).toBeCloseTo(9 * 0.81, 4);
  });

  it('weather only washes out sky-exposed cells', () => {
    const p = createPheromones();
    p.setExposure((cell) => cell >= 1000);
    p.deposit(1, Phero.food, 10, 8); // in the nest
    p.deposit(1, Phero.food, 2000, 8); // outdoors
    p.setWeatherScale(8); // heavy rain
    for (let i = 0; i < 10; i++) p.evaporate();
    const indoor = p.sample(1, Phero.food, 10);
    const outdoor = p.sample(1, Phero.food, 2000);
    expect(indoor).toBeCloseTo(8 * 0.985 ** 10, 3);
    expect(outdoor).toBeCloseTo(8 * 0.985 ** 80, 3);
    expect(outdoor).toBeLessThan(indoor * 0.5);
  });

  it('colonies are isolated but can smell each other at reduced strength', () => {
    const p = createPheromones();
    p.deposit(1, Phero.alarm, 42, 6);
    p.deposit(3, Phero.alarm, 42, 2);
    expect(p.sample(2, Phero.alarm, 42)).toBe(0);
    expect(p.sampleForeign(2, Phero.alarm, 42)).toBeCloseTo(3); // strongest other colony × 0.5
    expect(p.sampleForeign(1, Phero.alarm, 42)).toBeCloseTo(1); // excludes its own
    expect(p.sampleForeign(1, Phero.trail, 42)).toBe(0);
    p.configure({ foreignFactor: 0.25 });
    expect(p.sampleForeign(2, Phero.alarm, 42)).toBeCloseTo(1.5);
  });

  it('memory is bounded: pools stop growing at maxEntries and report what they dropped', () => {
    const p = createPheromones();
    p.configure({ maxEntries: 500 });
    for (let c = 0; c < 5000; c++) p.deposit(1, Phero.trail, c * 3, 1);
    expect(p.activeCount(1, Phero.trail)).toBe(500);
    const st = p.stats();
    expect(st.entries).toBe(500);
    expect(st.dropped).toBe(4500);
    expect(st.maxEntriesPerPool).toBe(500);
    expect(st.bytes).toBeLessThan(500 * 4 * 40);
    // existing cells still accept deposits when the pool is full
    p.deposit(1, Phero.trail, 0, 1);
    expect(p.sample(1, Phero.trail, 0)).toBeCloseTo(2);
    // evaporation frees room again
    for (let i = 0; i < 400; i++) p.evaporate(4);
    expect(p.stats().entries).toBe(0);
    p.deposit(1, Phero.trail, 99999, 1);
    expect(p.activeCount(1, Phero.trail)).toBe(1);
    expect(p.stats().peakEntries).toBe(500);
  });

  it('typed-array hash pool behaves exactly like a Map under random churn', () => {
    const p = createPheromones();
    const ref = new Map<number, number>();
    const rng = new SeededRng(1234);
    const ch: PheroChannel = Phero.rally;
    const keep = 0.95;
    for (let step = 0; step < 30000; step++) {
      const r = rng.next();
      // cells collide heavily in the table (multiples of 1024 and a dense block)
      const cell = rng.chance(0.5) ? rng.int(3000) : rng.int(400) * 1024;
      if (r < 0.6) {
        const amount = rng.range(0.05, 3);
        p.deposit(2, ch, cell, amount);
        ref.set(cell, Math.fround(Math.min(10, Math.fround((ref.get(cell) ?? 0) + amount))));
      } else if (r < 0.9) {
        p.clearCell(cell);
        ref.delete(cell);
      } else if (r < 0.93) {
        p.evaporate();
        for (const [c, v] of ref) {
          const nv = Math.fround(v * keep);
          if (nv < 0.02) ref.delete(c);
          else ref.set(c, nv);
        }
      } else {
        expect(p.sample(2, ch, cell)).toBeCloseTo(ref.get(cell) ?? 0, 4);
      }
    }
    expect(p.activeCount(2, ch)).toBe(ref.size);
    const seen = new Map<number, number>();
    p.forEachActive(2, ch, (c, v) => seen.set(c, v));
    expect(seen.size).toBe(ref.size);
    for (const [c, v] of ref) expect(seen.get(c)).toBeCloseTo(v, 4);
  });

  it('three-antenna sensor steers towards the trail', () => {
    const w = createWorld(32, 16, 32, 'open');
    for (let y = 0; y < 16; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) w.setCell(x, y, z, 8 - (y + 0.5), Mat.Soil);
    w.markAllDirty();
    const p = createPheromones();
    for (let x = 4; x < 28; x++) p.deposit(1, Phero.trail, w.index(x, 8, 16), 5); // a trail along +x at z = 16
    const out: TrailSense = { left: 0, centre: 0, right: 0, total: 0, turn: 0, dir: { x: 0, y: 0, z: 0 } };
    const up = { x: 0, y: 1, z: 0 };
    const fwd = { x: 1, y: 0, z: 0 };
    // on the trail, heading along it: centre antenna only, go straight
    p.senseTrail(w, 1, Phero.trail, { x: 10.5, y: 8.15, z: 16.5 }, fwd, up, out);
    expect(out.centre).toBeGreaterThan(0);
    expect(Math.abs(out.turn)).toBeLessThan(0.05);
    expect(out.dir.x).toBeGreaterThan(0.99);
    // trail lies at smaller z than the ant → it must steer towards −z
    p.senseTrail(w, 1, Phero.trail, { x: 10.5, y: 8.15, z: 17.6 }, fwd, up, out);
    expect(out.total).toBeGreaterThan(0);
    expect(out.dir.z).toBeLessThan(-0.2);
    const turnA = out.turn;
    p.senseTrail(w, 1, Phero.trail, { x: 10.5, y: 8.15, z: 15.4 }, fwd, up, out);
    expect(out.dir.z).toBeGreaterThan(0.2);
    expect(Math.sign(out.turn)).toBe(-Math.sign(turnA));
    // nothing in range → no bias, keep heading
    p.senseTrail(w, 1, Phero.trail, { x: 10.5, y: 8.15, z: 24.5 }, fwd, up, out);
    expect(out.total).toBe(0);
    expect(out.turn).toBe(0);
    expect(out.dir).toEqual(fwd);
    // other colonies' trails are invisible unless asked for
    p.senseTrail(w, 2, Phero.trail, { x: 10.5, y: 8.15, z: 16.5 }, fwd, up, out);
    expect(out.total).toBe(0);
    p.senseTrail(w, 2, Phero.trail, { x: 10.5, y: 8.15, z: 16.5 }, fwd, up, out, 1.6, 0.65, true);
    expect(out.total).toBeGreaterThan(0);
  });
});
