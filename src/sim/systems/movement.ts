import { MOVE_SPEED_KEY, v3, v3clone, type Ant, type Creature, type Mover, type PathState, type SimState, type SimSystem, type SpeedModifier, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste } from '../data/species';
import { CRAWL_BLOCKED, CRAWL_EMBEDDED, CRAWL_LOST, crawlStep, moverCell, snapToSurface } from './movementCrawl';
import { samplerFor } from './movementField';
import { flyStep } from './movementFly';

/**
 * D11 movement system.
 *
 *  - `surface` movers: crawl kernel (`movementCrawl.ts`) along the intent, path following with
 *    an unstuck ladder, soft ant–ant separation, speed modifiers.
 *  - `fly` movers: `movementFly.ts` (air steering, raycast avoidance, hover / land).
 *  - `static` movers: never move on their own; they are kept glued to the surface when the
 *    world is edited under them and start a D12 fall when their support disappears.
 *
 * SPEED MODIFIERS (for other streams — no need to edit this file):
 *   effective speed = mover.speed × intent.speedMul
 *                     × mover.mem['mv.speed'] (MOVE_SPEED_KEY, per entity, default 1)
 *                     × terrain factor (B.terrainSpeed[material walked on])
 *                     × carry factor   (1 − B.carrySlow × load; 0 by default because
 *                                       A2b applies its own carry penalty through speedMul)
 *                     × every global scale set with `setSpeedScale(sim, key, value)`
 *                     × every modifier registered with `registerSpeedModifier(sim, fn)`
 *   Global scales are for whole-map effects (cold night: `setSpeedScale(sim, 'cold', 0.7)`),
 *   the mem key for per-entity effects (glue, wounds), modifiers for anything positional
 *   (wet ground near a puddle). All of it is plain deterministic sim state.
 *
 * UNSTUCK LADDER (path followers; counters live on `mover.path`):
 *   1. no progress for `sidestepTicks`  → side-step (alternating sides) while pushing on
 *   2. no progress for `bridgeTicks`    → if the waypoint is close with open air in between
 *                                          (the far wall of a crevice / a facing surface) step
 *                                          straight across
 *   3. no progress for `stuckTicks`     → re-plan from the current cell
 *   4. `maxReplans` re-plans without reaching a waypoint → snap to the nearest walkable cell
 *      and report the path as `failed` (retry after `pathRetryTicks`)
 *   Movers that end inside solid are snapped out at once; movers that lose the surface fall.
 *
 * SEPARATION: every surface mover is pushed away from neighbours whose bodies overlap its own
 * (a fine per-tick hash grid, see below), along its tangent plane. The push is capped at a fraction of the
 * mover's own speed, so traffic compresses and overlaps under pressure instead of gridlocking;
 * oncoming traffic adds a keep-right bias so opposing streams sort into lanes.
 */

/** Runtime fields this system adds to `PathState` (created lazily; behaviors never touch them). */
export interface PathStateEx extends PathState {
  /** Re-plans since a waypoint was last reached. */
  replans?: number;
  /** M3 wedge detector: goal it tracks, best straight distance to it so far, re-plans without beating it. */
  wGoal?: number;
  wBest?: number;
  wN?: number;
  /** Consecutive partial paths towards the current goal. */
  partials?: number;
  /** `nav.editSeq` the current path was last validated against. */
  seq?: number;
  /** Waypoint cell the progress record below belongs to, and the closest the mover has been to it. */
  bW?: number;
  bD?: number;
  /** Waypoint cell that defeated the last re-plan, and how many re-plans in a row it has defeated. */
  fW?: number;
  fN?: number;
}

interface MoveCtx {
  scales: Map<string, number>;
  /** Product of `scales`. */
  scale: number;
  modifiers: SpeedModifier[];
}

const ctxs = new WeakMap<SimState, MoveCtx>();

function ctxOf(sim: SimState): MoveCtx {
  let c = ctxs.get(sim);
  if (!c) {
    c = { scales: new Map(), scale: 1, modifiers: [] };
    ctxs.set(sim, c);
  }
  return c;
}

/**
 * Set (or with `value === 1` clear) a named global speed multiplier for all surface and flying
 * movers of this sim. Call it whenever the value changes; it persists until changed.
 */
export function setSpeedScale(sim: SimState, key: string, value: number): void {
  const c = ctxOf(sim);
  if (value === 1 || !(value >= 0)) c.scales.delete(key);
  else c.scales.set(key, value);
  let s = 1;
  for (const v of c.scales.values()) s *= v;
  c.scale = s;
}

/** Register a per-mover speed modifier (called once per moving mover per tick — keep it cheap). */
export function registerSpeedModifier(sim: SimState, fn: SpeedModifier): () => void {
  const c = ctxOf(sim);
  c.modifiers.push(fn);
  return () => {
    const i = c.modifiers.indexOf(fn);
    if (i >= 0) c.modifiers.splice(i, 1);
  };
}

// Module-local copies of hot imported bindings (imports are live lookups on every use).
const B = BALANCE.a2a;
const SPEED_KEY = MOVE_SPEED_KEY;
const crawl = crawlStep;
const cellOf = moverCell;
const fieldOf = samplerFor;

const _c = v3();
const _wish = v3();
const _g = v3();
const _sep = v3();
const _dirv = v3();

/** Fills `_wish` with the direction to the current path waypoint; advances/finishes the path. */
function followPath(sim: SimState, m: Mover): Vec3 | null {
  const p = m.path as PathStateEx;
  if (p.status !== 'following' || !p.cells) return null;
  const cells = p.cells;
  const w = sim.world;
  const f = fieldOf(w);
  for (;;) {
    w.cellCenter(cells[p.index], _c);
    const dx = _c.x - m.pos.x;
    const dy = _c.y - m.pos.y;
    const dz = _c.z - m.pos.z;
    // Waypoints are cell centres, up to ~1 voxel off the ride surface — and in a narrow tunnel
    // the A* path may hop to cells that hug the opposite wall (26-adjacent cells, but several
    // units apart along the surface). So "reached" is judged by tangential distance, with a
    // loose normal tolerance when the waypoint sits on a surface FACING ours across open air.
    const dn = dx * m.up.x + dy * m.up.y + dz * m.up.z;
    const tx = dx - m.up.x * dn;
    const ty = dy - m.up.y * dn;
    const tz = dz - m.up.z * dn;
    const dt2 = tx * tx + ty * ty + tz * tz;
    const last = p.index >= cells.length - 1;
    // A string-pulled leg (next waypoint not adjacent to this one) is only valid from this
    // waypoint's own face, so before turning onto one the mover must really be there — not
    // merely level with it on a neighbouring face.
    const strict = !last && !adjacent(w.sx, w.sz, cells[p.index], cells[p.index + 1]);
    let reached = false;
    if (strict) {
      if (dt2 < 0.36 && dn < 1.15 && dn > -0.3) {
        f.gradient(_c.x, _c.y, _c.z, _g);
        const gl = Math.hypot(_g.x, _g.y, _g.z);
        reached = gl > 0.2 && -(_g.x * m.up.x + _g.y * m.up.y + _g.z * m.up.z) / gl > 0.6;
      }
    } else if (dt2 < (last ? 0.25 : 0.42)) {
      if (dn < 1.25 && dn > -1.25) reached = true;
      else if (dn > 0 && dn < 4.2) {
        f.gradient(_c.x, _c.y, _c.z, _g);
        const gl = Math.hypot(_g.x, _g.y, _g.z);
        // waypoint surface normal (−g) opposes our up → it is the other wall of a tunnel/gap
        const facing = gl > 0.2 && (_g.x * m.up.x + _g.y * m.up.y + _g.z * m.up.z) / gl > 0.5;
        reached = facing && f.sample(m.pos.x + dx * 0.33, m.pos.y + dy * 0.33, m.pos.z + dz * 0.33) < -0.05 && f.sample(m.pos.x + dx * 0.66, m.pos.y + dy * 0.66, m.pos.z + dz * 0.66) < -0.05;
      }
    }
    if (reached || (m.cell === cells[p.index] && (!strict || dt2 < 0.36))) {
      if (last) {
        if (reached || dt2 < 0.6) {
          // A partial path ends short of the goal: request again from here.
          p.status = cells[p.index] === p.goal ? 'arrived' : 'none';
          p.cells = null;
          p.replans = 0;
          return null;
        }
      } else {
        p.index++;
        p.stuck = 0;
        // forgive re-plans only gradually: a mover that keeps reaching one waypoint and then
        // wedging again must still climb the unstuck ladder
        const rp = p.replans ?? 0;
        p.replans = rp > 0.34 ? rp - 0.34 : 0;
        continue;
      }
    }
    _wish.x = dx;
    _wish.y = dy;
    _wish.z = dz;
    // Waypoint mostly "above" us along our normal: it sits on another surface that meets ours
    // in a concave junction (on a stem, next waypoint out on the ground). The straight direction
    // has almost no tangent component, so also head *into* the waypoint's surface (+gradient =
    // −its normal), which on our tangent plane points at the junction.
    if (dn > 0 && dt2 < 0.2 * (dt2 + dn * dn)) {
      f.gradient(_c.x, _c.y, _c.z, _g);
      const gl = Math.hypot(_g.x, _g.y, _g.z);
      if (gl > 0.2) {
        const k = (dn * 1.5) / gl;
        _wish.x += _g.x * k;
        _wish.y += _g.y * k;
        _wish.z += _g.z * k;
      }
    }
    return _wish;
  }
}

/** Are two cells 26-neighbours (or the same cell)? */
function adjacent(sx: number, sz: number, a: number, b: number): boolean {
  const sxz = sx * sz;
  const ay = (a / sxz) | 0;
  const ar = a - ay * sxz;
  const az = (ar / sx) | 0;
  const by = (b / sxz) | 0;
  const br = b - by * sxz;
  const bz = (br / sx) | 0;
  const dx = ar - az * sx - (br - bz * sx);
  const dy = ay - by;
  const dz = az - bz;
  return dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && dz >= -1 && dz <= 1;
}

function startFall(sim: SimState, m: Mover): void {
  m.falling = true;
  m.cell = -1;
  m.moveSpeed = 0;
  if (m.path.ticket) sim.nav.cancelPath(m.path.ticket);
  m.path.ticket = 0;
  m.path.status = 'none';
  m.path.cells = null;
  sim.emit({ type: 'fell', tick: sim.tick, id: m.id, pos: v3clone(m.pos) });
}

// ---- separation grid -----------------------------------------------------------------------
// A throw-away hash grid over this tick's surface movers with 1-voxel cells, rebuilt at the start
// of the movement update. It answers "who overlaps me" in a handful of lookups even inside a
// packed nest chamber, where the sim's coarse spatial hash (4-voxel cells, built for perception
// queries) would hand back every ant in the room. Big bodies (radius > BIG_RADIUS) are few and
// are kept in a short list that everyone checks.
const GRID_SIZE = 1 << 13;
const GRID_MASK = GRID_SIZE - 1;
const BIG_RADIUS = 0.5;
const gridHead = new Int32Array(GRID_SIZE);
let gridNext = new Int32Array(1024);
/** Cell each entry was filed under (movers move while the grid is in use). */
let gridCell = new Int32Array(1024 * 3);
let gridCount = 0;
const gridMovers: Mover[] = [];
const bigMovers: Mover[] = [];

function gridKey(ix: number, iy: number, iz: number): number {
  return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & GRID_MASK;
}

function gridAdd(m: Mover): void {
  if (!m.alive || m.falling || m.locomotion === 'fly') return;
  if (m.rideHeight * B.sepRadiusPerRide > BIG_RADIUS) {
    bigMovers.push(m);
    return;
  }
  const i = gridCount++;
  if (i >= gridNext.length) {
    const n = new Int32Array(gridNext.length * 2);
    n.set(gridNext);
    gridNext = n;
    const c = new Int32Array(gridCell.length * 2);
    c.set(gridCell);
    gridCell = c;
  }
  gridMovers[i] = m;
  const ix = Math.floor(m.pos.x);
  const iy = Math.floor(m.pos.y);
  const iz = Math.floor(m.pos.z);
  gridCell[i * 3] = ix;
  gridCell[i * 3 + 1] = iy;
  gridCell[i * 3 + 2] = iz;
  const k = gridKey(ix, iy, iz);
  gridNext[i] = gridHead[k];
  gridHead[k] = i;
}

function gridBuild(sim: SimState): void {
  gridHead.fill(-1);
  gridCount = 0;
  bigMovers.length = 0;
  const ants = sim.ants;
  for (let i = 0; i < ants.length; i++) gridAdd(ants[i]);
  const cr = sim.creatures;
  for (let i = 0; i < cr.length; i++) gridAdd(cr[i]);
  gridMovers.length = gridCount;
}

/** Body radius used for separation. */
function bodyRadius(m: Mover): number {
  return m.rideHeight * B.sepRadiusPerRide;
}

// accumulators shared by `separation` and `sepWith`
let sPx = 0;
let sPy = 0;
let sPz = 0;
let sDeep = 0;
let sLane = 0;
let sWx = 0;
let sWy = 0;
let sWz = 0;
let sHasWish = false;
let sMelee = false;
let sMeleeTick = 0;
/** Written by the melee footwork (behaviors/fightCommon.ts `MELEE_MEM`). */
const MELEE_KEY = 'ft.m';
const FB = BALANCE.b1.fight;

function sepWith(m: Mover, r: number, o: Mover): void {
  if (o === m) return;
  let dx = m.pos.x - o.pos.x;
  let dy = m.pos.y - o.pos.y;
  let dz = m.pos.z - o.pos.z;
  const ro = o.rideHeight * B.sepRadiusPerRide;
  // two ants in melee keep a wider berth (a battle line, not a heap)
  const rr = sMelee && ((o as Ant).mem?.[MELEE_KEY] ?? -9) >= sMeleeTick ? (r + ro) * FB.meleeSepRadius : r + ro;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= rr * rr) return;
  let d = Math.sqrt(d2);
  let coincident = false;
  if (d < 1e-4) {
    // exactly coincident: pick a deterministic direction from the ids
    const a = (((Math.imul(m.id, 0x9e3779b1) + Math.imul(o.id, 40503)) >>> 0) / 4294967296) * 6.2831853;
    dx = Math.cos(a);
    dy = 0;
    dz = Math.sin(a);
    d = 1;
    coincident = true;
    // the pair must move apart, not in lockstep
    if (m.id < o.id) {
      dx = -dx;
      dz = -dz;
    }
  }
  const overlap = coincident ? 1 : 1 - d / rr;
  if (overlap > sDeep) sDeep = overlap;
  // bigger bodies shove smaller ones, not the other way round
  let k = ro / r;
  k = k >= 1 ? 1 : k * k;
  const wgt = (overlap * k) / d;
  sPx += dx * wgt;
  sPy += dy * wgt;
  sPz += dz * wgt;
  if (sHasWish) {
    // oncoming: the other is ahead of us and faces against our direction of travel
    const ahead = -(dx * sWx + dy * sWy + dz * sWz);
    const facing = o.forward.x * sWx + o.forward.y * sWy + o.forward.z * sWz;
    if (ahead > 0 && facing < -0.3 && o.moveSpeed > 0.05) sLane += overlap * k;
  }
}

/**
 * Soft separation: accumulates into `_sep` the push (in units of "own speed", length ≤ 1) away
 * from overlapping neighbours, plus a keep-right bias against oncoming traffic when `wish` is
 * given. Returns the deepest overlap 0..1 (0 = nobody close).
 */
function separation(m: Mover, wish: Vec3 | null, melee = false, tick = 0): number {
  const r = bodyRadius(m);
  sMelee = melee;
  sMeleeTick = tick - 3;
  sPx = sPy = sPz = 0;
  sDeep = 0;
  sLane = 0;
  sHasWish = false;
  if (wish) {
    const wl = Math.hypot(wish.x, wish.y, wish.z);
    if (wl > 1e-6) {
      sWx = wish.x / wl;
      sWy = wish.y / wl;
      sWz = wish.z / wl;
      sHasWish = true;
    }
  }
  // small bodies: grid cells overlapping the sphere of radius r + BIG_RADIUS around us
  const q = r + BIG_RADIUS;
  const x0 = Math.floor(m.pos.x - q);
  const x1 = Math.floor(m.pos.x + q);
  const y0 = Math.floor(m.pos.y - q);
  const y1 = Math.floor(m.pos.y + q);
  const z0 = Math.floor(m.pos.z - q);
  const z1 = Math.floor(m.pos.z + q);
  for (let iy = y0; iy <= y1; iy++)
    for (let iz = z0; iz <= z1; iz++)
      for (let ix = x0; ix <= x1; ix++) {
        for (let i = gridHead[gridKey(ix, iy, iz)]; i >= 0; i = gridNext[i]) {
          // hash collisions put other cells' movers in this chain: only take the cell's own
          if (gridCell[i * 3] !== ix || gridCell[i * 3 + 1] !== iy || gridCell[i * 3 + 2] !== iz) continue;
          sepWith(m, r, gridMovers[i]);
        }
      }
  for (let i = 0; i < bigMovers.length; i++) sepWith(m, r, bigMovers[i]);
  if (sDeep <= 0) return 0;
  let px = sPx;
  let py = sPy;
  let pz = sPz;
  if (sLane > 0) {
    // right = wish × up
    const lane = sLane > 1 ? 1 : sLane;
    const k = lane * (B.sepLane / B.sepPush);
    px += (sWy * m.up.z - sWz * m.up.y) * k;
    py += (sWz * m.up.x - sWx * m.up.z) * k;
    pz += (sWx * m.up.y - sWy * m.up.x) * k;
  }
  // keep the push in the tangent plane and bounded
  const dn = px * m.up.x + py * m.up.y + pz * m.up.z;
  px -= m.up.x * dn;
  py -= m.up.y * dn;
  pz -= m.up.z * dn;
  const pl = Math.hypot(px, py, pz);
  if (pl > 1) {
    px /= pl;
    py /= pl;
    pz /= pl;
  }
  _sep.x = px;
  _sep.y = py;
  _sep.z = pz;
  return sDeep;
}

/** Product of every speed modifier for one mover (see the header). */
function speedFactor(sim: SimState, ctx: MoveCtx, m: Mover, isAnt: boolean): number {
  let k = ctx.scale;
  const own = (m as Ant | Creature).mem[SPEED_KEY];
  if (own !== undefined) k *= own;
  if (m.locomotion === 'surface') {
    const w = sim.world;
    const cell = w.cellAt(m.pos.x - m.up.x * 0.6, m.pos.y - m.up.y * 0.6, m.pos.z - m.up.z * 0.6);
    if (cell >= 0) k *= B.terrainSpeed[w.material[cell]] ?? 1;
    if (isAnt && B.carrySlow > 0) {
      const a = m as Ant;
      if (a.carrying) {
        const cap = getCaste(a.species, a.caste).carryCapacity;
        const load = cap > 0 ? Math.min(1, Math.max(0.3, a.carrying.amount / cap)) : 1;
        k *= 1 - B.carrySlow * load;
      }
    }
  }
  const mods = ctx.modifiers;
  for (let i = 0; i < mods.length; i++) k *= mods[i](m, sim);
  return k > 0 ? k : 0;
}

/** Step 2 of the unstuck ladder: walk straight through open air to a close waypoint. */
function tryBridge(sim: SimState, m: Mover, speed: number, dt: number): boolean {
  const p = m.path;
  if (!p.cells) return false;
  const f = samplerFor(sim.world);
  sim.world.cellCenter(p.cells[p.index], _c);
  const dx = _c.x - m.pos.x;
  const dy = _c.y - m.pos.y;
  const dz = _c.z - m.pos.z;
  const d = Math.hypot(dx, dy, dz);
  if (d > 2.7 || d < 1e-3) return false;
  // open air all the way?
  if (f.sample(m.pos.x + dx * 0.33, m.pos.y + dy * 0.33, m.pos.z + dz * 0.33) > -0.05) return false;
  if (f.sample(m.pos.x + dx * 0.66, m.pos.y + dy * 0.66, m.pos.z + dz * 0.66) > -0.05) return false;
  const step = Math.min(d, Math.max(speed, m.speed * 0.5) * dt);
  const k = step / d;
  m.pos.x += dx * k;
  m.pos.y += dy * k;
  m.pos.z += dz * k;
  m.moveSpeed = step / dt;
  if (d - step < 0.3) {
    // across: let the normal follower take over (it sees the waypoint as reached)
    m.cell = p.cells[p.index];
    p.stuck = 0;
  }
  return true;
}

function moveSurface(sim: SimState, ctx: MoveCtx, m: Mover, dt: number, possessed: boolean, isAnt: boolean): void {
  const it = m.intent;
  const p = m.path as PathStateEx;
  let wish: Vec3 | null = null;
  if (it.mode === 'dir') wish = it.dir;
  else if (it.mode === 'goto') wish = followPath(sim, m);
  const following = wish !== null && it.mode === 'goto' && p.status === 'following';
  let speed = wish ? m.speed * it.speedMul * speedFactor(sim, ctx, m, isAnt) : 0;
  let before = 0;
  if (following) {
    // `_c` still holds the waypoint centre from followPath
    before = Math.hypot(m.pos.x - _c.x, m.pos.y - _c.y, m.pos.z - _c.z);
    if (p.stuck > B.bridgeTicks && tryBridge(sim, m, speed, dt)) return;
    if (p.stuck > B.sidestepTicks && wish) {
      // side-step: add a lateral component, flipping sides every half second
      const side = ((sim.tick + m.id * 7) / 15) & 1 ? 1 : -1;
      const wl = Math.hypot(wish.x, wish.y, wish.z) || 1;
      const k = 0.9 * side;
      _dirv.x = wish.x / wl + (wish.y * m.up.z - wish.z * m.up.y) / wl * k;
      _dirv.y = wish.y / wl + (wish.z * m.up.x - wish.x * m.up.z) / wl * k;
      _dirv.z = wish.z / wl + (wish.x * m.up.y - wish.y * m.up.x) / wl * k;
      wish = _dirv;
    }
  }

  // separation (possessed ants are steered by the player alone)
  let align = !possessed;
  if (!possessed) {
    const melee = isAnt && ((m as Ant).mem[MELEE_KEY] ?? -9) >= sim.tick - 3;
    const deepest = separation(m, wish, melee, sim.tick);
    if (deepest > 0) {
      if (wish && speed > 0) {
        const wl = Math.hypot(wish.x, wish.y, wish.z) || 1;
        const push = melee ? FB.meleeSepPush : B.sepPush;
        _dirv.x = wish.x / wl + _sep.x * push;
        _dirv.y = wish.y / wl + _sep.y * push;
        _dirv.z = wish.z / wl + _sep.z * push;
        // never faster than the unpushed speed; a head-on push slows, it cannot reverse
        const l = Math.hypot(_dirv.x, _dirv.y, _dirv.z);
        if (l < 1) speed *= l < 0.35 ? 0.35 : l;
        wish = _dirv;
      } else if (deepest > (melee ? 0.04 : 0.3) && m.speed > 0) {
        // resting: drift apart slowly, without turning to face the push (fighters: briskly)
        wish = _sep;
        speed = m.speed * (melee ? FB.meleeRestPush : B.sepRestPush) * deepest;
        align = false;
      }
    }
  }

  const flags = crawl(sim.world, m, wish, speed, dt, align);

  if (flags & CRAWL_EMBEDDED) {
    // unstuck fallback (§13): jump to the nearest walkable cell
    if (!snapToSurface(sim.world, sim.nav, m, 10)) startFall(sim, m);
    else if (p.status === 'following') p.status = 'none';
    return;
  }
  if (flags & CRAWL_LOST) {
    startFall(sim, m);
    return;
  }
  m.cell = cellOf(sim.world, sim.nav, m);

  if (following && p.status === 'following') {
    const c = sim.world.cellCenter(p.cells![p.index], _c);
    const after = Math.hypot(m.pos.x - c.x, m.pos.y - c.y, m.pos.z - c.z);
    // Progress means getting CLOSER THAN EVER to the waypoint, not merely closer than a tick
    // ago: a mover bouncing on the spot (advance, bounce back — a lip, a step, a pinch) or
    // circling the waypoint at full speed used to "make headway" half of the time, so its stuck
    // count barely rose and the unstuck ladder took half a minute to get anywhere.
    const wc = p.cells![p.index];
    if (p.bW !== wc || p.bD === undefined) {
      p.bW = wc;
      p.bD = before;
    }
    if (!(flags & CRAWL_BLOCKED) && after < p.bD - speed * dt * 0.2) {
      p.bD = after;
      if (p.stuck > 0) p.stuck -= 0.5;
    } else if (++p.stuck > B.stuckTicks) replan(sim, m, p);
    // `stuck` only resets when a waypoint is reached; it shrinks slowly while the mover makes
    // headway.
  }
}

/** Steps 3 and 4 of the unstuck ladder. */
function replan(sim: SimState, m: Mover, p: PathStateEx): void {
  const wp = p.cells && p.index < p.cells.length ? p.cells[p.index] : -1;
  p.stuck = 0;
  p.cells = null;
  // M3: net progress towards the goal across re-plans. `replans` is forgiven a little for every
  // waypoint reached, so a mover that keeps clearing two or three close waypoints and then
  // wedging at the same ragged spot never climbed the ladder at all.
  let wedged = false;
  if (p.goal >= 0) {
    sim.world.cellCenter(p.goal, _c);
    const dg = Math.hypot(_c.x - m.pos.x, _c.y - m.pos.y, _c.z - m.pos.z);
    if (p.wGoal !== p.goal || p.wBest === undefined || dg < p.wBest - 1.5) {
      p.wGoal = p.goal;
      p.wBest = dg;
      p.wN = 0;
    } else if ((p.wN = (p.wN ?? 0) + 1) >= B.maxReplans + 1) {
      wedged = true;
      p.wN = B.maxReplans - 1;
    }
  }
  // the same waypoint defeating two re-plans in a row is a step the crawl kernel cannot take
  // (fresh paths keep routing through it): go straight to the scramble below
  if (wp >= 0 && wp === p.fW) p.fN = (p.fN ?? 0) + 1;
  else {
    p.fW = wp;
    p.fN = 1;
  }
  const stubborn = (p.fN ?? 0) >= 2;
  const n = (p.replans ?? 0) + 1;
  if (n <= B.maxReplans && !wedged && !stubborn) {
    p.replans = n;
    p.status = 'none'; // the paths system requests a fresh path from the current cell
    return;
  }
  p.replans = 0;
  p.fN = 0;
  // M3, step 4a: the SAME close waypoint defeated every re-plan — the path is right (A* keeps
  // returning it) but the crawl kernel cannot take the step (a thin ledge left by digging: termites
  // gnawing a log stalled a whole colony's diggers at one such spot, forever). Scramble onto the
  // waypoint cell itself and carry on from there instead of giving up and coming straight back.
  if (wp >= 0 && sim.nav.isWalkable(wp, m.clearance)) {
    sim.world.cellCenter(wp, _c);
    if (Math.hypot(_c.x - m.pos.x, _c.y - m.pos.y, _c.z - m.pos.z) <= B.hopReach) {
      m.pos.x = _c.x;
      m.pos.y = _c.y;
      m.pos.z = _c.z;
      if (snapToSurface(sim.world, sim.nav, m, 2)) {
        p.status = 'none';
        return;
      }
    }
  }
  // last resort: re-seat the body on the nearest walkable cell and give up for a while
  snapToSurface(sim.world, sim.nav, m, 4);
  p.status = 'failed';
  p.retryAt = sim.tick + B.pathRetryTicks;
}

/** `static` movers: glued in place; follow the ground when it is edited, fall when it is gone. */
function moveStatic(sim: SimState, m: Mover): void {
  m.moveSpeed = 0;
  if ((sim.tick + m.id) % 8 !== 0) return;
  const flags = crawlStep(sim.world, m, null, 0, 0, false);
  if (flags & CRAWL_EMBEDDED) {
    if (!snapToSurface(sim.world, sim.nav, m, 6)) startFall(sim, m);
  } else if (flags & CRAWL_LOST) startFall(sim, m);
  else m.cell = moverCell(sim.world, sim.nav, m);
}

function moveOne(sim: SimState, ctx: MoveCtx, m: Mover, dt: number, possessed: boolean, isAnt: boolean): void {
  if (m.falling) return; // falling system
  if (m.locomotion === 'surface') moveSurface(sim, ctx, m, dt, possessed, isAnt);
  else if (m.locomotion === 'fly') flyStep(sim, m, dt, speedFactor(sim, ctx, m, isAnt));
  else moveStatic(sim, m);
}

/**
 * D11 movement: integrates every mover along its intent (see the header), follows paths, keeps
 * `cell` current and hands detached movers to the falling system. Possessed ants use the same
 * code path with heading driven by yaw input.
 */
export const movementSystem: SimSystem = {
  id: 'movement',
  update(sim, dt) {
    const ctx = ctxOf(sim);
    fieldOf(sim.world); // sync the field copy once per tick
    gridBuild(sim);
    for (const a of sim.ants) {
      if (!a.alive) continue;
      moveOne(sim, ctx, a, dt, a.possessed, true);
      setAnim(a);
    }
    for (const c of sim.creatures) if (c.alive) moveOne(sim, ctx, c, dt, false, false);
  },
};

function setAnim(a: Ant): void {
  if (a.locomotion === 'fly') {
    if (a.anim === 'idle' || a.anim === 'walk' || a.anim === 'carry' || a.anim === 'fly') a.anim = a.moveSpeed > 0.05 ? 'fly' : 'idle';
    return;
  }
  if (a.anim === 'idle' || a.anim === 'walk' || a.anim === 'carry' || a.anim === 'fly') a.anim = a.moveSpeed > 0.05 ? (a.carrying ? 'carry' : 'walk') : 'idle';
}
