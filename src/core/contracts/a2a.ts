/**
 * Contract extensions owned by stream A2A (PLAN §10.2, D22) — locomotion, navigation,
 * pheromones, digging/building execution, falling.
 * Additive only — never redefines or widens a type from `core/contracts.ts`.
 *
 * HOW TO REACH THE IMPLEMENTATIONS (all additive; every `core/contracts.ts` API still works):
 *
 *   import { navOf } from '../systems/paths';        // NavEx view of sim.nav
 *   import { pheroOf } from '../systems/pheromone';  // PheromoneStoreEx view of sim.pheromones
 *   import { claimWorkSite, applyDigWork, applyBuildWork, runDigDuty, dropSpoil, … }
 *     from '../systems/dig';                         // dig/build execution (see that file's header)
 *   import { setSpeedScale, registerSpeedModifier } from '../systems/movement';
 *
 * `sim.nav` IS a `NavEx` and `sim.pheromones` IS a `PheromoneStoreEx` at runtime; the helpers
 * above are just typed casts.
 */
import type {
  CellIndex,
  ColonyId,
  EntityId,
  MaterialId,
  Mover,
  NavApi,
  PheroChannel,
  PheromoneStore,
  SimState,
  Tick,
  Vec3,
  VoxelWorld,
} from '../contracts';

// =====================================================================================
// Navigation
// =====================================================================================

/**
 * A multi-source BFS distance field over walkable cells (Uint16 steps, `HOME_UNREACHABLE` for
 * cells that cannot reach any source). Fields are rebuilt by the `paths` system after world
 * edits (throttled, incrementally, swapped in atomically) — readers always see a complete,
 * possibly slightly stale field. Home fields are distance fields; create others with
 * `NavEx.field(key)` for any "walk towards the nearest X" need (exits, food depots, midden…).
 */
export interface DistanceField {
  readonly key: string;
  /** True once the field has been built at least once. */
  readonly ready: boolean;
  /** True while a rebuild is pending (the world changed since the last build). */
  readonly stale: boolean;
  /** Bumped each time a rebuild is swapped in. */
  readonly version: number;
  /** Replace the BFS sources and schedule a rebuild (the first build happens on the next `paths` update). */
  setSources(cells: readonly CellIndex[]): void;
  /** Steps to the nearest source, or `HOME_UNREACHABLE`. */
  distance(cell: CellIndex): number;
  /** Walkable neighbour of `cell` one step closer to the sources, or -1 (at a source / unreachable). */
  descend(cell: CellIndex): CellIndex;
}

export interface NavStats {
  /** Path requests queued or in progress. */
  pending: number;
  /** A* node expansions since creation. */
  expansions: number;
  searches: number;
  fields: number;
  fieldBuilds: number;
  fieldNodes: number;
  /** Bytes held by distance fields (incl. the shared back buffer). */
  fieldBytes: number;
  editSeq: number;
}

/** Everything `world/nav.ts` offers beyond `NavApi`. `sim.nav` implements this. */
export interface NavEx extends NavApi {
  /** Get or create a named distance field. Keys starting with `home:` and `sky` are reserved. */
  field(key: string): DistanceField;
  removeField(key: string): void;
  /** A colony's home field (sources = nest cells given to `setHome`), or null. */
  homeField(colony: ColonyId): DistanceField | null;
  /**
   * "Distance to open sky" field: sources are all walkable cells with nothing solid above
   * (ground surface outdoors, top of the gel/sand on farms). `descend` leads out of the nest —
   * use for flood escape, spoil hauling, nuptial flights. Created lazily on first call.
   */
  skyField(): DistanceField;
  /** True if nothing solid lies above the cell (rain / sun / wind reach it). O(1) amortised. */
  isExposed(cell: CellIndex): boolean;
  /** y of the lowest cell of column (x, z) that has only air above it. */
  skyHeight(x: number, z: number): number;
  /**
   * Cheap reachability for ant-sized movers: answered from distance fields when possible, else a
   * bounded A* (`maxExpansions`, default 4000; hitting the cap counts as unreachable).
   */
  reachable(from: CellIndex, to: CellIndex, clearance?: number, maxExpansions?: number): boolean;
  /** Straight-line crawlability between two walkable cells on one near-planar face. */
  lineWalkable(a: CellIndex, b: CellIndex): boolean;
  /** String-pull a cell path (returns a subsequence that keeps the last cell). */
  smoothPath(from: CellIndex, cells: Int32Array): Int32Array;
  /** Did world edits since `sinceSeq` break `cells[index..]`? (`at` = current cell of the mover.) */
  pathBroken(cells: Int32Array, index: number, at: CellIndex, sinceSeq: number): boolean;
  /** `requestPath` with `smooth = false` returns the raw 26-connected cell path (no string-pulling). */
  requestPath(from: CellIndex, to: CellIndex, clearance?: number, smooth?: boolean): number;
  /** Bumped by every world edit. */
  readonly editSeq: number;
  /**
   * M3: soft hazard cost of a cell for path planning (0..255 extra cell steps; 0 clears). A* goes
   * around hazards when a shorter detour exists and still crosses them when it must. Used for
   * deep water and antlion slopes; walkability and distance fields are unaffected.
   */
  setHazard(cell: CellIndex, cost: number): void;
  hazardAt(cell: CellIndex): number;
  /** `updateFields` with an optional BFS node budget per call (default: unlimited). */
  updateFields(tick: Tick, nodeBudget?: number): void;
  stats(): NavStats;
}

// =====================================================================================
// Pheromones
// =====================================================================================

/** Result of the three-antenna trail sensor. */
export interface TrailSense {
  left: number;
  centre: number;
  right: number;
  total: number;
  /** Steering bias −1 (hard left) … +1 (hard right); 0 when nothing is smelled. */
  turn: number;
  /** Unit steering direction on the tangent plane (== forward when nothing is smelled). */
  dir: Vec3;
}

export interface PheroConfig {
  /** Per-channel keep factor per evaporation step (index = PheroChannel). */
  keep?: readonly number[];
  /** Per-channel saturation cap. */
  max?: readonly number[];
  /** Entries below this are freed. */
  floor?: number;
  /** Max live cells per (colony, channel) pool. */
  maxEntries?: number;
  /** Strength factor when smelling another colony. */
  foreignFactor?: number;
}

export interface PheroStats {
  /** Live cells over all pools. */
  entries: number;
  pools: number;
  /** Bytes of typed-array storage currently allocated. */
  bytes: number;
  /** Deposits refused because a pool was full. */
  dropped: number;
  peakEntries: number;
  maxEntriesPerPool: number;
}

/** Everything `world/pheromones.ts` offers beyond `PheromoneStore`. `sim.pheromones` implements this. */
export interface PheromoneStoreEx extends PheromoneStore {
  configure(cfg: PheroConfig): void;
  /** Saturation cap of a channel (normalise visualisations with this). */
  maxOf(channel: PheroChannel): number;
  /** Strongest value any OTHER colony has at the cell, times the foreign factor (enemy alarm/trail). */
  sampleForeign(colony: ColonyId, channel: PheroChannel, cell: CellIndex): number;
  /**
   * Three forward sensors (left / centre / right antenna) on the mover's tangent plane.
   * Steer with `out.dir` (use it as a `dir` intent) or `out.turn`. `dist` = antenna reach in
   * voxels (default 1.6), `angle` = half-spread in radians (default 0.65), `foreign` = also
   * smell other colonies (attenuated).
   */
  senseTrail(world: VoxelWorld, colony: ColonyId, channel: PheroChannel, pos: Vec3, forward: Vec3, up: Vec3, out: TrailSense, dist?: number, angle?: number, foreign?: boolean): TrailSense;
  /** Global evaporation multiplier applied to every entry (> 1 = faster decay). Default 1. */
  setDecayScale(scale: number): void;
  /**
   * Extra evaporation multiplier for entries on sky-exposed cells only (wind, rain). The
   * `pheromone` system derives it from `sim.weather` each step; see `setPheromoneWeatherOverride`.
   */
  setWeatherScale(scale: number): void;
  /** Per-channel evaporation multiplier. Default 1. */
  setChannelScale(channel: PheroChannel, scale: number): void;
  /** Predicate deciding whether a newly created entry is sky-exposed (set by the `pheromone` system). */
  setExposure(fn: ((cell: CellIndex) => boolean) | null): void;
  stats(): PheroStats;
}

// =====================================================================================
// Locomotion
// =====================================================================================

/**
 * Per-entity speed multiplier hook: set `mover.mem[MOVE_SPEED_KEY]` (ants and creatures both
 * have `mem`) to scale that mover's speed (glue, cold, wounds…). Absent = 1. The movement system
 * multiplies it with `intent.speedMul`, the terrain-material factor, the carry-load factor and
 * the global scales set through `setSpeedScale` (sim/systems/movement.ts).
 */
export const MOVE_SPEED_KEY = 'mv.speed';

/** A registered per-mover speed modifier (see `registerSpeedModifier` in sim/systems/movement.ts). */
export type SpeedModifier = (m: Mover, sim: SimState) => number;

// =====================================================================================
// Digging & building
// =====================================================================================

/**
 * One unit of dig/build work: a single D4 brush stamp of a designation.
 * Sites are produced by the dig system from `Colony.designations`; see sim/systems/dig.ts.
 */
export interface WorkSite {
  /** Stable handle (store it in `ant.mem`); resolve with `getWorkSite(sim, id)`. */
  id: number;
  designationId: number;
  kind: 'dig' | 'build';
  colony: ColonyId;
  /** Brush centre that will be carved / filled. */
  target: Vec3;
  radius: number;
  /** Walkable cell to stand on while working (path goal). */
  cell: CellIndex;
  /** Build material (Mat.Air for dig). */
  material: MaterialId;
  /** Work units needed in total and done so far. */
  cost: number;
  progress: number;
  /** Ant holding the reservation (0 = free). */
  reservedBy: EntityId;
}

/**
 * Result of `applyDigWork` / `applyBuildWork`:
 *  - `working`     progress was added, keep calling every tick
 *  - `done`        the stamp was executed this tick (dig: the ant now carries a spoil pellet)
 *  - `outOfReach`  the ant is too far from the site — walk to `site.cell` first
 *  - `carrying`    dig only: the ant's mandibles are full — drop what it carries first
 *  - `noMaterial`  build only: neither the ant nor the colony store has the material
 *  - `blocked`     build only: the spot is occupied by entities right now — retry shortly
 *  - `invalid`     the site no longer exists / is already finished — pick another
 */
export type WorkResult = 'working' | 'done' | 'outOfReach' | 'carrying' | 'noMaterial' | 'blocked' | 'invalid';

/** Phases of the reference dig/build duty state machine (`runDigDuty`), stored in `ant.mem`. */
export type DigDutyState = 'idle' | 'toSite' | 'working' | 'toSpoil' | 'done';

export interface DigStats {
  /** Pending work sites over all designations. */
  pendingSites: number;
  reservedSites: number;
  designations: number;
  /** Voxels removed / added by the dig system since the sim started. */
  dugVoxels: number;
  filledVoxels: number;
  /** Spoil pellets dropped, and voxels of mound they produced. */
  pelletsDropped: number;
  moundVoxels: number;
}
