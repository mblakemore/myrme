import {
  PHERO_CHANNELS,
  type CellIndex,
  type ColonyId,
  type PheroChannel,
  type PheroConfig,
  type PheroStats,
  type PheromoneStoreEx,
  type TrailSense,
  type Vec3,
  type VoxelWorld,
} from '../core';

/**
 * D16 pooled pheromone store.
 *
 * One pool per (colony, channel). A pool is a dense active list (`cells[i]`, `values[i]`,
 * `flags[i]` for i < count) plus an open-addressing hash table (typed arrays, linear probing,
 * backward-shift deletion) mapping cell → list index. No per-entry objects, no `Map`.
 *
 * - No diffusion (D16). Evaporation is a multiplicative decay applied by the `pheromone` system
 *   at 2 Hz: `value *= keep[channel] ^ (scale · decayScale · channelScale · weather)`, where the
 *   weather factor only applies to entries flagged as exposed to the sky (wind and rain do not
 *   reach into the nest).
 * - Saturation: deposits clamp to the per-channel maximum.
 * - Bounded memory: a pool never holds more than `maxEntries` cells; deposits on new cells
 *   beyond that are dropped (counted in `stats().dropped`).
 * - Colonies are isolated; `sampleForeign` smells other colonies at reduced strength.
 * - `senseTrail` is the classic three-antenna sensor model on the surface tangent plane.
 *
 * The constants below are the defaults; the `pheromone` system applies the balance file through
 * `configure` at init.
 */
export const PHERO_KEEP: readonly number[] = [0.985, 0.9, 0.995, 0.97, 0.95, 0.93, 0.97, 0.99];
export const PHERO_MAX: readonly number[] = [10, 10, 10, 10, 10, 10, 10, 10];
export const PHERO_FLOOR = 0.02;
/** Default cap on live cells per (colony, channel) pool. */
export const PHERO_MAX_ENTRIES = 1 << 16;
/** Default strength factor for smelling another colony's pheromone. */
export const PHERO_FOREIGN_FACTOR = 0.5;

const CH = PHERO_CHANNELS;
const INITIAL_CAPACITY = 256;

class Pool {
  cells = new Int32Array(INITIAL_CAPACITY);
  values = new Float32Array(INITIAL_CAPACITY);
  /** bit 0: exposed to the sky */
  flags = new Uint8Array(INITIAL_CAPACITY);
  count = 0;
  /** Hash table: `keys[h]` = cell + 1 (0 = empty), `slots[h]` = index into the dense list. */
  private keys = new Int32Array(INITIAL_CAPACITY * 2);
  private slots = new Int32Array(INITIAL_CAPACITY * 2);
  private mask = INITIAL_CAPACITY * 2 - 1;

  get bytes(): number {
    return this.cells.byteLength + this.values.byteLength + this.flags.byteLength + this.keys.byteLength + this.slots.byteLength;
  }

  private home(cell: number): number {
    return (Math.imul(cell, 0x9e3779b1) >>> 7) & this.mask;
  }

  /** Dense index of `cell`, or -1. */
  find(cell: CellIndex): number {
    const keys = this.keys;
    const mask = this.mask;
    const k = cell + 1;
    let h = this.home(cell);
    for (;;) {
      const e = keys[h];
      if (e === k) return this.slots[h];
      if (e === 0) return -1;
      h = (h + 1) & mask;
    }
  }

  private tableSet(cell: CellIndex, slot: number): void {
    const keys = this.keys;
    const mask = this.mask;
    const k = cell + 1;
    let h = this.home(cell);
    while (keys[h] !== 0 && keys[h] !== k) h = (h + 1) & mask;
    keys[h] = k;
    this.slots[h] = slot;
  }

  private tableDelete(cell: CellIndex): void {
    const keys = this.keys;
    const slots = this.slots;
    const mask = this.mask;
    const k = cell + 1;
    let h = this.home(cell);
    while (keys[h] !== k) {
      if (keys[h] === 0) return;
      h = (h + 1) & mask;
    }
    // backward-shift deletion keeps probe chains intact without tombstones
    let hole = h;
    let j = h;
    for (;;) {
      j = (j + 1) & mask;
      const e = keys[j];
      if (e === 0) break;
      const ideal = this.home(e - 1);
      // can the entry at j move into the hole? (its ideal slot must not lie in (hole, j])
      const between = hole <= j ? ideal > hole && ideal <= j : ideal > hole || ideal <= j;
      if (between) continue;
      keys[hole] = e;
      slots[hole] = slots[j];
      hole = j;
    }
    keys[hole] = 0;
  }

  private grow(): void {
    const cap = this.cells.length * 2;
    const nc = new Int32Array(cap);
    nc.set(this.cells);
    this.cells = nc;
    const nv = new Float32Array(cap);
    nv.set(this.values);
    this.values = nv;
    const nf = new Uint8Array(cap);
    nf.set(this.flags);
    this.flags = nf;
    this.keys = new Int32Array(cap * 2);
    this.slots = new Int32Array(cap * 2);
    this.mask = cap * 2 - 1;
    for (let i = 0; i < this.count; i++) this.tableSet(this.cells[i], i);
  }

  /** Returns the dense index of a new entry for `cell`, or -1 if the pool is full. */
  insert(cell: CellIndex, maxEntries: number): number {
    if (this.count >= maxEntries) return -1;
    if (this.count >= this.cells.length) this.grow();
    const i = this.count++;
    this.cells[i] = cell;
    this.values[i] = 0;
    this.flags[i] = 0;
    this.tableSet(cell, i);
    return i;
  }

  removeAt(i: number): void {
    const last = --this.count;
    this.tableDelete(this.cells[i]);
    if (i !== last) {
      const moved = this.cells[last];
      this.cells[i] = moved;
      this.values[i] = this.values[last];
      this.flags[i] = this.flags[last];
      this.tableSet(moved, i);
    }
  }

  reset(): void {
    this.count = 0;
    this.keys.fill(0);
  }
}

const _r: Vec3 = { x: 0, y: 0, z: 0 };

export class Pheromones implements PheromoneStoreEx {
  /** pools[colony * CH + channel] */
  private pools: (Pool | undefined)[] = [];
  private keep: number[] = PHERO_KEEP.slice();
  private max: number[] = PHERO_MAX.slice();
  private floor = PHERO_FLOOR;
  private maxEntries = PHERO_MAX_ENTRIES;
  private foreignFactor = PHERO_FOREIGN_FACTOR;
  private decayScale = 1;
  private weatherScale = 1;
  private channelScale: number[] = new Array<number>(CH).fill(1);
  private exposure: ((cell: CellIndex) => boolean) | null = null;
  private dropped = 0;
  private peak = 0;

  configure(cfg: PheroConfig): void {
    if (cfg.keep) for (let c = 0; c < CH; c++) this.keep[c] = cfg.keep[c] ?? this.keep[c];
    if (cfg.max) for (let c = 0; c < CH; c++) this.max[c] = cfg.max[c] ?? this.max[c];
    if (cfg.floor !== undefined) this.floor = cfg.floor;
    if (cfg.maxEntries !== undefined) this.maxEntries = Math.max(16, cfg.maxEntries | 0);
    if (cfg.foreignFactor !== undefined) this.foreignFactor = cfg.foreignFactor;
  }

  /** Saturation cap of a channel. */
  maxOf(channel: PheroChannel): number {
    return this.max[channel];
  }

  setDecayScale(scale: number): void {
    this.decayScale = scale > 0 ? scale : 0;
  }

  setWeatherScale(scale: number): void {
    this.weatherScale = scale > 0 ? scale : 0;
  }

  setChannelScale(channel: PheroChannel, scale: number): void {
    this.channelScale[channel] = scale > 0 ? scale : 0;
  }

  setExposure(fn: ((cell: CellIndex) => boolean) | null): void {
    this.exposure = fn;
  }

  private pool(colony: ColonyId, channel: PheroChannel, create: boolean): Pool | undefined {
    const k = colony * CH + channel;
    let p = this.pools[k];
    if (!p && create) p = this.pools[k] = new Pool();
    return p;
  }

  deposit(colony: ColonyId, channel: PheroChannel, cell: CellIndex, amount: number): void {
    if (cell < 0 || !(amount > 0) || colony < 0) return;
    const p = this.pool(colony, channel, true)!;
    let i = p.find(cell);
    if (i < 0) {
      i = p.insert(cell, this.maxEntries);
      if (i < 0) {
        this.dropped++;
        return;
      }
      if (this.exposure && this.exposure(cell)) p.flags[i] = 1;
    }
    const v = p.values[i] + amount;
    const max = this.max[channel];
    p.values[i] = v > max ? max : v;
  }

  sample(colony: ColonyId, channel: PheroChannel, cell: CellIndex): number {
    const p = this.pools[colony * CH + channel];
    if (!p || p.count === 0 || cell < 0) return 0;
    const i = p.find(cell);
    return i < 0 ? 0 : p.values[i];
  }

  sampleForeign(colony: ColonyId, channel: PheroChannel, cell: CellIndex): number {
    if (cell < 0) return 0;
    let best = 0;
    const pools = this.pools;
    for (let k = channel; k < pools.length; k += CH) {
      const p = pools[k];
      if (!p || p.count === 0 || k === colony * CH + channel) continue;
      const i = p.find(cell);
      if (i >= 0 && p.values[i] > best) best = p.values[i];
    }
    return best * this.foreignFactor;
  }

  /** Own value, or with `foreign` the stronger of own and (attenuated) foreign. */
  private smell(colony: ColonyId, channel: PheroChannel, cell: CellIndex, foreign: boolean): number {
    const own = this.sample(colony, channel, cell);
    if (!foreign) return own;
    const f = this.sampleForeign(colony, channel, cell);
    return f > own ? f : own;
  }

  /** Value around a world position: the containing cell and the one half a voxel out along `up`. */
  private smellAt(world: VoxelWorld, colony: ColonyId, channel: PheroChannel, x: number, y: number, z: number, up: Vec3, foreign: boolean): number {
    const a = world.cellAt(x, y, z);
    const b = world.cellAt(x + up.x * 0.6, y + up.y * 0.6, z + up.z * 0.6);
    let v = a >= 0 ? this.smell(colony, channel, a, foreign) : 0;
    if (b >= 0 && b !== a) v += this.smell(colony, channel, b, foreign);
    return v;
  }

  senseTrail(world: VoxelWorld, colony: ColonyId, channel: PheroChannel, pos: Vec3, forward: Vec3, up: Vec3, out: TrailSense, dist = 1.6, angle = 0.65, foreign = false): TrailSense {
    // right = forward × up
    const r = _r;
    r.x = forward.y * up.z - forward.z * up.y;
    r.y = forward.z * up.x - forward.x * up.z;
    r.z = forward.x * up.y - forward.y * up.x;
    const c = Math.cos(angle) * dist;
    const s = Math.sin(angle) * dist;
    const px = pos.x;
    const py = pos.y;
    const pz = pos.z;
    // Each antenna reads two points along its ray so a one-cell-wide trail is not stepped over.
    const centre =
      this.smellAt(world, colony, channel, px + forward.x * dist, py + forward.y * dist, pz + forward.z * dist, up, foreign) +
      this.smellAt(world, colony, channel, px + forward.x * dist * 0.5, py + forward.y * dist * 0.5, pz + forward.z * dist * 0.5, up, foreign) * 0.5;
    const lx = forward.x * c - r.x * s;
    const ly = forward.y * c - r.y * s;
    const lz = forward.z * c - r.z * s;
    const left = this.smellAt(world, colony, channel, px + lx, py + ly, pz + lz, up, foreign) + this.smellAt(world, colony, channel, px + lx * 0.5, py + ly * 0.5, pz + lz * 0.5, up, foreign) * 0.5;
    const rx = forward.x * c + r.x * s;
    const ry = forward.y * c + r.y * s;
    const rz = forward.z * c + r.z * s;
    const right = this.smellAt(world, colony, channel, px + rx, py + ry, pz + rz, up, foreign) + this.smellAt(world, colony, channel, px + rx * 0.5, py + ry * 0.5, pz + rz * 0.5, up, foreign) * 0.5;
    const total = left + centre + right;
    out.left = left;
    out.centre = centre;
    out.right = right;
    out.total = total;
    if (total <= 1e-6) {
      out.turn = 0;
      out.dir.x = forward.x;
      out.dir.y = forward.y;
      out.dir.z = forward.z;
      return out;
    }
    out.turn = (right - left) / total;
    let dx = (lx * left + forward.x * dist * centre + rx * right) / total;
    let dy = (ly * left + forward.y * dist * centre + ry * right) / total;
    let dz = (lz * left + forward.z * dist * centre + rz * right) / total;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) {
      dx = forward.x;
      dy = forward.y;
      dz = forward.z;
    } else {
      dx /= l;
      dy /= l;
      dz /= l;
    }
    out.dir.x = dx;
    out.dir.y = dy;
    out.dir.z = dz;
    return out;
  }

  forEachActive(colony: ColonyId, channel: PheroChannel, fn: (cell: CellIndex, value: number) => void): void {
    const p = this.pool(colony, channel, false);
    if (!p) return;
    for (let i = 0; i < p.count; i++) fn(p.cells[i], p.values[i]);
  }

  clearCell(cell: CellIndex): void {
    const pools = this.pools;
    for (let k = 0; k < pools.length; k++) {
      const p = pools[k];
      if (!p || p.count === 0) continue;
      const i = p.find(cell);
      if (i >= 0) p.removeAt(i);
    }
  }

  evaporate(scale = 1): void {
    const pools = this.pools;
    const floor = this.floor;
    let live = 0;
    for (let k = 0; k < pools.length; k++) {
      const p = pools[k];
      if (!p || p.count === 0) continue;
      const ch = k % CH;
      const e = scale * this.decayScale * this.channelScale[ch];
      const keepIn = Math.pow(this.keep[ch], e);
      const keepOut = this.weatherScale === 1 ? keepIn : Math.pow(this.keep[ch], e * this.weatherScale);
      const values = p.values;
      const flags = p.flags;
      live += p.count;
      for (let i = p.count - 1; i >= 0; i--) {
        const v = values[i] * (flags[i] ? keepOut : keepIn);
        if (v < floor) p.removeAt(i);
        else values[i] = v;
      }
    }
    if (live > this.peak) this.peak = live;
  }

  activeCount(colony: ColonyId, channel: PheroChannel): number {
    return this.pool(colony, channel, false)?.count ?? 0;
  }

  stats(): PheroStats {
    let entries = 0;
    let pools = 0;
    let bytes = 0;
    for (const p of this.pools) {
      if (!p) continue;
      pools++;
      entries += p.count;
      bytes += p.bytes;
    }
    if (entries > this.peak) this.peak = entries;
    return { entries, pools, bytes, dropped: this.dropped, peakEntries: this.peak, maxEntriesPerPool: this.maxEntries };
  }

  clear(): void {
    this.pools = [];
    this.dropped = 0;
    this.peak = 0;
  }
}

export function createPheromones(): Pheromones {
  return new Pheromones();
}
