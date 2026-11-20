import type { Behavior } from '../../core';
import { getExt } from '../systems/colonyState';
import { approach, dist, dropCarry, shuffle } from './util';

/**
 * Default when nothing else applies: drift back to the nest and rest there (a slow shuffle so
 * the colony shows life). An idle ant holding something no duty explains puts it down.
 */
export const idleBehavior: Behavior = {
  id: 'idle',
  band: 'idle',
  score: () => 0.1,
  run(ant, sim, dt) {
    const colony = sim.getColony(ant.colony);
    if (colony && getExt(sim, colony.id).active) {
      if (ant.carrying && ant.tasks.length === 0) dropCarry(sim, ant);
      if (!ant.mem['exiled'] && colony.nestCell >= 0 && dist(ant.pos, colony.nestPos) > 8) {
        approach(sim, ant, colony.nestCell, colony.nestPos, 5, 0.8);
        return;
      }
    }
    shuffle(sim, ant, dt, 'i', 0.45, 0.35);
  },
};
