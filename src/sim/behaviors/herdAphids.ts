import { type Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste, getSpecies } from '../data/species';
import { dutyTask } from '../systems/colonyState';
import { herdOf, milkHerd } from '../systems/aphids';
import { getJob } from '../systems/jobsBoard';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach, carryBulkFood, deliverCarriedFood, homeward, pantry, shuffle, stop } from './util';

/**
 * Aphid shepherd (`herdAphids` jobs, species with `herdsAphids`). Duty task kind `follow`
 * (unused by other duties); `task.data` = herd id, `task.phase`:
 *   0 walk out to the herd
 *   1 stand guard among the aphids, stroking them (`groom`), for a third of a shift — being
 *     there is what makes the herd "tended" (more honeydew, faster breeding)
 *   2 milk: drink a crop of honeydew from the herd's source
 *   3 carry it home to the pantry (counts as delivered food)
 */
export const herdAphidsBehavior: Behavior = {
  id: 'herdAphids',
  band: 'duty',
  score(ant, sim) {
    if (!getSpecies(ant.species).caps.herdsAphids) return 0;
    return dutyScore(sim, ant, 'follow', 'herdAphids', 'nj.aphid');
  },
  run(ant, sim, dt) {
    const A = BALANCE.b3.aphids;
    const t = dutyTask(ant) ?? takeJob(sim, ant, 'follow', 'herdAphids', 'nj.aphid') ?? undefined;
    if (!t || t.kind !== 'follow') return;
    const colony = sim.getColony(ant.colony);
    if (!colony) return;
    if (t.phase === 3) {
      ant.anim = 'carry';
      const store = pantry(colony, ant.pos);
      const d = Math.hypot(store.pos.x - ant.pos.x, store.pos.y - ant.pos.y, store.pos.z - ant.pos.z);
      if (!ant.mem['ha.go'] && (d < 8 || !homeward(sim, ant, 0.9))) ant.mem['ha.go'] = 1;
      if (ant.mem['ha.go']) {
        const r = approach(sim, ant, store.cell, store.pos, 1.6, 0.9);
        if (r === ARRIVED || (r === FAILED && d < 5)) {
          deliverCarriedFood(sim, colony, ant);
          ant.mem['ha.go'] = 0;
          finishDuty(sim, ant, t);
        } else if (r === FAILED) ant.mem['ha.go'] = 0;
      }
      return;
    }
    const job = getJob(sim, ant, t.jobId);
    const herd = herdOf(sim, t.data);
    if (!job || !herd || herd.aphids.length === 0) {
      finishDuty(sim, ant, t, 'nj.aphid', 6);
      return;
    }
    if (t.phase === 0) {
      const r = approach(sim, ant, t.cell, t.pos, 1.8);
      if (r === ARRIVED) {
        t.phase = 1;
        ant.mem['ha.t'] = sim.tick;
      } else if (r === FAILED) finishDuty(sim, ant, t, 'nj.aphid', 8);
      return;
    }
    if (t.phase === 1) {
      // potter about among the aphids
      shuffle(sim, ant, dt, 'ha', 0.25, 0.25);
      if (ant.intent.mode === 'none') ant.anim = 'groom';
      if ((sim.tick + ant.id) % 30 === 0) milkHerd(sim, herd.id, ant.id);
      if (sim.tick - (ant.mem['ha.t'] ?? 0) > (A.shift / 3) * 30) {
        t.phase = 2;
        ant.mem['ha.t'] = sim.tick;
      }
      return;
    }
    // milking
    const r = approach(sim, ant, t.cell, t.pos, 1.8);
    if (r === FAILED) {
      finishDuty(sim, ant, t, 'nj.aphid', 4);
      return;
    }
    if (r !== ARRIVED) return;
    stop(ant);
    ant.anim = 'feed';
    if (sim.tick - (ant.mem['ha.t'] ?? 0) < A.milkTime * 30 + 60) return;
    const src = milkHerd(sim, herd.id, ant.id);
    const take = src ? Math.min(Math.max(0.5, getCaste(ant.species, ant.caste).carryCapacity), src.amount) : 0;
    if (!src || take < 0.2) {
      finishDuty(sim, ant, t, 'nj.aphid', 10);
      return;
    }
    src.amount -= take;
    carryBulkFood(ant, take);
    ant.mem['ha.go'] = 0;
    t.phase = 3;
  },
  exit(ant) {
    if (ant.anim === 'groom' || ant.anim === 'feed') ant.anim = 'idle';
  },
};
