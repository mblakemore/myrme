/**
 * Contract extensions owned by stream A2B (PLAN §10.2, D22).
 * Add types here when `core/contracts.ts` lacks something you need to share; report additions.
 * Additive only — never redefine or widen a type from `core/contracts.ts`.
 */
import type { Ant, BeaconKind, ChamberKind, Colony, EntityId, JobKind, PheroChannel, TaskKind } from '../contracts';

// ---------------------------------------------------------------------------------------
// Conventions (documentation of how A2b uses the frozen contract)
// ---------------------------------------------------------------------------------------

/**
 * TASK QUEUE CONVENTION (`Ant.tasks`):
 *  - `source:'player'` tasks sit at the FRONT of the queue in issue order; the `playerOrder`
 *    behavior (band `player`) runs `tasks[0]` while it is a player task. `move` pops on arrival,
 *    `gather` pops when the source is exhausted, `attack` pops when the target is gone,
 *    `guard` / `follow` / `exile` are persistent (until `stop` or a non-queued order replaces them).
 *  - Behind them an ant holds AT MOST ONE duty task (`source:'colony'` when it fulfils a job-board
 *    entry — `jobId` ≠ 0 — or `source:'self'` for foraging). `dutyTask(ant)` = first non-player
 *    task. The duty behavior that owns the task kind scores `commitScore` while it exists; all
 *    other A2b duty behaviors score 0, so an ant never dithers between jobs mid-task.
 *  - Task kind → owning behavior: gather→forage · haul→haulFood · feed→nurse (target is brood) or
 *    tendQueen (target is an ant) · carryBrood→carryBrood · carryCorpse→necrophoresis · dig→dig ·
 *    patrol→patrol · guard→guard (B1) · build→build (B3).
 *  - Possession never touches the queue; job reservations of a possessed ant are kept.
 *
 * `Ant.mem` keys written by A2b systems (readable by anyone):
 *  - `beacon`   id of the beacon the ant is currently assigned to (0/undefined = none)
 *  - `exiled`   1 while the ant is under an `exile` order
 *  - `p.trail`  1 while a possessed ant lays `trail` pheromone
 */
export const A2B_TASK_OWNER: Readonly<Partial<Record<TaskKind, string>>> = {
  gather: 'forage',
  haul: 'haulFood',
  feed: 'nurse',
  carryBrood: 'carryBrood',
  carryCorpse: 'necrophoresis',
  dig: 'dig',
  patrol: 'patrol',
  guard: 'guard',
  build: 'build',
};

/** Pheromone channel a beacon of each kind deposits over its radius. */
export const BEACON_CHANNEL: Readonly<Record<BeaconKind, PheroChannel>> = {
  gather: 0, // Phero.food
  dig: 3, // Phero.dig
  rally: 4, // Phero.rally
  attack: 5, // Phero.attack
  avoid: 6, // Phero.avoid
};

/** Which `colony.chambers` entry is the active one of a kind: the LAST (newest) of that kind. */
export function activeChamber(colony: Readonly<Colony>, kind: ChamberKind): Colony['chambers'][number] | undefined {
  for (let i = colony.chambers.length - 1; i >= 0; i--) if (colony.chambers[i].kind === kind) return colony.chambers[i];
  return undefined;
}

// ---------------------------------------------------------------------------------------
// HUD helpers (pure functions over contract data — usable from ui/ without importing sim/)
// ---------------------------------------------------------------------------------------

const BEHAVIOR_LABEL: Readonly<Record<string, string>> = {
  idle: 'Idle',
  wander: 'Wandering',
  forage: 'Foraging',
  haulFood: 'Hauling food',
  eat: 'Eating',
  nurse: 'Feeding larvae',
  tendQueen: 'Tending the queen',
  queen: 'Laying eggs',
  carryBrood: 'Carrying brood',
  dig: 'Digging',
  necrophoresis: 'Carrying a corpse',
  patrol: 'Patrolling',
  beacon: 'Answering a beacon',
  playerOrder: 'Following orders',
  fight: 'Fighting',
  flee: 'Fleeing',
  guard: 'Guarding',
  raid: 'Raiding',
  infected: 'Infected',
  floodEscape: 'Escaping the flood',
  hygiene: 'Cleaning',
  build: 'Building',
  harvestLeaves: 'Cutting leaves',
  tendGarden: 'Tending the garden',
  herdAphids: 'Herding aphids',
  raft: 'Rafting',
  seekShade: 'Seeking shade',
  nuptial: 'Nuptial flight',
};

const ORDER_LABEL: Readonly<Partial<Record<TaskKind, string>>> = {
  move: 'Moving (ordered)',
  gather: 'Gathering (ordered)',
  attack: 'Attacking (ordered)',
  guard: 'Guarding (ordered)',
  follow: 'Following (ordered)',
  exile: 'Exiled',
  dig: 'Digging (ordered)',
  build: 'Building (ordered)',
  rally: 'Rallying',
  wait: 'Waiting',
};

const TASK_LABEL: Readonly<Record<TaskKind, string>> = {
  move: 'Move',
  gather: 'Gather food',
  attack: 'Attack',
  guard: 'Guard',
  follow: 'Follow',
  dig: 'Dig',
  build: 'Build',
  haul: 'Haul food',
  feed: 'Feed',
  carryBrood: 'Carry brood',
  carryCorpse: 'Carry corpse',
  patrol: 'Patrol',
  exile: 'Exile',
  rally: 'Rally',
  wait: 'Wait',
};

/** Phase names of a `gather` task (forage state machine) for the selection panel. */
export const FORAGE_PHASES = ['leaving nest', 'scouting', 'following trail', 'approaching food', 'cutting a load', 'carrying food home', 'returning empty', 'heading back to source'] as const;

/** One-line activity label for the selection panel ("task label per ant"). */
export function antActivityLabel(ant: Readonly<Ant>): string {
  if (ant.possessed) return 'Possessed';
  if (ant.behavior === 'playerOrder') {
    const t = ant.tasks[0];
    if (t && t.source === 'player') return ORDER_LABEL[t.kind] ?? 'Following orders';
    if (ant.followId) return 'Following the leader';
  }
  if (ant.behavior === 'forage') {
    const t = ant.tasks.find((x) => x.kind === 'gather' && x.source !== 'player');
    if (t) return `Foraging — ${FORAGE_PHASES[t.phase] ?? 'working'}`;
  }
  return BEHAVIOR_LABEL[ant.behavior] ?? (ant.behavior || 'Idle');
}

/** Labels for every entry of an ant's queue, front first (player orders are marked). */
export function antQueueLabels(ant: Readonly<Ant>): string[] {
  return ant.tasks.map((t) => (t.source === 'player' ? `▶ ${TASK_LABEL[t.kind]}` : TASK_LABEL[t.kind]));
}

/** Job-board summary for the colony panel: open/total slots per job kind. */
export function jobSummary(colony: Readonly<Colony>): Partial<Record<JobKind, { jobs: number; slots: number; assigned: number }>> {
  const out: Partial<Record<JobKind, { jobs: number; slots: number; assigned: number }>> = {};
  for (const j of colony.jobs) {
    const e = (out[j.kind] ??= { jobs: 0, slots: 0, assigned: 0 });
    e.jobs++;
    e.slots += j.slots;
    e.assigned += j.assigned.length;
  }
  return out;
}

/** Ids of the ants currently following `leader` after a possession "recruit". */
export function followersOf(ants: readonly Readonly<Ant>[], leader: EntityId): EntityId[] {
  const out: EntityId[] = [];
  for (const a of ants) if (a.alive && a.followId === leader) out.push(a.id);
  return out;
}
