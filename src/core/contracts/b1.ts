/**
 * Contract extensions owned by stream B1 (PLAN §10.2, D22) — combat, creatures, rival colonies,
 * threat director. Additive only — never redefines or widens a type from `core/contracts.ts`.
 *
 * WHAT OTHER STREAMS NEED FROM HERE
 *  - B3 (faction data): `StatusEffectDef` / `AttackProfile` + `registerAttackProfile`,
 *    `registerArmour`, `registerGrapple`. A caste's `attackKind` alone already selects a default
 *    profile (sting → venom DoT, acid → armour-piercing burn, glue → stuck + slow); register a
 *    profile under `'<species>:<caste>'` to override it, or under `'kind:<attackKind>'` to change
 *    the default for every user of that kind.
 *  - B4 (render): `creatureAnim(creature, tick)`, `CREATURE_MEM`, `COMBAT_MEM`, `statusActive`.
 *  - B5 (shell): `SimOptionsB1.director` (or the `setDirector` command) and `DIFFICULTY_INTENSITY`.
 */
import type { AttackKind, CasteId, Creature, CreatureId, EntityId, SimOptions, SpeciesId, Tick } from '../contracts';

// =====================================================================================
// Status effects (generic mechanism; data supplied per attack)
// =====================================================================================

/**
 *  - `poison`  damage over time (venom, acid burn); ignores armour; stacks up to `maxStacks`
 *  - `slow`    speed multiplied by `speedMul` while active (the strongest slow wins)
 *  - `glued`   cannot move; attacks at half rate (nasute glue)
 *  - `stunned` cannot move or attack (knock-back, heavy strikes)
 */
export type StatusKind = 'poison' | 'slow' | 'glued' | 'stunned';

export interface StatusEffectDef {
  kind: StatusKind;
  /** Seconds the effect lasts (re-applying refreshes the timer). */
  duration: number;
  /** `poison`: health lost per second per stack. */
  dps?: number;
  /** `slow`: speed multiplier 0..1. */
  speedMul?: number;
  /** Probability 0..1 that a landed hit applies it (default 1). */
  chance?: number;
  /** `poison`: how many applications add up (default 1). */
  maxStacks?: number;
}

/** How one kind of attack behaves beyond `attack` / `attackCooldown` of the caste or creature. */
export interface AttackProfile {
  /** Extra reach in world units on top of the melee reach (sprays, squirts). */
  range?: number;
  /** Share 0..1 of the target's armour this attack ignores. */
  armourPierce?: number;
  /** Multiplier on the direct damage (glue hardly hurts). Default 1. */
  damageMul?: number;
  /** Status effects applied to the target on a hit. */
  effects?: readonly StatusEffectDef[];
}

const attackProfiles = new Map<string, AttackProfile>();
const armourTable = new Map<string, number>();
const grappleTable = new Map<string, { weight: number; hold: number }>();

/** Key of a unit in the B1 registries: `'<species>:<caste>'` or `'creature:<id>'`. */
export function unitKey(species: SpeciesId, caste: CasteId): string {
  return species + ':' + caste;
}
export function creatureKey(id: CreatureId): string {
  return 'creature:' + id;
}

/** Register (or replace) an attack profile under a unit key or `'kind:<attackKind>'`. */
export function registerAttackProfile(key: string, profile: AttackProfile): void {
  attackProfiles.set(key, profile);
}
/** Registered profile for a unit, falling back to the registered kind profile; undefined = B1 default. */
export function registeredAttackProfile(key: string, kind: AttackKind): AttackProfile | undefined {
  return attackProfiles.get(key) ?? attackProfiles.get('kind:' + kind);
}
/** Armour 0..0.9 = share of incoming direct damage absorbed. Overrides B1's per-caste default. */
export function registerArmour(key: string, armour: number): void {
  armourTable.set(key, armour);
}
export function registeredArmour(key: string): number | undefined {
  return armourTable.get(key);
}
/**
 * Grappling numbers of a unit: `weight` = how much it pins when latched onto a victim, `hold` =
 * total latched weight needed to immobilise IT (speed falls linearly on the way there).
 */
export function registerGrapple(key: string, weight: number, hold: number): void {
  grappleTable.set(key, { weight, hold });
}
export function registeredGrapple(key: string): { weight: number; hold: number } | undefined {
  return grappleTable.get(key);
}

/**
 * `mem` keys the combat system writes on ants AND creatures (JSON-plain numbers, readable by
 * anyone). Expiry values are ticks: the effect is active while `mem[key] > tick`.
 */
export const COMBAT_MEM = {
  /** Expiry tick of each status effect. */
  poison: 'st.poison',
  /** Total poison dps currently applied. */
  poisonDps: 'st.poisonD',
  slow: 'st.slow',
  slowMul: 'st.slowM',
  glued: 'st.glued',
  stunned: 'st.stun',
  /** Attacker side of a grapple: id of the victim this ant is latched onto, and expiry tick. */
  latchId: 'gr.id',
  latchUntil: 'gr.t',
  /** Victim side: number of latched attackers, 1 while fully pinned (immobile). */
  latchers: 'gr.n',
  pinned: 'gr.pin',
  /** Tick this unit was last damaged / last landed an attack. */
  hitTick: 'hit.t',
  attackTick: 'bite.t',
} as const;

export function statusActive(mem: Readonly<Record<string, number>>, kind: StatusKind, tick: Tick): boolean {
  const k = kind === 'poison' ? COMBAT_MEM.poison : kind === 'slow' ? COMBAT_MEM.slow : kind === 'glued' ? COMBAT_MEM.glued : COMBAT_MEM.stunned;
  const v = mem[k];
  return v !== undefined && v > tick;
}

// =====================================================================================
// Creatures
// =====================================================================================

/** `Creature.mem` keys written by the creatures system (see `creatureAnim` for the usual reader). */
export const CREATURE_MEM = {
  /** Dormant in its lair until this tick (resident predators before the director wakes them). */
  sleepUntil: 'c.sleep',
  /** 1 while buried / hidden (antlion in its pit, spider tucked in its lair). */
  hidden: 'c.hide',
  /** Tick of the last strike (attack animation trigger). */
  attackTick: 'c.atk',
  /** Leaping until this tick (jumping spider pounce, wasp swoop). */
  pounceUntil: 'c.pounce',
  /** Feeding until this tick. */
  eatUntil: 'c.eat',
  /** Thrashing until this tick (caterpillar / worm shaking attackers off). */
  thrashUntil: 'c.thrash',
  /** 1 while it holds a dead ant in its jaws / legs (spider, wasp, antlion, mantis). */
  carrying: 'c.carry',
  /** 1 = generic prey tag: predators may hunt it (B3 can set it on aphids). */
  prey: 'prey',
  /** Pit / lair radius the creature is bound to (0 = none). */
  siteRadius: 'c.siteR',
} as const;

export type CreatureAnim = 'idle' | 'walk' | 'stalk' | 'pounce' | 'attack' | 'eat' | 'carry' | 'flee' | 'hidden' | 'thrash' | 'fly' | 'stuck' | 'dead';

/** Coarse animation state of a creature for renderers / audio (pure function of contract data). */
export function creatureAnim(c: Readonly<Creature>, tick: Tick): CreatureAnim {
  const m = c.mem;
  if (!c.alive || c.state === 'dead') return 'dead';
  if (tick - (m[CREATURE_MEM.attackTick] ?? -1000) < 9) return 'attack';
  if ((m[CREATURE_MEM.pounceUntil] ?? 0) > tick) return 'pounce';
  if ((m[CREATURE_MEM.thrashUntil] ?? 0) > tick) return 'thrash';
  if ((m[COMBAT_MEM.glued] ?? 0) > tick || (m[COMBAT_MEM.stunned] ?? 0) > tick || m[COMBAT_MEM.pinned] === 1) return 'stuck';
  if ((m[CREATURE_MEM.eatUntil] ?? 0) > tick) return 'eat';
  if (m[CREATURE_MEM.hidden] === 1) return 'hidden';
  if (c.locomotion === 'fly') return m[CREATURE_MEM.carrying] === 1 ? 'carry' : 'fly';
  if (c.state === 'flee') return m[CREATURE_MEM.carrying] === 1 ? 'carry' : 'flee';
  if (c.state === 'stalk') return 'stalk';
  return c.moveSpeed > 0.05 ? 'walk' : 'idle';
}

/** Creature roles that ants treat as threats (the rest are prey or livestock). */
export const THREAT_ROLES: Readonly<Record<string, 1>> = { hunter: 1, ambush: 1, tank: 1, flyer: 1, boss: 1 };

// =====================================================================================
// Raids (rival AI, director invasions, distant Attack beacons)
// =====================================================================================

export type RaidPhase = 'muster' | 'advance' | 'assault' | 'return' | 'done';
export type RaidKind = 'scout' | 'picket' | 'raid' | 'invasion';

/** Read-only summary of an active raid (UI / debug / tests). Members carry `mem.raid = id`. */
export interface RaidInfo {
  id: number;
  kind: RaidKind;
  colony: number;
  /** Colony under attack (0 = a point target such as a food source or a beacon). */
  targetColony: number;
  phase: RaidPhase;
  members: EntityId[];
  startedTick: Tick;
}

// =====================================================================================
// Director / difficulty
// =====================================================================================

/**
 * Optional start-up options read by the director and the rivals system from `sim.options`
 * (pass them in the options object given to `new Simulation(...)`). Everything can also be
 * changed at runtime with the `setDirector` command.
 *
 *  - `director.enabled`   threats on/off (default OFF — sandbox / tests / M1 fixtures)
 *  - `director.intensity` budget multiplier = difficulty (see `DIFFICULTY_INTENSITY`)
 *  - `rivals`             found the map's rival colony at start even while the director is off
 */
export interface SimOptionsB1 extends SimOptions {
  director?: { enabled?: boolean; intensity?: number };
  rivals?: boolean;
}

export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard' | 'brutal';

/** Director intensity per difficulty name (`peaceful` = director disabled). */
export const DIFFICULTY_INTENSITY: Readonly<Record<Difficulty, number>> = { peaceful: 0, easy: 0.6, normal: 1, hard: 1.5, brutal: 2.2 };

/** Kinds of event the director can schedule (also the `kind` of `DirectorEventInfo`). */
export type DirectorEventKind = 'scout' | 'predator' | 'prey' | 'beetleRaid' | 'rivalRaid' | 'tubeRaid' | 'waspSeason' | 'boss';

export interface DirectorEventInfo {
  kind: DirectorEventKind;
  tick: Tick;
  threat: number;
}
