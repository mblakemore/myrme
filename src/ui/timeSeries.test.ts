import { describe, expect, it } from 'vitest';
import { b3StateOf, type SimEvent, type SimView } from '../core';
import { sparkPath } from './sparkline';
import { TimeSeriesRecorder } from './timeSeries';

interface Fake {
  sim: SimView;
  set(p: Partial<{ tick: number; pop: number; food: number; deaths: number; workers: number; soldiers: number }>): void;
}

function fakeSim(): Fake {
  const colony = {
    id: 1,
    nestPos: { x: 10, y: 10, z: 10 },
    population: { total: 10, byCaste: { worker: 8, soldier: 2 } as Record<string, number>, eggs: 1, larvae: 2, pupae: 3 },
    stores: { food: 50, wood: 0, leaves: 0, mud: 0 },
    jobs: [
      { slots: 3, assigned: [1] },
      { slots: 2, assigned: [1, 2] },
    ],
    stats: { foodDelivered: 120, dugVoxels: 40, kills: 3, deaths: 0, born: 7 },
  };
  const sim = {
    tick: 0,
    time: 0,
    playerColony: 1,
    ants: [
      { alive: true, colony: 2, pos: { x: 12, y: 10, z: 10 }, caste: 'worker' },
      { alive: true, colony: 2, pos: { x: 500, y: 10, z: 10 }, caste: 'worker' },
    ],
    creatures: [{ alive: true, state: 'stalk', pos: { x: 10, y: 11, z: 10 } }, { alive: true, state: 'roam', pos: { x: 10, y: 11, z: 10 } }],
    weather: { day: 2 },
    map: { environment: { dayLength: 600 } },
    goal: { status: 'active', reason: '' },
    getColony: (id: number) => (id === 1 ? colony : undefined),
  };
  return {
    sim: sim as unknown as SimView,
    set(p) {
      if (p.tick !== undefined) {
        sim.tick = p.tick;
        sim.time = p.tick / 30;
      }
      if (p.pop !== undefined) colony.population.total = p.pop;
      if (p.workers !== undefined) colony.population.byCaste.worker = p.workers;
      if (p.soldiers !== undefined) colony.population.byCaste.soldier = p.soldiers;
      if (p.food !== undefined) colony.stores.food = p.food;
      if (p.deaths !== undefined) colony.stats.deaths = p.deaths;
    },
  };
}

const died = (tick: number, cause: string, colony = 1): SimEvent => ({ type: 'antDied', tick, id: tick, colony, caste: 'worker', cause, pos: { x: 1, y: 2, z: 3 } }) as SimEvent;

describe('TimeSeriesRecorder', () => {
  it('samples once per interval of sim ticks, however often it is called', () => {
    const f = fakeSim();
    const r = new TimeSeriesRecorder(100, 30);
    r.observe(f.sim, []); // first call samples
    expect(r.samples).toBe(1);
    for (let t = 1; t < 30; t++) {
      f.set({ tick: t });
      r.observe(f.sim, []);
      r.observe(f.sim, []);
    }
    expect(r.samples).toBe(1);
    f.set({ tick: 30 });
    r.observe(f.sim, []);
    expect(r.samples).toBe(2);
    // paused: no new samples
    for (let i = 0; i < 50; i++) r.observe(f.sim, []);
    expect(r.samples).toBe(2);
    // a debug step of many ticks yields ONE sample, not a burst
    f.set({ tick: 3000 });
    r.observe(f.sim, []);
    expect(r.samples).toBe(3);
    expect(r.values('population')).toEqual([10, 10, 10]);
  });

  it('records the colony metrics', () => {
    const f = fakeSim();
    const r = new TimeSeriesRecorder();
    r.observe(f.sim, []);
    expect(r.last('population')).toBe(10);
    expect(r.last('workers')).toBe(8);
    expect(r.last('soldiers')).toBe(2);
    expect(r.last('brood')).toBe(6);
    expect(r.last('food')).toBe(50);
    expect(r.last('jobsOpen')).toBe(2);
    // one enemy ant near the nest + one stalking creature; the far ant and the roaming creature do not count
    expect(r.last('threat')).toBe(2);
  });

  it('wraps around keeping the newest samples in order, and remembers the all-time peak', () => {
    const f = fakeSim();
    const r = new TimeSeriesRecorder(5, 30);
    for (let i = 0; i < 12; i++) {
      f.set({ tick: i * 30, pop: i === 3 ? 99 : i });
      r.observe(f.sim, []);
    }
    expect(r.samples).toBe(12);
    expect(r.values('population')).toEqual([7, 8, 9, 10, 11]);
    expect(r.last('population')).toBe(11);
    expect(r.peak('population')).toBe(99);
  });

  it('computes the net rate per sim minute from tick stamps', () => {
    const f = fakeSim();
    const r = new TimeSeriesRecorder(600, 30);
    expect(r.ratePerMinute('food')).toBe(0);
    for (let i = 0; i <= 60; i++) {
      f.set({ tick: i * 30, food: 50 + i * 0.5 }); // +0.5 per second
      r.observe(f.sim, []);
    }
    expect(r.ratePerMinute('food', 60)).toBeCloseTo(30, 3);
    expect(r.ratePerMinute('food', 10)).toBeCloseTo(30, 3);
    // irregular sampling (4× speed, hitches) still gives the right slope
    f.set({ tick: 60 * 30 + 300, food: 80 - 20 });
    r.observe(f.sim, []);
    expect(r.ratePerMinute('food', 2)).toBeCloseTo((-20 / 300) * 1800, 3);
  });

  it('tallies player-colony deaths by cause and keeps a newest-first log', () => {
    const f = fakeSim();
    const r = new TimeSeriesRecorder();
    r.observe(f.sim, [died(5, 'combat'), died(6, 'combat'), died(7, 'starvation'), died(8, 'combat', 2)]);
    r.observe(f.sim, [died(40, 'fungus')]);
    expect(r.deathsByCause()).toEqual({ combat: 2, starvation: 1, fungus: 1 });
    const log = r.deathLog(3);
    expect(log.map((d) => d.tick)).toEqual([40, 7, 6]);
    expect(log[0].pos).toEqual({ x: 1, y: 2, z: 3 });
    f.set({ tick: 60 });
    r.observe(f.sim, []);
    expect(r.last('deaths')).toBe(4);
  });

  it('builds the end summary and merges B3 numbers where they exist', () => {
    const f = fakeSim();
    const r = new TimeSeriesRecorder();
    f.set({ pop: 30 });
    r.observe(f.sim, [died(1, 'combat')]);
    f.set({ tick: 1800, pop: 12, deaths: 5 });
    r.observe(f.sim, []);
    let s = r.summary(f.sim);
    expect(s.result).toBe('playing');
    expect(s.population).toBe(12);
    expect(s.peakPopulation).toBe(30);
    expect(s.deaths).toBe(5);
    expect(s.kills).toBe(3);
    expect(s.dugVoxels).toBe(40);
    expect(s.foodGathered).toBe(120);
    expect(s.born).toBe(7);
    expect(s.days).toBeCloseTo(60 / 600, 5);
    const b3 = b3StateOf(f.sim).goals.summary;
    Object.assign(b3, { result: 'won', reason: 'flight', days: 3.5, peakPopulation: 44, kills: 9, alatesLaunched: 6, population: 20 });
    s = r.summary(f.sim);
    expect(s.result).toBe('won');
    expect(s.reason).toBe('flight');
    expect(s.days).toBe(3.5);
    expect(s.peakPopulation).toBe(44);
    expect(s.kills).toBe(9);
    expect(s.population).toBe(20);
    expect(s.alatesLaunched).toBe(6);
    expect(s.foodGathered).toBe(120);
  });
});

describe('sparkPath', () => {
  it('is empty for no data and finite for flat / single-point series', () => {
    expect(sparkPath([])).toEqual({ line: '', area: '' });
    for (const v of [[5], [3, 3, 3], [0, 0]]) {
      const p = sparkPath(v);
      expect(p.line.startsWith('M')).toBe(true);
      expect(p.line).not.toMatch(/NaN|Infinity/);
      expect(p.area.endsWith('Z')).toBe(true);
    }
  });
  it('downsamples long series and ends on the newest value', () => {
    const v = Array.from({ length: 600 }, (_, i) => i);
    const p = sparkPath(v, 100, 24);
    expect(p.line.split('L').length).toBe(80);
    expect(p.line.endsWith('100.0 1.5')).toBe(true);
  });
});
