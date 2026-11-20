import {
  JOB_KINDS,
  Mat,
  RIDE_PER_LENGTH,
  v3,
  v3clone,
  type Ant,
  type Brood,
  type CasteId,
  type Colony,
  type ColonyId,
  type Creature,
  type CreatureId,
  type DeathCause,
  type EntityId,
  type FoodKind,
  type FoodSource,
  type Item,
  type ItemKind,
  type JobKind,
  type MoveIntent,
  type Mover,
  type PathState,
  type SimState,
  type SpeciesId,
  type Task,
  type TaskKind,
  type TaskSource,
  type Vec3,
} from '../core';
import { getCreature } from './data/creatures';
import { getCaste, getSpecies } from './data/species';
import { snapToSurface } from './systems/movementCrawl';

/**
 * Entity creation helpers (§5.2). All entity objects are created here so their shape stays
 * monomorphic and complete. The Simulation exposes these through `SimState.spawn*`.
 */

/** Largest ride height the 2-voxel distance band supports reliably. */
const MAX_RIDE = 1.2;

export const newIntent = (): MoveIntent => ({ mode: 'none', dir: v3(), goal: -1, speedMul: 1 });
export const newPathState = (): PathState => ({ status: 'none', ticket: 0, goal: -1, cells: null, index: 0, stuck: 0, retryAt: 0 });

function moverBase(id: EntityId, pos: Vec3, length: number, clearance: number, speed: number, heading: number) {
  return {
    id,
    alive: true,
    pos: v3clone(pos),
    prevPos: v3clone(pos),
    up: v3(0, 1, 0),
    prevUp: v3(0, 1, 0),
    forward: v3(Math.cos(heading), 0, Math.sin(heading)),
    prevForward: v3(Math.cos(heading), 0, Math.sin(heading)),
    cell: -1,
    clearance,
    rideHeight: Math.min(MAX_RIDE, length * RIDE_PER_LENGTH),
    speed,
    moveSpeed: 0,
    falling: false,
    intent: newIntent(),
    path: newPathState(),
  };
}

function settle(sim: SimState, m: Mover): void {
  if (m.locomotion === 'fly') {
    m.cell = sim.world.cellAt(m.pos.x, m.pos.y, m.pos.z);
  } else if (!snapToSurface(sim.world, sim.nav, m, 12)) {
    // Nothing walkable nearby: let D12 falling find the ground.
    m.falling = true;
  }
  syncPrev(m);
}

export function syncPrev(m: Mover): void {
  m.prevPos.x = m.pos.x;
  m.prevPos.y = m.pos.y;
  m.prevPos.z = m.pos.z;
  m.prevUp.x = m.up.x;
  m.prevUp.y = m.up.y;
  m.prevUp.z = m.up.z;
  m.prevForward.x = m.forward.x;
  m.prevForward.y = m.forward.y;
  m.prevForward.z = m.forward.z;
}

export function createAnt(sim: SimState, colonyId: ColonyId, casteId: CasteId, pos: Vec3): Ant {
  const colony = sim.getColony(colonyId);
  const species: SpeciesId = colony?.species ?? sim.options.faction;
  const c = getCaste(species, casteId);
  const id = sim.nextId();
  const phase = sim.rng.next();
  const ant: Ant = {
    ...moverBase(id, pos, c.length, c.clearance, c.speed, phase * Math.PI * 2),
    kind: 'ant',
    locomotion: 'surface',
    species,
    caste: c.id,
    colony: colonyId,
    health: c.maxHealth,
    maxHealth: c.maxHealth,
    energy: 1,
    hydration: 1,
    age: 0,
    lifespan: Number.isFinite(c.lifespan) ? Math.round(c.lifespan * 30 * (0.85 + 0.3 * sim.rng.next())) : Infinity,
    tasks: [],
    carrying: null,
    possessed: false,
    infection: { stage: 'none', timer: 0, load: 0 },
    behavior: '',
    thinkAt: sim.tick + 1 + Math.floor(phase * 10),
    targetId: 0,
    attackReadyAt: 0,
    submerged: 0,
    followId: 0,
    group: 0,
    anim: 'idle',
    phase,
    mem: {},
  };
  settle(sim, ant);
  sim.ants.push(ant);
  sim.emit({ type: 'antSpawned', tick: sim.tick, id, colony: colonyId, caste: c.id, pos: v3clone(ant.pos) });
  return ant;
}

export function createCreature(sim: SimState, defId: CreatureId, pos: Vec3, colony: ColonyId = 0): Creature {
  const d = getCreature(defId);
  const id = sim.nextId();
  const phase = sim.rng.next();
  const cr: Creature = {
    ...moverBase(id, pos, d.length, d.clearance, d.speed, phase * Math.PI * 2),
    kind: 'creature',
    locomotion: d.locomotion,
    def: defId,
    colony,
    health: d.maxHealth,
    maxHealth: d.maxHealth,
    state: 'idle',
    targetId: 0,
    attackReadyAt: 0,
    home: v3clone(pos),
    thinkAt: sim.tick + 1 + Math.floor(phase * 10),
    stunned: 0,
    phase,
    mem: {},
  };
  settle(sim, cr);
  sim.creatures.push(cr);
  sim.emit({ type: 'creatureSpawned', tick: sim.tick, id, def: defId, pos: v3clone(cr.pos) });
  return cr;
}

export function createBrood(sim: SimState, colonyId: ColonyId, caste: CasteId, pos: Vec3): Brood {
  const colony = sim.getColony(colonyId);
  const b: Brood = {
    id: sim.nextId(),
    kind: 'brood',
    alive: true,
    pos: v3clone(pos),
    cell: sim.nav.nearestWalkable(pos.x, pos.y, pos.z, 4),
    colony: colonyId,
    species: colony?.species ?? sim.options.faction,
    stage: 'egg',
    caste,
    age: 0,
    fed: 0,
    hunger: 0,
    carriedBy: 0,
    up: v3(0, 1, 0),
  };
  sim.brood.push(b);
  sim.emit({ type: 'broodStage', tick: sim.tick, id: b.id, colony: colonyId, stage: 'egg', pos: v3clone(b.pos) });
  return b;
}

export function createItem(sim: SimState, itemKind: ItemKind, amount: number, pos: Vec3, colony: ColonyId = 0): Item {
  const it: Item = {
    id: sim.nextId(),
    kind: 'item',
    alive: true,
    pos: v3clone(pos),
    cell: sim.nav.nearestWalkable(pos.x, pos.y, pos.z, 3),
    itemKind,
    amount,
    colony,
    infected: false,
    carriedBy: 0,
    claimedBy: 0,
    bornTick: sim.tick,
    up: v3(0, 1, 0),
    falling: false,
  };
  sim.items.push(it);
  return it;
}

export function createFood(sim: SimState, foodKind: FoodKind, amount: number, pos: Vec3, regen = 0): FoodSource {
  const cell = sim.nav.nearestWalkable(pos.x, pos.y, pos.z, 8);
  const p = v3clone(pos);
  if (cell >= 0) sim.world.cellCenter(cell, p);
  const f: FoodSource = {
    id: sim.nextId(),
    kind: 'food',
    alive: true,
    pos: p,
    cell,
    foodKind,
    amount,
    maxAmount: amount,
    regen,
    radius: Math.max(0.6, Math.cbrt(amount) * 0.35),
    up: v3(0, 1, 0),
  };
  sim.foodSources.push(f);
  return f;
}

const COLONY_COLORS: readonly (readonly [number, number, number])[] = [
  [0.25, 0.75, 1.0],
  [1.0, 0.35, 0.25],
  [1.0, 0.8, 0.2],
  [0.7, 0.4, 1.0],
];

export function createColonyState(sim: SimState, species: SpeciesId, controller: 'player' | 'ai', nestPos: Vec3): Colony {
  const id = sim.colonies.length + 1;
  const def = getSpecies(species);
  const nestCell = sim.nav.nearestWalkable(nestPos.x, nestPos.y, nestPos.z, 12);
  const pos = v3clone(nestPos);
  if (nestCell >= 0) sim.world.cellCenter(nestCell, pos);
  const priorities = {} as Record<JobKind, number>;
  for (const k of JOB_KINDS) priorities[k] = 1;
  const colony: Colony = {
    id,
    species,
    controller,
    alive: true,
    queenId: 0,
    kingId: 0,
    nestCell,
    nestPos: pos,
    entrances: [],
    stores: { food: def.startingFood, leaves: 0, wood: 0, mud: 0 },
    priorities,
    casteRatio: { ...def.defaultCasteRatio },
    chambers: [{ id: sim.nextId(), kind: 'queen', cell: nestCell, pos: v3clone(pos), radius: 5, health: 1 }],
    jobs: [],
    beacons: [],
    designations: [],
    population: { total: 0, byCaste: {}, eggs: 0, larvae: 0, pupae: 0 },
    color: COLONY_COLORS[(id - 1) % COLONY_COLORS.length],
    stats: { foodDelivered: 0, dugVoxels: 0, kills: 0, deaths: 0, born: 0 },
    nextLayTick: 0,
  };
  sim.colonies.push(colony);
  if (controller === 'player') sim.playerColony = id;
  if (nestCell >= 0) sim.nav.setHome(id, [nestCell]);
  return colony;
}

export function killAntImpl(sim: SimState, ant: Ant, cause: DeathCause, leaveCorpse = true): void {
  if (!ant.alive) return;
  ant.alive = false;
  const colony = sim.getColony(ant.colony);
  if (colony) colony.stats.deaths++;
  sim.emit({ type: 'antDied', tick: sim.tick, id: ant.id, colony: ant.colony, caste: ant.caste, cause, pos: v3clone(ant.pos) });
  if (leaveCorpse) {
    const corpse = sim.spawnItem('corpse', 1, ant.pos, ant.colony);
    corpse.up = v3clone(ant.up);
    corpse.infected = ant.infection.stage !== 'none';
  }
}

export function killCreatureImpl(sim: SimState, c: Creature, killerColony: ColonyId = 0): void {
  if (!c.alive) return;
  c.alive = false;
  c.state = 'dead';
  sim.emit({ type: 'creatureDied', tick: sim.tick, id: c.id, def: c.def, pos: v3clone(c.pos), killerColony });
  const d = getCreature(c.def);
  if (d.foodValue > 0) sim.spawnItem('corpse', d.foodValue, c.pos, 0);
}

/** Convenience constructor for task-queue entries. */
export function makeTask(sim: SimState, kind: TaskKind, source: TaskSource, over: Partial<Task> = {}): Task {
  return { id: sim.nextId(), kind, source, cell: -1, pos: null, targetId: 0, jobId: 0, phase: 0, data: 0, issuedTick: sim.tick, ...over };
}

export const NO_CARRY_MATERIAL = Mat.Air;
