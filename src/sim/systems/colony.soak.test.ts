import { describe, expect, it } from 'vitest';
import { Phero, v3isFinite, type MapId } from '../../core';
import type { Simulation } from '../Simulation';
import { makeSim } from '../testUtil';
import { colonyCapacity } from './colony';
import { chamberOf, inChamber } from './colonyState';
import { makeColonySim } from './colonyTestWorld';

/**
 * Colony soaks (PLAN §11, §15 A2b): the colony must live on its own for 10 sim-minutes.
 * Each prints a compact timeline — one row per sim-minute:
 *   min | pop (workers/soldiers) | food | brood e/l/p | dug voxels | foragers | trail cells | corpses(in midden)
 */
const MINUTES = 10;
const TICKS_PER_MIN = 1800;

interface Row {
  min: number;
  pop: number;
  food: number;
  brood: number;
  dug: number;
  trail: number;
}

function soak(name: string, sim: Simulation, minutes = MINUTES) {
  const colony = sim.getColony(sim.playerColony)!;
  const rows: Row[] = [];
  const lines: string[] = [];
  let bad = 0;
  let deaths = 0;
  let born = 0;
  let trailPeak = 0;
  let trailMid = 0;
  let middenPeak = 0;
  const causes: Record<string, number> = {};
  const alerts = new Set<string>();
  const t0 = performance.now();
  for (let t = 1; t <= minutes * TICKS_PER_MIN; t++) {
    // two workers die early so necrophoresis has something to do regardless of old age
    if (t === 2 * TICKS_PER_MIN) for (const a of sim.ants.filter((x) => x.caste === 'worker').slice(0, 2)) sim.command({ type: 'debugKill', id: a.id });
    sim.step();
    if (t % 30 === 0) {
      for (const a of sim.ants) if (!v3isFinite(a.pos) || !v3isFinite(a.up) || !v3isFinite(a.forward) || !Number.isFinite(a.energy) || !Number.isFinite(a.health)) bad++;
      if (!Number.isFinite(colony.stores.food)) bad++;
      const trail = sim.pheromones.activeCount(colony.id, Phero.food);
      if (trail > trailPeak) trailPeak = trail;
      if (t >= 2 * TICKS_PER_MIN && t <= 8 * TICKS_PER_MIN && trail > trailMid) trailMid = trail;
      const midden = chamberOf(colony, 'midden');
      const inMidden = sim.items.filter((i) => i.itemKind === 'corpse' && !i.carriedBy && inChamber(midden, i.pos, 0.5)).length;
      if (inMidden > middenPeak) middenPeak = inMidden;
    }
    for (const e of sim.drainEvents()) {
      if (e.type === 'antDied') {
        deaths++;
        causes[e.cause] = (causes[e.cause] ?? 0) + 1;
      } else if (e.type === 'broodStage' && e.stage === 'adult') born++;
      else if (e.type === 'alert') alerts.add(e.text);
    }
    if (t % TICKS_PER_MIN === 0) {
      const p = colony.population;
      const midden = chamberOf(colony, 'midden');
      const corpses = sim.items.filter((i) => i.itemKind === 'corpse');
      const inMidden = corpses.filter((i) => inChamber(midden, i.pos, 0.5)).length;
      const foragers = sim.ants.filter((a) => a.behavior === 'forage').length;
      const trail = sim.pheromones.activeCount(colony.id, Phero.food);
      rows.push({ min: t / TICKS_PER_MIN, pop: p.total, food: colony.stores.food, brood: p.eggs + p.larvae + p.pupae, dug: colony.stats.dugVoxels, trail });
      lines.push(
        `${String(t / TICKS_PER_MIN).padStart(3)} | pop ${String(p.total).padStart(3)} (w${p.byCaste.worker ?? 0}/s${p.byCaste.soldier ?? 0}) | food ${colony.stores.food.toFixed(0).padStart(4)} | brood ${p.eggs}/${p.larvae}/${p.pupae} | dug ${String(colony.stats.dugVoxels).padStart(4)} | forg ${String(foragers).padStart(2)} | trail ${String(trail).padStart(4)} | corpses ${corpses.length}(${inMidden})`,
      );
    }
  }
  const wall = (performance.now() - t0) / 1000;
  const cap = colonyCapacity(sim, colony.id);
  console.log(
    `[colony soak] ${name}: ${wall.toFixed(1)} s wall, ${((wall * 1000) / (minutes * TICKS_PER_MIN)).toFixed(2)} ms/tick\n` +
      lines.join('\n') +
      `\n    behaviors ${JSON.stringify(sim.ants.reduce((m: Record<string, number>, a) => ((m[a.behavior] = (m[a.behavior] ?? 0) + 1), m), {}))}, sources ${sim.foodSources.map((f) => f.foodKind + ':' + f.amount.toFixed(0)).join(' ')}` +
      `\n    born ${born}, deaths ${deaths} ${JSON.stringify(causes)}, delivered ${colony.stats.foodDelivered.toFixed(0)}, chambers ${colony.chambers.map((c) => c.kind).join(',')}, cap ${cap.popCap}, finds scout:${cap.scoutFinds} trail:${cap.trailFinds} (follows ${cap.trailFollows}), deliveries ${cap.deliveries}, alerts ${JSON.stringify([...alerts])}`,
  );
  return { rows, bad, deaths, born, causes, trailPeak, trailMid, middenPeak, colony, wall, sim, cap };
}

describe('colony soak: synthetic world', () => {
  it('lives, grows, lays trails, hauls its dead and digs on its own for 10 sim-minutes', () => {
    const r = soak('synthetic', makeColonySim({ seed: 11 }));
    const last = r.rows[r.rows.length - 1];
    expect(r.bad).toBe(0);
    expect(r.sim.getAnt(r.colony.queenId)).toBeDefined();
    expect(last.pop).toBeGreaterThanOrEqual(40); // grew from 11
    expect(last.pop).toBeLessThan(160); // …without exploding
    expect(r.causes['starvation'] ?? 0).toBeLessThanOrEqual(2);
    expect(r.colony.stats.foodDelivered).toBeGreaterThan(60);
    expect(r.trailMid).toBeGreaterThan(15); // a real trail existed mid-run
    expect(r.middenPeak).toBeGreaterThan(0); // corpses ended up in the midden
    expect(last.dug).toBeGreaterThan(100); // the nest grew without the player
    expect(r.colony.chambers.length).toBeGreaterThan(5);
    expect(r.wall).toBeLessThan(60);
  });

  it('is deterministic: same seed ⇒ same stateHash, different seed ⇒ different', () => {
    const run = (seed: number) => {
      const sim = makeColonySim({ seed });
      const hashes: string[] = [];
      for (let t = 1; t <= 3600; t++) {
        sim.step();
        if (t % 600 === 0) hashes.push(sim.stateHash());
      }
      return hashes;
    };
    const a = run(5);
    expect(run(5)).toEqual(a);
    expect(run(6)[5]).not.toBe(a[5]);
  });
});

// all six maps: the farms and the other biomes each broke in their own way once (e.g. the sand farm's
// first expansion dug out the nest anchor and blanked the home field)
describe.each(['meadow', 'gelFarm', 'forest', 'desert', 'sandFarm', 'formicarium'] as const)('colony soak: %s', (mapId: MapId) => {
  it('survives 10 sim-minutes on the real map', () => {
    const sim = makeSim(mapId, { seed: 3, fixture: 'none' });
    const r = soak(mapId, sim);
    const last = r.rows[r.rows.length - 1];
    expect(r.bad).toBe(0);
    expect(r.sim.getAnt(r.colony.queenId)).toBeDefined(); // the queen lives
    expect(last.pop).toBeGreaterThanOrEqual(mapId === 'meadow' ? 40 : mapId === 'gelFarm' ? 12 : 25);
    expect(r.sim.nav.isWalkable(r.colony.nestCell)).toBe(true); // the home anchor survived the digging
    expect(last.pop).toBeLessThan(200);
    if (mapId === 'meadow') {
      expect(r.trailMid).toBeGreaterThan(15);
      expect(last.dug).toBeGreaterThan(0);
    }
    expect(r.wall).toBeLessThan(60);
  });
});
