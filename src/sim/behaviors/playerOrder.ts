import type { Ant, Behavior, CellIndex, Entity, SimState, Task, Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { biteTarget, isHostile, nearestHostile } from '../systems/ordersCombat';
import { F_SCOUT, forageExit, runForage } from './forageCore';
import { ARRIVED, FAILED, approach, clearWorkAnim, dist, shuffle, stop } from './util';

function pop(ant: Ant, sim: SimState, task: Task): void {
  const i = ant.tasks.indexOf(task);
  if (i >= 0) ant.tasks.splice(i, 1);
  ant.intent.mode = 'none';
  ant.targetId = 0;
  clearWorkAnim(ant);
  ant.thinkAt = sim.tick; // next order, or back to duty, right away
}

/**
 * Chase a (possibly moving) entity. The path goal is only refreshed when the target has moved
 * away from it, so a fleeing target does not thrash the path queue.
 */
export function chase(sim: SimState, ant: Ant, target: { pos: Vec3; cell: CellIndex }, reach: number, key: string, speedMul = 1): number {
  const mem = ant.mem;
  let goal = mem[key] ?? -1;
  if (dist(ant.pos, target.pos) <= reach) {
    stop(ant);
    return ARRIVED;
  }
  let stale = goal < 0 || !sim.nav.isWalkable(goal);
  if (!stale) {
    const w = sim.world;
    const sxz = w.sx * w.sz;
    const gy = Math.floor(goal / sxz);
    const r = goal - gy * sxz;
    const gz = Math.floor(r / w.sx);
    const gx = r - gz * w.sx;
    stale = Math.hypot(gx + 0.5 - target.pos.x, gy + 0.5 - target.pos.y, gz + 0.5 - target.pos.z) > Math.max(2, reach);
  }
  if (stale) {
    goal = target.cell >= 0 && sim.nav.isWalkable(target.cell) ? target.cell : sim.nav.nearestWalkable(target.pos.x, target.pos.y, target.pos.z, 4, ant.clearance);
    mem[key] = goal;
  }
  if (goal < 0) return FAILED;
  const r = approach(sim, ant, goal, null, 0.6, speedMul);
  // at the goal cell but the target is still out of reach (it moved): refresh next tick
  if (r === ARRIVED) mem[key] = -1;
  return r === FAILED ? FAILED : 0;
}

/** Close in on a hostile and bite it (minimal combat until B1; see systems/ordersCombat.ts). */
export function engage(sim: SimState, ant: Ant, target: Entity & { pos: Vec3; cell: CellIndex }, key: string): number {
  ant.targetId = target.id;
  const r = chase(sim, ant, target, BALANCE.a2b.attackRange, key, 1.15);
  if (r === ARRIVED) biteTarget(sim, ant, target);
  if (ant.anim === 'bite' && sim.tick - (ant.mem['bite.t'] ?? 0) > 8) ant.anim = 'idle';
  return r;
}

/**
 * Executes `source:'player'` tasks at the head of the queue (§5.2 band `player`), and makes
 * recruited ants (`followId`, set by the possession "recruit" action) follow their leader.
 *
 *   move    path to the cell, then pop
 *   gather  work the target food (or the food nearest the clicked point) until it is exhausted,
 *           hauling loads home and laying trail like any forager, then pop
 *   attack  chase the target and bite it until it is dead, then pop; without a target
 *           (attack-move) go to the point and fight whatever hostile is near it
 *   guard   hold the position (persistent); bite hostiles that come close
 *   follow  stay near the target ant (persistent while it lives)
 *   exile   walk to the exile spot and stay there for good (persistent; no duties)
 * When the player queue is empty the brain falls through to the duty band: the ant resumes the
 * colony task it had (still in its queue) or picks a new one.
 */
export const playerOrderBehavior: Behavior = {
  id: 'playerOrder',
  band: 'player',
  score(ant, sim) {
    if (ant.tasks.length > 0 && ant.tasks[0].source === 'player') return 1;
    return ant.followId && sim.getAnt(ant.followId) ? 0.9 : 0;
  },
  run(ant, sim, dt) {
    const task = ant.tasks[0];
    const B = BALANCE.a2b;
    if (!task || task.source !== 'player') {
      const leader = ant.followId ? sim.getAnt(ant.followId) : undefined;
      if (!leader) {
        ant.followId = 0;
        stop(ant);
        return;
      }
      chase(sim, ant, leader, B.followDistance + (ant.id % 3) * 0.5, 'po.g', 1.25);
      return;
    }
    switch (task.kind) {
      case 'move': {
        if (task.cell < 0) return pop(ant, sim, task);
        const r = approach(sim, ant, task.cell, null, 0.7);
        if (r !== 0) pop(ant, sim, task);
        return;
      }
      case 'gather': {
        // no specific food given: walk to the point first, then search from there
        if (!task.targetId && task.data === 0 && !ant.carrying) {
          const r = approach(sim, ant, task.cell, null, 2.5);
          if (r === 0) return;
          task.data = 1;
          task.phase = F_SCOUT;
          ant.mem['f.t0'] = sim.tick - Math.round(B.scoutTime * 30 * 0.7);
        }
        task.data = 1;
        if (runForage(sim, ant, task, dt, true)) {
          forageExit(ant);
          pop(ant, sim, task);
        }
        return;
      }
      case 'attack': {
        let target = task.targetId ? sim.getEntity(task.targetId) : undefined;
        if (task.targetId && (!target || (target.kind !== 'ant' && target.kind !== 'creature'))) return pop(ant, sim, task);
        if (!target) {
          // attack-move
          const h = task.pos ? nearestHostile(sim, ant, task.pos.x, task.pos.y, task.pos.z, 6) : null;
          if (h) target = h as Entity;
          else {
            const r = approach(sim, ant, task.cell, null, 1.5);
            if (r !== 0) pop(ant, sim, task);
            return;
          }
        }
        if (target.kind !== 'ant' && target.kind !== 'creature') return pop(ant, sim, task);
        if (!target.alive) return pop(ant, sim, task);
        // An attack order ends when the target is dead, has run off beyond the leash from where
        // the order was given, or has stayed out of reach for too long (unreachable, or a
        // fleeing target it cannot catch) — the ant then goes back to its duties.
        const mem = ant.mem;
        if (mem['po.tid'] !== task.id) {
          mem['po.tid'] = task.id;
          mem['po.near'] = sim.tick;
        }
        if (dist(ant.pos, target.pos) <= B.attackRange + 1.5) mem['po.near'] = sim.tick;
        const anchor = task.targetId ? task.pos : null;
        if ((anchor && dist(target.pos, anchor) > B.attackLeash) || sim.tick - (mem['po.near'] ?? sim.tick) > B.attackGiveUp * 30) return pop(ant, sim, task);
        const r = engage(sim, ant, target, 'po.g');
        if (r === FAILED && ++task.phase > 3) pop(ant, sim, task);
        return;
      }
      case 'guard': {
        const h = task.pos ? nearestHostile(sim, ant, task.pos.x, task.pos.y, task.pos.z, 5) : null;
        if (h) {
          engage(sim, ant, h as Entity & { pos: Vec3; cell: CellIndex }, 'po.g');
          return;
        }
        ant.targetId = 0;
        if (task.cell >= 0 && task.pos && dist(ant.pos, task.pos) > B.guardLeash) {
          if (approach(sim, ant, task.cell, null, 0.8) === FAILED) task.pos = { x: ant.pos.x, y: ant.pos.y, z: ant.pos.z }; // hold here instead
        } else shuffle(sim, ant, dt, 'po', 0.12, 0.2);
        return;
      }
      case 'follow': {
        const target = sim.getEntity(task.targetId);
        if (!target || (target.kind !== 'ant' && target.kind !== 'creature')) return pop(ant, sim, task);
        chase(sim, ant, target, B.followDistance, 'po.g', 1.15);
        return;
      }
      case 'exile': {
        ant.mem['exiled'] = 1;
        if (task.cell >= 0 && task.pos && dist(ant.pos, task.pos) > 2.5) {
          if (approach(sim, ant, task.cell, null, 1.5) === FAILED) task.cell = -1;
        } else shuffle(sim, ant, dt, 'po', 0.2, 0.25);
        return;
      }
      default:
        // kinds no order produces (or that another stream owns): do not jam the queue
        if (task.cell >= 0) {
          const r = approach(sim, ant, task.cell, null, 0.8);
          if (r === 0) return;
        }
        pop(ant, sim, task);
    }
  },
  exit(ant) {
    ant.intent.mode = 'none';
    ant.targetId = 0;
    ant.mem['po.g'] = -1;
    clearWorkAnim(ant);
  },
};
