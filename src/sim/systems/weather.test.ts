import { describe, expect, it } from 'vitest';
import { Phero, STUN_KEY, clockLabel, envOf, forecastLabel, weatherEx, weatherLabel, type NavEx, type SimEvent, type WeatherStateEx } from '../../core';
import { Simulation } from '../Simulation';
import { makeSim } from '../testUtil';
import { pheromoneSystem } from './pheromone';
import { temperatureSystem } from './temperature';
import { weatherSystem } from './weather';
import { makeEnvMap, makeEnvSim } from './weatherTestWorld';

/** A sim that only runs the weather + temperature systems (fast: hours of weather in milliseconds). */
function weatherOnly(seed: number, mapId: 'meadow' | 'forest' | 'desert' = 'meadow', rainChance = 0.3): Simulation {
  const map = makeEnvMap({ rainChance, baseTemperature: mapId === 'desert' ? 36 : 22 });
  return new Simulation(mapId, map, { seed, faction: 'gardenAnt', fixture: 'none' }, [weatherSystem, temperatureSystem]);
}

function trace(sim: Simulation, ticks: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.step();
    if (i % 300 === 299 || i === ticks - 1)
      for (const e of sim.drainEvents()) {
        if (e.type === 'weatherChanged') out.push(`${e.tick}:${e.from}>${e.to}`);
        else if (e.type === 'lightning') out.push(`${e.tick}:L${e.pos.x.toFixed(1)},${e.pos.z.toFixed(1)}`);
        else if (e.type === 'alert') out.push(`${e.tick}:A:${e.text}`);
      }
  }
  return out;
}

describe('clock', () => {
  it('starts at 07:00 and a day lasts 720 s', () => {
    const sim = weatherOnly(1);
    expect(clockLabel(sim.weather.timeOfDay)).toBe('07:00');
    for (let i = 0; i < 720 * 30; i++) sim.step();
    expect(sim.weather.day).toBe(1);
    expect(sim.weather.timeOfDay).toBeCloseTo(7 / 24, 3);
    for (let i = 0; i < 360 * 30; i++) sim.step();
    expect(clockLabel(sim.weather.timeOfDay)).toBe('19:00');
  });

  it('farm maps have no weather and a fixed clock', () => {
    const sim = makeSim('gelFarm', { seed: 2, fixture: 'none', small: true });
    const t0 = sim.weather.timeOfDay;
    let changes = 0;
    for (let i = 0; i < 1500; i++) sim.step();
    for (const e of sim.drainEvents()) if (e.type === 'weatherChanged' || e.type === 'rainImpact' || e.type === 'lightning') changes++;
    const wx = weatherEx(sim.weather);
    expect(changes).toBe(0);
    expect(sim.weather.timeOfDay).toBe(t0);
    expect(wx.phase).toBe('room');
    expect(wx.forecast).toBeNull();
    expect(wx.rain).toBe(0);
    expect(weatherLabel(sim.weather)).toBe('Indoors');
    expect(envOf(sim)).not.toBeNull();
  });
});

describe('weather state machine', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = trace(weatherOnly(7), 90000);
    const b = trace(weatherOnly(7), 90000);
    const c = trace(weatherOnly(8), 90000);
    expect(a.length).toBeGreaterThan(6);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('cycles through rain with a truthful forecast and a warning ahead', () => {
    const sim = weatherOnly(11, 'meadow', 0.6);
    const wx = weatherEx(sim.weather);
    let warned = -1;
    let rainAt = -1;
    let predicted = false;
    const kinds = new Set<string>();
    let maxWet = 0;
    for (let i = 0; i < 120000 && rainAt < 0; i++) {
      // the forecast names the coming phase before it starts
      if (wx.forecast && wx.forecast.kind === 'rain' && wx.forecast.inTicks < 300 && wx.kind !== 'rain') predicted = true;
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.type === 'alert' && e.text === 'Rain is coming') warned = e.tick;
        if (e.type === 'weatherChanged') {
          kinds.add(e.to);
          if (e.to === 'rain' && wx.phase === 'rain') rainAt = e.tick;
        }
      }
    }
    expect(rainAt).toBeGreaterThan(0);
    expect(predicted).toBe(true);
    expect(warned).toBeGreaterThan(0);
    expect(rainAt - warned).toBeLessThanOrEqual(46 * 30);
    expect(rainAt - warned).toBeGreaterThan(20 * 30);
    // grace period: no rain right at the start
    expect(rainAt).toBeGreaterThan(400 * 30);
    // rain eases in, wets the ground, and it dries again afterwards
    for (let i = 0; i < 60 * 30; i++) {
      sim.step();
      maxWet = Math.max(maxWet, sim.weather.wetness);
    }
    expect(wx.rain).toBeGreaterThan(0.3);
    expect(maxWet).toBeGreaterThan(0.4);
    envOf(sim)!.forceWeather('clear', 0, 900);
    for (let i = 0; i < 600 * 30; i++) sim.step();
    expect(wx.rain).toBe(0);
    expect(sim.weather.wetness).toBe(0);
    sim.drainEvents();
  });

  it('desert gets heat waves, forest gets fog or drizzle', () => {
    const desert = trace(weatherOnly(3, 'desert', 0.04), 150000).join(' ');
    expect(desert).toMatch(/>heat/);
    const forest = weatherOnly(4, 'forest', 0.55);
    const phases = new Set<string>();
    for (let i = 0; i < 150000; i++) {
      forest.step();
      if (i % 30 === 0) phases.add(weatherEx(forest.weather).phase);
      if (i % 3000 === 0) forest.drainEvents();
    }
    expect(phases.has('drizzle') || phases.has('fog')).toBe(true);
    expect(phases.has('rain') || phases.has('drizzle')).toBe(true);
  });

  it('debugWeather forces and holds the weather; clearForcedWeather resumes the machine', () => {
    const sim = weatherOnly(5);
    const wx = weatherEx(sim.weather);
    sim.command({ type: 'debugWeather', kind: 'storm', intensity: 1 });
    const events: SimEvent[] = [];
    for (let i = 0; i < 40 * 30; i++) {
      sim.step();
      events.push(...sim.drainEvents());
    }
    expect(wx.kind).toBe('storm');
    expect(wx.forced).toBe(true);
    expect(wx.rain).toBeGreaterThan(0.9);
    expect(wx.cloudiness).toBeGreaterThan(0.8);
    expect(sim.weather.intensity).toBeGreaterThan(0.9);
    expect(Math.hypot(wx.wind.x, wx.wind.z)).toBeGreaterThan(1);
    expect(events.some((e) => e.type === 'weatherChanged' && e.to === 'storm')).toBe(true);
    expect(events.filter((e) => e.type === 'lightning').length).toBeGreaterThan(1);
    expect(events.filter((e) => e.type === 'rainImpact').length).toBeGreaterThan(100);
    expect(weatherLabel(sim.weather)).toBe('Thunderstorm');
    // still held minutes later
    for (let i = 0; i < 300 * 30; i++) sim.step();
    expect(wx.kind).toBe('storm');
    envOf(sim)!.clearForcedWeather();
    for (let i = 0; i < 5; i++) sim.step();
    expect(wx.forced).toBe(false);
    expect(wx.phase).toBe('clearing');
    sim.command({ type: 'debugWeather', kind: 'heat' });
    for (let i = 0; i < 60 * 30; i++) sim.step();
    expect(wx.kind).toBe('heat');
    expect(forecastLabel(sim.weather, 1e9)).toBeTypeOf('string');
    sim.drainEvents();
  });
});

describe('rain', () => {
  it('raindrops only land on sky-exposed surface and only hit ants in the open', () => {
    // wander fixture: ants ignore the shelter signal, so plenty stay out in the storm
    // (sealed nest: the third of the ants spawned inside can never come out)
    const map = makeEnvMap({ sealed: true });
    const sim = new Simulation('meadow', map, { seed: 9, faction: 'gardenAnt', fixture: 'wander', fixtureAnts: 90 });
    const nav = sim.nav as NavEx;
    for (let i = 0; i < 60; i++) sim.step();
    sim.command({ type: 'debugWeather', kind: 'storm', intensity: 1 });
    const stunAt = new Map<number, number>();
    const everOut = new Set<number>();
    let hits = 0;
    let impacts = 0;
    let knocked = 0;
    const open = (x: number, y: number, z: number): boolean => nav.skyHeight(Math.floor(x), Math.floor(z)) <= Math.floor(y) + 1;
    for (let i = 0; i < 70 * 30; i++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.type === 'rainImpact') {
          impacts++;
          // on top of the column: nothing solid above the impact point
          expect(nav.skyHeight(Math.floor(e.pos.x), Math.floor(e.pos.z))).toBeLessThanOrEqual(e.pos.y);
          expect(e.pos.y - nav.skyHeight(Math.floor(e.pos.x), Math.floor(e.pos.z))).toBeLessThan(0.5);
        } else if (e.type === 'fell') knocked++;
      }
      for (const a of sim.ants) {
        if (open(a.pos.x, a.pos.y, a.pos.z) || open(a.prevPos.x, a.prevPos.y, a.prevPos.z)) everOut.add(a.id);
        const s = a.mem[STUN_KEY] ?? 0;
        if (s > (stunAt.get(a.id) ?? 0)) {
          stunAt.set(a.id, s);
          hits++;
          // the hit was applied at the start of the tick, where the ant stood then
          expect(open(a.prevPos.x, a.prevPos.y, a.prevPos.z)).toBe(true);
        }
      }
    }
    expect(impacts).toBeGreaterThan(300);
    expect(hits).toBeGreaterThan(10);
    void knocked;
    // ants that stayed under cover the whole time were never touched
    let sheltered = 0;
    for (const a of sim.ants) {
      if (everOut.has(a.id)) continue;
      sheltered++;
      expect(stunAt.has(a.id)).toBe(false);
      expect(a.health).toBe(a.maxHealth);
    }
    expect(sheltered).toBeGreaterThan(0);
    for (const a of sim.ants) expect(Number.isFinite(a.pos.x + a.pos.y + a.pos.z)).toBe(true);
  });

  it('washes out trails on exposed cells but not inside the nest', () => {
    const levels = (storm: boolean): { out: number; inside: number } => {
      const map = makeEnvMap({});
      const sim = new Simulation('meadow', map, { seed: 1, faction: 'gardenAnt', fixture: 'none' }, [weatherSystem, temperatureSystem, pheromoneSystem]);
      const nav = sim.nav as NavEx;
      const col = sim.colonies[0];
      const outCell = col.entrances[0];
      const inCell = col.nestCell;
      expect(nav.isExposed(outCell)).toBe(true);
      expect(nav.isExposed(inCell)).toBe(false);
      if (storm) sim.command({ type: 'debugWeather', kind: 'rain', intensity: 0.8 });
      for (let i = 0; i < 20 * 30; i++) sim.step(); // let the rain set in
      sim.pheromones.deposit(col.id, Phero.food, outCell, 8);
      sim.pheromones.deposit(col.id, Phero.food, inCell, 8);
      for (let i = 0; i < 20 * 30; i++) sim.step();
      return { out: sim.pheromones.sample(col.id, Phero.food, outCell), inside: sim.pheromones.sample(col.id, Phero.food, inCell) };
    };
    const dry = levels(false);
    const wet = levels(true);
    expect(dry.out).toBeGreaterThan(3);
    expect(wet.out).toBeLessThan(dry.out * 0.4);
    expect(wet.inside).toBeCloseTo(dry.inside, 5);
  });

  it('calls the foragers home (shelter signal) and lets them out again', () => {
    const sim = makeEnvSim({ seed: 4 });
    const nav = sim.nav as NavEx;
    const env = envOf(sim)!;
    const col = sim.colonies[0];
    const outside = (): number => sim.ants.filter((a) => a.cell >= 0 && nav.isExposed(a.cell)).length;
    let peakOut = 0;
    for (let i = 0; i < 100 * 30; i++) {
      sim.step();
      if (i % 30 === 0) peakOut = Math.max(peakOut, outside());
    }
    expect(peakOut).toBeGreaterThan(2);
    sim.command({ type: 'debugWeather', kind: 'rain', intensity: 0.8 });
    for (let i = 0; i < 45 * 30; i++) sim.step();
    expect(env.colonyState(col.id).shelter).toBe('rain');
    expect((sim.weather as WeatherStateEx).wetness).toBeGreaterThan(0.3);
    let out = 0;
    for (let i = 0; i < 30 * 30; i++) {
      sim.step();
      if (i % 30 === 0) out = Math.max(out, outside());
    }
    // (the odd one stands in the open throat of the entrance shaft, driven up by the run-off)
    expect(out).toBeLessThanOrEqual(2);
    expect(sim.ants.some((a) => a.behavior === 'seekShade')).toBe(true);
    const texts = sim.drainEvents().filter((e) => e.type === 'alert').map((e) => (e as { text: string }).text);
    expect(texts).toContain('Foragers are sheltering from the rain');
    envOf(sim)!.forceWeather('clear', 0, 600);
    let back = 0;
    for (let i = 0; i < 60 * 30; i++) {
      sim.step();
      if (i % 30 === 0) back = Math.max(back, outside());
    }
    expect(env.colonyState(col.id).shelter).toBe('none');
    expect(back).toBeGreaterThan(2);
  });
});
