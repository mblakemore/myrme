import {
  CHUNK_SIZE,
  DENSITY_PER_VOXEL,
  ISO,
  MATERIAL_COUNT,
  MIN_BRUSH_RADIUS,
  Mat,
  materialDef,
  type BoundaryMode,
  type CellIndex,
  type EditOptions,
  type EditResult,
  type MaterialId,
  type RayHit,
  type RaycastOptions,
  type Vec3,
  type VoxelWorld,
} from '../core';
import { raycastWorld } from './raycast';

type EditListener = (result: EditResult, center: Vec3, radius: number) => void;

export function sdfToDensity(sdf: number): number {
  const d = Math.round(ISO + sdf * DENSITY_PER_VOXEL);
  return d < 0 ? 0 : d > 255 ? 255 : d;
}

/**
 * Voxel world (D1–D4, D6). See the `VoxelWorld` contract for semantics.
 *
 * Storage: `density` is a clamped signed distance (Uint8, 128 = surface, 64 per voxel) and
 * `material` one MaterialId per cell. Edits are spherical CSG on the distance field, so the
 * field stays a usable distance approximation for trilinear sampling and gradients.
 */
export class VoxelWorldImpl implements VoxelWorld {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly ncx: number;
  readonly ncy: number;
  readonly ncz: number;
  readonly boundary: BoundaryMode;
  readonly density: Uint8Array;
  readonly material: Uint8Array;
  readonly chunkVersion: Uint32Array;
  version = 1;

  private readonly sxz: number;
  private readonly glass: boolean;
  private listeners: EditListener[] = [];

  constructor(sx: number, sy: number, sz: number, boundary: BoundaryMode) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.sxz = sx * sz;
    this.boundary = boundary;
    this.glass = boundary === 'glass';
    this.ncx = Math.ceil(sx / CHUNK_SIZE);
    this.ncy = Math.ceil(sy / CHUNK_SIZE);
    this.ncz = Math.ceil(sz / CHUNK_SIZE);
    this.density = new Uint8Array(sx * sy * sz);
    this.material = new Uint8Array(sx * sy * sz);
    this.chunkVersion = new Uint32Array(this.ncx * this.ncy * this.ncz).fill(1);
    // Start as empty air honouring the glass bake.
    if (this.glass) {
      for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) this.density[x + sx * (z + sz * y)] = this.glassMinDensity(x, y, z);
    }
  }

  index(x: number, y: number, z: number): CellIndex {
    return x + this.sx * (z + this.sz * y);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  cellCoords(cell: CellIndex, out: Vec3): Vec3 {
    const y = Math.floor(cell / this.sxz);
    const r = cell - y * this.sxz;
    const z = Math.floor(r / this.sx);
    out.x = r - z * this.sx;
    out.y = y;
    out.z = z;
    return out;
  }

  cellCenter(cell: CellIndex, out: Vec3): Vec3 {
    this.cellCoords(cell, out);
    out.x += 0.5;
    out.y += 0.5;
    out.z += 0.5;
    return out;
  }

  cellAt(x: number, y: number, z: number): CellIndex {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.sx || iy >= this.sy || iz >= this.sz) return -1;
    return ix + this.sx * (iz + this.sz * iy);
  }

  chunkIndexOfCell(x: number, y: number, z: number): number {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    return cx + this.ncx * (cz + this.ncz * cy);
  }

  /** Lowest density a cell may store on a glass map (the pane baked in as a solid half-space). */
  private glassMinDensity(x: number, y: number, z: number): number {
    let m = x + 0.5;
    let t = this.sx - x - 0.5;
    if (t < m) m = t;
    t = y + 0.5;
    if (t < m) m = t;
    t = this.sy - y - 0.5;
    if (t < m) m = t;
    t = z + 0.5;
    if (t < m) m = t;
    t = this.sz - z - 0.5;
    if (t < m) m = t;
    const d = Math.round(ISO - m * DENSITY_PER_VOXEL);
    return d < 0 ? 0 : d;
  }

  densityAt(x: number, y: number, z: number): number {
    if (x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz) {
      return this.density[x + this.sx * (z + this.sz * y)];
    }
    if (this.glass) {
      // Distance of the (out-of-bounds) cell centre behind the nearest pane.
      let d = 0;
      if (x < 0) d = Math.max(d, -x - 0.5);
      else if (x >= this.sx) d = Math.max(d, x - this.sx + 0.5);
      if (y < 0) d = Math.max(d, -y - 0.5);
      else if (y >= this.sy) d = Math.max(d, y - this.sy + 0.5);
      if (z < 0) d = Math.max(d, -z - 0.5);
      else if (z >= this.sz) d = Math.max(d, z - this.sz + 0.5);
      const v = ISO + d * DENSITY_PER_VOXEL;
      return v > 255 ? 255 : v;
    }
    // open: sky is air, floor is solid, sides clamp to the nearest in-bounds column.
    if (y >= this.sy) return 0;
    if (y < 0) return 255;
    const cx = x < 0 ? 0 : x >= this.sx ? this.sx - 1 : x;
    const cz = z < 0 ? 0 : z >= this.sz ? this.sz - 1 : z;
    return this.density[cx + this.sx * (cz + this.sz * y)];
  }

  /**
   * Density with *visual* semantics (what the mesher sees): out of bounds is air. The value is
   * the mirror (255 - d) of the nearest in-bounds cell when that cell is solid, so the visual
   * surface lies exactly on the world box — same rule as the mesher.
   */
  densityVisual(x: number, y: number, z: number): number {
    if (x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz) {
      return this.density[x + this.sx * (z + this.sz * y)];
    }
    const cx = x < 0 ? 0 : x >= this.sx ? this.sx - 1 : x;
    const cy = y < 0 ? 0 : y >= this.sy ? this.sy - 1 : y;
    const cz = z < 0 ? 0 : z >= this.sz ? this.sz - 1 : z;
    const d = this.density[cx + this.sx * (cz + this.sz * cy)];
    return d >= ISO ? 255 - d : 0;
  }

  materialAt(x: number, y: number, z: number): MaterialId {
    if (x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz) {
      return this.material[x + this.sx * (z + this.sz * y)] as MaterialId;
    }
    return Mat.Air;
  }

  isSolid(x: number, y: number, z: number): boolean {
    return this.densityAt(x, y, z) >= ISO;
  }

  sample(x: number, y: number, z: number): number {
    const fx = x - 0.5;
    const fy = y - 0.5;
    const fz = z - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    let d000: number, d100: number, d010: number, d110: number, d001: number, d101: number, d011: number, d111: number;
    if (x0 >= 0 && y0 >= 0 && z0 >= 0 && x0 + 1 < this.sx && y0 + 1 < this.sy && z0 + 1 < this.sz) {
      const d = this.density;
      const sx = this.sx;
      const i = x0 + sx * (z0 + this.sz * y0);
      const j = i + this.sxz;
      d000 = d[i];
      d100 = d[i + 1];
      d001 = d[i + sx];
      d101 = d[i + sx + 1];
      d010 = d[j];
      d110 = d[j + 1];
      d011 = d[j + sx];
      d111 = d[j + sx + 1];
    } else {
      d000 = this.densityAt(x0, y0, z0);
      d100 = this.densityAt(x0 + 1, y0, z0);
      d001 = this.densityAt(x0, y0, z0 + 1);
      d101 = this.densityAt(x0 + 1, y0, z0 + 1);
      d010 = this.densityAt(x0, y0 + 1, z0);
      d110 = this.densityAt(x0 + 1, y0 + 1, z0);
      d011 = this.densityAt(x0, y0 + 1, z0 + 1);
      d111 = this.densityAt(x0 + 1, y0 + 1, z0 + 1);
    }
    const a = d000 + (d100 - d000) * tx;
    const b = d001 + (d101 - d001) * tx;
    const c = d010 + (d110 - d010) * tx;
    const e = d011 + (d111 - d011) * tx;
    const lo = a + (b - a) * tz;
    const hi = c + (e - c) * tz;
    return (lo + (hi - lo) * ty - ISO) / DENSITY_PER_VOXEL;
  }

  /** Trilinear sdf with visual semantics (out of bounds = air). Used by visual raycasts. */
  sampleVisual(x: number, y: number, z: number): number {
    const fx = x - 0.5;
    const fy = y - 0.5;
    const fz = z - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    if (x0 >= 0 && y0 >= 0 && z0 >= 0 && x0 + 1 < this.sx && y0 + 1 < this.sy && z0 + 1 < this.sz) return this.sample(x, y, z);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    const d000 = this.densityVisual(x0, y0, z0);
    const d100 = this.densityVisual(x0 + 1, y0, z0);
    const d001 = this.densityVisual(x0, y0, z0 + 1);
    const d101 = this.densityVisual(x0 + 1, y0, z0 + 1);
    const d010 = this.densityVisual(x0, y0 + 1, z0);
    const d110 = this.densityVisual(x0 + 1, y0 + 1, z0);
    const d011 = this.densityVisual(x0, y0 + 1, z0 + 1);
    const d111 = this.densityVisual(x0 + 1, y0 + 1, z0 + 1);
    const a = d000 + (d100 - d000) * tx;
    const b = d001 + (d101 - d001) * tx;
    const c = d010 + (d110 - d010) * tx;
    const e = d011 + (d111 - d011) * tx;
    const lo = a + (b - a) * tz;
    const hi = c + (e - c) * tz;
    return (lo + (hi - lo) * ty - ISO) / DENSITY_PER_VOXEL;
  }

  gradient(x: number, y: number, z: number, out: Vec3): Vec3 {
    const h = 0.5;
    out.x = this.sample(x + h, y, z) - this.sample(x - h, y, z);
    out.y = this.sample(x, y + h, z) - this.sample(x, y - h, z);
    out.z = this.sample(x, y, z + h) - this.sample(x, y, z - h);
    return out;
  }

  setCell(x: number, y: number, z: number, sdf: number, material: MaterialId): void {
    if (!this.inBounds(x, y, z)) return;
    let d = sdfToDensity(sdf);
    if (this.glass) {
      const m = this.glassMinDensity(x, y, z);
      if (d < m) d = m;
    }
    const i = x + this.sx * (z + this.sz * y);
    this.density[i] = d;
    this.material[i] = d >= ISO ? material : Mat.Air;
  }

  markAllDirty(): void {
    this.version++;
    for (let i = 0; i < this.chunkVersion.length; i++) this.chunkVersion[i]++;
  }

  dig(center: Vec3, radius: number, opts?: EditOptions): EditResult {
    return this.edit(center, radius, Mat.Air, false, opts);
  }

  fill(center: Vec3, radius: number, material: MaterialId, opts?: EditOptions): EditResult {
    return this.edit(center, radius, material, true, opts);
  }

  private edit(center: Vec3, radiusIn: number, material: MaterialId, add: boolean, opts?: EditOptions): EditResult {
    const radius = Math.max(MIN_BRUSH_RADIUS, radiusIn);
    const res: EditResult = { changedChunks: [], removedByMaterial: new Array<number>(MATERIAL_COUNT).fill(0), addedCells: 0, touchedCells: 0 };
    // The brush changes the distance field up to 2 voxels (the clamp band) beyond its radius.
    const reach = radius + 2;
    const x0 = Math.max(0, Math.floor(center.x - reach));
    const y0 = Math.max(0, Math.floor(center.y - reach));
    const z0 = Math.max(0, Math.floor(center.z - reach));
    const x1 = Math.min(this.sx - 1, Math.floor(center.x + reach));
    const y1 = Math.min(this.sy - 1, Math.floor(center.y + reach));
    const z1 = Math.min(this.sz - 1, Math.floor(center.z + reach));
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    const canDig = opts?.canDig;
    const isOccupied = opts?.isOccupied;
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - center.y;
      for (let z = z0; z <= z1; z++) {
        const dz = z + 0.5 - center.z;
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - center.x;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const i = x + this.sx * (z + this.sz * y);
          const old = this.density[i];
          let nd: number;
          if (add) {
            nd = sdfToDensity(radius - dist);
            if (nd <= old) continue;
            if (old < ISO && nd >= ISO) {
              if (isOccupied && isOccupied(i)) continue;
              this.material[i] = material;
              res.addedCells++;
            }
          } else {
            nd = sdfToDensity(dist - radius);
            if (this.glass) {
              const m = this.glassMinDensity(x, y, z);
              if (nd < m) nd = m;
            }
            if (nd >= old) continue;
            if (old >= ISO) {
              const mat = this.material[i] as MaterialId;
              const ok = canDig ? canDig(mat) : Number.isFinite(materialDef(mat).digCost);
              if (!ok) continue;
              if (nd < ISO) {
                res.removedByMaterial[mat]++;
                this.material[i] = Mat.Air;
              }
            }
          }
          this.density[i] = nd;
          res.touchedCells++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
      }
    }
    if (res.touchedCells === 0) return res;
    // Dirty every chunk whose mesh can depend on a changed cell: the mesher reads a 2-cell
    // border (1 for stitching + 1 for gradient normals), so edits near a border dirty neighbours.
    const pad = 2;
    const cx0 = Math.max(0, Math.floor((minX - pad) / CHUNK_SIZE));
    const cy0 = Math.max(0, Math.floor((minY - pad) / CHUNK_SIZE));
    const cz0 = Math.max(0, Math.floor((minZ - pad) / CHUNK_SIZE));
    const cx1 = Math.min(this.ncx - 1, Math.floor((maxX + pad) / CHUNK_SIZE));
    const cy1 = Math.min(this.ncy - 1, Math.floor((maxY + pad) / CHUNK_SIZE));
    const cz1 = Math.min(this.ncz - 1, Math.floor((maxZ + pad) / CHUNK_SIZE));
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const ci = cx + this.ncx * (cz + this.ncz * cy);
          this.chunkVersion[ci]++;
          res.changedChunks.push(ci);
        }
    this.version++;
    for (const fn of this.listeners) fn(res, center, radius);
    return res;
  }

  raycast(origin: Vec3, dir: Vec3, maxDist: number, opts?: RaycastOptions): RayHit | null {
    return raycastWorld(this, origin, dir, maxDist, opts);
  }

  onEdit(fn: EditListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }
}

export function createWorld(sx: number, sy: number, sz: number, boundary: BoundaryMode): VoxelWorldImpl {
  return new VoxelWorldImpl(sx, sy, sz, boundary);
}
