import { describe, expect, it } from 'vitest';
import { Mat, envOf, weatherEx, type NavEx } from '../../core';
import { Simulation } from '../Simulation';
import { temperatureSystem } from './temperature';
import { weatherSystem } from './weather';
import { makeEnvMap, makeEnvSim } from './weatherTestWorld';

const S = 48;
const G = 20;
const C = S / 2;

function envOnly(opts: Parameters<typeof makeEnvMap>[0] = {}, mapId: 'meadow' | 'desert' = 'meadow'): Simulation {
  const map = makeEnvMap(opts);
  // a slab of wood on legs: shade over open ground at (8..14, 8..14)
  const w = map.world;
  for (let z = 8; z <= 14; z++) for (let x = 8; x <= 14; x++) for (let y = G + 3; y <= G + 4; y++) w.setCell(x, y, z, 1, Mat.Wood);
  w.markAllDirty();
  return new Simulation(mapId, map, { seed: 1, faction: 'gardenAnt', fixture: 'none' }, [weatherSystem, temperatureSystem]);
}

describe('temperature model', () => {
  it('swings with the time of day: warm afternoons, cold nights', () => {
    const sim = envOnly({ rainChance: 0 });
    envOf(sim)!.forceWeather('clear', 0, 5000);
    const byHour: number[] = [];
    for (let h = 0; h < 24; h++) {
      for (let i = 0; i < 30 * 30; i++) sim.step();
      byHour[Math.round(sim.weather.timeOfDay * 24) % 24] = sim.weather.temperature;
    }
    const base = sim.map.environment.baseTemperature;
    const max = Math.max(...byHour);
    const min = Math.min(...byHour);
    expect(max).toBeGreaterThan(base + 5);
    expect(min).toBeLessThan(base - 6);
    expect(byHour.indexOf(max)).toBeGreaterThanOrEqual(12);
    expect(byHour.indexOf(max)).toBeLessThanOrEqual(17);
    const coldest = byHour.indexOf(min);
    expect(coldest <= 6 || coldest >= 22).toBe(true);
    expect(byHour[14]).toBeGreaterThan(byHour[2] + 10);
  });

  it('is hot in the sun, cooler in shade, stable underground; heat sources add locally', () => {
    const sim = envOnly({ rainChance: 0 });
    const env = envOf(sim)!;
    const nav = sim.nav as NavEx;
    env.forceWeather('clear', 0, 5000);
    // run to early afternoon
    while (sim.weather.timeOfDay < 0.58) sim.step();
    const w = sim.world;
    const sunCell = w.index(30, G, 30);
    const shadeCell = w.index(11, G, 11);
    const deepCell = sim.colonies[0].nestCell;
    expect(nav.isExposed(sunCell)).toBe(true);
    expect(nav.isExposed(shadeCell)).toBe(false);
    const tSun = env.temperatureAtCell(sunCell);
    const tShade = env.temperatureAtCell(shadeCell);
    const tDeep = env.temperatureAtCell(deepCell);
    expect(tSun).toBeGreaterThan(sim.weather.temperature + 2);
    expect(tShade).toBeLessThan(tSun - 4);
    expect(tDeep).toBeLessThan(tShade);
    expect(env.sunExposure(sunCell)).toBeGreaterThan(0.5);
    expect(env.sunExposure(shadeCell)).toBe(0);
    expect(env.temperatureAt({ x: 30.5, y: G + 0.5, z: 30.5 })).toBe(tSun);
    // midnight: the surface is cold, the nest keeps its warmth
    while (sim.weather.timeOfDay > 0.05) sim.step();
    while (sim.weather.timeOfDay < 0.05) sim.step();
    const nSun = env.temperatureAtCell(sunCell);
    const nDeep = env.temperatureAtCell(deepCell);
    expect(nSun).toBeLessThan(tSun - 12);
    expect(nDeep).toBeGreaterThan(nSun + 4);
    expect(Math.abs(nDeep - tDeep)).toBeLessThan(Math.abs(nSun - tSun) * 0.45);
    // cold slows, warmth is the optimum
    expect(env.activityAt(nSun)).toBeLessThan(env.activityAt(24));
    expect(env.activityAt(3)).toBeLessThan(0.5);
    // heat source (keeper lamp hook)
    const id = env.addHeatSource({ x: 30.5, y: G + 2, z: 30.5 }, 8, 12);
    expect(env.temperatureAtCell(sunCell)).toBeGreaterThan(nSun + 7);
    expect(env.temperatureAtCell(w.index(44, G, 44))).toBeCloseTo(env.temperatureAtCell(w.index(40, G, 44)), 5);
    env.removeHeatSource(id);
    expect(env.temperatureAtCell(sunCell)).toBeCloseTo(nSun, 6);
    sim.weather.lamp = { x: 30.5, y: G + 2, z: 30.5 };
    expect(env.temperatureAtCell(sunCell)).toBeGreaterThan(nSun + 8);
  });

  it('cloud and rain cool the day; a heat wave heats it', () => {
    const at = (kind: 'clear' | 'storm' | 'heat'): number => {
      const sim = envOnly({ rainChance: 0 });
      envOf(sim)!.forceWeather(kind, 1, 5000);
      while (sim.weather.timeOfDay < 0.6) sim.step();
      return sim.weather.temperature;
    };
    const clear = at('clear');
    expect(at('storm')).toBeLessThan(clear - 4);
    expect(at('heat')).toBeGreaterThan(clear + 5);
  });
});

describe('temperature effects', () => {
  it('ants move slower in the cold of the night than in the afternoon', () => {
    const sim = makeEnvSim({ seed: 2, rainChance: 0 });
    const nav = sim.nav as NavEx;
    envOf(sim)!.forceWeather('clear', 0, 5000);
    const a = sim.ants.find((x) => x.caste === 'worker')!;
    a.lifespan = Infinity;
    /** Average speed of the ordered ant over the stretch it walks in the open. */
    const surfaceSpeed = (): number => {
      let d = 0;
      let n = 0;
      const corners = [
        { x: C - 16, y: G + 0.5, z: C - 16 },
        { x: C + 16, y: G + 0.5, z: C - 16 },
      ];
      for (let leg = 0; leg < 2; leg++) {
        sim.command({ type: 'order', ids: [a.id], order: 'move', pos: corners[leg] });
        for (let i = 0; i < 18 * 30; i++) {
          sim.step();
          if (a.cell >= 0 && nav.isExposed(a.cell) && a.intent.mode !== 'none') {
            d += Math.hypot(a.pos.x - a.prevPos.x, a.pos.y - a.prevPos.y, a.pos.z - a.prevPos.z);
            n++;
          }
        }
      }
      expect(n).toBeGreaterThan(90);
      return (d / n) * 30;
    };
    while (sim.weather.timeOfDay < 0.55) sim.step();
    const tDay = sim.weather.temperature;
    const day = surfaceSpeed();
    while (sim.weather.timeOfDay > 0.5) sim.step();
    while (sim.weather.timeOfDay < 0.08) sim.step();
    const tNight = sim.weather.temperature;
    const night = surfaceSpeed();
    expect(tNight).toBeLessThan(tDay - 12);
    expect(day).toBeGreaterThan(1.5);
    expect(night).toBeLessThan(day * 0.8);
    expect(a.alive).toBe(true);
  });

  it('midday desert heat desiccates exposed ants; the colony shelters and ants in the nest are fine', () => {
    const sim = makeEnvSim({ seed: 3, rainChance: 0, baseTemperature: 36, material: Mat.Sand }, 'desert');
    const env = envOf(sim)!;
    const nav = sim.nav as NavEx;
    const col = sim.colonies[0];
    env.forceWeather('heat', 1, 5000);
    // skip to late morning
    while (sim.weather.timeOfDay < 0.45) sim.step();
    for (let i = 0; i < 20 * 30; i++) sim.step();
    expect(weatherEx(sim.weather).phase).toBe('heat');
    expect(env.colonyState(col.id).shelter).toBe('heat');
    const surface = sim.world.index(30, G, 30);
    expect(env.temperatureAtCell(surface)).toBeGreaterThan(48);
    expect(env.temperatureAtCell(col.nestCell)).toBeLessThan(40);
    // one worker is ordered to stand guard in the sun (player orders beat the shelter instinct)
    const victim = sim.ants.find((a) => a.caste === 'worker')!;
    sim.command({ type: 'order', ids: [victim.id], order: 'guard', pos: { x: 30.5, y: G + 0.5, z: 30.5 } });
    let died = '';
    let minHyd = 1;
    let outside = 0;
    for (let i = 0; i < 150 * 30 && !died; i++) {
      sim.step();
      minHyd = Math.min(minHyd, victim.hydration);
      // (on the surface — the open throat of the entrance shaft does not count)
      if (i > 600 && i % 30 === 0) outside = Math.max(outside, sim.ants.filter((a) => a.id !== victim.id && a.cell >= 0 && a.pos.y > G - 1 && nav.isExposed(a.cell)).length);
      for (const e of sim.drainEvents()) if (e.type === 'antDied' && e.id === victim.id) died = e.cause;
    }
    expect(minHyd).toBeLessThan(0.05);
    expect(died).toBe('desiccation');
    expect(outside).toBeLessThanOrEqual(1);
    // everyone else kept out of the sun and stayed hydrated
    for (const a of sim.ants) expect(a.hydration).toBeGreaterThan(0.6);
    expect(sim.ants.length).toBeGreaterThan(8);
  });

  it('brood develops faster in a warm chamber than in a cold one', () => {
    const ageAfter = (base: number): number => {
      const sim = makeEnvSim({ seed: 5, rainChance: 0, dayNight: false, weather: false, baseTemperature: base });
      const col = sim.colonies[0];
      const b = sim.spawnBrood(col.id, 'worker', col.nestPos);
      for (let i = 0; i < 600; i++) sim.step();
      return b.stage === 'egg' ? b.age : 9999;
    };
    // (the nest sits 1 °C below the map's base temperature; 24 °C is the brood optimum)
    const warm = ageAfter(32);
    const mild = ageAfter(25);
    const cold = ageAfter(14);
    expect(mild).toBeGreaterThanOrEqual(595);
    expect(mild).toBeLessThanOrEqual(605);
    expect(warm).toBeGreaterThan(mild * 1.2);
    expect(cold).toBeLessThan(mild * 0.8);
  });
});
