import { HOME_UNREACHABLE, v3, type Ant, type Behavior, type NavEx, type SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { dutyTask, getExt } from '../systems/colonyState';
import { sunSensitive } from '../systems/temperature';
import { termiteSheeted } from '../systems/termiteBuild';
import { envState } from '../systems/weatherEnv';
import { bestCellNear } from './floodEscapeNav';
import { FAILED, approach, dist, homeward, shuffle, stop } from './util';

/**
 * Weather shelter (band `survival`) — one behavior for every "get under cover" reason:
 *
 *   - the colony's shelter signal (`ColonyEnvState.shelter`: rain / heat / cold): every exposed
 *     ant of the colony heads home, and foragers (ants holding a `gather` duty task without a
 *     load) are held inside until the signal clears — this is how foraging is suppressed without
 *     touching A2b's forage scoring (survival beats duty; the forager keeps its task and resumes)
 *   - thirst: an ant drying out in the heat looks for shade whatever the colony says
 *   - sun-sensitive species (termites): out of direct sun
 *
 * Under cover it does not push deeper into a flooded nest; it waits near the entrance.
 * Hungry ants are released so they can eat; player orders (band `player`) are never overridden.
 */

const _c = v3();
const HOLD = 'sh.u';

/** Stores below `rainForageFood` per adult: foraging matters more than staying dry. */
function hungryColony(sim: SimState, id: number, k: number): boolean {
  const c = sim.getColony(id);
  return !!c && c.stores.food < BALANCE.b2.rainForageFood * k * Math.max(8, c.population.total);
}

function exposed(sim: SimState, ant: Ant): boolean {
  return ant.cell >= 0 && (sim.nav as NavEx).isExposed(ant.cell);
}

export const seekShadeBehavior: Behavior = {
  id: 'seekShade',
  band: 'survival',
  score(ant, sim) {
    if (ant.colony <= 0 || ant.caste === 'queen' || ant.caste === 'king') return 0;
    if (!getExt(sim, ant.colony).active) return 0;
    const st = ant.infection.stage;
    if (st !== 'none' && st !== 'exposed' && st !== 'incubating') return 0;
    const B = BALANCE.b2;
    const env = envState(sim);
    const out = exposed(sim, ant);
    // final round: termite builders at the works (shelter tube mouth, mound) stay on the job
    if (out && sim.tick - (ant.mem['tb.w'] ?? -1e9) < 30 && sim.weather.kind !== 'storm') return 0;
    if (out) {
      if (env.sun > B.sunSensitiveExposure && sunSensitive(ant) && !termiteSheeted(sim, ant)) return 0.8;
      if (ant.hydration < B.thirsty && env.temperatureAtCell(ant.cell) > B.dryTemp) return 0.75;
    }
    const cs = env.colonyState(ant.colony);
    if (cs.shelter === 'none') return 0;
    // final round: a colony short of food sends its foragers out in ordinary rain (and, when the stores are
    // nearly empty, even in a storm — some will be lost to the drops): a long wet spell no longer starves it behind a closed door
    if (cs.shelter === 'rain' && hungryColony(sim, ant.colony, sim.weather.kind === 'storm' ? 0.25 : 1)) {
      const t = dutyTask(ant);
      if ((t && t.kind === 'gather') || ant.carrying) return 0;
    }
    if (out) return 0.6;
    if ((ant.mem[HOLD] ?? 0) > sim.tick) return 0.55;
    // foragers wait inside (unless they have a load to deliver or need to eat)
    if (ant.carrying || ant.energy < BALANCE.a2b.hungryEnergy + 0.05) return 0;
    const t = dutyTask(ant);
    return t && t.kind === 'gather' ? 0.5 : 0;
  },
  run(ant, sim, dt) {
    const nav = sim.nav as NavEx;
    const env = envState(sim);
    const colony = sim.getColony(ant.colony);
    if (!colony || ant.cell < 0 || ant.falling) {
      stop(ant);
      return;
    }
    const hd = nav.homeDistance(ant.colony, ant.cell);
    if (exposed(sim, ant)) {
      ant.mem[HOLD] = sim.tick + 150;
      // far from home in the heat: any shade will do
      const cs = env.colonyState(ant.colony);
      if ((hd === HOME_UNREACHABLE || hd > 70) && cs.shelter !== 'rain') {
        let goal = ant.mem['sh.g'] ?? -1;
        if (goal < 0 || !nav.isWalkable(goal) || sim.tick >= (ant.mem['sh.gu'] ?? 0)) {
          goal = bestCellNear(sim, ant, 5, (cell, dx, dy, dz) => (nav.isExposed(cell) ? Infinity : dx * dx + dy * dy + dz * dz));
          ant.mem['sh.g'] = goal;
          ant.mem['sh.gu'] = sim.tick + 90;
        }
        if (goal >= 0 && approach(sim, ant, goal, null, 0.7, 1.15) !== FAILED) return;
      }
      // homing by direction can jitter at full speed on a lip without getting anywhere: when the
      // home distance stops dropping, let A* take the ant in
      const mem = ant.mem;
      if (mem['sh.t'] === undefined || sim.tick - mem['sh.t'] > 300 || hd < mem['sh.d']) {
        mem['sh.d'] = hd;
        mem['sh.t'] = sim.tick;
      } else if (sim.tick - mem['sh.t'] > 60) mem['sh.p'] = sim.tick + 300;
      if (!((mem['sh.p'] ?? 0) > sim.tick) && homeward(sim, ant, 1.15)) return;
      if (colony.nestCell >= 0 && approach(sim, ant, colony.nestCell, null, 2, 1.15) !== FAILED) return;
      stop(ant);
      return;
    }
    // under cover: move in off the doorstep unless the nest below is under water
    const cs = env.colonyState(ant.colony);
    if (hd !== HOME_UNREACHABLE && hd > 6 && !cs.flooded) {
      const next = nav.homeStep(ant.colony, ant.cell);
      if (next >= 0 && sim.water.depthAt(next) <= BALANCE.b2.escapeDepth && homeward(sim, ant, 0.8)) return;
    }
    sim.world.cellCenter(ant.cell, _c);
    void dist;
    shuffle(sim, ant, dt, 'sh', 0.3, 0.3);
  },
  exit(ant) {
    ant.mem['sh.g'] = -1;
    ant.intent.mode = 'none';
  },
};
