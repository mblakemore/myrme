import type { Behavior } from '../../core';
import { dutyTask, getExt } from '../systems/colonyState';
import { getJob } from '../systems/jobsBoard';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach } from './util';

/**
 * Patrol duty (`patrol` job): walk the ring of patrol posts around the nest entrance. Soldiers
 * have the low threshold; old workers join when nothing else is pressing. One lap, then the ant
 * re-decides. B1's fight/guard behaviors (survival band) pre-empt it when something turns up.
 */
export const patrolBehavior: Behavior = {
  id: 'patrol',
  band: 'duty',
  score: (ant, sim) => dutyScore(sim, ant, 'patrol', 'patrol', 'nj.patrol'),
  run(ant, sim) {
    const fresh = !dutyTask(ant);
    const t = dutyTask(ant) ?? takeJob(sim, ant, 'patrol', 'patrol', 'nj.patrol');
    if (!t || t.kind !== 'patrol') return;
    const pts = getExt(sim, ant.colony).patrolPoints;
    if (pts.length === 0 || !getJob(sim, ant, t.jobId)) {
      finishDuty(sim, ant, t, 'nj.patrol', 10);
      return;
    }
    if (fresh) t.data = ant.id % pts.length; // spread patrollers over the ring
    const cell = pts[(t.data + t.phase) % pts.length];
    const r = approach(sim, ant, cell, null, 1.6, 0.8);
    if (r === ARRIVED || r === FAILED) {
      t.phase++;
      if (t.phase >= pts.length) finishDuty(sim, ant, t, 'nj.patrol', ant.caste === 'soldier' ? 3 : 30);
    }
  },
};
