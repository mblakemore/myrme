import type { Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { makeTask } from '../entities';
import { dutyTask, getExt } from '../systems/colonyState';
import { hasSpoil, runDigDuty, runSpoilHaul, stopDigDuty } from '../systems/dig';
import { getJob } from '../systems/jobsBoard';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { clearWorkAnim } from './util';

/**
 * Excavation duty (`dig` jobs — one per designation, player-painted or requested by the colony
 * itself when the nest is crowded). Allocation (who digs, how many per designation) is the job
 * board's; execution is A2a's dig-site API: `runDigDuty` claims a stamp of the designation,
 * walks there, works it, then hauls the spoil pellet out to the mound and repeats.
 * An ant left holding a pellet without a task (after possession) carries it out too.
 */
export const digBehavior: Behavior = {
  id: 'dig',
  band: 'duty',
  score(ant, sim) {
    if (!dutyTask(ant) && ant.carrying) return hasSpoil(ant) ? BALANCE.a2b.commitScore : 0;
    return dutyScore(sim, ant, 'dig', 'dig', 'nj.dig');
  },
  run(ant, sim, dt) {
    let t = dutyTask(ant);
    if (!t) {
      if (ant.carrying) {
        if (!hasSpoil(ant)) return;
        t = makeTask(sim, 'dig', 'self');
        ant.tasks.push(t);
      } else t = takeJob(sim, ant, 'dig', 'dig', 'nj.dig') ?? undefined;
    }
    if (!t || t.kind !== 'dig') return;
    // a pellet in the mandibles is carried out whatever happened to the job meanwhile
    if (hasSpoil(ant)) {
      // dropping the pellet is a natural break: re-decide (and most likely dig on)
      if (runSpoilHaul(sim, ant) === 'dropped') {
        stopDigDuty(sim, ant);
        finishDuty(sim, ant, t);
      }
      return;
    }
    const colony = sim.getColony(ant.colony);
    const job = getJob(sim, ant, t.jobId);
    const d = colony && job ? colony.designations.find((x) => x.id === job.designationId) : undefined;
    if (!colony || !job || !d || d.kind !== 'dig') {
      stopDigDuty(sim, ant);
      finishDuty(sim, ant, t);
      return;
    }
    const st = runDigDuty(sim, ant, dt, { designationId: d.id });
    if (st === 'done') {
      // nothing workable left: finished (the API retired the designation) or out of reach for now
      // (a job somebody else is still working is merely full: only this ant backs off)
      if (!d.done && job.assigned.length <= 1) getExt(sim, colony.id).digBlocked.set(d.id, sim.tick + BALANCE.a2b.digRetryTicks);
      stopDigDuty(sim, ant);
      finishDuty(sim, ant, t, 'nj.dig', 2);
    } else if (st === 'idle') {
      t.phase++;
      if (t.phase > 90) {
        stopDigDuty(sim, ant);
        finishDuty(sim, ant, t, 'nj.dig', 3);
      }
    } else t.phase = 0;
  },
  exit(ant, sim) {
    stopDigDuty(sim, ant);
    clearWorkAnim(ant);
  },
};
