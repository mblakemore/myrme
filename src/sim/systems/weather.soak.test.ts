import { describe, expect, it } from 'vitest';
import { envOf, v3isFinite, waterEx, weatherEx, type NavEx } from '../../core';
import type { Simulation } from '../Simulation';
import { makeSim } from '../testUtil';
import { makeEnvSim } from './weatherTestWorld';

/**
 * B2 soaks (PLAN §11): the environment must be survivable, deterministic and cheap.
 *   storm     a meadow colony sits out a forced thunderstorm (nest floods), then recovers
 *   outbreak  seeded infections are contained with hygiene on and spread with it off
 *   heat      a desert colony gets through a heat wave by foraging at night
 * Each prints a one-line summary; the storm soak prints sim ms/tick with rain + flood active.
 */

function finite(sim: Simulation): number {
  let bad = 0;
  for (const a of sim.ants) {
    if (!v3isFinite(a.pos) || !v3isFinite(a.up) || !v3isFinite(a.forward)) bad++;
    if (!Number.isFinite(a.health + a.energy + a.hydration + a.infection.load + a.infection.timer + a.submerged)) bad++;
  }
  for (const b of sim.brood) if (!v3isFinite(b.pos) || !Number.isFinite(b.age)) bad++;
  for (const it of sim.items) if (!v3isFinite(it.pos)) bad++;
  const w = sim.weather;
  if (!Number.isFinite(w.timeOfDay + w.temperature + w.wetness + w.intensity + w.wind.x + w.wind.z)) bad++;
  const water = waterEx(sim.water);
  if (!Number.isFinite(water.totalVolume() + water.totalAdded + water.totalDrained)) bad++;
  for (const c of sim.colonies) if (!Number.isFinite(c.stores.food)) bad++;
  return bad;
}

const outside = (sim: Simulation): number => {
  const nav = sim.nav as NavEx;
  let n = 0;
  for (const a of sim.ants) if (a.colony === sim.playerColony && a.cell >= 0 && nav.isExposed(a.cell)) n++;
  return n;
};

const pop = (sim: Simulation): number => sim.ants.filter((a) => a.colony === sim.playerColony).length;

describe('B2 soak: rainstorm', () => {
  it('a meadow colony survives a forced heavy storm and recovers', () => {
    const sim = makeSim('meadow', { seed: 11, fixture: 'none', small: true });
    const env = envOf(sim)!;
    const col = sim.getColony(sim.playerColony)!;
    const water = waterEx(sim.water);
    const cs = env.colonyState(col.id);
    const deaths: Record<string, number> = {};
    const alerts = new Set<string>();
    let bad = 0;
    let broodLost = 0;
    const run = (seconds: number, each?: () => void): number => {
      const t0 = performance.now();
      for (let i = 0; i < seconds * 30; i++) {
        sim.step();
        if (i % 30 === 29) {
          bad += finite(sim);
          each?.();
          for (const e of sim.drainEvents()) {
            if (e.type === 'antDied' && e.colony === col.id) deaths[e.cause] = (deaths[e.cause] ?? 0) + 1;
            else if (e.type === 'alert') alerts.add(e.text);
            else if (e.type === 'broodStage' && e.stage === 'dead') broodLost++;
          }
        }
      }
      return (performance.now() - t0) / (seconds * 30);
    };
    const msCalm = run(120);
    const before = { pop: pop(sim), food: col.stores.food };
    expect(outside(sim)).toBeGreaterThan(1);

    sim.command({ type: 'debugWeather', kind: 'storm', intensity: 1 });
    let t = 0;
    let outLate = 0;
    let foodMin = Infinity;
    let peakWater = 0;
    let peakNest = 0;
    let peakCells = 0;
    let flooded = false;
    const msStorm = run(200, () => {
      t++;
      if (t > 50) outLate = Math.max(outLate, outside(sim));
      foodMin = Math.min(foodMin, col.stores.food);
      peakWater = Math.max(peakWater, water.totalVolume());
      peakCells = Math.max(peakCells, water.activeCount);
      peakNest = Math.max(peakNest, cs.nestWater);
      if (cs.flooded) flooded = true;
    });
    expect(weatherEx(sim.weather).rain).toBeGreaterThan(0.9);
    const hashStorm = sim.stateHash();

    env.forceWeather('clear', 0, 3000);
    const msAfter = run(330, () => {
      foodMin = Math.min(foodMin, col.stores.food);
    });
    const after = { pop: pop(sim), food: col.stores.food, out: outside(sim) };
    console.log(
      `[B2 storm] pop ${before.pop} → ${after.pop}, food ${before.food.toFixed(0)} → min ${foodMin.toFixed(0)} → ${after.food.toFixed(0)}, peak water ${peakWater.toFixed(0)} vox, nest cells under water ${peakNest}${flooded ? ' (FLOODED)' : ''}, brood lost ${broodLost}, deaths ${JSON.stringify(deaths)}, ` +
        `sim ms/tick calm ${msCalm.toFixed(3)} | rain+flood ${msStorm.toFixed(3)} | draining ${msAfter.toFixed(3)} (peak active water cells ${peakCells})`,
    );
    expect(bad).toBe(0);
    // during: everyone in, water in the nest, stores eaten down
    expect(outLate).toBeLessThanOrEqual(5); // (a few are driven out of the flooded galleries)
    expect(peakWater).toBeGreaterThan(20);
    expect(alerts.has('Foragers are sheltering from the rain')).toBe(true);
    expect(alerts.has('Water is running into the nest')).toBe(true);
    expect(foodMin).toBeLessThan(before.food * 0.6);
    // after: queen alive, colony at least as big, foraging again, stores back, water gone from the nest
    expect(sim.getAnt(col.queenId)?.alive).toBe(true);
    expect(after.pop).toBeGreaterThanOrEqual(before.pop);
    expect(after.out).toBeGreaterThan(3);
    expect(after.food).toBeGreaterThan(foodMin + 30);
    expect(cs.nestWater).toBe(0);
    expect(cs.flooded).toBe(false);
    expect(cs.shelter).toBe('none');
    expect(deaths.drowning ?? 0).toBeLessThanOrEqual(before.pop);
    expect(water.totalAdded - water.totalDrained).toBeCloseTo(water.totalVolume(), 3);
    // cheap: well inside the 33 ms frame even at full rain with the flood running
    expect(msStorm).toBeLessThan(4);

    // deterministic: the same seed and commands reproduce the storm exactly
    const again = makeSim('meadow', { seed: 11, fixture: 'none', small: true });
    for (let i = 0; i < 120 * 30; i++) again.step();
    again.command({ type: 'debugWeather', kind: 'storm', intensity: 1 });
    for (let i = 0; i < 200 * 30; i++) {
      again.step();
      if (i % 900 === 0) again.drainEvents();
    }
    expect(again.stateHash()).toBe(hashStorm);
    expect(waterEx(again.water).totalAdded).toBeGreaterThan(0);
  }, 60000);
});

describe('B2 soak: outbreak', () => {
  const SEEDS = [1, 2, 3, 4, 5];
  const outbreak = (seed: number, hygiene: boolean): { infections: number; grips: number; cures: number; exiles: number; pop: number; sick: number; bad: number; hash: string } => {
    const sim = makeEnvSim({ seed, rainChance: 0, stems: [{ x: 38, z: 14, height: 10 }] });
    const env = envOf(sim)!;
    env.forceWeather('clear', 0, 99999);
    if (!hygiene) sim.colonies[0].priorities.exile = 0;
    for (let i = 0; i < 90 * 30; i++) sim.step();
    // two foragers come home incubating
    const ws = sim.ants.filter((a) => a.caste === 'worker');
    sim.command({ type: 'debugInfect', id: ws[1].id });
    sim.command({ type: 'debugInfect', id: ws[4].id });
    let bad = 0;
    for (let i = 0; i < 660 * 30; i++) {
      sim.step();
      if (i % 300 === 0) {
        bad += finite(sim);
        sim.drainEvents();
      }
    }
    const s = env.fungusStats;
    const sick = sim.ants.filter((a) => a.infection.stage !== 'none' && a.infection.stage !== 'exposed').length;
    return { infections: s.infections, grips: s.grips, cures: s.cures, exiles: s.exiles, pop: sim.ants.length, sick, bad, hash: sim.stateHash() };
  };

  it('is contained with hygiene on in most seeds and spreads with hygiene off', () => {
    const on = SEEDS.map((s) => outbreak(s, true));
    const off = SEEDS.map((s) => outbreak(s, false));
    const fmt = (r: ReturnType<typeof outbreak>): string => `inf ${r.infections} grips ${r.grips} cured ${r.cures} exiled ${r.exiles} sick-now ${r.sick} pop ${r.pop}`;
    console.log('[B2 outbreak] hygiene ON : ' + on.map(fmt).join(' | '));
    console.log('[B2 outbreak] hygiene OFF: ' + off.map(fmt).join(' | '));
    for (const r of [...on, ...off]) expect(r.bad).toBe(0);
    // contained = at most one secondary case beyond the two index cases, nobody reaches the death
    // grip, at most one ant still under treatment at the end (final round: foragers find the stem
    // sooner, so one contact case per run is now typical; unchecked it is still 30+)
    const contained = on.filter((r) => r.infections <= 3 && r.sick <= 1 && r.grips === 0).length;
    expect(contained).toBeGreaterThanOrEqual(4);
    for (const r of on) expect(r.cures + r.exiles).toBeGreaterThan(0);
    // unchecked: both index cases grip and their spores take more ants in most seeds
    const spread = off.filter((r) => r.infections > 2).length;
    expect(spread).toBeGreaterThanOrEqual(4);
    for (const r of off) {
      expect(r.grips).toBeGreaterThanOrEqual(1);
      expect(r.cures + r.exiles).toBe(0);
    }
    const sum = (rs: ReturnType<typeof outbreak>[]): number => rs.reduce((n, r) => n + r.infections, 0);
    expect(sum(off)).toBeGreaterThan(sum(on) * 2);
    // deterministic
    expect(outbreak(3, true).hash).toBe(on[2].hash);
  }, 60000);
});

describe('B2 soak: heat wave', () => {
  it('a desert colony survives a heat wave by shifting its activity to the night', () => {
    const sim = makeSim('desert', { seed: 11, fixture: 'none', small: true });
    const env = envOf(sim)!;
    const col = sim.getColony(sim.playerColony)!;
    const cs = env.colonyState(col.id);
    let bad = 0;
    const deaths: Record<string, number> = {};
    for (let i = 0; i < 60 * 30; i++) sim.step();
    sim.command({ type: 'debugWeather', kind: 'heat', intensity: 1 });
    const before = pop(sim);
    // one full day, sampled once a second
    let dayOut = 0;
    let daySamples = 0;
    let nightOut = 0;
    let nightSamples = 0;
    let shelterDay = 0;
    let hottest = 0;
    let minHydration = 1;
    const t0 = performance.now();
    for (let i = 0; i < 720 * 30; i++) {
      sim.step();
      if (i % 30 !== 29) continue;
      bad += finite(sim);
      const hour = sim.weather.timeOfDay * 24;
      const out = outside(sim);
      hottest = Math.max(hottest, sim.weather.temperature);
      for (const a of sim.ants) if (a.colony === col.id) minHydration = Math.min(minHydration, a.hydration);
      if (hour >= 11 && hour < 17) {
        dayOut += out;
        daySamples++;
        if (cs.shelter === 'heat') shelterDay++;
      } else if (hour >= 23 || hour < 5) {
        nightOut += out;
        nightSamples++;
      }
      for (const e of sim.drainEvents()) if (e.type === 'antDied' && e.colony === col.id) deaths[e.cause] = (deaths[e.cause] ?? 0) + 1;
    }
    const ms = (performance.now() - t0) / (720 * 30);
    const after = pop(sim);
    const day = dayOut / daySamples;
    const night = nightOut / nightSamples;
    console.log(`[B2 heat] pop ${before} → ${after}, peak air ${hottest.toFixed(1)} °C, mean ants outside midday ${day.toFixed(1)} vs night ${night.toFixed(1)}, min hydration ${minHydration.toFixed(2)}, deaths ${JSON.stringify(deaths)}, food ${col.stores.food.toFixed(0)}, sim ms/tick ${ms.toFixed(3)}`);
    expect(bad).toBe(0);
    expect(hottest).toBeGreaterThan(45);
    expect(shelterDay).toBeGreaterThan(daySamples * 0.9);
    expect(day).toBeLessThan(1.5);
    expect(night).toBeGreaterThan(5);
    expect(night).toBeGreaterThan(day * 4);
    expect(sim.getAnt(col.queenId)?.alive).toBe(true);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(deaths.desiccation ?? 0).toBeLessThanOrEqual(2);
    expect(col.stores.food).toBeGreaterThan(10);
  }, 60000);
});
