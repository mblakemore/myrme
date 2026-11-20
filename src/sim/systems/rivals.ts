import { getMapExtras, v3, v3clone, type Ant, type Colony, type ColonyId, type SimOptionsB1, type SimState, type SimSystem, type Tick, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { getExt } from './colonyState';
import { distance, getCombat, powerOf } from './combatCore';
import { drainFinishedRaids, getRaids, raidCandidates, recallRaid, startRaid, updateRaids, type Raid } from './rivalsRaid';

/**
 * Rival colonies (B1).
 *
 * An AI colony is an ordinary `Colony` with `controller: 'ai'`: it is founded in the map's
 * pre-carved rival nest with a queen and workers and from then on runs on exactly the machinery
 * the player's colony uses — job board, brood, foraging with its own pheromone channels, its
 * own home field, autonomous digging, necrophoresis, guards. Nothing in here steers individual
 * ants; this system only adds the STRATEGIC layer on top:
 *
 *   scouting      a scout or two is sent to look at the player's nest; once one comes back the
 *                 rival "knows" the player, raises more soldiers and can be sent raiding
 *   food wars     pickets (soldiers if it has any) are posted on food both colonies exploit;
 *                 where trails cross, the fight/flee behaviors produce the border skirmishes
 *   raids         `requestRivalRaid` (called by the director, so pacing and quiet periods hold):
 *                 party size grows with the rival's strength, the difficulty and each raid
 *   defence       parties that have not engaged yet are recalled when its own nest is attacked
 *   elimination   queen dead → `colonyDied` event, colony marked dead, survivors scatter and die
 *
 * Nomad colonies (tube-port invaders on farm maps) are queenless parties without an economy;
 * they are created by `spawnInvaders` and never count as an eliminated rival.
 *
 * WHEN IS THE RIVAL FOUNDED? At the first tick on which threats are on: `SimOptionsB1.rivals`,
 * the director enabled (options or `setDirector`). Peaceful sandboxes and the M1 fixtures get none.
 */

const V = BALANCE.b1.rivals;

interface RivalExt {
  colony: ColonyId;
  nomad: boolean;
  knowsPlayer: boolean;
  nextScout: Tick;
  nextPicket: Tick;
  raids: number;
  lastQueen: number;
  eliminated: boolean;
  foundedTick: Tick;
}

interface RivalsState {
  founded: boolean;
  ext: RivalExt[];
  nomadColony: ColonyId;
}

const states = new WeakMap<SimState, RivalsState>();

function getState(sim: SimState): RivalsState {
  let s = states.get(sim);
  if (!s) states.set(sim, (s = { founded: false, ext: [], nomadColony: 0 }));
  return s;
}

function jitter(sim: SimState, p: Vec3, r: number): Vec3 {
  return v3(p.x + sim.rng.range(-r, r), p.y + sim.rng.range(-r * 0.3, r * 0.3), p.z + sim.rng.range(-r, r));
}

function wanted(sim: SimState): boolean {
  if (sim.options.fixture !== 'none' || !sim.map.flags.rivals) return false;
  const o = sim.options as SimOptionsB1;
  return o.rivals === true || sim.director.enabled;
}

/** Found an AI colony at `nestPos` (queen + workers), exactly like the player's start. */
export function foundColony(sim: SimState, species: Colony['species'], nestPos: Vec3, entrance: Vec3 | null, workers?: number): Colony {
  const st = getState(sim);
  const colony = sim.createColony(species, 'ai', nestPos);
  if (entrance) {
    const e = sim.nav.nearestWalkable(entrance.x, entrance.y, entrance.z, 6);
    if (e >= 0) colony.entrances.push(e);
  }
  const def = getSpecies(species);
  const queen = sim.spawnAnt(colony.id, 'queen', nestPos);
  colony.queenId = queen.id;
  if (def.castes.king) colony.kingId = sim.spawnAnt(colony.id, 'king', jitter(sim, nestPos, 1.5)).id;
  const diff = Math.max(1, (sim.options as SimOptionsB1).director?.intensity ?? sim.director.intensity ?? 1);
  const n = workers ?? Math.max(4, Math.round(def.startingWorkers * V.startScale * Math.pow(diff, V.startPow)));
  for (let i = 0; i < n; i++) sim.spawnAnt(colony.id, 'worker', jitter(sim, nestPos, 3));
  st.ext.push({ colony: colony.id, nomad: false, knowsPlayer: false, nextScout: sim.tick + V.scoutAfter * 30, nextPicket: sim.tick + V.picketAfter * 30, raids: 0, lastQueen: queen.id, eliminated: false, foundedTick: sim.tick });
  return colony;
}

function foundRivals(sim: SimState): void {
  const st = getState(sim);
  st.founded = true;
  const player = sim.getColony(sim.playerColony);
  for (const sp of sim.map.spawns) {
    if (sp.kind !== 'rival') continue;
    foundColony(sim, sp.species ?? player?.species ?? sim.options.faction, sp.pos, sp.entrance);
  }
}

function extOf(sim: SimState, colony: ColonyId): RivalExt | undefined {
  return getState(sim).ext.find((e) => e.colony === colony);
}

/** AI colonies that are real rivals (alive, with a queen). */
export function rivalColonies(sim: SimState): Colony[] {
  const st = getState(sim);
  const out: Colony[] = [];
  for (const e of st.ext) {
    const c = sim.getColony(e.colony);
    if (c && c.alive && !e.nomad && !e.eliminated) out.push(c);
  }
  return out;
}

export function rivalKnowsPlayer(sim: SimState, colony: ColonyId): boolean {
  return extOf(sim, colony)?.knowsPlayer === true;
}

function colonyPower(sim: SimState, colony: ColonyId): number {
  let p = 0;
  for (const a of sim.ants) if (a.alive && a.colony === colony && a.caste !== 'queen' && a.caste !== 'king') p += powerOf(a);
  return p;
}

function hasRaid(sim: SimState, colony: ColonyId, kind?: Raid['kind']): boolean {
  return getRaids(sim).raids.some((r) => r.colony === colony && (!kind || r.kind === kind));
}

function playerEntrancePos(sim: SimState, out: Vec3): boolean {
  const p = sim.getColony(sim.playerColony);
  if (!p || !p.alive) return false;
  const cell = p.entrances[0] ?? p.nestCell;
  if (cell < 0) return false;
  sim.world.cellCenter(cell, out);
  return true;
}

const _p = v3();

/** Fighters an AI colony keeps at home whatever it sends out (final round). */
function homeGuard(sim: SimState, fighters: number): number {
  const share = Math.min(V.guardFracMax, Math.max(V.guardFracMin, V.guardFrac / Math.sqrt(Math.max(0.3, sim.director.intensity))));
  return Math.max(V.homeGuard, Math.round(fighters * share));
}

/** Send a scout party to look at the player's nest. Returns the raid or null. */
export function sendScout(sim: SimState, colony: Colony): Raid | null {
  if (!playerEntrancePos(sim, _p)) return null;
  const cands = raidCandidates(sim, colony).filter((a) => a.caste === 'worker');
  if (cands.length === 0) return null;
  // the oldest workers scout (they are the foragers)
  return startRaid(sim, colony, 'scout', _p, { size: 1, members: cands.slice(0, cands.length > 6 ? 2 : 1), formed: true });
}

/**
 * Director hook: have the strongest rival that knows the player raid the player's nest with a
 * party worth about `threat` (director budget units ≈ fighting power ÷ 1.6). Returns the threat
 * actually committed (0 = no rival could raid).
 */
export function requestRivalRaid(sim: SimState, threat: number): number {
  const player = sim.getColony(sim.playerColony);
  if (!player || !player.alive) return 0;
  let best: Colony | null = null;
  let bestP = 0;
  for (const c of rivalColonies(sim)) {
    if (hasRaid(sim, c.id, 'raid')) continue;
    const p = colonyPower(sim, c.id);
    if (p > bestP) {
      bestP = p;
      best = c;
    }
  }
  if (!best) return 0;
  const ext = extOf(sim, best.id)!;
  const cands = raidCandidates(sim, best);
  // final round: a rival raids with its SURPLUS only — a home guard (a share of its fighters,
  // smaller on higher difficulties) always stays, and a colony too small to spare a real party
  // does not raid at all (it used to bleed itself down to a handful of ants)
  if (cands.length < V.raidMinFighters) return 0;
  const avail = Math.max(0, cands.length - homeGuard(sim, cands.length));
  let size = Math.round(Math.min(avail, V.raidMax * Math.sqrt(Math.max(0.3, sim.director.intensity))));
  // budget → mandibles, growing with every raid already made
  let want = 0;
  let acc = 0;
  const cap = threat * 1.6 * Math.pow(V.raidEscalation, Math.min(4, ext.raids));
  for (const a of cands) {
    if (acc >= cap) break;
    acc += powerOf(a);
    want++;
  }
  size = Math.min(size, Math.max(V.raidMin, want));
  if (size < V.raidMin) return 0;
  const raid = startRaid(sim, best, 'raid', player.nestPos, { size, targetColony: player.id });
  if (!raid) return 0;
  ext.raids++;
  ext.knowsPlayer = true;
  let power = 0;
  for (const id of raid.members) {
    const a = sim.getAnt(id);
    if (a) power += powerOf(a);
  }
  sim.emit({ type: 'alert', tick: sim.tick, code: 'raidIncoming', colony: player.id, pos: v3clone(raid.rallyPos), id: 0, text: `The rival colony is mustering a raid (${raid.members.length} ants)` });
  return Math.max(1, power / 1.6);
}

/**
 * Nomad invaders: `count` ants (a quarter soldiers if the species has them) appear at `pos`
 * (tube port, drop zone) and assault the player's nest; survivors leave the way they came.
 */
export function spawnInvaders(sim: SimState, pos: Vec3, count: number, kind: 'scout' | 'invasion' = 'invasion'): Raid | null {
  const st = getState(sim);
  const player = sim.getColony(sim.playerColony);
  if (!player || !player.alive || count < 1) return null;
  let colony = st.nomadColony ? sim.getColony(st.nomadColony) : undefined;
  if (!colony) {
    colony = sim.createColony(player.species, 'ai', pos);
    if (colony.nestCell < 0) return null;
    colony.stores.food = 0;
    st.nomadColony = colony.id;
    st.ext.push({ colony: colony.id, nomad: true, knowsPlayer: true, nextScout: 0, nextPicket: 0, raids: 0, lastQueen: 0, eliminated: false, foundedTick: sim.tick });
    // no economy: a raiding party, not a colony (A2b's systems skip inactive colonies)
    getExt(sim, colony.id).active = false;
  }
  const def = getSpecies(colony.species);
  const members: Ant[] = [];
  for (let i = 0; i < count; i++) {
    const caste = def.castes.soldier && kind === 'invasion' && i % 4 === 3 ? 'soldier' : 'worker';
    const a = sim.spawnAnt(colony.id, caste, jitter(sim, pos, 1.2));
    a.age = Math.round((Number.isFinite(a.lifespan) ? a.lifespan : 30000) * 0.3);
    members.push(a);
  }
  const raid = startRaid(sim, colony, kind, player.nestPos, { size: count, targetColony: kind === 'invasion' ? player.id : 0, members, formed: true, vanish: true });
  if (kind === 'scout' && raid && playerEntrancePos(sim, _p)) {
    const cell = sim.nav.nearestWalkable(_p.x, _p.y, _p.z, 6);
    if (cell >= 0) {
      raid.stageCell = raid.targetCell = cell;
      sim.world.cellCenter(cell, raid.stagePos);
      sim.world.cellCenter(cell, raid.targetPos);
    }
  }
  return raid;
}

function eliminate(sim: SimState, colony: Colony, ext: RivalExt): void {
  ext.eliminated = true;
  colony.alive = false;
  colony.queenId = 0;
  for (const r of getRaids(sim).raids) if (r.colony === colony.id) recallRaid(sim, r);
  // leaderless: the survivors scatter and die off
  for (const a of sim.ants) {
    if (!a.alive || a.colony !== colony.id) continue;
    a.lifespan = a.age + Math.round(sim.rng.range(8, V.routTime) * 30);
    a.mem['raid'] = 0;
  }
  sim.emit({ type: 'colonyDied', tick: sim.tick, colony: colony.id });
  const player = sim.getColony(sim.playerColony);
  if (player) sim.emit({ type: 'alert', tick: sim.tick, code: 'info', colony: player.id, pos: v3clone(colony.nestPos), id: 0, text: 'The rival queen is dead — their colony has fallen' });
}

function contestedFood(sim: SimState, colony: Colony, out: Vec3): boolean {
  const mine = getExt(sim, colony.id).knownSources;
  const player = sim.getColony(sim.playerColony);
  const theirs = player ? getExt(sim, player.id).knownSources : null;
  let best = Infinity;
  for (const [id] of mine) {
    const f = sim.getEntity(id);
    if (!f || f.kind !== 'food' || f.amount < 10) continue;
    // food the player uses too comes first; otherwise the source nearest to the player
    const shared = theirs?.has(id) ? 0 : 1000;
    const d = shared + (player ? distance(f.pos, player.nestPos) : 0);
    if (d < best) {
      best = d;
      out.x = f.pos.x;
      out.y = f.pos.y;
      out.z = f.pos.z;
    }
  }
  return best < Infinity;
}

function strategy(sim: SimState, colony: Colony, ext: RivalExt): void {
  const tick = sim.tick;
  // elimination
  if (ext.lastQueen && !sim.getAnt(ext.lastQueen)) {
    const q = colony.queenId && colony.queenId !== ext.lastQueen ? sim.getAnt(colony.queenId) : undefined;
    if (q) ext.lastQueen = q.id;
    else {
      eliminate(sim, colony, ext);
      return;
    }
  }
  // scouts that made it back report
  if (ext.knowsPlayer && (colony.casteRatio.soldier ?? 0) < V.warSoldierRatio && getSpecies(colony.species).castes.soldier) {
    colony.casteRatio.soldier = V.warSoldierRatio;
  }
  // defence: under attack at home → parties that have not engaged come back
  const calls = getCombat(sim).calls;
  let besieged = false;
  for (const c of calls) if (c.colony === colony.id && c.kind === 'threat' && c.enemyPower > 2 && distance(c.pos, colony.nestPos) < 22) besieged = true;
  if (besieged) {
    for (const r of getRaids(sim).raids) if (r.colony === colony.id && (r.phase === 'muster' || r.phase === 'advance')) recallRaid(sim, r);
    return;
  }
  if (!sim.director.enabled) return; // peaceful: it just lives
  const intensity = Math.max(0.3, sim.director.intensity);
  // above normal the rival has an edge: a steady income on top of what it forages
  if (intensity > 1) colony.stores.food += V.subsidy * (intensity - 1) * V.thinkEvery;
  if (tick >= ext.nextScout && !hasRaid(sim, colony.id, 'scout')) {
    ext.nextScout = tick + Math.round((V.scoutEvery * 30) / (intensity >= 1 ? intensity : intensity * intensity));
    sendScout(sim, colony);
  }
  if (tick >= ext.nextPicket && !hasRaid(sim, colony.id, 'picket')) {
    ext.nextPicket = tick + Math.round((V.picketEvery * 30) / intensity);
    // pickets are surplus too, and an "easy" rival does not contest food at all
    if (intensity >= V.picketMinIntensity && contestedFood(sim, colony, _p)) {
      const all = raidCandidates(sim, colony);
      const cands = all.length;
      // up to normal a picket is a few WORKERS squabbling over the food; soldiers picket only on
      // hard and above (three soldiers camping on a shared source used to butcher the player's
      // foragers one at a time — forest seeds 2 and 3 lost 25+ workers to a single picket)
      const pool = intensity >= V.picketSoldierIntensity ? all : all.filter((a) => a.caste === 'worker');
      if (cands >= V.raidMinFighters && cands - homeGuard(sim, cands) >= V.picketSize && pool.length >= V.picketSize) {
        startRaid(sim, colony, 'picket', _p, { size: V.picketSize, members: pool.slice(0, V.picketSize) });
      }
    }
  }
}

export const rivalsSystem: SimSystem = {
  id: 'rivals',
  init(sim) {
    getState(sim);
    if (wanted(sim)) foundRivals(sim);
  },
  update(sim) {
    const st = getState(sim);
    if (!st.founded && wanted(sim)) foundRivals(sim);
    if (sim.tick % 15 === 3) {
      updateRaids(sim);
      for (const r of drainFinishedRaids(sim)) {
        if (r.kind !== 'scout' || !r.reached) continue;
        const e = extOf(sim, r.colony);
        // a scout that got home alive has seen the nest
        if (e && r.members.some((id) => sim.getAnt(id))) e.knowsPlayer = true;
      }
    }
    if (st.ext.length === 0 || sim.tick % (V.thinkEvery * 30) !== 11) return;
    for (const ext of st.ext) {
      if (ext.nomad || ext.eliminated) continue;
      const colony = sim.getColony(ext.colony);
      if (colony && colony.alive) strategy(sim, colony, ext);
    }
  },
};

/** Tests / debug: strategic state of an AI colony. */
export function rivalState(sim: SimState, colony: ColonyId) {
  const e = extOf(sim, colony);
  return e ? { ...e, power: colonyPower(sim, colony) } : null;
}

/** Positions director events can use on farm maps (tube port first, then the drop zone). */
export function invasionPoint(sim: SimState, out: Vec3): boolean {
  const sites = getMapExtras(sim.map)?.sites ?? [];
  const site = sites.find((s) => s.kind === 'tubePort') ?? sites.find((s) => s.kind === 'dropZone');
  if (!site) return false;
  const cell = sim.nav.nearestWalkable(site.pos.x, site.pos.y, site.pos.z, 12);
  if (cell < 0) return false;
  sim.world.cellCenter(cell, out);
  return true;
}
