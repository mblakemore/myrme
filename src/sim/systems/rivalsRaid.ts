import { v3, v3clone, type Ant, type CellIndex, type Colony, type ColonyId, type EntityId, type RaidInfo, type RaidKind, type RaidPhase, type SimState, type Tick, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { getExt, hasPlayerTask } from './colonyState';
import { distance, healthFrac, powerOf } from './combatCore';

/**
 * Raids (B1): a group of ants of one colony acting together against a place — an enemy nest
 * (`raid`, `invasion`), a look at it (`scout`), a contested food source (`picket`) or a distant
 * player Attack beacon (`raid` with `beaconId`).
 *
 * This module owns the shared raid state and its phase logic; `behaviors/raid.ts` makes the
 * members act; the rivals system and the director start raids.
 *
 *   muster   gather at the rally point (own nest entrance) until most of the party is there
 *   advance  walk together to the staging point (the victim's entrance / the target point)
 *   assault  fight; inside an enemy nest steal brood and food; hold a point target
 *   return   go home (loot is delivered by the ordinary colony behaviors)
 * Members carry `mem.raid = <raid id>`; while it is set the `raid` behavior outranks duties and
 * the ant counts as "brave" for the fight/flee decision.
 */

const R = BALANCE.b1.raid;
/** `mem` flag of a raid member whose party is going home (it only fights when grabbed). */
export const RETREAT_MEM = 'raid.ret';
const _bp = v3();

export interface Raid {
  id: number;
  kind: RaidKind;
  colony: ColonyId;
  targetColony: ColonyId;
  phase: RaidPhase;
  members: EntityId[];
  size0: number;
  rallyCell: CellIndex;
  rallyPos: Vec3;
  /** Staging point: where the party forms up before the assault (enemy entrance / the target). */
  stageCell: CellIndex;
  stagePos: Vec3;
  /** Assault point (enemy queen chamber / the target point). */
  targetCell: CellIndex;
  targetPos: Vec3;
  startedTick: Tick;
  phaseTick: Tick;
  /** Player Attack beacon this party serves (0 = none). */
  beaconId: number;
  /** Members are removed from the world when they get home (tube-port invaders). */
  vanish: boolean;
  /** Set once the party stood at the target (scouts report back). */
  reached: boolean;
  /** M3: mean distance of the members to the staging point while advancing (cohesion). */
  bodyDist?: number;
}

interface RaidState {
  raids: Raid[];
  /** Finished raids since the last drain (the rivals system reads scouts' reports from here). */
  finished: Raid[];
  /** Final round: player Attack beacon id → tick before which no new war party is mustered for it. */
  beaconRest: Map<number, Tick>;
}

const states = new WeakMap<SimState, RaidState>();

export function getRaids(sim: SimState): RaidState {
  let s = states.get(sim);
  if (!s) states.set(sim, (s = { raids: [], finished: [], beaconRest: new Map() }));
  return s;
}

export function raidOf(sim: SimState, ant: Ant): Raid | undefined {
  const id = ant.mem['raid'];
  if (!id) return undefined;
  const raids = getRaids(sim).raids;
  for (let i = 0; i < raids.length; i++) if (raids[i].id === id) return raids[i];
  return undefined;
}

export function raidInfos(sim: SimState): RaidInfo[] {
  return getRaids(sim).raids.map((r) => ({ id: r.id, kind: r.kind, colony: r.colony, targetColony: r.targetColony, phase: r.phase, members: r.members.slice(), startedTick: r.startedTick }));
}

/** Ants of a colony that could join a raid right now, best fighters first. */
export function raidCandidates(sim: SimState, colony: Colony): Ant[] {
  const out: Ant[] = [];
  for (const a of sim.ants) {
    if (!a.alive || a.colony !== colony.id) continue;
    if (a.caste === 'queen' || a.caste === 'king' || a.caste === 'alate') continue;
    if (a.possessed || a.followId || a.mem['raid'] || a.mem['beacon'] || a.mem['exiled'] || hasPlayerTask(a)) continue;
    if (a.carrying?.kind === 'brood' || healthFrac(a) < 0.6 || a.infection.stage !== 'none') continue;
    // young workers stay with the brood
    if (a.caste === 'worker' && Number.isFinite(a.lifespan) && a.age < a.lifespan * 0.12) continue;
    out.push(a);
  }
  const rank = (a: Ant): number => (a.caste === 'worker' ? 1 : 0);
  out.sort((a, b) => rank(a) - rank(b) || b.age - a.age || a.id - b.id);
  return out;
}

export interface RaidOpts {
  size: number;
  targetColony?: ColonyId;
  /** Use exactly these ants instead of recruiting (invaders that were just spawned). */
  members?: Ant[];
  beaconId?: number;
  vanish?: boolean;
  /** Skip the muster (the party is already together). */
  formed?: boolean;
  /** Only this caste mix: 'soldiers' prefers soldiers but falls back to workers. */
}

function cellNear(sim: SimState, p: Vec3, r = 6): CellIndex {
  return sim.nav.nearestWalkable(p.x, p.y, p.z, r);
}

/**
 * Start a raid of `colony` on a colony (`opts.targetColony`) or a point (`target`). Returns the
 * raid, or null when nobody could be recruited or the places are unreachable.
 */
export function startRaid(sim: SimState, colony: Colony, kind: RaidKind, target: Vec3, opts: RaidOpts): Raid | null {
  const st = getRaids(sim);
  const members = opts.members ?? raidCandidates(sim, colony).slice(0, Math.max(1, Math.round(opts.size)));
  if (members.length === 0) return null;
  const rallyCell = colony.entrances[0] ?? colony.nestCell;
  if (rallyCell < 0) return null;
  const victim = opts.targetColony ? sim.getColony(opts.targetColony) : undefined;
  let stageCell: CellIndex;
  let targetCell: CellIndex;
  if (victim) {
    stageCell = victim.entrances[0] ?? victim.nestCell;
    targetCell = victim.nestCell;
  } else {
    stageCell = targetCell = cellNear(sim, target);
  }
  if (stageCell < 0 || targetCell < 0) return null;
  const raid: Raid = {
    id: sim.nextId(),
    kind,
    colony: colony.id,
    targetColony: victim ? victim.id : 0,
    phase: opts.formed ? 'advance' : 'muster',
    members: members.map((a) => a.id),
    size0: members.length,
    rallyCell,
    rallyPos: sim.world.cellCenter(rallyCell, v3()),
    stageCell,
    stagePos: sim.world.cellCenter(stageCell, v3()),
    targetCell,
    targetPos: victim ? v3clone(victim.nestPos) : sim.world.cellCenter(targetCell, v3()),
    startedTick: sim.tick,
    phaseTick: sim.tick,
    beaconId: opts.beaconId ?? 0,
    vanish: opts.vanish === true,
    reached: false,
  };
  for (const a of members) {
    a.mem['raid'] = raid.id;
    a.mem[RETREAT_MEM] = 0;
    a.thinkAt = sim.tick;
  }
  st.raids.push(raid);
  return raid;
}

function setPhase(sim: SimState, raid: Raid, phase: RaidPhase): void {
  if (raid.phase === phase) return;
  raid.phase = phase;
  raid.phaseTick = sim.tick;
  for (const id of raid.members) {
    const a = sim.getAnt(id);
    if (!a) continue;
    a.thinkAt = sim.tick;
    // a party going home disengages: its members stop picking fights (see combatCore `assess`)
    a.mem[RETREAT_MEM] = phase === 'return' ? 1 : 0;
    if (phase === 'return') {
      a.targetId = 0;
      a.mem['ft.c'] = 0;
    }
  }
}

/** Call a raid off: the party goes home. */
export function recallRaid(sim: SimState, raid: Raid): void {
  if (raid.phase !== 'done' && raid.phase !== 'return') setPhase(sim, raid, 'return');
}

function countNear(sim: SimState, raid: Raid, p: Vec3, r: number): number {
  let n = 0;
  for (const id of raid.members) {
    const a = sim.getAnt(id);
    if (a && distance(a.pos, p) <= r) n++;
  }
  return n;
}

/**
 * The odds have turned on a player war party: the survivors fall back; a standing beacon musters
 * a fresh party only after `beaconWarCooldown` (attacking is a decision, not a suicide switch).
 */
function warRout(sim: SimState, raid: Raid, colony: ColonyId, n: number): void {
  setPhase(sim, raid, 'return');
  sim.emit({ type: 'alert', tick: sim.tick, code: 'info', colony, pos: v3clone(raid.targetPos), id: 0, text: `The war party is beaten back (${n} of ${raid.size0} left) — it is falling back to regroup` });
}

function powerOfColony(sim: SimState, colony: ColonyId): number {
  let p = 0;
  for (const a of sim.ants) if (a.alive && a.colony === colony && a.caste !== 'queen' && a.caste !== 'king') p += powerOf(a);
  return p;
}

/**
 * Has the fight turned against a player war party? Against a colony: what is left of the party
 * is clearly outmatched by what is left of the defenders (losses alone do not count — a party
 * that is winning presses on). Against a point target: most of the party is gone.
 */
function warLost(sim: SimState, raid: Raid, n: number): boolean {
  if (raid.size0 <= 2) return false;
  if (!raid.targetColony) return n < raid.size0 * R.warRoutFrac;
  if (n >= raid.size0 * 0.8) return false; // not blooded yet
  let mine = 0;
  for (const id of raid.members) {
    const a = sim.getAnt(id);
    if (a) mine += powerOf(a);
  }
  return mine < powerOfColony(sim, raid.targetColony) * R.warRetreatOdds;
}

function finish(sim: SimState, st: RaidState, raid: Raid): void {
  raid.phase = 'done';
  if (raid.beaconId) {
    // a beaten party is replaced only after a pause; one that came home whole may go again sooner
    const rest = (raid.members.length < raid.size0 * R.warRoutFrac ? R.beaconWarCooldown : raid.targetColony ? R.beaconWarCooldown * 0.5 : 20) * 30;
    st.beaconRest.set(raid.beaconId, sim.tick + Math.round(rest));
  }
  for (const id of raid.members) {
    const a = sim.getAnt(id);
    if (!a || a.mem['raid'] !== raid.id) continue;
    a.mem['raid'] = 0;
    a.mem[RETREAT_MEM] = 0;
    a.thinkAt = sim.tick;
    if (raid.vanish) sim.remove(a);
  }
  st.finished.push(raid);
}

/** Advance every raid's phase (called by the rivals system a few times per second). */
export function updateRaids(sim: SimState): void {
  const st = getRaids(sim);
  const raids = st.raids;
  for (let i = raids.length - 1; i >= 0; i--) {
    const raid = raids[i];
    // members that died or left
    for (let k = raid.members.length - 1; k >= 0; k--) {
      const a = sim.getAnt(raid.members[k]);
      if (!a || a.mem['raid'] !== raid.id) raid.members.splice(k, 1);
    }
    const n = raid.members.length;
    const colony = sim.getColony(raid.colony);
    const age = (sim.tick - raid.phaseTick) / 30;
    if (n === 0 || !colony || (sim.tick - raid.startedTick) / 30 > R.maxTime) {
      finish(sim, st, raid);
      raids.splice(i, 1);
      continue;
    }
    switch (raid.phase) {
      case 'muster':
        if (raid.beaconId && !colony.beacons.some((b) => b.id === raid.beaconId)) setPhase(sim, raid, 'return');
        else if (age > R.musterTime || countNear(sim, raid, raid.rallyPos, 6) >= Math.ceil(n * R.musterFrac)) setPhase(sim, raid, 'advance');
        break;
      case 'advance': {
        // M3 cohesion: how far the body of the party still is from the staging point; the van
        // waits for it (behaviors/raid.ts) instead of reaching the enemy a few ants at a time
        let sum = 0;
        for (const id of raid.members) {
          const a = sim.getAnt(id);
          if (a) sum += distance(a.pos, raid.stagePos);
        }
        raid.bodyDist = sum / Math.max(1, n);
        if (n <= raid.size0 * R.routFrac && raid.size0 > 1 && !raid.beaconId) setPhase(sim, raid, 'return');
        else if (raid.beaconId && !colony.beacons.some((b) => b.id === raid.beaconId)) setPhase(sim, raid, 'return');
        else if (raid.beaconId && warLost(sim, raid, n)) warRout(sim, raid, colony.id, n);
        else if (countNear(sim, raid, raid.stagePos, 8) >= Math.ceil(n * 0.5) || age > 150) {
          raid.reached = countNear(sim, raid, raid.stagePos, 12) > 0;
          setPhase(sim, raid, 'assault');
        }
        break;
      }
      case 'assault': {
        if (raid.beaconId) {
          // serves a player beacon: lasts as long as the beacon does (or until the victim falls)
          const v = raid.targetColony ? sim.getColony(raid.targetColony) : undefined;
          if (!colony.beacons.some((b) => b.id === raid.beaconId) || (raid.targetColony && (!v || !v.alive))) setPhase(sim, raid, 'return');
          else if (warLost(sim, raid, n)) warRout(sim, raid, colony.id, n);
          break;
        }
        const victim = raid.targetColony ? sim.getColony(raid.targetColony) : undefined;
        const linger = raid.kind === 'scout' ? R.lingerScout : raid.kind === 'picket' ? R.lingerPicket : R.lootTime;
        if (age > linger || (n <= raid.size0 * R.routFrac && raid.size0 > 1) || (raid.targetColony && (!victim || !victim.alive))) setPhase(sim, raid, 'return');
        break;
      }
      case 'return': {
        let home = 0;
        for (const id of raid.members) {
          const a = sim.getAnt(id);
          if (a && a.cell >= 0 && sim.nav.homeDistance(a.colony, a.cell) <= 12) home++;
        }
        if (home >= n || age > 150) {
          finish(sim, st, raid);
          raids.splice(i, 1);
        }
        break;
      }
      default:
        finish(sim, st, raid);
        raids.splice(i, 1);
    }
  }

  // distant player Attack beacons get a mustered war party (A2b's beacon only calls ants nearby)
  const player = sim.getColony(sim.playerColony);
  if (player && player.beacons.length > 0 && getExt(sim, player.id).active) {
    for (const b of player.beacons) {
      if (b.kind !== 'attack' || distance(b.pos, player.nestPos) < R.beaconMinDist) continue;
      if (raids.some((r) => r.beaconId === b.id) || (st.beaconRest.get(b.id) ?? 0) > sim.tick) continue;
      // M3: a beacon on a rival nest is a war on that colony — the party stages at its entrance
      // and pushes in (soldiers for the queen, workers loot), and it is sized to the colony: ten
      // ants against a defended nest only fed the defenders, which made `eliminateRival` unwinnable.
      let victim: Colony | undefined;
      for (const c of sim.colonies) {
        if (!c.alive || c.id === player.id) continue;
        if (distance(b.pos, c.nestPos) <= R.beaconNestRadius || c.entrances.some((e) => distance(b.pos, sim.world.cellCenter(e, _bp)) <= R.beaconNestRadius)) victim = c;
      }
      const cands = raidCandidates(sim, player);
      const size = Math.max(R.beaconParty, Math.min(R.beaconPartyMax, Math.round(cands.length * (victim ? R.beaconWarFrac : R.beaconFrac))));
      if (victim) {
        // final round: the party sizes up the nest before it marches. Against a colony it cannot
        // hope to beat it stays home and says so — a beacon is an order to attack when able, not
        // a switch that feeds the colony into the enemy's doorway fifteen ants at a time.
        let mine = 0;
        for (let i = 0; i < cands.length && i < size; i++) mine += powerOf(cands[i]);
        let theirs = 0;
        let heads = 0;
        for (const a of sim.ants) {
          if (!a.alive || a.colony !== victim.id || a.caste === 'queen' || a.caste === 'king') continue;
          theirs += powerOf(a);
          heads++;
        }
        if (mine < theirs * R.warMinOdds) {
          st.beaconRest.set(b.id, sim.tick + R.warRecheck * 30);
          sim.emit({ type: 'alert', tick: sim.tick, code: 'info', colony: player.id, pos: v3clone(b.pos), id: 0, text: `The war party will not march: ${Math.min(size, cands.length)} fighters against about ${heads} defenders. Raise more ants (or soldiers), or lead an attack yourself` });
          continue;
        }
      }
      startRaid(sim, player, 'raid', b.pos, { size, beaconId: b.id, targetColony: victim?.id });
    }
  }
}

/** Take the list of raids that finished since the last call. */
export function drainFinishedRaids(sim: SimState): Raid[] {
  const st = getRaids(sim);
  if (st.finished.length === 0) return st.finished;
  const out = st.finished;
  st.finished = [];
  return out;
}
