import { ISO, type CellIndex, type VoxelWorld, type WaterFieldEx } from '../core';

/**
 * D17 water field: a sparse set of wet air cells, each holding a depth 0..1 (1 = a full voxel).
 *
 * FLOW (active front, budgeted, deterministic). Only cells on the active queue are updated; a
 * cell that changes wakes itself and its wet neighbours, a cell at rest costs nothing.
 *   1. down      water drops into the air cell below until that is full
 *   2. sideways  on a floor (or on full water) it levels out with its four side neighbours;
 *                films thinner than `filmMin` do not creep onto dry cells unless there is a drop
 *                behind them (so water runs over a ledge but does not spread without end)
 *   3. pressure  a free-surface cell resting on a full body of water searches through that body
 *                (bounded BFS) for a non-full cell LOWER than itself and feeds it — communicating
 *                vessels, so a U-shaped tunnel fills on both sides and the lowest connected air is
 *                always filled first.
 * Injected water that lands on a full cell is pushed up the column (or through the full body to
 * its nearest free surface). Volume is conserved exactly by every transfer.
 *
 * DRAIN. Every `drainEveryTicks` each wet cell loses water into the solid it touches (per-face
 * absorption by material: sand and soil soak quickly, clay barely, rock / gel / glass never) and
 * free surfaces evaporate. `totalAdded − totalDrained === totalVolume()` at all times.
 *
 * No three.js, no sim imports: runs anywhere. The `water` sim system owns rain inflow, drowning
 * and events; renderers iterate `forEachFlooded` / `forEachSurface` keyed on `version` / `revision`.
 */

export interface WaterConfig {
  floodDepth: number;
  flowBudget: number;
  pressureBudget: number;
  pressureNodes: number;
  flowShare: number;
  filmMin: number;
  filmDry: number;
  /** Absorption per second per touching face, index = MaterialId. */
  absorb: readonly number[];
  absorbFloorMul: number;
  drainEveryTicks: number;
}

const DEFAULTS: WaterConfig = {
  floodDepth: 0.5,
  flowBudget: 1800,
  pressureBudget: 6,
  pressureNodes: 400,
  flowShare: 0.4,
  filmMin: 0.05,
  filmDry: 0.012,
  absorb: [0, 0.006, 0.016, 0.0012, 0, 0, 0.001, 0.01, 0, 0.002, 0.002],
  absorbFloorMul: 2,
  drainEveryTicks: 15,
};

const FULL = 0.999;
/** Ticks a free-surface cell waits after a futile pressure search. */
const PRESSURE_IDLE_TICKS = 90;
const EPS = 1e-5;

export class Water implements WaterFieldEx {
  private depth = new Map<CellIndex, number>();
  /** Active queue (FIFO with a moving head) and its membership set. */
  private queue: CellIndex[] = [];
  private head = 0;
  private queued = new Set<CellIndex>();
  /** Cached absorption rate per wet cell (cleared when the world is edited). */
  private absorbCache = new Map<CellIndex, number>();
  private seenWorldVersion = -1;
  private cfg: WaterConfig = { ...DEFAULTS };
  private tickCount = 0;
  private evaporation = 0;
  private pressureLeft = 0;
  private pressureIdle = new Map<CellIndex, number>();
  private readonly sx: number;
  private readonly sxz: number;
  private readonly n: number;
  // scratch for the pressure search
  private bfs: CellIndex[] = [];
  private seen = new Set<CellIndex>();

  version = 0;
  revision = 0;
  totalAdded = 0;
  totalDrained = 0;

  constructor(protected readonly world: VoxelWorld) {
    this.sx = world.sx;
    this.sxz = world.sx * world.sz;
    this.n = this.sxz * world.sy;
  }

  configure(cfg: Partial<WaterConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get floodDepth(): number {
    return this.cfg.floodDepth;
  }

  get floodedCount(): number {
    return this.depth.size;
  }

  get activeCount(): number {
    return this.queue.length - this.head;
  }

  isFlooded(cell: CellIndex): boolean {
    return (this.depth.get(cell) ?? 0) > this.cfg.floodDepth;
  }

  depthAt(cell: CellIndex): number {
    return this.depth.get(cell) ?? 0;
  }

  totalVolume(): number {
    let s = 0;
    for (const d of this.depth.values()) s += d;
    return s;
  }

  setEvaporation(rate: number): void {
    this.evaporation = rate > 0 ? rate : 0;
  }

  forEachFlooded(fn: (cell: CellIndex, depth: number) => void): void {
    for (const [cell, d] of this.depth) fn(cell, d);
  }

  forEachSurface(fn: (cell: CellIndex, level: number) => void): void {
    const sxz = this.sxz;
    for (const [cell, d] of this.depth) {
      const up = cell + sxz;
      if (up < this.n && this.depth.has(up)) continue;
      fn(cell, Math.floor(cell / sxz) + d);
    }
  }

  surfaceAbove(cell: CellIndex): number {
    let d = this.depth.get(cell);
    if (d === undefined) return -1;
    let c = cell;
    for (;;) {
      const up = c + this.sxz;
      const du = up < this.n ? this.depth.get(up) : undefined;
      if (du === undefined) break;
      c = up;
      d = du;
    }
    return Math.floor(c / this.sxz) + d;
  }

  clear(): void {
    if (this.depth.size) {
      this.version++;
      this.revision++;
    }
    this.totalDrained += this.totalVolume();
    this.depth.clear();
    this.queue.length = 0;
    this.head = 0;
    this.queued.clear();
    this.absorbCache.clear();
    this.pressureIdle.clear();
  }

  // ---- cells -----------------------------------------------------------------------------

  private isAir(cell: CellIndex): boolean {
    return cell >= 0 && cell < this.n && this.world.density[cell] < ISO;
  }

  private wake(cell: CellIndex): void {
    if (this.queued.has(cell)) return;
    this.queued.add(cell);
    this.queue.push(cell);
  }

  /** Wake a cell and every wet cell that might now flow into / out of it. */
  private wakeAround(cell: CellIndex): void {
    this.wake(cell);
    const sx = this.sx;
    const sxz = this.sxz;
    const x = cell % sx;
    const z = Math.floor((cell % sxz) / sx);
    const dp = this.depth;
    if (cell + sxz < this.n && dp.has(cell + sxz)) this.wake(cell + sxz);
    if (x > 0 && dp.has(cell - 1)) this.wake(cell - 1);
    if (x < sx - 1 && dp.has(cell + 1)) this.wake(cell + 1);
    if (z > 0 && dp.has(cell - sx)) this.wake(cell - sx);
    if (z < this.world.sz - 1 && dp.has(cell + sx)) this.wake(cell + sx);
  }

  private setDepth(cell: CellIndex, d: number): void {
    const had = this.depth.has(cell);
    if (d <= EPS) {
      if (had) {
        this.depth.delete(cell);
        this.absorbCache.delete(cell);
        this.pressureIdle.delete(cell);
        this.version++;
      }
      // dust is accounted as drained so the books stay exact
      if (d > 0) this.totalDrained += d;
    } else {
      this.depth.set(cell, d);
      if (!had) this.version++;
    }
    this.revision++;
  }

  // ---- sources ---------------------------------------------------------------------------

  addWater(cell: CellIndex, amount: number): void {
    this.inject(cell, amount);
  }

  inject(cell: CellIndex, amount: number): number {
    if (cell < 0 || cell >= this.n || !(amount > 0)) return 0;
    // a solid target: use the first air cell above it (a dropper aimed at the ground)
    let c = cell;
    for (let k = 0; k < 4 && !this.isAir(c); k++) c += this.sxz;
    if (!this.isAir(c)) return 0;
    let left = amount;
    let guard = 0;
    while (left > EPS && guard++ < 64) {
      const d = this.depth.get(c) ?? 0;
      if (d < FULL) {
        const m = Math.min(left, 1 - d);
        this.setDepth(c, d + m);
        this.wakeAround(c);
        left -= m;
        continue;
      }
      // full: push up the column, else out through the full body
      const up = c + this.sxz;
      if (this.isAir(up)) {
        c = up;
        continue;
      }
      const t = this.findFree(c, Infinity);
      if (t < 0) break;
      c = t;
    }
    const accepted = amount - left;
    this.totalAdded += accepted;
    return accepted;
  }

  take(cell: CellIndex, amount: number): number {
    const d = this.depth.get(cell);
    if (d === undefined || !(amount > 0)) return 0;
    const m = Math.min(d, amount);
    this.setDepth(cell, d - m);
    this.totalDrained += m;
    this.wakeAround(cell);
    return m;
  }

  /**
   * Bounded BFS through FULL cells starting at `from`: the nearest non-full air cell whose level
   * is below `maxY` (cell y strictly less), or -1.
   */
  private findFree(from: CellIndex, maxY: number): CellIndex {
    const q = this.bfs;
    const seen = this.seen;
    q.length = 0;
    seen.clear();
    q.push(from);
    seen.add(from);
    const sx = this.sx;
    const sxz = this.sxz;
    const sz = this.world.sz;
    const limit = this.cfg.pressureNodes;
    for (let i = 0; i < q.length && i < limit; i++) {
      const c = q[i];
      const x = c % sx;
      const z = Math.floor((c % sxz) / sx);
      for (let k = 0; k < 6; k++) {
        let nb: number;
        if (k === 0) nb = c - sxz;
        else if (k === 1) nb = x > 0 ? c - 1 : -1;
        else if (k === 2) nb = x < sx - 1 ? c + 1 : -1;
        else if (k === 3) nb = z > 0 ? c - sx : -1;
        else if (k === 4) nb = z < sz - 1 ? c + sx : -1;
        else nb = c + sxz;
        if (nb < 0 || nb >= this.n || seen.has(nb) || !this.isAir(nb)) continue;
        seen.add(nb);
        const d = this.depth.get(nb) ?? 0;
        if (d >= FULL) q.push(nb);
        else if (Math.floor(nb / sxz) < maxY) return nb;
      }
    }
    return -1;
  }

  // ---- simulation --------------------------------------------------------------------------

  step(dt: number, drainScale = 1): void {
    if (this.depth.size === 0) {
      this.tickCount++;
      return;
    }
    if (this.world.version !== this.seenWorldVersion) {
      // the world was edited: absorption changes, and water may now have somewhere to go
      this.seenWorldVersion = this.world.version;
      this.absorbCache.clear();
      this.pressureIdle.clear();
      for (const cell of this.depth.keys()) this.wake(cell);
    }
    this.pressureLeft = this.cfg.pressureBudget;
    let budget = this.cfg.flowBudget;
    const q = this.queue;
    while (budget-- > 0 && this.head < q.length) {
      const cell = q[this.head++];
      this.queued.delete(cell);
      this.flow(cell);
    }
    if (this.head > 4096 || this.head >= q.length) {
      q.splice(0, this.head);
      this.head = 0;
    }
    this.tickCount++;
    if (this.tickCount % this.cfg.drainEveryTicks === 0) this.drain(dt * this.cfg.drainEveryTicks, drainScale);
  }

  private flow(cell: CellIndex): void {
    const dp = this.depth;
    let d = dp.get(cell);
    if (d === undefined) return;
    const sx = this.sx;
    const sxz = this.sxz;
    if (!this.isAir(cell)) {
      // buried by a fill: the water is displaced upwards (or lost into the new soil)
      this.setDepth(cell, 0);
      const moved = this.inject(cell + sxz, d);
      this.totalAdded -= moved; // displaced, not new water
      this.totalDrained += d - moved;
      return;
    }
    const d0 = d;
    const C = this.cfg;

    // 1. down
    const below = cell - sxz;
    if (below >= 0 && this.isAir(below)) {
      const db = dp.get(below) ?? 0;
      if (db < FULL) {
        const m = Math.min(d, 1 - db);
        this.setDepth(below, db + m);
        this.wakeAround(below);
        d -= m;
      }
    }
    // whatever is left rests on a floor or on full water

    // 2. sideways
    if (d > EPS) {
      const x = cell % sx;
      const z = Math.floor((cell % sxz) / sx);
      const sz = this.world.sz;
      const start = (cell + this.tickCount) & 3;
      for (let i = 0; i < 4 && d > EPS; i++) {
        const k = (start + i) & 3;
        let nb: number;
        if (k === 0) nb = x > 0 ? cell - 1 : -1;
        else if (k === 1) nb = x < sx - 1 ? cell + 1 : -1;
        else if (k === 2) nb = z > 0 ? cell - sx : -1;
        else nb = z < sz - 1 ? cell + sx : -1;
        if (nb < 0 || !this.isAir(nb)) continue;
        const dn = dp.get(nb) ?? 0;
        const diff = d - dn;
        if (diff <= 0.004) continue;
        let m: number;
        if (dn <= 0) {
          // onto a dry cell: over a ledge everything goes; on the flat only a real layer creeps
          const nbBelow = nb - sxz;
          const ledge = nbBelow >= 0 && this.isAir(nbBelow) && (dp.get(nbBelow) ?? 0) < FULL;
          if (ledge) m = d;
          else if (d < C.filmMin) continue;
          else m = diff * C.flowShare;
        } else m = diff * C.flowShare;
        if (m > 1 - dn) m = 1 - dn;
        if (m <= EPS) continue;
        this.setDepth(nb, dn + m);
        this.wakeAround(nb);
        d -= m;
      }
    }

    // 3. pressure: a free surface resting on a full body feeds any LOWER free surface connected
    //    through that body (searches are budgeted; a futile one is not repeated for a while)
    if (d > EPS && below >= 0 && (dp.get(below) ?? 0) >= FULL) {
      const up = cell + sxz;
      const idle = this.pressureIdle.get(cell);
      if (!(up < this.n && dp.has(up)) && (idle === undefined || this.tickCount >= idle)) {
        if (this.pressureLeft > 0) {
          this.pressureLeft--;
          const t = this.findFree(below, Math.floor(cell / sxz));
          if (t >= 0 && t !== cell) {
            const dt2 = dp.get(t) ?? 0;
            const m = Math.min(d, 1 - dt2);
            if (m > EPS) {
              this.setDepth(t, dt2 + m);
              this.wakeAround(t);
              d -= m;
            }
          } else this.pressureIdle.set(cell, this.tickCount + PRESSURE_IDLE_TICKS);
        } else this.wake(cell); // out of budget this tick: try again next tick
      }
    }

    if (d !== d0) {
      this.setDepth(cell, d);
      this.wakeAround(cell);
    }
  }

  private absorbRate(cell: CellIndex): number {
    let r = this.absorbCache.get(cell);
    if (r !== undefined) return r;
    const w = this.world;
    const sx = this.sx;
    const sxz = this.sxz;
    const x = cell % sx;
    const z = Math.floor((cell % sxz) / sx);
    const A = this.cfg.absorb;
    const den = w.density;
    const mat = w.material;
    r = 0;
    const below = cell - sxz;
    if (below >= 0 && den[below] >= ISO) r += (A[mat[below]] ?? 0) * this.cfg.absorbFloorMul;
    if (x > 0 && den[cell - 1] >= ISO) r += A[mat[cell - 1]] ?? 0;
    if (x < sx - 1 && den[cell + 1] >= ISO) r += A[mat[cell + 1]] ?? 0;
    if (z > 0 && den[cell - sx] >= ISO) r += A[mat[cell - sx]] ?? 0;
    if (z < w.sz - 1 && den[cell + sx] >= ISO) r += A[mat[cell + sx]] ?? 0;
    this.absorbCache.set(cell, r);
    return r;
  }

  private drainList: CellIndex[] = [];

  private drain(dt: number, drainScale: number): void {
    const list = this.drainList;
    list.length = 0;
    for (const cell of this.depth.keys()) list.push(cell);
    const sxz = this.sxz;
    const filmDry = this.cfg.filmDry;
    for (let i = 0; i < list.length; i++) {
      const cell = list[i];
      const d = this.depth.get(cell);
      if (d === undefined) continue;
      let loss = this.absorbRate(cell) * drainScale * dt;
      const up = cell + sxz;
      const free = !(up < this.n && this.depth.has(up));
      if (free) loss += this.evaporation * dt;
      // a film too thin to flow dries where it lies (unless it is resting, e.g. a puddle's rim)
      if (d < filmDry && free) loss = d;
      if (loss <= 0) continue;
      const m = Math.min(d, loss);
      this.totalDrained += m;
      this.setDepth(cell, d - m);
      this.wakeAround(cell);
    }
  }
}

export function createWater(world: VoxelWorld): Water {
  return new Water(world);
}
