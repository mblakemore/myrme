import { describe, expect, it } from 'vitest';
import { b3StateOf, v3 } from '../../core';
import { deliverFood } from '../behaviors/util';
import type { Simulation } from '../Simulation';
import { GROUND, makeB3Sim } from './goalsTestKit';

function leafSim(seed = 3): Simulation {
  const sim = makeB3Sim({ faction: 'leafcutter', seed, size: 64 });
  sim.spawnFood('leaves', 300, v3(52, GROUND + 0.5, 38), 0.05);
  return sim;
}

function run(sim: Simulation, ticks: number, each?: (t: number) => boolean | void): { types: string[]; alerts: string[] } {
  const types: string[] = [];
  const alerts: string[] = [];
  for (let t = 0; t < ticks; t++) {
    sim.step();
    for (const e of sim.drainEvents()) {
      const ev = e as { type: string; op?: string };
      types.push(ev.op && ev.type === 'garden' ? `garden:${ev.op}` : ev.type);
      if (e.type === 'alert') alerts.push(e.code);
    }
    if (each?.(t)) break;
  }
  return { types, alerts };
}

describe('leafcutters', () => {
  it('start with minims and media, and run the chain leaf → substrate → fungus → food', () => {
    const sim = leafSim();
    const colony = sim.getColony(1)!;
    expect(sim.ants.some((a) => a.caste === 'major')).toBe(true);
    expect(sim.ants.some((a) => a.caste === 'worker')).toBe(true);
    const src = sim.foodSources.find((f) => f.foodKind === 'leaves')!;
    const food0 = colony.stats.foodDelivered;
    let leavesPeak = 0;
    let substratePeak = 0;
    let cutters = 0;
    let gardeners = 0;
    let leafCarried = false;
    const { types } = run(sim, 240 * 30, () => {
      leavesPeak = Math.max(leavesPeak, colony.stores.leaves);
      const g = b3StateOf(sim).gardens[0];
      if (g) substratePeak = Math.max(substratePeak, g.substrate);
      for (const a of sim.ants) {
        if (a.behavior === 'harvestLeaves') cutters++;
        if (a.behavior === 'tendGarden') gardeners++;
        if (a.carrying?.itemKind === 'leaf') leafCarried = true;
      }
    });
    const g = b3StateOf(sim).gardens[0];
    expect(g).toBeDefined();
    expect(colony.chambers.some((c) => c.kind === 'fungusGarden')).toBe(true);
    expect(types).toContain('garden:founded');
    expect(types).toContain('leafCut');
    expect(leafCarried).toBe(true);
    expect(src.amount).toBeLessThan(295); // leaves were cut…
    expect(leavesPeak).toBeGreaterThan(2); // …delivered as leaf matter…
    expect(types).toContain('garden:fed');
    expect(substratePeak).toBeGreaterThan(2); // …bedded in the garden…
    expect(g.biomass).toBeGreaterThan(8); // …grown into fungus…
    expect(types).toContain('garden:harvest');
    expect(colony.stats.foodDelivered).toBeGreaterThan(food0 + 5); // …and harvested as food
    expect(cutters).toBeGreaterThan(0);
    expect(gardeners).toBeGreaterThan(0);
    // castes keep to their trade: only media / majors cut, the standing crop is tended by minims
    expect(sim.ants.some((a) => a.behavior === 'forage')).toBe(false);
  });

  it('cannot eat forage directly: delivered food becomes leaf substrate, not food', () => {
    const sim = leafSim();
    const colony = sim.getColony(1)!;
    const ant = sim.ants.find((a) => a.caste === 'major')!;
    const food = colony.stores.food;
    const leaves = colony.stores.leaves;
    deliverFood(sim, colony, ant, 4);
    expect(colony.stores.food).toBe(food);
    expect(colony.stores.leaves).toBeGreaterThan(leaves);
    // a garden ant with the same call does get food
    const other = makeB3Sim({ faction: 'gardenAnt', seed: 3 });
    const oc = other.getColony(1)!;
    const f0 = oc.stores.food;
    deliverFood(other, oc, other.ants[1], 4);
    expect(oc.stores.food).toBe(f0 + 4);
  });

  it('a neglected garden moulds, sickens (alert) and finally collapses (famine alert); nothing to eat without it', () => {
    const sim = leafSim(5);
    const colony = sim.getColony(1)!;
    run(sim, 3 * 30);
    run(sim, 60, () => b3StateOf(sim).gardens.length > 0);
    const g = b3StateOf(sim).gardens[0];
    expect(g.mould).toBe(0);
    // no gardeners left
    for (const a of sim.ants) if (a.caste !== 'queen') sim.command({ type: 'debugKill', id: a.id });
    const { types, alerts } = run(sim, 600 * 30, () => g.status === 'collapsed');
    expect(types).toContain('garden:mould');
    expect(alerts).toContain('gardenSick');
    expect(g.status).toBe('collapsed');
    expect(types).toContain('garden:collapsed');
    expect(alerts).toContain('starving');
    expect(g.biomass).toBe(0);
    void colony;
  });

  it('overloading the comb with leaves grows mould even while tended; gardeners weed it back', () => {
    const sim = leafSim(6);
    run(sim, 120, () => b3StateOf(sim).gardens.length > 0);
    const g = b3StateOf(sim).gardens[0];
    g.substrate = 60;
    g.tendedTick = sim.tick;
    const colony = sim.getColony(1)!;
    colony.stores.leaves = 0;
    let peak = 0;
    run(sim, 40 * 30, () => {
      g.substrate = 60; // keep it overloaded
      peak = Math.max(peak, g.mould);
    });
    expect(peak).toBeGreaterThan(0.02);
    // back to a sane load, with a visible infection: the minims clear it
    g.substrate = 5;
    g.mould = 0.3;
    const { types } = run(sim, 120 * 30, () => g.mould < 0.02);
    expect(g.mould).toBeLessThan(0.02);
    expect(types).toContain('garden:weeded');
    expect(g.status).not.toBe('collapsed');
  });
});
