import {
  HOME_UNREACHABLE,
  ISO,
  MATERIALS,
  Mat,
  asSimEvent,
  b3StateOf,
  envOf,
  getMapExtras,
  v3,
  v3clone,
  type Ant,
  type CellIndex,
  type Colony,
  type Job,
  type Mover,
  type NavEx,
  type ShelterTubeState,
  type SimState,
  type SimSystem,
  type TermiteWorksState,
  type Vec3,
} from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste, getSpecies } from '../data/species';
import { syncPrev } from '../entities';
import { alertOnce, getExt } from './colonyState';
import { bumpDemand, closeJob, countWorkers, postJob, sunAt, sunIsUp } from './keeperEnv';
import { orthonormalizeForward, snapToSurface } from './movementCrawl';

/**
 * TERMITE WORKS — everything `eatsWood`, `canFill` and `sunSensitive` mean (PLAN §2). All of it
 * is gated by capability flags, so an AI colony of the species behaves the same.
 *
 * eatsWood
 *  - Foraging is tunnelling: the system keeps a few dig designations ("wood faces") on the
 *    nearest reachable Wood / LeafLitter voxels. The ordinary dig duty executes them; A2a's dig
 *    system credits the pulp to `stores.wood` as it is carved. The spoil pellet is not carried
 *    out — termites swallow it: every pellet a `canFill` ant holds is turned into `stores.mud`.
 *  - Gut symbionts digest `stores.wood` into `stores.food` at a rate set by the number of
 *    workers; from there the normal food economy (pantry, brood, queen) runs unchanged.
 *  - In daylight only faces that can be worked under cover are designated; exposed ones wait
 *    for night or rain.
 * sunSensitive
 *  - A termite on a sky-exposed cell in daylight (or under the keeper's lamp) loses health and
 *    hydration (`sunAt`); under cover it slowly recovers. Death cause 'sun'. See behaviors/seekShade.ts.
 * canFill (autonomous works; one operation at a time per colony, posted as a `build` job and
 * carried out by behaviors/build.ts through `workTermiteOp`)
 *  - breach plugs: a nest chamber that suddenly has open sky above it gets a mud plug in its roof
 *  - shelter tubes: along the walking route from the nest entrance to the current wood face,
 *    every sky-exposed stretch is roofed over segment by segment — a ridge of Mud with the
 *    walkway bored through it (two D4 brush stamps: `fill` ridge, `dig` Mud-only bore)
 *  - the mound: spare mud is piled over the nest in a rising spiral, with spires ("chimneys")
 *    on top; done at night / in rain where there is a day
 *  Player build designations are ordinary `build` jobs from the job board; behaviors/build.ts
 *  runs them through A2a's `applyBuildWork` (they consume `stores.mud` too).
 * Start: on outdoor maps with a `deadwood` site the royal chamber is dug under the deadwood and
 * the founding colony moved there (a gallery leads up into the wood, so the first meals are
 * eaten from inside the log).
 *
 * State for render/UI: `b3StateOf(sim).termite[]` (`TermiteWorksState`); events `shelterTube`,
 * `sunburn`, plus the frozen `build` / `dig`.
 */

export interface TermiteOp {
  serial: number;
  kind: 'plug' | 'tube' | 'mound';
  /** Brush centre of the work. */
  pos: Vec3;
  /** Cell to stand on. */
  cell: CellIndex;
  reach: number;
  progress: number;
  work: number;
  mud: number;
  radius: number;
  startedTick: number;
  fails: number;
}

interface TubePlan {
  state: ShelterTubeState;
  pts: Vec3[];
  target: CellIndex;
  /** Covered cell at the start of the open stretch (where the first segment is built from). */
  lead: CellIndex;
}

interface ColonyCtx {
  colony: number;
  /** Edible solid cells sorted by distance from the nest (keys `dist² * N + cell`), and the scan pointer. */
  wood: Float64Array | null;
  woodPtr: number;
  /** Wood designation id → tick it was created. */
  faces: Map<number, number>;
  /** Stand cell of the nearest face found by the last scan (tube target), -1 if none. */
  faceStand: CellIndex;
  /** Final round: stand cell of the nearest wood that can only be reached across open ground (preferred tube target). */
  openStand: CellIndex;
  /** Surface wood cells found to have no reachable stand (skipped until the next rescan). */
  noStand: Set<number>;
  /** Next windfall (twigs / leaf litter dropping near the nest), and the tick of the last full rescan. */
  windfallNext: number;
  /** Where windfall pieces landed (tube targets), newest last. */
  litter: Vec3[];
  zoneI: number;
  slot: { job: Job | null };
  op: TermiteOp | null;
  serial: number;
  tubes: TubePlan[];
  tubeRetry: number;
  tubeServed: CellIndex;
  moundBase: Vec3 | null;
  moundI: number;
  moundNext: number;
  moundSkips: number;
  /** Autonomous operations executed (the mound gets every third turn while tubes are being built). */
  opsDone: number;
  /** Chambers known to be open to the sky by design (never "breached"). */
  openChambers: Set<number>;
  /** Breached chambers whose shaft cannot be plugged without cutting the colony off: next re-check tick. */
  breachWait: Map<number, number>;
  seenChambers: Set<number>;
  state: TermiteWorksState;
}

interface Ctx {
  colonies: Map<number, ColonyCtx>;
}

const ctxs = new WeakMap<SimState, Ctx>();
const _p = v3();
const _q = v3();
const _s = v3();
const _occ: Mover[] = [];

function ctxOf(sim: SimState): Ctx {
  let c = ctxs.get(sim);
  if (!c) ctxs.set(sim, (c = { colonies: new Map() }));
  return c;
}

function colonyCtx(sim: SimState, colony: Colony): ColonyCtx {
  const ctx = ctxOf(sim);
  let cc = ctx.colonies.get(colony.id);
  if (!cc) {
    const state: TermiteWorksState = { colony: colony.id, tubes: [], mound: { pos: v3clone(colony.nestPos), height: 0, stamps: 0, chimneys: 0 }, breaches: [], woodFaces: [], scorched: 0 };
    cc = { colony: colony.id, wood: null, woodPtr: 0, faces: new Map(), faceStand: -1, openStand: -1, noStand: new Set(), windfallNext: 0, litter: [], zoneI: 0, slot: { job: null }, op: null, serial: 0, tubes: [], tubeRetry: 0, tubeServed: -1, moundBase: null, moundI: 0, moundNext: 0, moundSkips: 0, opsDone: 0, openChambers: new Set(), breachWait: new Map(), seenChambers: new Set(), state };
    ctx.colonies.set(colony.id, cc);
    if (getSpecies(colony.species).caps.canFill) {
      b3StateOf(sim).termite.push(state);
      colony.stores.mud += BALANCE.b3.termites.startMud;
    }
  }
  return cc;
}

/** Current autonomous build operation of a colony (behaviors/build.ts). */
export function termiteOpOf(sim: SimState, colonyId: number): TermiteOp | null {
  return ctxOf(sim).colonies.get(colonyId)?.op ?? null;
}

/**
 * Final round — sheeting: the head of a finished shelter tube. Termites plaster the wood there
 * with mud sheeting and eat under it, so within `sheetRadius` of the head they count as under
 * cover (no scorching, no flight from the sun) and wood there may be worked by day.
 */
function sheetedAt(sim: SimState, cc: ColonyCtx, x: number, y: number, z: number): boolean {
  const R = BALANCE.b3.termites.sheetRadius;
  for (const t of cc.tubes) {
    if (t.state.built < t.pts.length) continue;
    sim.world.cellCenter(t.target, _s);
    if (Math.abs(_s.x - x) < R && Math.abs(_s.z - z) < R && Math.hypot(_s.x - x, _s.y - y, _s.z - z) < R) return true;
  }
  return false;
}

export function termiteSheeted(sim: SimState, ant: Ant): boolean {
  const cc = ctxOf(sim).colonies.get(ant.colony);
  return !!cc && cc.tubes.length > 0 && sheetedAt(sim, cc, ant.pos.x, ant.pos.y, ant.pos.z);
}

/** By day: put a face on the best wood under a tube head's sheeting (one tube per pass). */
function planSheetFace(sim: SimState, colony: Colony, cc: ColonyCtx): void {
  const T = BALANCE.b3.termites;
  const w = sim.world;
  const n = cc.tubes.length;
  for (let q = 0; q < n; q++) {
    const t = cc.tubes[(cc.zoneI + q) % n];
    if (t.state.built < t.pts.length) continue;
    cc.zoneI = (cc.zoneI + q + 1) % n;
    w.cellCenter(t.target, _s);
    const R = Math.floor(T.sheetRadius) - 1;
    const cx = Math.floor(_s.x);
    const cy = Math.floor(_s.y);
    const cz = Math.floor(_s.z);
    let best = -1;
    let bestN = T.faceMinCells - 1;
    let bx = 0;
    let by = 0;
    let bz = 0;
    for (let dy = -3; dy <= 4; dy++)
      for (let dz = -R; dz <= R; dz += 2)
        for (let dx = -R; dx <= R; dx += 2) {
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          if (!w.inBounds(x, y, z)) continue;
          const c = w.index(x, y, z);
          if (w.density[c] < ISO || !MATERIALS[w.material[c]].edibleByTermites || cc.noStand.has(c)) continue;
          const e = edibleAround(w, x, y, z, T.woodBrush);
          if (e <= bestN) continue;
          let clash = false;
          for (const d of colony.designations) if (Math.hypot(d.center.x - (x + 0.5), d.center.y - (y + 0.5), d.center.z - (z + 0.5)) < d.radius + T.woodBrush * 0.6) clash = true;
          if (clash) continue;
          if (standNear(sim, colony.id, x, y, z, 2.6) < 0) continue;
          best = c;
          bestN = e;
          bx = x;
          by = y;
          bz = z;
        }
    if (best < 0) continue;
    const d = { id: sim.nextId(), kind: 'dig' as const, colony: colony.id, center: v3(bx + 0.5, by + 0.5, bz + 0.5), radius: T.woodBrush, material: Mat.Air, done: false };
    colony.designations.push(d);
    cc.faces.set(d.id, sim.tick);
    cc.state.woodFaces.push(v3clone(d.center));
    sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'add', designation: d });
    return;
  }
}

/** Tests / debug: planner internals of a colony's works. */
export function termiteDebug(sim: SimState, colonyId: number) {
  const cc = ctxOf(sim).colonies.get(colonyId);
  return cc ? { moundI: cc.moundI, moundBase: cc.moundBase, moundNext: cc.moundNext, moundSkips: cc.moundSkips, op: cc.op?.kind ?? '', opAge: cc.op ? sim.tick - cc.op.startedTick : 0, opFails: cc.op?.fails ?? 0, openStand: cc.openStand, noStand: cc.noStand.size } : null;
}

// ---- wood faces (eatsWood) -----------------------------------------------------------------------

function scanWood(sim: SimState, colony: Colony): Float64Array {
  const w = sim.world;
  const N = w.sx * w.sy * w.sz;
  const den = w.density;
  const mat = w.material;
  const keys: number[] = [];
  const nx = colony.nestPos.x;
  const ny = colony.nestPos.y;
  const nz = colony.nestPos.z;
  let i = 0;
  for (let y = 0; y < w.sy; y++)
    for (let z = 0; z < w.sz; z++)
      for (let x = 0; x < w.sx; x++, i++) {
        if (den[i] < ISO || !MATERIALS[mat[i]].edibleByTermites) continue;
        const d2 = (x + 0.5 - nx) ** 2 + (y + 0.5 - ny) ** 2 + (z + 0.5 - nz) ** 2;
        keys.push(Math.floor(d2) * N + i);
      }
  const out = Float64Array.from(keys);
  out.sort();
  return out;
}

/** A reachable cell to stand on within `r` of a cell centre, or -1. Prefers sheltered cells. */
function standNear(sim: SimState, colonyId: number, cx: number, cy: number, cz: number, r: number): CellIndex {
  const w = sim.world;
  const nav = sim.nav as NavEx;
  let best = -1;
  let bestS = Infinity;
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r * r) continue;
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        if (!w.inBounds(x, y, z)) continue;
        const c = w.index(x, y, z);
        if (!nav.isWalkable(c) || nav.homeDistance(colonyId, c) === HOME_UNREACHABLE) continue;
        const s = d2 + (nav.isExposed(c) ? 6 : 0);
        if (s < bestS) {
          bestS = s;
          best = c;
        }
      }
  return best;
}

function removeDesignation(sim: SimState, colony: Colony, id: number): void {
  const i = colony.designations.findIndex((d) => d.id === id);
  if (i < 0) return;
  const [d] = colony.designations.splice(i, 1);
  getExt(sim, colony.id).digBlocked.delete(id);
  sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'remove', designation: d });
}

function planWoodFaces(sim: SimState, colony: Colony, cc: ColonyCtx): void {
  const T = BALANCE.b3.termites;
  const w = sim.world;
  const nav = sim.nav as NavEx;
  const day = sunActive(sim);
  if (!cc.wood) cc.wood = scanWood(sim, colony);
  // retire faces that are finished, stale, or now out in the sun
  cc.state.woodFaces.length = 0;
  for (const [id, born] of cc.faces) {
    const d = colony.designations.find((x) => x.id === id);
    if (!d) {
      cc.faces.delete(id);
      continue;
    }
    const stand = standNear(sim, colony.id, Math.floor(d.center.x), Math.floor(d.center.y), Math.floor(d.center.z), 3);
    const stale = sim.tick - born > 70 * 30;
    if (stale || (day && stand >= 0 && !sheetedAt(sim, cc, d.center.x, d.center.y, d.center.z) && (nav.isExposed(stand) || mostlyOpen(sim, Math.floor(d.center.x), Math.floor(d.center.y), Math.floor(d.center.z)))) || (stand < 0 && sim.tick - born > 20 * 30)) {
      // a face nobody finished in 70 s is a bad one (awkward scrap): leave that spot alone for a while
      if (stale || stand < 0) cc.noStand.add(w.cellAt(d.center.x, d.center.y, d.center.z));
      removeDesignation(sim, colony, id);
      cc.faces.delete(id);
      continue;
    }
    cc.state.woodFaces.push(v3clone(d.center));
  }
  // the skip list is forgotten now and then (the ground changes)
  if (sim.tick % (240 * 30) < 60) cc.noStand.clear();
  const workers = countWorkers(sim, colony);
  const pop = colony.population.total;
  const want = Math.max(1, Math.min(T.woodFacesMax, Math.round(workers * T.woodFacesPerWorker)));
  const stocked = colony.stores.wood * T.foodPerWood + colony.stores.food > T.woodEnoughPerAnt * Math.max(8, pop);
  const wood = cc.wood;
  const N = w.sx * w.sy * w.sz;
  const den = w.density;
  const sxz = w.sx * w.sz;
  // drop the eaten prefix
  while (cc.woodPtr < wood.length) {
    const c = wood[cc.woodPtr] % N;
    if (den[c] >= ISO && MATERIALS[w.material[c]].edibleByTermites) break;
    cc.woodPtr++;
  }
  if (!stocked && cc.faces.size < want && cc.tubes.length > 0) planSheetFace(sim, colony, cc);
  let checked = 0;
  let firstStand = -1;
  let openStand = -1;
  for (let k = cc.woodPtr; k < wood.length && checked < 500; k++) {
    const c = wood[k] % N;
    if (den[c] < ISO || !MATERIALS[w.material[c]].edibleByTermites) continue;
    if (cc.noStand.has(c)) continue;
    const y = Math.floor(c / sxz);
    const r = c - y * sxz;
    const z = Math.floor(r / w.sx);
    const x = r - z * w.sx;
    // surface wood only: one of the six neighbours is open
    if (
      !(
        (x > 0 && den[c - 1] < ISO) ||
        (x < w.sx - 1 && den[c + 1] < ISO) ||
        (z > 0 && den[c - w.sx] < ISO) ||
        (z < w.sz - 1 && den[c + w.sx] < ISO) ||
        (y > 0 && den[c - sxz] < ISO) ||
        (y < w.sy - 1 && den[c + sxz] < ISO)
      )
    )
      continue;
    checked++;
    const stand = standNear(sim, colony.id, x, y, z, 2.3);
    if (stand < 0) {
      // unreachable for now (top of a log, a scrap in mid-air): do not let it use up the scan
      // budget every time — the search has to be able to move on to wood further out
      cc.noStand.add(c);
      continue;
    }
    if (firstStand < 0) firstStand = stand;
    const open = nav.isExposed(stand);
    if (open && openStand < 0) openStand = stand;
    if (stocked || cc.faces.size >= want) {
      if (openStand >= 0 || checked > 120) break;
      continue;
    }
    if (day && (open || mostlyOpen(sim, x, y, z)) && !sheetedAt(sim, cc, x, y, z)) continue;
    // a face must be worth the walk: scraps of a few voxels kept eighteen diggers commuting
    if (edibleAround(w, x, y, z, T.woodBrush) < T.faceMinCells) {
      cc.noStand.add(c);
      continue;
    }
    let clash = false;
    for (const d of colony.designations) if (Math.hypot(d.center.x - (x + 0.5), d.center.y - (y + 0.5), d.center.z - (z + 0.5)) < d.radius + T.woodBrush * 0.6) clash = true;
    if (clash) continue;
    const d = { id: sim.nextId(), kind: 'dig' as const, colony: colony.id, center: v3(x + 0.5, y + 0.5, z + 0.5), radius: T.woodBrush, material: Mat.Air, done: false };
    colony.designations.push(d);
    cc.faces.set(d.id, sim.tick);
    cc.state.woodFaces.push(v3clone(d.center));
    sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'add', designation: d });
  }
  cc.faceStand = firstStand;
  // a fallen piece out in the open is the first choice of tube target
  for (let i = cc.litter.length - 1; i >= 0; i--) {
    const p = cc.litter[i];
    if (edibleAround(w, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 2.5) < 6) {
      cc.litter.splice(i, 1); // eaten
      continue;
    }
    let served = false;
    for (const t of cc.tubes) {
      w.cellCenter(t.target, _s);
      if (Math.hypot(_s.x - p.x, _s.z - p.z) < T.sheetRadius) served = true;
    }
    if (served) continue;
    const stand = standNear(sim, colony.id, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 3.2);
    if (stand >= 0 && nav.isExposed(stand)) {
      w.cellCenter(stand, _s);
      const dn = Math.hypot(_s.x - colony.nestPos.x, _s.z - colony.nestPos.z);
      if (openStand >= 0) {
        w.cellCenter(openStand, _q);
        if (Math.hypot(_q.x - colony.nestPos.x, _q.z - colony.nestPos.z) <= dn) continue;
      }
      openStand = stand;
    }
  }
  cc.openStand = openStand;
}

/**
 * Final round — windfall: twigs and leaf litter keep dropping onto the ground around a
 * wood-eating colony (outdoor maps only). The founding log is finite (~2,600 voxels on the
 * meadow); without this a termite colony ate it in half an hour and starved. The pieces land in
 * the open, 10–36 voxels out, so reaching them by day takes a shelter tube.
 */
/** Would a piece dropped at (x, z) land on a nest entrance, a shelter tube or the mound? */
function blocksTraffic(sim: SimState, cc: ColonyCtx, x: number, z: number, tubeClear: number): boolean {
  for (const c of sim.colonies) {
    if (Math.hypot(c.nestPos.x - x, c.nestPos.z - z) < 6) return true;
    for (const e of c.entrances) {
      if (e < 0) continue;
      sim.world.cellCenter(e, _p);
      if (Math.hypot(_p.x - x, _p.z - z) < 8) return true;
    }
  }
  for (const t of cc.tubes) for (const p of t.pts) if (Math.hypot(p.x - x, p.z - z) < tubeClear) return true;
  if (cc.moundBase && Math.hypot(cc.moundBase.x - x, cc.moundBase.z - z) < 7) return true;
  return false;
}

function windfall(sim: SimState, colony: Colony, cc: ColonyCtx): void {
  const T = BALANCE.b3.termites;
  if (sim.map.flags.slab || sim.world.boundary !== 'open') return;
  if (cc.windfallNext === 0) {
    cc.windfallNext = sim.tick + Math.round(T.windfallAfter * 30);
    return;
  }
  if (sim.tick < cc.windfallNext) return;
  const w = sim.world;
  const nav = sim.nav as NavEx;
  // more mouths, more litter found worth eating (bounded): the colony ranges further
  const pop = Math.max(20, colony.population.total);
  cc.windfallNext = sim.tick + Math.round((T.windfallEvery * 30) / Math.min(1.6, Math.max(0.6, pop / 90)));
  let made = 0;
  for (let tries = 0; tries < 6 && made < T.windfallPieces; tries++) {
    const a = sim.rng.range(0, Math.PI * 2);
    const r = sim.rng.range(T.windfallMin, T.windfallMax);
    let x = colony.nestPos.x + Math.cos(a) * r;
    let z = colony.nestPos.z + Math.sin(a) * r;
    // half the pieces come down by the head of a finished tube (the colony ranges from there)
    const heads = cc.tubes.filter((t) => t.state.built >= t.pts.length);
    const head = heads.length > 0 && sim.rng.chance(T.windfallAtTube) ? heads[sim.rng.int(heads.length)] : null;
    if (head) {
      w.cellCenter(head.target, _s);
      const last = head.pts[head.pts.length - 1];
      const prev = head.pts[Math.max(0, head.pts.length - 3)];
      // beyond the head, in the direction the tube was going
      const fa = Math.atan2(last.z - prev.z, last.x - prev.x) + sim.rng.range(-1.1, 1.1);
      const fr = sim.rng.range(2.5, T.sheetRadius - 2);
      x = _s.x + Math.cos(fa) * fr;
      z = _s.z + Math.sin(fa) * fr;
    }
    if (x < 6 || z < 6 || x > w.sx - 6 || z > w.sz - 6) continue;
    if (blocksTraffic(sim, cc, x, z, head ? 2.5 : 5)) continue;
    const top = nav.skyHeight(Math.floor(x), Math.floor(z));
    if (top < 2 || top > w.sy - 8) continue;
    // on open ground only (not on top of a plant or the mound), and never in a puddle
    const under = w.index(Math.floor(x), Math.max(0, top - 1), Math.floor(z));
    const m = w.material[under];
    if (m === Mat.Plant || m === Mat.Mud || m === Mat.Rock) continue;
    if (sim.water.depthAt(w.index(Math.floor(x), top, Math.floor(z))) > 0.05) continue;
    const twig = sim.rng.chance(T.windfallTwigChance);
    // a twig is a short row of wood stamps, litter a low heap
    const n = twig ? 3 : 2;
    const dirA = sim.rng.range(0, Math.PI);
    let added = 0;
    for (let i = 0; i < n; i++) {
      _q.x = x + Math.cos(dirA) * (i - (n - 1) / 2) * 1.6;
      _q.z = z + Math.sin(dirA) * (i - (n - 1) / 2) * 1.6;
      _q.y = nav.skyHeight(Math.floor(_q.x), Math.floor(_q.z)) + (twig ? 0.5 : 0.1);
      const near = sim.spatial.queryMovers(_q.x, _q.y, _q.z, 3.5, _occ);
      added += w.fill(_q, twig ? 1.5 : 1.7, twig ? Mat.Wood : Mat.LeafLitter, {
        isOccupied: (cell) => {
          for (let k = 0; k < near.length; k++) if (w.cellAt(near[k].pos.x, near[k].pos.y, near[k].pos.z) === cell) return true;
          return false;
        },
      }).addedCells;
    }
    if (added > 0) {
      made++;
      cc.litter.push(v3(x, nav.skyHeight(Math.floor(x), Math.floor(z)) - 1, z));
      if (cc.litter.length > 40) cc.litter.shift();
    }
  }
  if (made > 0) {
    // the sorted wood list is stale now: rescan (cheap next to how rarely this runs)
    cc.wood = null;
    cc.woodPtr = 0;
    cc.noStand.clear();
  }
}

/**
 * Is the standing room around a wood cell mostly under the open sky? By day such wood is left
 * alone even when one covered foothold exists: the dig planner picks its own stand cells, and
 * diggers working half in the sun were scorched one retreat at a time.
 */
function mostlyOpen(sim: SimState, cx: number, cy: number, cz: number): boolean {
  const w = sim.world;
  const nav = sim.nav as NavEx;
  let open = 0;
  let all = 0;
  for (let dy = -3; dy <= 3; dy++)
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy + dz * dz > 10 || !w.inBounds(cx + dx, cy + dy, cz + dz)) continue;
        const c = w.index(cx + dx, cy + dy, cz + dz);
        if (!nav.isWalkable(c)) continue;
        all++;
        if (nav.isExposed(c)) open++;
      }
  return all > 0 && open > all * 0.3;
}

/** Edible solid cells inside a brush of radius `r` centred on a cell. */
function edibleAround(w: SimState['world'], cx: number, cy: number, cz: number, r: number): number {
  const R = Math.floor(r);
  let n = 0;
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy + dz * dz > r * r || !w.inBounds(cx + dx, cy + dy, cz + dz)) continue;
        const i = w.index(cx + dx, cy + dy, cz + dz);
        if (w.density[i] >= ISO && MATERIALS[w.material[i]].edibleByTermites) n++;
      }
  return n;
}

/**
 * Does the sun (or the keeper's lamp) currently burn termites anywhere? ONE signal for the damage
 * (`sunAndPellets`), the flight from it (behaviors/seekShade.ts), the day-time choice of wood
 * faces and the corpse run (necrophoresis). They used to disagree: termites were scorched as soon
 * as the sun was up at all (B2 sun > 0.05) but only took cover above `sunSensitiveExposure`
 * (0.35), so at dawn, at dusk and all through an overcast day the colony worked in the open and
 * burned to death without ever fleeing.
 */
export function termiteSunBurns(sim: SimState): boolean {
  const T = BALANCE.b3.termites;
  if (!sunIsUp(sim, T.sunFrom, T.sunTo)) return false;
  if (sim.weather.lamp) return true;
  const env = envOf(sim) as { sun?: number } | null;
  return !env || typeof env.sun !== 'number' || env.sun > BALANCE.b2.sunSensitiveExposure;
}

function sunActive(sim: SimState): boolean {
  return termiteSunBurns(sim);
}

// ---- autonomous works (canFill) ------------------------------------------------------------------

function newOp(cc: ColonyCtx, sim: SimState, kind: TermiteOp['kind'], pos: Vec3, cell: CellIndex, radius: number, mud: number, work: number): TermiteOp {
  return { serial: ++cc.serial, kind, pos: v3clone(pos), cell, reach: radius + 2.2, progress: 0, work, mud, radius, startedTick: sim.tick, fails: 0 };
}

function fillGuarded(sim: SimState, pos: Vec3, radius: number, colonyId?: number): number {
  const w = sim.world;
  // never wall the colony off from itself: a tube arch or a mound stamp that lands in a gallery
  // (the walking route to the wood starts in the royal chamber's climb into the log) would seal it
  if (colonyId !== undefined && plugCuts(sim, colonyId, pos.x, pos.y, pos.z, radius)) return 0;
  const near = sim.spatial.queryMovers(pos.x, pos.y, pos.z, radius + 1.5, _occ);
  const res = w.fill(pos, radius, Mat.Mud, {
    isOccupied: (cell) => {
      for (let k = 0; k < near.length; k++) if (w.cellAt(near[k].pos.x, near[k].pos.y, near[k].pos.z) === cell) return true;
      return false;
    },
  });
  return res.addedCells;
}


/**
 * Is any part of a chamber open to the sky? Checks every column over the chamber's footprint, not
 * just its floor cell: the royal chamber's gallery runs straight up into the deadwood, and once
 * the log above it was eaten through, the sun shone in beside the floor cell (which stayed
 * "covered") — the breach was never seen and the colony burned in its own royal chamber. `out`
 * gets the open column nearest the centre.
 */
function skylight(sim: SimState, pos: Vec3, radius: number, out: Vec3): boolean {
  const nav = sim.nav as NavEx;
  const R = Math.ceil(radius);
  const cx = Math.floor(pos.x);
  const cz = Math.floor(pos.z);
  const roof = pos.y + radius + 0.5;
  let best = Infinity;
  for (let dz = -R; dz <= R; dz++)
    for (let dx = -R; dx <= R; dx++) {
      const d2 = dx * dx + dz * dz;
      if (d2 > radius * radius || d2 >= best) continue;
      if (nav.skyHeight(cx + dx, cz + dz) > roof) continue;
      best = d2;
      out.x = cx + dx + 0.5;
      out.z = cz + dz + 0.5;
    }
  return best < Infinity;
}

/**
 * Would a mud fill (sphere of `brush` at x,y,z) cut nest-connected walkable cells around it off
 * from the nest? Flood fill over walkable cells (26-neighbourhood) avoiding the filled volume, from
 * the cell just outside it that lies nearest home: every other walkable, home-connected cell just
 * outside the fill must still be reached. Conservative — a detour longer than the flood budget
 * counts as cut.
 */
export function plugCuts(sim: SimState, colonyId: number, px: number, py: number, pz: number, brush: number): boolean {
  const nav = sim.nav as NavEx;
  const w = sim.world;
  const inner = brush + 1.6;
  const outer = brush + 3.6;
  const plugged = (x: number, y: number, z: number) => Math.hypot(x + 0.5 - px, y + 0.5 - py, z + 0.5 - pz) < inner;
  const shell: number[] = [];
  const R = Math.ceil(outer);
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(px) + dx;
        const y = Math.floor(py) + dy;
        const z = Math.floor(pz) + dz;
        if (!w.inBounds(x, y, z)) continue;
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py, z + 0.5 - pz);
        if (d < inner || d > outer) continue;
        const c = w.index(x, y, z);
        if (nav.isWalkable(c) && nav.homeDistance(colonyId, c) !== HOME_UNREACHABLE) shell.push(c);
      }
  if (shell.length < 2) return false;
  // flood from the shell cell nearest home (the nest side)
  let from = shell[0];
  for (const c of shell) if (nav.homeDistance(colonyId, c) < nav.homeDistance(colonyId, from)) from = c;
  // flood the walkable graph (no box: the way round may lead out of the nest and back in) until
  // every shell cell is reached, or the budget runs out — then they count as cut off
  const n = w.sx * w.sy * w.sz;
  if (!_seen || _seen.length !== n) _seen = new Uint32Array(n);
  const seen = _seen;
  const mark = ++_seenMark;
  let left = shell.length;
  const want = new Set(shell);
  const q = _flood;
  q.length = 0;
  seen[from] = mark;
  q.push(from);
  if (want.delete(from)) left--;
  const sxz = w.sx * w.sz;
  for (let h = 0; h < q.length && left > 0 && h < PLUG_FLOOD_BUDGET; h++) {
    const c = q[h];
    const cy = (c / sxz) | 0;
    const cz = ((c - cy * sxz) / w.sx) | 0;
    const cx = c - cy * sxz - cz * w.sx;
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          if (!w.inBounds(x, y, z)) continue;
          const k = x + w.sx * (z + w.sz * y);
          if (seen[k] === mark) continue;
          seen[k] = mark;
          if (plugged(x, y, z) || !nav.isWalkable(k)) continue;
          q.push(k);
          if (want.delete(k)) left--;
        }
  }
  return left > 0;
}
let _seen: Uint32Array | null = null;
let _seenMark = 0;
const _flood: number[] = [];
/** Cells a `plugCuts` flood may visit before it gives up and calls the fill a cut. */
const PLUG_FLOOD_BUDGET = 60000;
/** How far up the shaft a breach plug may move to keep from sealing a gallery. */
const PLUG_CLIMB = 14;

function findBreach(sim: SimState, colony: Colony, cc: ColonyCtx): TermiteOp | null {
  const T = BALANCE.b3.termites;
  const nav = sim.nav as NavEx;
  cc.state.breaches.length = 0;
  let op: TermiteOp | null = null;
  for (const ch of colony.chambers) {
    if (ch.kind === 'entrance' || ch.kind === 'midden' || ch.cell < 0) continue;
    const open = skylight(sim, ch.pos, ch.radius, _q);
    if (!cc.seenChambers.has(ch.id)) {
      cc.seenChambers.add(ch.id);
      if (open) cc.openChambers.add(ch.id); // built that way
      continue;
    }
    if (!open) {
      cc.openChambers.delete(ch.id);
      continue;
    }
    if (cc.openChambers.has(ch.id) || sim.tick < (cc.breachWait.get(ch.id) ?? 0)) continue;
    // plug the shaft where the sky comes in: at roof level just above the chamber, or — when the
    // shaft is the colony's gallery (the royal chamber's climb into the deadwood) and a plug
    // there would cut the nest off from everyone above it — higher up, past where the gallery
    // branches off. If every height would cut the colony off, live with the opening for a while
    // (the sun-shy step into the shade; a plug that strands half the colony starves it).
    _p.x = _q.x;
    _p.z = _q.z;
    let y = ch.pos.y + Math.min(ch.radius, 3) + 1.6;
    const top = Math.min(y + PLUG_CLIMB, sim.world.sy - 2);
    while (y < top && plugCuts(sim, colony.id, _q.x, y, _q.z, T.plugBrush)) y += 1;
    if (y >= top) {
      cc.breachWait.set(ch.id, sim.tick + 60 * 30);
      continue;
    }
    _p.y = y;
    cc.state.breaches.push(v3clone(_p));
    if (!op) {
      const stand = standNear(sim, colony.id, Math.floor(_p.x), Math.floor(_p.y), Math.floor(_p.z), 3.4);
      op = newOp(cc, sim, 'plug', _p, stand >= 0 ? stand : ch.cell, T.plugBrush, T.plugMud, 1.2);
      op.reach = T.plugBrush + 3.2;
    }
  }
  return op;
}

function planTube(sim: SimState, colony: Colony, cc: ColonyCtx): void {
  const T = BALANCE.b3.termites;
  const nav = sim.nav as NavEx;
  const w = sim.world;
  if (cc.tubes.length > 0 && !cc.tubes[cc.tubes.length - 1].state.done) return;
  // final round: the tube heads for the nearest wood that lies across OPEN ground (that is the
  // wood the sun keeps the colony from); wood reachable under cover needs none
  const goal = cc.openStand >= 0 ? cc.openStand : cc.faceStand;
  if (cc.tubes.length >= T.tubesMax || sim.tick < cc.tubeRetry || goal < 0) return;
  cc.tubeRetry = sim.tick + 20 * 30;
  for (const t of cc.tubes) {
    w.cellCenter(t.target, _p);
    w.cellCenter(goal, _q);
    if (Math.hypot(_p.x - _q.x, _p.y - _q.y, _p.z - _q.z) < 8) return; // that wood already has its tube
  }
  const from = colony.entrances[0] !== undefined && colony.entrances[0] >= 0 && nav.isWalkable(colony.entrances[0]) ? colony.entrances[0] : colony.nestCell;
  if (from < 0) return;
  const res = nav.findPath(from, goal, 0, 20000);
  if (res.status !== 'found' || res.cells.length < 4 || res.cells.length > T.tubeMaxLength * 2) return;
  w.cellCenter(from, _q);
  const ex = _q.x;
  const ey = _q.y;
  const ez = _q.z;
  const pts: Vec3[] = [];
  let lx = Infinity;
  let ly = 0;
  let lz = 0;
  let lead: CellIndex = from;
  for (let i = 0; i < res.cells.length; i++) {
    const c = res.cells[i];
    if (!nav.isExposed(c)) {
      if (pts.length === 0) lead = c; // last covered cell before the open stretch: the first builder's post
      continue;
    }
    w.cellCenter(c, _p);
    if (Math.hypot(_p.x - ex, _p.y - ey, _p.z - ez) < 4) continue; // never roof over the entrance itself
    if (Math.hypot(_p.x - lx, _p.y - ly, _p.z - lz) < T.tubeSpacing) continue;
    pts.push(v3clone(_p));
    lx = _p.x;
    ly = _p.y;
    lz = _p.z;
    if (pts.length >= T.tubeMaxLength) break;
  }
  cc.tubeServed = goal;
  if (pts.length < 3) return; // the route is already under cover
  const state: ShelterTubeState = { id: sim.nextId(), colony: colony.id, from: v3clone(pts[0]), to: v3clone(pts[pts.length - 1]), segments: pts.length, built: 0, done: false };
  cc.tubes.push({ state, pts, target: goal, lead });
  cc.state.tubes.push(state);
  sim.emit(asSimEvent({ type: 'shelterTube', tick: sim.tick, op: 'started', tube: state.id, colony: colony.id, pos: v3clone(state.from) }));
  alertOnce(sim, colony, 'info', 'Workers are building a shelter tube towards the wood', state.from, 0, 20);
}

function tubeOp(sim: SimState, colony: Colony, cc: ColonyCtx): TermiteOp | null {
  const T = BALANCE.b3.termites;
  const tube = cc.tubes[cc.tubes.length - 1];
  if (!tube || tube.state.done) return null;
  const k = tube.state.built;
  const p = tube.pts[k];
  // Final round: the builder works FROM UNDER COVER — at the mouth of the finished part (the
  // previous segment's roof), or for the first segment at the last covered cell of the route —
  // and roofs the next stretch ahead of itself. That is what lets the tube advance in daylight.
  const nav = sim.nav as NavEx;
  let stand = -1;
  for (let b = k - 1; b >= Math.max(0, k - 3) && stand < 0; b--) {
    const q = tube.pts[b];
    const c = coveredNear(sim, colony.id, q.x, q.y, q.z, 2);
    if (c >= 0) stand = c;
  }
  if (stand < 0 && k <= 2 && tube.lead >= 0 && nav.isWalkable(tube.lead)) {
    sim.world.cellCenter(tube.lead, _q);
    if (Math.hypot(_q.x - p.x, _q.y - p.y, _q.z - p.z) < T.tubeRidge + 4.5) stand = tube.lead;
  }
  const prev = k > 0 ? tube.pts[k - 1] : p;
  if (stand < 0) stand = sim.nav.nearestWalkable(prev.x, prev.y, prev.z, 3);
  if (stand < 0) stand = sim.nav.nearestWalkable(p.x, p.y, p.z, 4);
  if (stand < 0) {
    tube.state.done = true; // the ground changed under the plan
    return null;
  }
  _p.x = p.x;
  _p.y = p.y + 1.6;
  _p.z = p.z;
  const op = newOp(cc, sim, 'tube', _p, stand, T.tubeRidge, T.tubeMudPerSegment, T.tubeWork);
  op.reach = T.tubeRidge + 4.2;
  return op;
}

/** Nearest reachable, sky-covered walkable cell within `r` of a point, or -1. */
function coveredNear(sim: SimState, colonyId: number, px: number, py: number, pz: number, r: number): CellIndex {
  const w = sim.world;
  const nav = sim.nav as NavEx;
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  let best = -1;
  let bestD = Infinity;
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        if (!w.inBounds(cx + dx, cy + dy, cz + dz)) continue;
        const c = w.index(cx + dx, cy + dy, cz + dz);
        if (!nav.isWalkable(c) || nav.isExposed(c) || nav.homeDistance(colonyId, c) === HOME_UNREACHABLE) continue;
        const d = dx * dx + dy * dy * 2 + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
  return best;
}

/** Surface point the mound grows from: above the nest, pushed away from the entrance. */
function moundBase(sim: SimState, colony: Colony): Vec3 | null {
  const w = sim.world;
  const nav = sim.nav as NavEx;
  let x = colony.nestPos.x;
  let z = colony.nestPos.z;
  const e = colony.entrances[0];
  if (e !== undefined && e >= 0) {
    w.cellCenter(e, _p);
    let dx = x - _p.x;
    let dz = z - _p.z;
    const l = Math.hypot(dx, dz);
    if (l < 8) {
      if (l < 0.5) {
        dx = 1;
        dz = 0;
      } else {
        dx /= l;
        dz /= l;
      }
      x = _p.x + dx * 8;
      z = _p.z + dz * 8;
    }
  }
  if (sim.map.flags.slab) {
    if (sim.map.flags.slabAxis === 'z') z = w.sz / 2;
    else x = w.sx / 2;
  }
  x = Math.max(5, Math.min(w.sx - 5, x));
  z = Math.max(sim.map.flags.slab ? 0.5 : 5, Math.min(w.sz - (sim.map.flags.slab ? 0.5 : 5), z));
  // Final round: the site must be ground the builders can actually reach — over the log the
  // spiral never attached and the mound stayed at zero stamps. Try the first guess, then a ring.
  const x0 = x;
  const z0 = z;
  // level ground near the door: within a few voxels of the entrance's own height (not the top
  // of a flower or a log, where the builders took a minute to climb and the stamps timed out)
  let eTop = -1;
  if (e !== undefined && e >= 0) eTop = nav.skyHeight(Math.floor(_p.x), Math.floor(_p.z));
  const ex = _p.x;
  const ez = _p.z;
  for (let k = 0; k < 29; k++) {
    if (k > 0) {
      if (sim.map.flags.slab) break;
      const a = k * 2.39996323;
      const r = 4 + Math.floor((k - 1) / 4) * 3;
      x = Math.max(5, Math.min(w.sx - 5, x0 + Math.cos(a) * r));
      z = Math.max(5, Math.min(w.sz - 5, z0 + Math.sin(a) * r));
    }
    const top = nav.skyHeight(Math.floor(x), Math.floor(z));
    if (top <= colony.nestPos.y + 2 || top >= w.sy - 6) {
      if (k === 0 && sim.map.flags.slab) return null; // sealed farm with no ground above, or no head-room
      continue;
    }
    const under = w.material[w.index(Math.floor(x), Math.max(0, top - 1), Math.floor(z))];
    if (!sim.map.flags.slab) {
      if (MATERIALS[under].edibleByTermites || under === Mat.Plant) continue; // not on the larder
      if (eTop >= 0 && Math.abs(top - eTop) > 4) continue;
      if (eTop >= 0 && Math.hypot(x - ex, z - ez) < 5) continue; // never on the doorstep
    }
    const stand = standNear(sim, colony.id, Math.floor(x), top, Math.floor(z), 3.5);
    if (stand < 0 || nav.homeDistance(colony.id, stand) > 90) continue;
    return v3(x, top, z);
  }
  return null;
}

const CHIMNEY_ANGLES = [0.8, 2.9, 5.0];

function moundOp(sim: SimState, colony: Colony, cc: ColonyCtx): TermiteOp | null {
  const T = BALANCE.b3.termites;
  if (sim.tick < cc.moundNext || colony.stores.mud < T.moundReserve + T.moundMudPerStamp) return null;
  // Final round: the mound grows WITH the colony — it is owed `moundStampsPerAnt` stamps per
  // termite (so it is a real landmark by the time the colony is big) and rests once it has them.
  if (cc.state.mound.stamps >= Math.min(T.moundStampsMax, T.moundStampsBase + colony.population.total * T.moundStampsPerAnt)) {
    cc.moundNext = sim.tick + 20 * 30;
    return null;
  }
  if (!cc.moundBase) {
    cc.moundBase = moundBase(sim, colony);
    if (!cc.moundBase) {
      cc.moundNext = sim.tick + 120 * 30;
      return null;
    }
    cc.state.mound.pos = v3clone(cc.moundBase);
  }
  const base = cc.moundBase;
  const w = sim.world;
  for (let tries = 0; tries < 4; tries++) {
    const i = cc.moundI;
    const level = Math.floor(i / 6);
    const slab = sim.map.flags.slab;
    let x: number;
    let y: number;
    let z: number;
    let brush: number = T.moundBrush;
    if (level >= 2 && i % 6 === 5) {
      // a spire on one of the chimney axes, growing from the top of what is there
      const ci = Math.floor(i / 6) % CHIMNEY_ANGLES.length;
      const a = CHIMNEY_ANGLES[ci];
      x = base.x + Math.cos(a) * 1.6;
      z = slab ? base.z : base.z + Math.sin(a) * 1.6;
      y = (sim.nav as NavEx).skyHeight(Math.floor(x), Math.floor(z)) + 0.4;
      brush = 1.5;
      cc.state.mound.chimneys = Math.min(CHIMNEY_ANGLES.length, Math.max(cc.state.mound.chimneys, ci + 1));
    } else {
      const r = Math.max(0.4, 3.4 - level * 0.55);
      const a = i * 2.39996323;
      x = base.x + Math.cos(a) * r;
      z = slab ? base.z : base.z + Math.sin(a) * r;
      y = base.y + level * 1.1 + 0.3;
    }
    if (y - base.y > T.moundMaxHeight || y + brush > w.sy - 3) {
      cc.moundNext = sim.tick + 600 * 30; // as tall as it gets
      return null;
    }
    _p.x = x;
    _p.y = y;
    _p.z = z;
    // attach to what is there: skip stamps that would float
    const stand = w.sample(x, y, z) > -2.4 ? standNear(sim, colony.id, Math.floor(x), Math.floor(y), Math.floor(z), 3.5) : -1;
    if (stand < 0) {
      cc.moundI++;
      if (++cc.moundSkips > 14) {
        // nothing attaches here any more: look for a better site and start a fresh spiral
        cc.moundSkips = 0;
        cc.moundBase = null;
        cc.moundI = 0;
        cc.moundNext = sim.tick + 30 * 30;
        return null;
      }
      continue;
    }
    cc.moundSkips = 0;
    const op = newOp(cc, sim, 'mound', _p, stand, brush, T.moundMudPerStamp, 1.4);
    op.reach = brush + 3.6;
    return op;
  }
  return null;
}

function chooseOp(sim: SimState, colony: Colony, cc: ColonyCtx): void {
  const T = BALANCE.b3.termites;
  const op = cc.op;
  if (op) {
    // stuck operations are dropped (and their plan advanced) so the queue never jams
    if (sim.tick - op.startedTick > 75 * 30 || op.fails > 3) {
      if (op.kind === 'mound') cc.moundI++;
      else if (op.kind === 'tube') {
        const tube = cc.tubes[cc.tubes.length - 1];
        if (tube) tube.state.done = true;
      }
      cc.op = null;
    } else return;
  }
  const breach = findBreach(sim, colony, cc);
  if (breach && colony.stores.mud >= breach.mud) {
    cc.op = breach;
    alertOnce(sim, colony, 'info', 'The nest has been breached — workers are sealing it', breach.pos, 0, 30);
    return;
  }
  planTube(sim, colony, cc);
  if (cc.opsDone % 3 === 2) {
    const m = moundOp(sim, colony, cc);
    if (m) {
      cc.op = m;
      return;
    }
  }
  if (colony.stores.mud >= T.tubeMudPerSegment) {
    const t = tubeOp(sim, colony, cc);
    if (t) {
      cc.op = t;
      return;
    }
  }
  cc.op = moundOp(sim, colony, cc);
}

function executeOp(sim: SimState, colony: Colony, cc: ColonyCtx, op: TermiteOp, ant: Ant): void {
  const T = BALANCE.b3.termites;
  const w = sim.world;
  colony.stores.mud = Math.max(0, colony.stores.mud - op.mud);
  cc.opsDone++;
  let added = 0;
  if (op.kind !== 'tube') added = fillGuarded(sim, op.pos, op.radius, colony.id);
  if (op.kind === 'tube') {
    const tube = cc.tubes[cc.tubes.length - 1];
    if (tube && !tube.state.done) {
      // An arch over the walkway: a wall stamp either side and a roof stamp on top. The floor is
      // left untouched so the walkway keeps its walkable surface band (a bored-out solid ridge
      // would leave a hard 255→0 floor that the nav grid cannot walk).
      const k = tube.state.built;
      const n = tube.pts.length;
      const a = tube.pts[k];
      const b0 = tube.pts[Math.max(0, k - 1)];
      const b1 = tube.pts[Math.min(n - 1, k + 1)];
      let tx = b1.x - b0.x;
      let tz = b1.z - b0.z;
      const tl = Math.hypot(tx, tz);
      if (tl < 0.01) {
        tx = 1;
        tz = 0;
      } else {
        tx /= tl;
        tz /= tl;
      }
      if (!sim.map.flags.slab) {
        for (const side of [-1, 1]) {
          _q.x = a.x - tz * side * T.tubeWallOffset;
          _q.y = a.y + 0.6;
          _q.z = a.z + tx * side * T.tubeWallOffset;
          added += fillGuarded(sim, _q, T.tubeWall, colony.id);
        }
      }
      _q.x = a.x;
      _q.y = a.y + T.tubeRoofHeight;
      _q.z = a.z;
      added += fillGuarded(sim, _q, T.tubeRoof, colony.id);
      tube.state.built = k + 1;
      sim.emit(asSimEvent({ type: 'shelterTube', tick: sim.tick, op: 'segment', tube: tube.state.id, colony: colony.id, pos: v3clone(op.pos) }));
      if (tube.state.built >= tube.state.segments) {
        tube.state.done = true;
        sim.emit(asSimEvent({ type: 'shelterTube', tick: sim.tick, op: 'done', tube: tube.state.id, colony: colony.id, pos: v3clone(tube.state.to) }));
        alertOnce(sim, colony, 'info', 'Shelter tube complete', tube.state.to, 0, 5);
      }
    }
  } else if (op.kind === 'mound') {
    cc.moundI++;
    cc.moundNext = sim.tick + Math.round(T.moundEvery * 30);
    const m = cc.state.mound;
    m.stamps++;
    if (cc.moundBase) m.height = Math.max(m.height, op.pos.y + op.radius - cc.moundBase.y);
  }
  if (added > 0 || op.kind === 'tube') sim.emit({ type: 'build', tick: sim.tick, by: ant.id, pos: v3clone(op.pos), radius: op.radius, material: Mat.Mud });
  cc.op = null;
}

/**
 * One tick of work by `ant` on its colony's current operation.
 *  'far'      not within reach — walk to `op.cell`
 *  'working'  progress added
 *  'done'     the operation was executed this tick
 *  'none'     there is no (such) operation any more
 * `atStand`: the ant reached the standing cell (counts as in reach even if the brush centre is a
 * little farther than `op.reach`).
 */
export function workTermiteOp(sim: SimState, ant: Ant, serial: number, dt: number, atStand = false): 'far' | 'working' | 'done' | 'none' {
  const colony = sim.getColony(ant.colony);
  const cc = colony ? ctxOf(sim).colonies.get(colony.id) : undefined;
  const op = cc?.op;
  if (!colony || !cc || !op || op.serial !== serial) return 'none';
  const d = Math.hypot(op.pos.x - ant.pos.x, op.pos.y - ant.pos.y, op.pos.z - ant.pos.z);
  if (d > op.reach && !(atStand && d < op.reach + 3)) return 'far';
  if (colony.stores.mud < op.mud) return 'none';
  ant.intent.mode = 'none';
  ant.anim = 'dig';
  orthonormalizeForward(ant.forward, ant.up, ant.forward.x * 0.7 + (op.pos.x - ant.pos.x) * 0.3, ant.forward.y * 0.7 + (op.pos.y - ant.pos.y) * 0.3, ant.forward.z * 0.7 + (op.pos.z - ant.pos.z) * 0.3);
  op.progress += Math.max(0.3, getCaste(ant.species, ant.caste).digRate) * dt;
  if (op.progress < op.work) return 'working';
  executeOp(sim, colony, cc, op, ant);
  ant.anim = 'idle';
  return 'done';
}

/** Tell the works an operation could not be reached (path failed). */
export function failTermiteOp(sim: SimState, colonyId: number, serial: number): void {
  const op = ctxOf(sim).colonies.get(colonyId)?.op;
  if (op && op.serial === serial) op.fails++;
}

// ---- founding under the deadwood -------------------------------------------------------------------

function relocateToDeadwood(sim: SimState, colony: Colony): boolean {
  const T = BALANCE.b3.termites;
  const extras = getMapExtras(sim.map);
  if (!extras || sim.map.flags.slab) return false;
  const w = sim.world;
  const nav = sim.nav as NavEx;
  let best: { pos: Vec3; end: Vec3 } | null = null;
  let bestD = Infinity;
  for (const s of extras.sites) {
    if (s.kind !== 'deadwood') continue;
    const d = Math.hypot(s.pos.x - colony.nestPos.x, s.pos.z - colony.nestPos.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (!best) return false;
  const sx = Math.max(12, Math.min(w.sx - 12, best.pos.x));
  const sz = Math.max(12, Math.min(w.sz - 12, best.pos.z));
  // top of the soil under the wood
  let ground = -1;
  for (let y = Math.min(w.sy - 1, Math.floor(best.pos.y) + 4); y >= 2; y--) {
    const c = w.index(Math.floor(sx), y, Math.floor(sz));
    if (w.density[c] >= ISO && !MATERIALS[w.material[c]].edibleByTermites) {
      ground = y + 1;
      break;
    }
  }
  if (ground < T.royalDepth + 5) return false;
  // log axis (horizontal), and the side the ramp comes out on
  let ax = best.end.x - best.pos.x;
  let az = best.end.z - best.pos.z;
  const al = Math.hypot(ax, az);
  if (al < 1) {
    ax = 1;
    az = 0;
  } else {
    ax /= al;
    az /= al;
  }
  const R = T.royalRadius;
  const cy = ground - T.royalDepth;
  const centre = v3(sx, cy, sz);
  // Final round: the royal chamber used to be carved with `canDig` refusing rock, so wherever the
  // room met the bedrock it kept jagged rock teeth. The pair now settles in packed earth: rock in
  // the brush's band is turned to soil first, then the brush carves a clean SDF surface.
  const carve = (p: Vec3, r: number): void => {
    const q = r + 2.5;
    for (let y = Math.max(1, Math.floor(p.y - q)); y <= Math.min(w.sy - 1, Math.ceil(p.y + q)); y++)
      for (let z = Math.max(0, Math.floor(p.z - q)); z <= Math.min(w.sz - 1, Math.ceil(p.z + q)); z++)
        for (let x = Math.max(0, Math.floor(p.x - q)); x <= Math.min(w.sx - 1, Math.ceil(p.x + q)); x++) {
          const i = w.index(x, y, z);
          if (w.material[i] === Mat.Rock && (x + 0.5 - p.x) ** 2 + (y + 0.5 - p.y) ** 2 + (z + 0.5 - p.z) ** 2 <= q * q) w.material[i] = Mat.Soil;
        }
    w.dig(p, r);
  };
  // the room: an ellipsoid along the log axis — a dense row of overlapping spheres, tapering to
  // the ends, with a second, lower row that flattens the floor
  for (let o = -0.8; o <= 0.801; o += 0.16) {
    const taper = 1 - 0.3 * o * o;
    carve(v3(sx + ax * R * o, cy + 0.6, sz + az * R * o), R * 0.8 * taper);
    carve(v3(sx + ax * R * o * 0.9, cy - 0.2, sz + az * R * o * 0.9), R * 0.62 * taper);
  }
  // gallery straight up into the wood
  for (let y = cy + R * 0.6; y <= ground + 1.5; y += 0.9) carve(v3(sx, y, sz), 1.7);
  // ramp to the open air beside the log, on whichever side has room
  let exit: Vec3 | null = null;
  for (const side of [1, -1]) {
    const px = -az * side;
    const pz = ax * side;
    const ox = sx + px * 13;
    const oz = sz + pz * 13;
    if (ox < 6 || oz < 6 || ox > w.sx - 6 || oz > w.sz - 6) continue;
    const top = nav.skyHeight(Math.floor(ox), Math.floor(oz));
    if (top < cy + 3 || top > ground + 6) continue;
    const a = v3(sx + px * R * 0.7, cy + 0.8, sz + pz * R * 0.7);
    const b = v3(ox, top + 0.6, oz);
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    for (let s = 0; s <= len; s += 0.9) carve(v3(a.x + ((b.x - a.x) * s) / len, a.y + ((b.y - a.y) * s) / len, a.z + ((b.z - a.z) * s) / len), 1.85);
    exit = b;
    break;
  }
  const nestCell = nav.nearestWalkable(centre.x, cy - R * 0.8 + 1.2, centre.z, 6);
  if (nestCell < 0) return false;
  const ext = getExt(sim, colony.id);
  colony.nestCell = nestCell;
  w.cellCenter(nestCell, colony.nestPos);
  nav.setHome(colony.id, [nestCell]);
  colony.entrances.length = 0;
  if (exit) {
    const e = nav.nearestWalkable(exit.x, exit.y, exit.z, 5);
    if (e >= 0) colony.entrances.push(e);
  }
  // one royal chamber; the colony system lays the rest out again around the new nest
  const q = colony.chambers[0];
  colony.chambers.length = 1;
  q.cell = nestCell;
  q.pos = v3clone(colony.nestPos);
  ext.baseVolume = 0;
  ext.patrolPoints.length = 0;
  let i = 0;
  for (const a of sim.ants) {
    if (!a.alive || a.colony !== colony.id) continue;
    const royal = a.caste === 'queen' || a.caste === 'king';
    const ang = i * 2.39996323;
    const r = royal ? (a.caste === 'king' ? 1.4 : 0) : 1.2 + (i % 5) * 0.6;
    a.pos.x = colony.nestPos.x + Math.cos(ang) * r;
    a.pos.y = colony.nestPos.y;
    a.pos.z = colony.nestPos.z + Math.sin(ang) * r;
    a.falling = false;
    a.path.status = 'none';
    if (!snapToSurface(w, nav, a, 8)) a.falling = true;
    syncPrev(a);
    i++;
  }
  nav.updateFields(sim.tick);
  return true;
}

// ---- per-tick ----------------------------------------------------------------------------------------

function sunAndPellets(sim: SimState): void {
  const T = BALANCE.b3.termites;
  const sunny = sunActive(sim);
  const works = b3StateOf(sim).termite;
  if (sim.tick % 30 === 0) for (const s of works) s.scorched = 0;
  for (const a of sim.ants) {
    if (!a.alive) continue;
    const caps = getSpecies(a.species).caps;
    if (caps.canFill) {
      const c = a.carrying;
      if (c && c.kind === 'bulk' && c.itemKind === 'debris') {
        // swallowed: soil and frass become building mud
        const colony = sim.getColony(a.colony);
        if (colony) colony.stores.mud = Math.max(colony.stores.mud, Math.min(T.mudMax, colony.stores.mud + c.amount * T.mudPerVoxel));
        a.carrying = null;
      }
    }
    if (!caps.sunSensitive || (sim.tick + a.id) % 15 !== 0 || a.caste === 'alate') continue;
    const s = sunny ? sunAt(sim, a.cell, a.pos, T.sunFrom, T.sunTo) : 0;
    if (s > 0 && !a.mem['raft'] && sim.tick - (a.mem['tb.w'] ?? -1e9) >= 30 && !termiteSheeted(sim, a)) {
      a.health -= T.sunDamage * s * 0.5;
      a.hydration = Math.max(0, a.hydration - T.sunDry * s * 0.5);
      a.mem['sun.x'] = sim.tick;
      for (const st of works) if (st.colony === a.colony) st.scorched++;
      if ((sim.tick + a.id) % 60 < 15) sim.emit(asSimEvent({ type: 'sunburn', tick: sim.tick, id: a.id, colony: a.colony, pos: v3clone(a.pos) }));
      if (a.health <= 0) sim.killAnt(a, 'sun');
    } else {
      // the damp dark of the nest: slow recovery
      if (a.health < a.maxHealth) a.health = Math.min(a.maxHealth, a.health + 0.03);
      if (a.hydration < 1) a.hydration = Math.min(1, a.hydration + 0.02);
    }
  }
}

export const termiteBuildSystem: SimSystem = {
  id: 'termiteBuild',
  init(sim) {
    if (sim.options.fixture === 'wander') return;
    for (const colony of sim.colonies) {
      const caps = getSpecies(colony.species).caps;
      if (!caps.canFill && !caps.eatsWood) continue;
      const old = v3clone(colony.nestPos);
      if (caps.eatsWood && relocateToDeadwood(sim, colony)) {
        alertOnce(sim, colony, 'info', 'The royal pair has settled under the deadwood', colony.nestPos, colony.queenId, 0);
        // M3: the map's authored nest views (shots, the menu's attract camera, e2e) were framed on
        // the default nest site — carry them over to where the player's colony actually lives
        if (colony.id === sim.playerColony) {
          const n = colony.nestPos;
          for (const key of ['nest', 'queen', 'chamber', 'entrance']) {
            const p = sim.map.shotPoses[key];
            if (!p) continue;
            const dx = n.x - old.x;
            const dy = n.y - old.y;
            const dz = n.z - old.z;
            p.pos = [p.pos[0] + dx, p.pos[1] + dy, p.pos[2] + dz];
            p.target = [p.target[0] + dx, p.target[1] + dy, p.target[2] + dz];
            if (p.cut && p.cut.axis !== 'y') p.cut = { ...p.cut, pos: Math.round(p.cut.pos + (p.cut.axis === 'x' ? dx : dz)) };
            else if (p.cut) p.cut = { ...p.cut, pos: Math.round(p.cut.pos + dy) };
          }
        }
      }
      colonyCtx(sim, colony);
    }
  },
  update(sim, dt) {
    sunAndPellets(sim);
    if (sim.tick % 30 !== 7) return;
    void dt;
    for (const colony of sim.colonies) {
      if (!colony.alive) continue;
      const caps = getSpecies(colony.species).caps;
      if (!caps.canFill && !caps.eatsWood) continue;
      if (!getExt(sim, colony.id).active) continue;
      const cc = colonyCtx(sim, colony);
      const T = BALANCE.b3.termites;
      // jobs barred by the sun are open again once it stops burning
      const barred = getExt(sim, colony.id).sunBarred;
      if (barred.size > 0 && (!sunActive(sim) || barred.size > 64)) for (const [id, until] of barred) if (!sunActive(sim) || until <= sim.tick) barred.delete(id);
      if (caps.eatsWood) {
        // digestion
        const d = Math.min(colony.stores.wood, T.digestPerWorker * Math.max(1, Math.min(T.digestWorkersMax, countWorkers(sim, colony))));
        if (d > 0) {
          colony.stores.wood -= d;
          colony.stores.food += d * T.foodPerWood;
          colony.stats.foodDelivered += d * T.foodPerWood;
        }
        if (sim.tick % 60 === 7) {
          windfall(sim, colony, cc);
          planWoodFaces(sim, colony, cc);
        }
      }
      if (caps.canFill) {
        chooseOp(sim, colony, cc);
        const op = cc.op;
        if (op) {
          postJob(sim, colony, cc.slot, 'build', op.cell, op.pos, 0, op.kind === 'plug' ? 0.9 : T.buildUrgency, op.kind === 'plug' ? 2 : T.buildSlots, op.serial);
          bumpDemand(sim, colony, 'build');
        } else closeJob(sim, colony, cc.slot);
      }
    }
  },
};
