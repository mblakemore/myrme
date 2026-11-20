import type { Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { FIGHT, HUNT, assess, distance, isBrave, isEnemy, isFighter, isPrey, type Fighter } from '../systems/combatCore';
import { fightExit, fightStep, ignoreTarget } from './fightCommon';
import { FAILED, approach } from './util';

const F = BALANCE.b1.fight;

/**
 * Fight (band `survival`): engage what `assess` (systems/combatCore.ts) says is worth fighting.
 *
 *  - soldiers and raid members attack any enemy they see and answer alarm calls from afar
 *  - workers defend the nest, fight outside it when the local odds are even or better, and mob
 *    prey they find (a `prey` alarm call recruits more hunters)
 *  - target choice: nearest enemy, preferring one that is already being mobbed (swarming works
 *    because latched bites slow and finally pin the victim — see `attack`)
 *  - pursuit ends at a leash from where the fight began; unreachable targets are ignored for a
 *    while; badly hurt ants hand over to `flee`
 * The bite itself happens in the combat system once the target is in reach.
 */
export const fightBehavior: Behavior = {
  id: 'fight',
  band: 'survival',
  score(ant, sim) {
    const m = assess(sim, ant).mode;
    return m === FIGHT ? 1 : m === HUNT ? 0.9 : 0;
  },
  run(ant, sim) {
    const mem = ant.mem;
    if (mem['ft.on'] !== 1) {
      mem['ft.on'] = 1;
      mem['ft.x'] = ant.pos.x;
      mem['ft.y'] = ant.pos.y;
      mem['ft.z'] = ant.pos.z;
    }
    let target: Fighter | null = null;
    const cur = ant.targetId ? sim.getEntity(ant.targetId) : undefined;
    if (isFighter(cur) && (isEnemy(sim, ant, cur) || (cur.kind === 'creature' && isPrey(cur)))) target = cur;
    let goal = -1;
    if (!target || (sim.tick + ant.id) % 10 === 0) {
      const a = assess(sim, ant);
      if (a.mode !== FIGHT && a.mode !== HUNT) {
        ant.thinkAt = sim.tick; // nothing to fight any more: let the brain move on
        if (!target) {
          ant.intent.mode = 'none';
          return;
        }
      } else if (a.targetId) {
        const e = sim.getEntity(a.targetId);
        if (isFighter(e)) target = e;
      } else if (a.call && !target) goal = a.call.cell;
    }
    if (target) {
      const leash = isBrave(ant) ? F.leashSoldier : F.leashWorker;
      const ox = ant.pos.x - (mem['ft.x'] ?? ant.pos.x);
      const oy = ant.pos.y - (mem['ft.y'] ?? ant.pos.y);
      const oz = ant.pos.z - (mem['ft.z'] ?? ant.pos.z);
      if (ox * ox + oy * oy + oz * oz > leash * leash && distance(ant.pos, target.pos) > 3) {
        ignoreTarget(sim, ant, target.id);
        ant.intent.mode = 'none';
        ant.thinkAt = sim.tick;
        return;
      }
      if (fightStep(sim, ant, target) === FAILED) ant.thinkAt = sim.tick;
      return;
    }
    if (goal >= 0) {
      if (approach(sim, ant, goal, null, 2.5, F.chaseSpeed) === FAILED) ant.thinkAt = sim.tick;
      return;
    }
    ant.intent.mode = 'none';
  },
  exit(ant) {
    fightExit(ant);
  },
};
