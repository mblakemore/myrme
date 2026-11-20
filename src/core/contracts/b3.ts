/**
 * Contract extensions owned by stream B3 (PLAN §10.2, D22) — factions & game modes:
 * fire-ant rafts, leafcutter fungus gardens, termite works, aphid herds, keeper events,
 * goals / win / lose / nuptial flight.
 * Additive only — never redefines or widens a type from `core/contracts.ts`.
 *
 * HOW TO READ B3 STATE (render / ui / audio — no sim imports needed):
 *
 *   import { b3StateOf } from '../core';
 *   const b3 = b3StateOf(app.sim);          // same object every call; plain mutable data owned by the sim
 *   b3.gardens / b3.herds / b3.rafts / b3.keeper / b3.termite / b3.nuptial / b3.goals
 *
 * HOW TO READ B3 EVENTS: they travel through the normal D19 buffer (`frame.events`) next to the
 * frozen `SimEvent`s. Their `type` strings never collide with a core event type:
 *
 *   for (const e of frame.events as readonly AnySimEvent[]) if (e.type === 'raft') …
 *
 * HOW TO SEND B3 COMMANDS: `app.command(b3Command({ type: 'goal', op: 'continue' }))`.
 * Extended keeper actions go through the frozen `keeper` command type:
 * `app.command(keeperCommand('dropFood', { food: 'fruit' }))`.
 */
import type { CellIndex, ColonyId, Command, EntityId, FoodKind, KeeperAction, SimEvent, Tick, Vec3 } from '../contracts';

// =====================================================================================
// Leafcutter fungus gardens (systems/fungusGarden.ts)
// =====================================================================================

export type GardenStatus = 'founding' | 'healthy' | 'sick' | 'collapsed';

/** One fungus garden. Lives in a `fungusGarden` chamber (`Colony.chambers`, `Chamber.health` mirrors `health`). */
export interface FungusGardenState {
  id: number;
  colony: ColonyId;
  chamberId: number;
  pos: Vec3;
  cell: CellIndex;
  /** Chamber radius; the rendered fungus comb should fill `radius * fill`. */
  radius: number;
  /** Living fungus (food units it can still yield ≈ biomass). */
  biomass: number;
  /** Carrying capacity of the chamber. */
  capacity: number;
  /** Chewed leaf substrate bedded in the comb, not yet digested. */
  substrate: number;
  /** 0..1 overall vigour (drops with mould, dryness, starvation). */
  health: number;
  /** 0..1 Escovopsis mould cover. Above `mouldSick` the garden is 'sick'. */
  mould: number;
  /** 0..1 biomass / capacity — how full the comb looks. */
  fill: number;
  /** Tick a gardener last worked here. */
  tendedTick: Tick;
  /** Gardeners currently working here. */
  tenders: number;
  status: GardenStatus;
}

// =====================================================================================
// Aphid herds (systems/aphids.ts)
// =====================================================================================

/** A herd of `aphid` creatures on one plant stem (`MapSite` kind `aphidStem`). */
export interface AphidHerdState {
  id: number;
  /** Stem base-of-herd position and the stem tip. */
  pos: Vec3;
  end: Vec3;
  radius: number;
  /** Honeydew `FoodSource` fed by the herd (0 if gone). */
  sourceId: EntityId;
  /** Living aphid creature ids. */
  aphids: EntityId[];
  capacity: number;
  /** Colony that found and tends the herd (0 = wild). `Creature.colony` of its aphids is the same. */
  owner: ColonyId;
  /** Ants standing guard / milking right now. */
  tenders: number;
  /** True while tended recently (boosted honeydew and growth). */
  tended: boolean;
  /** Honeydew units per sim second the herd currently yields. */
  honeydewRate: number;
}

// =====================================================================================
// Fire-ant rafts (systems/raft.ts)
// =====================================================================================

export type RaftPhase = 'forming' | 'afloat' | 'landing';

/**
 * A living raft. `pos` is the centre of the raft disc on the water surface; members are packed in
 * a spiral disc of `radius` around it (their `Ant.anim` is `'raft'`, their poses are driven by the
 * raft system); `riders` (queen, brood, alates) sit on top.
 */
export interface RaftState {
  id: number;
  colony: ColonyId;
  pos: Vec3;
  radius: number;
  /** Horizontal drift velocity, units/s. */
  drift: Vec3;
  /** Ant ids forming the raft body. */
  members: EntityId[];
  /** Ids carried on top: the queen / king / alates (ants) and brood. */
  riders: EntityId[];
  phase: RaftPhase;
  formedTick: Tick;
}

// =====================================================================================
// Termite works (systems/termiteBuild.ts)
// =====================================================================================

/** A covered mud gallery ("shelter tube") being built from the nest towards a wood source. */
export interface ShelterTubeState {
  id: number;
  colony: ColonyId;
  from: Vec3;
  to: Vec3;
  /** Segment count and how many are roofed over. */
  segments: number;
  built: number;
  done: boolean;
}

export interface TermiteWorksState {
  colony: ColonyId;
  tubes: ShelterTubeState[];
  /** Mound over the nest: base position, current height in voxels, mud stamps placed, chimney count. */
  mound: { pos: Vec3; height: number; stamps: number; chimneys: number };
  /** Open breaches in the nest shell awaiting repair. */
  breaches: Vec3[];
  /** Wood currently being eaten: active wood designations (centres). */
  woodFaces: Vec3[];
  /** Termites that took sun damage in the last second (HUD / fx hint). */
  scorched: number;
}

// =====================================================================================
// Keeper (systems/keeper.ts)
// =====================================================================================

/** Everything the keeper can do. The first five are the frozen `KeeperAction`s. */
export type KeeperActionEx = KeeperAction | 'shake' | 'topUp' | 'contaminatedFood';

export type KeeperFoodKind = 'seeds' | 'sugar' | 'fruit' | 'cricket' | 'leaves' | 'wood';

export interface KeeperState {
  /** Schedule active (farm maps with `flags.keeperEvents`). Player keeper commands work regardless. */
  enabled: boolean;
  /** Next scheduled event and what it will be. */
  nextTick: Tick;
  nextAction: KeeperActionEx;
  lampOn: boolean;
  lampPos: Vec3 | null;
  /** Ticks left of glass-tap panic (ants stumble) — 0 when calm. */
  panic: number;
  tubeOpen: boolean;
  tubePos: Vec3 | null;
  /** Counters for UI / tests. */
  counts: Record<KeeperActionEx, number>;
  /** Last event (for a HUD toast). */
  last: { action: KeeperActionEx; tick: Tick; pos: Vec3 | null; food: KeeperFoodKind | '' } | null;
}

// =====================================================================================
// Goals, win / lose, nuptial flight (systems/goals.ts, behaviors/nuptial.ts)
// =====================================================================================

export type NuptialPhase = 'none' | 'rearing' | 'waiting' | 'gather' | 'takeoff' | 'done';

export interface NuptialState {
  colony: ColonyId;
  phase: NuptialPhase;
  /** Alates wanted / alive (adults) / already flown away. */
  wanted: number;
  alates: number;
  launched: number;
  /** Where the alates assemble before take-off (entrance / summit). */
  gatherPos: Vec3 | null;
  gatherCell: CellIndex;
  /** Tick the current phase began. */
  phaseTick: Tick;
  /** Why the flight is on hold while `waiting` ('' if not): 'cold' | 'night' | 'rain'. */
  hold: string;
}

/** End-screen statistics (also updated live while playing). */
export interface EndSummary {
  result: 'won' | 'lost' | 'playing';
  reason: string;
  /** Sim days survived (fractional) and sim seconds. */
  days: number;
  seconds: number;
  population: number;
  peakPopulation: number;
  born: number;
  deaths: number;
  kills: number;
  dugVoxels: number;
  foodGathered: number;
  alatesLaunched: number;
}

/**
 * `playing`     goal active
 * `succession`  the queen (or a termite royal) is dead but queen-destined brood / a grace period
 *               remains — the colony may still recover
 * `won`/`lost`  end screen; the sim keeps running until the host pauses it
 * `continued`   the player chose to keep playing after a win (sandbox; no further win/lose)
 */
export type GoalPhase = 'playing' | 'succession' | 'won' | 'lost' | 'continued';

export interface GoalsState {
  phase: GoalPhase;
  /** Tick at which a `succession` turns into a loss. */
  graceUntil: Tick;
  summary: EndSummary;
  /** Rival colonies alive / eliminated so far (eliminateRival goal). */
  rivalsAlive: number;
  rivalsEliminated: number;
  /** Percent of the map's solid cells excavated (excavate goal; also on other maps). */
  excavatedPercent: number;
}

// =====================================================================================
// The B3 state bag
// =====================================================================================

export interface B3State {
  gardens: FungusGardenState[];
  herds: AphidHerdState[];
  rafts: RaftState[];
  keeper: KeeperState;
  /** One entry per `canFill` colony. */
  termite: TermiteWorksState[];
  /** One entry per colony that ever started a flight. */
  nuptial: NuptialState[];
  goals: GoalsState;
}

const KEEPER_ACTIONS: readonly KeeperActionEx[] = ['dropFood', 'dropWater', 'lamp', 'tapGlass', 'openTube', 'shake', 'topUp', 'contaminatedFood'];

function makeB3State(): B3State {
  const counts = {} as Record<KeeperActionEx, number>;
  for (const a of KEEPER_ACTIONS) counts[a] = 0;
  return {
    gardens: [],
    herds: [],
    rafts: [],
    keeper: { enabled: false, nextTick: 0, nextAction: 'dropFood', lampOn: false, lampPos: null, panic: 0, tubeOpen: false, tubePos: null, counts, last: null },
    termite: [],
    nuptial: [],
    goals: {
      phase: 'playing',
      graceUntil: 0,
      summary: { result: 'playing', reason: '', days: 0, seconds: 0, population: 0, peakPopulation: 0, born: 0, deaths: 0, kills: 0, dugVoxels: 0, foodGathered: 0, alatesLaunched: 0 },
      rivalsAlive: 0,
      rivalsEliminated: 0,
      excavatedPercent: 0,
    },
  };
}

const b3States = new WeakMap<object, B3State>();

/** The B3 state of a simulation (created on first use). Pass the `SimState` / `SimView` object. */
export function b3StateOf(sim: object): B3State {
  let s = b3States.get(sim);
  if (!s) b3States.set(sim, (s = makeB3State()));
  return s;
}

// =====================================================================================
// Events (through the normal D19 buffer; see the header)
// =====================================================================================

export type B3SimEvent =
  /** Every keeper event in full detail (the frozen `keeper` event is emitted as well, with the nearest base action). */
  | { type: 'keeperEvent'; tick: Tick; action: KeeperActionEx; by: 'keeper' | 'player'; pos: Vec3 | null; on: boolean; amount: number; food: KeeperFoodKind | '' }
  | { type: 'raft'; tick: Tick; op: 'formed' | 'landed' | 'lost'; raft: number; colony: ColonyId; pos: Vec3; members: number }
  | { type: 'garden'; tick: Tick; op: 'founded' | 'fed' | 'harvest' | 'mould' | 'weeded' | 'recovered' | 'collapsed'; garden: number; colony: ColonyId; pos: Vec3; amount: number }
  | { type: 'leafCut'; tick: Tick; by: EntityId; colony: ColonyId; pos: Vec3; amount: number }
  | { type: 'aphid'; tick: Tick; op: 'discovered' | 'milked' | 'born' | 'lost'; herd: number; colony: ColonyId; pos: Vec3; by: EntityId }
  | { type: 'shelterTube'; tick: Tick; op: 'started' | 'segment' | 'done'; tube: number; colony: ColonyId; pos: Vec3 }
  | { type: 'sunburn'; tick: Tick; id: EntityId; colony: ColonyId; pos: Vec3 }
  | { type: 'alateTakeoff'; tick: Tick; id: EntityId; colony: ColonyId; pos: Vec3 }
  | { type: 'gameEnd'; tick: Tick; result: 'won' | 'lost'; reason: string; summary: EndSummary }
  | { type: 'gameContinue'; tick: Tick };

export type B3SimEventType = B3SimEvent['type'];
export type AnySimEvent = SimEvent | B3SimEvent;

/** Narrowing helper for consumers iterating `frame.events`. */
export function isB3Event(e: { type: string }): e is B3SimEvent {
  switch (e.type) {
    case 'keeperEvent':
    case 'raft':
    case 'garden':
    case 'leafCut':
    case 'aphid':
    case 'shelterTube':
    case 'sunburn':
    case 'alateTakeoff':
    case 'gameEnd':
    case 'gameContinue':
      return true;
    default:
      return false;
  }
}

/** Typed emit for B3 systems (the sim's event buffer stores any plain object). */
export function asSimEvent(e: B3SimEvent): SimEvent {
  return e as unknown as SimEvent;
}

// =====================================================================================
// Commands
// =====================================================================================

export interface KeeperCommandOptions {
  pos?: Vec3;
  /** `lamp`: on/off (omit to toggle). `openTube`: open/close. */
  on?: boolean;
  amount?: number;
  /** `dropFood`: what is dropped (default: the keeper picks). */
  food?: KeeperFoodKind;
}

/**
 * Build a keeper command, including the extended actions (`shake`, `topUp`, `contaminatedFood`)
 * and the food kind. Works on every map (sandbox: the player acts as keeper).
 */
export function keeperCommand(action: KeeperActionEx, opts: KeeperCommandOptions = {}): Command {
  return { type: 'keeper', action, ...opts } as unknown as Command;
}

/**
 * `goal` commands (consumed by the goals system):
 *  - `continue`  keep playing after a win (phase → 'continued', no further win/lose)
 *  - `concede`   give up: immediate loss with reason 'conceded'
 *  - `launchFlight`  sandbox / debug: start a nuptial flight for the player colony now
 */
export type B3Command = { type: 'goal'; op: 'continue' | 'concede' | 'launchFlight' };

export function b3Command(cmd: B3Command): Command {
  return cmd as unknown as Command;
}

// =====================================================================================
// Faction descriptions (menu / tooltips)
// =====================================================================================

export interface FactionInfo {
  id: 'gardenAnt' | 'fireAnt' | 'leafcutter' | 'termite';
  name: string;
  tagline: string;
  /** Two or three bullet points on how it plays. */
  traits: string[];
  difficulty: 'easy' | 'medium' | 'hard';
}

export const FACTION_INFO: readonly FactionInfo[] = [
  {
    id: 'gardenAnt',
    name: 'Black garden ant',
    tagline: 'Balanced foragers that farm aphids.',
    traits: ['Eats anything it can carry home', 'Herds aphids on plant stems for a steady trickle of honeydew — guard them', 'Solid all-round workers and soldiers'],
    difficulty: 'easy',
  },
  {
    id: 'fireAnt',
    name: 'Fire ant',
    tagline: 'Fast, venomous and unsinkable.',
    traits: ['Quick, fragile workers; cheap soldiers with a venom sting that keeps burning', 'Swarms to alarms in numbers', 'When the nest floods the colony links bodies into a living raft carrying queen and brood'],
    difficulty: 'medium',
  },
  {
    id: 'leafcutter',
    name: 'Leafcutter ant',
    tagline: 'Farmers: leaves in, fungus out.',
    traits: ['Cannot eat forage — media workers cut leaves and parade them home', 'Minims tend the fungus garden, the only food; neglect or overload it and mould takes hold', 'Huge-headed majors defend the columns'],
    difficulty: 'hard',
  },
  {
    id: 'termite',
    name: 'Termite',
    tagline: 'Soft-bodied builders that eat the furniture.',
    traits: ['Eats wood and leaf litter by tunnelling into it', 'Builds mud shelter tubes, walls and a mound — paint build designations', 'King and queen must both live; workers burn in open sun; nasute soldiers spray glue'],
    difficulty: 'hard',
  },
];
