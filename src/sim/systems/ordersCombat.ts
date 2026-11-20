import type { Ant, Creature, Entity, Mover, SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { getCreature } from '../data/creatures';
import { attack, bodyRadius, isFighter, isThreatCreature } from './combatCore';

/**
 * Melee entry points used by A2b's attack orders, Attack beacons and the possession bite.
 * Since B1 these are thin wrappers over the one combat resolution (`attack` in combatCore.ts):
 * reach, cooldown, armour, facing bonus, status effects, grappling, alarm and death are all
 * handled there. Signatures are unchanged from the M1 placeholder.
 *
 * Ordered ants also bite through the combat system's per-tick pass (any ant whose `targetId`
 * is a hostile in reach bites when its cooldown allows), so `biteTarget` failing because a big
 * creature's centre is farther away than A2b's fixed attack range is not a dead end.
 */

const _movers: Mover[] = [];

/** Something this ant may attack on the player's say-so. */
export function isHostile(ant: Ant, e: Entity | undefined): e is Ant | Extract<Entity, { kind: 'creature' }> {
  if (!e || !e.alive || e.id === ant.id) return false;
  if (e.kind === 'creature') return e.colony === 0 || e.colony !== ant.colony;
  if (e.kind === 'ant') return e.colony !== ant.colony || e.infection.stage !== 'none';
  return false;
}

/** Bite if off cooldown and in reach. Returns true if a bite landed. */
export function biteTarget(sim: SimState, attacker: Ant, target: Entity): boolean {
  if (!isFighter(target)) return false;
  // callers judged the range themselves with A2b's flat `attackRange`: allow for it
  return attack(sim, attacker, target, { slack: 0.35 }) > 0;
}

/**
 * Nearest hostile mover around a point (deterministic: distance, then id). Distance is measured
 * to the body surface, so big creatures are found from where an ant can actually stand.
 * Prey is only returned when nothing dangerous is there; livestock (aphids) never — orders can
 * still name either explicitly.
 */
export function nearestHostile(sim: SimState, ant: Ant, x: number, y: number, z: number, radius: number): Mover | null {
  sim.spatial.queryMovers(x, y, z, radius + BALANCE.b1.combat.bodyRadiusMax, _movers);
  let best: Mover | null = null;
  let bestD = Infinity;
  for (const m of _movers) {
    if (!isHostile(ant, m as Entity)) continue;
    const r = bodyRadius(m);
    if (Math.hypot(m.pos.x - x, m.pos.y - y, m.pos.z - z) - r > radius) continue;
    if (m.kind === 'creature' && getCreature((m as Creature).def).role === 'herd') continue; // never livestock
    const harmless = m.kind === 'creature' && !isThreatCreature(m as Creature);
    const d = Math.hypot(m.pos.x - ant.pos.x, m.pos.y - ant.pos.y, m.pos.z - ant.pos.z) - r + (harmless ? 1000 : 0);
    if (d < bestD || (d === bestD && best !== null && m.id < best.id)) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/** What a possessed ant would bite: the mover in front of its head (hostiles preferred). */
export function biteCandidate(sim: SimState, ant: Ant, range: number): Mover | null {
  const big = BALANCE.b1.combat.bodyRadiusMax;
  sim.spatial.queryMovers(ant.pos.x + ant.forward.x * range * 0.5, ant.pos.y + ant.forward.y * range * 0.5, ant.pos.z + ant.forward.z * range * 0.5, range + big, _movers);
  let best: Mover | null = null;
  let bestS = Infinity;
  for (const m of _movers) {
    if (m.id === ant.id || !m.alive) continue;
    const dx = m.pos.x - ant.pos.x;
    const dy = m.pos.y - ant.pos.y;
    const dz = m.pos.z - ant.pos.z;
    const d = Math.hypot(dx, dy, dz);
    const r = bodyRadius(m);
    if (d - r > range) continue;
    // behind the head? (big bodies fill more of the view)
    if (d > 1e-3 && (dx * ant.forward.x + dy * ant.forward.y + dz * ant.forward.z) / d < 0.2 - Math.min(0.6, r * 0.3)) continue;
    const s = d - r + (isHostile(ant, m as Entity) ? 0 : 10); // nestmates only if nothing else is there
    if (s < bestS) {
      bestS = s;
      best = m;
    }
  }
  return best;
}
