import { getMapExtras, v3, v3clone, type Creature, type CreatureId, type DirectorEventInfo, type DirectorEventKind, type Rng, type SimOptionsB1, type SimState, type SimSystem, type Tick, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { getCreature } from '../data/creatures';
import { powerOf } from './combatCore';
import { isAsleep, spawnCreatureAt, wakeCreature } from './creatures';
import { navOf } from './paths';
import { invasionPoint, requestRivalRaid, rivalColonies, sendScout, spawnInvaders } from './rivals';

/**
 * Threat director (PLAN §2): budget-based pacing of everything hostile.
 *
 *   budget    grows per second with population, elapsed days and `intensity` (= difficulty)
 *   stage     0 scouts → 1 single predators → 2 raids (beetle, rival, wasps) → 3 boss → 4 late
 *             game (B2 may read `sim.director.stage >= 4` as "fungus season"); a stage unlocks by
 *             elapsed time AND population, so a struggling colony is not pushed up the ladder
 *   wave      at `nextWaveTick` the director buys the most expensive event it can afford whose
 *             threat, together with what is still alive from earlier waves, stays under a cap
 *             proportional to the colony's own fighting power — it never stacks waves the
 *             colony cannot win
 *   quiet     after heavy losses (share of the population dead within a minute) nothing new is
 *             scheduled for a while and the budget does not grow
 *   tables    outdoor maps (`flags.predators`): rival scouts, spider, beetle raid, rival raid,
 *             wasp season, mantis · farm maps: invaders arrive through the tube port (or are
 *             dropped in at the drop zone) — sites are read from the map, the keeper's own
 *             events belong to B3
 *   off       `enabled = false` (sandbox / peaceful): no budget, no waves, residents stay asleep
 *
 * Every wave emits `directorWave` and an alert with a position (`raidIncoming` / `predatorNear`).
 * Deterministic: one forked seeded stream; no wall clock.
 * Options: `SimOptionsB1.director` at construction, `setDirector` command at runtime.
 */

const D = BALANCE.b1.director;
type EventKind = DirectorEventKind;
const EVENTS = D.events as Record<EventKind, { cost: number; stage: number; cooldown: number }>;
const OUTDOOR: readonly EventKind[] = ['boss', 'waspSeason', 'beetleRaid', 'rivalRaid', 'predator', 'scout', 'prey'];
const FARM: readonly EventKind[] = ['tubeRaid', 'scout', 'prey'];

interface Pending {
  tick: Tick;
  def: CreatureId;
  pos: Vec3;
}

interface DirectorExt {
  rng: Rng;
  started: boolean;
  lastAt: Partial<Record<EventKind, Tick>>;
  /** Death counter samples of the player colony (tick, total deaths). */
  samples: { tick: Tick; deaths: number }[];
  quietUntil: Tick;
  peak?: number;
  /** Creatures this director put on the map or woke (threat still in play). */
  active: number[];
  pending: Pending[];
  history: DirectorEventInfo[];
  waves: number;
}

const states = new WeakMap<SimState, DirectorExt>();

function getState(sim: SimState): DirectorExt {
  let s = states.get(sim);
  if (!s) states.set(sim, (s = { rng: sim.rng.fork('director'), started: false, lastAt: {}, samples: [], quietUntil: 0, active: [], pending: [], history: [], waves: 0 }));
  return s;
}

const _p = v3();
const _e = v3();

/**
 * Final round — how the difficulty (`director.intensity`: easy 0.6, normal 1, hard 1.5, brutal
 * 2.2) shapes a game. Before, only the budget and (weakly) the timings scaled, while the stage
 * ladder's population gate and the defence-power cap bound in practice, so brutal and normal
 * played alike. Now every binding constraint scales:
 *   pace      stage times, grace and wave spacing ÷ pace (easy later/sparser, brutal ~2.2× faster)
 *   popGate   stage population thresholds ÷ gate above normal (a small colony is no longer safe)
 *   cap       wave threat ≤ capShare × defence × intensity^capPow (+ a floor above normal, so hard
 *             and brutal can send a predator at a colony that could not beat it yet)
 *   quiet     the mercy pause after heavy losses is shorter and harder to trigger above normal
 */
function pace(sim: SimState): number {
  const i = Math.max(0.3, sim.director.intensity);
  return i >= 1 ? i : Math.pow(i, 1.5);
}

function waveCap(sim: SimState): number {
  const i = Math.max(0.3, sim.director.intensity);
  return D.capShare * defencePower(sim) * Math.pow(i, D.capPow) + D.capFloor * Math.max(0, i - 1);
}

/** Fighting power of the player's colony (what a wave is measured against). */
export function defencePower(sim: SimState): number {
  let p = 0;
  for (const a of sim.ants) if (a.alive && a.colony === sim.playerColony && a.caste !== 'queen' && a.caste !== 'king') p += powerOf(a);
  return p;
}

function population(sim: SimState): number {
  let n = 0;
  for (const a of sim.ants) if (a.alive && a.colony === sim.playerColony) n++;
  return n;
}

function playerEntrance(sim: SimState, out: Vec3): boolean {
  const c = sim.getColony(sim.playerColony);
  if (!c) return false;
  const cell = c.entrances[0] ?? c.nestCell;
  if (cell < 0) return false;
  sim.world.cellCenter(cell, out);
  return true;
}

/** Threat of director creatures still alive and awake. */
function activeThreat(sim: SimState, ext: DirectorExt): number {
  let t = 0;
  for (let i = ext.active.length - 1; i >= 0; i--) {
    const e = sim.getEntity(ext.active[i]);
    if (!e || e.kind !== 'creature') {
      ext.active.splice(i, 1);
      continue;
    }
    if (!isAsleep(sim, e) && e.state !== 'idle') t += getCreature(e.def).threat;
  }
  return t;
}

/** A spot on the rim of the map, away from the player's entrance, where `clearance` fits. */
function edgeSpawn(sim: SimState, ext: DirectorExt, clearance: number, out: Vec3): boolean {
  const w = sim.world;
  const nav = navOf(sim);
  const has = playerEntrance(sim, _e);
  const cx = w.sx / 2;
  const cz = w.sz / 2;
  const a0 = ext.rng.range(0, Math.PI * 2);
  for (let k = 0; k < 12; k++) {
    const a = a0 + k * 2.399963;
    // walk from the centre towards the rim along the angle and stop a margin short of it
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const tx = dx > 0 ? (w.sx - 7 - cx) / dx : dx < 0 ? (7 - cx) / dx : Infinity;
    const tz = dz > 0 ? (w.sz - 7 - cz) / dz : dz < 0 ? (7 - cz) / dz : Infinity;
    const t = Math.min(tx, tz);
    const x = cx + dx * t;
    const z = cz + dz * t;
    const y = nav.skyHeight(Math.floor(x), Math.floor(z)) + 1;
    if (has && Math.hypot(x - _e.x, z - _e.z) < Math.min(D.spawnMinDist, Math.min(w.sx, w.sz) * 0.3)) continue;
    const cell = sim.nav.nearestWalkable(x, y, z, 6, clearance);
    if (cell < 0) continue;
    w.cellCenter(cell, out);
    return true;
  }
  return false;
}

function resident(sim: SimState, def: CreatureId): Creature | null {
  for (const c of sim.creatures) if (c.alive && c.def === def && isAsleep(sim, c)) return c;
  return null;
}

function announce(sim: SimState, code: 'predatorNear' | 'raidIncoming' | 'info', text: string, pos: Vec3, id = 0): void {
  sim.emit({ type: 'alert', tick: sim.tick, code, colony: sim.playerColony, pos: v3clone(pos), id, text });
}

/** Final round: director predators are tougher above normal and softer below it. */
function toughen(sim: SimState, c: Creature): void {
  const i = Math.max(0.3, sim.director.intensity);
  const k = 1 + D.toughPerIntensity * (i - 1);
  if (Math.abs(k - 1) < 0.01 || c.mem['c.tough']) return;
  c.mem['c.tough'] = k;
  c.maxHealth *= k;
  c.health *= k;
}

function bringPredator(sim: SimState, ext: DirectorExt, def: CreatureId, text: string): Creature | null {
  let c = resident(sim, def);
  if (c) wakeCreature(sim, c);
  else {
    if (!edgeSpawn(sim, ext, getCreature(def).clearance, _p)) return null;
    c = spawnCreatureAt(sim, def, _p, { stay: D.predatorStay * (def === 'mantis' ? 2.5 : 1) });
  }
  if (def === 'groundBeetle') c.mem['b.next'] = 0;
  toughen(sim, c);
  c.mem['c.alerted'] = 1;
  ext.active.push(c.id);
  announce(sim, 'predatorNear', text, c.pos, c.id);
  return c;
}

/** Can this event happen on this map right now? */
function available(sim: SimState, kind: EventKind): boolean {
  const farm = !sim.map.flags.predators;
  switch (kind) {
    case 'scout':
      return farm ? invasionPoint(sim, _p) : rivalColonies(sim).length > 0;
    case 'rivalRaid':
      // never in the opening minutes, whatever the difficulty (a 20-ant colony cannot take one)
      return sim.time >= D.raidMinTime && rivalColonies(sim).length > 0;
    case 'tubeRaid':
      return invasionPoint(sim, _p);
    case 'prey': {
      let n = 0;
      for (const c of sim.creatures) if (c.alive && (c.def === 'caterpillar' || c.def === 'worm')) n++;
      return n < 3;
    }
    case 'boss': {
      for (const c of sim.creatures) if (c.alive && c.def === 'mantis') return false;
      return true;
    }
    default:
      return true;
  }
}

/** Run one event. Returns the threat actually put in play (0 = it could not happen). */
function fire(sim: SimState, ext: DirectorExt, kind: EventKind, budget: number): number {
  const intensity = Math.max(0.3, sim.director.intensity);
  const farm = !sim.map.flags.predators;
  switch (kind) {
    case 'scout': {
      if (farm) {
        if (!invasionPoint(sim, _p)) return 0;
        const raid = spawnInvaders(sim, _p, 1, 'scout');
        if (!raid) return 0;
        announce(sim, 'info', 'A foreign scout has come through the tube', _p);
        return EVENTS.scout.cost;
      }
      const rivals = rivalColonies(sim);
      if (rivals.length === 0) return 0;
      const raid = sendScout(sim, rivals[ext.rng.int(rivals.length)]);
      if (!raid) return 0;
      announce(sim, 'info', 'A rival scout is heading for the nest', raid.rallyPos);
      return EVENTS.scout.cost;
    }
    case 'prey': {
      const def: CreatureId = farm || ext.rng.chance(0.4) ? 'worm' : 'caterpillar';
      if (farm) {
        const site = getMapExtras(sim.map)?.sites.find((s) => s.kind === 'dropZone');
        if (!site) return 0;
        _p.x = site.pos.x + ext.rng.range(-site.radius, site.radius) * 0.6;
        _p.y = site.pos.y;
        _p.z = site.pos.z;
      } else {
        if (!playerEntrance(sim, _e)) return 0;
        const a = ext.rng.range(0, Math.PI * 2);
        const r = ext.rng.range(14, 24);
        _p.x = Math.max(4, Math.min(sim.world.sx - 4, _e.x + Math.cos(a) * r));
        _p.z = Math.max(4, Math.min(sim.world.sz - 4, _e.z + Math.sin(a) * r));
        _p.y = navOf(sim).skyHeight(Math.floor(_p.x), Math.floor(_p.z)) + 1;
      }
      const cell = sim.nav.nearestWalkable(_p.x, _p.y, _p.z, 8, getCreature(def).clearance);
      if (cell < 0) return 0;
      sim.world.cellCenter(cell, _p);
      const c = spawnCreatureAt(sim, def, _p);
      announce(sim, 'info', `${getCreature(def).name} spotted — a feast for a hunting party`, c.pos, c.id);
      return EVENTS.prey.cost;
    }
    case 'predator': {
      const c = bringPredator(sim, ext, 'jumpingSpider', 'A jumping spider is on the prowl');
      // brutal: they come in pairs
      if (c && intensity >= D.pairIntensity) bringPredator(sim, ext, 'jumpingSpider', 'A second jumping spider is hunting with it');
      return c ? getCreature('jumpingSpider').threat : 0;
    }
    case 'beetleRaid': {
      const c = bringPredator(sim, ext, 'groundBeetle', 'A ground beetle is coming to raid the nest entrance');
      if (c && intensity >= D.pairIntensity) bringPredator(sim, ext, 'groundBeetle', 'Another ground beetle follows it');
      return c ? getCreature('groundBeetle').threat : 0;
    }
    case 'rivalRaid':
      return requestRivalRaid(sim, Math.max(EVENTS.rivalRaid.cost, budget * 0.8));
    case 'tubeRaid': {
      if (!invasionPoint(sim, _p)) return 0;
      const pop = population(sim);
      const afford = Math.floor(budget / 0.8);
      const n = Math.max(2, Math.min(D.tubeMax, afford, Math.round((D.tubeBase + D.tubePerAnt * pop) * intensity)));
      const raid = spawnInvaders(sim, _p, n, 'invasion');
      if (!raid) return 0;
      announce(sim, 'raidIncoming', `Invaders are coming through the tube (${n} ants)`, _p);
      return Math.max(EVENTS.tubeRaid.cost, n * 0.8);
    }
    case 'waspSeason': {
      const n = Math.max(1, Math.round(D.waspCount * intensity));
      const w = sim.world;
      for (let i = 0; i < n; i++) {
        const a = ext.rng.range(0, Math.PI * 2);
        const x = Math.max(4, Math.min(w.sx - 4, w.sx / 2 + Math.cos(a) * w.sx));
        const z = Math.max(4, Math.min(w.sz - 4, w.sz / 2 + Math.sin(a) * w.sz));
        const y = Math.min(w.sy - 3, navOf(sim).skyHeight(Math.floor(x), Math.floor(z)) + BALANCE.b1.creatures.wasp.cruiseHeight);
        ext.pending.push({ tick: sim.tick + 30 + i * Math.round(ext.rng.range(500, 1100)), def: 'wasp', pos: v3(x, y, z) });
      }
      if (playerEntrance(sim, _e)) announce(sim, 'predatorNear', 'Parasitic wasps are circling — keep workers under cover or guarded', _e);
      return getCreature('wasp').threat * n;
    }
    case 'boss': {
      const site = sim.map.spawns.find((s) => s.kind === 'creature' && s.creature === 'mantis');
      let c: Creature | null = null;
      if (site && sim.nav.nearestWalkable(site.pos.x, site.pos.y, site.pos.z, 8, getCreature('mantis').clearance) >= 0) {
        c = spawnCreatureAt(sim, 'mantis', site.pos, { stay: D.predatorStay * 2.5 });
        toughen(sim, c);
        c.mem['c.alerted'] = 1;
        ext.active.push(c.id);
        announce(sim, 'predatorNear', 'A mantis has come hunting', c.pos, c.id);
      } else c = bringPredator(sim, ext, 'mantis', 'A mantis has come hunting');
      return c ? getCreature('mantis').threat : 0;
    }
  }
  return 0;
}

function stageFor(sim: SimState, pop: number): number {
  const k = pace(sim);
  const gate = Math.pow(Math.max(1, sim.director.intensity), D.gatePow);
  let s = 0;
  for (let i = 1; i < D.stageTime.length; i++) if (sim.time >= D.stageTime[i] / k && pop >= D.stagePop[i] / gate) s = i;
  return s;
}

function scheduleNext(sim: SimState, ext: DirectorExt, scale = 1): void {
  const j = 1 + ext.rng.range(-D.waveJitter, D.waveJitter);
  sim.director.nextWaveTick = sim.tick + Math.round((D.waveEvery * 30 * j * scale) / Math.pow(pace(sim), D.wavePacePow));
}

function think(sim: SimState, ext: DirectorExt): void {
  const dir = sim.director;
  const colony = sim.getColony(sim.playerColony);
  if (!colony || !colony.alive) return;
  const pop = population(sim);
  const intensity = Math.max(0, dir.intensity);
  const dt = D.thinkEvery;

  // losses → quiet period
  ext.samples.push({ tick: sim.tick, deaths: colony.stats.deaths });
  while (ext.samples.length > 1 && sim.tick - ext.samples[0].tick > D.lossWindow * 30) ext.samples.shift();
  const lost = colony.stats.deaths - ext.samples[0].deaths;
  const hard = Math.max(1, intensity);
  if (lost >= Math.max(3, D.lossShare * hard * (pop + lost)) && sim.tick >= ext.quietUntil) {
    ext.quietUntil = sim.tick + Math.round((D.quietTime * 30) / Math.pow(Math.max(0.3, intensity), 1.5));
    ext.samples.length = 0;
    ext.samples.push({ tick: sim.tick, deaths: colony.stats.deaths });
    if (dir.nextWaveTick < ext.quietUntil) dir.nextWaveTick = ext.quietUntil;
  }
  // final round — mercy: up to normal, a colony that has shrunk well below its best and is tiny gets
  // room to recover (nothing new is sent; what is already on the map stays)
  ext.peak = Math.max(ext.peak ?? 0, pop);
  const quiet = sim.tick < ext.quietUntil || (intensity <= 1 && pop < D.mercyPop && pop < ext.peak * D.mercyShare);

  const stage = stageFor(sim, pop);
  if (stage > dir.stage) dir.stage = stage;
  if (!quiet) {
    const dayLen = sim.map.environment.dayLength > 0 ? sim.map.environment.dayLength : D.defaultDay;
    const rate = (D.budgetBase + D.budgetPerAnt * pop + D.budgetPerDay * (sim.time / dayLen)) * Math.pow(intensity, D.budgetPow);
    dir.budget = Math.min(D.budgetMax, dir.budget + rate * dt);
  }
  if (quiet || sim.tick < dir.nextWaveTick) return;

  const table = sim.map.flags.predators ? OUTDOOR : FARM;
  // M3: linear in the difficulty (was sqrt): the cap, not the budget, is what binds in practice
  const cap = waveCap(sim);
  const inPlay = activeThreat(sim, ext);
  const options: EventKind[] = [];
  for (const kind of table) {
    const e = EVENTS[kind];
    if (e.stage > dir.stage || e.cost > dir.budget) continue;
    const last = ext.lastAt[kind];
    // M3: per-kind cooldowns shrink with the difficulty too (÷ intensity^0.8). With fixed
    // cooldowns "brutal" only bought more scouts: the dangerous kinds were all cooling down, and
    // brutal games ended with FEWER combat deaths than normal ones.
    if (last !== undefined && sim.tick - last < (e.cooldown * 30) / Math.pow(Math.max(0.5, sim.director.intensity), 0.8)) continue;
    if (e.cost > 1.5 && e.cost + inPlay > cap) continue;
    if (!available(sim, kind)) continue;
    options.push(kind);
  }
  if (options.length === 0) {
    scheduleNext(sim, ext, 0.25);
    return;
  }
  // the table is ordered by weight: usually the heaviest affordable event, sometimes the next one
  options.sort((a, b) => EVENTS[b].cost - EVENTS[a].cost);
  const pick = options.length > 1 && ext.rng.chance(0.3) ? options[1] : options[0];
  const threat = fire(sim, ext, pick, Math.min(dir.budget, Math.max(EVENTS[pick].cost, cap - inPlay)));
  ext.lastAt[pick] = sim.tick;
  if (threat <= 0) {
    scheduleNext(sim, ext, 0.2);
    return;
  }
  dir.budget = Math.max(0, dir.budget - Math.max(EVENTS[pick].cost, threat));
  ext.waves++;
  ext.history.push({ kind: pick, tick: sim.tick, threat });
  sim.emit({ type: 'directorWave', tick: sim.tick, stage: dir.stage, threat });
  scheduleNext(sim, ext, EVENTS[pick].cost <= 1.5 ? 0.5 : 1);
}

function start(sim: SimState, ext: DirectorExt): void {
  ext.started = true;
  sim.director.nextWaveTick = Math.max(sim.tick + 150, Math.round((D.graceTime * 30) / pace(sim)));
}

export const directorSystem: SimSystem = {
  id: 'director',
  commands: ['setDirector'],
  init(sim) {
    const o = (sim.options as SimOptionsB1).director;
    if (o) {
      if (o.intensity !== undefined) sim.director.intensity = Math.max(0, o.intensity);
      if (o.enabled !== undefined) sim.director.enabled = o.enabled && sim.director.intensity > 0;
    }
    getState(sim);
  },
  onCommand(sim, cmd) {
    if (cmd.type !== 'setDirector') return;
    if (cmd.intensity !== undefined) sim.director.intensity = Math.max(0, cmd.intensity);
    if (cmd.enabled !== undefined) sim.director.enabled = cmd.enabled;
    if (sim.director.intensity <= 0) sim.director.enabled = false;
  },
  update(sim) {
    const dir = sim.director;
    if (!dir.enabled || sim.options.fixture !== 'none') return;
    const ext = getState(sim);
    if (!ext.started) start(sim, ext);
    // staggered arrivals of a wave already paid for (wasps)
    if (ext.pending.length > 0) {
      for (let i = ext.pending.length - 1; i >= 0; i--) {
        const p = ext.pending[i];
        if (sim.tick < p.tick) continue;
        ext.pending.splice(i, 1);
        const c = spawnCreatureAt(sim, p.def, p.pos, { stay: D.predatorStay });
        toughen(sim, c);
        ext.active.push(c.id);
      }
    }
    if (sim.tick % (D.thinkEvery * 30) === 5) think(sim, ext);
  },
};

/** Tests / debug / HUD: what the director has done so far. */
export function directorHistory(sim: SimState): readonly DirectorEventInfo[] {
  return getState(sim).history;
}

export function directorDebug(sim: SimState) {
  const ext = getState(sim);
  return { waves: ext.waves, quietUntil: ext.quietUntil, active: ext.active.length, pending: ext.pending.length, inPlay: activeThreat(sim, ext), cap: waveCap(sim) };
}

/** Force an event now, ignoring budget and stage (tests, debug console). Returns its threat. */
export function forceDirectorEvent(sim: SimState, kind: DirectorEventKind): number {
  const ext = getState(sim);
  const threat = fire(sim, ext, kind, 1000);
  if (threat > 0) {
    ext.history.push({ kind, tick: sim.tick, threat });
    sim.emit({ type: 'directorWave', tick: sim.tick, stage: sim.director.stage, threat });
  }
  return threat;
}
