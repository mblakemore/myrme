import { type Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { dutyTask } from '../systems/colonyState';
import { gardenOf, tendGardenAction } from '../systems/fungusGarden';
import { getJob } from '../systems/jobsBoard';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach, pileCell, stop } from './util';

/**
 * Fungus gardening (`tendGarden` jobs — leafcutter minims). Duty task kind `rally` (unused by
 * other duties); `task.data` = garden id, `task.phase` = tend actions done this shift.
 * Walk to a spot in the garden, then every `tendTime` seconds perform one
 * `tendGardenAction` (weed mould → bed leaves → harvest fungus); after `tendsPerShift` actions,
 * or when there is nothing to do, re-decide.
 */
export const tendGardenBehavior: Behavior = {
  id: 'tendGarden',
  band: 'duty',
  score(ant, sim) {
    if (!getSpecies(ant.species).caps.farmsFungus) return 0;
    return dutyScore(sim, ant, 'rally', 'tendGarden', 'nj.garden');
  },
  run(ant, sim) {
    const L = BALANCE.b3.leafcutters;
    const t = dutyTask(ant) ?? takeJob(sim, ant, 'rally', 'tendGarden', 'nj.garden') ?? undefined;
    if (!t || t.kind !== 'rally') return;
    const job = getJob(sim, ant, t.jobId);
    const g = gardenOf(sim, ant.colony, t.data);
    if (!job || !g || g.status === 'collapsed') {
      finishDuty(sim, ant, t, 'nj.garden', 4);
      return;
    }
    if (!ant.mem['tg.at']) {
      const spot = pileCell(sim, g.pos, g.radius * 0.8, ant.id);
      const r = approach(sim, ant, spot >= 0 ? spot : g.cell, null, 1.2);
      if (r === ARRIVED) {
        ant.mem['tg.at'] = 1;
        ant.mem['tg.t'] = sim.tick;
      } else if (r === FAILED) {
        if (Math.hypot(g.pos.x - ant.pos.x, g.pos.y - ant.pos.y, g.pos.z - ant.pos.z) < g.radius + 2) {
          ant.mem['tg.at'] = 1;
          ant.mem['tg.t'] = sim.tick;
        } else finishDuty(sim, ant, t, 'nj.garden', 4);
      }
      return;
    }
    stop(ant);
    ant.anim = 'groom';
    if (sim.tick - (ant.mem['tg.t'] ?? 0) < L.tendTime * 30) return;
    ant.mem['tg.t'] = sim.tick;
    const did = tendGardenAction(sim, ant, g.id);
    t.phase++;
    if (did === 'none' || t.phase >= L.tendsPerShift) {
      ant.mem['tg.at'] = 0;
      finishDuty(sim, ant, t, did === 'none' ? 'nj.garden' : undefined, 6);
    }
  },
  exit(ant) {
    ant.mem['tg.at'] = 0;
    if (ant.anim === 'groom') ant.anim = 'idle';
  },
};
