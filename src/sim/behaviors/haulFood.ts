import type { Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste } from '../data/species';
import { makeTask } from '../entities';
import { dutyTask } from '../systems/colonyState';
import { getJob } from '../systems/jobsBoard';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach, carriesFood, carryBulkFood, clearWorkAnim, deliverCarriedFood, isFoodItem, pantry, pickUpItem, stop } from './util';

function orphanFood(ant: Parameters<Behavior['score']>[0], sim: Parameters<Behavior['score']>[1]): boolean {
  if (!carriesFood(ant)) return false;
  const c = ant.carrying!;
  if (c.kind === 'item' && c.itemKind === 'corpse') {
    const e = sim.getEntity(c.id);
    return !!e && e.kind === 'item' && e.colony !== ant.colony; // own dead go to the midden instead
  }
  return true;
}

/**
 * Haul loose food to the pantry (`haulFood` jobs: dropped loads, keeper food, prey corpses).
 * Items bigger than one load are butchered on site, so several carriers work one item.
 * Also brings home any food an ant holds without a task explaining it (after possession, an
 * interrupted feeding run…). Phases: 0 to the item · 1 cutting · 2 to the pantry.
 */
export const haulFoodBehavior: Behavior = {
  id: 'haulFood',
  band: 'duty',
  score(ant, sim) {
    if (!dutyTask(ant) && ant.carrying) return orphanFood(ant, sim) ? BALANCE.a2b.commitScore : 0;
    return dutyScore(sim, ant, 'haul', 'haulFood', 'nj.haul');
  },
  run(ant, sim) {
    let t = dutyTask(ant);
    if (!t) {
      if (ant.carrying) {
        if (!orphanFood(ant, sim)) return;
        t = makeTask(sim, 'haul', 'self', { phase: 2 });
        ant.tasks.push(t);
      } else t = takeJob(sim, ant, 'haul', 'haulFood', 'nj.haul') ?? undefined;
    }
    if (!t || t.kind !== 'haul') return;
    const colony = sim.getColony(ant.colony);
    if (!colony) return;
    const B = BALANCE.a2b;
    if (t.phase < 2) {
      const item = sim.getEntity(t.targetId);
      if (!item || item.kind !== 'item' || item.carriedBy || !isFoodItem(item, ant.colony) || !getJob(sim, ant, t.jobId)) {
        finishDuty(sim, ant, t);
        return;
      }
      if (t.phase === 0) {
        const r = approach(sim, ant, item.cell, item.pos, 1.3);
        if (r === ARRIVED) {
          const cap = Math.max(0.5, getCaste(ant.species, ant.caste).carryCapacity);
          if (item.amount <= cap) {
            pickUpItem(sim, ant, item);
            t.phase = 2;
          } else {
            t.phase = 1;
            ant.mem['h.t0'] = sim.tick;
          }
        } else if (r === FAILED) finishDuty(sim, ant, t, 'nj.haul');
        return;
      }
      // butcher a load off a big item
      stop(ant);
      ant.anim = 'bite';
      if (sim.tick - (ant.mem['h.t0'] ?? 0) < B.butcherTime * 30) return;
      const cap = Math.max(0.5, getCaste(ant.species, ant.caste).carryCapacity);
      const take = Math.min(cap, item.amount);
      item.amount -= take;
      if (item.amount <= 1e-6) sim.remove(item);
      carryBulkFood(ant, take);
      clearWorkAnim(ant);
      t.phase = 2;
      return;
    }
    if (!ant.carrying) {
      finishDuty(sim, ant, t);
      return;
    }
    const store = pantry(colony, ant.pos);
    const r = approach(sim, ant, store.cell, store.pos, 1.5, B.carrySpeed);
    if (r === ARRIVED) {
      deliverCarriedFood(sim, colony, ant);
      finishDuty(sim, ant, t);
    } else if (r === FAILED) {
      // pantry unreachable from here: try again later, keep the load
      ant.mem['mv.f'] = 0;
    }
  },
  exit(ant) {
    clearWorkAnim(ant);
  },
};
