import {
  HOME_UNREACHABLE,
  ISO,
  MATERIALS,
  Mat,
  hash01,
  v3,
  v3clone,
  type Ant,
  type CellIndex,
  type Colony,
  type Designation,
  type DigDutyState,
  type DigStats,
  type EditResult,
  type MaterialId,
  type Mover,
  type NavEx,
  type SimState,
  type SimSystem,
  type Vec3,
  type WorkResult,
  type WorkSite,
} from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste, getSpecies } from '../data/species';
import { orthonormalizeForward } from './movementCrawl';

/**
 * DIG & BUILD EXECUTION (A2a) — the machinery behind dig designations, spoil mounds and
 * termite-style building. The dig *system* owns work sites, progress, world edits, spoil and
 * events; a *behavior* only decides that an ant should work and calls in here.
 *
 * ── Model ────────────────────────────────────────────────────────────────────────────────
 * A `Designation` (one painted brush stamp: sphere of radius ≥ 1.5, kind dig | build) is broken
 * into WORK SITES. Up to radius `digBrushMax` (2.4) a designation is ONE site: a single D4 stamp
 * of the designation's own radius. Bigger ones become a lattice of `digLatticeBrush` (2.0)
 * stamps plus rim stamps, whose union covers the sphere and never leaves it. A site is workable
 * when work is left in it (dig: diggable solid cells; build: air cells) and a walkable cell
 * lies within reach of it — i.e. sites on the face of the excavation come first and the
 * frontier advances as stamps are carved. Build sites additionally need existing solid nearby
 * to attach to, so structures grow out of what is there.
 *
 * Work: an ant within `digReach` of a site adds `digRate · dt` per tick until the site's cost
 * is paid (dig cost ∝ voxels × material dig cost), then the stamp is executed with
 * `world.dig` / `world.fill`. Nav, home fields, pheromones and falling update automatically
 * from the edit.
 *
 * Spoil: a dig stamp leaves the ant carrying a PELLET — `ant.carrying = { kind:'bulk',
 * itemKind:'debris', amount: voxels, material }`. Dropping the pellet outdoors (`dropSpoil`)
 * performs a small `fill` there, so pellets carried to the entrance pile up into the classic
 * crater mound; dropped underground or in a cramped spot the pellet simply vanishes (packed
 * into the walls). Edible material is credited as it is dug: gel/fungus → `stores.food` for
 * ants, wood/litter → `stores.wood` for `eatsWood` species.
 *
 * ── API for behaviors (all exported from this file) ──────────────────────────────────────
 *   runDigDuty(sim, ant, dt, opts?) → DigDutyState
 *       The whole job as one call per tick: claim a site → walk there → work → haul the pellet
 *       to the spoil mound → drop → repeat. Returns 'done' when no workable site is left
 *       (then stop calling). A dig behavior can be exactly:  run(ant, sim, dt) { runDigDuty(sim, ant, dt) }.
 *       opts: { kind = 'dig', designationId = 0 (any), autoFinish = true }.
 *       Call `stopDigDuty(sim, ant)` from the behavior's `exit`.
 *
 *   Or drive the pieces yourself:
 *   claimWorkSite(sim, ant, kind?, designationId?) → WorkSite | null   nearest workable site, reserved for the ant
 *   findWorkSite(sim, ant, kind?, designationId?)  → WorkSite | null   same without reserving
 *   getWorkSite(sim, siteId) → WorkSite | null                         resolve an id kept in ant.mem
 *   releaseWorkSite(sim, ant)                                           give the reservation back
 *   applyDigWork(sim, ant, site, dt)   → WorkResult                     call every tick while at the site
 *   applyBuildWork(sim, ant, site, dt, free?) → WorkResult              build: uses a carried pellet of the
 *                                                                       site material, else `stores.mud`
 *   hasSpoil(ant) / spoilDropCell(sim, ant) / dropSpoil(sim, ant)       pellet handling
 *   runSpoilHaul(sim, ant) → 'none' | 'hauling' | 'dropped'             walk the pellet out and drop it
 *   digDirect(sim, ant, target, radius?) → voxels removed               instant stamp (possession dig, debug)
 *   giveSpoil(ant, editResult)                                          turn any EditResult into a pellet
 *   designationProgress(sim, id) → { total, left } | null
 *   finishDesignation(sim, designation)                                 flag done + remove + event
 *   digStats(sim) → DigStats
 *
 * The dig system never touches a designation on its own: it is only marked done by
 * `finishDesignation` (called by `runDigDuty` with autoFinish, or by the owning behavior).
 * Site ids are `designationId * 4096 + index` and stay valid for the designation's lifetime.
 * Events: `dig` / `build` (per stamp and per mound drop), `designationChanged` op 'done'.
 */

const SITE_STRIDE = 4096;
const PENDING = 0;
const DONE = 1;
const SKIPPED = 2;

interface Plan {
  d: Designation;
  kind: 'dig' | 'build';
  colony: number;
  /** Brush radius of this plan's stamps. */
  brush: number;
  /** xyz stamp centres. */
  pts: Float32Array;
  state: Uint8Array;
  progress: Float32Array;
  cost: Float32Array;
  reservedBy: Int32Array;
  reservedAt: Int32Array;
  /** Cached standing cell and the edit sequence it was computed at. */
  stand: Int32Array;
  /** Edit sequence at which the standing cell was last proven reachable from the nest. */
  verified: Int32Array;
  checkedSeq: Int32Array;
  /** Tick until which a site is skipped (its stand cell turned out unreachable). */
  blockedUntil: Int32Array;
  left: number;
  total: number;
}

interface DigCtx {
  plans: Map<number, Plan>;
  byAnt: Map<number, number>;
  /** Pellets dropped per colony (drives the spoil ring). */
  pellets: number[];
  /** Cached exit cell per colony when it has no entrance listed. */
  exits: number[];
  stats: DigStats;
}

const ctxs = new WeakMap<SimState, DigCtx>();

function ctxOf(sim: SimState): DigCtx {
  let c = ctxs.get(sim);
  if (!c) {
    c = { plans: new Map(), byAnt: new Map(), pellets: [], exits: [], stats: { pendingSites: 0, reservedSites: 0, designations: 0, dugVoxels: 0, filledVoxels: 0, pelletsDropped: 0, moundVoxels: 0 } };
    ctxs.set(sim, c);
  }
  return c;
}

const _p = v3();
const _q = v3();
const _pe = v3();

// ---- plans ---------------------------------------------------------------------------------

function buildPlan(sim: SimState, d: Designation): Plan {
  const B = BALANCE.a2a;
  const w = sim.world;
  // small designations are a single stamp of their own radius: neighbouring painted stamps then
  // join exactly as painted (a lattice of smaller balls would leave necks too tight to walk)
  const brush = d.radius <= B.digBrushMax ? Math.max(B.digBrush, d.radius) : B.digLatticeBrush;
  const inner = Math.max(0, d.radius - brush);
  const pts: number[] = [];
  // keep stamp centres inside the world so stamps are not wasted on the boundary
  const push = (x: number, y: number, z: number): void => {
    if (x < 0.5 || y < 0.5 || z < 0.5 || x > w.sx - 0.5 || y > w.sy - 0.5 || z > w.sz - 0.5) return;
    pts.push(x, y, z);
  };
  if (inner < 0.4) push(d.center.x, d.center.y, d.center.z);
  else {
    let step = B.digSpacing;
    // huge designations: widen the lattice rather than overflow the site id space
    while (((4.19 * inner * inner * inner) / (step * step * step)) * 1.2 > SITE_STRIDE - 8) step *= 1.15;
    const n = Math.floor(inner / step);
    for (let j = -n; j <= n; j++)
      for (let k = -n; k <= n; k++)
        for (let i = -n; i <= n; i++) {
          const x = i * step;
          const y = j * step;
          const z = k * step;
          if (x * x + y * y + z * z > inner * inner + 1e-3) continue;
          push(d.center.x + x, d.center.y + y, d.center.z + z);
        }
    // rim stamps (6 axes + 8 diagonals) so the painted radius is actually reached all round
    if (inner - n * step > 0.4) {
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++)
          for (let i = -1; i <= 1; i++) {
            const m = Math.abs(i) + Math.abs(j) + Math.abs(k);
            if (m !== 1 && m !== 3) continue;
            const s = inner / Math.sqrt(m);
            push(d.center.x + i * s, d.center.y + j * s, d.center.z + k * s);
          }
    }
  }
  const count = Math.min(SITE_STRIDE - 1, pts.length / 3);
  return {
    d,
    kind: d.kind,
    colony: d.colony,
    brush,
    pts: new Float32Array(pts.slice(0, count * 3)),
    state: new Uint8Array(count),
    progress: new Float32Array(count),
    cost: new Float32Array(count),
    reservedBy: new Int32Array(count),
    reservedAt: new Int32Array(count),
    stand: new Int32Array(count).fill(-1),
    verified: new Int32Array(count).fill(-1),
    checkedSeq: new Int32Array(count).fill(-1),
    blockedUntil: new Int32Array(count),
    left: count,
    total: count,
  };
}

/** Create plans for new designations of a colony and drop plans whose designation is gone. */
function syncPlans(sim: SimState, ctx: DigCtx, colony: Colony): void {
  for (const d of colony.designations) {
    if (d.done) continue;
    if (!ctx.plans.has(d.id)) ctx.plans.set(d.id, buildPlan(sim, d));
  }
}

function prunePlans(sim: SimState, ctx: DigCtx): void {
  for (const [id, plan] of ctx.plans) {
    const colony = sim.getColony(plan.colony);
    if (!plan.d.done && colony && colony.designations.includes(plan.d)) continue;
    for (let i = 0; i < plan.total; i++) if (plan.reservedBy[i]) ctx.byAnt.delete(plan.reservedBy[i]);
    ctx.plans.delete(id);
  }
}

function setState(plan: Plan, i: number, state: number): void {
  if (plan.state[i] !== PENDING) return;
  plan.state[i] = state;
  plan.left--;
}

/**
 * Work left in one site. dig: Σ dig cost of diggable solid cells inside the brush (−1 if only
 * undiggable solid is left); build: number of air cells inside the brush. 0 = nothing to do.
 */
function workLeft(sim: SimState, plan: Plan, i: number): number {
  const w = sim.world;
  const r = plan.brush;
  const cx = plan.pts[i * 3];
  const cy = plan.pts[i * 3 + 1];
  const cz = plan.pts[i * 3 + 2];
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const z0 = Math.max(0, Math.floor(cz - r));
  const x1 = Math.min(w.sx - 1, Math.floor(cx + r));
  const y1 = Math.min(w.sy - 1, Math.floor(cy + r));
  const z1 = Math.min(w.sz - 1, Math.floor(cz + r));
  const dig = plan.kind === 'dig';
  let sum = 0;
  let hard = false;
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const dz = z + 0.5 - cz;
        if (dx * dx + dy * dy + dz * dz >= r * r) continue;
        const c = x + w.sx * (z + w.sz * y);
        const solid = w.density[c] >= ISO;
        if (dig) {
          if (!solid) continue;
          const cost = MATERIALS[w.material[c]].digCost;
          if (Number.isFinite(cost)) sum += cost;
          else hard = true;
        } else if (!solid) sum += 1;
      }
  return sum === 0 && hard ? -1 : sum;
}

const CAND = 4;
const candCell = new Int32Array(CAND);
const candScore = new Float64Array(CAND);

/**
 * Best walkable cell to stand on for a site, or -1. Prefers cells connected to the nest.
 * With `ref >= 0` the best few candidates are checked for real and the first one reachable from
 * `ref` wins (freshly dug rock leaves walkable crumbs that lead nowhere).
 */
function findStand(sim: SimState, nav: NavEx, plan: Plan, i: number, ref: CellIndex = -1): CellIndex {
  const w = sim.world;
  const tx = plan.pts[i * 3];
  const ty = plan.pts[i * 3 + 1];
  const tz = plan.pts[i * 3 + 2];
  const reach = plan.brush + BALANCE.a2a.digReach - BALANCE.a2a.digBrush - 0.7;
  const ix = Math.floor(tx);
  const iy = Math.floor(ty);
  const iz = Math.floor(tz);
  const R = Math.ceil(reach);
  let best = -1;
  let bestScore = Infinity;
  let nc = 0;
  for (let dy = -R; dy <= R; dy++) {
    const y = iy + dy;
    if (y < 0 || y >= w.sy) continue;
    for (let dz = -R; dz <= R; dz++) {
      const z = iz + dz;
      if (z < 0 || z >= w.sz) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = ix + dx;
        if (x < 0 || x >= w.sx) continue;
        const ex = x + 0.5 - tx;
        const ey = y + 0.5 - ty;
        const ez = z + 0.5 - tz;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > reach * reach) continue;
        const c = x + w.sx * (z + w.sz * y);
        if (!nav.isWalkable(c)) continue;
        // prefer cells the colony can already reach; standing below the work is slightly
        // preferred over hanging above it
        let score = Math.sqrt(d2) + (ey > 0 ? 0.3 : 0);
        if (nav.homeDistance(plan.colony, c) === HOME_UNREACHABLE) score += 2.5;
        if (score < bestScore) {
          bestScore = score;
          best = c;
        }
        if (ref >= 0) {
          // keep the CAND best, sorted (insertion)
          let k: number;
          if (nc < CAND) k = nc++;
          else if (score < candScore[CAND - 1]) k = CAND - 1;
          else continue;
          while (k > 0 && candScore[k - 1] > score) {
            candScore[k] = candScore[k - 1];
            candCell[k] = candCell[k - 1];
            k--;
          }
          candScore[k] = score;
          candCell[k] = c;
        }
      }
    }
  }
  if (ref < 0) return best;
  for (let k = 0; k < nc; k++) if (nav.reachable(ref, candCell[k], 0, 6000)) return candCell[k];
  return -1;
}

/**
 * Re-examines a pending site if the world changed since it was last looked at: settles its
 * state, its cost and its standing cell. Returns true if the site is workable right now.
 */
function examine(sim: SimState, nav: NavEx, plan: Plan, i: number): boolean {
  if (plan.state[i] !== PENDING) return false;
  if (plan.checkedSeq[i] !== nav.editSeq) {
    plan.checkedSeq[i] = nav.editSeq;
    const left = workLeft(sim, plan, i);
    if (left === 0) {
      setState(plan, i, DONE);
      return false;
    }
    if (left < 0) {
      setState(plan, i, SKIPPED); // nothing but rock
      return false;
    }
    const B = BALANCE.a2a;
    plan.cost[i] = plan.kind === 'dig' ? Math.max(B.digMinCost, left * B.digCostScale) : B.buildCost;
    plan.stand[i] = findStand(sim, nav, plan, i);
    if (plan.kind === 'build' && plan.stand[i] >= 0) {
      // must attach to existing solid: something solid within ~2 voxels of the stamp centre
      if (sim.world.sample(plan.pts[i * 3], plan.pts[i * 3 + 1], plan.pts[i * 3 + 2]) < -1.95) plan.stand[i] = -1;
    }
  }
  return plan.stand[i] >= 0 && sim.tick >= plan.blockedUntil[i];
}

function siteView(plan: Plan, i: number): WorkSite {
  return {
    id: plan.d.id * SITE_STRIDE + i,
    designationId: plan.d.id,
    kind: plan.kind,
    colony: plan.colony,
    target: { x: plan.pts[i * 3], y: plan.pts[i * 3 + 1], z: plan.pts[i * 3 + 2] },
    radius: plan.brush,
    cell: plan.stand[i],
    material: plan.kind === 'build' ? plan.d.material : Mat.Air,
    cost: plan.cost[i],
    progress: plan.progress[i],
    reservedBy: plan.reservedBy[i],
  };
}

function reservationLive(sim: SimState, plan: Plan, i: number): boolean {
  const by = plan.reservedBy[i];
  if (!by) return false;
  if (sim.tick - plan.reservedAt[i] > BALANCE.a2a.siteReserveTicks) return false;
  return sim.getAnt(by) !== undefined;
}

// ---- site API ------------------------------------------------------------------------------

/** Nearest workable, unreserved site for the ant's colony (not reserved by this call). */
export function findWorkSite(sim: SimState, ant: Ant, kind: 'dig' | 'build' = 'dig', designationId = 0): WorkSite | null {
  const ctx = ctxOf(sim);
  const colony = sim.getColony(ant.colony);
  if (!colony) return null;
  syncPlans(sim, ctx, colony);
  const nav = sim.nav as NavEx;
  const ref = colony.nestCell >= 0 && nav.isWalkable(colony.nestCell) ? colony.nestCell : ant.cell;
  for (let round = 0; round < 4; round++) {
    const site = pickSite(sim, ctx, nav, ant, kind, designationId);
    if (!site) return null;
    const { plan, i } = site;
    if (plan.verified[i] === nav.editSeq) return siteView(plan, i);
    // prove the standing cell can be walked to before anyone is sent there
    const stand = findStand(sim, nav, plan, i, ref);
    if (stand >= 0) {
      plan.stand[i] = stand;
      plan.verified[i] = nav.editSeq;
      return siteView(plan, i);
    }
    plan.blockedUntil[i] = sim.tick + 90;
  }
  return null;
}

const _pick: { plan: Plan; i: number } = { plan: null as unknown as Plan, i: -1 };

function pickSite(sim: SimState, ctx: DigCtx, nav: NavEx, ant: Ant, kind: 'dig' | 'build', designationId: number): { plan: Plan; i: number } | null {
  let bestPlan: Plan | null = null;
  let bestI = -1;
  let bestD = Infinity;
  for (const plan of ctx.plans.values()) {
    if (plan.colony !== ant.colony || plan.kind !== kind || plan.left <= 0) continue;
    if (designationId && plan.d.id !== designationId) continue;
    if (plan.d.done) continue;
    for (let i = 0; i < plan.total; i++) {
      if (plan.state[i] !== PENDING) continue;
      if (plan.reservedBy[i] && plan.reservedBy[i] !== ant.id && reservationLive(sim, plan, i)) continue;
      if (!examine(sim, nav, plan, i)) continue;
      const dx = plan.pts[i * 3] - ant.pos.x;
      const dy = plan.pts[i * 3 + 1] - ant.pos.y;
      const dz = plan.pts[i * 3 + 2] - ant.pos.z;
      // started stamps first (finish what is begun), then the nearest
      const d = dx * dx + dy * dy + dz * dz - (plan.progress[i] > 0 ? 4 : 0);
      if (d < bestD) {
        bestD = d;
        bestPlan = plan;
        bestI = i;
      }
    }
  }
  if (!bestPlan) return null;
  _pick.plan = bestPlan;
  _pick.i = bestI;
  return _pick;
}

function resolve(sim: SimState, siteId: number): { plan: Plan; i: number } | null {
  const id = Math.floor(siteId / SITE_STRIDE);
  const plan = ctxOf(sim).plans.get(id);
  if (!plan) return null;
  const i = siteId - id * SITE_STRIDE;
  if (i < 0 || i >= plan.total) return null;
  return { plan, i };
}

/** The site with this id, or null if it is finished or its designation is gone. */
export function getWorkSite(sim: SimState, siteId: number): WorkSite | null {
  const r = resolve(sim, siteId);
  if (!r || r.plan.state[r.i] !== PENDING || r.plan.d.done) return null;
  return siteView(r.plan, r.i);
}

/** Give back whatever site the ant has reserved. Safe to call any time. */
export function releaseWorkSite(sim: SimState, ant: { id: number }): void {
  const ctx = ctxOf(sim);
  const siteId = ctx.byAnt.get(ant.id);
  if (siteId === undefined) return;
  ctx.byAnt.delete(ant.id);
  const r = resolve(sim, siteId);
  if (r && r.plan.reservedBy[r.i] === ant.id) r.plan.reservedBy[r.i] = 0;
}

/** `findWorkSite` + reserve it for the ant (one site per ant; a previous reservation is released). */
export function claimWorkSite(sim: SimState, ant: Ant, kind: 'dig' | 'build' = 'dig', designationId = 0): WorkSite | null {
  releaseWorkSite(sim, ant);
  const site = findWorkSite(sim, ant, kind, designationId);
  if (!site) return null;
  const r = resolve(sim, site.id)!;
  r.plan.reservedBy[r.i] = ant.id;
  r.plan.reservedAt[r.i] = sim.tick;
  ctxOf(sim).byAnt.set(ant.id, site.id);
  site.reservedBy = ant.id;
  return site;
}

/** Tell the dig system a site could not be reached (path failed): it is skipped for a few seconds. */
export function reportUnreachable(sim: SimState, siteId: number, ticks = 150): void {
  const r = resolve(sim, siteId);
  if (r) r.plan.blockedUntil[r.i] = sim.tick + ticks;
}

/** Sites of a designation: total and still pending. Null if the dig system has no plan for it (yet). */
export function designationProgress(sim: SimState, designationId: number): { total: number; left: number } | null {
  const ctx = ctxOf(sim);
  let plan = ctx.plans.get(designationId);
  if (!plan) {
    // not planned yet (designations are picked up once a second): look for it now
    for (const colony of sim.colonies) if (colony.designations.some((d) => d.id === designationId)) syncPlans(sim, ctx, colony);
    plan = ctx.plans.get(designationId);
  }
  return plan ? { total: plan.total, left: plan.left } : null;
}

/** Mark a designation finished: flag, remove from its colony, drop its plan, emit `designationChanged`. */
export function finishDesignation(sim: SimState, d: Designation): void {
  const ctx = ctxOf(sim);
  const plan = ctx.plans.get(d.id);
  if (plan) {
    for (let i = 0; i < plan.total; i++) if (plan.reservedBy[i]) ctx.byAnt.delete(plan.reservedBy[i]);
    ctx.plans.delete(d.id);
  }
  if (d.done) return;
  d.done = true;
  const colony = sim.getColony(d.colony);
  if (colony) {
    const i = colony.designations.indexOf(d);
    if (i >= 0) colony.designations.splice(i, 1);
  }
  sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'done', designation: { ...d, center: v3clone(d.center) } });
}

// ---- work ----------------------------------------------------------------------------------

function faceTarget(ant: Ant, t: Vec3): void {
  orthonormalizeForward(ant.forward, ant.up, ant.forward.x * 0.7 + (t.x - ant.pos.x) * 0.3, ant.forward.y * 0.7 + (t.y - ant.pos.y) * 0.3, ant.forward.z * 0.7 + (t.z - ant.pos.z) * 0.3);
}

function digRate(ant: Ant): number {
  return Math.max(0.05, getCaste(ant.species, ant.caste).digRate);
}

/** Books a dig EditResult: stats, edible yield, event. Returns voxels removed and the dominant material. */
function bookDig(sim: SimState, ant: Ant, res: EditResult, pos: Vec3, radius: number): { removed: number; material: MaterialId } {
  let removed = 0;
  let best = 0;
  let material: MaterialId = Mat.Soil;
  const colony = sim.getColony(ant.colony);
  const eatsWood = colony ? getSpecies(colony.species).caps.eatsWood : false;
  const isAnt = colony ? getSpecies(colony.species).kind === 'ant' : true;
  for (let m = 1; m < res.removedByMaterial.length; m++) {
    const n = res.removedByMaterial[m] ?? 0;
    if (n <= 0) continue;
    removed += n;
    if (n > best) {
      best = n;
      material = m as MaterialId;
    }
    if (!colony) continue;
    const def = MATERIALS[m];
    const y = n * def.nutrition * BALANCE.a2a.digFoodYield;
    if (y > 0) {
      if (def.edibleByTermites && eatsWood) colony.stores.wood += y;
      // fungus farmers cannot eat what they dig (gel, honeydew crust…): it is garden substrate
      else if (def.edibleByAnts && isAnt) {
        if (getSpecies(colony.species).caps.farmsFungus) colony.stores.leaves += y * BALANCE.b3.leafcutters.forageAsSubstrate;
        else colony.stores.food += y;
      }
    }
  }
  if (colony) colony.stats.dugVoxels += removed;
  ctxOf(sim).stats.dugVoxels += removed;
  if (res.touchedCells > 0) sim.emit({ type: 'dig', tick: sim.tick, by: ant.id, pos: v3clone(pos), radius, material });
  return { removed, material };
}

/** Turn the material removed by an edit into the pellet the ant carries (no-op if nothing was removed). */
export function giveSpoil(ant: Ant, res: EditResult): boolean {
  let removed = 0;
  let best = 0;
  let material: MaterialId = Mat.Soil;
  for (let m = 1; m < res.removedByMaterial.length; m++) {
    const n = res.removedByMaterial[m] ?? 0;
    removed += n;
    if (n > best) {
      best = n;
      material = m as MaterialId;
    }
  }
  if (removed <= 0) return false;
  ant.carrying = { kind: 'bulk', id: 0, itemKind: 'debris', amount: removed, material };
  return true;
}

/**
 * Advance dig work on a site by one tick. The ant must be within `digReach` of `site.target`
 * and have free mandibles. On 'done' the stamp has been carved and the ant carries the pellet.
 */
export function applyDigWork(sim: SimState, ant: Ant, site: WorkSite, dt: number): WorkResult {
  const r = resolve(sim, site.id);
  if (!r || r.plan.kind !== 'dig' || r.plan.state[r.i] !== PENDING || r.plan.d.done) return 'invalid';
  const { plan, i } = r;
  if (ant.carrying) return 'carrying';
  const B = BALANCE.a2a;
  const t = site.target;
  const dx = t.x - ant.pos.x;
  const dy = t.y - ant.pos.y;
  const dz = t.z - ant.pos.z;
  const reach = B.digReach - B.digBrush + plan.brush;
  if (dx * dx + dy * dy + dz * dz > reach * reach) return 'outOfReach';
  const nav = sim.nav as NavEx;
  if (plan.checkedSeq[i] !== nav.editSeq) {
    examine(sim, nav, plan, i);
    if (plan.state[i] !== PENDING) {
      releaseWorkSite(sim, ant);
      return 'invalid';
    }
  }
  ant.intent.mode = 'none';
  ant.anim = 'dig';
  faceTarget(ant, t);
  plan.reservedAt[i] = sim.tick;
  const p = (plan.progress[i] += digRate(ant) * dt);
  site.progress = p;
  if (p < plan.cost[i]) return 'working';
  const res = sim.world.dig(t, plan.brush);
  const { removed, material } = bookDig(sim, ant, res, t, plan.brush);
  setState(plan, i, DONE);
  releaseWorkSite(sim, ant);
  if (removed > 0) ant.carrying = { kind: 'bulk', id: 0, itemKind: 'debris', amount: removed, material };
  ant.anim = 'idle';
  return 'done';
}

/** Instant dig stamp at `target` by `ant` (possession RMB dig, debug). Returns voxels removed; the ant gets the pellet if its mandibles are free. */
export function digDirect(sim: SimState, ant: Ant, target: Vec3, radius = BALANCE.a2a.digBrush): number {
  const res = sim.world.dig(target, radius);
  const { removed, material } = bookDig(sim, ant, res, target, Math.max(1.5, radius));
  if (removed > 0 && !ant.carrying) ant.carrying = { kind: 'bulk', id: 0, itemKind: 'debris', amount: removed, material };
  return removed;
}

const _occ: Mover[] = [];

/**
 * Advance build work on a site by one tick. Material comes from a carried pellet of the site's
 * material, else from `colony.stores.mud`; pass `free = true` to build without consuming any.
 * On 'done' the stamp has been filled (cells holding entities are skipped by the fill).
 */
export function applyBuildWork(sim: SimState, ant: Ant, site: WorkSite, dt: number, free = false): WorkResult {
  const r = resolve(sim, site.id);
  if (!r || r.plan.kind !== 'build' || r.plan.state[r.i] !== PENDING || r.plan.d.done) return 'invalid';
  const { plan, i } = r;
  const B = BALANCE.a2a;
  const t = site.target;
  const dx = t.x - ant.pos.x;
  const dy = t.y - ant.pos.y;
  const dz = t.z - ant.pos.z;
  const reach = B.digReach - B.digBrush + plan.brush;
  if (dx * dx + dy * dy + dz * dz > reach * reach) return 'outOfReach';
  const nav = sim.nav as NavEx;
  if (plan.checkedSeq[i] !== nav.editSeq) {
    examine(sim, nav, plan, i);
    if (plan.state[i] !== PENDING) {
      releaseWorkSite(sim, ant);
      return 'invalid';
    }
  }
  const colony = sim.getColony(ant.colony);
  const material = plan.d.material === Mat.Air ? Mat.Mud : plan.d.material;
  const carried = ant.carrying && ant.carrying.kind === 'bulk' && ant.carrying.material === material && ant.carrying.amount > 0;
  if (!free && !carried && !(colony && colony.stores.mud >= B.buildMudPerStamp)) return 'noMaterial';
  ant.intent.mode = 'none';
  ant.anim = 'dig';
  faceTarget(ant, t);
  plan.reservedAt[i] = sim.tick;
  const p = (plan.progress[i] += digRate(ant) * dt);
  site.progress = p;
  if (p < plan.cost[i]) return 'working';
  // D4: the fill refuses cells that hold entities
  const w = sim.world;
  const near = sim.spatial.queryMovers(t.x, t.y, t.z, plan.brush + 1.5, _occ);
  const res = w.fill(t, plan.brush, material, {
    isOccupied: (cell) => {
      for (let k = 0; k < near.length; k++) {
        const m = near[k];
        if (w.cellAt(m.pos.x, m.pos.y, m.pos.z) === cell) return true;
      }
      return false;
    },
  });
  if (res.addedCells === 0) {
    // nothing could be placed: either already full, or everything free was occupied
    if (workLeft(sim, plan, i) > 0 && near.length > 0) {
      plan.progress[i] = plan.cost[i] * 0.8;
      return 'blocked';
    }
    setState(plan, i, DONE);
    releaseWorkSite(sim, ant);
    return 'invalid';
  }
  if (!free) {
    if (carried) ant.carrying = null;
    else if (colony) colony.stores.mud -= B.buildMudPerStamp;
  }
  ctxOf(sim).stats.filledVoxels += res.addedCells;
  sim.emit({ type: 'build', tick: sim.tick, by: ant.id, pos: v3clone(t), radius: plan.brush, material });
  setState(plan, i, DONE);
  releaseWorkSite(sim, ant);
  ant.anim = 'idle';
  return 'done';
}

// ---- spoil ---------------------------------------------------------------------------------

/** Is the ant carrying a dig pellet? */
export function hasSpoil(ant: Ant): boolean {
  const c = ant.carrying;
  return !!c && c.kind === 'bulk' && c.itemKind === 'debris';
}

/** The colony's way out: its first listed entrance, else an exit found by walking the sky field. */
function exitCell(sim: SimState, ctx: DigCtx, colony: Colony, from: CellIndex): CellIndex {
  const nav = sim.nav as NavEx;
  for (const e of colony.entrances) if (e >= 0) return e;
  const cached = ctx.exits[colony.id];
  if (cached !== undefined && cached >= 0 && nav.isWalkable(cached) && nav.isExposed(cached)) return cached;
  const sky = nav.skyField();
  if (!sky.ready) return -1; // built by the next paths update
  let c = colony.nestCell >= 0 ? colony.nestCell : from;
  for (let k = 0; k < 2000 && c >= 0; k++) {
    if (sky.distance(c) === 0) {
      ctx.exits[colony.id] = c;
      return c;
    }
    c = sky.descend(c);
  }
  return -1;
}

/**
 * Where this ant should carry its pellet: a walkable, sky-exposed cell on a ring around the
 * colony entrance (the ring widens as the mound grows). -1 if the colony has no way out — then
 * just `dropSpoil` in place. The result varies from call to call (it spreads pellets round the
 * ring); a behavior should ask once per pellet and keep the cell.
 */
export function spoilDropCell(sim: SimState, ant: Ant): CellIndex {
  const ctx = ctxOf(sim);
  const colony = sim.getColony(ant.colony);
  if (!colony) return -1;
  const nav = sim.nav as NavEx;
  const exit = exitCell(sim, ctx, colony, ant.cell);
  if (exit < 0) return -1;
  const B = BALANCE.a2a;
  const w = sim.world;
  w.cellCenter(exit, _p);
  const n = ctx.pellets[colony.id] ?? 0;
  const ring = Math.min(B.spoilRingMax, B.spoilRingMin + B.spoilRingGrow * Math.sqrt(n));
  // golden-angle sequence over the colony's pellets, decorrelated per ant
  const base = (n + ant.id * 0.37) * 2.39996323;
  for (let k = 0; k < 8; k++) {
    const a = base + k * 0.785;
    const rr = ring * (k < 4 ? 1 : 1.35);
    const x = _p.x + Math.cos(a) * rr;
    const z = _p.z + Math.sin(a) * rr;
    if (x < 2 || z < 2 || x > w.sx - 2 || z > w.sz - 2) continue;
    const top = nav.skyHeight(Math.floor(x), Math.floor(z));
    if (top >= w.sy - 1) continue;
    const cell = nav.nearestWalkable(x, top + 0.5, z, 2);
    if (cell < 0 || !nav.isExposed(cell)) continue;
    // must be on the same connected surface as the exit (only an up-to-date field can tell)
    const hf = nav.homeField(colony.id);
    if (hf && hf.ready && !hf.stale && hf.distance(cell) === HOME_UNREACHABLE && hf.distance(exit) !== HOME_UNREACHABLE) continue;
    // never above a tunnel or the entrance ramp
    w.cellCenter(cell, _q);
    if (nearProtected(sim, _q)) continue;
    return cell;
  }
  return -1;
}

/**
 * Is there a cavity (air with solid above it: a tunnel, a ramp mouth, a chamber) inside or just
 * outside the brush a pellet dropped at `pos` would fill? Mounds must never plug the nest.
 */
function overCavity(sim: SimState, x: number, y: number, z: number): boolean {
  const w = sim.world;
  const nav = sim.nav as NavEx;
  const r = BALANCE.a2a.spoilBrush + 1.5;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(w.sx - 1, Math.floor(x + r));
  const z0 = Math.max(0, Math.floor(z - r));
  const z1 = Math.min(w.sz - 1, Math.floor(z + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const den = w.density;
  for (let cz = z0; cz <= z1; cz++)
    for (let cx = x0; cx <= x1; cx++) {
      const top = Math.min(nav.skyHeight(cx, cz), Math.floor(y + r) + 1);
      for (let cy = y0; cy < top; cy++) if (den[cx + w.sx * (cz + w.sz * cy)] < ISO) return true;
    }
  return false;
}

/** Would a mound here plug an entrance or bury the nest? */
function nearProtected(sim: SimState, pos: Vec3): boolean {
  if (overCavity(sim, pos.x, pos.y - BALANCE.a2a.spoilSink, pos.z)) return true;
  const keep = BALANCE.a2a.spoilBrush + 1.6;
  for (const col of sim.colonies) {
    for (const e of col.entrances) {
      if (e < 0) continue;
      sim.world.cellCenter(e, _pe);
      if (Math.hypot(_pe.x - pos.x, _pe.y - pos.y, _pe.z - pos.z) < keep) return true;
    }
  }
  return false;
}

/**
 * Drop the carried pellet where the ant stands. Outdoors with head-room (and not on top of an
 * entrance) this performs a small `fill` — the mound grows; anywhere else the pellet vanishes.
 * Returns true if mound material was added. No-op (false) if the ant carries no pellet.
 */
export function dropSpoil(sim: SimState, ant: Ant, pack = false): boolean {
  const c = ant.carrying;
  if (!c || c.kind !== 'bulk' || c.itemKind !== 'debris') return false;
  ant.carrying = null;
  const ctx = ctxOf(sim);
  ctx.stats.pelletsDropped++;
  ctx.pellets[ant.colony] = (ctx.pellets[ant.colony] ?? 0) + 1;
  const nav = sim.nav as NavEx;
  const B = BALANCE.a2a;
  const w = sim.world;
  if (pack) {
    // final round — a POSSESSED ant's pellet always lands: it is packed against the surface just
    // ahead of her feet, indoors too (the player dug it, the player decides where it goes; the
    // fill itself refuses occupied cells, so she cannot wall herself or a nestmate in solid)
    if (ant.cell < 0 || ant.falling) return false;
    _p.x = ant.pos.x + ant.forward.x * 0.9 - ant.up.x * B.spoilSink;
    _p.y = ant.pos.y + ant.forward.y * 0.9 - ant.up.y * B.spoilSink;
    _p.z = ant.pos.z + ant.forward.z * 0.9 - ant.up.z * B.spoilSink;
    const res = w.fill(_p, B.spoilBrush, c.material === Mat.Air ? Mat.Soil : c.material);
    if (res.addedCells <= 0 && res.touchedCells <= 0) return false;
    ctx.stats.filledVoxels += res.addedCells;
    sim.emit({ type: 'build', tick: sim.tick, by: ant.id, pos: v3clone(_p), radius: B.spoilBrush, material: c.material === Mat.Air ? Mat.Soil : c.material });
    return true;
  }
  if (ant.cell < 0 || ant.falling || !nav.isExposed(ant.cell) || ant.up.y < 0.5) return false;
  if (ant.pos.y + B.spoilHeadroom > w.sy - 1) return false;
  if (nearProtected(sim, ant.pos)) return false;
  const material = c.material === Mat.Air ? Mat.Soil : c.material;
  _p.x = ant.pos.x;
  _p.y = ant.pos.y - B.spoilSink;
  _p.z = ant.pos.z;
  // Spread the pellets: drop on the LOWEST column near the ant (ties broken by a deterministic
  // jitter), so repeated drops fill the mound's flanks into a rounded cone instead of stacking
  // a spike on one cell.
  {
    const ax = Math.floor(ant.pos.x);
    const az = Math.floor(ant.pos.z);
    const h0 = nav.skyHeight(ax, az);
    const n = ctx.pellets[ant.colony] ?? 0;
    let bestH = h0;
    let bestK = 2;
    let bx = ax;
    let bz = az;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if ((dx === 0 && dz === 0) || dx * dx + dz * dz > 5) continue;
        const x = ax + dx;
        const z = az + dz;
        if (x < 2 || z < 2 || x >= w.sx - 2 || z >= w.sz - 2) continue;
        const h = nav.skyHeight(x, z);
        if (h > h0 || h < h0 - 3) continue; // never uphill, never down a hole
        const k = hash01(n, x * 31 + z, ant.id);
        if (h < bestH || (h === bestH && k < bestK)) {
          _q.x = x + 0.5;
          _q.y = ant.pos.y - (h0 - h);
          _q.z = z + 0.5;
          if (nearProtected(sim, _q)) continue;
          bestH = h;
          bestK = k;
          bx = x;
          bz = z;
        }
      }
    if (bx !== ax || bz !== az) {
      _p.x = bx + 0.5;
      _p.z = bz + 0.5;
      _p.y = ant.pos.y - (h0 - bestH) - B.spoilSink;
    }
  }
  const res = w.fill(_p, B.spoilBrush, material);
  if (res.addedCells <= 0 && res.touchedCells <= 0) return false;
  ctx.stats.moundVoxels += res.addedCells;
  ctx.stats.filledVoxels += res.addedCells;
  sim.emit({ type: 'build', tick: sim.tick, by: ant.id, pos: v3clone(_p), radius: B.spoilBrush, material });
  return true;
}

const SP_CELL = 'a2a.sp.c';
const SP_FAIL = 'a2a.sp.f';

/**
 * Carry the pellet out and drop it on the spoil ring: call every tick while `hasSpoil(ant)`.
 * 'none' = no pellet; 'hauling' = on the way; 'dropped' = pellet dropped this tick.
 */
export function runSpoilHaul(sim: SimState, ant: Ant): 'none' | 'hauling' | 'dropped' {
  if (!hasSpoil(ant)) return 'none';
  const mem = ant.mem;
  let cell = mem[SP_CELL] ?? -1;
  if (cell < 0 || !sim.nav.isWalkable(cell)) {
    cell = spoilDropCell(sim, ant);
    mem[SP_CELL] = cell;
    mem[SP_FAIL] = 0;
  }
  const finish = (): 'dropped' => {
    dropSpoil(sim, ant);
    mem[SP_CELL] = -1;
    ant.intent.mode = 'none';
    return 'dropped';
  };
  if (cell < 0) return finish(); // no way out: pack it into the wall right here
  sim.world.cellCenter(cell, _q);
  const d = Math.hypot(_q.x - ant.pos.x, _q.y - ant.pos.y, _q.z - ant.pos.z);
  if (d < 1.4) return finish();
  const it = ant.intent;
  it.mode = 'goto';
  it.goal = cell;
  it.speedMul = 1;
  const p = ant.path;
  if (p.goal === cell) {
    if (p.status === 'arrived') return finish();
    if (p.status === 'failed') {
      const f = (mem[SP_FAIL] ?? 0) + 1;
      mem[SP_FAIL] = f;
      if (f > 90) return finish();
    }
  }
  return 'hauling';
}

// ---- reference duty ------------------------------------------------------------------------

const DG_SITE = 'a2a.dg.s';

export interface DigDutyOptions {
  kind?: 'dig' | 'build';
  /** Restrict to one designation (0 = any of the colony's). */
  designationId?: number;
  /** Call `finishDesignation` when a designation the ant worked on has no sites left. Default true. */
  autoFinish?: boolean;
  /** Build without consuming material. */
  free?: boolean;
}

function finishIfComplete(sim: SimState, designationId: number): void {
  const plan = ctxOf(sim).plans.get(designationId);
  if (plan && plan.left <= 0) finishDesignation(sim, plan.d);
}

/**
 * The complete dig (or build) job for one ant, one call per tick — see the file header.
 * Sets `ant.intent`. Returns 'done' when there is nothing (reachable) left to do.
 */
export function runDigDuty(sim: SimState, ant: Ant, dt: number, opts?: DigDutyOptions): DigDutyState {
  const kind = opts?.kind ?? 'dig';
  const mem = ant.mem;
  if (kind === 'dig') {
    if (hasSpoil(ant)) {
      runSpoilHaul(sim, ant);
      return 'toSpoil';
    }
    if (ant.carrying) {
      ant.intent.mode = 'none';
      return 'idle'; // mandibles full of something else: not our business
    }
  }
  let site = mem[DG_SITE] ? getWorkSite(sim, mem[DG_SITE]) : null;
  if (site && site.reservedBy !== ant.id) site = null;
  if (!site) {
    site = claimWorkSite(sim, ant, kind, opts?.designationId ?? 0);
    if (!site) {
      mem[DG_SITE] = 0;
      ant.intent.mode = 'none';
      if (opts?.autoFinish !== false) {
        const colony = sim.getColony(ant.colony);
        if (colony) for (let i = colony.designations.length - 1; i >= 0; i--) if (colony.designations[i].kind === kind) finishIfComplete(sim, colony.designations[i].id);
      }
      return 'done';
    }
    mem[DG_SITE] = site.id;
  }
  const res = kind === 'dig' ? applyDigWork(sim, ant, site, dt) : applyBuildWork(sim, ant, site, dt, opts?.free);
  if (res === 'working') return 'working';
  if (res === 'outOfReach') {
    if (site.cell < 0 || !sim.nav.isWalkable(site.cell)) {
      // the excavation moved on and the standing cell is gone: look again
      const r = resolve(sim, site.id);
      if (r) {
        r.plan.checkedSeq[r.i] = -1;
        examine(sim, sim.nav as NavEx, r.plan, r.i);
        site.cell = r.plan.stand[r.i];
      }
      if (!r || site.cell < 0) {
        releaseWorkSite(sim, ant);
        mem[DG_SITE] = 0;
        ant.intent.mode = 'none';
        return 'idle';
      }
    }
    const it = ant.intent;
    it.mode = 'goto';
    it.goal = site.cell;
    it.speedMul = 1;
    const p = ant.path;
    if (p.goal === site.cell && (p.status === 'failed' || p.status === 'arrived')) {
      // cannot get there (or the stand cell was not close enough after all): skip it for a while
      reportUnreachable(sim, site.id);
      releaseWorkSite(sim, ant);
      mem[DG_SITE] = 0;
      it.mode = 'none';
      return 'idle';
    }
    return 'toSite';
  }
  // done / invalid / carrying / noMaterial / blocked
  if (res === 'blocked') return 'working';
  mem[DG_SITE] = 0;
  if (res === 'done' || res === 'invalid') {
    if (opts?.autoFinish !== false) finishIfComplete(sim, site.designationId);
    return res === 'done' && kind === 'dig' ? 'toSpoil' : 'idle';
  }
  releaseWorkSite(sim, ant);
  ant.intent.mode = 'none';
  return res === 'noMaterial' ? 'done' : 'idle';
}

/** Call from a behavior's `exit`: releases the reservation and clears the duty's memory. */
export function stopDigDuty(sim: SimState, ant: Ant): void {
  releaseWorkSite(sim, ant);
  ant.mem[DG_SITE] = 0;
  ant.mem[SP_CELL] = -1;
  if (ant.anim === 'dig') ant.anim = 'idle';
}

export function digStats(sim: SimState): DigStats {
  const ctx = ctxOf(sim);
  let pending = 0;
  let reserved = 0;
  for (const plan of ctx.plans.values()) {
    pending += plan.left;
    for (let i = 0; i < plan.total; i++) if (plan.state[i] === PENDING && plan.reservedBy[i]) reserved++;
  }
  const s = ctx.stats;
  s.pendingSites = pending;
  s.reservedSites = reserved;
  s.designations = ctx.plans.size;
  return { ...s };
}

/**
 * Dig system: housekeeping only (the work itself happens in the API calls above, driven by
 * behaviors). Every second it creates plans for new designations, drops plans of removed ones
 * and expires reservations whose ant died or wandered off.
 */
export const digSystem: SimSystem = {
  id: 'dig',
  update(sim) {
    if (sim.tick % 30 !== 0) return;
    const ctx = ctxOf(sim);
    for (const colony of sim.colonies) if (colony.designations.length > 0) syncPlans(sim, ctx, colony);
    if (ctx.plans.size === 0) return;
    prunePlans(sim, ctx);
    for (const plan of ctx.plans.values()) {
      for (let i = 0; i < plan.total; i++) {
        const by = plan.reservedBy[i];
        if (by && !reservationLive(sim, plan, i)) {
          plan.reservedBy[i] = 0;
          if (ctx.byAnt.get(by) === plan.d.id * SITE_STRIDE + i) ctx.byAnt.delete(by);
        }
      }
    }
  },
};
