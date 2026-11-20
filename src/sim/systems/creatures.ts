import {
  COMBAT_MEM,
  CREATURE_MEM,
  Phero,
  getMapExtras,
  v3,
  v3clone,
  v3rotateAbout,
  type Ant,
  type CellIndex,
  type ColonyId,
  type Creature,
  type CreatureId,
  type Mover,
  type Rng,
  type SimState,
  type SimSystem,
  type Vec3,
} from '../../core';
import { dropCarry } from '../behaviors/util';
import { BALANCE } from '../data/balance';
import { getCreature } from '../data/creatures';
import { applyStatus, attack, bodyRadius, distance, healthFrac, hurt, isAirborne, meleeReach, powerOf, shakeOff, type AttackOpts, type Fighter } from './combatCore';
import { registerSpeedModifier } from './movement';
import { navOf } from './paths';

/**
 * Creature AI (B1). One small state machine per creature kind over the contract's
 * `Creature.state` plus the `CREATURE_MEM` keys (see contracts/b1.ts — `creatureAnim` turns both
 * into an animation state for the renderer).
 *
 *   jumpingSpider  idle (lair, hidden) → roam → stalk → attack (pounce, then melee) →
 *                  flee (to the lair: with a catch, or when mobbed / hurt) → idle
 *   antlion        ambush (hidden in its pit; ants on the slope slide in and are grabbed)
 *   groundBeetle   idle (home) → roam (to a nest entrance) → attack (carriers, food) → flee (home)
 *   wasp           roam (cruise) → stalk (line up) → attack (swoop) → flee (climb / leave)
 *   mantis         roam (towards ant activity) → attack (slow turn, lethal strike in its front cone)
 *   caterpillar, worm   roam; bitten → thrash (shakes attackers off, hurts them) → flee
 *   aphid          untouched here (B3's `aphids` system)
 *
 * Perception is range + line of sight (`world.raycast`). Predators hunt ants of every colony
 * and, failing that, creatures carrying the generic prey tag (`mem.prey = 1`, or role `herd`).
 * Resident predators of a map sleep in their lair (`sleepUntil`) until the director wakes them;
 * the antlion and the prey animals are always active (they are part of the terrain).
 * All randomness comes from a forked, seeded stream.
 */

const T = BALANCE.b1.creatures;
const M = CREATURE_MEM;

interface Pit {
  id: number;
  pos: Vec3;
  radius: number;
  /** M3: slope cells registered as a nav hazard. */
  marked?: boolean;
}

interface CreaturesState {
  rng: Rng;
  pits: Pit[];
  spawned: boolean;
}

const states = new WeakMap<SimState, CreaturesState>();

function getState(sim: SimState): CreaturesState {
  let s = states.get(sim);
  if (!s) {
    s = { rng: sim.rng.fork('creatures'), pits: [], spawned: false };
    states.set(sim, s);
    // crumbling slope: ants inside an antlion pit crawl slowly
    registerSpeedModifier(sim, (m, sm) => (m.kind === 'ant' && ((m as Ant).mem['pit'] ?? -9) >= sm.tick - 1 ? T.antlion.slopeSpeed : 1));
  }
  return s;
}

const _near: Mover[] = [];
const _d = v3();
const _o = v3();
const _p = v3();

// =====================================================================================
// spawning
// =====================================================================================

export interface SpawnOpts {
  /** Stay dormant in the lair until woken (resident predators). */
  asleep?: boolean;
  /** Leave the map this many seconds after spawning (director visitors). 0 = stays. */
  stay?: number;
  /** Site radius (pit / lair). */
  radius?: number;
}

/** Spawn a creature the way this system expects it (home, timers, flags). Used by the director too. */
export function spawnCreatureAt(sim: SimState, def: CreatureId, pos: Vec3, opts: SpawnOpts = {}): Creature {
  const st = getState(sim);
  const c = sim.spawnCreature(def, pos);
  const m = c.mem;
  c.home = v3clone(c.pos);
  m[M.siteRadius] = opts.radius ?? 0;
  m['c.born'] = sim.tick;
  if (opts.asleep) {
    m[M.sleepUntil] = 1e9;
    m[M.hidden] = 1;
  }
  if (opts.stay) m['c.leaveAt'] = sim.tick + Math.round(opts.stay * 30);
  if (def === 'antlion') {
    c.state = 'ambush';
    m[M.hidden] = 1;
    st.pits.push({ id: c.id, pos: v3clone(c.pos), radius: opts.radius && opts.radius > 1 ? opts.radius : T.antlion.pitRadius });
  } else if (def === 'wasp') {
    c.state = 'roam';
    m['w.pass'] = 0;
  } else c.state = opts.asleep ? 'idle' : 'roam';
  return c;
}

/** Wake a dormant resident (director). Returns false if it was not asleep. */
export function wakeCreature(sim: SimState, c: Creature): boolean {
  if (!c.alive || !((c.mem[M.sleepUntil] ?? 0) > sim.tick)) return false;
  c.mem[M.sleepUntil] = 0;
  c.mem[M.hidden] = 0;
  c.state = 'roam';
  return true;
}

export function isAsleep(sim: SimState, c: Creature): boolean {
  return (c.mem[M.sleepUntil] ?? 0) > sim.tick;
}

function spawnResidents(sim: SimState): void {
  const st = getState(sim);
  if (st.spawned || sim.options.fixture !== 'none') return;
  st.spawned = true;
  const sites = getMapExtras(sim.map)?.sites ?? [];
  for (const sp of sim.map.spawns) {
    if (sp.kind !== 'creature' || !sp.creature) continue;
    const def = sp.creature;
    // aphids belong to B3's system; the boss only comes when the director calls it
    if (def === 'aphid' || def === 'mantis' || def === 'wasp') continue;
    let radius = sp.radius;
    if (def === 'antlion') {
      for (const s of sites) if (s.kind === 'antlionPit' && distance(s.pos, sp.pos) < 4) radius = s.radius;
    }
    const role = getCreature(def).role;
    spawnCreatureAt(sim, def, sp.pos, { asleep: role === 'hunter' || role === 'tank', radius });
  }
}

// =====================================================================================
// shared helpers
// =====================================================================================

function setDir(c: Creature, x: number, y: number, z: number, speedMul: number): void {
  const it = c.intent;
  it.mode = 'dir';
  it.dir.x = x;
  it.dir.y = y;
  it.dir.z = z;
  it.speedMul = speedMul;
}

function halt(c: Creature): void {
  c.intent.mode = 'none';
}

/**
 * Walk a surface creature towards a point: straight when it is near, through the path queue
 * (clearance-aware) when it is far or the straight line is blocked. Returns true on arrival.
 */
function travel(sim: SimState, c: Creature, to: Vec3, reach: number, speedMul: number): boolean {
  const d = distance(c.pos, to);
  if (d <= reach) {
    halt(c);
    return true;
  }
  const m = c.mem;
  if (d < 9 && !((m['c.pth'] ?? 0) > sim.tick)) {
    setDir(c, to.x - c.pos.x, to.y - c.pos.y, to.z - c.pos.z, speedMul);
    if (c.moveSpeed < c.speed * speedMul * 0.2 && !(c.stunned > 0)) {
      const s = (m['c.stk'] ?? 0) + 1;
      m['c.stk'] = s;
      if (s > 30) {
        m['c.stk'] = 0;
        m['c.pth'] = sim.tick + 150;
      }
    } else m['c.stk'] = 0;
    return false;
  }
  let goal = m['c.goal'] ?? -1;
  if (goal >= 0) {
    sim.world.cellCenter(goal, _p);
    if (distance(_p, to) > 3.5 || !sim.nav.isWalkable(goal, c.clearance)) goal = -1;
  }
  if (goal < 0) {
    goal = sim.nav.nearestWalkable(to.x, to.y, to.z, 7, c.clearance);
    m['c.goal'] = goal;
  }
  if (goal < 0) {
    setDir(c, to.x - c.pos.x, to.y - c.pos.y, to.z - c.pos.z, speedMul);
    return false;
  }
  const it = c.intent;
  it.mode = 'goto';
  it.goal = goal;
  it.speedMul = speedMul;
  if (c.path.goal === goal && c.path.status === 'arrived') return true;
  if (c.path.goal === goal && c.path.status === 'failed') {
    // cannot path there (clearance): fall back to steering for a while
    m['c.pth'] = 0;
    m['c.goal'] = -1;
    setDir(c, to.x - c.pos.x, to.y - c.pos.y, to.z - c.pos.z, speedMul);
  }
  return false;
}

/** Turn `forward` towards a point by at most `maxAngle` radians. Returns the cosine left to turn. */
function turnToward(c: Creature, to: Vec3, maxAngle: number): number {
  let dx = to.x - c.pos.x;
  let dy = to.y - c.pos.y;
  let dz = to.z - c.pos.z;
  const dn = dx * c.up.x + dy * c.up.y + dz * c.up.z;
  dx -= c.up.x * dn;
  dy -= c.up.y * dn;
  dz -= c.up.z * dn;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-4) return 1;
  dx /= l;
  dy /= l;
  dz /= l;
  const f = c.forward;
  const cos = Math.max(-1, Math.min(1, f.x * dx + f.y * dy + f.z * dz));
  const ang = Math.acos(cos);
  if (ang <= maxAngle) {
    f.x = dx;
    f.y = dy;
    f.z = dz;
    return 1;
  }
  // sign of the turn about `up`
  const cx = f.y * dz - f.z * dy;
  const cy = f.z * dx - f.x * dz;
  const cz = f.x * dy - f.y * dx;
  const sgn = cx * c.up.x + cy * c.up.y + cz * c.up.z >= 0 ? 1 : -1;
  v3rotateAbout(_d, f, c.up, sgn * maxAngle);
  const fl = Math.hypot(_d.x, _d.y, _d.z) || 1;
  f.x = _d.x / fl;
  f.y = _d.y / fl;
  f.z = _d.z / fl;
  return Math.cos(ang - maxAngle);
}

function facingCos(c: Creature, to: Vec3): number {
  const dx = to.x - c.pos.x;
  const dy = to.y - c.pos.y;
  const dz = to.z - c.pos.z;
  const l = Math.hypot(dx, dy, dz);
  return l < 1e-4 ? 1 : (c.forward.x * dx + c.forward.y * dy + c.forward.z * dz) / l;
}

/** Line of sight from the creature's head to a point (D10). */
function canSee(sim: SimState, c: Creature, to: Vec3): boolean {
  _o.x = c.pos.x + c.up.x * 0.6;
  _o.y = c.pos.y + c.up.y * 0.6;
  _o.z = c.pos.z + c.up.z * 0.6;
  _d.x = to.x - _o.x;
  _d.y = to.y + 0.25 - _o.y;
  _d.z = to.z - _o.z;
  const l = Math.hypot(_d.x, _d.y, _d.z);
  if (l < 1.2) return true;
  return sim.world.raycast(_o, _d, l - 0.6) === null;
}

function isPreyTagged(m: Mover, self: Creature): boolean {
  if (m.kind !== 'creature' || m === self) return false;
  const o = m as Creature;
  return o.mem[M.prey] === 1 || getCreature(o.def).role === 'herd';
}

/**
 * Nearest visible ant within `radius` (any colony). `score` may bias the choice (lower = better;
 * Infinity = skip). At most four line-of-sight rays per call. Falls back to prey-tagged
 * creatures when `withPrey` and no ant qualifies.
 */
function findVictim(sim: SimState, c: Creature, radius: number, withPrey: boolean, score?: (a: Ant, d: number) => number): Fighter | null {
  sim.spatial.queryMovers(c.pos.x, c.pos.y, c.pos.z, radius, _near);
  const cands: { f: Fighter; s: number }[] = [];
  for (const m of _near) {
    if (!m.alive) continue;
    const d = distance(m.pos, c.pos);
    if (m.kind === 'ant') {
      const a = m as Ant;
      const s = score ? score(a, d) : d;
      if (s < Infinity) cands.push({ f: a, s });
    } else if (withPrey && isPreyTagged(m, c)) cands.push({ f: m as Creature, s: d + radius });
  }
  cands.sort((x, y) => x.s - y.s || x.f.id - y.f.id);
  for (let i = 0; i < cands.length && i < 4; i++) if (canSee(sim, c, cands[i].f.pos)) return cands[i].f;
  return null;
}

/** Nearest ant in striking distance (attackers latched on come first). */
function meleeVictim(sim: SimState, c: Creature, extra = 0): Ant | null {
  sim.spatial.queryMovers(c.pos.x, c.pos.y, c.pos.z, bodyRadius(c) + 3 + extra, _near);
  let best: Ant | null = null;
  let bestS = Infinity;
  for (const m of _near) {
    if (m.kind !== 'ant' || !m.alive) continue;
    const a = m as Ant;
    const d = distance(a.pos, c.pos);
    if (d > meleeReach(c, a) + extra) continue;
    // stay on the ant it is already working on; attackers hanging on come before bystanders
    const s = d - (a.mem[COMBAT_MEM.latchId] === c.id ? 2 : 0) - (a.id === c.targetId ? 1.5 : 0);
    if (s < bestS) {
      bestS = s;
      best = a;
    }
  }
  return best;
}

function strike(sim: SimState, c: Creature, target: Fighter, opts?: AttackOpts): number {
  return attack(sim, c, target, opts);
}

function recentlyHit(sim: SimState, c: Creature, ticks: number): boolean {
  return sim.tick - (c.mem[COMBAT_MEM.hitTick] ?? -100000) < ticks;
}

/** A point of ant activity for a roaming predator: a random exposed ant within `radius` of `around`. */
function activityPoint(sim: SimState, st: CreaturesState, around: Vec3, radius: number, out: Vec3): boolean {
  const ants = sim.ants;
  if (ants.length === 0) return false;
  const nav = navOf(sim);
  const start = st.rng.int(ants.length);
  const step = 1 + st.rng.int(7);
  for (let k = 0; k < Math.min(ants.length, 40); k++) {
    const a = ants[(start + k * step) % ants.length];
    if (!a.alive || a.cell < 0 || !nav.isExposed(a.cell)) continue;
    if (distance(a.pos, around) > radius) continue;
    out.x = a.pos.x;
    out.y = a.pos.y;
    out.z = a.pos.z;
    return true;
  }
  return false;
}

function randomPointNear(st: CreaturesState, c: Creature, around: Vec3, radius: number, out: Vec3): void {
  const a = st.rng.range(0, Math.PI * 2);
  const r = radius * Math.sqrt(st.rng.next());
  out.x = around.x + Math.cos(a) * r;
  out.y = around.y;
  out.z = around.z + Math.sin(a) * r;
  void c;
}

function waypoint(c: Creature, out: Vec3): Vec3 {
  out.x = c.mem['c.wx'] ?? c.home.x;
  out.y = c.mem['c.wy'] ?? c.home.y;
  out.z = c.mem['c.wz'] ?? c.home.z;
  return out;
}

function setWaypoint(sim: SimState, c: Creature, p: Vec3): void {
  const w = sim.world;
  c.mem['c.wx'] = Math.max(2, Math.min(w.sx - 2, p.x));
  c.mem['c.wz'] = Math.max(2, Math.min(w.sz - 2, p.z));
  c.mem['c.wy'] = p.y;
  c.mem['c.wt'] = sim.tick;
  c.mem['c.goal'] = -1;
}

/** Entrance (or nest) position of the colony nearest to the creature — where the ants are. */
function nearestEntrance(sim: SimState, c: Creature, out: Vec3): boolean {
  let best = Infinity;
  for (const col of sim.colonies) {
    if (!col.alive) continue;
    const cell = col.entrances[0] ?? col.nestCell;
    if (cell < 0) continue;
    sim.world.cellCenter(cell, _p);
    const d = distance(_p, c.pos);
    if (d < best) {
      best = d;
      out.x = _p.x;
      out.y = _p.y;
      out.z = _p.z;
    }
  }
  return best < Infinity;
}

function alertPredator(sim: SimState, c: Creature): void {
  if (c.mem['c.alerted']) return;
  const colony = sim.getColony(sim.playerColony);
  if (!colony) return;
  // only once it is actually near the player's ants
  const cell = colony.entrances[0] ?? colony.nestCell;
  if (cell < 0) return;
  sim.world.cellCenter(cell, _p);
  if (distance(_p, c.pos) > 30) return;
  c.mem['c.alerted'] = 1;
  sim.emit({ type: 'alert', tick: sim.tick, code: 'predatorNear', colony: colony.id, pos: v3clone(c.pos), id: c.id, text: `${getCreature(c.def).name} near the nest` });
}

/** Visitors whose time is up walk (or fly) back to where they came from and vanish. */
function leaving(sim: SimState, c: Creature): boolean {
  const at = c.mem['c.leaveAt'];
  if (!at || sim.tick < at) return false;
  if (recentlyHit(sim, c, 90) && c.locomotion !== 'fly') return false; // finish the fight first
  c.state = 'flee';
  c.mem[M.hidden] = 0;
  if (c.locomotion === 'fly') {
    setDir(c, c.home.x - c.pos.x, 3, c.home.z - c.pos.z, 1);
    if (Math.hypot(c.home.x - c.pos.x, c.home.z - c.pos.z) < 4 || sim.tick > at + 900) sim.remove(c);
  } else if (travel(sim, c, c.home, 3.5, 1) || sim.tick > at + 2400) sim.remove(c);
  return true;
}

// =====================================================================================
// jumping spider
// =====================================================================================

function spiderRetreat(sim: SimState, c: Creature, rest: number): void {
  c.state = 'flee';
  c.mem['s.rest'] = rest;
  c.mem[M.pounceUntil] = 0;
  c.targetId = 0;
}

function updateSpider(sim: SimState, st: CreaturesState, c: Creature): void {
  const S = T.jumpingSpider;
  const m = c.mem;
  const tick = sim.tick;
  const think = tick >= c.thinkAt;
  if (think) c.thinkAt = tick + 6;
  const latchers = m[COMBAT_MEM.latchers] ?? 0;

  // bite whatever hangs on it, in any state
  if (tick >= c.attackReadyAt && (latchers > 0 || recentlyHit(sim, c, 60)) && !((m[M.pounceUntil] ?? 0) > tick)) {
    const v = meleeVictim(sim, c);
    if (v) strike(sim, c, v);
  }

  switch (c.state) {
    case 'idle': {
      halt(c);
      if (recentlyHit(sim, c, 30)) {
        // cornered in the lair
        m[M.hidden] = 0;
        m[M.sleepUntil] = 0;
        c.state = 'attack';
        return;
      }
      if (isAsleep(sim, c)) return;
      if ((m[M.eatUntil] ?? 0) > tick || (m['s.until'] ?? 0) > tick) return;
      m[M.carrying] = 0;
      m[M.hidden] = 0;
      c.state = 'roam';
      m['c.wt'] = -10000;
      return;
    }
    case 'roam': {
      alertPredator(sim, c);
      if (think) {
        if (healthFrac(c) < S.retreatHealth * 0.8) return spiderRetreat(sim, c, S.restTime);
        // isolated workers first: few nestmates around, not a soldier
        const v = findVictim(sim, c, getCreature(c.def).senseRadius, true, (a, d) => d + (a.caste === 'soldier' ? 6 : 0) + (a.caste === 'queen' ? 20 : 0));
        if (v) {
          c.targetId = v.id;
          c.state = 'stalk';
          m['s.t0'] = tick;
          m['s.seen'] = tick;
          return;
        }
        if (tick - (m['c.wt'] ?? -10000) > 360 || distance(c.pos, waypoint(c, _p)) < 3) {
          if (!activityPoint(sim, st, c.home, S.territory, _p)) randomPointNear(st, c, c.home, S.territory * 0.6, _p);
          setWaypoint(sim, c, _p);
        }
      }
      travel(sim, c, waypoint(c, _p), 2.5, 0.7);
      return;
    }
    case 'stalk': {
      const v = c.targetId ? sim.getEntity(c.targetId) : undefined;
      if (!v || (v.kind !== 'ant' && v.kind !== 'creature') || tick - (m['s.t0'] ?? 0) > 600) {
        c.state = 'roam';
        c.targetId = 0;
        return;
      }
      if (latchers >= S.mobLimit || healthFrac(c) < S.retreatHealth) return spiderRetreat(sim, c, S.restTime);
      const d = distance(c.pos, v.pos);
      if (think) {
        // lost it (gone underground, behind cover) for a few seconds: look for something else
        if (canSee(sim, c, v.pos)) m['s.seen'] = tick;
        if (d > getCreature(c.def).senseRadius * 1.3 || tick - (m['s.seen'] ?? m['s.t0'] ?? tick) > 100) {
          c.state = 'roam';
          c.targetId = 0;
          return;
        }
      }
      if (d <= S.pounceRange && tick >= (m['s.pcd'] ?? 0) && !(c.stunned > 0) && (think ? canSee(sim, c, v.pos) : true)) {
        m[M.pounceUntil] = tick + Math.round(S.pounceTime * 30);
        m['s.pcd'] = tick + Math.round(S.pounceCooldown * 30);
        c.state = 'attack';
        return;
      }
      // creep closer, freezing when just out of range and the leap is not ready
      if (d > S.pounceRange * 0.8) travel(sim, c, v.pos, S.pounceRange * 0.7, d > S.pounceRange * 0.97 ? 1.1 : S.stalkSpeed);
      else {
        halt(c);
        turnToward(c, v.pos, S.turn / 30);
      }
      return;
    }
    case 'attack': {
      const v = c.targetId ? sim.getEntity(c.targetId) : undefined;
      const pouncing = (m[M.pounceUntil] ?? 0) > tick;
      if (pouncing && v && (v.kind === 'ant' || v.kind === 'creature')) {
        // the leap: a fast dash that ends in a heavy strike
        setDir(c, v.pos.x - c.pos.x, v.pos.y - c.pos.y, v.pos.z - c.pos.z, S.pounceSpeed);
        if (distance(c.pos, v.pos) <= meleeReach(c, v) * 0.9) {
          m[M.pounceUntil] = 0;
          strike(sim, c, v, { damage: S.pounceDamage, ignoreCooldown: true, devour: true, slack: 0.5 });
          if (!v.alive) {
            // got one: carry it home
            m[M.carrying] = 1;
            spiderRetreat(sim, c, S.digestTime);
            m['s.eat'] = 1;
          }
        }
        return;
      }
      if (latchers >= S.mobLimit || healthFrac(c) < S.retreatHealth) return spiderRetreat(sim, c, S.restTime);
      // melee after a pounce that did not kill (or cornered): stay on the nearest ant
      const near = meleeVictim(sim, c, 4);
      if (near) {
        c.targetId = near.id;
        if (distance(c.pos, near.pos) > meleeReach(c, near) * 0.85) setDir(c, near.pos.x - c.pos.x, near.pos.y - c.pos.y, near.pos.z - c.pos.z, 0.8);
        else {
          halt(c);
          turnToward(c, near.pos, S.turn / 30);
        }
        if (tick >= c.attackReadyAt) strike(sim, c, near, { devour: false });
        if (!recentlyHit(sim, c, 90) && tick >= (m['s.pcd'] ?? 0)) c.state = 'stalk';
        m['s.t0'] = tick;
      } else {
        c.state = v && v.alive ? 'stalk' : 'roam';
        m['s.t0'] = tick;
      }
      return;
    }
    case 'flee': {
      // home to the lair; pinned spiders cannot move and keep biting (above)
      if (travel(sim, c, c.home, 2.5, 1.25)) {
        c.state = 'idle';
        m[M.hidden] = 1;
        const rest = m['s.rest'] ?? S.restTime;
        if (m['s.eat']) {
          m['s.eat'] = 0;
          m[M.eatUntil] = tick + Math.round(S.eatTime * 30);
        }
        m['s.until'] = tick + Math.round(rest * 30);
      }
      return;
    }
    default:
      c.state = 'roam';
  }
}

// =====================================================================================
// antlion
// =====================================================================================

function pitCells(sim: SimState, pit: Pit, fn: (cell: CellIndex) => void): void {
  const w = sim.world;
  const r = Math.ceil(pit.radius + 1);
  for (let y = Math.floor(pit.pos.y - 2); y <= pit.pos.y + r; y++)
    for (let z = Math.floor(pit.pos.z - r); z <= pit.pos.z + r; z++)
      for (let x = Math.floor(pit.pos.x - r); x <= pit.pos.x + r; x++) {
        if (!w.inBounds(x, y, z)) continue;
        if (Math.hypot(x + 0.5 - pit.pos.x, z + 0.5 - pit.pos.z) > pit.radius + 1) continue;
        const cell = w.index(x, y, z);
        if (sim.nav.isWalkable(cell)) fn(cell);
      }
}

function updateAntlion(sim: SimState, st: CreaturesState, c: Creature): void {
  const L = T.antlion;
  const m = c.mem;
  const tick = sim.tick;
  const pit = st.pits.find((p) => p.id === c.id);
  if (!pit) return;
  c.state = 'ambush';
  const eating = (m[M.eatUntil] ?? 0) > tick;
  m[M.hidden] = eating || tick - (m[M.attackTick] ?? -1000) < 20 ? 0 : 1;
  if (!eating) m[M.carrying] = 0;

  sim.spatial.queryMovers(pit.pos.x, pit.pos.y + 1, pit.pos.z, pit.radius + 1.5, _near);
  let victim: Ant | null = null;
  let victimD = Infinity;
  for (const mv of _near) {
    if (mv.kind !== 'ant' || !mv.alive) continue;
    const a = mv as Ant;
    const dx = pit.pos.x - a.pos.x;
    const dz = pit.pos.z - a.pos.z;
    const r = Math.hypot(dx, dz);
    if (r > pit.radius || a.pos.y < pit.pos.y - 2.5 || a.pos.y > pit.pos.y + pit.radius + 1.5) continue;
    a.mem['pit'] = tick;
    const d3 = distance(a.pos, c.pos);
    if (d3 < victimD) {
      victimD = d3;
      victim = a;
    }
    // M3: on the outer ring an ant can still feel the sand give way. The first one of a colony to
    // do so usually backs out and the colony learns the pit (before, learning always cost a life:
    // three pits ate three of a founding colony's ten workers in the first minute on the desert);
    // afterwards most nestmates refuse the slope — the careless few still slide in.
    let wary = false;
    if (!a.possessed && r > pit.radius * L.waryRing) {
      const key = 'al.col' + a.colony;
      if (!m[key] && (a.id + c.id) % 3 !== 0) {
        m[key] = 1;
        const col: ColonyId = a.colony;
        if (col > 0) pitCells(sim, pit, (cell) => sim.pheromones.deposit(col, Phero.avoid, cell, L.avoidDeposit));
      }
      wary = !!m[key] && (a.id + c.id) % 4 !== 0;
    }
    if (r > L.grabRadius * 0.6 && !a.falling) {
      // the slope gives way: slide towards the centre (stronger the deeper the ant is)
      const k = 1 - r / pit.radius;
      const pull = wary ? -L.warySpeed / 30 : (L.pullRim + (L.pullCentre - L.pullRim) * k) / 30;
      let px = dx;
      let py = pit.pos.y - a.pos.y;
      let pz = dz;
      const dn = px * a.up.x + py * a.up.y + pz * a.up.z;
      px -= a.up.x * dn;
      py -= a.up.y * dn;
      pz -= a.up.z * dn;
      const l = Math.hypot(px, py, pz);
      if (l > 1e-3) {
        a.pos.x += (px / l) * pull;
        a.pos.y += (py / l) * pull;
        a.pos.z += (pz / l) * pull;
      }
    }
  }
  if (victim && !eating && tick >= c.attackReadyAt && victimD <= Math.max(L.grabRadius + bodyRadius(c), meleeReach(c, victim))) {
    turnToward(c, victim.pos, Math.PI);
    const colony = victim.colony;
    strike(sim, c, victim, { devour: true, ignoreReach: true });
    if (!victim.alive) {
      m[M.eatUntil] = tick + Math.round(L.eatTime * 30);
      m[M.carrying] = 1;
      m['al.col' + colony] = 1; // that colony has learned where the pit is
    }
  }
  // colonies that lost an ant here smell the danger: `avoid` scent over the pit
  if ((tick + c.id) % 150 === 0) {
    for (const col of sim.colonies) {
      if (!col.alive || !m['al.col' + col.id]) continue;
      const id: ColonyId = col.id;
      pitCells(sim, pit, (cell) => sim.pheromones.deposit(id, Phero.avoid, cell, L.avoidDeposit));
    }
  }
}

// =====================================================================================
// ground beetle
// =====================================================================================

function updateBeetle(sim: SimState, st: CreaturesState, c: Creature): void {
  const G = T.groundBeetle;
  const m = c.mem;
  const tick = sim.tick;
  const think = tick >= c.thinkAt;
  if (think) c.thinkAt = tick + 8;

  // it bites back whatever is chewing on it
  if (tick >= c.attackReadyAt && recentlyHit(sim, c, 60)) {
    const v = meleeVictim(sim, c);
    if (v) {
      turnToward(c, v.pos, G.turn / 30 * 6);
      strike(sim, c, v);
    }
  }

  switch (c.state) {
    case 'idle': {
      halt(c);
      if (recentlyHit(sim, c, 30)) {
        m[M.sleepUntil] = 0;
        m[M.hidden] = 0;
      }
      if (isAsleep(sim, c)) return;
      m[M.hidden] = 0;
      if (tick < (m['b.next'] ?? 0)) return;
      c.state = 'roam';
      m['b.ate'] = 0;
      m['b.t0'] = tick;
      return;
    }
    case 'roam': {
      alertPredator(sim, c);
      if (!nearestEntrance(sim, c, _p)) {
        c.state = 'flee';
        return;
      }
      if (tick - (m['b.t0'] ?? 0) > 3600) {
        c.state = 'flee';
        return;
      }
      if (travel(sim, c, _p, 7, 1) || distance(c.pos, _p) < 9) {
        c.state = 'attack';
        m['b.t0'] = tick;
      }
      return;
    }
    case 'attack': {
      if ((m[M.eatUntil] ?? 0) > tick) {
        halt(c);
        return;
      }
      if (healthFrac(c) < G.retreatHealth || (m['b.ate'] ?? 0) >= G.appetite || tick - (m['b.t0'] ?? 0) > G.raidTime * 30) {
        c.state = 'flee';
        c.targetId = 0;
        return;
      }
      if (think) {
        // loose food first, then ants carrying food, then a food source, then any ant
        let food: { pos: Vec3; id: number } | null = null;
        let fd: number = getCreature(c.def).senseRadius;
        for (const it of sim.items) {
          if (!it.alive || it.carriedBy || (it.itemKind !== 'food' && it.itemKind !== 'seed' && it.itemKind !== 'corpse')) continue;
          const d = distance(it.pos, c.pos);
          if (d < fd) {
            fd = d;
            food = it;
          }
        }
        if (!food) {
          for (const f of sim.foodSources) {
            if (!f.alive || f.amount <= 0) continue;
            const d = distance(f.pos, c.pos);
            if (d < fd) {
              fd = d;
              food = f;
            }
          }
        }
        const carrier = findVictim(sim, c, getCreature(c.def).senseRadius, false, (a, d) => (a.carrying && a.carrying.kind !== 'brood' ? d : Infinity));
        if (carrier && distance(carrier.pos, c.pos) < fd + 2) {
          c.targetId = carrier.id;
          m['b.food'] = 0;
        } else if (food) {
          c.targetId = 0;
          m['b.food'] = food.id;
        } else {
          m['b.food'] = 0;
          const any = findVictim(sim, c, getCreature(c.def).senseRadius * 0.7, false);
          c.targetId = any ? any.id : 0;
        }
      }
      const foodE = m['b.food'] ? sim.getEntity(m['b.food']) : undefined;
      if (foodE && (foodE.kind === 'item' || foodE.kind === 'food')) {
        if (travel(sim, c, foodE.pos, bodyRadius(c) + 1.2, 1)) {
          foodE.amount -= G.bite;
          if (foodE.amount <= 0 && foodE.kind === 'item') sim.remove(foodE);
          m['b.ate'] = (m['b.ate'] ?? 0) + 1;
          m[M.eatUntil] = tick + Math.round(G.eatTime * 30);
          m['b.food'] = 0;
        }
        return;
      }
      const v = c.targetId ? sim.getEntity(c.targetId) : undefined;
      if (v && v.kind === 'ant') {
        const reach = meleeReach(c, v);
        if (distance(c.pos, v.pos) > reach * 0.9) travel(sim, c, v.pos, reach * 0.8, 1.1);
        else {
          halt(c);
          turnToward(c, v.pos, G.turn / 30);
        }
        if (tick >= c.attackReadyAt && distance(c.pos, v.pos) <= reach) {
          strike(sim, c, v);
          if (v.alive && v.carrying && v.carrying.kind !== 'brood') dropCarry(sim, v);
        }
        return;
      }
      // nothing in sight: mill about the entrance
      if (think && (tick - (m['c.wt'] ?? -10000) > 240 || distance(c.pos, waypoint(c, _p)) < 3)) {
        if (nearestEntrance(sim, c, _o)) {
          randomPointNear(st, c, _o, 7, _p);
          setWaypoint(sim, c, _p);
        }
      }
      travel(sim, c, waypoint(c, _p), 2.5, 0.7);
      return;
    }
    case 'flee': {
      if (travel(sim, c, c.home, 3, 1.1)) {
        c.state = 'idle';
        m['b.next'] = tick + Math.round(G.raidEvery * 30);
      }
      return;
    }
    default:
      c.state = 'idle';
  }
}

// =====================================================================================
// parasitic wasp
// =====================================================================================

function groundY(sim: SimState, x: number, z: number): number {
  const w = sim.world;
  return navOf(sim).skyHeight(Math.max(0, Math.min(w.sx - 1, Math.floor(x))), Math.max(0, Math.min(w.sz - 1, Math.floor(z))));
}

function flyTo(sim: SimState, c: Creature, x: number, y: number, z: number, speedMul: number): number {
  const dx = x - c.pos.x;
  const dy = y - c.pos.y;
  const dz = z - c.pos.z;
  setDir(c, dx, dy, dz, speedMul);
  return Math.hypot(dx, dy, dz);
}

function waspGuarded(sim: SimState, victim: Ant): boolean {
  const W = T.wasp;
  sim.spatial.queryMovers(victim.pos.x, victim.pos.y, victim.pos.z, W.guardRadius, _near);
  let p = 0;
  for (const mv of _near) {
    if (mv.kind !== 'ant' || !mv.alive || mv === victim) continue;
    const a = mv as Ant;
    if (a.colony === victim.colony && (a.caste === 'soldier' || a.caste === 'major' || a.caste === 'nasute')) p += powerOf(a);
  }
  return p >= W.guardPower;
}

function updateWasp(sim: SimState, st: CreaturesState, c: Creature): void {
  const W = T.wasp;
  const m = c.mem;
  const tick = sim.tick;
  const think = tick >= c.thinkAt;
  if (think) c.thinkAt = tick + 6;
  const nav = navOf(sim);
  const sense = getCreature(c.def).senseRadius;

  if (c.state !== 'flee' && (healthFrac(c) < W.retreatHealth || (m['w.pass'] ?? 0) >= W.passes)) {
    c.state = 'flee';
    m['c.leaveAt'] = tick;
  }

  switch (c.state) {
    case 'roam': {
      if (think && tick >= (m['w.cd'] ?? 0)) {
        const v = findVictim(sim, c, sense, false, (a, d) => (a.cell >= 0 && nav.isExposed(a.cell) && a.caste !== 'queen' && a.caste !== 'soldier' && !waspGuarded(sim, a) ? d : Infinity));
        if (v) {
          c.targetId = v.id;
          c.state = 'stalk';
          m['w.t0'] = tick;
          alertPredator(sim, c);
          return;
        }
      }
      if (think && (tick - (m['c.wt'] ?? -10000) > 300 || Math.hypot(c.pos.x - (m['c.wx'] ?? 0), c.pos.z - (m['c.wz'] ?? 0)) < 4)) {
        if (!nearestEntrance(sim, c, _o)) v3copyTo(_o, c.home);
        if (!activityPoint(sim, st, _o, 40, _p)) randomPointNear(st, c, _o, 14, _p);
        setWaypoint(sim, c, _p);
      }
      waypoint(c, _p);
      flyTo(sim, c, _p.x, groundY(sim, _p.x, _p.z) + W.cruiseHeight, _p.z, 0.7);
      return;
    }
    case 'stalk': {
      // line up above and behind the victim
      const v = c.targetId ? sim.getAnt(c.targetId) : undefined;
      if (!v || !nav.isExposed(v.cell) || tick - (m['w.t0'] ?? 0) > 300) {
        c.state = 'roam';
        c.targetId = 0;
        return;
      }
      const d = flyTo(sim, c, v.pos.x, v.pos.y + W.cruiseHeight * 0.55, v.pos.z, 1);
      if (d < 3 || Math.hypot(v.pos.x - c.pos.x, v.pos.z - c.pos.z) < 2.5) {
        if (waspGuarded(sim, v)) {
          c.state = 'roam';
          m['w.cd'] = tick + 90;
          c.targetId = 0;
          return;
        }
        c.state = 'attack';
        m[M.pounceUntil] = tick + 90;
      }
      return;
    }
    case 'attack': {
      const v = c.targetId ? sim.getAnt(c.targetId) : undefined;
      if (!v || (m[M.pounceUntil] ?? 0) <= tick) {
        // missed (the ant got indoors) or timed out: climb and try again later
        m[M.pounceUntil] = 0;
        m['w.pass'] = (m['w.pass'] ?? 0) + 1;
        m['w.cd'] = tick + Math.round(W.passCooldown * 30);
        m['w.up'] = tick + 60;
        c.state = 'flee';
        return;
      }
      // dive at the victim's cell (the fly kernel lands there, which puts the sting in reach)
      const d = distance(c.pos, v.pos);
      if (v.cell >= 0 && sim.nav.isWalkable(v.cell)) {
        c.intent.mode = 'goto';
        c.intent.goal = v.cell;
        c.intent.speedMul = W.swoopSpeed;
      } else flyTo(sim, c, v.pos.x, v.pos.y + 0.3, v.pos.z, W.swoopSpeed);
      if (d <= meleeReach(c, v) + 0.6) {
        m[M.pounceUntil] = 0;
        strike(sim, c, v, { ignoreCooldown: true, ignoreReach: true, devour: true });
        if (v.alive && v.caste !== 'soldier' && healthFrac(v) <= 0.45) hurt(sim, v, v.health + 1, 0, true); // snatched
        m['w.pass'] = (m['w.pass'] ?? 0) + 1;
        m['w.cd'] = tick + Math.round(W.passCooldown * 30);
        m['w.up'] = tick + 75;
        c.state = 'flee';
        if (!v.alive) {
          // it has what it came for
          m[M.carrying] = 1;
          m['c.leaveAt'] = tick;
        }
      }
      return;
    }
    case 'flee': {
      if (m['c.leaveAt'] && tick >= m['c.leaveAt']) {
        // out over the nearest edge, climbing
        const w = sim.world;
        const ex = c.pos.x < w.sx - c.pos.x ? -6 : w.sx + 6;
        const ez = c.pos.z < w.sz - c.pos.z ? -6 : w.sz + 6;
        const toX = Math.min(c.pos.x, w.sx - c.pos.x) < Math.min(c.pos.z, w.sz - c.pos.z);
        const tx = toX ? ex : c.pos.x;
        const tz = toX ? c.pos.z : ez;
        flyTo(sim, c, tx, Math.min(w.sy - 2, groundY(sim, c.pos.x, c.pos.z) + W.cruiseHeight * 1.4), tz, 1.1);
        if (c.pos.x < 2.5 || c.pos.z < 2.5 || c.pos.x > w.sx - 2.5 || c.pos.z > w.sz - 2.5 || tick > m['c.leaveAt'] + 900) sim.remove(c);
        return;
      }
      // climb out of reach, then cruise again
      flyTo(sim, c, c.pos.x + c.forward.x * 4, groundY(sim, c.pos.x, c.pos.z) + W.cruiseHeight, c.pos.z + c.forward.z * 4, 1);
      if (tick >= (m['w.up'] ?? 0)) {
        c.state = 'roam';
        c.targetId = 0;
      }
      return;
    }
    default:
      c.state = 'roam';
  }
}

function v3copyTo(out: Vec3, a: Vec3): void {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
}

// =====================================================================================
// mantis
// =====================================================================================

function updateMantis(sim: SimState, st: CreaturesState, c: Creature): void {
  const B = T.mantis;
  const m = c.mem;
  const tick = sim.tick;
  const think = tick >= c.thinkAt;
  if (think) c.thinkAt = tick + 8;
  if (isAsleep(sim, c)) {
    halt(c);
    if (recentlyHit(sim, c, 30)) m[M.sleepUntil] = 0;
    return;
  }
  m[M.hidden] = 0;
  if ((m[M.eatUntil] ?? 0) > tick) {
    halt(c);
    return;
  }
  m[M.carrying] = 0;
  alertPredator(sim, c);

  if (think) {
    const v = findVictim(sim, c, getCreature(c.def).senseRadius, true, (a, d) => d - (a.mem[COMBAT_MEM.latchId] === c.id ? 3 : 0));
    c.targetId = v ? v.id : 0;
    c.state = v ? 'attack' : 'roam';
  }
  const v = c.targetId ? sim.getEntity(c.targetId) : undefined;
  if (v && (v.kind === 'ant' || v.kind === 'creature')) {
    const d = distance(c.pos, v.pos);
    const reach = Math.max(B.strikeReach, meleeReach(c, v));
    if (d > reach * 0.9) {
      travel(sim, c, v.pos, reach * 0.8, 1);
      return;
    }
    // in reach: it has to bring its forelegs to bear — slowly
    halt(c);
    turnToward(c, v.pos, B.turn / 30);
    if (tick >= c.attackReadyAt) {
      // strike the best target inside the front cone (not necessarily the one it is turning to)
      sim.spatial.queryMovers(c.pos.x, c.pos.y, c.pos.z, reach + 1, _near);
      let best: Fighter | null = null;
      let bestD = Infinity;
      for (const mv of _near) {
        if (!mv.alive || mv === c || (mv.kind !== 'ant' && !isPreyTagged(mv, c))) continue;
        const dd = distance(mv.pos, c.pos);
        if (dd > reach || facingCos(c, mv.pos) < B.strikeCone) continue;
        if (dd < bestD) {
          bestD = dd;
          best = mv as Fighter;
        }
      }
      if (best) {
        strike(sim, c, best, { ignoreReach: true, devour: true, noLatch: true });
        if (!best.alive) {
          m[M.eatUntil] = tick + Math.round(B.eatTime * 30);
          m[M.carrying] = 1;
        }
      }
    }
    return;
  }
  // roam: towards where the ants are
  if (think && (tick - (m['c.wt'] ?? -10000) > 450 || distance(c.pos, waypoint(c, _p)) < 4)) {
    if (!activityPoint(sim, st, c.pos, B.territory, _p) && !nearestEntrance(sim, c, _p)) randomPointNear(st, c, c.home, 12, _p);
    setWaypoint(sim, c, _p);
  }
  travel(sim, c, waypoint(c, _p), 3, 0.8);
}

// =====================================================================================
// caterpillar / worm
// =====================================================================================

function updatePrey(sim: SimState, st: CreaturesState, c: Creature): void {
  const P = c.def === 'worm' ? T.worm : T.caterpillar;
  const m = c.mem;
  const tick = sim.tick;
  const think = tick >= c.thinkAt;
  if (think) c.thinkAt = tick + 10;

  if (recentlyHit(sim, c, 45)) {
    if (tick >= (m['p.next'] ?? 0)) {
      // thrash: throw the attackers off and batter the ones close by
      m['p.next'] = tick + Math.round(P.thrashEvery * 30);
      m[M.thrashUntil] = tick + Math.round(P.thrashTime * 30);
      m[M.attackTick] = tick;
      shakeOff(sim, c);
      sim.spatial.queryMovers(c.pos.x, c.pos.y, c.pos.z, P.thrashRadius + bodyRadius(c), _near);
      let ax = 0;
      let az = 0;
      const hit: Ant[] = [];
      for (const mv of _near) {
        if (mv.kind !== 'ant' || !mv.alive) continue;
        ax += mv.pos.x - c.pos.x;
        az += mv.pos.z - c.pos.z;
        hit.push(mv as Ant);
      }
      for (const a of hit) {
        sim.emit({ type: 'attack', tick, attacker: c.id, target: a.id, kind: 'bite', pos: v3clone(a.pos) });
        applyStatus(sim, a, { kind: 'stunned', duration: 0.5 }, c.id);
        hurt(sim, a, P.thrashDamage * (0.5 + 0.5 * st.rng.next()));
      }
      m['p.fx'] = -ax;
      m['p.fz'] = -az;
      c.state = 'flee';
      m['p.until'] = tick + 120;
    }
  }
  if ((m[M.thrashUntil] ?? 0) > tick) {
    halt(c);
    return;
  }
  if (c.state === 'flee') {
    if (tick >= (m['p.until'] ?? 0) && !recentlyHit(sim, c, 60)) {
      c.state = 'roam';
      return;
    }
    let fx = m['p.fx'] ?? 0;
    let fz = m['p.fz'] ?? 0;
    if (Math.abs(fx) + Math.abs(fz) < 1e-3) {
      fx = c.forward.x;
      fz = c.forward.z;
    }
    setDir(c, fx, 0, fz, P.fleeSpeed);
    return;
  }
  c.state = 'roam';
  if (think && (tick - (m['c.wt'] ?? -10000) > 420 || distance(c.pos, waypoint(c, _p)) < 2)) {
    randomPointNear(st, c, c.home, P.territory, _p);
    setWaypoint(sim, c, _p);
  }
  if ((tick + c.id * 7) % 240 < 150) travel(sim, c, waypoint(c, _p), 1.5, 1);
  else halt(c); // munching
}

// =====================================================================================
// system
// =====================================================================================

export const creaturesSystem: SimSystem = {
  id: 'creatures',
  init(sim) {
    getState(sim);
    spawnResidents(sim);
  },
  update(sim) {
    const st = getState(sim);
    const list = sim.creatures;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.alive) continue;
      if (c.def === 'aphid') continue;
      if (c.def === 'antlion') {
        if (!st.pits.some((p) => p.id === c.id)) st.pits.push({ id: c.id, pos: v3clone(c.pos), radius: T.antlion.pitRadius });
        updateAntlion(sim, st, c);
        continue;
      }
      if (c.falling) continue;
      if (c.def !== 'wasp' && leaving(sim, c)) continue;
      switch (c.def) {
        case 'jumpingSpider':
          updateSpider(sim, st, c);
          break;
        case 'groundBeetle':
          updateBeetle(sim, st, c);
          break;
        case 'wasp':
          updateWasp(sim, st, c);
          break;
        case 'mantis':
          updateMantis(sim, st, c);
          break;
        default:
          updatePrey(sim, st, c);
      }
    }
    if (st.pits.length > 0 && sim.tick % 60 === 0) {
      // M3: a pit is a path hazard (A* skirts it; scouts still stumble in) for as long as its owner lives
      const nav = navOf(sim);
      for (let i = st.pits.length - 1; i >= 0; i--) {
        const pit = st.pits[i];
        const gone = !sim.getEntity(pit.id);
        if (gone || !pit.marked) {
          pitCells(sim, pit, (cell) => nav.setHazard(cell, gone ? 0 : T.antlion.pathCost));
          pit.marked = true;
        }
        if (gone) st.pits.splice(i, 1);
      }
    }
  },
};

/** Creatures of a kind currently alive (tests, director). */
export function countCreatures(sim: SimState, def: CreatureId): number {
  let n = 0;
  for (const c of sim.creatures) if (c.alive && c.def === def) n++;
  return n;
}

/** Whether the wasp (or any flyer) is currently out of reach in the air. */
export function creatureAirborne(sim: SimState, c: Creature): boolean {
  return isAirborne(sim, c);
}
