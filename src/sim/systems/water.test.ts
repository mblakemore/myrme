import { describe, expect, it } from 'vitest';
import { DENSITY_PER_VOXEL, ISO, Mat, NO_DROWN_KEY, envOf, waterEx, weatherEx, type NavEx, type SimEvent } from '../../core';
import { BALANCE } from '../data/balance';
import { Simulation } from '../Simulation';
import { catchmentOf } from './water';
import { makeEnvMap, makeEnvSim } from './weatherTestWorld';

const S = 48;
const G = 20;
const B = BALANCE.b2;

function collect(sim: Simulation, into: SimEvent[]): void {
  for (const e of sim.drainEvents()) into.push(e);
}

describe('nest flooding', () => {
  it('floodEscape moves the brood and the queen above the water; the nest drains and recovers', () => {
    const sim = makeEnvSim({ seed: 3, rainChance: 0 });
    const env = envOf(sim)!;
    const col = sim.colonies[0];
    for (let i = 0; i < 30 * 40; i++) sim.step();
    sim.drainEvents();
    const floorY = Math.min(...sim.brood.map((b) => b.pos.y));
    expect(sim.brood.length).toBeGreaterThan(4);
    expect(floorY).toBeLessThan(col.nestPos.y + 1.5);
    const events: SimEvent[] = [];
    // a pipe bursts into the queen's chamber: 180 voxels over a minute
    let sawEscape = false;
    for (let i = 0; i < 30 * 60; i++) {
      if (i % 10 === 0) env.addWater(col.nestPos, 1);
      sim.step();
      if (i % 30 === 0) {
        collect(sim, events);
        if (sim.ants.some((a) => a.behavior === 'floodEscape')) sawEscape = true;
      }
    }
    collect(sim, events);
    const cs = env.colonyState(col.id);
    const sxz = S * S;
    expect(cs.flooded).toBe(true);
    expect(cs.nestWater).toBeGreaterThanOrEqual(B.floodCells);
    expect(cs.waterTop).toBeGreaterThan(col.nestPos.y);
    expect(cs.refugeCell).toBeGreaterThanOrEqual(0);
    expect(Math.floor(cs.refugeCell / sxz)).toBeGreaterThan(cs.waterTop + B.broodMargin);
    expect(sim.water.depthAt(cs.refugeCell)).toBe(0);
    const refuge = cs.refugeCell;
    expect(col.chambers.some((c) => c.kind === 'nursery' && c.cell === refuge)).toBe(true); // the emergency nursery
    expect(sawEscape).toBe(true);
    expect(events.some((e) => e.type === 'flood' && e.rising)).toBe(true);
    const alerts = events.filter((e) => e.type === 'alert').map((e) => (e as { text: string }).text);
    expect(alerts.some((t) => t.startsWith('The nest is flooding'))).toBe(true);
    // the brood was carried up: none left in or just above the water
    expect(cs.threatenedBrood.length).toBe(0);
    expect(sim.brood.length).toBeGreaterThan(4);
    for (const b of sim.brood) if (!b.carriedBy) expect(b.pos.y).toBeGreaterThan(cs.waterTop + 0.5);
    expect(Math.min(...sim.brood.map((b) => b.pos.y))).toBeGreaterThan(floorY + 1.5);
    // the queen kept her feet dry and nobody drowned
    const queen = sim.ants.find((a) => a.caste === 'queen')!;
    expect(queen.alive).toBe(true);
    expect(queen.submerged).toBe(0);
    expect(events.filter((e) => e.type === 'antDied' && e.cause === 'drowning').length).toBe(0);
    expect(events.filter((e) => e.type === 'broodStage' && e.stage === 'dead').length).toBeLessThanOrEqual(4);
    // the soil soaks it up; the colony goes back to normal
    for (let i = 0; i < 30 * 200; i++) sim.step();
    collect(sim, events);
    expect(waterEx(sim.water).totalVolume()).toBeLessThan(1);
    expect(events.some((e) => e.type === 'flood' && !e.rising)).toBe(true);
    expect(cs.flooded).toBe(false);
    expect(cs.refugeCell).toBe(-1);
    expect(col.chambers.some((c) => c.cell === refuge)).toBe(false);
    expect(sim.ants.some((a) => a.behavior === 'floodEscape')).toBe(false);
    expect(queen.alive).toBe(true);
  });

  it('adults swim for swimSeconds then drown; brood drowns faster; NO_DROWN ants are spared', () => {
    // sealed rock nest: nowhere to go, nothing drains
    const sim = makeEnvSim({ seed: 4, rainChance: 0, sealed: true, material: Mat.Rock });
    const env = envOf(sim)!;
    const col = sim.colonies[0];
    for (let i = 0; i < 60; i++) sim.step();
    const spared = sim.ants.find((a) => a.caste === 'worker')!;
    spared.mem[NO_DROWN_KEY] = 1;
    for (let i = 0; i < 6; i++) sim.spawnBrood(col.id, 'worker', { x: col.nestPos.x + i * 0.5 - 1.5, y: col.nestPos.y, z: col.nestPos.z + 1 });
    const workers = sim.ants.filter((a) => a.caste === 'worker' && a !== spared).length;
    // fill the whole cavity at once
    let poured = 0;
    for (let i = 0; i < 80 && poured < 420; i++) poured += env.addWater(col.nestPos, 8);
    expect(poured).toBeGreaterThan(250);
    const start = sim.tick;
    const initial = new Set(sim.brood.map((b) => b.id));
    let firstBrood = -1;
    let lastBrood = -1;
    let firstAnt = -1;
    const causes = new Set<string>();
    let drowned = 0;
    for (let i = 0; i < 30 * 45; i++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        if (e.type === 'broodStage' && e.stage === 'dead' && initial.delete(e.id)) {
          if (firstBrood < 0) firstBrood = e.tick - start;
          lastBrood = e.tick - start;
        } else if (e.type === 'antDied') {
          causes.add(e.cause);
          drowned++;
          if (firstAnt < 0) firstAnt = e.tick - start;
        }
      }
    }
    // brood: gone after broodDrownSeconds (give the water a few seconds to settle over them)
    expect(firstBrood).toBeGreaterThan(B.broodDrownSeconds * 30 - 15);
    expect(lastBrood).toBeLessThan((B.broodDrownSeconds + 12) * 30);
    expect(initial.size).toBe(0);
    // adults last longer than brood, at least their swim time
    expect(firstAnt).toBeGreaterThan(B.swimSeconds * 30);
    expect(firstAnt).toBeGreaterThan(firstBrood);
    expect([...causes]).toEqual(['drowning']);
    expect(drowned).toBeGreaterThanOrEqual(workers - 1);
    expect(spared.alive).toBe(true);
    expect(spared.health).toBe(spared.maxHealth);
  });

  it('an ant that climbs out of a puddle recovers its breath', () => {
    const map = makeEnvMap({ rainChance: 0 });
    // a rock-lined pool in the open
    const w = map.world;
    for (let z = 6; z <= 15; z++)
      for (let x = 6; x <= 15; x++)
        for (let y = G - 4; y < G; y++) {
          const inside = x >= 8 && x <= 13 && z >= 8 && z <= 13 && y >= G - 2;
          w.setCell(x, y, z, inside ? -1 : 1, Mat.Rock);
        }
    w.markAllDirty();
    const sim = new Simulation('meadow', map, { seed: 2, faction: 'gardenAnt', fixture: 'none' });
    const env = envOf(sim)!;
    for (let i = 0; i < 40; i++) env.addWater({ x: 10.5, y: G - 1.5, z: 10.5 }, 2);
    for (let i = 0; i < 90; i++) sim.step();
    expect(sim.water.isFlooded(w.index(10, G - 2, 10))).toBe(true);
    expect(waterEx(sim.water).surfaceAbove(w.index(10, G - 2, 10))).toBeGreaterThan(G - 1.2);
    const a = sim.spawnAnt(sim.playerColony, 'worker', { x: 10.5, y: G - 1.5, z: 10.5 });
    let maxSub = 0;
    let swam = false;
    for (let i = 0; i < 30 * 20; i++) {
      sim.step();
      maxSub = Math.max(maxSub, a.submerged);
      if (a.behavior === 'floodEscape') swam = true;
    }
    expect(swam).toBe(true);
    expect(maxSub).toBeGreaterThan(5);
    expect(maxSub).toBeLessThan(B.swimSeconds * 30);
    expect(a.alive).toBe(true);
    expect(a.health).toBe(a.maxHealth);
    expect(a.submerged).toBe(0);
    expect(sim.water.depthAt(a.cell)).toBeLessThanOrEqual(B.escapeDepth);
    // food dropped in the pool floats on the surface instead of sinking
    const it = sim.spawnItem('food', 1, { x: 11.5, y: G - 1.6, z: 11.5 });
    for (let i = 0; i < 90; i++) sim.step();
    const level = waterEx(sim.water).surfaceAbove(w.index(11, G - 2, 11));
    if (it.alive && !it.carriedBy) expect(Math.abs(it.pos.y - level)).toBeLessThan(0.4);
  });
});

describe('rain inflow', () => {
  it('rain runs into an open entrance; a mound around the mouth keeps it out', () => {
    const run = (mound: boolean): { added: number; catchment: number } => {
      const map = makeEnvMap({ rainChance: 0 });
      if (mound) {
        // a raised rim around the mouth (the spoil cone a colony builds): 2 voxels high, 3..6 away
        const w = map.world;
        const e = map.spawns[0].entrance!;
        for (let z = 0; z < S; z++)
          for (let x = 0; x < S; x++) {
            const d = Math.hypot(x + 0.5 - e.x, z + 0.5 - e.z);
            if (d < 3 || d > 6.5) continue;
            for (let y = G; y < G + 2; y++) {
              const cur = (w.density[w.index(x, y, z)] - ISO) / DENSITY_PER_VOXEL;
              if (cur < 0.5) w.setCell(x, y, z, 1, Mat.Soil);
            }
          }
        w.markAllDirty();
      }
      const sim = new Simulation('meadow', map, { seed: 6, faction: 'gardenAnt', fixture: 'none' });
      const col = sim.colonies[0];
      const catchment = Math.max(...catchmentOf(sim, col));
      sim.command({ type: 'debugWeather', kind: 'rain', intensity: 1 });
      for (let i = 0; i < 30 * 60; i++) sim.step();
      sim.drainEvents();
      expect(weatherEx(sim.weather).rain).toBeGreaterThan(0.8);
      return { added: waterEx(sim.water).totalAdded, catchment };
    };
    const open = run(false);
    const ringed = run(true);
    expect(open.catchment).toBeGreaterThan(0.3);
    expect(open.added).toBeGreaterThan(10);
    expect(ringed.catchment).toBeLessThan(open.catchment * 0.5);
    expect(ringed.added).toBeLessThan(open.added * 0.5);
  });

  it('puddles collect in hollows during rain, slow waders, and dry up afterwards', () => {
    const map = makeEnvMap({ rainChance: 0, sealed: true });
    // a clay-lined hollow 2 deep in the open
    const w = map.world;
    for (let z = 26; z <= 34; z++)
      for (let x = 2; x <= 10; x++) {
        const d = Math.hypot(x - 6, z - 30);
        for (let y = G - 3; y < G; y++) w.setCell(x, y, z, d < 3.2 && y >= G - 2 ? -1 : 1, Mat.Clay);
      }
    w.markAllDirty();
    const sim = new Simulation('meadow', map, { seed: 7, faction: 'gardenAnt', fixture: 'none' });
    const nav = sim.nav as NavEx;
    const water = waterEx(sim.water);
    const bottom = w.index(6, G - 2, 30);
    expect(nav.isExposed(bottom)).toBe(true);
    sim.command({ type: 'debugWeather', kind: 'storm', intensity: 1 });
    for (let i = 0; i < 30 * 120; i++) sim.step();
    expect(sim.water.depthAt(bottom)).toBeGreaterThan(0.5);
    expect(water.surfaceAbove(bottom)).toBeLessThanOrEqual(G + 0.01); // never above its rim
    let surfaces = 0;
    water.forEachSurface(() => surfaces++);
    expect(surfaces).toBeGreaterThan(5);
    expect(water.totalAdded - water.totalDrained).toBeCloseTo(water.totalVolume(), 4);
    // clear, hot weather: it evaporates
    envOf(sim)!.forceWeather('heat', 1, 5000);
    for (let i = 0; i < 30 * 420 && sim.water.floodedCount > 0; i++) sim.step();
    expect(sim.water.floodedCount).toBe(0);
    sim.drainEvents();
  });
});
