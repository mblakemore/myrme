import type { Behavior } from '../../core';
import { chamberOf, getExt } from '../systems/colonyState';
import { approach, dist, shuffle } from './util';

/**
 * The queen (and a termite king) stays in the royal chamber: walks back if displaced, otherwise
 * shuffles slowly. Egg laying itself is done by the brood system at her position. Player orders
 * and possession (higher bands) still work on her.
 */
export const queenBehavior: Behavior = {
  id: 'queen',
  band: 'duty',
  score(ant, sim) {
    if (ant.caste !== 'queen' && ant.caste !== 'king') return 0;
    return getExt(sim, ant.colony).active ? 5 : 0;
  },
  run(ant, sim, dt) {
    const colony = sim.getColony(ant.colony);
    if (!colony) return;
    const ch = chamberOf(colony, 'queen');
    if (dist(ant.pos, ch.pos) > Math.max(2.5, ch.radius * 0.5)) approach(sim, ant, ch.cell, ch.pos, 1.5);
    else shuffle(sim, ant, dt, 'q', 0.15, 0.2);
  },
};
