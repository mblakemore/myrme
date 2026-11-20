import {
  ISO,
  asSimEvent,
  b3StateOf,
  getMapExtras,
  v3,
  v3clone,
  type Ant,
  type B3Command,
  type CasteId,
  type Colony,
  type CommandType,
  type GoalsState,
  type NavEx,
  type NuptialState,
  type SimState,
  type SimSystem,
} from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { alertOnce, getExt } from './colonyState';
import { isRaining, recaste, temperatureAt } from './keeperEnv';
import { rivalColonies } from './rivals';

/**
 * Goals, win / lose and the nuptial flight (PLAN §2).
 *
 * GOAL KINDS (`sim.goal.def`, set by the map):
 *   population      progress = adult ants; won when it reaches the target
 *   nuptialFlight   progress = adult ants up to the target; then the colony rears winged alates,
 *                   waits for flying weather (warm, daylight, not raining), the alates gather at
 *                   the entrance and take off en masse — won when enough of them got away
 *   eliminateRival  progress = rival (AI) colonies destroyed; won when at least one existed and
 *                   none is left alive
 *   excavate        progress = percent of the map's solid cells (`extras.solidCells`) the colony dug
 *   survive         progress = sim days survived
 *   sandbox         never won
 * `goalProgress` is emitted whenever the progress shown in the HUD changes (≤ 1 Hz).
 *
 * LOSE: a royal is dead — the queen, or for species with a king caste (termites) either of the
 * pair — and no succession is possible. Succession: an adult alate sheds her wings and takes the
 * throne at once; failing that, the colony holds on (`phase: 'succession'`) for as long as
 * queen-destined (alate) brood is alive, and for a short grace period otherwise. Also lost when
 * the last ant dies. Reasons: 'queenDead' | 'kingDead' | 'colonyDead' | 'conceded'.
 *
 * WIN / LOSE set `sim.goal.status` + `reason`, emit the frozen `win` / `lose` event and a
 * `gameEnd` event carrying the `EndSummary` (also kept live in `b3StateOf(sim).goals.summary`).
 * The sim keeps running; after a win the `goal` command `continue` switches to phase
 * 'continued' (sandbox — nothing is evaluated any more except the live summary).
 *
 * The per-alate side of the flight is behaviors/nuptial.ts; the colony-level state machine is
 * here (`NuptialState` in `b3StateOf(sim).nuptial`). Any colony can fly (`startNuptial`); only
 * the player's flight decides the goal.
 */

const _p = v3();

// ---- nuptial flight -------------------------------------------------------------------------------

export function nuptialOf(sim: SimState, colonyId: number): NuptialState | undefined {
  for (const n of b3StateOf(sim).nuptial) if (n.colony === colonyId) return n;
  return undefined;
}

function countAlates(sim: SimState, colonyId: number): number {
  let n = 0;
  for (const a of sim.ants) if (a.alive && a.colony === colonyId && a.caste === 'alate' && !a.mem['nf.gone']) n++;
  return n;
}

/** Begin (or restart) rearing alates for a flight. Returns the colony's nuptial state. */
export function startNuptial(sim: SimState, colony: Colony, wanted?: number): NuptialState {
  const G = BALANCE.b3.goals;
  let n = nuptialOf(sim, colony.id);
  if (!n) {
    n = { colony: colony.id, phase: 'none', wanted: 0, alates: 0, launched: 0, gatherPos: null, gatherCell: -1, phaseTick: sim.tick, hold: '' };
    b3StateOf(sim).nuptial.push(n);
  }
  if (n.phase !== 'none' && n.phase !== 'done') return n;
  n.wanted = wanted ?? Math.min(G.alatesMax, G.alatesBase + Math.floor((colony.population.total / 50) * G.alatesPer50));
  n.launched = 0;
  setPhase(sim, colony, n, 'rearing');
  return n;
}

function setPhase(sim: SimState, colony: Colony, n: NuptialState, phase: NuptialState['phase']): void {
  n.phase = phase;
  n.phaseTick = sim.tick;
  n.hold = '';
  // rear alates only while rearing
  if (phase === 'rearing') {
    let sum = 0;
    for (const k of Object.keys(colony.casteRatio) as CasteId[]) if (k !== 'alate') sum += colony.casteRatio[k] ?? 0;
    colony.casteRatio.alate = Math.max(0.1, sum) * BALANCE.b3.goals.alateWeight;
  } else colony.casteRatio.alate = 0;
}

/** Where the alates assemble: the entrance, else the nearest way out to open sky. */
function pickGather(sim: SimState, colony: Colony, n: NuptialState): void {
  const nav = sim.nav as NavEx;
  let cell = colony.entrances[0] ?? -1;
  if (cell < 0 || !nav.isWalkable(cell)) {
    const sky = nav.skyField();
    let c = colony.nestCell;
    for (let k = 0; k < 600 && c >= 0 && sky.ready; k++) {
      if (sky.distance(c) === 0) break;
      const d = sky.descend(c);
      if (d < 0) break;
      c = d;
    }
    cell = c;
  }
  n.gatherCell = cell;
  n.gatherPos = cell >= 0 ? v3clone(sim.world.cellCenter(cell, _p)) : v3clone(colony.nestPos);
}

function flightHold(sim: SimState, colony: Colony): string {
  const G = BALANCE.b3.goals;
  if (isRaining(sim)) return 'rain';
  if (sim.map.flags.dayNight) {
    const t = sim.weather.timeOfDay;
    if (t < G.dayFrom || t > G.dayTo) return 'night';
  }
  if (temperatureAt(sim, colony.nestPos) < G.minTemperature) return 'cold';
  return '';
}

function updateNuptial(sim: SimState, colony: Colony, n: NuptialState): void {
  const G = BALANCE.b3.goals;
  n.alates = countAlates(sim, colony.id);
  const since = (sim.tick - n.phaseTick) / 30;
  switch (n.phase) {
    case 'rearing': {
      // enough reared — or the brood pipeline has stalled but a party is ready
      if (n.alates >= n.wanted || (since > 420 && n.alates >= 2)) setPhase(sim, colony, n, 'waiting');
      return;
    }
    case 'waiting': {
      if (n.alates === 0) {
        setPhase(sim, colony, n, 'rearing');
        return;
      }
      const hold = flightHold(sim, colony);
      n.hold = hold;
      if (hold && since < G.maxWait) return;
      pickGather(sim, colony, n);
      setPhase(sim, colony, n, 'gather');
      sim.emit({ type: 'nuptialFlight', tick: sim.tick, colony: colony.id, pos: v3clone(n.gatherPos!), phase: 'gather' });
      alertOnce(sim, colony, 'info', 'The alates are gathering for the nuptial flight', n.gatherPos, 0, 0);
      for (const a of sim.ants) {
        if (!a.alive || a.colony !== colony.id || a.caste !== 'alate') continue;
        a.mem['nf.at'] = 0;
        a.mem['nf.go'] = 0;
        a.thinkAt = sim.tick;
      }
      return;
    }
    case 'gather': {
      let there = 0;
      for (const a of sim.ants) if (a.alive && a.colony === colony.id && a.caste === 'alate' && a.mem['nf.at']) there++;
      if (n.alates === 0) {
        setPhase(sim, colony, n, 'rearing');
        return;
      }
      if (there >= Math.ceil(n.alates * G.gatherFraction) || since > G.gatherTime) {
        setPhase(sim, colony, n, 'takeoff');
        let i = 0;
        for (const a of sim.ants) {
          if (!a.alive || a.colony !== colony.id || a.caste !== 'alate') continue;
          a.mem['nf.go'] = sim.tick + 1 + Math.round(i++ * G.takeoffStagger * 30);
          a.thinkAt = sim.tick;
        }
        sim.emit({ type: 'nuptialFlight', tick: sim.tick, colony: colony.id, pos: v3clone(n.gatherPos ?? colony.nestPos), phase: 'takeoff' });
      }
      return;
    }
    case 'takeoff': {
      if (n.alates === 0 || since > G.flightTime + n.wanted * G.takeoffStagger + 60) {
        // stragglers that never got airborne stay behind as ordinary alates
        setPhase(sim, colony, n, 'done');
      }
      return;
    }
    default:
      return;
  }
}

/** Called by behaviors/nuptial.ts when an alate has flown out of the world. */
export function alateDeparted(sim: SimState, ant: Ant): void {
  const n = nuptialOf(sim, ant.colony);
  if (n) n.launched++;
  ant.mem['nf.gone'] = 1;
  sim.remove(ant);
}

// ---- royals / succession ----------------------------------------------------------------------------

function findCaste(sim: SimState, colony: Colony, caste: CasteId): Ant | undefined {
  for (const a of sim.ants) if (a.alive && a.colony === colony.id && a.caste === caste) return a;
  return undefined;
}

/** Makes `colony.queenId` / `kingId` point at living royals where any exist. Returns the missing roles. */
function missingRoyals(sim: SimState, colony: Colony): CasteId[] {
  const out: CasteId[] = [];
  if (!colony.queenId || !sim.getAnt(colony.queenId)) {
    const q = findCaste(sim, colony, 'queen');
    if (q) colony.queenId = q.id;
    else out.push('queen');
  }
  if (getSpecies(colony.species).castes.king) {
    if (!colony.kingId || !sim.getAnt(colony.kingId)) {
      const k = findCaste(sim, colony, 'king');
      colony.kingId = k ? k.id : 0;
      if (!k) out.push('king');
    }
  }
  return out;
}

function promote(sim: SimState, colony: Colony, role: CasteId): boolean {
  let best: Ant | undefined;
  for (const a of sim.ants) {
    if (!a.alive || a.colony !== colony.id || a.caste !== 'alate' || a.locomotion !== 'surface' || a.mem['nf.gone']) continue;
    if (!best || a.id < best.id) best = a;
  }
  if (!best) return false;
  recaste(best, role);
  best.tasks.length = 0;
  best.carrying = null;
  best.thinkAt = sim.tick;
  if (role === 'queen') colony.queenId = best.id;
  else colony.kingId = best.id;
  alertOnce(sim, colony, 'info', role === 'queen' ? 'An alate has shed her wings: the colony has a new queen' : 'A new king has taken his place beside the queen', best.pos, best.id, 0);
  return true;
}

function hasRoyalBrood(sim: SimState, colony: Colony): boolean {
  for (const b of sim.brood) if (b.alive && b.colony === colony.id && (b.caste === 'alate' || b.caste === 'queen' || b.caste === 'king')) return true;
  return false;
}

// ---- end of game -----------------------------------------------------------------------------------

function refreshSummary(sim: SimState, colony: Colony | undefined, g: GoalsState): void {
  const s = g.summary;
  const len = sim.map.environment.dayLength > 0 && sim.map.flags.dayNight ? BALANCE.b2.dayLength : BALANCE.b3.goals.defaultDay; // B2's clock: one day = b2.dayLength
  s.seconds = sim.time;
  s.days = sim.time / len;
  if (!colony) return;
  s.population = colony.population.total;
  if (s.population > s.peakPopulation) s.peakPopulation = s.population;
  s.born = colony.stats.born;
  s.deaths = colony.stats.deaths;
  s.kills = colony.stats.kills;
  s.dugVoxels = colony.stats.dugVoxels;
  s.foodGathered = colony.stats.foodDelivered;
  s.alatesLaunched = nuptialOf(sim, colony.id)?.launched ?? 0;
  const solid = getMapExtras(sim.map)?.solidCells || solidCellsOf(sim);
  g.excavatedPercent = solid > 0 ? (colony.stats.dugVoxels / solid) * 100 : 0;
}

const solidCounts = new WeakMap<object, number>();

/** Solid cells of the map as generated (fallback for maps without A1 extras), counted once. */
function solidCellsOf(sim: SimState): number {
  let n = solidCounts.get(sim.map);
  if (n === undefined) {
    n = 0;
    const den = sim.world.density;
    for (let i = 0; i < den.length; i++) if (den[i] >= ISO) n++;
    const colony = sim.getColony(sim.playerColony);
    n += colony ? colony.stats.dugVoxels : 0;
    solidCounts.set(sim.map, n);
  }
  return n;
}

function finish(sim: SimState, g: GoalsState, result: 'won' | 'lost', reason: string): void {
  if (g.phase === 'won' || g.phase === 'lost' || g.phase === 'continued') return;
  g.phase = result;
  sim.goal.status = result;
  sim.goal.reason = reason;
  g.summary.result = result;
  g.summary.reason = reason;
  refreshSummary(sim, sim.getColony(sim.playerColony), g);
  if (result === 'won') sim.emit({ type: 'win', tick: sim.tick, reason });
  else sim.emit({ type: 'lose', tick: sim.tick, reason });
  sim.emit(asSimEvent({ type: 'gameEnd', tick: sim.tick, result, reason, summary: { ...g.summary } }));
}

interface GoalCtx {
  lastShown: number;
  rivalsSeen: number;
  /** Rivals alive at the previous evaluation. */
  rivalsLast: number;
  active: boolean;
}
const ctxs = new WeakMap<SimState, GoalCtx>();

function setProgress(sim: SimState, ctx: GoalCtx, value: number, digits: number): void {
  const k = 10 ** digits;
  const shown = Math.round(value * k) / k;
  sim.goal.progress = value;
  if (shown === ctx.lastShown) return;
  ctx.lastShown = shown;
  sim.emit({ type: 'goalProgress', tick: sim.tick, goal: sim.goal.def.id, progress: shown, target: sim.goal.def.target });
}

function evaluateGoal(sim: SimState, colony: Colony, g: GoalsState, ctx: GoalCtx): void {
  const def = sim.goal.def;
  const pop = colony.population.total;
  switch (def.kind) {
    case 'population':
      setProgress(sim, ctx, pop, 0);
      if (pop >= def.target && def.target > 0) finish(sim, g, 'won', 'population');
      return;
    case 'nuptialFlight': {
      let n = nuptialOf(sim, colony.id);
      if (!n || n.phase === 'none') {
        setProgress(sim, ctx, Math.min(pop, def.target), 0);
        if (pop >= def.target && def.target > 0) {
          n = startNuptial(sim, colony);
          alertOnce(sim, colony, 'info', 'The colony is strong enough: rearing winged alates for the nuptial flight', colony.nestPos, 0, 0);
        }
        return;
      }
      setProgress(sim, ctx, def.target, 0);
      if (n.phase === 'done') {
        if (n.launched >= Math.max(1, Math.ceil(n.wanted * BALANCE.b3.goals.winFraction))) finish(sim, g, 'won', 'nuptialFlight');
        else {
          // the flight was massacred on the ground: rear another generation
          const launched = n.launched;
          startNuptial(sim, colony);
          n.launched = launched;
        }
      }
      return;
    }
    case 'eliminateRival': {
      // B1's rivals system owns the definition of a rival (nomad raiders do not count); a
      // rival is eliminated when its queen is dead and B1 has marked the colony dead
      const alive = rivalColonies(sim).length;
      const gone = ctx.rivalsSeen - ctx.rivalsLast + Math.max(0, ctx.rivalsLast - alive);
      ctx.rivalsLast = alive;
      ctx.rivalsSeen = alive + gone;
      g.rivalsAlive = alive;
      g.rivalsEliminated = ctx.rivalsSeen - alive;
      setProgress(sim, ctx, g.rivalsEliminated, 0);
      if (ctx.rivalsSeen > 0 && alive === 0 && g.rivalsEliminated >= Math.max(1, Math.min(def.target, ctx.rivalsSeen))) finish(sim, g, 'won', 'eliminateRival');
      return;
    }
    case 'excavate':
      setProgress(sim, ctx, g.excavatedPercent, 1);
      if (def.target > 0 && g.excavatedPercent >= def.target) finish(sim, g, 'won', 'excavate');
      return;
    case 'survive':
      setProgress(sim, ctx, g.summary.days, 1);
      if (def.target > 0 && g.summary.days >= def.target) finish(sim, g, 'won', 'survive');
      return;
    default:
      return;
  }
}

function evaluateLoss(sim: SimState, colony: Colony, g: GoalsState): void {
  // counted directly: `colony.population` is refreshed only every 15 ticks
  let ants = 0;
  for (const a of sim.ants) if (a.alive && a.colony === colony.id) ants++;
  if (ants === 0) {
    finish(sim, g, 'lost', 'colonyDead');
    return;
  }
  let missing = missingRoyals(sim, colony);
  if (missing.length === 0) {
    if (g.phase === 'succession') g.phase = 'playing';
    return;
  }
  // an adult alate takes over at once
  for (const role of missing) promote(sim, colony, role);
  missing = missingRoyals(sim, colony);
  if (missing.length === 0) {
    g.phase = 'playing';
    return;
  }
  if (g.phase !== 'succession') {
    g.phase = 'succession';
    g.graceUntil = sim.tick + Math.round(BALANCE.b3.goals.grace * 30);
    // the queen's death alert comes from the colony system; the king has none
    if (missing.includes('king') && !missing.includes('queen')) alertOnce(sim, colony, 'queenDead', 'The king is dead', colony.nestPos, 0, 0);
    if (hasRoyalBrood(sim, colony)) alertOnce(sim, colony, 'info', 'Royal brood remains — protect it, the colony can still recover', colony.nestPos, 0, 0);
  }
  if (hasRoyalBrood(sim, colony)) return; // queen-destined brood remains (§2)
  if (sim.tick >= g.graceUntil) finish(sim, g, 'lost', missing.includes('queen') ? 'queenDead' : 'kingDead');
}

export const goalsSystem: SimSystem = {
  id: 'goals',
  commands: ['goal' as CommandType],
  init(sim) {
    ctxs.set(sim, { lastShown: -1, rivalsSeen: 0, rivalsLast: 0, active: getExt(sim, sim.playerColony).active });
    b3StateOf(sim);
  },
  onCommand(sim, raw) {
    const cmd = raw as unknown as B3Command;
    if (cmd.type !== 'goal') return;
    const g = b3StateOf(sim).goals;
    const colony = sim.getColony(sim.playerColony);
    if (cmd.op === 'continue') {
      if (g.phase !== 'won') return;
      g.phase = 'continued';
      sim.emit(asSimEvent({ type: 'gameContinue', tick: sim.tick }));
    } else if (cmd.op === 'concede') finish(sim, g, 'lost', 'conceded');
    else if (cmd.op === 'launchFlight' && colony) {
      const n = startNuptial(sim, colony);
      if (n.phase === 'rearing' && countAlates(sim, colony.id) > 0) setPhase(sim, colony, n, 'waiting');
    }
  },
  update(sim) {
    let ctx = ctxs.get(sim);
    if (!ctx) ctxs.set(sim, (ctx = { lastShown: -1, rivalsSeen: 0, rivalsLast: 0, active: getExt(sim, sim.playerColony).active }));
    if (!ctx.active) return; // wander fixture: no economy, no goals
    const b3 = b3StateOf(sim);
    const g = b3.goals;

    // flights run for every colony that started one, at 3 Hz
    if (sim.tick % 10 === 0) {
      for (const n of b3.nuptial) {
        if (n.phase === 'none' || n.phase === 'done') continue;
        const c = sim.getColony(n.colony);
        if (c && c.alive) updateNuptial(sim, c, n);
      }
    }
    if (sim.tick % 15 !== 0) return;
    const colony = sim.getColony(sim.playerColony);
    refreshSummary(sim, colony, g);
    if (!colony || g.phase === 'won' || g.phase === 'lost' || g.phase === 'continued') return;
    evaluateLoss(sim, colony, g);
    if (g.phase === 'playing' || g.phase === 'succession') evaluateGoal(sim, colony, g, ctx);
  },
};
