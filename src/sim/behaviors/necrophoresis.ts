import type { Ant, Behavior, Colony, NavEx, SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { makeTask } from '../entities';
import { dutyTask, nearestChamber } from '../systems/colonyState';
import { sunSensitive } from '../systems/temperature';
import { termiteSheeted, termiteSunBurns } from '../systems/termiteBuild';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach, dropCarry, pickUpItem, pileCell, placeCarry } from './util';

function orphanCorpse(ant: Ant, sim: SimState): boolean {
  const c = ant.carrying;
  if (!c || c.kind !== 'item' || c.itemKind !== 'corpse') return false;
  const e = sim.getEntity(c.id);
  return !!e && e.kind === 'item' && e.colony === ant.colony;
}

/**
 * Sun-sensitive species (termites) cannot reach a midden out in the sun by day: seekShade pulls
 * the carrier back under cover at the doorstep and the duty sends it out again, every think,
 * for as long as the sun is up (the ant shuttles on the spot and starves). They leave the dead
 * for the night instead.
 */
function sunBarred(sim: SimState, ant: Ant, colony: Colony): boolean {
  if (!sunSensitive(ant) || !termiteSunBurns(sim) || termiteSheeted(sim, ant)) return false;
  const midden = nearestChamber(colony, 'midden', ant.pos);
  return midden.cell >= 0 && (sim.nav as NavEx).isExposed(midden.cell);
}

/**
 * Necrophoresis (§1 pillar 4): corpses of nestmates start to smell (`death` signal) after a
 * delay; workers pick them up and carry them to the midden pile, away from the brood
 * (`carryCorpse` jobs). Phases: 0 fetch · 1 carry to the midden.
 */
export const necrophoresisBehavior: Behavior = {
  id: 'necrophoresis',
  band: 'duty',
  score(ant, sim) {
    if (!dutyTask(ant) && ant.carrying) return orphanCorpse(ant, sim) ? BALANCE.a2b.commitScore : 0;
    if (!dutyTask(ant)) {
      const colony = sim.getColony(ant.colony);
      if (colony && sunBarred(sim, ant, colony)) return 0;
    }
    return dutyScore(sim, ant, 'carryCorpse', 'carryCorpse', 'nj.corpse');
  },
  run(ant, sim) {
    let t = dutyTask(ant);
    if (!t) {
      if (ant.carrying) {
        if (!orphanCorpse(ant, sim)) return;
        t = makeTask(sim, 'carryCorpse', 'self', { phase: 1, targetId: ant.carrying.id, cell: -1 });
        ant.tasks.push(t);
      } else t = takeJob(sim, ant, 'carryCorpse', 'carryCorpse', 'nj.corpse') ?? undefined;
    }
    if (!t || t.kind !== 'carryCorpse') return;
    const colony = sim.getColony(ant.colony);
    const item = sim.getEntity(t.targetId);
    if (!colony || !item || item.kind !== 'item') {
      if (ant.carrying?.kind === 'item') ant.carrying = null;
      finishDuty(sim, ant, t);
      return;
    }
    if (t.phase === 0) {
      if (item.carriedBy && item.carriedBy !== ant.id) {
        finishDuty(sim, ant, t);
        return;
      }
      const r = approach(sim, ant, item.cell, item.pos, 1.3);
      if (r === ARRIVED) {
        pickUpItem(sim, ant, item);
        t.phase = 1;
        t.cell = -1;
      } else if (r === FAILED) finishDuty(sim, ant, t, 'nj.corpse', 8);
      return;
    }
    if (ant.carrying?.id !== item.id) {
      finishDuty(sim, ant, t);
      return;
    }
    // turned back by the sun (seekShade has just held it under cover): put the corpse down here
    if ((ant.mem['sh.u'] ?? 0) > sim.tick && sunBarred(sim, ant, colony) && ant.cell >= 0 && !(sim.nav as NavEx).isExposed(ant.cell)) {
      dropCarry(sim, ant);
      finishDuty(sim, ant, t, 'nj.corpse', 60);
      return;
    }
    const midden = nearestChamber(colony, 'midden', ant.pos);
    if (t.cell < 0) t.cell = pileCell(sim, midden.pos, midden.radius * 0.6, item.id);
    const r = approach(sim, ant, t.cell, null, 1.0, BALANCE.a2b.carrySpeed);
    if (r === ARRIVED) {
      placeCarry(sim, ant, t.cell);
      finishDuty(sim, ant, t);
    } else if (r === FAILED) {
      dropCarry(sim, ant);
      finishDuty(sim, ant, t, 'nj.corpse', 8);
    }
  },
};
