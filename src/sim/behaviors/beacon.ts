import { v3, v3clone, type Ant, type Beacon, type Behavior, type CellIndex, type Colony, type Entity, type SimState, type Vec3 } from '../../core';
import { makeTask } from '../entities';
import { dutyTask, hasPlayerTask, removeTask } from '../systems/colonyState';
import { hasSpoil, runDigDuty, runSpoilHaul, stopDigDuty } from '../systems/dig';
import { inAvoidZone } from '../systems/jobsBoard';
import { nearestHostile } from '../systems/ordersCombat';
import { F_SCOUT, forageExit, runForage } from './forageCore';
import { engage } from './playerOrder';
import { approach, clearWorkAnim, dist, shuffle, steer } from './util';

const _d = v3();

function assigned(ant: Ant, colony: Colony): Beacon | undefined {
  const id = ant.mem['beacon'];
  if (!id) return undefined;
  for (const b of colony.beacons) if (b.id === id) return b;
  return undefined;
}

/**
 * Player beacons (§5.4). The jobs system deposits each beacon's pheromone channel over its
 * radius and assigns nearby ants up to a quota (`ant.mem.beacon`); this behavior makes them act:
 *
 *   Gather  go there and forage around it (food found is worked with normal trail laying)
 *   Dig     go there and excavate the dig designations inside it
 *   Rally   assemble and hold there
 *   Attack  assemble there and fight any hostile inside the radius
 *   Avoid   (no assignment) every ant without a direct order that finds itself inside walks out;
 *           scouts steer around the `avoid` scent and the job board ignores work inside it
 * Direct player orders outrank beacons (score 1 vs 0.8 in the same band).
 */
export const beaconBehavior: Behavior = {
  id: 'beacon',
  band: 'player',
  score(ant, sim) {
    const colony = sim.getColony(ant.colony);
    if (!colony || colony.beacons.length === 0) return 0;
    if (assigned(ant, colony)) return 0.8;
    return !hasPlayerTask(ant) && inAvoidZone(colony, ant.pos) ? 0.85 : 0;
  },
  run(ant, sim, dt) {
    const colony = sim.getColony(ant.colony);
    if (!colony) return;
    const b = assigned(ant, colony);
    if (!b) {
      const av = inAvoidZone(colony, ant.pos);
      if (!av) {
        ant.thinkAt = sim.tick;
        return;
      }
      // walk straight out (the surface projection keeps the ant on the ground)
      _d.x = ant.pos.x - av.pos.x;
      _d.y = (ant.pos.y - av.pos.y) * 0.3;
      _d.z = ant.pos.z - av.pos.z;
      if (Math.abs(_d.x) + Math.abs(_d.z) < 1e-3) _d.x = 1;
      steer(ant, _d, 1.2);
      return;
    }
    const d = dist(ant.pos, b.pos);
    switch (b.kind) {
      case 'rally': {
        if (d > b.radius * 0.6) approach(sim, ant, b.cell, b.pos, b.radius * 0.5, 1.15);
        else shuffle(sim, ant, dt, 'bc', 0.3, 0.3);
        return;
      }
      case 'attack': {
        const h = nearestHostile(sim, ant, b.pos.x, b.pos.y, b.pos.z, b.radius + 2);
        if (h) engage(sim, ant, h as Entity & { pos: Vec3; cell: CellIndex }, 'po.g');
        else if (d > b.radius * 0.6) approach(sim, ant, b.cell, b.pos, b.radius * 0.5, 1.15);
        else shuffle(sim, ant, dt, 'bc', 0.4, 0.4);
        return;
      }
      case 'dig': {
        if (hasSpoil(ant)) {
          runSpoilHaul(sim, ant);
          return;
        }
        if (d > b.radius + 3) {
          approach(sim, ant, b.cell, b.pos, b.radius, 1);
          return;
        }
        const des = colony.designations.find((x) => x.kind === 'dig' && dist(x.center, b.pos) < b.radius + 2);
        if (!des) {
          clearWorkAnim(ant);
          shuffle(sim, ant, dt, 'bc', 0.3, 0.3);
          return;
        }
        const st = runDigDuty(sim, ant, dt, { designationId: des.id });
        if (st === 'done' || st === 'idle') shuffle(sim, ant, dt, 'bc', 0.5, 0.4);
        return;
      }
      case 'gather': {
        let t = dutyTask(ant);
        if (t && t.kind !== 'gather') t = undefined; // another duty waits in the queue; resume it later
        if (!t) {
          if (dutyTask(ant)) {
            // holds an unrelated duty task: just assemble at the beacon
            if (d > b.radius * 0.6) approach(sim, ant, b.cell, b.pos, b.radius * 0.5);
            else shuffle(sim, ant, dt, 'bc', 0.4, 0.4);
            return;
          }
          if (d > b.radius * 0.7 && !ant.carrying) {
            approach(sim, ant, b.cell, b.pos, b.radius * 0.5);
            return;
          }
          t = makeTask(sim, 'gather', 'self', { phase: F_SCOUT, pos: v3clone(b.pos) });
          ant.tasks.push(t);
          ant.mem['f.t0'] = sim.tick;
        }
        // keep the search on the beacon
        if (t.phase === F_SCOUT && d > b.radius) {
          approach(sim, ant, b.cell, b.pos, b.radius * 0.5);
          ant.mem['f.t0'] = sim.tick;
          return;
        }
        if (runForage(sim, ant, t, dt, true)) {
          removeTask(ant, t);
          forageExit(ant);
        }
        return;
      }
      default:
        ant.mem['beacon'] = 0;
    }
  },
  exit(ant, sim) {
    stopDigDuty(sim, ant);
    ant.intent.mode = 'none';
    ant.targetId = 0;
    clearWorkAnim(ant);
  },
};
