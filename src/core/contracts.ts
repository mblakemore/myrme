/**
 * Myrme — shared contracts. THE single source of types shared between streams.
 *
 * Rules (PLAN §5.1, D22):
 *  - This file is frozen during waves. Streams add to `core/contracts/<stream>.ts` only.
 *  - No three.js, no DOM. Everything here is plain data + interfaces and runs in Node.
 *  - Kinds are string unions (stable, greppable); array-indexed things (materials, pheromone
 *    channels) are small integers.
 *
 * Where the plan was silent a decision was taken and marked with "DECISION:".
 */

// =====================================================================================
// 1. Math & ids (D1, D2, D13)
// =====================================================================================

/** Plain-object vector. y is up. 1 world unit = 1 voxel (D1). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Vec2 {
  x: number;
  y: number;
}

/** Linear voxel cell index `x + sx*(z + sz*y)` (D2). -1 = none. */
export type CellIndex = number;
/** Entity ids are unique per simulation and never reused (§5.2). 0 = none. */
export type EntityId = number;
/** Colony ids are small integers starting at 1. 0 = none/neutral. */
export type ColonyId = number;
/** Simulation tick (30 Hz). */
export type Tick = number;

/**
 * D13 render pose. `prev*` hold the value at the start of the current tick; the renderer
 * interpolates prev→current with the frame alpha.
 * DECISION: `prevForward` added to D13 so heading interpolates as smoothly as `up`.
 */
export interface Pose {
  id: EntityId;
  pos: Vec3;
  prevPos: Vec3;
  /** Unit surface normal the entity stands on (points out of the solid). */
  up: Vec3;
  prevUp: Vec3;
  /** Unit heading, always perpendicular to `up`. */
  forward: Vec3;
  prevForward: Vec3;
  /** Nav cell the entity currently occupies (nearest walkable cell), or -1 while falling. */
  cell: CellIndex;
}

// =====================================================================================
// 2. Materials (D5)
// =====================================================================================

export const Mat = {
  Air: 0,
  Soil: 1,
  Sand: 2,
  Clay: 3,
  Rock: 4,
  Gel: 5,
  Wood: 6,
  LeafLitter: 7,
  Plant: 8,
  Mud: 9,
  Fungus: 10,
} as const;
export type MaterialId = (typeof Mat)[keyof typeof Mat];
export const MATERIAL_COUNT = 11;
/**
 * Number of per-vertex material weight channels emitted by the mesher (D8). Channel index ==
 * MaterialId; channel 0 (Air) and 11 are unused padding so the data packs into 3 × vec4.
 */
export const MAT_CHANNELS = 12;

export interface MaterialDef {
  id: MaterialId;
  name: string;
  /** Work units to remove one voxel. Infinity = cannot be dug. */
  digCost: number;
  /** Ants can eat it in place (gel). */
  edibleByAnts: boolean;
  /** Termites (`eatsWood`) can eat it in place (wood, leaf litter). */
  edibleByTermites: boolean;
  /** Food units yielded per voxel eaten/harvested. */
  nutrition: number;
  /** Base albedo as sRGB 0..1 (placeholder terrain material, minimap, UI swatches). */
  color: readonly [number, number, number];
}

// =====================================================================================
// 3. Voxel world (D1–D4, D6), mesher (D8, D9), raycast (D10)
// =====================================================================================

/**
 * D6. `glass`: every out-of-bounds face is a pane — solid for physics/walkability, air for
 * meshing. `open`: sides and floor are closed (movers are clamped inside, no walkable surface on
 * the invisible side walls), the sky is open.
 * DECISION: on `open` maps the mesher also treats out-of-bounds as air on sides and floor, so an
 * outdoor map renders as a watertight "diorama block". Physics never sees those side faces.
 */
export type BoundaryMode = 'glass' | 'open';

/** Chunk edge length in cells (D8). */
export const CHUNK_SIZE = 16;
/** Density value at the isosurface (D3). */
export const ISO = 128;
/** Density units per voxel of signed distance (D3). */
export const DENSITY_PER_VOXEL = 64;

export interface EditResult {
  /** Chunk indices whose mesh/nav data must be rebuilt (includes border neighbours). */
  changedChunks: number[];
  /** Solid→air cell count per material (dig) — index by MaterialId. All zero for `fill`. */
  removedByMaterial: number[];
  /** Air→solid cell count (fill). */
  addedCells: number;
  /** Cells whose density changed at all. */
  touchedCells: number;
}

export interface EditOptions {
  /** Materials the brush may remove (dig). Default: every material with finite digCost. */
  canDig?: (m: MaterialId) => boolean;
  /**
   * `fill` refuses cells for which this returns true (D4 "fill refuses occupied cells" —
   * the sim passes a predicate that is true for cells containing entities).
   */
  isOccupied?: (cell: CellIndex) => boolean;
}

export interface RayHit {
  /** World-space hit point on the isosurface. */
  pos: Vec3;
  /** Unit surface normal at the hit (points out of the solid). */
  normal: Vec3;
  /** Distance from the ray origin. */
  dist: number;
  /** The solid cell that was hit, or -1 if the hit is a glass pane / closed boundary. */
  solidCell: CellIndex;
  /** The last non-solid in-bounds cell before the hit, or -1. */
  airCell: CellIndex;
  material: MaterialId;
  /** True if the ray stopped on the world boundary rather than on voxels. */
  boundary: boolean;
}

export interface RaycastOptions {
  /**
   * false (default): physics semantics — panes and the closed floor are solid; use for camera
   * collision and line of sight from inside the world.
   * true: visual semantics — matches the rendered mesh (out of bounds is air, so rays may start
   * outside the world and pass through panes). On glass maps a visual ray that crosses the whole
   * world without hitting voxels returns a `boundary` hit on the pane where it exits, so clicks
   * into an open tunnel still resolve to a position. Use for picking and paint tools.
   */
  visual?: boolean;
  /** With `visual`: ignore everything hidden by the cutaway plane. */
  cut?: CutPlane | null;
}

/**
 * The voxel world. Density is a clamped signed distance stored as Uint8 (D3):
 * `sdf = (density - 128) / 64` voxels, positive inside solid, clamped to about [-2, +1.98].
 *
 * Glass boundaries are baked into the stored field: on `glass` maps a cell's stored sdf is never
 * lower than `-(distance from the cell centre to the nearest pane)`, so panes behave as ordinary
 * solid surfaces for sampling, walkability and locomotion while the mesher (which treats
 * out-of-bounds as air) still cuts the slab flat against the pane.
 */
export interface VoxelWorld {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** Chunk grid dimensions (ceil(size / CHUNK_SIZE)). Chunk index = cx + ncx*(cz + ncz*cy). */
  readonly ncx: number;
  readonly ncy: number;
  readonly ncz: number;
  readonly boundary: BoundaryMode;
  /** Raw arrays, index per D2. Read freely; write only through the methods below. */
  readonly density: Uint8Array;
  readonly material: Uint8Array;
  /** Bumped by every edit that changed at least one cell. */
  version: number;
  /** Per-chunk version, bumped when a chunk (or its border neighbourhood) changes. */
  readonly chunkVersion: Uint32Array;

  index(x: number, y: number, z: number): CellIndex;
  inBounds(x: number, y: number, z: number): boolean;
  /** Decompose a cell index into integer coordinates (written to `out`). */
  cellCoords(cell: CellIndex, out: Vec3): Vec3;
  /** World-space centre of a cell (written to `out`). */
  cellCenter(cell: CellIndex, out: Vec3): Vec3;
  /** Cell containing a world position, or -1 if out of bounds. */
  cellAt(x: number, y: number, z: number): CellIndex;
  chunkIndexOfCell(x: number, y: number, z: number): number;

  /**
   * Density at integer cell coords with *physics* boundary semantics (D6): out-of-bounds is
   * solid on glass faces and on the floor of open maps, air above open maps, and clamps to the
   * nearest in-bounds cell on open sides.
   */
  densityAt(x: number, y: number, z: number): number;
  materialAt(x: number, y: number, z: number): MaterialId;
  /** `densityAt >= ISO`. */
  isSolid(x: number, y: number, z: number): boolean;

  /** Trilinear signed distance (voxels, + = inside solid) at a world position. */
  sample(x: number, y: number, z: number): number;
  /**
   * Smoothed gradient of `sample` (central differences, h = 0.5). Points INTO the solid; not
   * normalised (≈ unit length near well-formed surfaces, ~0 far from any surface).
   */
  gradient(x: number, y: number, z: number, out: Vec3): Vec3;

  /** Generator-time write of one cell (applies the glass bake, does NOT mark chunks dirty). */
  setCell(x: number, y: number, z: number, sdf: number, material: MaterialId): void;
  /** Call once after bulk `setCell` writes: bumps `version` and every chunk version. */
  markAllDirty(): void;

  /** D4 spherical carve. `radius` is clamped to ≥ 1.5. */
  dig(center: Vec3, radius: number, opts?: EditOptions): EditResult;
  /** D4 spherical add of `material`. Existing solid cells keep their material. */
  fill(center: Vec3, radius: number, material: MaterialId, opts?: EditOptions): EditResult;

  /**
   * Density / trilinear sdf with *visual* semantics: everything out of bounds is air. This is
   * what the mesher renders (D6), and what picking rays should hit.
   */
  densityVisual(x: number, y: number, z: number): number;
  sampleVisual(x: number, y: number, z: number): number;

  /** D10 raycast against the isosurface (see `RaycastOptions`). `dir` need not be normalised. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, opts?: RaycastOptions): RayHit | null;

  /** Subscribe to edits (pheromone clearing, nav invalidation…). Returns an unsubscribe fn. */
  onEdit(fn: (result: EditResult, center: Vec3, radius: number) => void): () => void;
}

/** D9 axis-aligned cutaway. Everything with `sign * (coord - pos) > 0` is hidden. */
export interface CutPlane {
  enabled: boolean;
  axis: 'x' | 'y' | 'z';
  pos: number;
  sign: 1 | -1;
}

/** D8 mesher output for one chunk. Arrays are exactly sized (safe to hand to a GPU buffer). */
export interface MeshData {
  /** xyz world-space positions. */
  positions: Float32Array;
  /** xyz unit normals from the global density gradient (pointing out of the solid). */
  normals: Float32Array;
  indices: Uint32Array;
  /** MAT_CHANNELS bytes per vertex, 0..255, summing to ~255; channel == MaterialId. */
  matWeights: Uint8Array;
  vertexCount: number;
  triangleCount: number;
}

export interface MeshOptions {
  /** D9: cells past the plane are meshed as air. */
  cut?: CutPlane | null;
}

/** Signature of `world/mesher.ts#meshChunk` (pure function). */
export type MeshChunkFn = (world: VoxelWorld, chunkIndex: number, opts?: MeshOptions) => MeshData;

// =====================================================================================
// 4. Navigation (D15) & locomotion (D11, D12)
// =====================================================================================

export type LocomotionClass = 'surface' | 'fly' | 'static';

export type PathStatus = 'pending' | 'found' | 'partial' | 'failed';

export interface PathResult {
  status: PathStatus;
  /** Cell waypoints from start (exclusive) to goal (inclusive). Empty when failed. */
  cells: Int32Array;
}

/** Sentinel in home-distance fields for unreachable cells. */
export const HOME_UNREACHABLE = 0xffff;

/**
 * Navigation over walkable cells. A cell is walkable when it is air and its centre lies within
 * about one voxel of a surface (density in [WALK_MIN_DENSITY, ISO)); see `world/nav.ts`.
 * `clearance` is the mover's body radius in voxels: values ≤ 1 fit everywhere an ant fits.
 */
export interface NavApi {
  isWalkable(cell: CellIndex, clearance?: number): boolean;
  /** Nearest walkable cell to a world position (BFS over cells), or -1 within `maxRadius`. */
  nearestWalkable(x: number, y: number, z: number, maxRadius?: number, clearance?: number): CellIndex;
  /** Synchronous A* (26-neighbourhood). Prefer `requestPath` from sim code. */
  findPath(from: CellIndex, to: CellIndex, clearance?: number, maxExpansions?: number): PathResult;
  /** Queue a path; returns a ticket (> 0). Processed by the `paths` system under a budget. */
  requestPath(from: CellIndex, to: CellIndex, clearance?: number): number;
  /** Result for a ticket once processed (consumes it), or null while pending. */
  takePath(ticket: number): PathResult | null;
  cancelPath(ticket: number): void;
  /** Spend up to `maxExpansions` A* node expansions on queued requests (FIFO). */
  process(maxExpansions: number): void;
  readonly pendingCount: number;

  /** (Re)define the BFS sources (nest cells) of a colony's home field and mark it dirty. */
  setHome(colony: ColonyId, sourceCells: CellIndex[]): void;
  /** Steps to the nearest home cell, or HOME_UNREACHABLE. */
  homeDistance(colony: ColonyId, cell: CellIndex): number;
  /** Neighbour of `cell` that is one step closer to home, or -1. */
  homeStep(colony: ColonyId, cell: CellIndex): CellIndex;
  /** Rebuild dirty home fields if their throttle allows (called by the `paths` system). */
  updateFields(tick: Tick): void;
  /** Tell nav the world changed (invalidates caches, schedules field rebuilds). */
  notifyEdit(changedChunks: readonly number[]): void;
}

/** What a behavior asks the movement system to do this tick. */
export interface MoveIntent {
  /**
   * `none`: stand still. `dir`: crawl along `dir` (world space, projected onto the surface).
   * `goto`: path to `goal` via the path queue and follow it.
   */
  mode: 'none' | 'dir' | 'goto';
  dir: Vec3;
  goal: CellIndex;
  /** Multiplier on the mover's base speed (sprint, carry penalty, cold…). */
  speedMul: number;
}

/** Path-following state, owned by the paths/movement systems; behaviors only read `status`. */
export interface PathState {
  status: 'none' | 'pending' | 'following' | 'arrived' | 'failed';
  ticket: number;
  /** Goal the current path/ticket was computed for. */
  goal: CellIndex;
  cells: Int32Array | null;
  index: number;
  /** Ticks without progress towards the current waypoint (stuck detection). */
  stuck: number;
  /** Tick before which no new request is issued after a failure. */
  retryAt: Tick;
}

export type EntityKind = 'ant' | 'creature' | 'brood' | 'item' | 'food';

export interface EntityBase {
  id: EntityId;
  kind: EntityKind;
  /** False once tombstoned; swept at end of tick (§5.2). */
  alive: boolean;
  pos: Vec3;
  cell: CellIndex;
}

/** Anything that moves with the D11 model (ants, creatures). */
export interface Mover extends EntityBase, Pose {
  locomotion: LocomotionClass;
  /** Body radius in voxels for nav clearance (D11). */
  clearance: number;
  /** Distance of the body centre (`pos`) from the surface. */
  rideHeight: number;
  /** Base speed, world units per second. */
  speed: number;
  /** Speed actually achieved last tick (units/s) — drives the gait shader. */
  moveSpeed: number;
  /** D12: true while dropping along −y to the next surface. */
  falling: boolean;
  intent: MoveIntent;
  path: PathState;
}

// =====================================================================================
// 5. Pheromones (D16) & water (D17)
// =====================================================================================

export const Phero = {
  food: 0,
  alarm: 1,
  death: 2,
  dig: 3,
  rally: 4,
  attack: 5,
  avoid: 6,
  trail: 7,
} as const;
export type PheroChannel = (typeof Phero)[keyof typeof Phero];
export const PHERO_CHANNELS = 8;
export const PHERO_NAMES = ['food', 'alarm', 'death', 'dig', 'rally', 'attack', 'avoid', 'trail'] as const;

export interface PheromoneStore {
  /** Add `amount` at a cell (clamped to the channel maximum). */
  deposit(colony: ColonyId, channel: PheroChannel, cell: CellIndex, amount: number): void;
  sample(colony: ColonyId, channel: PheroChannel, cell: CellIndex): number;
  /** Iterate live cells of one colony+channel. Do not deposit/clear from inside `fn`. */
  forEachActive(colony: ColonyId, channel: PheroChannel, fn: (cell: CellIndex, value: number) => void): void;
  /** Remove every channel of every colony at a cell (world edits, D4). */
  clearCell(cell: CellIndex): void;
  /**
   * One evaporation step (called at 2 Hz by the `pheromone` system): value *= keep[channel],
   * entries below the floor are freed. `scale` > 1 speeds decay (wind, rain).
   */
  evaporate(scale?: number): void;
  /** Number of live entries for a colony+channel (tests, debug, perf proxies). */
  activeCount(colony: ColonyId, channel: PheroChannel): number;
  clear(): void;
}

export interface WaterField {
  isFlooded(cell: CellIndex): boolean;
  /** Water depth 0..1 in a cell (1 = full voxel). */
  depthAt(cell: CellIndex): number;
  /** Inject `amount` voxels of water at a cell (rain at entrances, keeper dropper). */
  addWater(cell: CellIndex, amount: number): void;
  /** Advance the fill/drain simulation by one sim tick. */
  step(dt: number, drainScale?: number): void;
  forEachFlooded(fn: (cell: CellIndex, depth: number) => void): void;
  readonly floodedCount: number;
  /** Bumped whenever the flooded set changes (render cache key). */
  readonly version: number;
  clear(): void;
}

// =====================================================================================
// 6. Species, castes, creatures (D20)
// =====================================================================================

export type SpeciesId = 'gardenAnt' | 'fireAnt' | 'leafcutter' | 'termite';
export const SPECIES_IDS: readonly SpeciesId[] = ['gardenAnt', 'fireAnt', 'leafcutter', 'termite'];

/** Not every species has every caste. `major` = large worker (leafcutter), `nasute` = termite glue soldier. */
export type CasteId = 'queen' | 'king' | 'worker' | 'soldier' | 'major' | 'nasute' | 'alate';

export type AttackKind = 'bite' | 'sting' | 'acid' | 'glue';

/** D20 capability flags — faction twists are enforced through these, never by species id checks. */
export interface CapabilityFlags {
  canFill: boolean;
  eatsWood: boolean;
  farmsFungus: boolean;
  rafts: boolean;
  herdsAphids: boolean;
  sunSensitive: boolean;
}

export interface CasteDef {
  id: CasteId;
  name: string;
  /** Body length in world units (worker ≈ 0.7, D1). Drives render scale and ride height. */
  length: number;
  /** Nav clearance radius in voxels. */
  clearance: number;
  /** Base crawl speed, units/s. */
  speed: number;
  maxHealth: number;
  attack: number;
  attackKind: AttackKind;
  /** Seconds between attacks. */
  attackCooldown: number;
  /** Max carried amount (food units). */
  carryCapacity: number;
  /** Dig work units per second. */
  digRate: number;
  /** Lifespan in sim seconds (Infinity for queens). */
  lifespan: number;
  /** Food units to raise one from egg to adult. */
  foodCost: number;
  canLay: boolean;
  winged: boolean;
  /** Response thresholds per job (0..1; lower = takes the job more eagerly; absent = never). */
  thresholds: Partial<Record<JobKind, number>>;
}

export interface SpeciesDef {
  id: SpeciesId;
  name: string;
  kind: 'ant' | 'termite';
  castes: Partial<Record<CasteId, CasteDef>>;
  caps: CapabilityFlags;
  /** Default caste ratio for new brood (weights, normalised by the brood system). */
  defaultCasteRatio: Partial<Record<CasteId, number>>;
  /** Body tint (0..1 rgb) for the placeholder renderer; A4 may ignore. */
  color: readonly [number, number, number];
  /** Starting units when a colony of this species is founded. */
  startingWorkers: number;
  startingFood: number;
}

export type CreatureId =
  | 'jumpingSpider'
  | 'antlion'
  | 'groundBeetle'
  | 'wasp'
  | 'mantis'
  | 'aphid'
  | 'caterpillar'
  | 'worm';

export type CreatureRole = 'hunter' | 'ambush' | 'tank' | 'flyer' | 'boss' | 'herd' | 'prey';

export interface CreatureDef {
  id: CreatureId;
  name: string;
  role: CreatureRole;
  locomotion: LocomotionClass;
  length: number;
  clearance: number;
  speed: number;
  maxHealth: number;
  attack: number;
  attackKind: AttackKind;
  attackCooldown: number;
  /** Perception radius in world units. */
  senseRadius: number;
  /** Food units dropped as a corpse item. */
  foodValue: number;
  /** Director budget cost. */
  threat: number;
}

// =====================================================================================
// 7. Entities (§5.2)
// =====================================================================================

export type TaskKind =
  | 'move'
  | 'gather'
  | 'attack'
  | 'guard'
  | 'follow'
  | 'dig'
  | 'build'
  | 'haul'
  | 'feed'
  | 'carryBrood'
  | 'carryCorpse'
  | 'patrol'
  | 'exile'
  | 'rally'
  | 'wait';

export type TaskSource = 'player' | 'colony' | 'self';

/**
 * One entry of an ant's task queue. Tasks are data; the behavior that owns the task kind
 * interprets `phase`/`data`. `source:'player'` tasks are run by the `player` priority band.
 */
export interface Task {
  id: number;
  kind: TaskKind;
  source: TaskSource;
  /** Target cell (-1 if none). */
  cell: CellIndex;
  /** Target world position (present whenever `cell` ≥ 0 or the target is a point). */
  pos: Vec3 | null;
  /** Target entity (0 if none). */
  targetId: EntityId;
  /** Job-board entry this task fulfils (0 if none). */
  jobId: number;
  /** Behavior-private progress marker. */
  phase: number;
  /** Behavior-private scalar (radius, amount…). */
  data: number;
  issuedTick: Tick;
}

export type ItemKind = 'food' | 'seed' | 'leaf' | 'wood' | 'corpse' | 'debris' | 'honeydew' | 'fungus';

/** What an ant holds in its mandibles. Items/brood are referenced by id; bulk goods by amount. */
export interface Carry {
  kind: 'item' | 'brood' | 'bulk';
  /** Entity id for `item`/`brood`, 0 for `bulk`. */
  id: EntityId;
  itemKind: ItemKind;
  amount: number;
  /** Voxel material for carried dig spoil / building mud (Mat.Air if n/a). */
  material: MaterialId;
}

/** Ophiocordyceps stages (§7). */
export type InfectionStage = 'none' | 'exposed' | 'incubating' | 'erratic' | 'summit' | 'gripped' | 'fruiting' | 'burst';

export interface InfectionState {
  stage: InfectionStage;
  /** Ticks spent in the current stage. */
  timer: number;
  /** Accumulated spore exposure 0..1 while `exposed`. */
  load: number;
}

export type DeathCause = 'age' | 'starvation' | 'desiccation' | 'drowning' | 'combat' | 'fungus' | 'sun' | 'cull' | 'debug';

/** Coarse animation state for renderers/audio. */
export type AntAnim = 'idle' | 'walk' | 'carry' | 'bite' | 'dig' | 'feed' | 'groom' | 'grip' | 'fly' | 'raft';

export interface Ant extends Mover {
  kind: 'ant';
  species: SpeciesId;
  caste: CasteId;
  colony: ColonyId;
  health: number;
  maxHealth: number;
  /** Fed-ness 0..1; 0 starts starvation damage. */
  energy: number;
  /** Hydration 0..1 (desert/heat). */
  hydration: number;
  /** Age in ticks. */
  age: number;
  /** Death-of-old-age tick count (Infinity for queens). */
  lifespan: number;
  /** Task queue; index 0 is current (§5.2). */
  tasks: Task[];
  carrying: Carry | null;
  /** §5.2: brain skipped while true; queue untouched. */
  possessed: boolean;
  infection: InfectionState;
  /** Id of the behavior that ran last think ('' before the first). */
  behavior: string;
  /** Next tick the brain will think for this ant (staggered). */
  thinkAt: Tick;
  /** Current combat/interaction target (0 = none). */
  targetId: EntityId;
  /** Tick until which the ant cannot attack again. */
  attackReadyAt: Tick;
  /** Ticks submerged (drowning) — B2. */
  submerged: number;
  /** Leader followed after a possession "recruit" (0 = none). */
  followId: EntityId;
  /** Player control group 0..9 (0 = none). */
  group: number;
  anim: AntAnim;
  /** Per-ant deterministic random phase 0..1 (gait offset, stagger). */
  phase: number;
  /** Behavior-private numeric scratch (keys namespaced by behavior id). Must stay JSON-plain. */
  mem: Record<string, number>;
}

export interface Creature extends Mover {
  kind: 'creature';
  def: CreatureId;
  /** Colony the creature belongs to (aphid herds), else 0. */
  colony: ColonyId;
  health: number;
  maxHealth: number;
  /** Coarse AI state, interpreted by the creatures system. */
  state: 'idle' | 'roam' | 'stalk' | 'attack' | 'flee' | 'ambush' | 'dead';
  targetId: EntityId;
  attackReadyAt: Tick;
  home: Vec3;
  thinkAt: Tick;
  /** Ticks stuck in glue etc. */
  stunned: number;
  phase: number;
  mem: Record<string, number>;
}

export type BroodStage = 'egg' | 'larva' | 'pupa';

export interface Brood extends EntityBase {
  kind: 'brood';
  colony: ColonyId;
  species: SpeciesId;
  stage: BroodStage;
  /** Caste this brood will eclose as. */
  caste: CasteId;
  /** Ticks in the current stage. */
  age: number;
  /** Food received so far in the larva stage. */
  fed: number;
  /** Ticks since last fed (starvation). */
  hunger: number;
  carriedBy: EntityId;
  up: Vec3;
}

export interface Item extends EntityBase {
  kind: 'item';
  itemKind: ItemKind;
  amount: number;
  /** Colony of origin for corpses (necrophoresis), else 0. */
  colony: ColonyId;
  /** Corpse carries live spores (fungus). */
  infected: boolean;
  carriedBy: EntityId;
  /** Job claimed for hauling this item (0 = unclaimed). */
  claimedBy: EntityId;
  bornTick: Tick;
  up: Vec3;
  falling: boolean;
}

export type FoodKind = 'carcass' | 'seeds' | 'fruit' | 'leaves' | 'honeydew' | 'sugar' | 'gel';

export interface FoodSource extends EntityBase {
  kind: 'food';
  foodKind: FoodKind;
  amount: number;
  maxAmount: number;
  /** Units regenerated per sim second (aphid honeydew, plants). */
  regen: number;
  /** Visual/interaction radius. */
  radius: number;
  up: Vec3;
}

export type Entity = Ant | Creature | Brood | Item | FoodSource;

// ---- Colony ---------------------------------------------------------------------------

export type JobKind =
  | 'forage'
  | 'haulFood'
  | 'dig'
  | 'build'
  | 'feedLarva'
  | 'feedQueen'
  | 'carryBrood'
  | 'carryCorpse'
  | 'guard'
  | 'patrol'
  | 'tendGarden'
  | 'harvestLeaves'
  | 'herdAphids'
  | 'exile';

export const JOB_KINDS: readonly JobKind[] = [
  'forage',
  'haulFood',
  'dig',
  'build',
  'feedLarva',
  'feedQueen',
  'carryBrood',
  'carryCorpse',
  'guard',
  'patrol',
  'tendGarden',
  'harvestLeaves',
  'herdAphids',
  'exile',
];

/** Job-board entry (§5.2). Created/retired by the `jobs` system, claimed by duty behaviors. */
export interface Job {
  id: number;
  kind: JobKind;
  colony: ColonyId;
  cell: CellIndex;
  pos: Vec3;
  targetId: EntityId;
  /** Urgency 0..1 before the player's priority slider is applied. */
  urgency: number;
  /** How many ants may work it at once. */
  slots: number;
  assigned: EntityId[];
  /** Remaining work units (dig cost, amount to haul…). */
  remaining: number;
  /** Designation this job came from (0 = none). */
  designationId: number;
  createdTick: Tick;
  /** Extra scalar (brush radius, material id…). */
  data: number;
}

export type ChamberKind = 'queen' | 'nursery' | 'granary' | 'midden' | 'fungusGarden' | 'entrance' | 'barracks';

export interface Chamber {
  id: number;
  kind: ChamberKind;
  cell: CellIndex;
  pos: Vec3;
  radius: number;
  /** 0..1 — fungus garden health etc. */
  health: number;
}

export type BeaconKind = 'gather' | 'dig' | 'rally' | 'attack' | 'avoid';

export interface Beacon {
  id: number;
  kind: BeaconKind;
  colony: ColonyId;
  pos: Vec3;
  cell: CellIndex;
  radius: number;
  createdTick: Tick;
}

/** Painted dig/build volume (one spherical brush stamp). */
export interface Designation {
  id: number;
  kind: 'dig' | 'build';
  colony: ColonyId;
  center: Vec3;
  radius: number;
  /** Build material (Mat.Mud for termites); Mat.Air for dig. */
  material: MaterialId;
  done: boolean;
}

export interface ColonyStores {
  /** Edible food units. */
  food: number;
  /** Leaf fragments awaiting the fungus garden (leafcutters). */
  leaves: number;
  /** Wood/litter pulp (termites). */
  wood: number;
  /** Building mud (termites). */
  mud: number;
}

export interface PopulationCounts {
  total: number;
  byCaste: Partial<Record<CasteId, number>>;
  eggs: number;
  larvae: number;
  pupae: number;
}

export interface Colony {
  id: ColonyId;
  species: SpeciesId;
  /** Who runs it. Exactly one colony has `controller:'player'`. */
  controller: 'player' | 'ai';
  alive: boolean;
  queenId: EntityId;
  /** Termite king (0 if none). */
  kingId: EntityId;
  /** Nest centre (queen chamber) — home-field source. */
  nestCell: CellIndex;
  nestPos: Vec3;
  /** Surface entrance cell(s) — rain flooding sources, guard posts. */
  entrances: CellIndex[];
  stores: ColonyStores;
  /** Player priority sliders 0..2 (1 = neutral) per job kind. */
  priorities: Record<JobKind, number>;
  /** Caste weights for new brood. */
  casteRatio: Partial<Record<CasteId, number>>;
  chambers: Chamber[];
  jobs: Job[];
  beacons: Beacon[];
  designations: Designation[];
  population: PopulationCounts;
  /** Display tint 0..1 rgb. */
  color: readonly [number, number, number];
  /** Running statistics for goals/UI. */
  stats: { foodDelivered: number; dugVoxels: number; kills: number; deaths: number; born: number };
  /** Next tick the queen may lay. */
  nextLayTick: Tick;
}

// =====================================================================================
// 8. Environment state: weather, director, goals
// =====================================================================================

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'heat' | 'cold' | 'wind';

export interface WeatherState {
  kind: WeatherKind;
  /** 0..1 strength of the current kind. */
  intensity: number;
  /** Horizontal wind vector (units/s); also scales trail decay. */
  wind: Vec3;
  /** Surface wetness 0..1 (drives `uWetness`, trail washout). */
  wetness: number;
  /** Ambient temperature in °C at the surface. */
  temperature: number;
  /** 0..1, 0 = midnight, 0.5 = noon. Farm maps keep a fixed value unless the lamp is on. */
  timeOfDay: number;
  day: number;
  /** Ticks until the weather system rolls the next change. */
  nextChange: number;
  /** Keeper desk lamp (farm maps): heat source position or null. */
  lamp: Vec3 | null;
}

export interface DirectorState {
  enabled: boolean;
  /** Difficulty multiplier on the threat budget. */
  intensity: number;
  budget: number;
  /** 0 scouts → 4 fungus season (§2). */
  stage: number;
  nextWaveTick: Tick;
}

export type GoalKind = 'population' | 'nuptialFlight' | 'eliminateRival' | 'excavate' | 'survive' | 'sandbox';

export interface GoalDef {
  id: string;
  kind: GoalKind;
  /** Population target, percent excavated, days survived… (0 for sandbox). */
  target: number;
  label: string;
}

export interface GoalState {
  def: GoalDef;
  progress: number;
  status: 'active' | 'won' | 'lost';
  /** Reason code for the end screen ('' while active). */
  reason: string;
}

// =====================================================================================
// 9. Commands (input → sim) — §5.1 one-way flow
// =====================================================================================

export type OrderKind = 'move' | 'gather' | 'attack' | 'guard' | 'follow' | 'exile' | 'stop';

/** D14 possession action buttons (edge-triggered by the input layer: true = pressed this tick). */
export interface PossessActions {
  bite: boolean;
  dig: boolean;
  pickup: boolean;
  trail: boolean;
  recruit: boolean;
}

export type KeeperAction = 'dropFood' | 'dropWater' | 'lamp' | 'tapGlass' | 'openTube';

/**
 * Everything the outside world may ask of the sim. Commands are queued by `sim.command()` and
 * applied at the start of the next tick, in order. Commands without `colony` act for the player
 * colony. Each command kind is handled by exactly one system's `onCommand`.
 */
export type Command =
  | { type: 'order'; ids: EntityId[]; order: OrderKind; pos?: Vec3; cell?: CellIndex; targetId?: EntityId; queue?: boolean }
  | { type: 'beacon'; op: 'place'; kind: BeaconKind; pos: Vec3; radius?: number }
  | { type: 'beacon'; op: 'remove'; id: number }
  | { type: 'designate'; kind: 'dig' | 'build'; op: 'add' | 'remove'; center: Vec3; radius: number; material?: MaterialId }
  | { type: 'setPriority'; job: JobKind; value: number }
  | { type: 'setCasteRatio'; caste: CasteId; value: number }
  | { type: 'setGroup'; ids: EntityId[]; group: number }
  | { type: 'possessStart'; id: EntityId }
  | { type: 'possessStop' }
  /** D14. `move` is in the ant's local frame (x = strafe right, y = forward), each −1..1. */
  | { type: 'possessInput'; move: Vec2; yawDelta: number; sprint: boolean; actions: PossessActions; tick?: Tick }
  | { type: 'setSpeed'; speed: 0 | 1 | 2 | 4 }
  | { type: 'pause'; paused: boolean }
  | { type: 'keeper'; action: KeeperAction; pos?: Vec3; on?: boolean; amount?: number }
  | { type: 'setDirector'; enabled?: boolean; intensity?: number }
  /** Debug/test commands (also used by fixtures). */
  | { type: 'debugSpawn'; what: 'ant' | 'creature' | 'item' | 'food'; pos: Vec3; caste?: CasteId; creature?: CreatureId; colony?: ColonyId; count?: number }
  | { type: 'debugKill'; id: EntityId }
  | { type: 'debugWeather'; kind: WeatherKind; intensity?: number }
  | { type: 'debugInfect'; id: EntityId; stage?: InfectionStage };

export type CommandType = Command['type'];

// =====================================================================================
// 10. Events (sim → render/ui/audio) — D19
// =====================================================================================

export type AlertCode =
  | 'underAttack'
  | 'queenInDanger'
  | 'queenDead'
  | 'starving'
  | 'flooding'
  | 'infectionSpotted'
  | 'predatorNear'
  | 'possessedDied'
  | 'raidIncoming'
  | 'broodHungry'
  | 'gardenSick'
  | 'info';

/**
 * Per-tick events. Buffered in the sim and drained once per render frame (D19). Every event
 * carries the tick it happened on. Positions are copies (safe to keep).
 */
export type SimEvent =
  | { type: 'antSpawned'; tick: Tick; id: EntityId; colony: ColonyId; caste: CasteId; pos: Vec3 }
  | { type: 'antDied'; tick: Tick; id: EntityId; colony: ColonyId; caste: CasteId; cause: DeathCause; pos: Vec3 }
  | { type: 'creatureSpawned'; tick: Tick; id: EntityId; def: CreatureId; pos: Vec3 }
  | { type: 'creatureDied'; tick: Tick; id: EntityId; def: CreatureId; pos: Vec3; killerColony: ColonyId }
  | { type: 'broodStage'; tick: Tick; id: EntityId; colony: ColonyId; stage: BroodStage | 'adult' | 'dead'; pos: Vec3 }
  | { type: 'attack'; tick: Tick; attacker: EntityId; target: EntityId; kind: AttackKind; pos: Vec3 }
  | { type: 'damage'; tick: Tick; target: EntityId; amount: number; pos: Vec3 }
  | { type: 'dig'; tick: Tick; by: EntityId; pos: Vec3; radius: number; material: MaterialId }
  | { type: 'build'; tick: Tick; by: EntityId; pos: Vec3; radius: number; material: MaterialId }
  | { type: 'foodFound'; tick: Tick; colony: ColonyId; by: EntityId; source: EntityId; pos: Vec3 }
  | { type: 'foodDelivered'; tick: Tick; colony: ColonyId; by: EntityId; amount: number; pos: Vec3 }
  | { type: 'itemPicked'; tick: Tick; by: EntityId; item: EntityId; pos: Vec3 }
  | { type: 'itemDropped'; tick: Tick; by: EntityId; item: EntityId; pos: Vec3 }
  | { type: 'fell'; tick: Tick; id: EntityId; pos: Vec3 }
  | { type: 'weatherChanged'; tick: Tick; from: WeatherKind; to: WeatherKind }
  | { type: 'rainImpact'; tick: Tick; pos: Vec3; radius: number }
  | { type: 'lightning'; tick: Tick; pos: Vec3 }
  | { type: 'flood'; tick: Tick; pos: Vec3; cell: CellIndex; rising: boolean }
  | { type: 'infectionStage'; tick: Tick; id: EntityId; stage: InfectionStage; pos: Vec3 }
  | { type: 'sporeBurst'; tick: Tick; pos: Vec3; radius: number }
  | { type: 'alert'; tick: Tick; code: AlertCode; colony: ColonyId; pos: Vec3 | null; id: EntityId; text: string }
  | { type: 'orderIssued'; tick: Tick; ids: EntityId[]; order: OrderKind; pos: Vec3 | null }
  | { type: 'beaconChanged'; tick: Tick; op: 'place' | 'remove'; beacon: Beacon }
  | { type: 'designationChanged'; tick: Tick; op: 'add' | 'remove' | 'done'; designation: Designation }
  | { type: 'possession'; tick: Tick; id: EntityId; op: 'start' | 'stop'; reason: 'player' | 'died' | 'invalid' }
  | { type: 'pheromoneBurst'; tick: Tick; colony: ColonyId; channel: PheroChannel; pos: Vec3 }
  | { type: 'keeper'; tick: Tick; action: KeeperAction; pos: Vec3 | null; on: boolean }
  | { type: 'directorWave'; tick: Tick; stage: number; threat: number }
  | { type: 'nuptialFlight'; tick: Tick; colony: ColonyId; pos: Vec3; phase: 'gather' | 'takeoff' }
  | { type: 'colonyDied'; tick: Tick; colony: ColonyId }
  | { type: 'goalProgress'; tick: Tick; goal: string; progress: number; target: number }
  | { type: 'win'; tick: Tick; reason: string }
  | { type: 'lose'; tick: Tick; reason: string };

export type SimEventType = SimEvent['type'];
export type SimEventOf<T extends SimEventType> = Extract<SimEvent, { type: T }>;

// =====================================================================================
// 11. Simulation: state, systems, behaviors (§5.2)
// =====================================================================================

/** Deterministic PRNG (see core/rng.ts). */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  chance(p: number): boolean;
  /** Independent child stream derived from this stream's seed and `label` (does not advance the parent). */
  fork(label: string | number): Rng;
  /** Serializable state (for stateHash). */
  state(): number;
}

export interface SpatialQuery {
  /** Movers (ants + creatures) within `radius` of a point, appended to `out` (cleared first). */
  queryMovers(x: number, y: number, z: number, radius: number, out: Mover[]): Mover[];
}

export type FixtureMode = 'none' | 'wander';

export interface SimOptions {
  seed: number;
  /** Player faction. */
  faction: SpeciesId;
  fixture: FixtureMode;
  /** Number of ants spawned by the wander fixture. */
  fixtureAnts?: number;
}

export interface SimStats {
  tick: Tick;
  ants: number;
  creatures: number;
  brood: number;
  items: number;
  /** Rolling average sim cost per tick in ms (measured by the host via `Simulation.recordTickMs`). */
  msPerTick: number;
  pendingPaths: number;
}

/** The latest D14 input for the possessed ant (held until replaced). */
export interface PossessInputState {
  move: Vec2;
  /** Yaw still to be applied (radians, consumed by the possession system). */
  yawDelta: number;
  sprint: boolean;
  actions: PossessActions;
}

/**
 * Mutable simulation state as seen by systems and behaviors. Implemented by
 * `sim/Simulation.ts`. Nothing outside `sim/` may mutate it (§5.1) — outside code gets `SimView`.
 */
export interface SimState {
  readonly options: SimOptions;
  readonly map: MapGenResult;
  readonly mapId: MapId;
  readonly world: VoxelWorld;
  readonly nav: NavApi;
  readonly pheromones: PheromoneStore;
  readonly water: WaterField;
  readonly rng: Rng;
  readonly spatial: SpatialQuery;

  tick: Tick;
  /** Sim seconds elapsed (tick / 30). */
  time: number;
  speed: 0 | 1 | 2 | 4;
  paused: boolean;

  readonly ants: Ant[];
  readonly creatures: Creature[];
  readonly brood: Brood[];
  readonly items: Item[];
  readonly foodSources: FoodSource[];
  readonly colonies: Colony[];
  /** Id of the player's colony. */
  playerColony: ColonyId;

  weather: WeatherState;
  director: DirectorState;
  goal: GoalState;

  /** Possessed ant id (0 = none) and its held input. */
  possessedId: EntityId;
  possessInput: PossessInputState;

  /** Lookup by id (ants, creatures, brood, items, food). Undefined for dead/swept ids. */
  getEntity(id: EntityId): Entity | undefined;
  getAnt(id: EntityId): Ant | undefined;
  getColony(id: ColonyId): Colony | undefined;
  /** Allocate a fresh entity/task/job id (shared monotonically increasing counter). */
  nextId(): number;

  /** Queue an event for this tick (D19). */
  emit(e: SimEvent): void;

  // ---- entity lifecycle helpers (sim/entities.ts) ----
  spawnAnt(colony: ColonyId, caste: CasteId, pos: Vec3): Ant;
  spawnCreature(def: CreatureId, pos: Vec3, colony?: ColonyId): Creature;
  spawnBrood(colony: ColonyId, caste: CasteId, pos: Vec3): Brood;
  spawnItem(kind: ItemKind, amount: number, pos: Vec3, colony?: ColonyId): Item;
  spawnFood(kind: FoodKind, amount: number, pos: Vec3, regen?: number): FoodSource;
  createColony(species: SpeciesId, controller: 'player' | 'ai', nestPos: Vec3): Colony;
  /** Tombstone an ant (emits antDied, drops a corpse item unless `leaveCorpse` is false). */
  killAnt(ant: Ant, cause: DeathCause, leaveCorpse?: boolean): void;
  killCreature(c: Creature, killerColony?: ColonyId): void;
  /** Tombstone any entity without side effects. */
  remove(e: Entity): void;
}

/**
 * A simulation system. Systems run once per tick in the order of `sim/systems/index.ts`.
 * `commands` lists the command types this system consumes; `onCommand` is called for each such
 * command at the start of the tick, before any system's `update`.
 */
export interface SimSystem {
  readonly id: string;
  readonly commands?: readonly CommandType[];
  init?(sim: SimState): void;
  onCommand?(sim: SimState, cmd: Command): void;
  update(sim: SimState, dt: number): void;
}

/** §5.2 priority bands, strongest first. */
export type BehaviorBand = 'forced' | 'player' | 'survival' | 'duty' | 'idle';
export const BEHAVIOR_BANDS: readonly BehaviorBand[] = ['forced', 'player', 'survival', 'duty', 'idle'];

/**
 * One brain behavior (§5.2). Each think, the brain takes the strongest band in which any
 * behavior scores > 0 and runs the top scorer there. `run` is then called every tick until the
 * next think (so it can keep steering); it may push/pop `ant.tasks` and must set `ant.intent`.
 */
export interface Behavior {
  readonly id: string;
  readonly band: BehaviorBand;
  /** ≤ 0 = not applicable. Must be cheap and side-effect free. */
  score(ant: Ant, sim: SimState): number;
  run(ant: Ant, sim: SimState, dt: number): void;
  /** Called when the brain switches away from this behavior. */
  exit?(ant: Ant, sim: SimState): void;
}

/**
 * Read-only view of the sim for render / ui / audio / input. Same object as the SimState at
 * runtime; the type just removes mutation. Treat everything reachable from it as immutable.
 */
export interface SimView {
  readonly options: Readonly<SimOptions>;
  readonly map: MapGenResult;
  readonly mapId: MapId;
  readonly world: VoxelWorld;
  readonly nav: NavApi;
  readonly pheromones: PheromoneStore;
  readonly water: WaterField;
  readonly tick: Tick;
  readonly time: number;
  readonly speed: 0 | 1 | 2 | 4;
  readonly paused: boolean;
  readonly ants: readonly Readonly<Ant>[];
  readonly creatures: readonly Readonly<Creature>[];
  readonly brood: readonly Readonly<Brood>[];
  readonly items: readonly Readonly<Item>[];
  readonly foodSources: readonly Readonly<FoodSource>[];
  readonly colonies: readonly Readonly<Colony>[];
  readonly playerColony: ColonyId;
  readonly weather: Readonly<WeatherState>;
  readonly director: Readonly<DirectorState>;
  readonly goal: Readonly<GoalState>;
  readonly possessedId: EntityId;
  getEntity(id: EntityId): Readonly<Entity> | undefined;
  getAnt(id: EntityId): Readonly<Ant> | undefined;
  getColony(id: ColonyId): Readonly<Colony> | undefined;
  stats(): SimStats;
  stateHash(): string;
}

// =====================================================================================
// 12. Maps (D20)
// =====================================================================================

export type MapId = 'meadow' | 'forest' | 'desert' | 'gelFarm' | 'sandFarm' | 'formicarium';
export const MAP_IDS: readonly MapId[] = ['meadow', 'forest', 'desert', 'gelFarm', 'sandFarm', 'formicarium'];

export type CameraMode = 'rts' | 'slab';

export interface SpawnPoint {
  kind: 'colony' | 'rival' | 'creature';
  pos: Vec3;
  /** Radius of the pre-dug chamber around `pos` (colony/rival). */
  radius: number;
  /** Surface entrance position of the starter tunnel (colony/rival), else null. */
  entrance: Vec3 | null;
  species?: SpeciesId;
  creature?: CreatureId;
}

export interface FoodSpawn {
  kind: FoodKind;
  pos: Vec3;
  amount: number;
  regen: number;
}

export type PropKind =
  | 'stem'
  | 'log'
  | 'twig'
  | 'mushroom'
  | 'rock'
  | 'leaf'
  | 'grassPatch'
  | 'flower'
  | 'tube'
  | 'tray'
  | 'lamp'
  | 'pebble';

/**
 * Descriptor of a placed prop. Climbables are ALSO written into the voxel grid by the generator
 * (D18); the descriptor lets render modules decorate them (leaves on a stem, bark on a log) and
 * lets fixtures/AI find them. Pure decoration (grassPatch, leaf, pebble) is render-only.
 */
export interface PropDef {
  kind: PropKind;
  /** Base position. */
  pos: Vec3;
  /** Tip/end position for elongated props (stem top, far end of a log); equals `pos` otherwise. */
  end: Vec3;
  radius: number;
  /** True if it exists in voxels and can be walked on. */
  climbable: boolean;
  /** Per-prop seed for render variation. */
  seed: number;
}

export interface EnvironmentDef {
  backdrop: 'sky' | 'room';
  /** Unit vector pointing FROM the scene TOWARDS the sun/key light. */
  sunDir: Vec3;
  sunColor: readonly [number, number, number];
  sunIntensity: number;
  skyTop: readonly [number, number, number];
  skyHorizon: readonly [number, number, number];
  groundColor: readonly [number, number, number];
  ambientIntensity: number;
  fogColor: readonly [number, number, number];
  /** Exponential fog density (0 = off). */
  fogDensity: number;
  /** Sim seconds per day (0 = no day/night cycle). */
  dayLength: number;
  baseTemperature: number;
  /** 0..1 likelihood weight of rain for the weather system. */
  rainChance: number;
}

export interface MapFlags {
  /** Farm map: thin slab between panes (D7). */
  slab: boolean;
  /** Axis perpendicular to the panes on slab maps. */
  slabAxis: 'x' | 'z';
  weather: boolean;
  dayNight: boolean;
  keeperEvents: boolean;
  /** Director spawns outdoor predators. */
  predators: boolean;
  /** Rival colony allowed. */
  rivals: boolean;
}

/** Camera pose in plain data (debug API, shots, start view). */
export interface CameraPose {
  pos: [number, number, number];
  target: [number, number, number];
  fov?: number;
  /** Optional cutaway to apply with the pose. `null` = force off; undefined = leave as is. */
  cut?: CutPlane | null;
}

export interface MapGenOptions {
  faction: SpeciesId;
  /** Smaller world for tests. Generators must honour it by shrinking, never by changing topology. */
  small?: boolean;
}

/** D20 generate result. DECISION: `cameraStart` and `shotPoses` added so shots/e2e have fixed poses. */
export interface MapGenResult {
  world: VoxelWorld;
  spawns: SpawnPoint[];
  foodSources: FoodSpawn[];
  props: PropDef[];
  cameraMode: CameraMode;
  environment: EnvironmentDef;
  boundary: BoundaryMode;
  flags: MapFlags;
  goal: GoalDef;
  cameraStart: CameraPose;
  /** Named poses for `tools/shots.mjs` and `__myrme.setCamera('<name>')`. Always has `overview`. */
  shotPoses: Record<string, CameraPose>;
}

export interface MapDef {
  id: MapId;
  name: string;
  kind: 'outdoor' | 'farm';
  description: string;
  generate(seed: number, opts: MapGenOptions): MapGenResult;
}

// =====================================================================================
// 13. View state shared by input / ui / render (not part of the sim)
// =====================================================================================

/** Camera in plain data. The input layer writes it; the Renderer copies it to the three camera. */
export interface CameraState {
  pos: Vec3;
  /** Unit view direction. */
  forward: Vec3;
  /** Unit camera up (need not be world up — possession uses the ant's local up, D14). */
  up: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  near: number;
  far: number;
  /** Point of interest: shadow-map fit centre and DoF focus. */
  focus: Vec3;
  /** Distance camera→focus. */
  focusDist: number;
}

export type ViewMode = 'rts' | 'slab' | 'possess';

/**
 * Presentation state owned by the input layer (single writer), read by ui and render modules.
 * Lives on the Game as one shared mutable object.
 */
export interface ViewState {
  mode: ViewMode;
  camera: CameraState;
  /** Selected ant ids (may contain ids that died this frame — consumers must tolerate). */
  selection: EntityId[];
  /** Entity under the cursor (0 = none). */
  hoverId: EntityId;
  /** Mirrors sim.possessedId for convenience. */
  possessedId: EntityId;
  firstPerson: boolean;
  cut: CutPlane;
  pheroVision: boolean;
  /** Active paint tool (dig/build designation), or null. */
  tool: 'dig' | 'build' | null;
  /** Screen-space drag box in CSS pixels while box-selecting, else null. */
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** World-space cursor hit from `world.raycast`, or null. */
  cursorWorld: Vec3 | null;
}

// =====================================================================================
// 14. Rendering (§5.3)
// =====================================================================================

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  preset: QualityPreset;
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio: number;
  /** Lower bound for dynamic resolution scaling (1 = disabled). */
  minResolutionScale: number;
  dynamicResolution: boolean;
  shadows: boolean;
  shadowMapSize: number;
  ssao: boolean;
  bloom: boolean;
  dof: boolean;
  godRays: boolean;
  smaa: boolean;
  /** Vignette / chromatic aberration / grain pass. */
  lens: boolean;
  /** Milliseconds per frame the terrain module may spend remeshing (D8). */
  remeshBudgetMs: number;
  /** Density multiplier for render-only decoration (grass, particles). */
  decoration: number;
  /** Max instanced ants drawn at full detail before LOD. */
  antLodCount: number;
}

/**
 * Typed post/look parameters. Render modules (A3 `postlook`) mutate this object; the Renderer
 * applies it to the effect chain every frame. All values are plain numbers.
 */
export interface LookSettings {
  exposure: number;
  ssao: { intensity: number; radius: number; bias: number };
  bloom: { intensity: number; threshold: number; smoothing: number; radius: number };
  /**
   * DoF policy §5.3: `focusDistance`/`focusRange` are world units along the view ray;
   * `strength` 0 disables. The Renderer derives the focus distance from the camera state when
   * `autoFocus` is true.
   */
  dof: { strength: number; autoFocus: boolean; focusDistance: number; focusRange: number; bokehScale: number };
  godRays: { intensity: number; decay: number; density: number; weight: number };
  grade: { saturation: number; contrast: number; brightness: number; hue: number };
  vignette: { offset: number; darkness: number };
  chromaticAberration: number;
  grain: number;
}

/** Values of the shared shader uniforms (§5.3). `render/shared.ts` wraps them as three uniforms. */
export interface SharedUniformValues {
  uTime: number;
  /** xy = wind direction * strength in the xz plane, z = gust phase. */
  uWind: Vec3;
  uWetness: number;
  uSunDir: Vec3;
  uSunColor: Vec3;
  /** Plane (nx, ny, nz, d): fragments with dot(n, p) + d > 0 are discarded. w = +1e9-disabled → n = 0, d = -1. */
  uCutPlane: { x: number; y: number; z: number; w: number };
  /** 0..1 pheromone-vision blend. */
  uPheroVision: number;
}

/** Per-frame info handed to render modules, input and ui. */
export interface FrameInfo {
  /** Real seconds since last frame (0 while time is frozen). */
  dt: number;
  /** Render clock in seconds (frozen by `freezeTime`). */
  time: number;
  /** Interpolation factor between the previous and current sim tick, 0..1. */
  alpha: number;
  tick: Tick;
  /** Events drained this frame (D19) — valid only during the frame. */
  events: readonly SimEvent[];
  frozen: boolean;
  /** Monotonic frame counter. */
  frame: number;
}

/**
 * A scene module (§5.3). `Ctx` is the three.js-typed `RenderContext` from `render/shared.ts`
 * (kept generic here because core must not import three).
 */
export interface RenderModule<Ctx = unknown> {
  readonly id: string;
  init(ctx: Ctx): void;
  update(ctx: Ctx, frame: FrameInfo): void;
  dispose(): void;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** Rolling average CPU ms per rendered frame. */
  frameMs: number;
  fps: number;
  /** Chunks waiting for a remesh. */
  pendingChunks: number;
  resolutionScale: number;
}

// =====================================================================================
// 15. App wiring: game ↔ input / ui / audio, debug API (D21)
// =====================================================================================

export interface UrlParams {
  map: MapId;
  faction: SpeciesId;
  seed: number;
  quality: QualityPreset;
  /** Skip the menu and start immediately (always true until B5 adds the menu). */
  autostart: boolean;
  /** Shot mode: no HUD chrome, no dynamic resolution, deterministic visuals. */
  shot: boolean;
  fixture: FixtureMode;
  /** Ant count for the wander fixture. */
  ants: number;
}

/**
 * What the Game hands to the input, ui and audio layers. These layers never import the sim
 * implementation — they read `sim` (SimView), write `view`, and send commands.
 */
export interface AppContext {
  readonly sim: SimView;
  readonly view: ViewState;
  readonly params: UrlParams;
  /** Root element for DOM UI (position: fixed overlay parent). */
  readonly root: HTMLElement;
  /** The WebGL canvas (pointer events, pointer lock). */
  readonly canvas: HTMLCanvasElement;
  command(cmd: Command): void;
  /** Render-side perf numbers for the HUD. */
  renderStats(): RenderStats;
  /** Canvas CSS size. */
  viewport(): { width: number; height: number };
}

export interface InputLayer {
  init(app: AppContext): void;
  /** Called once per frame before rendering; must update `app.view` (camera, selection…). */
  update(frame: FrameInfo): void;
  /** Debug/shot camera override. A named pose is looked up in `map.shotPoses`. `null` clears. */
  setCameraPose(pose: CameraPose | string | null): void;
  /** Snap any camera smoothing to its target (after `step(n)` / pose changes in shots). */
  snapCamera(): void;
  select(ids: EntityId[]): void;
  dispose(): void;
}

export interface UiLayer {
  init(app: AppContext): void;
  update(frame: FrameInfo): void;
  dispose(): void;
}

export interface AudioLayer {
  init(app: AppContext): void;
  /** Called once per frame with the drained events (frame.events). */
  update(frame: FrameInfo): void;
  setMasterVolume(v: number): void;
  setMuted(muted: boolean): void;
  /** Resume the AudioContext after a user gesture. */
  unlock(): void;
  dispose(): void;
}

export interface DebugStats extends SimStats, RenderStats {
  map: MapId;
  seed: number;
  quality: QualityPreset;
  /** WebGL renderer string (hardware vs SwiftShader). */
  gpu: string;
}

/** D21 `window.__myrme`. */
export interface DebugApi {
  /** True once the map is generated, the first frame rendered and all near chunks meshed. */
  ready: boolean;
  /** Run `n` sim ticks synchronously (ignores pause/freeze), then snap cameras. Returns the tick. */
  step(n: number): number;
  setCamera(pose: CameraPose | string | null): void;
  /** Stop advancing the sim and the render clock (rendering continues). */
  freezeTime(frozen: boolean): void;
  stateHash(): string;
  stats(): DebugStats;
  sim: SimView;
  command(cmd: Command): void;
  select(ids: EntityId[]): void;
  possess(id: EntityId): void;
  release(): void;
  /** DECISION (addition to D21): shared view state and a blocking "render one frame now". */
  view: ViewState;
  renderNow(): void;
}
