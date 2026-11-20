import {
  JOB_KINDS,
  activeChamber,
  v3,
  v3clone,
  type AlertCode,
  type Ant,
  type BroodStage,
  type CellIndex,
  type Chamber,
  type ChamberKind,
  type Colony,
  type ColonyId,
  type EntityId,
  type Job,
  type JobKind,
  type SimState,
  type Task,
  type Tick,
  type Vec3,
} from '../../core';
import { BALANCE } from '../data/balance';

/**
 * A2b-private per-colony state that does not fit the frozen `Colony` contract (demand levels,
 * explored-area memory, expansion plans, beacon assignments, alert cooldowns…). Kept in a
 * WeakMap keyed by the sim so several simulations can coexist (tests) and nothing leaks.
 * Everything in here is derived deterministically from sim state and commands.
 */
export interface ExpansionPlan {
  kind: ChamberKind;
  /** Designation ids still to be dug. */
  designations: number[];
  center: Vec3;
  radius: number;
  startedTick: Tick;
}

export interface BeaconCells {
  version: number;
  cells: Int32Array;
  weights: Float32Array;
}

export interface ColonyExt {
  /** False in the wander fixture: no economy, no jobs, duty behaviors never score. */
  active: boolean;
  /** Stimulus per job kind (urgency × player priority, 0..2), refreshed by the jobs system. */
  demand: Record<JobKind, number>;
  jobsById: Map<number, Job>;
  jobByKey: Map<string, Job>;
  /** Ants currently holding a forage task. */
  foragers: number;
  workers: number;
  /** Food sources this colony has discovered (id → tick of discovery). */
  knownSources: Map<EntityId, Tick>;
  /** Coarse explored-area memory (see `exploreKey`), decays over time. */
  explored: Map<number, number>;
  alertAt: Partial<Record<AlertCode, Tick>>;
  baseVolume: number;
  nestVolume: number;
  popCap: number;
  /** Designations created by the colony itself (not player-painted). */
  autoDesignations: Set<number>;
  plan: ExpansionPlan | null;
  nextExpandTick: Tick;
  expansions: number;
  beaconAssigned: Map<number, EntityId[]>;
  beaconCells: Map<number, BeaconCells>;
  /** Designation id → tick until which its dig job is closed (nothing workable was in reach). */
  digBlocked: Map<number, Tick>;
  /** Counters for tests/debug: how foragers found their food. */
  counters: { scoutFinds: number; trailFinds: number; trailFollows: number; deliveries: number };
  patrolPoints: CellIndex[];
  /** `food` pheromone level around the nest entrance (recruitment signal). */
  entranceTrail: number;
  /** Brood count per nursery chamber id (refreshed by the jobs system). */
  nurseryLoad: Map<number, number>;
  /** Queen id last seen alive (to detect her death). */
  lastQueenId: EntityId;
  /**
   * Final round — danger memory: places away from the nest where nestmates were killed in a
   * fight lately. Foragers leave food inside a live zone alone (see `inDangerZone`), so a colony
   * stops feeding its workers one by one to enemy soldiers camped on a shared source.
   */
  danger: { x: number; y: number; z: number; until: Tick }[];
}

const DANGER_RADIUS = 9;

/** Remember a combat death at `p` (called by the combat system for deaths away from the nest). */
export function noteDanger(sim: SimState, colony: number, p: Vec3): void {
  const ext = getExt(sim, colony);
  const add = 50 * 30;
  for (const z of ext.danger) {
    if (Math.hypot(z.x - p.x, z.y - p.y, z.z - p.z) > DANGER_RADIUS) continue;
    z.until = Math.min(sim.tick + 240 * 30, Math.max(z.until, sim.tick) + add);
    return;
  }
  if (ext.danger.length >= 8) ext.danger.shift();
  ext.danger.push({ x: p.x, y: p.y, z: p.z, until: sim.tick + add });
}

export function inDangerZone(sim: SimState, colony: number, p: Vec3): boolean {
  const d = getExt(sim, colony).danger;
  if (d.length === 0) return false;
  for (let i = d.length - 1; i >= 0; i--) {
    const z = d[i];
    if (z.until <= sim.tick) {
      d.splice(i, 1);
      continue;
    }
    if (Math.hypot(z.x - p.x, z.y - p.y, z.z - p.z) <= DANGER_RADIUS) return true;
  }
  return false;
}

const store = new WeakMap<object, ColonyExt[]>();

function makeExt(sim: SimState): ColonyExt {
  const demand = {} as Record<JobKind, number>;
  for (const k of JOB_KINDS) demand[k] = 0;
  return {
    active: sim.options.fixture !== 'wander',
    demand,
    jobsById: new Map(),
    jobByKey: new Map(),
    foragers: 0,
    workers: 0,
    knownSources: new Map(),
    explored: new Map(),
    alertAt: {},
    baseVolume: 0,
    nestVolume: 0,
    popCap: 0,
    autoDesignations: new Set(),
    plan: null,
    nextExpandTick: 0,
    expansions: 0,
    beaconAssigned: new Map(),
    beaconCells: new Map(),
    digBlocked: new Map(),
    counters: { scoutFinds: 0, trailFinds: 0, trailFollows: 0, deliveries: 0 },
    patrolPoints: [],
    entranceTrail: 0,
    danger: [],
    nurseryLoad: new Map(),
    lastQueenId: 0,
  };
}

export function getExt(sim: SimState, colony: ColonyId): ColonyExt {
  let list = store.get(sim);
  if (!list) store.set(sim, (list = []));
  return (list[colony] ??= makeExt(sim));
}

// ---- chambers ------------------------------------------------------------------------------

/** Active chamber of a kind, falling back to the queen chamber (always present). */
export function chamberOf(colony: Colony, kind: ChamberKind): Chamber {
  return activeChamber(colony, kind) ?? colony.chambers[0];
}

/**
 * Chamber of a kind nearest to a point. Every chamber of a kind is in use: stores are shared, so
 * any granary is a pantry door; brood may lie in any nursery.
 */
export function nearestChamber(colony: Colony, kind: ChamberKind, p: Vec3): Chamber {
  let best: Chamber | null = null;
  let bestD = Infinity;
  for (const c of colony.chambers) {
    if (c.kind !== kind) continue;
    const d = (c.pos.x - p.x) ** 2 + (c.pos.y - p.y) ** 2 + (c.pos.z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ?? colony.chambers[0];
}

/** The chamber of `kind` that contains `p` (with slack), or null. */
export function chamberAt(colony: Colony, kind: ChamberKind, p: Vec3, slack = 0): Chamber | null {
  for (const c of colony.chambers) if (c.kind === kind && inChamber(c, p, slack)) return c;
  return null;
}

export function inChamber(ch: Chamber, p: Vec3, slack = 0): boolean {
  const dx = p.x - ch.pos.x;
  const dy = p.y - ch.pos.y;
  const dz = p.z - ch.pos.z;
  const r = ch.radius + slack;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** A walkable cell with solid right below it (things can be put down there). */
export function isFloorCell(sim: SimState, cell: CellIndex): boolean {
  if (cell < 0 || !sim.nav.isWalkable(cell)) return false;
  const w = sim.world;
  return cell - w.sx * w.sz >= 0 && w.density[cell - w.sx * w.sz] >= 128;
}

const _p = v3();
/** Nearest floor cell to a point (falls back to the nearest walkable cell). */
export function floorCellNear(sim: SimState, x: number, y: number, z: number, radius = 4): CellIndex {
  const w = sim.world;
  let best = -1;
  let bestD = Infinity;
  const r = Math.ceil(radius);
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const cz = Math.floor(z);
  for (let dy = -r; dy <= r; dy++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const X = cx + dx;
        const Y = cy + dy;
        const Z = cz + dz;
        if (!w.inBounds(X, Y, Z)) continue;
        const d = dx * dx + dy * dy * 1.5 + dz * dz;
        if (d >= bestD) continue;
        const c = w.index(X, Y, Z);
        if (isFloorCell(sim, c)) {
          best = c;
          bestD = d;
        }
      }
  return best >= 0 ? best : sim.nav.nearestWalkable(x, y, z, radius + 2);
}

export function addChamber(sim: SimState, colony: Colony, kind: ChamberKind, pos: Vec3, radius: number): Chamber {
  const cell = floorCellNear(sim, pos.x, pos.y, pos.z, 4);
  const p = v3clone(pos);
  if (cell >= 0) sim.world.cellCenter(cell, p);
  const ch: Chamber = { id: sim.nextId(), kind, cell, pos: p, radius, health: 1 };
  colony.chambers.push(ch);
  return ch;
}

const STAGE_INDEX = { egg: 0, larva: 1, pupa: 2 } as const;
/** Centre of the nursery pile for a brood stage (brood is sorted by stage, like real colonies). */
export function broodPilePos(sim: SimState, n: Chamber, stage: BroodStage, out: Vec3): Vec3 {
  const a = STAGE_INDEX[stage] * 2.0944 + 0.5;
  const r = Math.min(BALANCE.a2b.broodPileOffset, n.radius * 0.6);
  out.x = n.pos.x + Math.cos(a) * r;
  out.y = n.pos.y;
  out.z = n.pos.z + Math.sin(a) * r;
  // slab maps: keep piles on the slab's mid-plane
  if (sim.map.flags.slab) {
    if (sim.map.flags.slabAxis === 'z') {
      out.z = n.pos.z;
      out.x = n.pos.x + (STAGE_INDEX[stage] - 1) * r * 1.6;
    } else {
      out.x = n.pos.x;
      out.z = n.pos.z + (STAGE_INDEX[stage] - 1) * r * 1.6;
    }
  }
  return out;
}

// ---- alerts ----------------------------------------------------------------------------------

/** Emit an alert for the colony unless the same code fired within the cooldown. */
export function alertOnce(sim: SimState, colony: Colony, code: AlertCode, text: string, pos: Vec3 | null = null, id: EntityId = 0, cooldown: number = BALANCE.a2b.alertCooldown): boolean {
  const ext = getExt(sim, colony.id);
  const at = ext.alertAt[code];
  if (at !== undefined && sim.tick < at) return false;
  ext.alertAt[code] = sim.tick + Math.round(cooldown * 30);
  sim.emit({ type: 'alert', tick: sim.tick, code, colony: colony.id, pos: pos ? v3clone(pos) : null, id, text });
  return true;
}

// ---- explored-area memory -----------------------------------------------------------------------

export function exploreKey(x: number, y: number, z: number): number {
  const s = BALANCE.a2b.exploreCell;
  const cx = Math.max(0, Math.floor(x / s)) & 0x3ff;
  const cy = Math.max(0, Math.floor(y / s)) & 0x3ff;
  const cz = Math.max(0, Math.floor(z / s)) & 0x3ff;
  return cx + 1024 * (cz + 1024 * cy);
}

export function exploredAt(ext: ColonyExt, x: number, y: number, z: number): number {
  return ext.explored.get(exploreKey(x, y, z)) ?? 0;
}

export function markExplored(ext: ColonyExt, p: Vec3, amount: number): void {
  const k = exploreKey(p.x, p.y, p.z);
  ext.explored.set(k, Math.min(20, (ext.explored.get(k) ?? 0) + amount));
}

// ---- tasks ---------------------------------------------------------------------------------------

/** The ant's duty task: first non-player entry of the queue (see contracts/a2b.ts). */
export function dutyTask(ant: Ant): Task | undefined {
  const ts = ant.tasks;
  for (let i = 0; i < ts.length; i++) if (ts[i].source !== 'player') return ts[i];
  return undefined;
}

export function removeTask(ant: Ant, task: Task): void {
  const i = ant.tasks.indexOf(task);
  if (i >= 0) ant.tasks.splice(i, 1);
}

export function hasPlayerTask(ant: Ant): boolean {
  return ant.tasks.length > 0 && ant.tasks[0].source === 'player';
}

void _p;
