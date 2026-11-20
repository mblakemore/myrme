import type { Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { getExt } from '../systems/colonyState';
import { ARRIVED, FAILED, approach, clearWorkAnim, pantry, stop } from './util';

/**
 * Eat from the colony stores. A hungry ant (energy < `hungryEnergy`) interrupts its duty for it;
 * a peckish one tops up when it has nothing better to do. An ant holding a food load eats from
 * the load on the spot. With empty stores nobody queues at the pantry — they forage instead
 * (and starve if that fails; see the food system).
 */
export const eatBehavior: Behavior = {
  id: 'eat',
  band: 'duty',
  score(ant, sim) {
    const B = BALANCE.a2b;
    if (ant.energy >= B.peckishEnergy || ant.caste === 'queen' || ant.caste === 'king') return 0;
    const colony = sim.getColony(ant.colony);
    if (!colony || !getExt(sim, colony.id).active) return 0;
    // (fungus farmers cannot eat the forage they carry — only what the garden yields)
    const own = ant.carrying?.kind === 'bulk' && ant.carrying.itemKind === 'food' && ant.carrying.amount > 0 && (!!ant.mem['crop'] || !getSpecies(ant.species).caps.farmsFungus);
    if (!own && colony.stores.food < 0.2) return 0;
    if (ant.energy < B.hungryEnergy) return 2 + (B.hungryEnergy - ant.energy);
    return ant.tasks.length === 0 && !ant.carrying ? 0.5 : 0;
  },
  run(ant, sim) {
    const colony = sim.getColony(ant.colony);
    if (!colony) return;
    const B = BALANCE.a2b;
    const c = ant.carrying;
    if (c && c.kind === 'bulk' && c.itemKind === 'food' && c.amount > 0 && (!!ant.mem['crop'] || !getSpecies(ant.species).caps.farmsFungus)) {
      const eat = Math.min(c.amount, (1 - ant.energy) * B.foodPerEnergy);
      c.amount -= eat;
      ant.energy = Math.min(1, ant.energy + eat / B.foodPerEnergy);
      if (c.amount <= 1e-6) ant.carrying = null;
      ant.thinkAt = sim.tick;
      return;
    }
    const store = pantry(colony, ant.pos);
    const r = approach(sim, ant, store.cell, store.pos, 2.2);
    if (r === ARRIVED) {
      stop(ant);
      ant.anim = 'feed';
      const t0 = ant.mem['e.t0'] ?? 0;
      if (t0 === 0 || sim.tick - t0 > 300) {
        ant.mem['e.t0'] = sim.tick;
        return;
      }
      if (sim.tick - t0 < B.eatTime * 30) return;
      const eat = Math.min(colony.stores.food, (1 - ant.energy) * B.foodPerEnergy);
      colony.stores.food -= eat;
      ant.energy = Math.min(1, ant.energy + eat / B.foodPerEnergy);
      ant.mem['e.t0'] = 0;
      clearWorkAnim(ant);
      ant.thinkAt = sim.tick;
    } else if (r === FAILED) {
      // cannot reach the pantry: stop trying for a while (trophallaxis may still save it)
      ant.mem['e.t0'] = 0;
      ant.energy = Math.max(ant.energy, 0); // no-op; keeps the ant in the pool for trophallaxis
      ant.thinkAt = sim.tick + 60;
    }
  },
  exit(ant) {
    ant.mem['e.t0'] = 0;
    clearWorkAnim(ant);
  },
};
