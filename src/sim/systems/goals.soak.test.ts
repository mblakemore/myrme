import { describe, expect, it } from 'vitest';
import { ISO, b3StateOf, type MapId, type SpeciesId } from '../../core';
import { F_SCOUT } from '../behaviors/forageCore';
import type { Simulation } from '../Simulation';
import { makeSim } from '../testUtil';
import { runTimeline } from './goalsTestKit';

/**
 * B3 soaks (PLAN §11): every faction must live on its own for 10 sim-minutes on the meadow, the
 * farms for 20 with the keeper feeding them. Each prints a per-minute timeline (see
 * `runTimeline`), with a faction-specific tail column.
 */

function extra(sim: Simulation): string {
  const b3 = b3StateOf(sim);
  const parts: string[] = [];
  for (const g of b3.gardens) parts.push(`garden ${g.status} bio ${g.biomass.toFixed(0)} sub ${g.substrate.toFixed(0)} mould ${g.mould.toFixed(2)}`);
  for (const t of b3.termite) parts.push(`faces ${t.woodFaces.length} tubes ${t.tubes.map((x) => `${x.built}/${x.segments}`).join(',') || '-'} mound ${t.mound.stamps}`);
  const owned = b3.herds.filter((h) => h.owner === sim.playerColony);
  if (b3.herds.length) parts.push(`herds ${owned.length}/${b3.herds.length} aphids ${b3.herds.map((h) => h.aphids.length).join(',')}`);
  if (b3.keeper.enabled) parts.push(`keeper food ${b3.keeper.counts.dropFood} water ${b3.keeper.counts.dropWater} tap ${b3.keeper.counts.tapGlass} lamp ${b3.keeper.counts.lamp}`);
  parts.push(`${sim.weather.kind}@${sim.weather.timeOfDay.toFixed(2)}`);
  return parts.join(' | ');
}

/** Is the slab empty (no material across its thickness) at this height and just below? */
function bare(sim: Simulation, x: number, y: number): boolean {
  const w = sim.world;
  for (let dy = 0; dy >= -2; dy--)
    for (let z = 0; z < w.sz; z++) {
      const cy = Math.floor(y) + dy;
      if (!w.inBounds(Math.floor(x), cy, z) || w.density[w.index(Math.floor(x), cy, z)] >= ISO) return false;
    }
  return true;
}

/**
 * Fractions of the colony clinging to bare glass right now: [all ants, scouting foragers].
 * (Loaded foragers and trail followers legitimately cross the pane to food dropped high up or to
 * the tube port; scouts have no business there.)
 */
function onGlass(sim: Simulation): [number, number] {
  let n = 0;
  let scouts = 0;
  let all = 0;
  for (const a of sim.ants) {
    if (!a.alive || a.colony !== sim.playerColony) continue;
    all++;
    if (Math.abs(a.up.z) > 0.7 && bare(sim, a.pos.x, a.pos.y)) {
      n++;
      if (a.behavior === 'forage' && !a.carrying && a.tasks[0]?.phase === F_SCOUT) scouts++;
    }
  }
  return all > 0 ? [n / all, scouts / all] : [0, 0];
}

function soak(map: MapId, faction: SpeciesId, minutes: number, seed = 3) {
  const sim = makeSim(map, { seed, fixture: 'none', faction });
  const colony = sim.getColony(sim.playerColony)!;
  const start = colony.population.total || sim.ants.filter((a) => a.colony === colony.id).length;
  let glassSum = 0;
  let scoutSum = 0;
  let glassN = 0;
  let glassPeak = 0;
  const res = runTimeline(`${faction} on ${map}`, sim, minutes, extra, (s, t) => {
    if (s.map.flags.slab && t % 150 === 0 && t > 3000) {
      const [g, sc] = onGlass(s as Simulation);
      glassSum += g;
      scoutSum += sc;
      glassN++;
      if (g > glassPeak) glassPeak = g;
    }
  });
  const glass = glassN > 0 ? glassSum / glassN : 0;
  const glassScouts = glassN > 0 ? scoutSum / glassN : 0;
  if (sim.map.flags.slab) console.log(`    on bare glass: mean ${(glass * 100).toFixed(1)} % of the colony (peak ${(glassPeak * 100).toFixed(1)} %), scouts among them: mean ${(glassScouts * 100).toFixed(1)} %`);
  return { sim, colony, start, glass, glassScouts, glassPeak, ...res };
}

describe('B3 faction soaks — 10 sim-minutes on the meadow', () => {
  it('fire ants', () => {
    const r = soak('meadow', 'fireAnt', 10);
    expect(r.bad).toBe(0);
    expect(r.sim.getAnt(r.colony.queenId)?.alive).toBe(true);
    expect(r.colony.population.total).toBeGreaterThan(r.start);
    expect(r.colony.stats.foodDelivered).toBeGreaterThan(20);
    expect(r.wall).toBeLessThan(60);
  }, 120_000);

  it('leafcutters: garden established and feeding the colony', () => {
    const r = soak('meadow', 'leafcutter', 10);
    const g = b3StateOf(r.sim).gardens[0];
    expect(r.bad).toBe(0);
    expect(r.sim.getAnt(r.colony.queenId)?.alive).toBe(true);
    expect(g).toBeDefined();
    expect(g.status === 'healthy' || g.status === 'founding').toBe(true);
    expect(g.biomass).toBeGreaterThan(5);
    expect(r.colony.stats.foodDelivered).toBeGreaterThan(15); // all of it harvested fungus
    expect(r.colony.population.total).toBeGreaterThanOrEqual(r.start);
    expect(r.deaths['starvation'] ?? 0).toBeLessThanOrEqual(2);
    expect(r.wall).toBeLessThan(60);
  }, 120_000);

  it('termites: the population grows on wood alone', () => {
    const r = soak('meadow', 'termite', 10);
    expect(r.bad).toBe(0);
    expect(r.sim.getAnt(r.colony.queenId)?.alive).toBe(true);
    expect(r.sim.ants.some((a) => a.alive && a.caste === 'king')).toBe(true);
    expect(r.colony.population.total).toBeGreaterThan(r.start);
    expect(r.colony.stats.foodDelivered).toBeGreaterThan(20); // digested wood: termites have no forage duty
    expect(r.sim.ants.some((a) => a.behavior === 'forage')).toBe(false);
    expect(r.deaths['sun'] ?? 0).toBeLessThanOrEqual(3);
    expect(r.wall).toBeLessThan(60);
  }, 120_000);
});

describe('B3 farm soaks — 20 sim-minutes with the keeper', () => {
  for (const map of ['gelFarm', 'sandFarm'] as const)
    it(`${map}: garden ants survive on keeper drops; few ants on bare glass`, () => {
      const r = soak(map, 'gardenAnt', 20);
      const k = b3StateOf(r.sim).keeper;
      expect(r.bad).toBe(0);
      expect(r.sim.getAnt(r.colony.queenId)?.alive).toBe(true);
      expect(r.colony.population.total).toBeGreaterThanOrEqual(r.start);
      expect(k.counts.dropFood + k.counts.contaminatedFood).toBeGreaterThanOrEqual(5);
      expect(r.glassScouts).toBeLessThan(0.08);
      expect(r.glass).toBeLessThan(0.25);
      expect(r.wall).toBeLessThan(60);
    }, 120_000);
});

describe('B3 determinism', () => {
  for (const [map, faction] of [
    ['meadow', 'termite'],
    ['meadow', 'leafcutter'],
    ['meadow', 'fireAnt'],
    ['sandFarm', 'gardenAnt'],
  ] as const)
    it(`${faction} on ${map}: same seed → same stateHash`, () => {
      const hashes: string[][] = [[], []];
      for (let k = 0; k < 2; k++) {
        const sim = makeSim(map, { seed: 5, fixture: 'none', faction });
        for (let t = 1; t <= 2700; t++) {
          sim.step();
          sim.drainEvents();
          if (t % 900 === 0) hashes[k].push(String(sim.stateHash()));
        }
      }
      expect(hashes[0]).toEqual(hashes[1]);
    }, 120_000);
});
