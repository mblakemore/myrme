import {
  EventBuffer,
  Hasher,
  SeededRng,
  TICK_DT,
  type Ant,
  type Brood,
  type CasteId,
  type Colony,
  type ColonyId,
  type Command,
  type CommandType,
  type Creature,
  type CreatureId,
  type DeathCause,
  type DirectorState,
  type Entity,
  type EntityId,
  type FoodKind,
  type FoodSource,
  type GoalState,
  type Item,
  type ItemKind,
  type MapGenResult,
  type MapId,
  type PossessInputState,
  type SimEvent,
  type SimOptions,
  type SimState,
  type SimStats,
  type SimSystem,
  type SimView,
  type SpeciesId,
  type Vec3,
  type WeatherState,
} from '../core';
import { createNav, type Nav } from '../world/nav';
import { createPheromones, type Pheromones } from '../world/pheromones';
import { createWater, type Water } from '../world/water';
import { createAnt, createBrood, createColonyState, createCreature, createFood, createItem, killAntImpl, killCreatureImpl, syncPrev } from './entities';
import { setupSimulation } from './setup';
import { SpatialHash } from './spatial';
import { SYSTEMS } from './systems';

/**
 * The deterministic simulation (§5.1, §5.2).
 *
 * One tick (`step()`), in order:
 *   1. tick counter advances; every mover's prev-pose is latched (D13)
 *   2. queued commands are applied in arrival order (each dispatched to its owning system)
 *   3. the spatial hash is rebuilt (queries during the tick see start-of-tick positions)
 *   4. systems run in registry order (see sim/systems/index.ts)
 *   5. tombstoned entities are swept
 *
 * Nothing in here reads wall-clock time or Math.random; the host measures tick cost and reports
 * it through `recordTickMs` purely for stats.
 */
export class Simulation implements SimState, SimView {
  readonly options: SimOptions;
  readonly map: MapGenResult;
  readonly mapId: MapId;
  readonly world;
  readonly nav: Nav;
  readonly pheromones: Pheromones;
  readonly water: Water;
  readonly rng: SeededRng;
  readonly spatial: SpatialHash;

  tick = 0;
  time = 0;
  speed: 0 | 1 | 2 | 4 = 1;
  paused = false;

  readonly ants: Ant[] = [];
  readonly creatures: Creature[] = [];
  readonly brood: Brood[] = [];
  readonly items: Item[] = [];
  readonly foodSources: FoodSource[] = [];
  readonly colonies: Colony[] = [];
  playerColony: ColonyId = 0;

  weather: WeatherState;
  director: DirectorState;
  goal: GoalState;

  possessedId: EntityId = 0;
  possessInput: PossessInputState = { move: { x: 0, y: 0 }, yawDelta: 0, sprint: false, actions: { bite: false, dig: false, pickup: false, trail: false, recruit: false } };

  readonly events = new EventBuffer();
  private readonly systems: readonly SimSystem[];
  private readonly commandOwner = new Map<CommandType, SimSystem>();
  private queue: Command[] = [];
  private idCounter = 1;
  private byId = new Map<EntityId, Entity>();
  private tickMs = 0;
  private needSweep = false;

  constructor(mapId: MapId, map: MapGenResult, options: SimOptions, systems: readonly SimSystem[] = SYSTEMS) {
    this.options = options;
    this.mapId = mapId;
    this.map = map;
    this.world = map.world;
    this.nav = createNav(this.world);
    this.pheromones = createPheromones();
    this.water = createWater(this.world);
    this.rng = new SeededRng(options.seed).fork('sim');
    this.spatial = new SpatialHash(this.world);
    this.systems = systems;
    const env = map.environment;
    this.weather = { kind: 'clear', intensity: 0, wind: { x: 0.4, y: 0, z: 0.2 }, wetness: 0, temperature: env.baseTemperature, timeOfDay: 0.42, day: 0, nextChange: 0, lamp: null };
    this.director = { enabled: false, intensity: 1, budget: 0, stage: 0, nextWaveTick: 0 };
    this.goal = { def: map.goal, progress: 0, status: 'active', reason: '' };

    for (const s of systems) for (const c of s.commands ?? []) this.commandOwner.set(c, s);

    // D4: edits clear pheromones in touched cells and invalidate nav.
    this.world.onEdit((res, center, radius) => {
      this.nav.notifyEdit(res.changedChunks);
      const r = Math.ceil(radius);
      const w = this.world;
      for (let y = Math.floor(center.y - r); y <= center.y + r; y++)
        for (let z = Math.floor(center.z - r); z <= center.z + r; z++)
          for (let x = Math.floor(center.x - r); x <= center.x + r; x++) if (w.inBounds(x, y, z)) this.pheromones.clearCell(w.index(x, y, z));
    });

    setupSimulation(this);
    for (const s of systems) s.init?.(this);
    this.nav.updateFields(0);
  }

  // ---- ids & lookup ------------------------------------------------------------------

  nextId(): number {
    return this.idCounter++;
  }

  getEntity(id: EntityId): Entity | undefined {
    const e = this.byId.get(id);
    return e && e.alive ? e : undefined;
  }

  getAnt(id: EntityId): Ant | undefined {
    const e = this.getEntity(id);
    return e && e.kind === 'ant' ? e : undefined;
  }

  getColony(id: ColonyId): Colony | undefined {
    return this.colonies[id - 1];
  }

  // ---- events & commands ---------------------------------------------------------------

  emit(e: SimEvent): void {
    // M3: alerts are player-facing (HUD toasts, audio stings). Systems raise them per colony —
    // AI colonies included — so the ones that concern another colony are dropped at the source.
    if (e.type === 'alert' && e.colony !== 0 && e.colony !== this.playerColony) return;
    this.events.push(e);
  }

  /** Drain buffered events (host calls once per render frame, D19). */
  drainEvents(): SimEvent[] {
    return this.events.drain();
  }

  /**
   * Queue a command for the next tick. `pause`/`setSpeed` are host-loop controls and apply
   * immediately (the sim does not tick while paused).
   */
  command(cmd: Command): void {
    if (cmd.type === 'pause') {
      this.paused = cmd.paused;
      return;
    }
    if (cmd.type === 'setSpeed') {
      this.speed = cmd.speed;
      this.paused = cmd.speed === 0;
      return;
    }
    this.queue.push(cmd);
  }

  private applyCommand(cmd: Command): void {
    switch (cmd.type) {
      case 'debugSpawn': {
        // a non-finite position would poison the spatial hash (crash in `rebuild`)
        if (!cmd.pos || !Number.isFinite(cmd.pos.x + cmd.pos.y + cmd.pos.z)) return;
        const n = Math.max(0, Math.min(5000, Math.floor(cmd.count ?? 1))) || 0;
        for (let i = 0; i < n; i++) {
          if (cmd.what === 'ant') this.spawnAnt(cmd.colony ?? this.playerColony, cmd.caste ?? 'worker', cmd.pos);
          else if (cmd.what === 'creature' && cmd.creature) this.spawnCreature(cmd.creature, cmd.pos, cmd.colony ?? 0);
          else if (cmd.what === 'item') this.spawnItem('food', 1, cmd.pos);
          else if (cmd.what === 'food') this.spawnFood('seeds', 50, cmd.pos);
        }
        return;
      }
      case 'debugKill': {
        const e = this.getEntity(cmd.id);
        if (e?.kind === 'ant') this.killAnt(e, 'debug');
        else if (e?.kind === 'creature') this.killCreature(e);
        else if (e) this.remove(e);
        return;
      }
      default:
        this.commandOwner.get(cmd.type)?.onCommand?.(this, cmd);
    }
  }

  // ---- stepping --------------------------------------------------------------------------

  step(): void {
    this.tick++;
    this.time = this.tick * TICK_DT;
    for (const a of this.ants) syncPrev(a);
    for (const c of this.creatures) syncPrev(c);

    if (this.queue.length) {
      const q = this.queue;
      this.queue = [];
      for (const cmd of q) this.applyCommand(cmd);
    }

    this.spatial.rebuild(this.ants, this.creatures);
    for (const s of this.systems) s.update(this, TICK_DT);
    if (this.needSweep) this.sweep();
  }

  private sweep(): void {
    const keep = <T extends { alive: boolean; id: number }>(list: T[]): void => {
      let w = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].alive) list[w++] = list[i];
        else this.byId.delete(list[i].id);
      }
      list.length = w;
    };
    keep(this.ants);
    keep(this.creatures);
    keep(this.brood);
    keep(this.items);
    keep(this.foodSources);
    this.needSweep = false;
  }

  // ---- lifecycle helpers -----------------------------------------------------------------

  private track<T extends Entity>(e: T): T {
    this.byId.set(e.id, e);
    return e;
  }

  spawnAnt(colony: ColonyId, caste: CasteId, pos: Vec3): Ant {
    return this.track(createAnt(this, colony, caste, pos));
  }
  spawnCreature(def: CreatureId, pos: Vec3, colony: ColonyId = 0): Creature {
    return this.track(createCreature(this, def, pos, colony));
  }
  spawnBrood(colony: ColonyId, caste: CasteId, pos: Vec3): Brood {
    return this.track(createBrood(this, colony, caste, pos));
  }
  spawnItem(kind: ItemKind, amount: number, pos: Vec3, colony: ColonyId = 0): Item {
    return this.track(createItem(this, kind, amount, pos, colony));
  }
  spawnFood(kind: FoodKind, amount: number, pos: Vec3, regen = 0): FoodSource {
    return this.track(createFood(this, kind, amount, pos, regen));
  }
  createColony(species: SpeciesId, controller: 'player' | 'ai', nestPos: Vec3): Colony {
    return createColonyState(this, species, controller, nestPos);
  }
  killAnt(ant: Ant, cause: DeathCause, leaveCorpse = true): void {
    killAntImpl(this, ant, cause, leaveCorpse);
    this.needSweep = true;
  }
  killCreature(c: Creature, killerColony: ColonyId = 0): void {
    killCreatureImpl(this, c, killerColony);
    this.needSweep = true;
  }
  remove(e: Entity): void {
    e.alive = false;
    this.needSweep = true;
  }

  // ---- stats & hashing ---------------------------------------------------------------------

  /** Host-reported wall-clock cost of the last tick (rolling average; stats only). */
  recordTickMs(ms: number): void {
    this.tickMs = this.tickMs === 0 ? ms : this.tickMs * 0.95 + ms * 0.05;
  }

  stats(): SimStats {
    return { tick: this.tick, ants: this.ants.length, creatures: this.creatures.length, brood: this.brood.length, items: this.items.length, msPerTick: this.tickMs, pendingPaths: this.nav.pendingCount };
  }

  stateHash(): string {
    const h = new Hasher();
    h.int(this.tick).int(this.rng.state()).int(this.world.version).int(this.idCounter);
    h.int(this.ants.length).int(this.creatures.length).int(this.brood.length).int(this.items.length);
    for (const a of this.ants) {
      h.int(a.id).vec(a.pos).vec(a.up).vec(a.forward).float(a.health).float(a.energy).int(a.tasks.length).int(a.cell);
    }
    for (const c of this.creatures) h.int(c.id).vec(c.pos).vec(c.up).float(c.health);
    for (const b of this.brood) h.int(b.id).vec(b.pos).int(b.age);
    for (const it of this.items) h.int(it.id).vec(it.pos).float(it.amount);
    for (const f of this.foodSources) h.int(f.id).float(f.amount);
    for (const c of this.colonies) h.float(c.stores.food).int(c.jobs.length).int(c.queenId);
    return h.digest();
  }
}
