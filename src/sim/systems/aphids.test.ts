import { describe, expect, it } from 'vitest';
import { CREATURE_MEM, b3StateOf, v3 } from '../../core';
import { BALANCE } from '../data/balance';
import type { Simulation } from '../Simulation';
import { addAphidHerd } from './aphids';
import { GROUND, makeB3Sim } from './goalsTestKit';

function run(sim: Simulation, ticks: number, each?: (t: number) => boolean | void): string[] {
  const types: string[] = [];
  for (let t = 0; t < ticks; t++) {
    sim.step();
    for (const e of sim.drainEvents()) {
      const ev = e as { type: string; op?: string };
      types.push(ev.type === 'aphid' ? `aphid:${ev.op}` : ev.type);
    }
    if (each?.(t)) break;
  }
  return types;
}

describe('aphid herding', () => {
  it('a herd is discovered, tended and milked: honeydew comes home as food and the herd grows', () => {
    const sim = makeB3Sim({ faction: 'gardenAnt', seed: 2, size: 64 });
    const colony = sim.getColony(1)!;
    const e = sim.world.cellCenter(colony.entrances[0], v3());
    const herd = addAphidHerd(sim, v3(e.x + 6, GROUND + 0.5, e.z + 3), v3(e.x + 9, GROUND + 0.5, e.z + 3), 3);
    run(sim, 30);
    const A = BALANCE.b3.aphids;
    expect(herd.aphids.length).toBe(A.startHerd);
    expect(herd.owner).toBe(0);
    const aphid = sim.getEntity(herd.aphids[0])!;
    expect(aphid.kind === 'creature' && aphid.def === 'aphid' && aphid.mem[CREATURE_MEM.prey] === 1).toBe(true);
    const src = sim.getEntity(herd.sourceId)!;
    expect(src.kind === 'food' && src.foodKind === 'honeydew').toBe(true);
    const food0 = colony.stats.foodDelivered;
    let shepherds = 0;
    let tended = false;
    const types = run(sim, 300 * 30, () => {
      for (const a of sim.ants) if (a.behavior === 'herdAphids') shepherds++;
      if (herd.tended) tended = true;
    });
    expect(types).toContain('aphid:discovered');
    expect(herd.owner).toBe(1);
    expect((sim.getEntity(herd.aphids[0]) as { colony: number }).colony).toBe(1);
    expect(shepherds).toBeGreaterThan(0);
    expect(tended).toBe(true);
    expect(types).toContain('aphid:milked');
    expect(types).toContain('aphid:born');
    expect(herd.aphids.length).toBeGreaterThan(A.startHerd);
    expect(colony.stats.foodDelivered).toBeGreaterThan(food0 + 2);
    expect(b3StateOf(sim).herds).toContain(herd);
  });

  it('a wild herd secretes and breeds more slowly than a tended one; a herd with no aphids left is lost', () => {
    const sim = makeB3Sim({ faction: 'gardenAnt', seed: 2, size: 64, sealed: true });
    const herd = addAphidHerd(sim, v3(50, GROUND + 0.5, 20), v3(53, GROUND + 0.5, 20), 3);
    const types = run(sim, 300 * 30);
    const A = BALANCE.b3.aphids;
    expect(herd.owner).toBe(0);
    expect(herd.tended).toBe(false);
    expect(herd.honeydewRate).toBeCloseTo(herd.aphids.length * A.honeydew, 5);
    expect(herd.aphids.length).toBeLessThanOrEqual(A.startHerd + 3);
    expect(types).not.toContain('aphid:milked');
    for (const id of herd.aphids) sim.command({ type: 'debugKill', id });
    const t2 = run(sim, 90);
    expect(t2).toContain('aphid:lost');
    expect(herd.aphids.length).toBe(0);
    expect(herd.honeydewRate).toBe(0);
  });

  it('species without the flag never shepherd', () => {
    const sim = makeB3Sim({ faction: 'fireAnt', seed: 2, size: 64 });
    const colony = sim.getColony(1)!;
    const e = sim.world.cellCenter(colony.entrances[0], v3());
    const herd = addAphidHerd(sim, v3(e.x + 6, GROUND + 0.5, e.z + 3), v3(e.x + 9, GROUND + 0.5, e.z + 3), 3);
    let shepherds = 0;
    run(sim, 120 * 30, () => {
      for (const a of sim.ants) if (a.behavior === 'herdAphids') shepherds++;
    });
    expect(shepherds).toBe(0);
    expect(herd.owner).toBe(0);
  });
  it('final round: a herd its owner never visits is adopted by the next colony that finds it; the crew grows with the herd — no orders', () => {
    const sim = makeB3Sim({ faction: 'gardenAnt', seed: 2, size: 64 });
    const colony = sim.getColony(1)!;
    const e = sim.world.cellCenter(colony.entrances[0], v3());
    const herd = addAphidHerd(sim, v3(e.x + 6, GROUND + 0.5, e.z + 3), v3(e.x + 9, GROUND + 0.5, e.z + 3), 3);
    // a rival scout "found" it first (as happens when it wanders past the player's door)
    const rival = sim.createColony('gardenAnt', 'ai', v3(6, GROUND + 1, 6));
    run(sim, 30);
    herd.owner = rival.id;
    const A = BALANCE.b3.aphids;
    let shepherds = 0;
    let maxCrew = 0;
    const food0 = colony.stats.foodDelivered;
    const types = run(sim, (A.abandonAfter + 420) * 30, () => {
      let n = 0;
      for (const a of sim.ants) if (a.colony === 1 && a.behavior === 'herdAphids') n++;
      shepherds += n;
      if (n > maxCrew) maxCrew = n;
    });
    expect(herd.owner).toBe(1);
    expect(types).toContain('aphid:discovered');
    expect(types).toContain('aphid:milked');
    expect(shepherds).toBeGreaterThan(0);
    expect(herd.aphids.length).toBeGreaterThanOrEqual(A.aphidsPerSlot);
    expect(maxCrew).toBeGreaterThan(A.slots); // more than the base crew once the herd has grown
    expect(maxCrew).toBeLessThanOrEqual(A.slotsMax + 2); // + shepherds on their way home with a crop
    expect(colony.stats.foodDelivered).toBeGreaterThan(food0 + 2);
  });
});
