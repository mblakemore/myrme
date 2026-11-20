import { Mat, Phero, asSimEvent, v3clone, type Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste, getSpecies } from '../data/species';
import { chamberOf, dutyTask, nearestChamber } from '../systems/colonyState';
import { getJob } from '../systems/jobsBoard';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach, deliverCarriedFood, homeward, stop } from './util';

/**
 * Leaf cutting (`harvestLeaves` jobs — leafcutter media). Duty task kind `wait` (unused by any
 * other duty), `task.phase`:
 *   0 walk to the leaf source (the job's standing cell)
 *   1 cut: `bite` animation for `cutTime`, then a leaf fragment up to the carry capacity is taken
 *   2 carry it home, laying `food` trail pheromone (the leaf parade follows it back out), and
 *     drop it in the garden chamber → `stores.leaves`
 * The fragment is a bulk `leaf` carry (render: a leaf sail above the ant).
 */
export const harvestLeavesBehavior: Behavior = {
  id: 'harvestLeaves',
  band: 'duty',
  score(ant, sim) {
    if (!getSpecies(ant.species).caps.farmsFungus) return 0;
    const t = dutyTask(ant);
    // a loaded cutter always finishes its delivery
    if (!t && ant.carrying?.kind === 'bulk' && ant.carrying.itemKind === 'leaf') return BALANCE.a2b.commitScore;
    return dutyScore(sim, ant, 'wait', 'harvestLeaves', 'nj.leaf');
  },
  run(ant, sim, dt) {
    const L = BALANCE.b3.leafcutters;
    const colony = sim.getColony(ant.colony);
    if (!colony) return;
    let t = dutyTask(ant);
    const loaded = ant.carrying?.kind === 'bulk' && ant.carrying.itemKind === 'leaf';
    if (!t && !loaded) t = takeJob(sim, ant, 'wait', 'harvestLeaves', 'nj.leaf') ?? undefined;
    if (t && t.kind !== 'wait') return;
    if (loaded) {
      // homeward with the load
      ant.anim = 'carry';
      if (ant.cell >= 0 && ant.cell !== ant.mem['hl.lc']) {
        ant.mem['hl.lc'] = ant.cell;
        sim.pheromones.deposit(colony.id, Phero.food, ant.cell, L.trailDeposit);
      }
      const store = colony.chambers.find((c) => c.kind === 'fungusGarden') ?? nearestChamber(colony, 'granary', ant.pos) ?? chamberOf(colony, 'queen');
      const d = Math.hypot(store.pos.x - ant.pos.x, store.pos.y - ant.pos.y, store.pos.z - ant.pos.z);
      if (!ant.mem['hl.go'] && (d < 8 || !homeward(sim, ant, 0.9))) ant.mem['hl.go'] = 1;
      if (ant.mem['hl.go']) {
        const r = approach(sim, ant, store.cell, store.pos, 1.8, 0.9);
        if (r === ARRIVED || (r === FAILED && d < 5)) {
          deliverCarriedFood(sim, colony, ant);
          ant.mem['hl.go'] = 0;
          if (t) finishDuty(sim, ant, t);
          else ant.thinkAt = sim.tick;
        } else if (r === FAILED) ant.mem['hl.go'] = 0;
      }
      return;
    }
    if (!t) return;
    const job = getJob(sim, ant, t.jobId);
    const src = sim.getEntity(t.targetId);
    if (!job || !src || src.kind !== 'food' || src.amount < 0.5) {
      finishDuty(sim, ant, t);
      return;
    }
    if (t.phase === 0) {
      const r = approach(sim, ant, t.cell, src.pos, 1.6);
      if (r === ARRIVED) {
        t.phase = 1;
        ant.mem['hl.t'] = sim.tick;
      } else if (r === FAILED) finishDuty(sim, ant, t, 'nj.leaf', 5);
      return;
    }
    // cutting
    stop(ant);
    ant.anim = 'bite';
    void dt;
    if (sim.tick - (ant.mem['hl.t'] ?? 0) < L.cutTime * 30) return;
    const take = Math.min(Math.max(0.5, getCaste(ant.species, ant.caste).carryCapacity), src.amount);
    src.amount -= take;
    ant.carrying = { kind: 'bulk', id: 0, itemKind: 'leaf', amount: take, material: Mat.Air };
    ant.mem['crop'] = 0;
    ant.mem['hl.go'] = 0;
    sim.emit(asSimEvent({ type: 'leafCut', tick: sim.tick, by: ant.id, colony: colony.id, pos: v3clone(ant.pos), amount: take }));
    t.phase = 2;
  },
  exit(ant) {
    if (ant.anim === 'bite') ant.anim = 'idle';
  },
};
