import {
  HOME_UNREACHABLE,
  ISO,
  WALK_MIN_DENSITY,
  type CellIndex,
  type ColonyId,
  type DistanceField,
  type NavEx,
  type NavStats,
  type PathResult,
  type Tick,
  type Vec3,
  type VoxelWorld,
} from '../core';

/**
 * D15 navigation over walkable cells.
 *
 * Walkable = air cell whose centre is within ~1.1 voxels of a surface, i.e. density in
 * [WALK_MIN_DENSITY, ISO), and whose density gradient is well formed (not pinched in an acute
 * crevice). Because glass panes are baked into the density field this one test also makes cells
 * against a pane walkable. Open-map side boundaries never become walkable.
 *
 * Neighbourhood: 26 cells. A diagonal step is allowed only if at least one of the axis-aligned
 * intermediate cells is air, so paths cannot squeeze through solid corners.
 *
 * What lives here (A2a):
 *  - lazily cached walkability (invalidated per edit box; full resync when `world.version` moves
 *    without an edit notification, e.g. `markAllDirty`), cached clearance for big movers (D11)
 *  - A* (weighted, expansion cap, partial fallback) that is RESUMABLE: `process(budget)` spends
 *    at most `budget` node expansions per call and continues the same search next tick. Requests
 *    are served FIFO; the per-request cap bounds how long one request can hold the queue.
 *    Everything is budgeted in node counts, never wall-clock, so the sim stays deterministic.
 *  - cheap rejections before a search: unwalkable goal, goal sealed in a tiny pocket, and
 *    from/goal on different sides of an up-to-date distance field
 *  - string-pulling of queue results on near-planar patches (`smoothPath`)
 *  - path validation against edits (`editSeq`, `pathBroken`)
 *  - distance fields: Uint16 multi-source BFS, throttled, rebuilt incrementally into a shared
 *    back buffer and swapped in (readers always see a complete field). Home fields are distance
 *    fields keyed by colony; `field(key)` creates arbitrary others; `skyField()` is "distance to
 *    open sky".
 *  - sky exposure (`isExposed`) from a lazily maintained column height map
 */

// module-local copies of imported constants used in hot loops (imports are live lookups)
const UNREACH = HOME_UNREACHABLE;
const WALK_MIN = WALK_MIN_DENSITY;
const ISO_ = ISO;

const NB_DX = new Int8Array(26);
const NB_DY = new Int8Array(26);
const NB_DZ = new Int8Array(26);
const NB_AXES = new Int8Array(26);
const NB_COST = new Float32Array(26);
{
  let i = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue;
        const axes = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        NB_DX[i] = dx;
        NB_DY[i] = dy;
        NB_DZ[i] = dz;
        NB_AXES[i] = axes;
        NB_COST[i] = Math.sqrt(axes);
        i++;
      }
}

/** Minimum density-gradient length (per 2 voxels) for a walkable cell: |∇sdf| ≥ 0.5 — kept
 * well above the crawl kernel's own limit (MIN_GRADIENT 0.3, measured at the body) so paths stay
 * out of acute crevices the kernel refuses to enter. */
const WELL_FORMED_MIN = 0.5 * 128;
const WELL_FORMED_MIN2 = WELL_FORMED_MIN * WELL_FORMED_MIN;

const EMPTY_PATH = new Int32Array(0);
const FAILED: PathResult = { status: 'failed', cells: EMPTY_PATH };
const FOUND_EMPTY: PathResult = { status: 'found', cells: EMPTY_PATH };

/** Default per-request A* expansion cap (D15). */
export const PATH_MAX_EXPANSIONS = 30000;
/** Minimum ticks between rebuilds of one distance field after edits. */
export const HOME_REBUILD_INTERVAL = 30;
/** Heuristic weight (> 1 = greedier, fewer expansions, paths at most this much longer). */
const HEURISTIC_WEIGHT = 1.2;
/** Goal-side flood size used to detect goals sealed in a tiny pocket before a full search. */
const POCKET_PROBE = 48;
/** String-pulling looks at most this many waypoints ahead. */
const SMOOTH_LOOKAHEAD = 10;
/** Hard cap for `nearestWalkable` shells. */
const NEAREST_MAX_RADIUS = 24;
/** Largest number of clearance probes cached per cell (clearance up to 4). */
const CLEAR_MAX_PROBES = 8;
/** Number of recent edit boxes remembered for path validation. */
const EDIT_RING = 16;
/** Unclaimed path results (their mover died) are dropped after this many `process` calls. */
const RESULT_TTL = 600;

interface Request {
  ticket: number;
  from: CellIndex;
  to: CellIndex;
  clearance: number;
  smooth: boolean;
  cancelled: boolean;
}

class Field implements DistanceField {
  sources: CellIndex[] = [];
  dist: Uint16Array;
  dirty = true;
  built = false;
  nextRebuild: Tick = 0;
  version = 0;
  /** Sources are regenerated from this before each rebuild (sky field). */
  sourceFn: (() => CellIndex[]) | null = null;
  interval = HOME_REBUILD_INTERVAL;

  constructor(
    readonly key: string,
    private readonly nav: Nav,
    n: number,
  ) {
    this.dist = new Uint16Array(n).fill(UNREACH);
  }

  get ready(): boolean {
    return this.built;
  }

  get stale(): boolean {
    return this.dirty;
  }

  setSources(cells: readonly CellIndex[]): void {
    this.sources = cells.slice();
    this.dirty = true;
    this.nextRebuild = 0;
  }

  distance(cell: CellIndex): number {
    return cell < 0 ? UNREACH : this.dist[cell];
  }

  descend(cell: CellIndex): CellIndex {
    return this.nav.descendField(this, cell);
  }
}

export class Nav implements NavEx {
  private readonly w: VoxelWorld;
  private readonly den: Uint8Array;
  private readonly sx: number;
  private readonly sy: number;
  private readonly sz: number;
  private readonly sxz: number;
  private readonly n: number;
  private readonly nbOff = new Int32Array(26);

  /** 0 unknown · 1 walkable · 2 not walkable */
  private readonly walk: Uint8Array;
  /** Lazily allocated: 0 unknown, else 1 + number of clearance probes the cell passes. */
  private clear: Uint8Array | null = null;
  /** Lazily allocated column height map: y of the topmost solid cell + 1 (0 = none), -1 unknown. */
  private sky: Int16Array | null = null;
  private seenVersion: number;

  // A* scratch (generation-stamped so no clearing between searches)
  private readonly g: Float32Array;
  private readonly came: Int32Array;
  private readonly stamp: Uint32Array;
  private gen = 0;
  private heapCell: Int32Array = new Int32Array(1024);
  private heapF: Float32Array = new Float32Array(1024);
  private heapN = 0;

  // resumable search state
  private sFrom = -1;
  private sTo = -1;
  private sTx = 0;
  private sTy = 0;
  private sTz = 0;
  private sClear = 0;
  private sMax = 0;
  private sExp = 0;
  private sBest = -1;
  private sBestH = Infinity;
  private sResult: PathResult | null = null;

  private queue: Request[] = [];
  private qHead = 0;
  private active: Request | null = null;
  private activeRestart = false;
  private live = new Map<number, Request>();
  private results = new Map<number, PathResult>();
  /** `processCalls` value at which each unclaimed result was produced (same insertion order). */
  private resultBorn = new Map<number, number>();
  private processCalls = 0;
  private nextTicket = 1;

  private fields: Field[] = [];
  private homeFields: (Field | undefined)[] = [];
  private fieldByKey = new Map<string, Field>();
  private skyFieldRef: Field | null = null;
  private bfsQueue: Int32Array = new Int32Array(4096);
  private bfsHead = 0;
  private bfsTail = 0;
  private bfsField: Field | null = null;
  private back: Uint16Array | null = null;

  /** String-pull queue results (see `smoothPath`). */
  smoothing = true;
  /** Bumped by every world edit nav has seen. */
  editSeq = 0;
  /** AABB (cell coords, inclusive) of the most recent edits, ring of `EDIT_RING`. */
  private readonly editBox = new Int32Array(EDIT_RING * 6);

  /** M3: soft per-cell extra path cost (lazily allocated; see `setHazard`). */
  private hazard: Uint8Array | null = null;
  private hazardCount = 0;

  private statExpansions = 0;
  private statSearches = 0;
  private statFieldNodes = 0;
  private statFieldBuilds = 0;

  constructor(world: VoxelWorld) {
    this.w = world;
    this.den = world.density;
    this.sx = world.sx;
    this.sy = world.sy;
    this.sz = world.sz;
    this.sxz = world.sx * world.sz;
    const n = (this.n = world.sx * world.sy * world.sz);
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.walk = new Uint8Array(n);
    this.seenVersion = world.version;
    for (let i = 0; i < 26; i++) this.nbOff[i] = NB_DX[i] + this.sx * (NB_DZ[i] + this.sz * NB_DY[i]);
    world.onEdit((_res, center, radius) => this.onWorldEdit(center, radius));
  }

  // ---- world sync ----------------------------------------------------------------------

  private onWorldEdit(center: Vec3, radius: number): void {
    // an edit changes densities up to 2 voxels beyond the brush; walkability also reads the
    // 6-neighbourhood → invalidate one more cell.
    const reach = radius + 3;
    const x0 = Math.max(0, Math.floor(center.x - reach));
    const y0 = Math.max(0, Math.floor(center.y - reach));
    const z0 = Math.max(0, Math.floor(center.z - reach));
    const x1 = Math.min(this.sx - 1, Math.floor(center.x + reach));
    const y1 = Math.min(this.sy - 1, Math.floor(center.y + reach));
    const z1 = Math.min(this.sz - 1, Math.floor(center.z + reach));
    const walk = this.walk;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        const row = this.sx * (z + this.sz * y);
        walk.fill(0, row + x0, row + x1 + 1);
      }
    if (this.clear) this.clear.fill(0);
    const sky = this.sky;
    if (sky) for (let z = z0; z <= z1; z++) sky.fill(-1, x0 + this.sx * z, x1 + 1 + this.sx * z);
    const k = (this.editSeq % EDIT_RING) * 6;
    const b = this.editBox;
    b[k] = x0;
    b[k + 1] = y0;
    b[k + 2] = z0;
    b[k + 3] = x1;
    b[k + 4] = y1;
    b[k + 5] = z1;
    this.editSeq++;
    this.seenVersion = this.w.version;
    this.afterEdit();
  }

  private afterEdit(): void {
    for (const f of this.fields) f.dirty = true;
    if (this.active) this.activeRestart = true;
  }

  /** The world changed without an edit notification (generator writes + `markAllDirty`). */
  private resync(): void {
    this.seenVersion = this.w.version;
    this.walk.fill(0);
    if (this.clear) this.clear.fill(0);
    if (this.sky) this.sky.fill(-1);
    // everything may have changed: make every held path re-validate against the whole world
    const b = this.editBox;
    for (let i = 0; i < EDIT_RING; i++) {
      const k = i * 6;
      b[k] = b[k + 1] = b[k + 2] = 0;
      b[k + 3] = this.sx - 1;
      b[k + 4] = this.sy - 1;
      b[k + 5] = this.sz - 1;
    }
    this.editSeq += EDIT_RING;
    this.afterEdit();
  }

  notifyEdit(_changedChunks: readonly number[]): void {
    // Edits made through `world.dig/fill` were already handled by the edit listener; this only
    // has to catch external changes and make sure fields get rebuilt.
    if (this.w.version !== this.seenVersion) this.resync();
    else for (const f of this.fields) f.dirty = true;
  }

  // ---- walkability ---------------------------------------------------------------------

  get pendingCount(): number {
    return this.live.size;
  }

  isWalkable(cell: CellIndex, clearance = 0): boolean {
    if (cell < 0 || cell >= this.n) return false;
    if (this.w.version !== this.seenVersion) this.resync();
    let c = this.walk[cell];
    if (c === 0) c = this.walk[cell] = this.computeWalk(cell);
    if (c !== 1) return false;
    if (clearance <= 1) return true;
    return this.hasClearance(cell, clearance);
  }

  /** Walkability without the version check (hot loops call `isWalkable` once first). */
  private walkable(cell: CellIndex): boolean {
    const c = this.walk[cell];
    if (c !== 0) return c === 1;
    return (this.walk[cell] = this.computeWalk(cell)) === 1;
  }

  /**
   * Density band + well-formedness. The latter rejects cells pinched between two surfaces (acute
   * crevices, e.g. under a resting log) where the density gradient cancels out — locomotion
   * refuses to enter those (see movementCrawl).
   */
  private computeWalk(cell: CellIndex): number {
    const den = this.den;
    const d = den[cell];
    if (d >= ISO_ || d < WALK_MIN) return 2;
    const sx = this.sx;
    const sxz = this.sxz;
    const y = (cell / sxz) | 0;
    const r = cell - y * sxz;
    const z = (r / sx) | 0;
    const x = r - z * sx;
    let gx: number;
    let gy: number;
    let gz: number;
    if (x > 0 && y > 0 && z > 0 && x < sx - 1 && y < this.sy - 1 && z < this.sz - 1) {
      gx = den[cell + 1] - den[cell - 1];
      gy = den[cell + sxz] - den[cell - sxz];
      gz = den[cell + sx] - den[cell - sx];
    } else {
      const w = this.w;
      gx = w.densityAt(x + 1, y, z) - w.densityAt(x - 1, y, z);
      gy = w.densityAt(x, y + 1, z) - w.densityAt(x, y - 1, z);
      gz = w.densityAt(x, y, z + 1) - w.densityAt(x, y, z - 1);
    }
    // central difference over 2 voxels in density units: |∇sdf| = len / 128
    return gx * gx + gy * gy + gz * gz >= WELL_FORMED_MIN2 ? 1 : 2;
  }

  /**
   * Big movers (D11): the body sphere (centre pushed `clearance` out along the surface normal)
   * must be in air. The number of consecutive probes a cell passes is cached, so repeated
   * queries for any clearance are O(1).
   */
  private hasClearance(cell: CellIndex, clearance: number): boolean {
    let clear = this.clear;
    if (!clear) clear = this.clear = new Uint8Array(this.n);
    let c = clear[cell];
    if (c === 0) c = clear[cell] = 1 + this.clearanceProbes(cell);
    const need = Math.floor(clearance * 2);
    return c - 1 >= (need > CLEAR_MAX_PROBES ? CLEAR_MAX_PROBES : need);
  }

  private clearanceProbes(cell: CellIndex): number {
    const w = this.w;
    const y = (cell / this.sxz) | 0;
    const r = cell - y * this.sxz;
    const z = (r / this.sx) | 0;
    const x = r - z * this.sx;
    const cx = x + 0.5;
    const cy = y + 0.5;
    const cz = z + 0.5;
    // normal = -gradient
    let nx = w.sample(cx - 0.5, cy, cz) - w.sample(cx + 0.5, cy, cz);
    let ny = w.sample(cx, cy - 0.5, cz) - w.sample(cx, cy + 0.5, cz);
    let nz = w.sample(cx, cy, cz - 0.5) - w.sample(cx, cy, cz + 0.5);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-4) return 0;
    nx /= l;
    ny /= l;
    nz /= l;
    // The sdf is clamped at -2, so probe along the normal in steps: every probe must be at least
    // min(dist travelled, 1.2) away from solid.
    let ok = 0;
    for (let t = 1; t <= CLEAR_MAX_PROBES; t++) {
      const s = w.sample(cx + nx * t, cy + ny * t, cz + nz * t);
      if (s > -Math.min(t * 0.6, 1.2)) break;
      ok = t;
    }
    return ok;
  }

  nearestWalkable(x: number, y: number, z: number, maxRadius = 6, clearance = 0): CellIndex {
    if (!(x === x) || !(y === y) || !(z === z)) return -1;
    const ix = Math.min(this.sx - 1, Math.max(0, Math.floor(x)));
    const iy = Math.min(this.sy - 1, Math.max(0, Math.floor(y)));
    const iz = Math.min(this.sz - 1, Math.max(0, Math.floor(z)));
    const c0 = ix + this.sx * (iz + this.sz * iy);
    if (this.isWalkable(c0, clearance)) return c0;
    if (maxRadius > NEAREST_MAX_RADIUS) maxRadius = NEAREST_MAX_RADIUS;
    // Shells of growing Chebyshev radius. A cell in shell r is at Euclidean distance ≥ r - 0.5
    // from the query, so once a hit at distance d is known only shells with r - 0.5 < d can
    // still hold something closer.
    let best = -1;
    let bestD = Infinity;
    for (let r = 1; r <= maxRadius; r++) {
      if (best >= 0 && (r - 0.5) * (r - 0.5) >= bestD) break;
      for (let dy = -r; dy <= r; dy++) {
        const yy = iy + dy;
        if (yy < 0 || yy >= this.sy) continue;
        for (let dz = -r; dz <= r; dz++) {
          const zz = iz + dz;
          if (zz < 0 || zz >= this.sz) continue;
          const shellYZ = dy === r || dy === -r || dz === r || dz === -r;
          for (let dx = -r; dx <= r; dx += shellYZ ? 1 : 2 * r) {
            const xx = ix + dx;
            if (xx < 0 || xx >= this.sx) continue;
            const c = xx + this.sx * (zz + this.sz * yy);
            if (!this.walkable(c)) continue;
            if (clearance > 1 && !this.hasClearance(c, clearance)) continue;
            const ddx = xx + 0.5 - x;
            const ddy = yy + 0.5 - y;
            const ddz = zz + 0.5 - z;
            const d = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
        }
      }
    }
    return best;
  }

  /** Can a mover step from cell `c` to its i-th neighbour? Target walkability is checked by the caller. */
  private canStep(c: CellIndex, i: number): boolean {
    const axes = NB_AXES[i];
    if (axes === 1) return true;
    const den = this.den;
    const ox = NB_DX[i];
    const oy = NB_DY[i] * this.sxz;
    const oz = NB_DZ[i] * this.sx;
    if (axes === 2) {
      // at least one axis-aligned intermediate must be air (all of them are in bounds because
      // the neighbour is)
      if (ox !== 0 && den[c + ox] < ISO_) return true;
      if (oy !== 0 && den[c + oy] < ISO_) return true;
      if (oz !== 0 && den[c + oz] < ISO_) return true;
      return false;
    }
    // A corner step needs an air staircase of axis steps (c → one axis → two axes → target).
    // One air face neighbour is not enough: it let paths through the diagonal pinch between two
    // solid cells that share an edge (a gap no body fits through), and movers circled at it.
    if (den[c + ox] < ISO_ && (den[c + ox + oy] < ISO_ || den[c + ox + oz] < ISO_)) return true;
    if (den[c + oy] < ISO_ && (den[c + oy + ox] < ISO_ || den[c + oy + oz] < ISO_)) return true;
    if (den[c + oz] < ISO_ && (den[c + oz + ox] < ISO_ || den[c + oz + oy] < ISO_)) return true;
    return false;
  }

  // ---- hazards --------------------------------------------------------------------------

  /**
   * M3: mark a cell as hazardous for path planning (deep water, an antlion's slope). `cost` (0..255,
   * in cell steps) is ADDED to the A* cost of entering the cell — paths go around when a detour
   * shorter than that exists and still cross when there is no other way. Walkability, distance
   * fields and steering are unaffected. 0 clears.
   */
  setHazard(cell: CellIndex, cost: number): void {
    if (cell < 0 || cell >= this.n) return;
    let hz = this.hazard;
    if (!hz) {
      if (cost <= 0) return;
      hz = this.hazard = new Uint8Array(this.n);
    }
    const v = cost <= 0 ? 0 : cost > 255 ? 255 : Math.round(cost);
    const old = hz[cell];
    if (old === v) return;
    if (old === 0) this.hazardCount++;
    else if (v === 0) this.hazardCount--;
    hz[cell] = v;
  }

  hazardAt(cell: CellIndex): number {
    return this.hazard && cell >= 0 && cell < this.n ? this.hazard[cell] : 0;
  }

  // ---- A* ------------------------------------------------------------------------------

  findPath(from: CellIndex, to: CellIndex, clearance = 0, maxExpansions = PATH_MAX_EXPANSIONS): PathResult {
    // The scratch arrays are shared with the queue's resumable search: restart that one later.
    if (this.active) this.activeRestart = true;
    if (!this.begin(from, to, clearance, maxExpansions)) this.runSearch(Infinity);
    const r = this.sResult!;
    this.sResult = null;
    return r;
  }

  /** Octile-style 3D heuristic to the current goal (admissible for 26-neighbour costs). */
  private h(x: number, y: number, z: number): number {
    let ax = x - this.sTx;
    let ay = y - this.sTy;
    let az = z - this.sTz;
    if (ax < 0) ax = -ax;
    if (ay < 0) ay = -ay;
    if (az < 0) az = -az;
    const mx = ax > ay ? (ax > az ? ax : az) : ay > az ? ay : az;
    const mn = ax < ay ? (ax < az ? ax : az) : ay < az ? ay : az;
    const md = ax + ay + az - mx - mn;
    return mn * 1.7320508 + (md - mn) * 1.4142136 + (mx - md);
  }

  /**
   * Sets up a search. Returns true if it was resolved immediately (`sResult` is set), false if
   * `runSearch` has to do work.
   */
  private begin(from: CellIndex, to: CellIndex, clearance: number, maxExpansions: number): boolean {
    this.sResult = null;
    this.statSearches++;
    if (from < 0 || to < 0 || from >= this.n || to >= this.n || !this.isWalkable(to, clearance)) {
      this.sResult = FAILED;
      return true;
    }
    if (from === to) {
      this.sResult = FOUND_EMPTY;
      return true;
    }
    if (clearance <= 1 && (this.fieldsDisagree(from, to) || this.sealedPocket(from, to))) {
      this.sResult = FAILED;
      return true;
    }
    const sx = this.sx;
    const sxz = this.sxz;
    const gen = ++this.gen;
    this.sFrom = from;
    this.sTo = to;
    this.sClear = clearance;
    this.sMax = maxExpansions;
    this.sExp = 0;
    this.sBest = from;
    this.sBestH = Infinity;
    this.sTy = (to / sxz) | 0;
    const tr = to - this.sTy * sxz;
    this.sTz = (tr / sx) | 0;
    this.sTx = tr - this.sTz * sx;
    this.heapN = 0;
    this.g[from] = 0;
    this.came[from] = -1;
    this.stamp[from] = gen * 2; // open
    const y = (from / sxz) | 0;
    const r = from - y * sxz;
    const z = (r / sx) | 0;
    this.push(from, this.h(r - z * sx, y, z) * HEURISTIC_WEIGHT);
    return false;
  }

  /**
   * True when an up-to-date distance field proves `from` and `to` are in different connected
   * components (one reaches the field's sources, the other does not).
   */
  private fieldsDisagree(from: CellIndex, to: CellIndex): boolean {
    for (const f of this.fields) {
      if (!f.built || f.dirty) continue;
      const a = f.dist[from] !== UNREACH;
      const b = f.dist[to] !== UNREACH;
      if (a !== b) return true;
    }
    return false;
  }

  /** Floods a few cells out from the goal: true if the goal's component is tiny and lacks `from`. */
  private sealedPocket(from: CellIndex, to: CellIndex): boolean {
    const mark = ++this.gen * 2;
    const stamp = this.stamp;
    const q = this.came; // free to use as scratch between searches
    let head = 0;
    let tail = 0;
    // `came` entries written here are overwritten by the real search before they are read.
    const base = this.n - POCKET_PROBE - 1; // park the tiny queue at the end of the array
    q[base + tail++] = to;
    stamp[to] = mark;
    const sx = this.sx;
    const sxz = this.sxz;
    while (head < tail) {
      const cur = q[base + head++];
      const y = (cur / sxz) | 0;
      const r = cur - y * sxz;
      const z = (r / sx) | 0;
      const x = r - z * sx;
      for (let i = 0; i < 26; i++) {
        const nx = x + NB_DX[i];
        const ny = y + NB_DY[i];
        const nz = z + NB_DZ[i];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= this.sy || nz >= this.sz) continue;
        const nc = cur + this.nbOff[i];
        if (stamp[nc] === mark || !this.walkable(nc) || !this.canStep(cur, i)) continue;
        if (nc === from) return false;
        if (tail >= POCKET_PROBE) return false; // big enough: let A* decide
        stamp[nc] = mark;
        q[base + tail++] = nc;
      }
    }
    return true;
  }

  /**
   * Runs the current search for at most `budget` expansions. Returns the number used; when the
   * search finished `sResult` is set.
   */
  private runSearch(budget: number): number {
    const sx = this.sx;
    const sy = this.sy;
    const sz = this.sz;
    const sxz = this.sxz;
    const g = this.g;
    const came = this.came;
    const stamp = this.stamp;
    const nbOff = this.nbOff;
    const to = this.sTo;
    const clearance = this.sClear;
    const open = this.gen * 2;
    const closed = open + 1;
    const hz = this.hazardCount > 0 ? this.hazard : null;
    let used = 0;
    let found = false;
    let capped = false;
    while (this.heapN > 0) {
      const cur = this.pop();
      if (stamp[cur] === closed) continue;
      stamp[cur] = closed;
      if (cur === to) {
        found = true;
        break;
      }
      if (++this.sExp > this.sMax) {
        capped = true;
        break;
      }
      used++;
      const y = (cur / sxz) | 0;
      const r = cur - y * sxz;
      const z = (r / sx) | 0;
      const x = r - z * sx;
      const hc = this.h(x, y, z);
      if (hc < this.sBestH) {
        this.sBestH = hc;
        this.sBest = cur;
      }
      const gc = g[cur];
      for (let i = 0; i < 26; i++) {
        const nx = x + NB_DX[i];
        const ny = y + NB_DY[i];
        const nz = z + NB_DZ[i];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const nc = cur + nbOff[i];
        const st = stamp[nc];
        if (st === closed) continue;
        if (!this.walkable(nc)) continue;
        if (clearance > 1 && !this.hasClearance(nc, clearance)) continue;
        if (NB_AXES[i] !== 1 && !this.canStep(cur, i)) continue;
        const ng = hz ? gc + NB_COST[i] + hz[nc] : gc + NB_COST[i];
        if (st === open && ng >= g[nc]) continue;
        g[nc] = ng;
        came[nc] = cur;
        stamp[nc] = open;
        this.push(nc, ng + this.h(nx, ny, nz) * HEURISTIC_WEIGHT);
      }
      if (used >= budget) {
        this.statExpansions += used;
        return used; // paused: heap and stamps stay valid until resumed
      }
    }
    this.statExpansions += used;
    const from = this.sFrom;
    // Open list exhausted without reaching the goal → it is unreachable: failed. Only a search
    // cut short by the expansion cap yields a partial path (towards the closest node seen).
    if (!found && !capped) {
      this.sResult = FAILED;
      return used + 1;
    }
    const end = found ? to : this.sBest;
    if (end === from) {
      this.sResult = FAILED;
      return used + 1;
    }
    let len = 0;
    for (let c = end; c !== from; c = came[c]) len++;
    const cells = new Int32Array(len);
    for (let c = end, i = len - 1; c !== from; c = came[c], i--) cells[i] = c;
    this.sResult = { status: found ? 'found' : 'partial', cells };
    return used + 1;
  }

  private push(cell: number, f: number): void {
    if (this.heapN >= this.heapCell.length) {
      const nc = new Int32Array(this.heapCell.length * 2);
      nc.set(this.heapCell);
      this.heapCell = nc;
      const nf = new Float32Array(this.heapF.length * 2);
      nf.set(this.heapF);
      this.heapF = nf;
    }
    let i = this.heapN++;
    const hc = this.heapCell;
    const hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hc[i] = hc[p];
      hf[i] = hf[p];
      i = p;
    }
    hc[i] = cell;
    hf[i] = f;
  }

  private pop(): number {
    const hc = this.heapCell;
    const hf = this.heapF;
    const top = hc[0];
    const n = --this.heapN;
    if (n > 0) {
      const cell = hc[n];
      const f = hf[n];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= f) break;
        hc[i] = hc[c];
        hf[i] = hf[c];
        i = c;
      }
      hc[i] = cell;
      hf[i] = f;
    }
    return top;
  }

  // ---- budgeted queue ------------------------------------------------------------------

  requestPath(from: CellIndex, to: CellIndex, clearance = 0, smooth = true): number {
    const ticket = this.nextTicket++;
    const req: Request = { ticket, from, to, clearance, smooth, cancelled: false };
    this.queue.push(req);
    this.live.set(ticket, req);
    return ticket;
  }

  takePath(ticket: number): PathResult | null {
    const r = this.results.get(ticket);
    if (!r) return null;
    this.results.delete(ticket);
    this.resultBorn.delete(ticket);
    return r;
  }

  cancelPath(ticket: number): void {
    this.results.delete(ticket);
    this.resultBorn.delete(ticket);
    const req = this.live.get(ticket);
    if (req) {
      req.cancelled = true;
      this.live.delete(ticket);
    }
  }

  process(maxExpansions: number): void {
    let budget = maxExpansions;
    while (budget > 0) {
      let req = this.active;
      if (req && req.cancelled) {
        req = this.active = null;
        this.sResult = null;
      }
      let resolved = false;
      if (!req) {
        while (this.qHead < this.queue.length && this.queue[this.qHead].cancelled) this.qHead++;
        if (this.qHead >= this.queue.length) {
          this.queue.length = 0;
          this.qHead = 0;
          break;
        }
        req = this.active = this.queue[this.qHead++];
        this.activeRestart = false;
        resolved = this.begin(req.from, req.to, req.clearance, PATH_MAX_EXPANSIONS);
      } else if (this.activeRestart) {
        // the world changed (or a synchronous findPath borrowed the scratch) mid-search
        this.activeRestart = false;
        resolved = this.begin(req.from, req.to, req.clearance, PATH_MAX_EXPANSIONS);
      }
      budget -= resolved ? 1 : this.runSearch(budget);
      const res = this.sResult as PathResult | null;
      if (!res) break; // paused on budget
      this.sResult = null;
      this.active = null;
      this.live.delete(req.ticket);
      let out = res;
      if (this.smoothing && req.smooth && res.cells.length > 2 && req.clearance <= 1) {
        out = { status: res.status, cells: this.smoothPath(req.from, res.cells) };
        budget -= res.cells.length >> 2;
      }
      this.results.set(req.ticket, out);
      this.resultBorn.set(req.ticket, this.processCalls);
    }
    // results nobody collected (the requester died): drop them after a while
    if ((++this.processCalls & 127) === 0 && this.results.size > 0) {
      for (const [ticket, born] of this.resultBorn) {
        if (this.processCalls - born < RESULT_TTL) break; // insertion-ordered: the rest is newer
        this.results.delete(ticket);
        this.resultBorn.delete(ticket);
      }
    }
    // compact the queue now and then so it cannot grow without bound
    if (this.qHead > 256 && this.qHead * 2 > this.queue.length) {
      this.queue.splice(0, this.qHead);
      this.qHead = 0;
    }
  }

  // ---- path smoothing & validation -----------------------------------------------------

  /**
   * True if a mover can crawl in a straight line between the centres of two walkable cells:
   * every sample along the segment lies in a walkable cell and on the same face (surface normal
   * within ~45° of the normal at `a`). Deliberately conservative — it only says yes on
   * near-planar patches, where the crawl kernel follows a straight wish direction exactly.
   */
  lineWalkable(a: CellIndex, b: CellIndex): boolean {
    const sx = this.sx;
    const sxz = this.sxz;
    const ay = (a / sxz) | 0;
    const ar = a - ay * sxz;
    const az = (ar / sx) | 0;
    const ax = ar - az * sx;
    const by = (b / sxz) | 0;
    const br = b - by * sxz;
    const bz = (br / sx) | 0;
    const bx = br - bz * sx;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1.01) return true;
    const w = this.w;
    const g = _g;
    const hz = this.hazardCount > 0 ? this.hazard : null;
    w.gradient(ax + 0.5, ay + 0.5, az + 0.5, g);
    const gl = Math.hypot(g.x, g.y, g.z);
    if (gl < 0.3) return false;
    const n0x = g.x / gl;
    const n0y = g.y / gl;
    const n0z = g.z / gl;
    // the segment must run along the face, not up/down its normal
    if (Math.abs(dx * n0x + dy * n0y + dz * n0z) > 0.45 * len) return false;
    const steps = Math.ceil(len / 0.5);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = ax + 0.5 + dx * t;
      const py = ay + 0.5 + dy * t;
      const pz = az + 0.5 + dz * t;
      const c = (px | 0) + sx * ((pz | 0) + this.sz * (py | 0));
      if (!this.walkable(c)) return false;
      // never string-pull a detour back through a hazard
      if (hz && hz[c] !== 0 && hz[a] === 0) return false;
      w.gradient(px, py, pz, g);
      const l = Math.hypot(g.x, g.y, g.z);
      if (l < 0.3 || (g.x * n0x + g.y * n0y + g.z * n0z) / l < 0.72) return false;
    }
    return true;
  }

  /**
   * String-pulling: drops intermediate waypoints wherever `lineWalkable` holds between the
   * waypoints that remain. The result is a subsequence of `cells` that keeps its last element.
   */
  smoothPath(from: CellIndex, cells: Int32Array): Int32Array {
    const n = cells.length;
    if (n < 3) return cells;
    if (!this.isWalkable(from)) return cells;
    const out = _smooth.length >= n ? _smooth : (_smooth = new Int32Array(n * 2));
    let m = 0;
    let anchor = from;
    let i = 0;
    while (i < n) {
      // farthest waypoint visible from the anchor (the next one always is: adjacent cells)
      let j = i;
      const lim = Math.min(n - 1, i + SMOOTH_LOOKAHEAD);
      for (let k = i + 1; k <= lim; k++) {
        if (!this.lineWalkable(anchor, cells[k])) break;
        j = k;
      }
      anchor = cells[j];
      out[m++] = anchor;
      i = j + 1;
    }
    return m === n ? cells : out.slice(0, m);
  }

  /**
   * Did edits since `sinceSeq` break the rest of a path? `cells[index..]` are the remaining
   * waypoints, `at` the mover's current cell. Only waypoints/segments inside recently edited
   * boxes are re-examined, so this is cheap to call for every following mover after an edit.
   */
  pathBroken(cells: Int32Array, index: number, at: CellIndex, sinceSeq: number): boolean {
    if (this.w.version !== this.seenVersion) this.resync();
    let count = this.editSeq - sinceSeq;
    if (count <= 0) return false;
    if (count > EDIT_RING) count = EDIT_RING;
    const sx = this.sx;
    const sxz = this.sxz;
    const b = this.editBox;
    let px = -1;
    let py = -1;
    let pz = -1;
    let prev = at;
    if (prev >= 0) {
      py = (prev / sxz) | 0;
      const r = prev - py * sxz;
      pz = (r / sx) | 0;
      px = r - pz * sx;
    }
    for (let i = index; i < cells.length; i++) {
      const c = cells[i];
      const y = (c / sxz) | 0;
      const r = c - y * sxz;
      const z = (r / sx) | 0;
      const x = r - z * sx;
      const x0 = prev >= 0 && px < x ? px : x;
      const x1 = prev >= 0 && px > x ? px : x;
      const y0 = prev >= 0 && py < y ? py : y;
      const y1 = prev >= 0 && py > y ? py : y;
      const z0 = prev >= 0 && pz < z ? pz : z;
      const z1 = prev >= 0 && pz > z ? pz : z;
      for (let e = 0; e < count; e++) {
        const k = ((this.editSeq - 1 - e) % EDIT_RING) * 6;
        if (x1 < b[k] || x0 > b[k + 3] || y1 < b[k + 1] || y0 > b[k + 4] || z1 < b[k + 2] || z0 > b[k + 5]) continue;
        if (!this.walkable(c)) return true;
        // a pulled (non-adjacent) segment must still be a straight crawl
        if (prev >= 0) {
          const far = Math.abs(px - x) > 1 || Math.abs(py - y) > 1 || Math.abs(pz - z) > 1;
          if (far && !this.lineWalkable(prev, c)) return true;
        }
        break;
      }
      prev = c;
      px = x;
      py = y;
      pz = z;
    }
    return false;
  }

  /**
   * Cheap reachability test for ant-sized movers. Answers from an up-to-date distance field when
   * one can decide it, otherwise runs a bounded A* (`maxExpansions`, default 4000): a search that
   * hits the cap counts as NOT reachable.
   */
  reachable(from: CellIndex, to: CellIndex, clearance = 0, maxExpansions = 4000): boolean {
    if (from < 0 || to < 0) return false;
    if (from === to) return this.isWalkable(to, clearance);
    if (!this.isWalkable(to, clearance)) return false;
    if (clearance <= 1) {
      for (const f of this.fields) {
        if (!f.built || f.dirty) continue;
        const a = f.dist[from] !== UNREACH;
        const b = f.dist[to] !== UNREACH;
        if (a !== b) return false;
        // both reach a single source → same component
        if (a && b && f.sources.length === 1 && !f.sourceFn) return true;
      }
    }
    return this.findPath(from, to, clearance, maxExpansions).status === 'found';
  }

  // ---- distance fields -----------------------------------------------------------------

  /** Get or create a named distance field (see `DistanceField`). */
  field(key: string): DistanceField {
    return this.fieldImpl(key);
  }

  private fieldImpl(key: string): Field {
    let f = this.fieldByKey.get(key);
    if (!f) {
      f = new Field(key, this, this.n);
      this.fieldByKey.set(key, f);
      this.fields.push(f);
    }
    return f;
  }

  /** Drop a named field and free its memory (home fields cannot be removed). */
  removeField(key: string): void {
    const f = this.fieldByKey.get(key);
    if (!f || this.homeFields.includes(f)) return;
    this.fieldByKey.delete(key);
    this.fields.splice(this.fields.indexOf(f), 1);
    if (this.bfsField === f) this.bfsField = null;
    if (this.skyFieldRef === f) this.skyFieldRef = null;
  }

  /**
   * "Distance to open sky": sources are all walkable cells with nothing solid above them
   * (outdoors: the ground surface and the tops of plants; farms: the top of the gel/sand).
   * Created on first use; rebuilt after edits at a slower throttle. `descend` walks out of the
   * nest by the shortest route.
   */
  skyField(): DistanceField {
    let f = this.skyFieldRef;
    if (!f) {
      f = this.skyFieldRef = this.fieldImpl('sky');
      f.interval = HOME_REBUILD_INTERVAL * 4;
      f.sourceFn = () => this.exposedWalkableCells();
    }
    return f;
  }

  setHome(colony: ColonyId, sourceCells: CellIndex[]): void {
    let f = this.homeFields[colony];
    if (!f) f = this.homeFields[colony] = this.fieldImpl(`home:${colony}`);
    f.setSources(sourceCells);
  }

  homeField(colony: ColonyId): DistanceField | null {
    return this.homeFields[colony] ?? null;
  }

  homeDistance(colony: ColonyId, cell: CellIndex): number {
    const f = this.homeFields[colony];
    if (!f || cell < 0) return UNREACH;
    return f.dist[cell];
  }

  homeStep(colony: ColonyId, cell: CellIndex): CellIndex {
    const f = this.homeFields[colony];
    if (!f) return -1;
    return this.descendField(f, cell);
  }

  /** Neighbour of `cell` with the smallest field distance below its own (still walkable), or -1. */
  descendField(f: Field, cell: CellIndex): CellIndex {
    if (cell < 0 || cell >= this.n) return -1;
    const dist = f.dist;
    const sx = this.sx;
    const sxz = this.sxz;
    const y = (cell / sxz) | 0;
    const r = cell - y * sxz;
    const z = (r / sx) | 0;
    const x = r - z * sx;
    let best = -1;
    let bestD = dist[cell];
    let bestCost = 0;
    for (let i = 0; i < 26; i++) {
      const nx = x + NB_DX[i];
      const ny = y + NB_DY[i];
      const nz = z + NB_DZ[i];
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= this.sy || nz >= this.sz) continue;
      const nc = cell + this.nbOff[i];
      const d = dist[nc];
      // strictly closer; among equals prefer the straighter (axis-aligned) step
      if (d > bestD || d === UNREACH) continue;
      if (d === bestD && (best < 0 || NB_COST[i] >= bestCost)) continue;
      if (!this.canStep(cell, i) || !this.walkable(nc)) continue;
      bestD = d;
      best = nc;
      bestCost = NB_COST[i];
    }
    return best;
  }

  /**
   * Rebuilds dirty fields whose throttle allows. A field that was never built is built in full
   * right away; later rebuilds run incrementally at `nodeBudget` BFS nodes per call into a back
   * buffer that is swapped in when complete (readers keep seeing the previous complete field).
   */
  updateFields(tick: Tick, nodeBudget = Infinity): void {
    if (this.w.version !== this.seenVersion) this.resync();
    let budget = nodeBudget;
    for (let guard = 0; guard <= this.fields.length && budget > 0; guard++) {
      let f = this.bfsField;
      if (!f) {
        for (const c of this.fields) {
          if (c.dirty && (tick >= c.nextRebuild || !c.built)) {
            f = c;
            break;
          }
        }
        if (!f) return;
        this.beginField(f);
      }
      budget -= this.runField(f, f.built ? budget : Infinity);
      if (this.bfsField) return; // out of budget
      f.nextRebuild = tick + f.interval;
    }
  }

  private beginField(f: Field): void {
    // Edits that arrive while the BFS runs set `dirty` again → another rebuild follows.
    f.dirty = false;
    if (f.sourceFn) f.sources = f.sourceFn();
    if (!this.back) this.back = new Uint16Array(this.n);
    const dist = this.back;
    dist.fill(UNREACH);
    this.bfsField = f;
    this.bfsHead = 0;
    this.bfsTail = 0;
    this.isWalkable(0); // version check once; the loop below uses the unchecked variant
    for (const s of f.sources) {
      if (s >= 0 && s < this.n && this.walkable(s) && dist[s] === UNREACH) {
        dist[s] = 0;
        this.bfsPush(s);
      }
    }
    this.statFieldBuilds++;
  }

  private bfsPush(c: number): void {
    if (this.bfsTail >= this.bfsQueue.length) {
      const nq = new Int32Array(this.bfsQueue.length * 2);
      nq.set(this.bfsQueue);
      this.bfsQueue = nq;
    }
    this.bfsQueue[this.bfsTail++] = c;
  }

  private runField(f: Field, budget: number): number {
    const dist = this.back!;
    const sx = this.sx;
    const sy = this.sy;
    const sz = this.sz;
    const sxz = this.sxz;
    const nbOff = this.nbOff;
    let used = 0;
    while (this.bfsHead < this.bfsTail) {
      if (used >= budget) {
        this.statFieldNodes += used;
        return used;
      }
      used++;
      const cur = this.bfsQueue[this.bfsHead++];
      const d = dist[cur] + 1;
      if (d >= UNREACH) continue;
      const y = (cur / sxz) | 0;
      const r = cur - y * sxz;
      const z = (r / sx) | 0;
      const x = r - z * sx;
      for (let i = 0; i < 26; i++) {
        const nx = x + NB_DX[i];
        const ny = y + NB_DY[i];
        const nz = z + NB_DZ[i];
        if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
        const nc = cur + nbOff[i];
        if (dist[nc] !== UNREACH) continue;
        if (!this.walkable(nc) || (NB_AXES[i] !== 1 && !this.canStep(cur, i))) continue;
        dist[nc] = d;
        this.bfsPush(nc);
      }
    }
    this.statFieldNodes += used;
    // complete: swap buffers
    this.back = f.dist;
    f.dist = dist;
    f.built = true;
    f.version++;
    this.bfsField = null;
    return used + 1;
  }

  // ---- sky exposure --------------------------------------------------------------------

  /** y of the lowest cell in column (x, z) that has only air above it (0 = column is all air). */
  skyHeight(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return this.sy;
    if (this.w.version !== this.seenVersion) this.resync();
    let sky = this.sky;
    if (!sky) sky = this.sky = new Int16Array(this.sx * this.sz).fill(-1);
    const k = x + this.sx * z;
    let h = sky[k];
    if (h < 0) {
      const den = this.den;
      let y = this.sy - 1;
      let c = k + this.sxz * y;
      while (y >= 0 && den[c] < ISO_) {
        y--;
        c -= this.sxz;
      }
      h = sky[k] = y + 1;
    }
    return h;
  }

  /** True if nothing solid lies above the cell (rain, sun and wind reach it). */
  isExposed(cell: CellIndex): boolean {
    if (cell < 0 || cell >= this.n) return false;
    const y = (cell / this.sxz) | 0;
    const r = cell - y * this.sxz;
    const z = (r / this.sx) | 0;
    return y >= this.skyHeight(r - z * this.sx, z);
  }

  /** All walkable cells open to the sky (one or two per column). Allocates; not for hot loops. */
  exposedWalkableCells(): CellIndex[] {
    const out: CellIndex[] = [];
    this.isWalkable(0);
    for (let z = 0; z < this.sz; z++)
      for (let x = 0; x < this.sx; x++) {
        const h = this.skyHeight(x, z);
        for (let y = h; y < h + 2 && y < this.sy; y++) {
          const c = x + this.sx * (z + this.sz * y);
          if (this.walkable(c)) out.push(c);
        }
      }
    return out;
  }

  stats(): NavStats {
    let fieldBytes = this.back ? this.back.byteLength : 0;
    for (const f of this.fields) fieldBytes += f.dist.byteLength;
    return {
      pending: this.live.size,
      expansions: this.statExpansions,
      searches: this.statSearches,
      fields: this.fields.length,
      fieldBuilds: this.statFieldBuilds,
      fieldNodes: this.statFieldNodes,
      fieldBytes,
      editSeq: this.editSeq,
    };
  }
}

const _g: Vec3 = { x: 0, y: 0, z: 0 };
let _smooth = new Int32Array(256);

export function createNav(world: VoxelWorld): Nav {
  return new Nav(world);
}
