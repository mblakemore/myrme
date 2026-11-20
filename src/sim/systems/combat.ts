import { COMBAT_MEM, HOME_UNREACHABLE, type Ant, type Creature, type Mover, type SimState, type SimSystem } from '../../core';
import { BALANCE } from '../data/balance';
import { alertOnce } from './colonyState';
import {
  SPEED_MEM,
  attack,
  bodyRadius,
  distance,
  getCombat,
  grappleHold,
  grappleWeight,
  hasAnyStatus,
  hurt,
  inReach,
  isEnemy,
  isFighter,
  perceivedThreat,
  powerOf,
  presenceAt,
  rebuildPresence,
  statusSpeed,
  type Fighter,
} from './combatCore';

/**
 * Combat system (B1) — the per-tick half of melee (the resolution itself is `attack` in
 * combatCore.ts):
 *
 *  1. presence grid        coarse "who is around" map that gates every perception query
 *  2. bites                every unpossessed ant with a hostile `targetId` in reach and its
 *                          cooldown over bites it — whichever behavior set the target (fight,
 *                          guard, raid, A2b's attack orders and beacons). Ants without a target
 *                          snap at enemies that come within reach (followers, ordered ants).
 *  3. grappling            latched ants → load per victim → speed multiplier / pinned flag
 *  4. status effects       poison ticks, slow / glue / stun timers, `Creature.stunned`
 *  5. recovery             ants resting in the nest heal; creatures out of combat heal slowly
 *  6. alarm calls          expiry and the power estimates workers use to join or run
 *  7. alerts               `queenInDanger` when an enemy closes in on the player's queen
 *
 * Runs after movement (so reach is judged on this tick's positions) and before `pheromone`.
 */

const C = BALANCE.b1.combat;
const MY_BEHAVIORS: Readonly<Record<string, 1>> = { fight: 1, flee: 1, guard: 1, raid: 1 };
const _near: Mover[] = [];
const _grappled: Fighter[] = [];

function hostileTarget(sim: SimState, ant: Ant, id: number): Fighter | null {
  const e = sim.getEntity(id);
  if (!isFighter(e) || e === ant) return null;
  if (e.kind === 'ant') return e.colony !== ant.colony || e.infection.stage !== 'none' ? e : null;
  return e.colony !== 0 && e.colony === ant.colony ? null : e;
}

/** Enemy within mandible reach of an ant that has nothing better to bite. */
function snapTarget(sim: SimState, ant: Ant): Fighter | null {
  sim.spatial.queryMovers(ant.pos.x, ant.pos.y, ant.pos.z, C.biteReach + C.bodyRadiusMax + 0.6, _near);
  let best: Fighter | null = null;
  let bestD = Infinity;
  for (const m of _near) {
    if (m === ant || !m.alive || !isEnemy(sim, ant, m)) continue;
    const f = m as Fighter;
    if (!inReach(ant, f)) continue;
    const d = distance(ant.pos, f.pos) - bodyRadius(f);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

function updateAnts(sim: SimState): void {
  const tick = sim.tick;
  const st = getCombat(sim);
  const ants = sim.ants;
  const regenQuiet = C.regenQuiet * 30;
  for (let i = 0; i < ants.length; i++) {
    const ant = ants[i];
    if (!ant.alive) continue;
    const mem = ant.mem;

    // ---- bites ----
    if (!ant.possessed && tick >= ant.attackReadyAt && !ant.falling) {
      let target: Fighter | null = ant.targetId ? hostileTarget(sim, ant, ant.targetId) : null;
      if (target && !inReach(ant, target)) target = null;
      if (!target && (tick + ant.id) % 4 === 0 && ant.carrying?.kind !== 'brood' && presenceAt(sim, ant.pos, ant.colony) !== 0) {
        const keep = ant.targetId;
        target = snapTarget(sim, ant);
        if (target) {
          attack(sim, ant, target);
          // a reflex bite must not hijack the target a behavior is steering for
          if (keep && ant.alive) ant.targetId = keep;
          target = null;
        }
      }
      if (target) attack(sim, ant, target);
    }
    if (ant.anim === 'bite' && !ant.possessed && MY_BEHAVIORS[ant.behavior] === 1 && tick - (mem[COMBAT_MEM.attackTick] ?? 0) > 8) ant.anim = 'idle';

    // ---- grapple bookkeeping (attacker side) ----
    const latch = mem[COMBAT_MEM.latchId];
    if (latch) {
      const v = (mem[COMBAT_MEM.latchUntil] ?? 0) > tick ? sim.getEntity(latch) : undefined;
      if (!isFighter(v) || distance(ant.pos, v.pos) > bodyRadius(v) + bodyRadius(ant) + C.biteReach + C.latchBreakDist) mem[COMBAT_MEM.latchId] = 0;
      else {
        st.loads.set(v.id, (st.loads.get(v.id) ?? 0) + grappleWeight(ant));
        st.counts.set(v.id, (st.counts.get(v.id) ?? 0) + 1);
      }
    }

    // ---- recovery in the nest ----
    if ((tick + ant.id) % 30 === 0 && ant.health < ant.maxHealth && tick - (mem[COMBAT_MEM.hitTick] ?? -100000) > regenQuiet && ant.cell >= 0) {
      const steps = sim.nav.homeDistance(ant.colony, ant.cell);
      if (steps !== HOME_UNREACHABLE && steps <= C.regenHomeSteps) ant.health = Math.min(ant.maxHealth, ant.health + C.regenPerSec);
    }
  }
}

function setSpeed(st: ReturnType<typeof getCombat>, f: Fighter, mul: number): void {
  if (mul >= 0.999) {
    if (f.mem[SPEED_MEM] !== undefined) delete f.mem[SPEED_MEM];
    st.slowed.delete(f.id);
  } else {
    f.mem[SPEED_MEM] = mul;
    st.slowed.add(f.id);
  }
}

function updateGrappleAndStatus(sim: SimState): void {
  const tick = sim.tick;
  const st = getCombat(sim);

  // victims of a grapple
  _grappled.length = 0;
  for (const [id, load] of st.loads) {
    const v = sim.getEntity(id);
    if (!isFighter(v)) continue;
    const hold = grappleHold(v);
    const pinned = load >= hold;
    v.mem[COMBAT_MEM.latchers] = st.counts.get(id) ?? 0;
    v.mem[COMBAT_MEM.pinned] = pinned ? 1 : 0;
    const g = pinned ? 0 : Math.max(C.grappleMinSpeed, 1 - load / hold);
    setSpeed(st, v, g * statusSpeed(v.mem, tick));
    _grappled.push(v);
  }

  // status effects
  for (const id of st.afflicted) {
    const e = sim.getEntity(id);
    if (!isFighter(e)) {
      st.afflicted.delete(id);
      continue;
    }
    const m = e.mem;
    if ((m[COMBAT_MEM.poison] ?? 0) > tick && (tick + id) % 15 === 0) {
      if (hurt(sim, e, (m[COMBAT_MEM.poisonDps] ?? 0) * 0.5)) continue;
    }
    if (!hasAnyStatus(m, tick)) {
      st.afflicted.delete(id);
      m[COMBAT_MEM.poisonDps] = 0;
    }
    if (!st.loads.has(id)) setSpeed(st, e, statusSpeed(m, tick));
  }

  // movers that were slowed last tick but are neither grappled nor afflicted any more
  for (const id of st.slowed) {
    if (st.loads.has(id) || st.afflicted.has(id)) continue;
    const e = sim.getEntity(id);
    st.slowed.delete(id);
    if (!isFighter(e)) continue;
    delete e.mem[SPEED_MEM];
    e.mem[COMBAT_MEM.latchers] = 0;
    e.mem[COMBAT_MEM.pinned] = 0;
  }
  // victims whose last attacker let go while they still carry a status keep the status speed
  for (const id of st.afflicted) {
    if (st.loads.has(id)) continue;
    const e = sim.getEntity(id);
    if (isFighter(e) && (e.mem[COMBAT_MEM.latchers] ?? 0) > 0) {
      e.mem[COMBAT_MEM.latchers] = 0;
      e.mem[COMBAT_MEM.pinned] = 0;
    }
  }
  st.loads.clear();
  st.counts.clear();
}

function updateCreatures(sim: SimState): void {
  const tick = sim.tick;
  for (const c of sim.creatures) {
    if (!c.alive) continue;
    const m = c.mem;
    const stuck = Math.max(m[COMBAT_MEM.glued] ?? 0, m[COMBAT_MEM.stunned] ?? 0) - tick;
    c.stunned = stuck > 0 ? stuck : m[COMBAT_MEM.pinned] === 1 ? 1 : 0;
    if ((tick + c.id) % 30 === 0 && c.health < c.maxHealth && tick - (m[COMBAT_MEM.hitTick] ?? -100000) > C.regenQuiet * 30) {
      c.health = Math.min(c.maxHealth, c.health + c.maxHealth * C.creatureRegen);
    }
  }
}

function updateCalls(sim: SimState): void {
  const st = getCombat(sim);
  const calls = st.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call.until <= sim.tick) {
      calls.splice(i, 1);
      continue;
    }
    sim.spatial.queryMovers(call.pos.x, call.pos.y, call.pos.z, BALANCE.b1.fight.oddsRadius + 2, _near);
    let ally = 0;
    let enemy = 0;
    for (const m of _near) {
      if (!m.alive) continue;
      if (m.kind === 'ant') {
        const a = m as Ant;
        if (a.colony === call.colony) ally += powerOf(a);
        else enemy += powerOf(a);
      } else {
        const c = m as Creature;
        if (c.colony !== call.colony && (call.kind === 'prey' ? c.id === call.threatId : perceivedThreat(sim, call.colony, c))) enemy += powerOf(c);
      }
    }
    call.allyPower = ally;
    call.enemyPower = enemy;
    // nothing left to fight: let the call lapse quickly
    if (enemy === 0 && call.until - sim.tick > 45) call.until = sim.tick + 45;
  }
}

function queenWatch(sim: SimState): void {
  const colony = sim.getColony(sim.playerColony);
  const queen = colony?.queenId ? sim.getAnt(colony.queenId) : undefined;
  if (!colony || !queen || presenceAt(sim, queen.pos, colony.id) === 0) return;
  sim.spatial.queryMovers(queen.pos.x, queen.pos.y, queen.pos.z, C.queenDangerRadius, _near);
  for (const m of _near) {
    if (m !== queen && m.alive && isEnemy(sim, queen, m)) {
      alertOnce(sim, colony, 'queenInDanger', 'Enemies are closing in on the queen', queen.pos, m.id, 30);
      return;
    }
  }
}

export const combatSystem: SimSystem = {
  id: 'combat',
  init(sim) {
    getCombat(sim);
    rebuildPresence(sim);
  },
  update(sim) {
    const st = getCombat(sim);
    if (sim.tick - st.gridTick >= 3) rebuildPresence(sim);
    updateAnts(sim);
    updateGrappleAndStatus(sim);
    updateCreatures(sim);
    if (st.calls.length > 0 && sim.tick % 10 === 0) updateCalls(sim);
    if (sim.tick % 30 === 7) queenWatch(sim);
  },
};

/** Counters for tests / debug overlays. */
export function combatStats(sim: SimState) {
  const st = getCombat(sim);
  return { ...st.stats, calls: st.calls.length, afflicted: st.afflicted.size, slowed: st.slowed.size };
}
