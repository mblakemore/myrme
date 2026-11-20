import { DENSITY_PER_VOXEL, ISO, type Vec3, type VoxelWorld } from '../../core';

/**
 * Fast trilinear sampling of the density field for the crawl kernel.
 *
 * `world.sample`/`world.gradient` are exact but slow near the world boundary (every corner goes
 * through `densityAt`), and on farm slabs nearly every mover is near a pane. This keeps a copy
 * of the density padded by 2 cells on every side with the *physics* boundary values
 * (`world.densityAt`), so one unchecked code path serves the whole world. Values are bit-for-bit
 * what `world.sample` / `world.gradient` return.
 *
 * The copy is kept in sync through `world.onEdit` (brush box only); any other change of
 * `world.version` (generator writes + `markAllDirty`) triggers a full recopy on the next `sync`.
 */
const P = 2;
// module-local copies: imported bindings are live lookups, and these sit in the hottest loop
const ISO_ = ISO;
const DPV = DENSITY_PER_VOXEL;

export class FieldSampler {
  private readonly w: VoxelWorld;
  private readonly d: Uint8Array;
  private readonly px: number;
  private readonly pxz: number;
  private readonly sx: number;
  private readonly sy: number;
  private readonly sz: number;
  private version = -1;
  /** Gradient of the last `sampleGrad` call (points into the solid, not normalised). */
  gx = 0;
  gy = 0;
  gz = 0;

  constructor(world: VoxelWorld) {
    this.w = world;
    this.sx = world.sx;
    this.sy = world.sy;
    this.sz = world.sz;
    this.px = world.sx + 2 * P;
    this.pxz = this.px * (world.sz + 2 * P);
    this.d = new Uint8Array(this.pxz * (world.sy + 2 * P));
    this.copyBox(-P, -P, -P, this.sx + P - 1, this.sy + P - 1, this.sz + P - 1);
    this.version = world.version;
    world.onEdit((_r, c, radius) => {
      if (this.version !== world.version - 1) return; // already stale: the next sync recopies
      const reach = radius + 2;
      // +P so pad cells that mirror edited border cells (open-map clamp) are refreshed too
      this.copyBox(
        Math.max(-P, Math.floor(c.x - reach) - P),
        Math.max(-P, Math.floor(c.y - reach) - P),
        Math.max(-P, Math.floor(c.z - reach) - P),
        Math.min(this.sx + P - 1, Math.floor(c.x + reach) + P),
        Math.min(this.sy + P - 1, Math.floor(c.y + reach) + P),
        Math.min(this.sz + P - 1, Math.floor(c.z + reach) + P),
      );
      this.version = world.version;
    });
  }

  private copyBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const w = this.w;
    const d = this.d;
    const src = w.density;
    const sx = this.sx;
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        const row = P + this.px * (z + P) + this.pxz * (y + P);
        if (y >= 0 && y < this.sy && z >= 0 && z < this.sz) {
          const srow = sx * (z + this.sz * y);
          for (let x = x0; x <= x1; x++) d[row + x] = x >= 0 && x < sx ? src[srow + x] : w.densityAt(x, y, z);
        } else {
          for (let x = x0; x <= x1; x++) d[row + x] = w.densityAt(x, y, z);
        }
      }
  }

  /** Recopy everything if the world changed behind our back. Cheap when in sync. */
  sync(): void {
    if (this.version === this.w.version) return;
    this.copyBox(-P, -P, -P, this.sx + P - 1, this.sy + P - 1, this.sz + P - 1);
    this.version = this.w.version;
  }

  /** Can `sample` be evaluated at (x, y, z) and at ±0.5 around it from the padded copy? */
  private inRange(x: number, y: number, z: number): boolean {
    return x >= -0.5 && y >= -0.5 && z >= -0.5 && x <= this.sx + 0.5 && y <= this.sy + 0.5 && z <= this.sz + 0.5;
  }

  /** Unchecked trilinear density (raw units) — caller guarantees the padded range. */
  private tri(x: number, y: number, z: number): number {
    const fx = x - 0.5;
    const fy = y - 0.5;
    const fz = z - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    const d = this.d;
    const px = this.px;
    const i = x0 + P + px * (z0 + P) + this.pxz * (y0 + P);
    const j = i + this.pxz;
    const d000 = d[i];
    const d001 = d[i + px];
    const d010 = d[j];
    const d011 = d[j + px];
    const a = d000 + (d[i + 1] - d000) * tx;
    const b = d001 + (d[i + px + 1] - d001) * tx;
    const c = d010 + (d[j + 1] - d010) * tx;
    const e = d011 + (d[j + px + 1] - d011) * tx;
    const lo = a + (b - a) * tz;
    const hi = c + (e - c) * tz;
    return lo + (hi - lo) * ty;
  }

  /** Same value as `world.sample`. */
  sample(x: number, y: number, z: number): number {
    if (x >= -1 && y >= -1 && z >= -1 && x <= this.sx + 1 && y <= this.sy + 1 && z <= this.sz + 1) return (this.tri(x, y, z) - ISO_) / DPV;
    return this.w.sample(x, y, z);
  }

  /** Same value as `world.gradient`, written to `out`. */
  gradient(x: number, y: number, z: number, out: Vec3): Vec3 {
    if (!this.inRange(x, y, z)) return this.w.gradient(x, y, z, out);
    const h = 0.5;
    // (a − ISO)/64 − (b − ISO)/64 is evaluated exactly like world.gradient does
    out.x = (this.tri(x + h, y, z) - ISO_) / DPV - (this.tri(x - h, y, z) - ISO_) / DPV;
    out.y = (this.tri(x, y + h, z) - ISO_) / DPV - (this.tri(x, y - h, z) - ISO_) / DPV;
    out.z = (this.tri(x, y, z + h) - ISO_) / DPV - (this.tri(x, y, z - h) - ISO_) / DPV;
    return out;
  }

  /** Sample + gradient in one call; the gradient lands in `gx, gy, gz`. Returns the sdf. */
  sampleGrad(x: number, y: number, z: number): number {
    if (!this.inRange(x, y, z)) {
      const g = this.w.gradient(x, y, z, _g);
      this.gx = g.x;
      this.gy = g.y;
      this.gz = g.z;
      return this.w.sample(x, y, z);
    }
    const h = 0.5;
    this.gx = (this.tri(x + h, y, z) - ISO_) / DPV - (this.tri(x - h, y, z) - ISO_) / DPV;
    this.gy = (this.tri(x, y + h, z) - ISO_) / DPV - (this.tri(x, y - h, z) - ISO_) / DPV;
    this.gz = (this.tri(x, y, z + h) - ISO_) / DPV - (this.tri(x, y, z - h) - ISO_) / DPV;
    return (this.tri(x, y, z) - ISO_) / DPV;
  }
}

const _g: Vec3 = { x: 0, y: 0, z: 0 };
const samplers = new WeakMap<VoxelWorld, FieldSampler>();
let lastWorld: VoxelWorld | null = null;
let lastSampler: FieldSampler | null = null;

/** The (lazily created, cached) sampler of a world, synced to its current version. */
export function samplerFor(world: VoxelWorld): FieldSampler {
  if (world === lastWorld) {
    lastSampler!.sync();
    return lastSampler!;
  }
  let s = samplers.get(world);
  if (!s) {
    s = new FieldSampler(world);
    samplers.set(world, s);
  } else s.sync();
  lastWorld = world;
  lastSampler = s;
  return s;
}
