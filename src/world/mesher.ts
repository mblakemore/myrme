import { CHUNK_SIZE, ISO, MAT_CHANNELS, type MeshData, type MeshOptions, type MeshOptionsB4, type VoxelWorld } from '../core';

/**
 * D8 surface-nets mesher — a pure function of (world, chunk, options).
 *
 * Grid conventions: density samples sit at cell centres (cell + 0.5). A "cube" is the dual cell
 * spanned by 8 neighbouring samples and is addressed by its min-corner sample. Each sign-changing
 * grid edge yields one quad joining the 4 cubes around it.
 *
 * Chunk stitching: per axis a chunk owns the grid edges whose min sample p lies in
 * [c0-1, c0+15) (the last chunk extends to the world size so the far boundary face is emitted).
 * Those ranges partition [-1, size), so every sign-changing edge of the world is meshed exactly
 * once. Vertices of border cubes are recomputed identically by both neighbours (1-cell padding),
 * which makes the union of all chunk meshes watertight by position.
 *
 * Out-of-bounds samples are air (D6, visual semantics); cells past the cutaway plane are air
 * (D9), which caps the cross-section for free. Both use a mirrored value so the faces are flat.
 *
 * Normals come from the density gradient (trilinear field, central differences) evaluated on
 * the same padded grid, so shading is continuous across chunk borders.
 */

const MAXN = CHUNK_SIZE + 5;
const grid = new Uint8Array(MAXN * MAXN * MAXN);
const vertId = new Int32Array(MAXN * MAXN * MAXN);

// Growable scratch buffers shared between calls (the function stays pure: output is copied out).
let posBuf = new Float32Array(3 * 4096);
let nrmBuf = new Float32Array(3 * 4096);
let matBuf = new Uint8Array(MAT_CHANNELS * 4096);
let idxBuf = new Uint32Array(6 * 8192);

const EMPTY: MeshData = Object.freeze({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  matWeights: new Uint8Array(0),
  vertexCount: 0,
  triangleCount: 0,
});

// Cube corner offsets (x, y, z) and the 12 edges as corner pairs.
const CORNER = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
] as const;
const EDGES = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;

export function chunkOrigin(world: VoxelWorld, chunkIndex: number, out: [number, number, number]): [number, number, number] {
  const cx = chunkIndex % world.ncx;
  const r = (chunkIndex - cx) / world.ncx;
  const cz = r % world.ncz;
  const cy = (r - cz) / world.ncz;
  out[0] = cx * CHUNK_SIZE;
  out[1] = cy * CHUNK_SIZE;
  out[2] = cz * CHUNK_SIZE;
  return out;
}

const _c0: [number, number, number] = [0, 0, 0];

export function meshChunk(world: VoxelWorld, chunkIndex: number, opts?: MeshOptions): MeshData {
  chunkOrigin(world, chunkIndex, _c0);
  const size = [world.sx, world.sy, world.sz];
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  const n = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    lo[a] = _c0[a] - 1;
    hi[a] = _c0[a] + CHUNK_SIZE >= size[a] ? size[a] : _c0[a] + CHUNK_SIZE - 1;
    n[a] = hi[a] - lo[a] + 4; // samples lo-2 .. hi+1
  }
  const gx = lo[0] - 2;
  const gy = lo[1] - 2;
  const gz = lo[2] - 2;
  const nx = n[0];
  const ny = n[1];
  const nz = n[2];
  const nxz = nx * nz;

  // ---- fill the padded density grid (local index = i + nx*(k + nz*j), j = y) ----
  // Samples outside the world or past the cutaway plane are "mirrored air": 255 - d of the
  // nearest kept cell when that cell is solid, else 0. Every such sample is < ISO (air), and the
  // crossing between a solid cell and its mirror lies exactly half-way, so boundary faces and
  // cutaway caps come out perfectly flat on the pane / cut plane, with crisp tunnel openings.
  const cut = opts?.cut && opts.cut.enabled ? opts.cut : null;
  const kMin = [0, 0, 0];
  const kMax = [world.sx - 1, world.sy - 1, world.sz - 1];
  if (cut) {
    const a = cut.axis === 'x' ? 0 : cut.axis === 'y' ? 1 : 2;
    // hidden: sign * (w + 0.5 - pos) > 0
    const p = Math.ceil(cut.pos - 0.5);
    const shell = (opts as MeshOptionsB4).shell;
    if (shell !== undefined && shell > 0) {
      // B4 "slack shell": keep ONLY the slab of cells just past the plane (where underground
      // entities stay visible, see world/cut.ts); everything else is mirrored air.
      const n = Math.ceil(shell);
      if (cut.sign > 0) {
        kMin[a] = Math.max(kMin[a], p);
        kMax[a] = Math.min(kMax[a], p + n - 1);
      } else {
        kMax[a] = Math.min(kMax[a], p - 1);
        kMin[a] = Math.max(kMin[a], p - n);
      }
    } else if (cut.sign > 0) kMax[a] = Math.min(kMax[a], p - 1);
    else kMin[a] = Math.max(kMin[a], p);
  }
  const nothingKept = kMin[0] > kMax[0] || kMin[1] > kMax[1] || kMin[2] > kMax[2];
  if (nothingKept) return EMPTY;
  let anySolid = false;
  let anyAir = false;
  const dens = world.density;
  const wsx = world.sx;
  const wsz = world.sz;
  for (let j = 0; j < ny; j++) {
    const wy = gy + j;
    const cy = wy < kMin[1] ? kMin[1] : wy > kMax[1] ? kMax[1] : wy;
    for (let k = 0; k < nz; k++) {
      const wz = gz + k;
      const cz = wz < kMin[2] ? kMin[2] : wz > kMax[2] ? kMax[2] : wz;
      const row = wsx * (cz + wsz * cy);
      const rowOut = cy !== wy || cz !== wz;
      let li = nx * (k + nz * j);
      for (let i = 0; i < nx; i++, li++) {
        const wx = gx + i;
        const cx = wx < kMin[0] ? kMin[0] : wx > kMax[0] ? kMax[0] : wx;
        let d = dens[row + cx];
        if (rowOut || cx !== wx) d = d >= ISO ? 255 - d : 0;
        grid[li] = d;
        if (d >= ISO) anySolid = true;
        else anyAir = true;
      }
    }
  }
  if (!anySolid || !anyAir) return EMPTY;

  const tri = (x: number, y: number, z: number): number => {
    // trilinear on the local grid; x,y,z in local sample coordinates
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const tx = x - x0;
    const ty = y - y0;
    const tz = z - z0;
    const i = x0 + nx * (z0 + nz * y0);
    const a = grid[i] + (grid[i + 1] - grid[i]) * tx;
    const b = grid[i + nx] + (grid[i + nx + 1] - grid[i + nx]) * tx;
    const c = grid[i + nxz] + (grid[i + nxz + 1] - grid[i + nxz]) * tx;
    const e = grid[i + nxz + nx] + (grid[i + nxz + nx + 1] - grid[i + nxz + nx]) * tx;
    const l = a + (b - a) * tz;
    const h = c + (e - c) * tz;
    return l + (h - l) * ty;
  };

  // ---- vertices: one per sign-changing cube, cubes at local min-corner 1 .. n-3 ----
  let vc = 0;
  const cornerD = [0, 0, 0, 0, 0, 0, 0, 0];
  const mw = new Float32Array(MAT_CHANNELS);
  for (let j = 1; j <= ny - 3; j++) {
    for (let k = 1; k <= nz - 3; k++) {
      for (let i = 1; i <= nx - 3; i++) {
        const base = i + nx * (k + nz * j);
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER[c];
          const dv = grid[base + o[0] + nx * o[2] + nxz * o[1]];
          cornerD[c] = dv;
          if (dv >= ISO) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) {
          vertId[base] = -1;
          continue;
        }
        // Cubes straddling the world box or the cut plane have a whole corner layer of mirrored
        // samples. Averaging all crossings there would bevel the 90° edge between the flat face
        // and a tunnel wall into per-voxel stair steps, so: the coordinate along each "out" axis
        // snaps to the plane, and the other coordinates come only from crossings between kept
        // corners (the in-plane contour) — tunnel openings on a pane get a crisp, smooth outline.
        const wx0 = gx + i;
        const wy0 = gy + j;
        const wz0 = gz + k;
        const loX = wx0 < kMin[0];
        const hiX = wx0 + 1 > kMax[0];
        const loY = wy0 < kMin[1];
        const hiY = wy0 + 1 > kMax[1];
        const loZ = wz0 < kMin[2];
        const hiZ = wz0 + 1 > kMax[2];
        const border = loX || hiX || loY || hiY || loZ || hiZ;
        let px = 0;
        let py = 0;
        let pz = 0;
        let cnt = 0;
        let qx = 0;
        let qy = 0;
        let qz = 0;
        let qcnt = 0;
        for (let e = 0; e < 12; e++) {
          const c0 = EDGES[e][0];
          const c1 = EDGES[e][1];
          const d0 = cornerD[c0];
          const d1 = cornerD[c1];
          if (d0 >= ISO === d1 >= ISO) continue;
          const t = (ISO - 0.5 - d0) / (d1 - d0); // iso at 127.5 keeps t strictly inside (0,1)
          const a = CORNER[c0];
          const b = CORNER[c1];
          const ex = a[0] + (b[0] - a[0]) * t;
          const ey = a[1] + (b[1] - a[1]) * t;
          const ez = a[2] + (b[2] - a[2]) * t;
          px += ex;
          py += ey;
          pz += ez;
          cnt++;
          if (border) {
            const aOut = (a[0] ? hiX : loX) || (a[1] ? hiY : loY) || (a[2] ? hiZ : loZ);
            const bOut = (b[0] ? hiX : loX) || (b[1] ? hiY : loY) || (b[2] ? hiZ : loZ);
            if (!aOut && !bOut) {
              qx += ex;
              qy += ey;
              qz += ez;
              qcnt++;
            }
          }
        }
        if (qcnt > 0) {
          px = qx / qcnt;
          py = qy / qcnt;
          pz = qz / qcnt;
        } else {
          px /= cnt;
          py /= cnt;
          pz /= cnt;
        }
        if (border) {
          // plane between the kept layer and the mirrored layer, in cube-local coordinates
          if (loX || hiX) px = 0.5;
          if (loY || hiY) py = 0.5;
          if (loZ || hiZ) pz = 0.5;
        }
        px += i;
        py += j;
        pz += k;

        if (vc * 3 + 3 > posBuf.length) {
          const np = new Float32Array(posBuf.length * 2);
          np.set(posBuf);
          posBuf = np;
          const nn = new Float32Array(nrmBuf.length * 2);
          nn.set(nrmBuf);
          nrmBuf = nn;
          const nm = new Uint8Array(matBuf.length * 2);
          nm.set(matBuf);
          matBuf = nm;
        }
        // local sample coord → world: sample w sits at w + 0.5
        posBuf[vc * 3] = gx + px + 0.5;
        posBuf[vc * 3 + 1] = gy + py + 0.5;
        posBuf[vc * 3 + 2] = gz + pz + 0.5;

        let gxn = tri(px + 1, py, pz) - tri(px - 1, py, pz);
        let gyn = tri(px, py + 1, pz) - tri(px, py - 1, pz);
        let gzn = tri(px, py, pz + 1) - tri(px, py, pz - 1);
        let gl = Math.hypot(gxn, gyn, gzn);
        if (gl < 1e-5) {
          gxn = 0;
          gyn = -1;
          gzn = 0;
          gl = 1;
        }
        nrmBuf[vc * 3] = -gxn / gl;
        nrmBuf[vc * 3 + 1] = -gyn / gl;
        nrmBuf[vc * 3 + 2] = -gzn / gl;

        // material weights from the solid corners
        mw.fill(0);
        let wsum = 0;
        for (let c = 0; c < 8; c++) {
          const dv = cornerD[c];
          if (dv < ISO) continue;
          const o = CORNER[c];
          const m = world.material[gx + i + o[0] + wsx * (gz + k + o[2] + wsz * (gy + j + o[1]))];
          const w = dv - (ISO - 1);
          mw[m < MAT_CHANNELS ? m : 0] += w;
          wsum += w;
        }
        const mo = vc * MAT_CHANNELS;
        for (let m = 0; m < MAT_CHANNELS; m++) matBuf[mo + m] = wsum > 0 ? Math.round((mw[m] / wsum) * 255) : 0;

        vertId[base] = vc++;
      }
    }
  }
  if (vc === 0) return EMPTY;

  // ---- quads: one per owned sign-changing edge (local min sample 2 .. n-3) ----
  let ic = 0;
  const stride = [1, nxz, nx]; // local index stride for x, y, z
  const nn = [nx, ny, nz];
  for (let j = 2; j <= ny - 3; j++) {
    for (let k = 2; k <= nz - 3; k++) {
      for (let i = 2; i <= nx - 3; i++) {
        const base = i + nx * (k + nz * j);
        const s0 = grid[base] >= ISO;
        for (let a = 0; a < 3; a++) {
          const s1 = grid[base + stride[a]] >= ISO;
          if (s0 === s1) continue;
          const b = (a + 1) % 3;
          const c = (a + 2) % 3;
          const v0 = vertId[base - stride[b] - stride[c]];
          const v1 = vertId[base - stride[c]];
          const v2 = vertId[base];
          const v3 = vertId[base - stride[b]];
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue; // cannot happen; defensive
          if (ic + 6 > idxBuf.length) {
            const ni = new Uint32Array(idxBuf.length * 2);
            ni.set(idxBuf);
            idxBuf = ni;
          }
          if (s0) {
            idxBuf[ic++] = v0;
            idxBuf[ic++] = v1;
            idxBuf[ic++] = v2;
            idxBuf[ic++] = v0;
            idxBuf[ic++] = v2;
            idxBuf[ic++] = v3;
          } else {
            idxBuf[ic++] = v0;
            idxBuf[ic++] = v2;
            idxBuf[ic++] = v1;
            idxBuf[ic++] = v0;
            idxBuf[ic++] = v3;
            idxBuf[ic++] = v2;
          }
        }
      }
    }
  }
  void nn;
  if (ic === 0) return EMPTY;

  // ---- compact: drop vertices not referenced by this chunk's quads ----
  const remap = new Int32Array(vc).fill(-1);
  let nv = 0;
  for (let q = 0; q < ic; q++) {
    const v = idxBuf[q];
    if (remap[v] < 0) remap[v] = nv++;
  }
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const matWeights = new Uint8Array(nv * MAT_CHANNELS);
  for (let v = 0; v < vc; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions[r * 3] = posBuf[v * 3];
    positions[r * 3 + 1] = posBuf[v * 3 + 1];
    positions[r * 3 + 2] = posBuf[v * 3 + 2];
    normals[r * 3] = nrmBuf[v * 3];
    normals[r * 3 + 1] = nrmBuf[v * 3 + 1];
    normals[r * 3 + 2] = nrmBuf[v * 3 + 2];
    for (let m = 0; m < MAT_CHANNELS; m++) matWeights[r * MAT_CHANNELS + m] = matBuf[v * MAT_CHANNELS + m];
  }
  const indices = new Uint32Array(ic);
  for (let q = 0; q < ic; q++) indices[q] = remap[idxBuf[q]];
  return { positions, normals, indices, matWeights, vertexCount: nv, triangleCount: ic / 3 };
}
