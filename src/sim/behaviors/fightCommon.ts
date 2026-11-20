import type { Ant, SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { bodyRadius, distance, isAirborne, meleeReach, type Fighter } from '../systems/combatCore';
import { chase } from './playerOrder';
import { ARRIVED, FAILED, MOVING, dropCarry, steerTo } from './util';

/** Shared melee footwork of the fight / guard / raid behaviors (B1). */

const F = BALANCE.b1.fight;

/** `mem` key: tick of the latest melee footwork step (movement reads it for fighter separation). */
export const MELEE_MEM = 'ft.m';

/** Turn the head towards `p` without moving (forward stays in the ant's tangent plane). */
function faceTo(ant: Ant, p: { x: number; y: number; z: number }): void {
  let dx = p.x - ant.pos.x;
  let dy = p.y - ant.pos.y;
  let dz = p.z - ant.pos.z;
  const n = dx * ant.up.x + dy * ant.up.y + dz * ant.up.z;
  dx -= ant.up.x * n;
  dy -= ant.up.y * n;
  dz -= ant.up.z * n;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-3) return;
  const f = ant.forward;
  const k = 0.3;
  const fx = f.x + (dx / l - f.x) * k;
  const fy = f.y + (dy / l - f.y) * k;
  const fz = f.z + (dz / l - f.z) * k;
  const fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-3) return;
  f.x = fx / fl;
  f.y = fy / fl;
  f.z = fz / fl;
}

/** Stop treating `id` as a target for a while (unreachable, out of leash). */
export function ignoreTarget(sim: SimState, ant: Ant, id: number): void {
  ant.mem['ft.no'] = id;
  ant.mem['ft.noT'] = sim.tick + Math.round(F.ignoreTime * 30);
  if (ant.targetId === id) ant.targetId = 0;
}

/**
 * Close in on `target` and stay on it. Biting itself is done by the combat system as soon as
 * the target is in reach (see systems/combat.ts), so this only has to set `targetId` and steer:
 * straight at the enemy when it is near (responsive, no path queue), through A* when it is far
 * or something is in the way. ARRIVED = in mandible reach; FAILED = cannot get there.
 */
export function fightStep(sim: SimState, ant: Ant, target: Fighter, speedMul: number = F.chaseSpeed): number {
  ant.targetId = target.id;
  if (ant.carrying && ant.carrying.kind !== 'brood') dropCarry(sim, ant);
  const reach = meleeReach(ant, target);
  const d = distance(ant.pos, target.pos);
  // melee footwork flag: movement keeps a firm separation between fighters (see moveSurface)
  ant.mem[MELEE_MEM] = sim.tick;
  if (d <= reach * 0.92) {
    ant.mem['ft.s'] = 0;
    if (target.kind === 'ant') {
      // ant against ant: hold a ring slot at mandible distance (heads meeting, bodies apart) and
      // let the separation push sort the attackers around the victim — no pressing into a pile
      const hold = Math.min(reach * 0.8, (bodyRadius(ant) + bodyRadius(target)) * F.holdPerRadii);
      if (d > hold * 1.12) steerTo(ant, target.pos, 0.3);
      else {
        ant.intent.mode = 'none';
        faceTo(ant, target.pos);
      }
      return ARRIVED;
    }
    // big bodies: keep the head on it and press in a little (the bite needs no more)
    steerTo(ant, target.pos, d > reach * 0.6 ? 0.3 : 0.04);
    return ARRIVED;
  }
  if (target.kind === 'creature' && isAirborne(sim, target)) {
    ant.intent.mode = 'none';
    return FAILED;
  }
  const mem = ant.mem;
  if (d <= 7 && !((mem['ft.p'] ?? 0) > sim.tick)) {
    const slow = mem['ft.s'] ?? 0;
    if (slow > F.flankAfterTicks && d < 4) {
      // somebody is in the way: swing round the target to a free side instead of shoving
      const side = ant.id & 1 ? 1 : -1;
      const dx = target.pos.x - ant.pos.x;
      const dy = target.pos.y - ant.pos.y;
      const dz = target.pos.z - ant.pos.z;
      const it = ant.intent;
      it.mode = 'dir';
      it.dir.x = dx * 0.45 + (ant.up.y * dz - ant.up.z * dy) * side;
      it.dir.y = dy * 0.45 + (ant.up.z * dx - ant.up.x * dz) * side;
      it.dir.z = dz * 0.45 + (ant.up.x * dy - ant.up.y * dx) * side;
      it.speedMul = speedMul * 0.8;
    } else steerTo(ant, target.pos, speedMul);
    if (ant.moveSpeed < ant.speed * 0.25) {
      const s = slow + 1;
      mem['ft.s'] = s;
      if (s > 45) {
        mem['ft.s'] = 0;
        mem['ft.p'] = sim.tick + 90; // something is in the way: path for a while
      }
    } else mem['ft.s'] = 0;
    return MOVING;
  }
  const r = chase(sim, ant, target, reach * 0.92, 'ft.g', speedMul);
  if (r === FAILED) {
    ignoreTarget(sim, ant, target.id);
    return FAILED;
  }
  return r === ARRIVED ? ARRIVED : MOVING;
}

/** Forget fight-private movement memory (behavior exit). */
export function fightExit(ant: Ant): void {
  const mem = ant.mem;
  mem['ft.on'] = 0;
  mem['ft.g'] = -1;
  mem['ft.s'] = 0;
  mem['ft.p'] = 0;
  ant.targetId = 0;
  ant.intent.mode = 'none';
  if (ant.anim === 'bite') ant.anim = 'idle';
}
