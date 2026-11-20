import type { Behavior } from '../../core';
import { dutyTask } from '../systems/colonyState';
import { dutyScore, takeJob } from './dutyCommon';
import { runFeed } from './feedCore';
import { clearWorkAnim } from './util';

/**
 * Queen care: bring her food from the pantry when she is hungry (`feedQueen` jobs — she never
 * leaves her chamber). Owns `feed` tasks whose target is an ant.
 */
export const tendQueenBehavior: Behavior = {
  id: 'tendQueen',
  band: 'duty',
  score: (ant, sim) => dutyScore(sim, ant, 'feed', 'feedQueen', 'nj.tendQueen', (t) => sim.getEntity(t.targetId)?.kind === 'ant'),
  run(ant, sim) {
    const t = dutyTask(ant) ?? takeJob(sim, ant, 'feed', 'feedQueen', 'nj.tendQueen');
    if (t && t.kind === 'feed') runFeed(sim, ant, t, 'nj.tendQueen');
  },
  exit(ant) {
    clearWorkAnim(ant);
  },
};
