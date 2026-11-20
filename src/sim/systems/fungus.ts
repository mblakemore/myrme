import {
  FZ_DRAG,
  FZ_EXILE,
  FZ_NOISE,
  HOME_UNREACHABLE,
  Phero,
  getMapExtras,
  hash01,
  v3,
  v3clone,
  type Ant,
  type CellIndex,
  type Colony,
  type DistanceField,
  type EntityId,
  type FungusStalk,
  type InfectionStage,
  type Item,
  type Mover,
  type NavEx,
  type Rng,
  type SimState,
  type SimSystem,
  type Vec3,
} from '../../core';
import { dropCarry } from '../behaviors/util';
import { BALANCE } from '../data/balance';
import { chamberAt } from './colonyState';
import { alertB2, envState, type EnvState } from './weatherEnv';

/**
 * Zombie fungus (Ophiocordyceps) — the whole arc (§7):
 *
 *   spores → `exposed` (load 0..1 builds with every dusting, slowly groomed away) → `incubating`
 *   (no symptoms, hidden; smellable by nestmates late) → `erratic` (stumbles, convulses, drops
 *   its job, drifts out of the nest) → `summit` (compelled climb to a grip point on a stem, via
 *   the `b2:summit` distance field) → `gripped` (death grip: a static, attackable body) →
 *   `fruiting` (the stalk grows) → `burst` (sporulation: periodic spore bursts rain on everything
 *   below and linger as clouds) until the body is chewed down or spent.
 *
 * State lives on `ant.infection` (stage, timer in ticks, load) plus this system's context:
 * fruiting bodies (`envOf(sim).stalks`), spore clouds, tracked infected corpses, the hygiene
 * target list. Stage changes go through `setStage` (emits `infectionStage`, alerts on discovery).
 *
 * A death-gripped ant stays in `sim.ants` (locomotion 'static', anim 'grip', never ages or
 * starves) so it can be targeted: an attack order on it makes workers chew it down (A2b's
 * `isHostile` already accepts infected nestmates); killing it leaves a sterile corpse.
 * Infected ants that die BEFORE gripping leave an infected corpse; left lying it fruits on the
 * ground (smaller bursts — inside the nest that reaches the nursery). Hauling it to the midden
 * (necrophoresis) stops that: there the fungus grows too slowly to beat decay.
 *
 * Social immunity is split between this system (smell detection → hygiene targets, avoid
 * pheromone under known stalks, quick death signal for infected corpses) and the `hygiene`
 * behavior (grooming cure, dragging victims out to the exile spot). `colony.priorities.exile`
 * is the hygiene slider (0 = off).
 *
 * Commands: `debugInfect {id, stage?}` (default stage 'incubating').
 */

export const GROOM = 1;
export const EXILE = 2;

interface CorpseRec {
  /** Scaled ticks towards fruiting. */
  timer: number;
  dosed: EntityId;
  alerted: boolean;
  /** Ticks since the ground stalk started sporulating. */
  spent: number;
}

export interface FzCtx {
  rng: Rng;
  env: EnvState;
  summit: DistanceField | null;
  summitSources: CellIndex[];
  corpses: Map<EntityId, CorpseRec>;
  /** Hygiene targets per colony: ant id → GROOM | EXILE. */
  targets: Map<EntityId, number>[];
  /** Hygiene target id → the nestmate working on it. */
  claims: Map<EntityId, EntityId>;
  /** Stalk ids each colony has seen (index = colony id). */
  seen: Set<number>[];
  exileAt: number[];
}

const ctxs = new WeakMap<SimState, FzCtx>();
const _movers: Mover[] = [];
const _c = v3();

export function fungusCtx(sim: SimState): FzCtx {
  let c = ctxs.get(sim);
  if (!c) {
    c = { rng: sim.rng.fork('b2.fungus'), env: envState(sim), summit: null, summitSources: [], corpses: new Map(), targets: [], claims: new Map(), seen: [], exileAt: [] };
    ctxs.set(sim, c);
    const env = c.env;
    env.hooks.exposeToSpores = (pos, radius, dose, sheltered) => dose > 0 ? doseArea(sim, pos, radius, dose, sheltered, false) : 0;
    env.hooks.controlNoise = (id) => {
      const a = sim.getAnt(id);
      return a ? controlNoise(a) : 0;
    };
  }
  return c;
}

export function isStalkStage(s: InfectionStage): boolean {
  return s === 'gripped' || s === 'fruiting' || s === 'burst';
}

/** Symptomatic or about to be: the stages `infected` (forced band) runs. */
export function isZombie(s: InfectionStage): boolean {
  return s === 'erratic' || s === 'summit' || isStalkStage(s);
}

export function incubationTicks(ant: Ant): number {
  const B = BALANCE.b2;
  return Math.round((B.incubation[0] + (B.incubation[1] - B.incubation[0]) * hash01(ant.id, 11)) * 30);
}

export function erraticTicks(ant: Ant): number {
  const B = BALANCE.b2;
  return Math.round((B.erratic[0] + (B.erratic[1] - B.erratic[0]) * hash01(ant.id, 12)) * 30);
}

/** Is the infection far enough along for nestmates to smell it? */
export function smellable(ant: Ant): boolean {
  const s = ant.infection.stage;
  if (s === 'erratic') return true;
  return s === 'incubating' && ant.infection.timer >= incubationTicks(ant) * (1 - BALANCE.b2.lateIncubation);
}

/** 0..1 loss of control (possession wobble, twitch). */
export function controlNoise(ant: Ant): number {
  const inf = ant.infection;
  switch (inf.stage) {
    case 'incubating': {
      const dur = incubationTicks(ant);
      const late = BALANCE.b2.lateIncubation;
      const f = inf.timer / dur;
      return f < 1 - late ? 0.03 : 0.06 + 0.2 * Math.min(1, (f - (1 - late)) / late);
    }
    case 'erratic':
      return 0.65;
    case 'summit':
      return 0.9;
    case 'gripped':
    case 'fruiting':
    case 'burst':
      return 1;
    default:
      return 0;
  }
}

// ---- summit field ----------------------------------------------------------------------------

function cellsNear(sim: SimState, p: Vec3, out: CellIndex[]): void {
  const w = sim.world;
  for (const r of [2.2, 3.4, 4.6]) {
    const R = Math.ceil(r);
    let n = 0;
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          const x = Math.floor(p.x) + dx;
          const y = Math.floor(p.y) + dy;
          const z = Math.floor(p.z) + dz;
          if (!w.inBounds(x, y, z)) continue;
          const c = w.index(x, y, z);
          if (sim.nav.isWalkable(c)) {
            out.push(c);
            n++;
          }
        }
    if (n > 0) return;
  }
}

/** Grip points: `summit` sites and a point well up every climbable stem-like prop. */
function buildSummitSources(sim: SimState, ctx: FzCtx): void {
  const B = BALANCE.b2;
  const out: CellIndex[] = [];
  const extras = getMapExtras(sim.map);
  if (extras) for (const s of extras.sites) if (s.kind === 'summit') cellsNear(sim, s.pos, out);
  for (const p of sim.map.props) {
    if (!p.climbable || (p.kind !== 'stem' && p.kind !== 'twig' && p.kind !== 'flower' && p.kind !== 'mushroom')) continue;
    const rise = p.end.y - p.pos.y;
    if (rise < 2.5) continue;
    const len = Math.hypot(p.end.x - p.pos.x, p.end.y - p.pos.y, p.end.z - p.pos.z);
    const t = Math.min(1, Math.max(B.gripHeight / rise, B.gripFraction));
    _c.x = p.pos.x + (p.end.x - p.pos.x) * t;
    _c.y = p.pos.y + (p.end.y - p.pos.y) * t;
    _c.z = p.pos.z + (p.end.z - p.pos.z) * t;
    void len;
    cellsNear(sim, _c, out);
  }
  ctx.summitSources = Array.from(new Set(out)).sort((a, b) => a - b);
}

/** The distance field towards the nearest grip point (created on first need), or null if the map has none. */
export function summitField(sim: SimState): DistanceField | null {
  const ctx = fungusCtx(sim);
  if (ctx.summit) return ctx.summit;
  if (ctx.summitSources.length === 0) buildSummitSources(sim, ctx);
  if (ctx.summitSources.length === 0) return null;
  const f = (sim.nav as NavEx).field('b2:summit');
  f.setSources(ctx.summitSources);
  ctx.summit = f;
  return f;
}

// ---- exile spot ---------------------------------------------------------------------------------

/** Where infected ants are banished to: reachable open ground as far from the nest as `exileDistance` allows. */
export function exileCell(sim: SimState, colony: Colony): CellIndex {
  const ctx = fungusCtx(sim);
  const st = ctx.env.colonyState(colony.id);
  if (st.exileCell >= 0 && sim.tick < (ctx.exileAt[colony.id] ?? 0) && sim.nav.isWalkable(st.exileCell)) return st.exileCell;
  ctx.exileAt[colony.id] = sim.tick + 600;
  const B = BALANCE.b2;
  const w = sim.world;
  const nav = sim.nav as NavEx;
  const e = colony.entrances.length && colony.entrances[0] >= 0 ? w.cellCenter(colony.entrances[0], v3()) : v3clone(colony.nestPos);
  let best = -1;
  let bestD = 0;
  const base = Math.atan2(e.z - colony.nestPos.z, e.x - colony.nestPos.x);
  for (const R of [B.exileDistance, B.exileDistance * 0.7, B.exileDistance * 0.45]) {
    for (let i = 0; i < 12; i++) {
      const a = base + (i % 2 ? -1 : 1) * Math.ceil(i / 2) * (Math.PI / 6);
      const x = Math.floor(e.x + Math.cos(a) * R);
      const z = Math.floor(e.z + Math.sin(a) * R);
      if (x < 3 || z < 3 || x >= w.sx - 3 || z >= w.sz - 3) continue;
      const cell = nav.nearestWalkable(x + 0.5, nav.skyHeight(x, z) + 0.5, z + 0.5, 2);
      if (cell < 0 || !nav.isExposed(cell) || nav.homeDistance(colony.id, cell) === HOME_UNREACHABLE) continue;
      if (sim.water.depthAt(cell) > 0.05) continue;
      w.cellCenter(cell, _c);
      const d = Math.hypot(_c.x - colony.nestPos.x, _c.z - colony.nestPos.z) - i * 0.5;
      if (d > bestD) {
        bestD = d;
        best = cell;
      }
    }
    if (best >= 0) break;
  }
  if (best < 0) {
    // no open ground (sealed farm): the midden is as far as it gets
    const midden = colony.chambers.find((c) => c.kind === 'midden');
    best = midden ? midden.cell : -1;
  }
  st.exileCell = best;
  return best;
}

// ---- stage changes --------------------------------------------------------------------------------

function clearJobs(sim: SimState, ant: Ant): void {
  if (ant.carrying) dropCarry(sim, ant);
  // the jobs system drops assignees that no longer hold a task for the job
  ant.tasks.length = 0;
  ant.followId = 0;
  ant.targetId = 0;
}

function addStalk(sim: SimState, ctx: FzCtx, s: FungusStalk): FungusStalk {
  ctx.env.stalks.push(s);
  return s;
}

function stalkOf(ctx: FzCtx, id: number): FungusStalk | undefined {
  const list = ctx.env.stalks;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return undefined;
}

function removeStalk(ctx: FzCtx, id: number): void {
  const list = ctx.env.stalks;
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) list.splice(i, 1);
  for (const set of ctx.seen) set?.delete(id);
}

function placeStalk(s: FungusStalk, pos: Vec3, up: Vec3, forward: Vec3 | null): void {
  // grows from the head, bending towards the sky
  s.pos.x = pos.x + (forward ? forward.x * 0.25 : 0) + up.x * 0.15;
  s.pos.y = pos.y + (forward ? forward.y * 0.25 : 0) + up.y * 0.15;
  s.pos.z = pos.z + (forward ? forward.z * 0.25 : 0) + up.z * 0.15;
  const ux = up.x * 0.6;
  const uy = up.y * 0.6 + 0.6;
  const uz = up.z * 0.6;
  const l = Math.hypot(ux, uy, uz) || 1;
  s.up.x = ux / l;
  s.up.y = uy / l;
  s.up.z = uz / l;
}

/** Turn an ant into a death-gripped body (static, attackable, never ages). */
function grip(sim: SimState, ctx: FzCtx, ant: Ant, native = false): FungusStalk {
  const B = BALANCE.b2;
  clearJobs(sim, ant);
  ant.locomotion = 'static';
  ant.intent.mode = 'none';
  ant.anim = 'grip';
  ant.lifespan = Infinity;
  ant.maxHealth = B.stalkHealth;
  ant.health = B.stalkHealth;
  ant.mem[FZ_DRAG] = 0;
  let s = stalkOf(ctx, ant.id);
  if (!s) {
    s = addStalk(sim, ctx, { id: ant.id, hostId: ant.id, itemId: 0, colony: ant.colony, pos: v3(), up: v3(0, 1, 0), stage: 'gripped', growth: 0, bursts: 0, nextBurstTick: 0, radius: B.burstRadius, native });
    ctx.env.fungusStats.grips++;
  }
  placeStalk(s, ant.pos, ant.up, ant.forward);
  return s;
}

/**
 * Move an ant to an infection stage with all side effects (events, alerts, job release, stalk
 * bookkeeping). Used by the natural progression, `debugInfect` and tests.
 */
export function setStage(sim: SimState, ant: Ant, stage: InfectionStage): void {
  const ctx = fungusCtx(sim);
  const env = ctx.env;
  const inf = ant.infection;
  const from = inf.stage;
  if (from === stage) return;
  const wasSick = from !== 'none' && from !== 'exposed';
  inf.stage = stage;
  inf.timer = 0;
  const player = ant.colony === sim.playerColony;
  switch (stage) {
    case 'none':
      inf.load = 0;
      if (wasSick) env.fungusStats.cures++;
      forget(sim, ctx, ant);
      ant.mem[FZ_NOISE] = 0;
      ant.mem[FZ_DRAG] = 0;
      ant.mem[FZ_EXILE] = 0;
      break;
    case 'exposed':
      break;
    case 'incubating':
      inf.load = 1;
      if (!wasSick) env.fungusStats.infections++;
      break;
    case 'erratic':
      if (!wasSick) env.fungusStats.infections++;
      if (!ant.possessed) clearJobs(sim, ant);
      ant.thinkAt = sim.tick;
      discover(sim, ctx, ant);
      if (player) alertB2(sim, 'fz.err.' + ant.id, 'infectionSpotted', ant.colony, 'A worker is behaving strangely…', ant.pos, ant.id, 600);
      break;
    case 'summit':
      if (!wasSick) env.fungusStats.infections++;
      if (!ant.possessed) clearJobs(sim, ant);
      ant.thinkAt = sim.tick;
      ant.mem['fz.sc'] = 0;
      discover(sim, ctx, ant);
      if (player) alertB2(sim, 'fz.sum.' + ant.id, 'infectionSpotted', ant.colony, 'An infected ant is climbing — it is looking for a place to die', ant.pos, ant.id, 600);
      break;
    case 'gripped':
    case 'fruiting':
    case 'burst': {
      if (!wasSick) env.fungusStats.infections++;
      const s = grip(sim, ctx, ant, !!ant.mem['fz.native']);
      s.stage = stage;
      s.growth = stage === 'gripped' ? 0 : stage === 'fruiting' ? s.growth : 1;
      if (stage === 'burst' && s.nextBurstTick === 0) s.nextBurstTick = sim.tick + 150;
      discover(sim, ctx, ant);
      if (player && stage === 'gripped') alertB2(sim, 'fz.grip.' + ant.id, 'infectionSpotted', ant.colony, 'Death grip — a fungus will sprout from the corpse. Destroy it before it sporulates', ant.pos, ant.id, 600);
      if (player && stage === 'burst') alertB2(sim, 'fz.burst.' + ant.id, 'infectionSpotted', ant.colony, 'A fruiting corpse is raining spores', ant.pos, ant.id, 600);
      break;
    }
  }
  sim.emit({ type: 'infectionStage', tick: sim.tick, id: ant.id, stage, pos: v3clone(ant.pos) });
}

function discover(sim: SimState, ctx: FzCtx, ant: Ant): void {
  if (ctx.env.known.has(ant.id)) return;
  ctx.env.known.add(ant.id);
  if (ant.colony > 0) ctx.env.colonyState(ant.colony).knownInfected.push(ant.id);
}

function forget(sim: SimState, ctx: FzCtx, ant: Ant): void {
  ctx.env.known.delete(ant.id);
  if (ant.colony > 0) {
    const list = ctx.env.colonyState(ant.colony).knownInfected;
    const i = list.indexOf(ant.id);
    if (i >= 0) list.splice(i, 1);
  }
  ctx.targets[ant.colony]?.delete(ant.id);
  ctx.claims.delete(ant.id);
}

/** Cure an early-stage infection (grooming). */
export function cure(sim: SimState, ant: Ant): void {
  setStage(sim, ant, 'none');
}

// ---- hygiene target list (read by behaviors/hygiene.ts) --------------------------------------------

export function hygieneTargets(sim: SimState, colony: number): Map<EntityId, number> | undefined {
  return fungusCtx(sim).targets[colony];
}

export function markExiled(sim: SimState, victim: Ant, cell: CellIndex): void {
  const ctx = fungusCtx(sim);
  victim.mem[FZ_EXILE] = 1;
  victim.mem[FZ_DRAG] = 0;
  victim.mem['fz.ex'] = cell;
  victim.mem['exiled'] = 1;
  ctx.targets[victim.colony]?.delete(victim.id);
  ctx.claims.delete(victim.id);
  ctx.env.fungusStats.exiles++;
  if (victim.colony === sim.playerColony) alertB2(sim, 'fz.exile', 'infectionSpotted', victim.colony, 'Workers dragged an infected nestmate out of the nest', victim.pos, victim.id, 20);
}

// ---- spores ----------------------------------------------------------------------------------------

/**
 * Dust ants around `pos`. `rain` = spores falling from a height (cone widening downwards, only
 * ants open to the sky or very close are reached when `sheltered` is respected); otherwise a
 * plain sphere. Returns the number of ants dosed.
 */
function doseArea(sim: SimState, pos: Vec3, radius: number, dose: number, respectShelter: boolean, rain: boolean): number {
  const B = BALANCE.b2;
  const nav = sim.nav as NavEx;
  let n = 0;
  const ants = sim.ants;
  for (let i = 0; i < ants.length; i++) {
    const a = ants[i];
    if (!a.alive || a.caste === 'queen' || a.caste === 'king') continue;
    const st = a.infection.stage;
    if (st !== 'none' && st !== 'exposed') continue;
    const dx = a.pos.x - pos.x;
    const dz = a.pos.z - pos.z;
    const dy = pos.y - a.pos.y;
    let k: number;
    if (rain) {
      if (dy < -1.5 || dy > 40) continue;
      const r = radius + Math.min(radius, Math.max(0, dy) * B.burstSpread);
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (respectShelter && !(a.cell >= 0 && nav.isExposed(a.cell)) && d2 + dy * dy > 9) continue;
      k = 1 - d2 / (r * r);
    } else {
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius) continue;
      if (respectShelter && !(a.cell >= 0 && nav.isExposed(a.cell)) && d2 > 9) continue;
      k = 1 - d2 / (radius * radius);
    }
    addLoad(sim, a, dose * (0.35 + 0.65 * k));
    n++;
  }
  return n;
}

/** Add spore load to one ant (→ `exposed`, and `incubating` once the load reaches 1). */
export function addLoad(sim: SimState, a: Ant, amount: number): void {
  const st = a.infection.stage;
  if (st !== 'none' && st !== 'exposed') return;
  a.infection.load += amount;
  if (a.infection.load >= 1) setStage(sim, a, 'incubating');
  else if (st === 'none' && a.infection.load >= 0.04) setStage(sim, a, 'exposed'); // (a trace is not worth an event)
}

function burst(sim: SimState, ctx: FzCtx, s: FungusStalk, ground: boolean): void {
  const B = BALANCE.b2;
  _c.x = s.pos.x + s.up.x * 1.1;
  _c.y = s.pos.y + s.up.y * 1.1;
  _c.z = s.pos.z + s.up.z * 1.1;
  s.bursts++;
  ctx.env.fungusStats.bursts++;
  sim.emit({ type: 'sporeBurst', tick: sim.tick, pos: v3clone(_c), radius: s.radius });
  ctx.env.sporeClouds.push({ pos: v3clone(_c), radius: s.radius, bornTick: sim.tick, untilTick: sim.tick + Math.round(B.cloudLinger * 30) });
  doseArea(sim, _c, s.radius, B.burstDose, !ground, !ground);
}

/** `avoid` scent under a stalk for every colony that has seen it and keeps up its hygiene. */
function markAvoid(sim: SimState, ctx: FzCtx, s: FungusStalk): void {
  const B = BALANCE.b2;
  const nav = sim.nav as NavEx;
  const w = sim.world;
  for (const colony of sim.colonies) {
    if (!colony.alive || !(colony.priorities.exile > 0) || !ctx.seen[colony.id]?.has(s.id)) continue;
    const R = Math.ceil(s.radius);
    for (let dz = -R; dz <= R; dz += 2)
      for (let dx = -R; dx <= R; dx += 2) {
        if (dx * dx + dz * dz > R * R) continue;
        const x = Math.floor(s.pos.x) + dx;
        const z = Math.floor(s.pos.z) + dz;
        if (x < 0 || z < 0 || x >= w.sx || z >= w.sz) continue;
        const y = nav.skyHeight(x, z);
        if (y >= w.sy || y > s.pos.y + 1) continue;
        const cell = w.index(x, y, z);
        if (nav.isWalkable(cell)) sim.pheromones.deposit(colony.id, Phero.avoid, cell, B.avoidDeposit);
      }
  }
}

// ---- per-tick pieces ---------------------------------------------------------------------------------

function findFreshCorpse(sim: SimState, ant: Ant): Item | null {
  const items = sim.items;
  for (let i = items.length - 1; i >= 0 && i >= items.length - 64; i--) {
    const it = items[i];
    if (it.bornTick !== sim.tick) break;
    if (it.itemKind === 'corpse' && it.alive && Math.hypot(it.pos.x - ant.pos.x, it.pos.y - ant.pos.y, it.pos.z - ant.pos.z) < 2.5) return it;
  }
  return null;
}

function onDeath(sim: SimState, ctx: FzCtx, ant: Ant): void {
  const st = ant.infection.stage;
  if (st === 'none') return;
  forget(sim, ctx, ant);
  if (st === 'exposed' || isStalkStage(st)) {
    // dusted but not infected, or a chewed-down fruiting body: the remains are sterile
    const corpse = findFreshCorpse(sim, ant);
    if (corpse) corpse.infected = false;
    if (isStalkStage(st)) {
      removeStalk(ctx, ant.id);
      ctx.env.fungusStats.destroyed++;
      if (ant.colony === sim.playerColony || ctx.seen[sim.playerColony]?.has(ant.id)) alertB2(sim, 'fz.destroyed', 'info', sim.playerColony, 'A fruiting corpse was destroyed', ant.pos, 0, 5);
    }
  } else ctx.env.fungusStats.deaths++;
}

function elevated(sim: SimState, ant: Ant): boolean {
  if (ant.cell < 0 || ant.falling) return false;
  if (ant.up.y < 0.75) return true;
  const nav = sim.nav as NavEx;
  if (!nav.isExposed(ant.cell)) return false;
  // standing on top of something that rises above the ground around it
  let lo = Infinity;
  const x = Math.floor(ant.pos.x);
  const z = Math.floor(ant.pos.z);
  for (let dz = -3; dz <= 3; dz += 3) for (let dx = -3; dx <= 3; dx += 3) lo = Math.min(lo, nav.skyHeight(x + dx, z + dz));
  return ant.pos.y - lo > 2.5;
}

function progress(sim: SimState, ctx: FzCtx, a: Ant, dt: number): void {
  const B = BALANCE.b2;
  const inf = a.infection;
  switch (inf.stage) {
    case 'exposed': {
      const social = a.cell >= 0 && !(sim.nav as NavEx).isExposed(a.cell) ? B.loadDecaySocial : 1;
      inf.load -= B.loadDecay * social * dt;
      if (inf.load <= 0.01) setStage(sim, a, 'none');
      return;
    }
    case 'incubating':
      inf.timer++;
      if (inf.timer >= incubationTicks(a)) setStage(sim, a, 'erratic');
      return;
    case 'erratic':
      inf.timer++;
      if (inf.timer >= erraticTicks(a)) setStage(sim, a, 'summit');
      return;
    case 'summit': {
      inf.timer++;
      const f = ctx.summit ?? summitField(sim);
      if (f && f.ready && a.cell >= 0 && !a.falling && f.distance(a.cell) <= 1 && inf.timer > 30) {
        setStage(sim, a, 'gripped');
        return;
      }
      if (inf.timer >= B.summitMax * 30) {
        if (elevated(sim, a)) setStage(sim, a, 'gripped');
        else sim.killAnt(a, 'fungus'); // never made it up: an infected corpse where it fell
      }
      return;
    }
    case 'gripped':
    case 'fruiting':
    case 'burst': {
      inf.timer++;
      a.energy = 1;
      a.hydration = 1;
      a.intent.mode = 'none';
      let s = stalkOf(ctx, a.id);
      if (!s) s = grip(sim, ctx, a, !!a.mem['fz.native']);
      s.stage = inf.stage;
      if (a.falling || sim.tick % 30 === 0) placeStalk(s, a.pos, a.up, a.forward);
      if (inf.stage === 'gripped') {
        if (inf.timer >= B.gripTime * 30) setStage(sim, a, 'fruiting');
      } else if (inf.stage === 'fruiting') {
        s.growth = Math.min(1, inf.timer / (B.fruitTime * 30));
        if (s.growth >= 1) setStage(sim, a, 'burst');
      } else {
        s.growth = 1;
        if (sim.tick >= s.nextBurstTick) {
          burst(sim, ctx, s, false);
          s.nextBurstTick = sim.tick + Math.round((s.native ? B.nativeBurstEvery : B.burstEvery) * 30);
        }
        if (!s.native && inf.timer >= B.sporulateTime * 30) {
          // spent: the husk crumbles
          removeStalk(ctx, a.id);
          forget(sim, ctx, a);
          inf.stage = 'none';
          sim.killAnt(a, 'fungus', false);
        }
      }
      return;
    }
    default:
      return;
  }
}

function corpses(sim: SimState, ctx: FzCtx): void {
  const B = BALANCE.b2;
  const step = 15;
  const nav = sim.nav as NavEx;
  for (const it of sim.items) {
    if (!it.alive || it.itemKind !== 'corpse' || !it.infected) continue;
    let rec = ctx.corpses.get(it.id);
    if (!rec) {
      rec = { timer: 0, dosed: 0, alerted: false, spent: 0 };
      ctx.corpses.set(it.id, rec);
    }
    const colony = it.colony > 0 ? sim.getColony(it.colony) : undefined;
    const stalk = stalkOf(ctx, it.id);
    if (it.carriedBy) {
      // disturbed: a carried body cannot fruit; the carrier gets dusted once
      if (rec.dosed !== it.carriedBy) {
        rec.dosed = it.carriedBy;
        const carrier = sim.getAnt(it.carriedBy);
        if (carrier) addLoad(sim, carrier, stalk ? 0.5 : B.corpseDose);
      }
      if (stalk) {
        removeStalk(ctx, it.id);
        ctx.env.fungusStats.destroyed++;
        rec.timer = B.corpseFruit * 30 * 0.4;
        rec.spent = 0;
      }
      continue;
    }
    // hygienic colonies smell an infected body at once (no waiting for the usual death signal)
    if (colony && colony.priorities.exile > 0) {
      const early = sim.tick - Math.round(BALANCE.a2b.corpseDelay * 30);
      if (it.bornTick > early) it.bornTick = early;
    }
    const inMidden = !!colony && !!chamberAt(colony, 'midden', it.pos, 0.5);
    rec.timer += step * (inMidden ? B.middenSlow : 1);
    if (colony && !rec.alerted && rec.timer > 20 * 30 && colony.id === sim.playerColony && it.cell >= 0 && !nav.isExposed(it.cell)) {
      rec.alerted = true;
      alertB2(sim, 'fz.corpse', 'infectionSpotted', colony.id, 'An infected corpse lies inside the nest — get it out before it fruits', it.pos, it.id, 30);
    }
    if (rec.timer < B.corpseFruit * 30) continue;
    let s = stalk;
    if (!s) {
      s = addStalk(sim, ctx, { id: it.id, hostId: 0, itemId: it.id, colony: it.colony, pos: v3(), up: v3(0, 1, 0), stage: 'fruiting', growth: 0, bursts: 0, nextBurstTick: 0, radius: B.groundBurstRadius, native: false });
      if (colony && colony.id === sim.playerColony) alertB2(sim, 'fz.cfruit', 'infectionSpotted', colony.id, 'A corpse is sprouting a fungus', it.pos, it.id, 30);
    }
    placeStalk(s, it.pos, it.up, null);
    const grow = B.fruitTime * 30 * 0.6;
    const over = rec.timer - B.corpseFruit * 30;
    if (over < grow) {
      s.stage = 'fruiting';
      s.growth = over / grow;
    } else {
      s.stage = 'burst';
      s.growth = 1;
      rec.spent += step;
      if (s.nextBurstTick === 0) s.nextBurstTick = sim.tick + 90;
      if (sim.tick >= s.nextBurstTick) {
        burst(sim, ctx, s, true);
        s.nextBurstTick = sim.tick + Math.round(B.burstEvery * 30);
      }
      if (rec.spent >= B.sporulateTime * 30 * 0.6) {
        removeStalk(ctx, it.id);
        ctx.corpses.delete(it.id);
        sim.remove(it);
      }
    }
  }
  // forget records of bodies that are gone (decayed, eaten)
  for (const id of ctx.corpses.keys()) {
    const e = sim.getEntity(id);
    if (!e || e.kind !== 'item' || !e.infected) {
      ctx.corpses.delete(id);
      if (stalkOf(ctx, id)) {
        removeStalk(ctx, id);
        ctx.env.fungusStats.destroyed++;
      }
    }
  }
}

/** Smell detection (2 Hz): healthy nestmates close to a late-incubation / erratic ant. */
function detect(sim: SimState, ctx: FzCtx): void {
  const B = BALANCE.b2;
  for (const a of sim.ants) {
    if (!a.alive || a.colony <= 0 || !smellable(a) || a.mem[FZ_EXILE] || a.mem['exiled']) continue;
    const colony = sim.getColony(a.colony);
    if (!colony) continue;
    const p = colony.priorities.exile;
    if (!(p > 0)) continue;
    const targets = (ctx.targets[a.colony] ??= new Map());
    const want = a.infection.stage === 'erratic' ? EXILE : GROOM;
    const have = targets.get(a.id);
    if (have !== undefined) {
      if (have === GROOM && want === EXILE) targets.set(a.id, EXILE);
      continue;
    }
    sim.spatial.queryMovers(a.pos.x, a.pos.y, a.pos.z, B.smellRadius, _movers);
    const chance = Math.min(1, B.smellChance * p * (want === EXILE ? B.smellErraticMul : 1));
    for (const m of _movers) {
      const n = m as Ant;
      if (n.kind !== 'ant' || !n.alive || n.id === a.id || n.colony !== a.colony || n.caste === 'queen') continue;
      if (n.infection.stage !== 'none' && n.infection.stage !== 'exposed') continue;
      if (!ctx.rng.chance(chance)) continue;
      targets.set(a.id, want);
      const fresh = !ctx.env.known.has(a.id);
      discover(sim, ctx, a);
      if (fresh && a.colony === sim.playerColony) alertB2(sim, 'fz.smell.' + a.id, 'infectionSpotted', a.colony, 'Nestmates smell sickness on a worker', a.pos, a.id, 600);
      break;
    }
  }
  // drop targets that no longer apply
  for (const targets of ctx.targets) {
    if (!targets) continue;
    for (const id of targets.keys()) {
      const a = sim.getAnt(id);
      if (!a || !(a.infection.stage === 'incubating' || a.infection.stage === 'erratic') || a.mem[FZ_EXILE]) {
        targets.delete(id);
        ctx.claims.delete(id);
      }
    }
  }
  for (const [id, by] of ctx.claims) {
    const h = sim.getAnt(by);
    if (!h || !h.tasks.some((t) => t.kind === 'exile' && t.source !== 'player' && t.targetId === id)) ctx.claims.delete(id);
  }
}

function sightings(sim: SimState, ctx: FzCtx): void {
  const B = BALANCE.b2;
  for (const s of ctx.env.stalks) {
    sim.spatial.queryMovers(s.pos.x, s.pos.y, s.pos.z, B.stalkSight, _movers);
    for (const m of _movers) {
      const a = m as Ant;
      if (a.kind !== 'ant' || !a.alive || a.colony <= 0 || a.id === s.hostId) continue;
      const set = (ctx.seen[a.colony] ??= new Set());
      if (set.has(s.id)) continue;
      set.add(s.id);
      if (a.colony === sim.playerColony && s.colony !== a.colony) alertB2(sim, 'fz.sight.' + s.id, 'infectionSpotted', a.colony, s.stage === 'burst' ? 'Foragers found a fruiting corpse raining spores — keep the trails away or destroy it' : 'Foragers found a corpse with a fungus growing from it', s.pos, s.hostId, 600);
    }
    // the host colony always knows its own dead
    if (s.colony > 0) (ctx.seen[s.colony] ??= new Set()).add(s.id);
  }
}

function season(sim: SimState, ctx: FzCtx): void {
  const B = BALANCE.b2;
  const env = ctx.env;
  if (env.biome === 'farm' || sim.options.fixture !== 'none' || sim.weather.day < B.seasonDay) return;
  let active = env.stalks.length;
  for (const a of sim.ants) if (a.alive && (a.infection.stage === 'incubating' || a.infection.stage === 'erratic' || a.infection.stage === 'summit')) active++;
  if (active >= B.seasonMaxActive) return;
  const d = sim.director;
  const p = B.seasonChance * (1 + (sim.weather.day - B.seasonDay) * B.seasonPerDay) * (1 + B.seasonHumid * sim.weather.wetness) * (d.enabled ? Math.max(0.25, d.intensity) * (d.stage >= 4 ? 3 : 1) : 1);
  if (!ctx.rng.chance(Math.min(0.9, p))) return;
  // a forager out in the open brushes against spores
  const nav = sim.nav as NavEx;
  const out: Ant[] = [];
  for (const a of sim.ants) if (a.alive && a.colony > 0 && a.caste === 'worker' && a.infection.stage === 'none' && a.cell >= 0 && nav.isExposed(a.cell)) out.push(a);
  if (out.length === 0) return;
  setStage(sim, out[ctx.rng.int(out.length)], 'incubating');
}

function spawnNative(sim: SimState, ctx: FzCtx): void {
  const B = BALANCE.b2;
  if (sim.mapId !== 'forest' || sim.options.fixture !== 'none' || B.nativeStalks <= 0) return;
  const extras = getMapExtras(sim.map);
  if (!extras) return;
  const sites = extras.sites.filter((s) => s.kind === 'summit');
  const colonySpawn = sim.map.spawns.find((s) => s.kind === 'colony');
  // not right on top of the player's nest: prefer sites a fair walk away
  const order = sites
    .map((s, i) => ({ s, i, d: colonySpawn ? Math.hypot(s.pos.x - colonySpawn.pos.x, s.pos.z - colonySpawn.pos.z) : 50 }))
    .filter((e) => e.d > 18)
    .sort((a, b) => a.d - b.d || a.i - b.i);
  for (let k = 0; k < B.nativeStalks && k < order.length; k++) {
    const site = order[k].s;
    const cell = sim.nav.nearestWalkable(site.pos.x, site.pos.y, site.pos.z, 5);
    if (cell < 0) continue;
    const host = sim.spawnAnt(0, 'worker', sim.world.cellCenter(cell, v3()));
    host.mem['fz.native'] = 1;
    setStage(sim, host, 'burst');
    const s = stalkOf(ctx, host.id);
    if (s) s.nextBurstTick = sim.tick + Math.round(B.nativeBurstEvery * 30);
  }
}

export const fungusSystem: SimSystem = {
  id: 'fungus',
  commands: ['debugInfect'],
  init(sim) {
    const ctx = fungusCtx(sim);
    spawnNative(sim, ctx);
  },
  onCommand(sim, cmd) {
    if (cmd.type !== 'debugInfect') return;
    const a = sim.getAnt(cmd.id);
    if (a) setStage(sim, a, cmd.stage ?? 'incubating');
  },
  update(sim, dt) {
    const ctx = fungusCtx(sim);
    const env = ctx.env;
    const B = BALANCE.b2;

    // ---- per-ant progression (and deaths of infected ants this tick) ----
    const ants = sim.ants;
    for (let i = 0; i < ants.length; i++) {
      const a = ants[i];
      const st = a.infection.stage;
      if (st === 'none') continue;
      if (!a.alive) {
        onDeath(sim, ctx, a);
        continue;
      }
      progress(sim, ctx, a, dt);
      if (a.alive) a.mem[FZ_NOISE] = controlNoise(a);
      else onDeath(sim, ctx, a);
    }
    // stalks whose host vanished without us seeing it die (removed by another system)
    if (sim.tick % 30 === 17) {
      for (let i = env.stalks.length - 1; i >= 0; i--) {
        const s = env.stalks[i];
        if (s.hostId && !sim.getAnt(s.hostId)) env.stalks.splice(i, 1);
      }
    }

    if (sim.tick % 15 === 4) {
      corpses(sim, ctx);
      detect(sim, ctx);
      // lingering spore clouds
      const clouds = env.sporeClouds;
      for (let i = clouds.length - 1; i >= 0; i--) {
        const c = clouds[i];
        if (sim.tick >= c.untilTick) clouds.splice(i, 1);
        else if (sim.tick > c.bornTick) doseArea(sim, c.pos, c.radius, B.cloudDose * 0.5, true, true);
      }
    }
    if (sim.tick % 30 === 21 && env.stalks.length > 0) sightings(sim, ctx);
    if (sim.tick % 150 === 33) for (const s of env.stalks) if (s.stage === 'burst') markAvoid(sim, ctx, s);
    if (sim.tick % 1800 === 900) season(sim, ctx);

    // ---- a possessed infected ant fights the player's controls ----
    if (sim.possessedId) {
      const a = sim.getAnt(sim.possessedId);
      if (a) {
        const n = controlNoise(a);
        if (n > 0.01) {
          const t = sim.tick;
          let yaw = 0.09 * Math.sin(t * 0.21 + a.phase * 6.28) + 0.06 * Math.sin(t * 0.53 + a.phase * 17);
          if (hash01(a.id, Math.floor(t / 12), 31) < n * 0.25) yaw += (hash01(a.id, t, 32) - 0.5) * 1.6; // a jerk
          sim.possessInput.yawDelta += yaw * n;
        }
      }
    }
  },
};

/** Infect an ant right now (tests / other streams): straight to `incubating`. */
export function infect(sim: SimState, ant: Ant): void {
  if (ant.infection.stage === 'none' || ant.infection.stage === 'exposed') setStage(sim, ant, 'incubating');
}
