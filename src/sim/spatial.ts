import { SPATIAL_CELL, type Mover, type SpatialQuery, type VoxelWorld } from '../core';

/**
 * Uniform-grid spatial hash over movers (ants + creatures). Rebuilt once per tick by the
 * Simulation before systems run, so queries see start-of-tick positions. Dense buckets (the
 * world is bounded), reused between rebuilds; iteration order is deterministic.
 */
export class SpatialHash implements SpatialQuery {
  private readonly gx: number;
  private readonly gy: number;
  private readonly gz: number;
  private readonly buckets: Mover[][];
  private used: number[] = [];

  constructor(world: VoxelWorld) {
    this.gx = Math.ceil(world.sx / SPATIAL_CELL);
    this.gy = Math.ceil(world.sy / SPATIAL_CELL);
    this.gz = Math.ceil(world.sz / SPATIAL_CELL);
    this.buckets = new Array(this.gx * this.gy * this.gz);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  private key(x: number, y: number, z: number): number {
    let ix = Math.floor(x / SPATIAL_CELL);
    let iy = Math.floor(y / SPATIAL_CELL);
    let iz = Math.floor(z / SPATIAL_CELL);
    ix = ix < 0 ? 0 : ix >= this.gx ? this.gx - 1 : ix;
    iy = iy < 0 ? 0 : iy >= this.gy ? this.gy - 1 : iy;
    iz = iz < 0 ? 0 : iz >= this.gz ? this.gz - 1 : iz;
    return ix + this.gx * (iz + this.gz * iy);
  }

  rebuild(...lists: readonly Mover[][]): void {
    for (const k of this.used) this.buckets[k].length = 0;
    this.used.length = 0;
    for (const list of lists) {
      for (const m of list) {
        if (!m.alive) continue;
        const k = this.key(m.pos.x, m.pos.y, m.pos.z);
        const b = this.buckets[k];
        if (b.length === 0) this.used.push(k);
        b.push(m);
      }
    }
  }

  queryMovers(x: number, y: number, z: number, radius: number, out: Mover[]): Mover[] {
    out.length = 0;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor((x - radius) / SPATIAL_CELL));
    const y0 = Math.max(0, Math.floor((y - radius) / SPATIAL_CELL));
    const z0 = Math.max(0, Math.floor((z - radius) / SPATIAL_CELL));
    const x1 = Math.min(this.gx - 1, Math.floor((x + radius) / SPATIAL_CELL));
    const y1 = Math.min(this.gy - 1, Math.floor((y + radius) / SPATIAL_CELL));
    const z1 = Math.min(this.gz - 1, Math.floor((z + radius) / SPATIAL_CELL));
    for (let iy = y0; iy <= y1; iy++)
      for (let iz = z0; iz <= z1; iz++)
        for (let ix = x0; ix <= x1; ix++) {
          const b = this.buckets[ix + this.gx * (iz + this.gz * iy)];
          for (let i = 0; i < b.length; i++) {
            const m = b[i];
            const dx = m.pos.x - x;
            const dy = m.pos.y - y;
            const dz = m.pos.z - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(m);
          }
        }
    return out;
  }
}
