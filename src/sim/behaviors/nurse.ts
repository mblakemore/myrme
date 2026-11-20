import type { Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { dutyTask, getExt } from '../systems/colonyState';
import { isBlocked, thresholdFor } from '../systems/jobsBoard';
import { dutyScore, takeJob } from './dutyCommon';
import { runFeed } from './feedCore';
import { clearWorkAnim } from './util';

/**
 * Brood care: carry food from the pantry to hungry larvae (`feedLarva` jobs). Young workers have
 * the lowest thresholds for it (age polyethism). Owns `feed` tasks whose target is brood.
 */
export const nurseBehavior: Behavior = {
  id: 'nurse',
  band: 'duty',
  score(ant, sim) {
    // food left in the crop after a feeding goes straight to the next hungry larva
    const c = ant.carrying;
    if (c && c.kind === 'bulk' && c.itemKind === 'food' && !dutyTask(ant) && !isBlocked(ant, sim, 'nj.nurse') && getExt(sim, ant.colony).demand.feedLarva > 0 && thresholdFor(ant, 'feedLarva') >= 0) return BALANCE.a2b.commitScore + 0.1;
    return dutyScore(sim, ant, 'feed', 'feedLarva', 'nj.nurse', (t) => sim.getEntity(t.targetId)?.kind !== 'ant');
  },
  run(ant, sim) {
    const t = dutyTask(ant) ?? takeJob(sim, ant, 'feed', 'feedLarva', 'nj.nurse');
    if (t && t.kind === 'feed') runFeed(sim, ant, t, 'nj.nurse');
  },
  exit(ant) {
    clearWorkAnim(ant);
  },
};
