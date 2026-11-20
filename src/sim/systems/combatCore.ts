import { noteDanger } from './colonyState';
import {
  COMBAT_MEM,
  CREATURE_MEM,
  HOME_UNREACHABLE,
  Phero,
  RIDE_PER_LENGTH,
  THREAT_ROLES,
  creatureKey,
  hash01,
  registeredArmour,
  registeredAttackProfile,
  registeredGrapple,
  unitKey,
  v3,
  v3clone,
  type Ant,
  type AttackKind,
  type AttackProfile,
  type CasteId,
  type CellIndex,
  type ColonyId,
  type Creature,
  type EntityId,
  type Mover,
  type SimState,
  type StatusEffectDef,
  type Tick,
  type Vec3,
} from '../../core';
import { BALANCE } from '../data/balance';
import { creatureTuning, getCreature } from '../data/creatures';
import { getCaste } from '../data/species';
import { alertOnce, getExt } from './colonyState';
import { registerSpeedModifier } from './movement';
import { navOf } from './paths';

/**
 * Combat core (B1): the ONE melee resolution every attack goes through — AI ants, possessed
 * ants, creatures — plus the shared perception helpers of the fight / flee / guard / raid
 * behaviors. The `combat` system (combat.ts) drives the per-tick parts.
 *
 * RESOLUTION (`attack`)
 *   reach      mandible reach + both body radii (+ the attack profile's range)
 *   cooldown   `attackReadyAt`; glued attackers strike at half rate, stunned ones not at all
 *   damage     attack × profile.damageMul × facing (flank ×1.2, rear ×1.5) × pinned bonus
 *              × possession bonus, then × (1 − armour × (1 − pierce))
 *   effects    the profile's status effects (poison DoT, slow, glued, stunned) — contracts/b1.ts
 *   grapple    an ant that lands a bite latches on; latched weight slows the victim linearly
 *              and immobilises ("pins") it once it reaches the victim's hold strength
 *   alarm      attacker and victim colonies get an alarm call + `alarm` pheromone at the spot
 *   death      ants: corpse item (enemy dead inside the killer's nest are relabelled so they go
 *              to the killer's midden); creatures: corpse item worth `foodValue`, made known to
 *              the killer colony so its haulers butcher it
 */

export type Fighter = Ant | Creature;

const C = BALANCE.b1.combat;
const A = BALANCE.b1.alarm;
const F = BALANCE.b1.fight;

/** Speed multiplier from status effects and grappling, read by the movement system. */
export const SPEED_MEM = 'b1.spd';
/** Colony credited with the latest damage (kill credit for poison deaths). */
const CREDIT_MEM = 'hit.c';

export interface AlarmCall {
  colony: ColonyId;
  /** `threat`: something is attacking us · `prey`: a hunt needs more mandibles. */
  kind: 'threat' | 'prey';
  pos: Vec3;
  cell: CellIndex;
  threatId: EntityId;
  until: Tick;
  burstAt: Tick;
  /** Power estimates around the call (refreshed by the combat system). */
  enemyPower: number;
  allyPower: number;
}

export interface CombatState {
  calls: AlarmCall[];
  /** Coarse presence grid: bit 0 = threat creature, bit 30 = prey, bit c = ants of colony c. */
  grid: Uint32Array;
  gx: number;
  gy: number;
  gz: number;
  gridTick: Tick;
  /** Latched weight / attacker count per victim this tick. */
  loads: Map<EntityId, number>;
  counts: Map<EntityId, number>;
  /** Movers whose `SPEED_MEM` is currently set by status or grapple. */
  slowed: Set<EntityId>;
  /** Movers with a live status effect. */
  afflicted: Set<EntityId>;
  /** Totals for tests / debug. */
  stats: { attacks: number; kills: number; alarms: number };
}

const GRID = 8;
const PREY_BIT = 1 << 30;
const states = new WeakMap<SimState, CombatState>();

export function getCombat(sim: SimState): CombatState {
  let s = states.get(sim);
  if (!s) {
    const w = sim.world;
    const gx = Math.ceil(w.sx / GRID) + 1;
    const gy = Math.ceil(w.sy / GRID) + 1;
    const gz = Math.ceil(w.sz / GRID) + 1;
    s = { calls: [], grid: new Uint32Array(gx * gy * gz), gx, gy, gz, gridTick: -1000, loads: new Map(), counts: new Map(), slowed: new Set(), afflicted: new Set(), stats: { attacks: 0, kills: 0, alarms: 0 } };
    states.set(sim, s);
    registerSpeedModifier(sim, speedModifier);
  }
  return s;
}

function speedModifier(m: Mover): number {
  const v = (m as Fighter).mem[SPEED_MEM];
  return v === undefined ? 1 : v;
}

// ---- who is who --------------------------------------------------------------------------------

export function isFighter(e: { kind: string } | undefined | null): e is Fighter {
  return !!e && (e.kind === 'ant' || e.kind === 'creature');
}

export function healthFrac(f: Fighter): number {
  return f.maxHealth > 0 ? Math.max(0, f.health / f.maxHealth) : 0;
}

/** A creature ants treat as a danger. */
export function isThreatCreature(c: Creature): boolean {
  return THREAT_ROLES[getCreature(c.def).role] === 1;
}

/** True while the flyer is out of mandible reach in the air. */
export function isAirborne(sim: SimState, c: Creature): boolean {
  if (c.locomotion !== 'fly') return false;
  return sim.world.sample(c.pos.x, c.pos.y, c.pos.z) < -(c.rideHeight + 0.9);
}

/**
 * Does colony `colony` perceive creature `c` as a threat right now? Hidden / dormant ambushers are only
 * noticed once they have struck.
 */
export function perceivedThreat(sim: SimState, colony: ColonyId, c: Creature): boolean {
  if (!c.alive || (c.colony !== 0 && c.colony === colony) || !isThreatCreature(c)) return false;
  const m = c.mem;
  if (m[CREATURE_MEM.hidden] === 1 || (m[CREATURE_MEM.sleepUntil] ?? 0) > sim.tick) {
    return sim.tick - (m[CREATURE_MEM.attackTick] ?? -1000) < 150 || sim.tick - (m[COMBAT_MEM.hitTick] ?? -1000) < 150;
  }
  return true;
}

/** An enemy ant: another colony's, alive. (Infected nestmates are only attacked on orders.) */
export function isEnemyAnt(ant: Ant, o: Ant): boolean {
  return o.alive && o.colony !== ant.colony;
}

/** Anything this ant fights on its own initiative. */
export function isEnemy(sim: SimState, ant: Ant, m: Mover): boolean {
  if (m.kind === 'ant') return isEnemyAnt(ant, m as Ant);
  return perceivedThreat(sim, ant.colony, m as Creature);
}

export function isPrey(c: Creature): boolean {
  return c.alive && getCreature(c.def).role === 'prey';
}

// ---- stats ---------------------------------------------------------------------------------------

export function bodyRadius(m: Mover): number {
  const len = m.kind === 'creature' ? getCreature((m as Creature).def).length : m.rideHeight / RIDE_PER_LENGTH;
  return Math.min(C.bodyRadiusMax, len * C.bodyRadiusPerLength);
}

const DEFAULT_PROFILES: Record<AttackKind, AttackProfile> = {
  bite: {},
  sting: { range: C.sting.range, armourPierce: C.sting.armourPierce, damageMul: C.sting.damageMul, effects: [{ kind: 'poison', duration: C.sting.poisonTime, dps: C.sting.poisonDps, maxStacks: C.sting.poisonStacks }] },
  acid: { range: C.acid.range, armourPierce: C.acid.armourPierce, damageMul: C.acid.damageMul, effects: [{ kind: 'poison', duration: C.acid.poisonTime, dps: C.acid.poisonDps, maxStacks: C.acid.poisonStacks }] },
  glue: {
    range: C.glue.range,
    armourPierce: C.glue.armourPierce,
    damageMul: C.glue.damageMul,
    effects: [
      { kind: 'glued', duration: C.glue.gluedTime, chance: C.glue.gluedChance },
      { kind: 'slow', duration: C.glue.slowTime, speedMul: C.glue.slowMul },
    ],
  },
};

function keyOf(f: Fighter): string {
  return f.kind === 'ant' ? unitKey(f.species, f.caste) : creatureKey(f.def);
}

export function attackStats(f: Fighter): { attack: number; kind: AttackKind; cooldown: number } {
  if (f.kind === 'ant') {
    const c = getCaste(f.species, f.caste);
    return { attack: c.attack, kind: c.attackKind, cooldown: c.attackCooldown };
  }
  const d = getCreature(f.def);
  return { attack: d.attack, kind: d.attackKind, cooldown: d.attackCooldown };
}

export function profileOf(f: Fighter, kind: AttackKind): AttackProfile {
  return registeredAttackProfile(keyOf(f), kind) ?? DEFAULT_PROFILES[kind];
}

export function armourOf(f: Fighter): number {
  const r = registeredArmour(keyOf(f));
  const a = r !== undefined ? r : f.kind === 'ant' ? (C.armour[f.caste as keyof typeof C.armour] ?? 0) : creatureTuning(f.def).armour;
  return a < 0 ? 0 : a > C.armourCap ? C.armourCap : a;
}

export function grappleWeight(f: Fighter): number {
  const r = registeredGrapple(keyOf(f));
  if (r) return r.weight;
  return f.kind === 'ant' ? (C.grappleWeight[f.caste as keyof typeof C.grappleWeight] ?? 1) : 0;
}

export function grappleHold(f: Fighter): number {
  const r = registeredGrapple(keyOf(f));
  if (r) return r.hold;
  return f.kind === 'ant' ? (C.grappleHold[f.caste as keyof typeof C.grappleHold] ?? 2) : creatureTuning(f.def).hold;
}

const POWER = C.power as Record<CasteId, number>;

/** Fighting power for odds estimates. */
export function powerOf(f: Fighter): number {
  const base = f.kind === 'ant' ? (POWER[f.caste] ?? 1) : creatureTuning(f.def).power;
  return base * (0.4 + 0.6 * healthFrac(f));
}

export function meleeReach(attacker: Fighter, target: Fighter, profile?: AttackProfile): number {
  return C.biteReach + bodyRadius(attacker) + bodyRadius(target) + (profile?.range ?? 0);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Within striking distance (default attack kind of the attacker). */
export function inReach(attacker: Fighter, target: Fighter, slack = 0): boolean {
  const st = attackStats(attacker);
  return distance(attacker.pos, target.pos) <= meleeReach(attacker, target, profileOf(attacker, st.kind)) + slack;
}

// ---- status effects ----------------------------------------------------------------------------

export function applyStatus(sim: SimState, target: Fighter, e: StatusEffectDef, sourceId: EntityId = 0): boolean {
  if (!target.alive) return false;
  if (e.chance !== undefined && e.chance < 1 && hash01(target.id, sim.tick, sourceId + 31) >= e.chance) return false;
  const m = target.mem;
  const until = sim.tick + Math.max(1, Math.round(e.duration * 30));
  switch (e.kind) {
    case 'poison': {
      const dps = e.dps ?? 0.5;
      const live = (m[COMBAT_MEM.poison] ?? 0) > sim.tick;
      const cap = dps * (e.maxStacks ?? 1);
      const cur = live ? (m[COMBAT_MEM.poisonDps] ?? 0) : 0;
      m[COMBAT_MEM.poisonDps] = Math.max(cur, Math.min(cap, cur + dps));
      m[COMBAT_MEM.poison] = Math.max(until, live ? m[COMBAT_MEM.poison] : 0);
      break;
    }
    case 'slow': {
      const live = (m[COMBAT_MEM.slow] ?? 0) > sim.tick;
      const mul = e.speedMul ?? 0.5;
      m[COMBAT_MEM.slowMul] = live ? Math.min(m[COMBAT_MEM.slowMul] ?? 1, mul) : mul;
      m[COMBAT_MEM.slow] = Math.max(until, live ? m[COMBAT_MEM.slow] : 0);
      break;
    }
    case 'glued':
      m[COMBAT_MEM.glued] = Math.max(until, m[COMBAT_MEM.glued] ?? 0);
      break;
    case 'stunned':
      m[COMBAT_MEM.stunned] = Math.max(until, m[COMBAT_MEM.stunned] ?? 0);
      break;
  }
  getCombat(sim).afflicted.add(target.id);
  return true;
}

/** Speed multiplier from the live status effects of a mover (1 = none). */
export function statusSpeed(m: Record<string, number>, tick: Tick): number {
  if ((m[COMBAT_MEM.glued] ?? 0) > tick || (m[COMBAT_MEM.stunned] ?? 0) > tick) return 0;
  if ((m[COMBAT_MEM.slow] ?? 0) > tick) return m[COMBAT_MEM.slowMul] ?? 1;
  return 1;
}

export function hasAnyStatus(m: Record<string, number>, tick: Tick): boolean {
  return (m[COMBAT_MEM.poison] ?? 0) > tick || (m[COMBAT_MEM.slow] ?? 0) > tick || (m[COMBAT_MEM.glued] ?? 0) > tick || (m[COMBAT_MEM.stunned] ?? 0) > tick;
}

// ---- alarm -------------------------------------------------------------------------------------

/** Raise (or refresh) an alarm call for a colony and lay `alarm` pheromone at the spot. */
export function raiseAlarm(sim: SimState, colony: ColonyId, kind: 'threat' | 'prey', pos: Vec3, cell: CellIndex, threatId: EntityId): void {
  if (!colony) return;
  const st = getCombat(sim);
  if (kind === 'threat' && cell >= 0) sim.pheromones.deposit(colony, Phero.alarm, cell, A.deposit);
  let call: AlarmCall | undefined;
  for (const c of st.calls) {
    if (c.colony === colony && c.kind === kind && distance(c.pos, pos) < A.mergeDist) {
      call = c;
      break;
    }
  }
  if (!call) {
    if (st.calls.length >= A.maxCalls * Math.max(1, sim.colonies.length)) return;
    call = { colony, kind, pos: v3clone(pos), cell, threatId, until: 0, burstAt: 0, enemyPower: 0, allyPower: 0 };
    st.calls.push(call);
    st.stats.alarms++;
  } else {
    call.pos.x += (pos.x - call.pos.x) * 0.3;
    call.pos.y += (pos.y - call.pos.y) * 0.3;
    call.pos.z += (pos.z - call.pos.z) * 0.3;
    if (cell >= 0) call.cell = cell;
    call.threatId = threatId;
  }
  call.until = sim.tick + Math.round(A.ttl * 30);
  if (kind === 'threat' && sim.tick >= call.burstAt) {
    call.burstAt = sim.tick + A.burstTicks;
    sim.emit({ type: 'pheromoneBurst', tick: sim.tick, colony, channel: Phero.alarm, pos: v3clone(pos) });
  }
}

/** Nearest live alarm call of a kind for the ant's colony within `radius`, or null. */
export function nearestCall(sim: SimState, ant: Ant, kind: 'threat' | 'prey', radius: number): AlarmCall | null {
  const calls = getCombat(sim).calls;
  let best: AlarmCall | null = null;
  let bestD = radius;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (c.colony !== ant.colony || c.kind !== kind || c.until <= sim.tick) continue;
    const d = distance(c.pos, ant.pos);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// ---- presence grid -------------------------------------------------------------------------------

function gridIndex(st: CombatState, x: number, y: number, z: number): number {
  let ix = Math.floor(x / GRID);
  let iy = Math.floor(y / GRID);
  let iz = Math.floor(z / GRID);
  ix = ix < 0 ? 0 : ix >= st.gx ? st.gx - 1 : ix;
  iy = iy < 0 ? 0 : iy >= st.gy ? st.gy - 1 : iy;
  iz = iz < 0 ? 0 : iz >= st.gz ? st.gz - 1 : iz;
  return ix + st.gx * (iz + st.gz * iy);
}

function mark(st: CombatState, p: Vec3, bit: number): void {
  const h = GRID / 2;
  for (let k = 0; k < 8; k++) {
    const i = gridIndex(st, p.x + (k & 1 ? h : -h), p.y + (k & 2 ? h : -h), p.z + (k & 4 ? h : -h));
    st.grid[i] |= bit;
  }
}

/** Rebuild the coarse "who is around" grid (cheap gate in front of every perception query). */
export function rebuildPresence(sim: SimState): void {
  const st = getCombat(sim);
  st.grid.fill(0);
  st.gridTick = sim.tick;
  if (sim.colonies.length > 1) {
    for (const a of sim.ants) if (a.alive && a.colony > 0 && a.colony < 30) mark(st, a.pos, 1 << a.colony);
  }
  for (const c of sim.creatures) {
    if (!c.alive) continue;
    const role = getCreature(c.def).role;
    if (THREAT_ROLES[role] === 1) mark(st, c.pos, 1);
    else if (role === 'prey') mark(st, c.pos, PREY_BIT);
  }
}

/** Bit mask of what is near `p` other than ants of `colony` (0 = nothing: skip the query). */
export function presenceAt(sim: SimState, p: Vec3, colony: ColonyId): number {
  const st = getCombat(sim);
  return st.grid[gridIndex(st, p.x, p.y, p.z)] & ~(colony > 0 && colony < 30 ? 1 << colony : 0);
}

// ---- perception ------------------------------------------------------------------------------------

export interface Scan {
  /** Best enemy to fight (ant or threat creature in mandible range of the ground), or null. */
  enemy: Fighter | null;
  enemyDist: number;
  /** Nearest huntable prey creature. */
  prey: Creature | null;
  /** Airborne predator close enough to scare. */
  flyer: Creature | null;
  enemyPower: number;
  allyPower: number;
}

const _movers: Mover[] = [];
const _scan: Scan = { enemy: null, enemyDist: 0, prey: null, flyer: null, enemyPower: 0, allyPower: 0 };

/** One spatial query answering everything the survival behaviors ask. Result object is reused. */
export function scanAround(sim: SimState, ant: Ant, sense: number): Scan {
  const s = _scan;
  s.enemy = null;
  s.enemyDist = Infinity;
  s.prey = null;
  s.flyer = null;
  s.enemyPower = 0;
  s.allyPower = powerOf(ant);
  const odds = F.oddsRadius;
  const ignore = (ant.mem['ft.noT'] ?? 0) > sim.tick ? ant.mem['ft.no'] : 0;
  sim.spatial.queryMovers(ant.pos.x, ant.pos.y, ant.pos.z, Math.max(sense, odds), _movers);
  let bestScore = Infinity;
  let preyD: number = F.preySense;
  let flyD: number = F.flyerScare;
  for (let i = 0; i < _movers.length; i++) {
    const m = _movers[i];
    if (m === ant || !m.alive) continue;
    const d = distance(m.pos, ant.pos);
    if (m.kind === 'ant') {
      const o = m as Ant;
      if (o.colony === ant.colony) {
        if (d <= odds && o.caste !== 'queen') s.allyPower += powerOf(o);
        continue;
      }
      if (d <= odds) s.enemyPower += powerOf(o);
      if (d > sense || o.id === ignore) continue;
      // M3: royals are fought last — a raid kills the defenders first, so a queen only falls once
      // her guard is gone (explicit player attack orders bypass this scan)
      const royalLast = o.caste === 'queen' || o.caste === 'king' ? F.royalLast : 0;
      // prefer an enemy that is already held (swarming works) — but not one that is already
      // surrounded: a full ring sends the next fighter to another opponent, so a skirmish reads
      // as knots of grappling pairs instead of one pile
      const lat = o.mem[COMBAT_MEM.latchers] ?? 0;
      const score = d - (lat > 0 && lat < F.crowdedLatch ? 0.8 : 0) + (lat >= F.crowdedLatch && ant.targetId !== o.id ? F.crowdedPenalty : 0) + (o.id % 7) * 0.01 + royalLast;
      if (score < bestScore) {
        bestScore = score;
        s.enemy = o;
        s.enemyDist = d;
      }
    } else {
      const c = m as Creature;
      if (isPrey(c)) {
        if (d < preyD && c.id !== ignore) {
          preyD = d;
          s.prey = c;
        }
        continue;
      }
      if (!perceivedThreat(sim, ant.colony, c)) continue;
      const r = bodyRadius(c);
      if (isAirborne(sim, c)) {
        if (d < flyD) {
          flyD = d;
          s.flyer = c;
        }
        continue;
      }
      if (d - r <= odds) s.enemyPower += powerOf(c);
      if (d - r > sense || c.id === ignore) continue;
      const score = d - r - 0.5;
      if (score < bestScore) {
        bestScore = score;
        s.enemy = c;
        s.enemyDist = d;
      }
    }
  }
  return s;
}

// ---- the survival decision ---------------------------------------------------------------------------

export const NONE = 0;
export const FIGHT = 1;
export const FLEE = 2;
export const HUNT = 3;

export interface Assessment {
  mode: number;
  /** Entity to fight / hunt / run from (0 = none). */
  targetId: EntityId;
  /** Alarm call being answered when there is no enemy in sight yet. */
  call: AlarmCall | null;
  /** FLEE only: the danger is perceived right now (not just lingering panic). */
  fresh: boolean;
}

const _as: Assessment = { mode: NONE, targetId: 0, call: null, fresh: false };
let _asAnt = 0;
let _asTick = -1;
let _asSim: SimState | null = null;

function set(mode: number, targetId: EntityId, call: AlarmCall | null, fresh = true): Assessment {
  _as.fresh = fresh;
  _as.mode = mode;
  _as.targetId = targetId;
  _as.call = call;
  return _as;
}

export function isBrave(ant: Ant): boolean {
  return ant.caste === 'soldier' || ant.caste === 'major' || ant.caste === 'nasute' || (ant.mem['raid'] ?? 0) > 0;
}

/**
 * M3 home muster: an alarm call raised against enemy ANTS close to our own nest. Workers answer it
 * from `homeMusterRadius` whatever the local odds, so a raid meets the colony instead of picking
 * off passers-by one at a time (predators keep B1's rule: workers weigh the odds and run indoors).
 */
function homeRaidCall(sim: SimState, ant: Ant): AlarmCall | null {
  const calls = getCombat(sim).calls;
  if (calls.length === 0) return null;
  const colony = sim.getColony(ant.colony);
  if (!colony || !colony.alive) return null;
  let best: AlarmCall | null = null;
  let bestD: number = F.homeMusterRadius;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (c.colony !== ant.colony || c.kind !== 'threat' || c.until <= sim.tick) continue;
    const d = distance(c.pos, ant.pos);
    if (d >= bestD || distance(c.pos, colony.nestPos) > F.homeRadius) continue;
    const t = sim.getEntity(c.threatId);
    if (!t || t.kind !== 'ant') continue;
    // enough defenders are on it already: the rest of the colony keeps working (a few raiders on
    // a log held 70 termites in `fight` for five minutes while the larder ran dry)
    if (c.enemyPower > 0 && c.allyPower > c.enemyPower * F.homeMusterOdds && d > F.senseWorker) continue;
    bestD = d;
    best = c;
  }
  return best;
}

function nearOwnNest(sim: SimState, ant: Ant, p: Vec3): boolean {
  const colony = sim.getColony(ant.colony);
  return !!colony && colony.alive && distance(p, colony.nestPos) <= F.homeRadius;
}

export function homeSteps(sim: SimState, ant: Ant): number {
  return ant.cell >= 0 ? sim.nav.homeDistance(ant.colony, ant.cell) : HOME_UNREACHABLE;
}

/**
 * What should this ant do about danger right now? Pure and cheap (one grid lookup when nothing
 * is around); memoised for the (ant, tick) so `flee.score` and `fight.score` share one answer.
 *
 *   brave castes (soldier / major / nasute, raid members)   fight anything in sight, answer alarm
 *                                                           calls from afar, give up when nearly dead
 *   workers   inside the nest: defend it                    outside: fight when the local odds are
 *             even or better, else run home; hunt prey they stumble on; scatter from flyers
 *   brood carriers and badly hurt ants                      run
 *   queen / king                                            bite back only at arm's length
 */
export function assess(sim: SimState, ant: Ant): Assessment {
  if (_asAnt === ant.id && _asTick === sim.tick && _asSim === sim) return _as;
  _asAnt = ant.id;
  _asTick = sim.tick;
  _asSim = sim;
  const mem = ant.mem;
  if (mem['exiled'] || ant.falling) return set(NONE, 0, null);
  // final round: a member of a party that is going home disengages — it fights only what has
  // hold of it, so recalled raids and beaten war parties actually leave the fight
  if (mem['raid.ret'] === 1 && (mem['raid'] ?? 0) > 0) {
    if (presenceAt(sim, ant.pos, ant.colony) !== 0) {
      const s = scanAround(sim, ant, 1.8);
      if (s.enemy && ((mem[COMBAT_MEM.latchers] ?? 0) > 0 || s.enemyDist <= 1.3)) return set(FIGHT, s.enemy.id, null);
    }
    return set(NONE, 0, null);
  }
  const st = getCombat(sim);
  const presence = presenceAt(sim, ant.pos, ant.colony);
  const royal = ant.caste === 'queen' || ant.caste === 'king';
  const brave = isBrave(ant);
  const panicking = (mem['fl.t'] ?? 0) > sim.tick;
  if (presence === 0) {
    if (panicking) return set(FLEE, mem['fl.id'] ?? 0, null, false);
    if (st.calls.length === 0 || royal) return set(NONE, 0, null);
    if (brave) {
      const call = nearestCall(sim, ant, 'threat', A.soldierRadius);
      if (call && healthFrac(ant) > F.fleeHealthSoldier) return set(FIGHT, 0, call);
    } else if (ant.carrying?.kind !== 'brood' && healthFrac(ant) > F.fleeHealthWorker) {
      const call = homeRaidCall(sim, ant);
      if (call) return set(FIGHT, 0, call);
    }
    return set(NONE, 0, null);
  }

  const sense = royal ? 2.6 : brave ? F.senseSoldier : F.senseWorker;
  const s = scanAround(sim, ant, sense);
  const hf = healthFrac(ant);
  const enemy = s.enemy;

  if (royal) return enemy && s.enemyDist <= 2.6 ? set(FIGHT, enemy.id, null) : set(NONE, 0, null);

  if (brave) {
    if ((hf <= F.fleeHealthSoldier || ant.carrying?.kind === 'brood') && (enemy || panicking)) return set(FLEE, enemy ? enemy.id : 0, null, !!enemy);
    if (enemy) return set(FIGHT, enemy.id, null);
    const call = nearestCall(sim, ant, 'threat', A.soldierRadius);
    if (call) return set(FIGHT, 0, call);
    return set(NONE, 0, null);
  }

  // ---- workers ----
  const carriesBrood = ant.carrying?.kind === 'brood';
  if (enemy) {
    if (carriesBrood || hf <= F.fleeHealthWorker) return set(FLEE, enemy.id, null);
    const committed = ant.targetId === enemy.id && (mem['ft.c'] ?? 0) > sim.tick;
    if (committed) return set(FIGHT, enemy.id, null);
    // indoors everybody defends; out in the open a worker weighs the odds
    if (homeSteps(sim, ant) <= F.nestDefendSteps && !navOf(sim).isExposed(ant.cell)) return set(FIGHT, enemy.id, null);
    // …and enemy ants at the doorstep are everybody's business too (home muster)
    if (enemy.kind === 'ant' && nearOwnNest(sim, ant, enemy.pos)) return set(FIGHT, enemy.id, null);
    if (s.allyPower >= s.enemyPower * F.oddsWorker && !panicking) return set(FIGHT, enemy.id, null);
    return set(FLEE, enemy.id, null);
  }
  if (panicking) return set(FLEE, mem['fl.id'] ?? 0, null, false);
  if (s.flyer && !carriesBrood && navOf(sim).isExposed(ant.cell)) return set(FLEE, s.flyer.id, null);
  if (hf <= F.fleeHealthWorker) return set(NONE, 0, null);
  if (s.prey && !ant.carrying && (s.prey.mem[COMBAT_MEM.latchers] ?? 0) < grappleHold(s.prey) * F.preyMobFactor) return set(HUNT, s.prey.id, null);
  if (st.calls.length > 0) {
    if (!carriesBrood) {
      const muster = homeRaidCall(sim, ant);
      if (muster) return set(FIGHT, 0, muster);
    }
    const call = nearestCall(sim, ant, 'threat', A.workerRadius);
    if (call) {
      // a fight nearby: join when it is going well, get indoors when it is not
      if (call.allyPower >= call.enemyPower * F.oddsWorker && !carriesBrood) return set(FIGHT, 0, call);
      if (navOf(sim).isExposed(ant.cell)) return set(FLEE, call.threatId, null);
      return set(NONE, 0, null);
    }
    if (!ant.carrying) {
      const hunt = nearestCall(sim, ant, 'prey', A.workerRadius);
      if (hunt) return set(HUNT, hunt.threatId, hunt);
    }
  }
  return set(NONE, 0, null);
}

// ---- damage & death ----------------------------------------------------------------------------------

function onAntKilled(sim: SimState, victim: Ant, killerColony: ColonyId, devour: boolean): void {
  const before = sim.items.length;
  // danger memory: a worker lost in a fight away from home warns the foragers off that place
  if (killerColony !== victim.colony && victim.caste !== 'queen' && victim.caste !== 'king' && !victim.mem['raid'] && victim.cell >= 0) {
    const steps = sim.nav.homeDistance(victim.colony, victim.cell);
    if (steps === HOME_UNREACHABLE || steps > F.nestDefendSteps) noteDanger(sim, victim.colony, victim.pos);
  }
  sim.killAnt(victim, killerColony === victim.colony && killerColony !== 0 ? 'cull' : 'combat', !devour);
  if (!killerColony || killerColony === victim.colony) return;
  const kc = sim.getColony(killerColony);
  if (!kc) return;
  kc.stats.kills++;
  // an enemy that fell inside our nest is OUR hygiene problem: it goes to our midden
  const corpse = sim.items.length > before ? sim.items[sim.items.length - 1] : undefined;
  if (corpse && corpse.itemKind === 'corpse' && corpse.cell >= 0) {
    const steps = sim.nav.homeDistance(killerColony, corpse.cell);
    if (steps !== HOME_UNREACHABLE && steps <= C.regenHomeSteps) corpse.colony = killerColony;
  }
}

function onCreatureKilled(sim: SimState, victim: Creature, killerColony: ColonyId): void {
  const before = sim.items.length;
  sim.killCreature(victim, killerColony);
  const kc = killerColony ? sim.getColony(killerColony) : undefined;
  if (!kc) return;
  kc.stats.kills++;
  const corpse = sim.items.length > before ? sim.items[sim.items.length - 1] : undefined;
  if (corpse && corpse.itemKind === 'corpse') {
    // the hunters know where the carcass lies: haulers butcher it without having to find it
    corpse.up = v3clone(victim.up);
    getExt(sim, kc.id).knownSources.set(corpse.id, sim.tick);
  }
  const d = getCreature(victim.def);
  if (d.threat > 0 || d.foodValue >= 30) {
    sim.emit({ type: 'alert', tick: sim.tick, code: 'info', colony: kc.id, pos: v3clone(victim.pos), id: 0, text: d.threat > 0 ? `${d.name} killed` : `${d.name} brought down — food!` });
  }
}

/**
 * Apply damage from any cause. `killerColony` gets the kill credit (0 = nobody). Emits `damage`,
 * handles death (`devour`: a killed ant leaves no corpse). Returns true if the target died.
 */
export function hurt(sim: SimState, target: Fighter, amount: number, killerColony: ColonyId = 0, devour = false): boolean {
  if (!target.alive || !(amount > 0)) return false;
  target.health -= amount;
  target.mem[COMBAT_MEM.hitTick] = sim.tick;
  if (killerColony) target.mem[CREDIT_MEM] = killerColony;
  sim.emit({ type: 'damage', tick: sim.tick, target: target.id, amount, pos: v3clone(target.pos) });
  if (target.health > 0) return false;
  target.health = 0;
  const credit = killerColony || (target.mem[CREDIT_MEM] ?? 0);
  getCombat(sim).stats.kills++;
  if (target.kind === 'ant') onAntKilled(sim, target, credit, devour);
  else onCreatureKilled(sim, target, credit);
  return true;
}

export interface AttackOpts {
  /** Replace the attacker's base attack value (pounce, special strikes). */
  damage?: number;
  damageMul?: number;
  /** Attack kind override (default: the attacker's `attackKind`). */
  kind?: AttackKind;
  ignoreReach?: boolean;
  ignoreCooldown?: boolean;
  /** Extra reach tolerance (callers that already did their own range check). */
  slack?: number;
  /** Do not latch on (hit-and-run attackers). */
  noLatch?: boolean;
  /** A killed ant leaves no corpse (the predator eats it / carries it off). */
  devour?: boolean;
}

const NO_OPTS: AttackOpts = {};
const _d = v3();

/**
 * Resolve one melee attack. Returns the damage dealt (> 0) or 0 when no attack happened
 * (cooldown, out of reach, stunned, invalid target). Check `target.alive` afterwards for a kill.
 */
export function attack(sim: SimState, attacker: Fighter, target: Fighter, opts: AttackOpts = NO_OPTS): number {
  if (!attacker.alive || !target.alive || attacker === target) return 0;
  const tick = sim.tick;
  const am = attacker.mem;
  if ((am[COMBAT_MEM.stunned] ?? 0) > tick) return 0;
  if (!opts.ignoreCooldown && tick < attacker.attackReadyAt) return 0;
  const st = attackStats(attacker);
  const kind = opts.kind ?? st.kind;
  const profile = profileOf(attacker, kind);
  _d.x = attacker.pos.x - target.pos.x;
  _d.y = attacker.pos.y - target.pos.y;
  _d.z = attacker.pos.z - target.pos.z;
  const dist = Math.hypot(_d.x, _d.y, _d.z);
  if (!opts.ignoreReach && dist > meleeReach(attacker, target, profile) + (opts.slack ?? 0)) return 0;

  const glued = (am[COMBAT_MEM.glued] ?? 0) > tick;
  // M3: an ANT with enemies hanging on its legs bites slower, down to 1/(1+grappleAttackSlow) of
  // its rate when fully pinned. Without this a soldier killed mobbing workers at full speed (one
  // every ~2 s) and a picket of three soldiers wiped out a 20-ant colony; now numbers count.
  let cd = st.cooldown * (glued ? 2 : 1);
  if (attacker.kind === 'ant') {
    const n = am[COMBAT_MEM.latchers] ?? 0;
    if (n > 0) cd *= 1 + C.grappleAttackSlow * (am[COMBAT_MEM.pinned] === 1 ? 1 : Math.min(1, n / grappleHold(attacker)));
  }
  attacker.attackReadyAt = tick + Math.max(1, Math.round(cd * 30));
  attacker.targetId = target.id;
  am[COMBAT_MEM.attackTick] = tick;
  if (attacker.kind === 'ant') attacker.anim = 'bite';
  else am[CREATURE_MEM.attackTick] = tick;
  const combat = getCombat(sim);
  combat.stats.attacks++;
  sim.emit({ type: 'attack', tick, attacker: attacker.id, target: target.id, kind, pos: v3clone(target.pos) });

  let dmg = (opts.damage ?? st.attack) * (opts.damageMul ?? 1) * (profile.damageMul ?? 1);
  // facing: bites from the side and from behind hurt more (static and airborne targets have no blind side)
  if (target.locomotion === 'surface' && dist > 1e-3) {
    const f = (target.forward.x * _d.x + target.forward.y * _d.y + target.forward.z * _d.z) / dist;
    if (f < -0.35) dmg *= C.rearMul;
    else if (f < 0.35) dmg *= C.flankMul;
  }
  if (target.mem[COMBAT_MEM.pinned] === 1) dmg *= C.pinnedMul;
  if (attacker.kind === 'ant' && attacker.possessed) dmg *= C.possessedMul;
  if (attacker.kind === 'creature') dmg *= am['c.tough'] ?? 1; // director difficulty scaling
  dmg *= 1 - armourOf(target) * (1 - (profile.armourPierce ?? 0));

  const attackerColony = attacker.kind === 'ant' ? attacker.colony : attacker.colony;
  const prey = target.kind === 'creature' && !isThreatCreature(target);

  // alarm: the victim's colony and the biter's colony both smell the fight
  if (target.kind === 'ant' && target.colony !== attackerColony) {
    raiseAlarm(sim, target.colony, 'threat', target.pos, target.cell, attacker.id);
    noteAttackOnColony(sim, target, attacker);
  }
  if (attacker.kind === 'ant' && !(target.kind === 'ant' && target.colony === attacker.colony)) {
    raiseAlarm(sim, attacker.colony, prey ? 'prey' : 'threat', target.pos, attacker.cell, target.id);
  }

  // grapple: a biting ant hangs on
  if (attacker.kind === 'ant' && !opts.noLatch && target.locomotion !== 'static') {
    am[COMBAT_MEM.latchId] = target.id;
    am[COMBAT_MEM.latchUntil] = tick + C.latchTicks;
  }
  am['ft.c'] = tick + F.commitTicks;

  if (profile.effects) for (const e of profile.effects) applyStatus(sim, target, e, attacker.id);
  hurt(sim, target, dmg, attackerColony, opts.devour === true);
  if (!target.alive) {
    attacker.targetId = 0;
    am[COMBAT_MEM.latchId] = 0;
  }
  return dmg;
}

/** Alerts for the owner of an attacked ant (rate-limited per colony by `alertOnce`). */
function noteAttackOnColony(sim: SimState, victim: Ant, attacker: Fighter): void {
  const colony = sim.getColony(victim.colony);
  if (!colony || colony.controller !== 'player') return;
  if (victim.caste === 'queen') alertOnce(sim, colony, 'queenInDanger', 'The queen is under attack!', victim.pos, victim.id, 15);
  else alertOnce(sim, colony, 'underAttack', attacker.kind === 'creature' ? `${getCreature(attacker.def).name} is attacking the colony` : 'The colony is under attack', victim.pos, attacker.id, C.alertCooldown);
}

// ---- grapple helpers ---------------------------------------------------------------------------------

export function latchedOn(ant: Ant, tick: Tick): EntityId {
  const id = ant.mem[COMBAT_MEM.latchId] ?? 0;
  return id && (ant.mem[COMBAT_MEM.latchUntil] ?? 0) > tick ? id : 0;
}

/** Throw off every attacker latched onto `victim` (thrashing prey, a spider tearing free). */
export function shakeOff(sim: SimState, victim: Fighter): number {
  let n = 0;
  sim.spatial.queryMovers(victim.pos.x, victim.pos.y, victim.pos.z, bodyRadius(victim) + C.latchBreakDist + 2, _movers);
  for (const m of _movers) {
    if (m.kind !== 'ant') continue;
    const a = m as Ant;
    if (a.mem[COMBAT_MEM.latchId] === victim.id) {
      a.mem[COMBAT_MEM.latchId] = 0;
      n++;
    }
  }
  return n;
}
