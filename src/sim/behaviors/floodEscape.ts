import { v3, type Ant, type Behavior, type Brood, type ColonyEnvState, type NavEx, type SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { getExt } from '../systems/colonyState';
import { envState, waterOver } from '../systems/weatherEnv';
import { bestCellNear, followField } from './floodEscapeNav';
import { ARRIVED, FAILED, approach, dist, dropCarry, pickUpBrood, pileCell, placeCarry, steerTo, stop } from './util';

/**
 * Flood response (band `survival`).
 *
 *   escape   an ant standing in water deeper than `escapeDepth` climbs out: down the sky field
 *            (the way out of the nest is the way up), or to the nearest dry, higher cell when it
 *            is already outside (a puddle). It keeps going for a moment after leaving the water.
 *   rescue   while the colony's nest is flooded (`ColonyEnvState.flooded`), workers fetch brood
 *            that lies in or just above the water and carry it to the refuge — the highest dry
 *            chamber, registered as an emergency nursery by the water system so the brood stays.
 *   queen    a queen threatened by the water walks to the refuge herself.
 *
 * Flooded cells are not blocked in nav (no such channel): ants still path through shallow water,
 * slowed by the speed hook, and this behavior turns them back before they drown.
 */

/** Brood id → rescuer id, per simulation. */
const claimsBySim = new WeakMap<SimState, Map<number, number>>();
const _c = v3();

function claimsOf(sim: SimState): Map<number, number> {
  let m = claimsBySim.get(sim);
  if (!m) claimsBySim.set(sim, (m = new Map()));
  return m;
}

function claimed(sim: SimState, broodId: number, by: number): boolean {
  const c = claimsOf(sim).get(broodId);
  if (c === undefined || c === by) return false;
  const a = sim.getAnt(c);
  return !!a && a.mem['fe.b'] === broodId;
}

function freeBrood(sim: SimState, st: ColonyEnvState, ant: Ant): Brood | null {
  let best: Brood | null = null;
  let bestD = Infinity;
  for (const id of st.threatenedBrood) {
    if (claimed(sim, id, ant.id)) continue;
    const b = sim.getEntity(id);
    if (!b || b.kind !== 'brood' || b.carriedBy) continue;
    const d = dist(b.pos, ant.pos);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function inDanger(sim: SimState, ant: Ant): boolean {
  return ant.cell >= 0 && waterOver(sim, ant) > BALANCE.b2.escapeDepth;
}

/** Climb out of the water. */
function escape(sim: SimState, ant: Ant): void {
  const nav = sim.nav as NavEx;
  const water = sim.water;
  if (ant.cell < 0 || ant.falling) {
    stop(ant);
    return;
  }
  if (!nav.isExposed(ant.cell) && followField(sim, ant, nav.skyField(), 1.2, 'fe.f')) return;
  // outside (or the field is no help): nearest dry cell, higher is better
  let goal = ant.mem['fe.g'] ?? -1;
  if (goal < 0 || !sim.nav.isWalkable(goal) || water.depthAt(goal) > 0.05 || sim.tick >= (ant.mem['fe.gu'] ?? 0)) {
    // final round: a rain puddle outdoors is often wider than 4 voxels — look further out there
    // (ants used to tread water in the middle of one until they drowned)
    const out = nav.isExposed(ant.cell);
    goal = bestCellNear(sim, ant, out ? 9 : 4, (cell, dx, dy, dz) => (water.depthAt(cell) > 0.05 || (out && (dy > 3 || dy < -3)) ? Infinity : dx * dx + dz * dz + dy * dy - dy * 3));
    ant.mem['fe.g'] = goal;
    ant.mem['fe.gu'] = sim.tick + 45;
  }
  if (goal >= 0) {
    sim.world.cellCenter(goal, _c);
    if (dist(ant.pos, _c) < 0.7) stop(ant);
    else if (approach(sim, ant, goal, null, 0.6, 1.2) === FAILED) steerTo(ant, _c, 1.2);
  } else {
    // nothing dry in reach: swim up
    _c.x = ant.pos.x;
    _c.y = ant.pos.y + 3;
    _c.z = ant.pos.z;
    steerTo(ant, _c, 1.2);
  }
}

export const floodEscapeBehavior: Behavior = {
  id: 'floodEscape',
  band: 'survival',
  score(ant, sim) {
    const water = sim.water;
    const B = BALANCE.b2;
    if (water.floodedCount === 0) return ant.mem['fe.b'] || (ant.mem['fe.u'] ?? 0) > sim.tick ? 0.5 : 0;
    const st = ant.infection.stage;
    if (st === 'gripped' || st === 'fruiting' || st === 'burst') return 0;
    const d = ant.cell >= 0 ? waterOver(sim, ant) : 0;
    if (d > B.escapeDepth) return 1 + d;
    if ((ant.mem['fe.u'] ?? 0) > sim.tick) return 0.9;
    if (ant.colony <= 0) return 0;
    const cs = envState(sim).colonyState(ant.colony);
    if (!cs.flooded || cs.refugeCell < 0) return 0;
    if (ant.carrying?.kind === 'brood') return 0.8;
    if (ant.caste === 'queen') {
      if (ant.pos.y >= cs.waterTop + B.broodMargin) return 0;
      sim.world.cellCenter(cs.refugeCell, _c);
      return dist(ant.pos, _c) > 2.5 ? 0.85 : 0;
    }
    if (ant.caste !== 'worker' || ant.carrying || !getExt(sim, ant.colony).active) return 0;
    if (ant.mem['fe.b']) return 0.7;
    if (cs.threatenedBrood.length === 0) return 0;
    const colony = sim.getColony(ant.colony);
    if (!colony || dist(ant.pos, colony.nestPos) > 28) return 0;
    return freeBrood(sim, cs, ant) ? 0.7 : 0;
  },
  run(ant, sim) {
    const B = BALANCE.b2;
    const mem = ant.mem;
    const cs = ant.colony > 0 ? envState(sim).colonyState(ant.colony) : null;
    const danger = inDanger(sim, ant);
    if (danger) mem['fe.u'] = sim.tick + Math.round(B.escapeLinger * 30);
    const tired = ant.submerged > B.swimSeconds * 30 * 0.6;

    // carrying rescued brood → the refuge
    if (ant.carrying?.kind === 'brood' && cs && cs.refugeCell >= 0 && cs.flooded) {
      let cell = mem['fe.c'] ?? -1;
      if (cell < 0 || mem['fe.r'] !== cs.refugeCell) {
        sim.world.cellCenter(cs.refugeCell, _c);
        cell = pileCell(sim, _c, 1.4, ant.carrying.id);
        if (cell < 0 || sim.water.depthAt(cell) > 0.05) cell = cs.refugeCell;
        mem['fe.c'] = cell;
        mem['fe.r'] = cs.refugeCell;
      }
      const r = approach(sim, ant, cell, null, 1.0, B.rescueSpeed);
      if (r === ARRIVED) {
        placeCarry(sim, ant, cell);
        mem['fe.b'] = 0;
        mem['fe.c'] = -1;
        ant.thinkAt = sim.tick;
      } else if (r === FAILED) {
        if (!danger) dropCarry(sim, ant);
        mem['fe.b'] = 0;
        mem['fe.c'] = -1;
      }
      return;
    }

    // the queen walks to the refuge
    if (ant.caste === 'queen' && cs && cs.flooded && cs.refugeCell >= 0 && !tired) {
      if (approach(sim, ant, cs.refugeCell, null, 1.5, 1.2) !== FAILED) return;
    }

    // rescuer
    if (cs && cs.flooded && cs.refugeCell >= 0 && ant.caste === 'worker' && !ant.carrying && !tired) {
      let b = mem['fe.b'] ? sim.getEntity(mem['fe.b']) : undefined;
      if (b && (b.kind !== 'brood' || b.carriedBy || !cs.threatenedBrood.includes(b.id))) b = undefined;
      if (!b) {
        const nb = freeBrood(sim, cs, ant);
        mem['fe.b'] = nb ? nb.id : 0;
        if (nb) claimsOf(sim).set(nb.id, ant.id);
        b = nb ?? undefined;
      }
      if (b && b.kind === 'brood') {
        const cell = b.cell >= 0 ? b.cell : sim.nav.nearestWalkable(b.pos.x, b.pos.y, b.pos.z, 3);
        const r = approach(sim, ant, cell, b.pos, 1.3, 1.15);
        if (r === ARRIVED) {
          pickUpBrood(sim, ant, b);
          mem['fe.c'] = -1;
        } else if (r === FAILED) mem['fe.b'] = 0;
        return;
      }
    } else if (tired) mem['fe.b'] = 0;

    if (danger || (mem['fe.u'] ?? 0) > sim.tick) escape(sim, ant);
    else stop(ant);
  },
  exit(ant) {
    ant.mem['fe.b'] = 0;
    ant.mem['fe.g'] = -1;
    ant.intent.mode = 'none';
  },
};
