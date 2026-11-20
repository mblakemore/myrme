import { v3, type Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { FLEE, assess, distance, homeSteps, isFighter } from '../systems/combatCore';
import { FAILED, approach, dropCarry, homeward, shuffle, steer } from './util';

const L = BALANCE.b1.flee;
const _d = v3();

/**
 * Flee (band `survival`): workers facing bad odds, brood carriers and badly hurt ants run down
 * the home field into the nest (big predators cannot follow — D11 clearance). A carrier drops
 * food when the enemy is on its heels; brood is never dropped. The panic lasts a few seconds
 * after the danger was last perceived, so ants do not turn around at the first step.
 */
export const fleeBehavior: Behavior = {
  id: 'flee',
  band: 'survival',
  score(ant, sim) {
    return assess(sim, ant).mode === FLEE ? 1.1 : 0;
  },
  run(ant, sim, dt) {
    const mem = ant.mem;
    if ((sim.tick + ant.id) % 6 === 0 || mem['fl.t'] === undefined) {
      const a = assess(sim, ant);
      if (a.mode === FLEE && a.fresh) {
        mem['fl.t'] = sim.tick + L.panicTicks;
        if (a.targetId) mem['fl.id'] = a.targetId;
      } else if (a.mode !== FLEE) {
        ant.thinkAt = sim.tick;
      }
    }
    ant.targetId = 0;
    const threat = mem['fl.id'] ? sim.getEntity(mem['fl.id']) : undefined;
    const td = isFighter(threat) ? distance(threat.pos, ant.pos) : Infinity;
    if (ant.carrying && ant.carrying.kind !== 'brood' && td < L.dropLoadDist) dropCarry(sim, ant);

    const steps = homeSteps(sim, ant);
    if (steps <= L.safeSteps) {
      // indoors: calm down unless the enemy followed us in
      if (td > 6 && (mem['fl.t'] ?? 0) > sim.tick + 20) mem['fl.t'] = sim.tick + 20;
      shuffle(sim, ant, dt, 'fl', 0.5, 0.5);
      return;
    }
    if (homeward(sim, ant, L.speed)) return;
    const colony = sim.getColony(ant.colony);
    if (colony && colony.nestCell >= 0 && approach(sim, ant, colony.nestCell, null, 2, L.speed) !== FAILED) return;
    // no way home from here: just get away from it
    if (isFighter(threat)) {
      _d.x = ant.pos.x - threat.pos.x;
      _d.y = 0;
      _d.z = ant.pos.z - threat.pos.z;
      if (Math.abs(_d.x) + Math.abs(_d.z) < 1e-3) _d.x = 1;
      steer(ant, _d, L.speed);
    } else ant.intent.mode = 'none';
  },
  exit(ant) {
    ant.intent.mode = 'none';
  },
};
