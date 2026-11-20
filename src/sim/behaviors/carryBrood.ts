import { v3, type Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { makeTask } from '../entities';
import { broodPilePos, chamberAt, dutyTask } from '../systems/colonyState';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach, dropCarry, nurseryFor, pickUpBrood, pileCell, placeCarry } from './util';

const _p = v3();

/**
 * Brood transport (`carryBrood` jobs): eggs laid at the queen, brood outside the nursery (after
 * a new nursery was dug, or dropped by the player) and brood lying in the wrong stage pile are
 * carried to their pile. Also re-homes brood an ant holds without a task. Phases: 0 fetch · 1 carry.
 */
export const carryBroodBehavior: Behavior = {
  id: 'carryBrood',
  band: 'duty',
  score(ant, sim) {
    if (!dutyTask(ant) && ant.carrying) return ant.carrying.kind === 'brood' ? BALANCE.a2b.commitScore : 0;
    return dutyScore(sim, ant, 'carryBrood', 'carryBrood', 'nj.brood');
  },
  run(ant, sim) {
    let t = dutyTask(ant);
    if (!t) {
      if (ant.carrying) {
        if (ant.carrying.kind !== 'brood') return;
        t = makeTask(sim, 'carryBrood', 'self', { phase: 1, targetId: ant.carrying.id, cell: -1 });
        ant.tasks.push(t);
      } else t = takeJob(sim, ant, 'carryBrood', 'carryBrood', 'nj.brood') ?? undefined;
    }
    if (!t || t.kind !== 'carryBrood') return;
    const colony = sim.getColony(ant.colony);
    const b = sim.getEntity(t.targetId);
    if (!colony || !b || b.kind !== 'brood') {
      if (ant.carrying?.kind === 'brood') ant.carrying = null;
      finishDuty(sim, ant, t);
      return;
    }
    if (t.phase === 0) {
      if (b.carriedBy && b.carriedBy !== ant.id) {
        finishDuty(sim, ant, t);
        return;
      }
      const r = approach(sim, ant, b.cell, b.pos, 1.3);
      if (r === ARRIVED) {
        pickUpBrood(sim, ant, b);
        t.phase = 1;
        t.cell = -1;
      } else if (r === FAILED) finishDuty(sim, ant, t, 'nj.brood');
      return;
    }
    if (ant.carrying?.kind !== 'brood') {
      finishDuty(sim, ant, t);
      return;
    }
    if (t.cell < 0) {
      broodPilePos(sim, chamberAt(colony, 'nursery', ant.pos, 0.8) ?? nurseryFor(sim, colony, ant.pos), b.stage, _p);
      t.cell = pileCell(sim, _p, BALANCE.a2b.broodPileRadius * 0.7, b.id);
    }
    const r = approach(sim, ant, t.cell, null, 0.9, BALANCE.a2b.carrySpeed);
    if (r === ARRIVED) {
      placeCarry(sim, ant, t.cell);
      finishDuty(sim, ant, t);
    } else if (r === FAILED) {
      dropCarry(sim, ant);
      finishDuty(sim, ant, t, 'nj.brood');
    }
  },
};
