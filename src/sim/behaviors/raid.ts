import type { Ant, Behavior, Brood, SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste } from '../data/species';
import { chamberOf } from '../systems/colonyState';
import { distance, homeSteps } from '../systems/combatCore';
import { raidOf, type Raid } from '../systems/rivalsRaid';
import { fightExit } from './fightCommon';
import { FAILED, approach, carryBulkFood, homeward, pickUpBrood, shuffle } from './util';

const R = BALANCE.b1.raid;

function leave(sim: SimState, ant: Ant): void {
  ant.mem['raid'] = 0;
  ant.mem['raid.ret'] = 0;
  ant.thinkAt = sim.tick;
  ant.intent.mode = 'none';
}

function goHome(sim: SimState, ant: Ant, raid: Raid | undefined): void {
  if (homeSteps(sim, ant) <= 8) {
    // home: loot is put away by the ordinary behaviors (haulFood / carryBrood pick up orphans)
    if (raid?.vanish) sim.remove(ant);
    else leave(sim, ant);
    return;
  }
  if (homeward(sim, ant, 1)) return;
  const colony = sim.getColony(ant.colony);
  if (!colony || approach(sim, ant, colony.nestCell, null, 2, 1) === FAILED) leave(sim, ant);
}

/** Nearest piece of the victim's brood lying around within `radius`. */
function looseBrood(sim: SimState, ant: Ant, victim: number, radius: number): Brood | null {
  let best: Brood | null = null;
  let bestD = radius;
  for (const b of sim.brood) {
    if (!b.alive || b.colony !== victim || b.carriedBy) continue;
    const d = distance(b.pos, ant.pos);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function assault(sim: SimState, ant: Ant, raid: Raid, dt: number): void {
  const victim = raid.targetColony ? sim.getColony(raid.targetColony) : undefined;
  if (!victim) {
    // a point target: hold it (fighting is the `fight` behavior's business)
    if (distance(ant.pos, raid.targetPos) > 4 + (ant.id % 3)) {
      if (approach(sim, ant, raid.targetCell, raid.targetPos, 3, 1.1) === FAILED) shuffle(sim, ant, dt, 'rd', 0.4, 0.4);
    } else shuffle(sim, ant, dt, 'rd', 0.4, 0.4);
    return;
  }
  if (ant.carrying) {
    goHome(sim, ant, raid);
    return;
  }
  const looter = raid.kind === 'raid' && getCaste(ant.species, ant.caste).carryCapacity > 0;
  if (looter) {
    // brood within reach: grab it — it will be raised as one of ours
    const b = looseBrood(sim, ant, victim.id, 5);
    if (b) {
      if (distance(b.pos, ant.pos) > 1.3) {
        approach(sim, ant, b.cell >= 0 ? b.cell : victim.nestCell, b.pos, 1.2, 1.1);
        return;
      }
      pickUpBrood(sim, ant, b);
      b.colony = ant.colony;
      b.hunger = 0;
      return;
    }
    const pantry = chamberOf(victim, 'granary');
    if (victim.stores.food > 0.5 && distance(ant.pos, pantry.pos) <= pantry.radius + 1.5) {
      const take = Math.min(R.lootPerAnt, victim.stores.food, Math.max(0.5, getCaste(ant.species, ant.caste).carryCapacity));
      victim.stores.food -= take;
      carryBulkFood(ant, take);
      return;
    }
  }
  // push in: odd ants make for the nursery, even ones for the pantry, soldiers for the queen
  const goal = !looter ? victim.chambers[0] : ant.id % 2 === 1 ? chamberOf(victim, 'nursery') : chamberOf(victim, 'granary');
  if (distance(ant.pos, goal.pos) > Math.max(1.5, goal.radius * 0.6)) {
    if (approach(sim, ant, goal.cell, goal.pos, 1.5, 1.1) === FAILED) shuffle(sim, ant, dt, 'rd', 0.6, 0.6);
  } else shuffle(sim, ant, dt, 'rd', 0.6, 0.6);
}

/**
 * Raid (band `duty`, but scoring above every committed duty): act as a member of a raid party
 * (see systems/rivalsRaid.ts for the phases). Fighting on the way and at the target is done by
 * `fight` (survival band), which treats raid members as brave; a member carrying stolen brood
 * runs home with it instead.
 */
export const raidBehavior: Behavior = {
  id: 'raid',
  band: 'duty',
  score(ant, sim) {
    return ant.mem['raid'] && raidOf(sim, ant) ? 2 : 0;
  },
  run(ant, sim, dt) {
    const raid = raidOf(sim, ant);
    if (!raid || raid.phase === 'done') {
      leave(sim, ant);
      return;
    }
    switch (raid.phase) {
      case 'muster':
        if (distance(ant.pos, raid.rallyPos) > 3 + (ant.id % 3)) {
          if (approach(sim, ant, raid.rallyCell, raid.rallyPos, 3, 1.1) === FAILED) leave(sim, ant);
        } else shuffle(sim, ant, dt, 'rd', 0.3, 0.3);
        return;
      case 'advance': {
        const d = distance(ant.pos, raid.stagePos);
        // the van waits for the body of the party (big parties only: scouts and pickets just go)
        if (raid.size0 >= R.cohesionMinSize && raid.bodyDist !== undefined && d > 10 && d < raid.bodyDist - R.cohesion) {
          shuffle(sim, ant, dt, 'rd', 0.3, 0.3);
          return;
        }
        if (d > 4 + (ant.id % 3)) {
          if (approach(sim, ant, raid.stageCell, raid.stagePos, 3.5, R.advanceSpeed) === FAILED) leave(sim, ant);
        } else shuffle(sim, ant, dt, 'rd', 0.3, 0.3);
        return;
      }
      case 'assault':
        assault(sim, ant, raid, dt);
        return;
      default:
        goHome(sim, ant, raid);
    }
  },
  exit(ant) {
    fightExit(ant);
  },
};
