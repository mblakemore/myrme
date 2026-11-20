import type { Ant, SimState, Task } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste } from '../data/species';
import { getJob } from '../systems/jobsBoard';
import { finishDuty } from './dutyCommon';
import { ARRIVED, FAILED, approach, carryBulkFood, pantry, stop } from './util';

/**
 * Feeding run shared by `nurse` (larvae) and `tendQueen`: fetch a portion from the pantry, carry
 * it to the target, feed. Phases: 0 to pantry · 1 to target · 2 feeding.
 */
export function runFeed(sim: SimState, ant: Ant, t: Task, key: string): void {
  const colony = sim.getColony(ant.colony);
  const target = sim.getEntity(t.targetId);
  const B = BALANCE.a2b;
  const ok = colony && target && ((target.kind === 'brood' && target.stage === 'larva' && !target.carriedBy) || target.kind === 'ant');
  if (!ok || !getJob(sim, ant, t.jobId)) {
    finishDuty(sim, ant, t); // leftover food is returned by haulFood (orphan carry)
    return;
  }
  if (t.phase === 0) {
    if (ant.carrying) {
      if (ant.carrying.kind === 'bulk' && ant.carrying.itemKind === 'food') t.phase = 1;
      else finishDuty(sim, ant, t, key);
      return;
    }
    const store = pantry(colony, ant.pos);
    const r = approach(sim, ant, store.cell, store.pos, 1.8);
    if (r === ARRIVED) {
      // a crop-full: enough for a couple of larvae per trip
      const amt = Math.min(Math.max(B.feedPortion, getCaste(ant.species, ant.caste).carryCapacity), colony.stores.food);
      if (amt <= 0.05) {
        finishDuty(sim, ant, t, key, 6);
        return;
      }
      colony.stores.food -= amt;
      carryBulkFood(ant, amt, true);
      t.phase = 1;
    } else if (r === FAILED) finishDuty(sim, ant, t, key);
    return;
  }
  if (t.phase === 1) {
    if (!ant.carrying) {
      t.phase = 0;
      return;
    }
    const r = approach(sim, ant, target.cell, target.pos, target.kind === 'ant' ? 1.9 : 1.3, B.carrySpeed);
    if (r === ARRIVED) {
      t.phase = 2;
      ant.mem['fd.t0'] = sim.tick;
    } else if (r === FAILED) finishDuty(sim, ant, t, key);
    return;
  }
  stop(ant);
  ant.anim = 'feed';
  if (sim.tick - (ant.mem['fd.t0'] ?? 0) < B.feedTime * 30) return;
  const c = ant.carrying;
  const amt = c?.amount ?? 0;
  let given = 0;
  if (target.kind === 'brood') {
    given = Math.min(amt, B.feedPortion, Math.max(0, getCaste(target.species, target.caste).foodCost - target.fed));
    target.fed += given;
    target.hunger = 0;
  } else if (target.kind === 'ant') {
    given = Math.min(amt, Math.max(0, (1 - target.energy) * B.foodPerEnergy));
    target.energy = Math.min(1, target.energy + given / B.foodPerEnergy);
  }
  // what is left in the crop goes to the next hungry mouth (nurse.score) or back to the pantry
  if (c && amt - given > 0.3) c.amount = amt - given;
  else ant.carrying = null;
  finishDuty(sim, ant, t);
}
