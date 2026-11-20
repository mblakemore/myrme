import * as THREE from 'three';
import { CHUNK_SIZE, ISO, MAT_CHANNELS, type CutPlane, type FrameInfo, type MeshData, type MeshOptionsB4, type VoxelWorld } from '../../core';
import { acquireNoiseTextures, releaseNoiseTextures } from '../../assets/textures/noiseTextures';
import { CUT_ENTITY_MARGIN } from '../../world/cut';
import { chunkOrigin, meshChunk } from '../../world/mesher';
import type { Module, RenderContext } from '../shared';
import { getEnv, type GroundField } from './skyEnv';
import { createTerrainMaterial, type TerrainMaterial } from './terrainMaterial';

/**
 * Terrain (§5.3, D8, D9). Chunks are meshed by the surface-nets mesher; dirty chunks (world
 * edits, cutaway changes) are remeshed nearest-to-focus first under `quality.remeshBudgetMs`
 * (`ctx.sync` lifts the budget).
 *
 * Draw-call budget (§12): chunk meshes are not drawn individually. Chunks are grouped into
 * regions of REGION×REGION chunk columns (full height); each region owns ONE merged
 * BufferGeometry rebuilt from the cached per-chunk mesh data whenever one of its chunks changes.
 * Empty chunks cost nothing. A 192×64×192 meadow becomes ≤ 36 draws per pass instead of ~150.
 *
 * Geometry attributes: position, normal, matW0 (material ids 0-3), matW1 (4-7), matW2 (8-11) as
 * normalised Uint8. Material: see terrainMaterial.ts.
 *
 * Cutaway floor apron (B4, integration item g): entities below ground stay visible up to
 * `CUT_ENTITY_MARGIN` past the cut plane (world/cut.ts), but the terrain there is removed, so
 * they used to float over the cut face. For chunks touching that slab the mesher is run a second
 * time with `shell` (see `MeshOptionsB4`); the up-facing, below-ground triangles are kept and
 * drawn with a dithered variant of the terrain material that fades out towards the viewer — a
 * ghosted continuation of every tunnel and chamber floor.
 *
 * Side products kept in sync with edits: the ground height field (skyEnv) and, on slab maps,
 * the slab thickness texture used by the gel shader's faked absorption.
 */

const REGION = 2;

interface Region {
  chunks: number[];
  mesh: THREE.Mesh | null;
  dirty: boolean;
  shellMesh: THREE.Mesh | null;
  shellDirty: boolean;
}

/** Does the slack slab past `cut` reach into this chunk's padded box? */
function shellTouchesChunk(cut: CutPlane | null, o: readonly number[]): boolean {
  if (!cut || !cut.enabled || cut.axis === 'y') return false;
  const a = cut.axis === 'x' ? 0 : 2;
  const lo = o[a] - 3;
  const hi = o[a] + CHUNK_SIZE + 3;
  const s0 = cut.sign > 0 ? cut.pos : cut.pos - CUT_ENTITY_MARGIN - 1;
  const s1 = cut.sign > 0 ? cut.pos + CUT_ENTITY_MARGIN + 1 : cut.pos;
  return hi > s0 && lo < s1;
}

/**
 * Keeps the walkable floors of a slack-slab mesh: up-facing triangles that are not part of a flat
 * cap and (outdoors) lie below the ground surface. Returns null when nothing is left.
 */
function floorsOnly(d: MeshData, ground: GroundField | null): MeshData | null {
  const P = d.positions;
  const N = d.normals;
  const I = d.indices;
  const keep = new Uint32Array(I.length);
  let ni = 0;
  for (let q = 0; q < I.length; q += 3) {
    const a = I[q];
    const b = I[q + 1];
    const c = I[q + 2];
    if (N[a * 3 + 1] < 0.3 || N[b * 3 + 1] < 0.3 || N[c * 3 + 1] < 0.3) continue;
    // true face normal (caps are flat in the cut axis, floors are not)
    const ax = P[b * 3] - P[a * 3];
    const ay = P[b * 3 + 1] - P[a * 3 + 1];
    const az = P[b * 3 + 2] - P[a * 3 + 2];
    const bx = P[c * 3] - P[a * 3];
    const by = P[c * 3 + 1] - P[a * 3 + 1];
    const bz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    if (ny < 0.35 * Math.hypot(nx, ny, nz)) continue;
    if (ground) {
      const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
      const cy = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3;
      const cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
      if (ground.heightAt(cx, cz) - cy < 1.3) continue;
    }
    keep[ni++] = a;
    keep[ni++] = b;
    keep[ni++] = c;
  }
  if (ni === 0) return null;
  const remap = new Int32Array(d.vertexCount).fill(-1);
  let nv = 0;
  for (let q = 0; q < ni; q++) if (remap[keep[q]] < 0) remap[keep[q]] = nv++;
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const matWeights = new Uint8Array(nv * MAT_CHANNELS);
  for (let v = 0; v < d.vertexCount; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions.set(P.subarray(v * 3, v * 3 + 3), r * 3);
    normals.set(N.subarray(v * 3, v * 3 + 3), r * 3);
    matWeights.set(d.matWeights.subarray(v * MAT_CHANNELS, (v + 1) * MAT_CHANNELS), r * MAT_CHANNELS);
  }
  const indices = new Uint32Array(ni);
  for (let q = 0; q < ni; q++) indices[q] = remap[keep[q]];
  return { positions, normals, indices, matWeights, vertexCount: nv, triangleCount: ni / 3 };
}

const _o: [number, number, number] = [0, 0, 0];

function cutKey(c: CutPlane): string {
  return c.enabled ? `${c.axis}${c.sign}${c.pos}` : '';
}

/** Does `cut` change what this chunk's mesh looks like? (hidden region touches its padded box) */
function cutTouchesChunk(cut: CutPlane | null, o: readonly number[]): boolean {
  if (!cut || !cut.enabled) return false;
  const a = cut.axis === 'x' ? 0 : cut.axis === 'y' ? 1 : 2;
  const lo = o[a] - 3;
  const hi = o[a] + CHUNK_SIZE + 3;
  return cut.sign > 0 ? hi > cut.pos : lo < cut.pos;
}

/** Fraction of solid along the slab axis per (u, y) column — the gel shader's thickness map. */
class SlabThickness {
  readonly tex: THREE.DataTexture;
  private readonly data: Uint8Array;
  private readonly w: number;
  private readonly h: number;
  constructor(
    world: VoxelWorld,
    private readonly axisX: boolean,
  ) {
    this.w = axisX ? world.sz : world.sx;
    this.h = world.sy;
    this.data = new Uint8Array(this.w * this.h);
    this.tex = new THREE.DataTexture(this.data, this.w, this.h, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.unpackAlignment = 1;
    this.refresh(world, 0, 0, this.w - 1, this.h - 1);
  }
  refresh(world: VoxelWorld, u0: number, y0: number, u1: number, y1: number): void {
    u0 = Math.max(0, u0);
    y0 = Math.max(0, y0);
    u1 = Math.min(this.w - 1, u1);
    y1 = Math.min(this.h - 1, y1);
    const { sx, sz, density } = world;
    const depth = this.axisX ? sx : sz;
    for (let y = y0; y <= y1; y++)
      for (let u = u0; u <= u1; u++) {
        let sum = 0;
        for (let k = 0; k < depth; k++) {
          const x = this.axisX ? k : u;
          const z = this.axisX ? u : k;
          const d = density[x + sx * (z + sz * y)];
          sum += Math.min(1, Math.max(0, (d - ISO) / 64 + 0.5));
        }
        this.data[u + y * this.w] = Math.round((sum / depth) * 255);
      }
    this.tex.needsUpdate = true;
  }
  dispose(): void {
    this.tex.dispose();
  }
}

export function createTerrainModule(): Module {
  let chunkData: (MeshData | null)[] = [];
  let chunkShell: (MeshData | null)[] = [];
  let chunkVersion: number[] = [];
  let chunkRegion: number[] = [];
  let regions: Region[] = [];
  let tm: TerrainMaterial | null = null;
  let group: THREE.Group | null = null;
  let slabTex: SlabThickness | null = null;
  let lastCut = '';
  let lastCutPlane: CutPlane | null = null;
  let initialised = false;
  const dirty: number[] = [];
  const centers: Float32Array[] = [];

  function rebuildRegion(r: Region, shell: boolean): void {
    const src = shell ? chunkShell : chunkData;
    const cur = shell ? r.shellMesh : r.mesh;
    let nv = 0;
    let ni = 0;
    for (const ci of r.chunks) {
      const d = src[ci];
      if (!d) continue;
      nv += d.vertexCount;
      ni += d.indices.length;
    }
    if (nv === 0) {
      if (cur) {
        cur.geometry.dispose();
        group!.remove(cur);
        if (shell) r.shellMesh = null;
        else r.mesh = null;
      }
      return;
    }
    const pos = new Float32Array(nv * 3);
    const nrm = new Float32Array(nv * 3);
    const w0 = new Uint8Array(nv * 4);
    const w1 = new Uint8Array(nv * 4);
    const w2 = new Uint8Array(nv * 4);
    const idx = new Uint32Array(ni);
    let vo = 0;
    let io = 0;
    for (const ci of r.chunks) {
      const d = src[ci];
      if (!d) continue;
      pos.set(d.positions, vo * 3);
      nrm.set(d.normals, vo * 3);
      const mw = d.matWeights;
      for (let v = 0, s = 0, t = vo * 4; v < d.vertexCount; v++, s += MAT_CHANNELS, t += 4) {
        w0[t] = mw[s];
        w0[t + 1] = mw[s + 1];
        w0[t + 2] = mw[s + 2];
        w0[t + 3] = mw[s + 3];
        w1[t] = mw[s + 4];
        w1[t + 1] = mw[s + 5];
        w1[t + 2] = mw[s + 6];
        w1[t + 3] = mw[s + 7];
        w2[t] = mw[s + 8];
        w2[t + 1] = mw[s + 9];
        w2[t + 2] = mw[s + 10];
        w2[t + 3] = mw[s + 11];
      }
      const ind = d.indices;
      for (let q = 0; q < ind.length; q++) idx[io + q] = ind[q] + vo;
      vo += d.vertexCount;
      io += ind.length;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('matW0', new THREE.BufferAttribute(w0, 4, true));
    geo.setAttribute('matW1', new THREE.BufferAttribute(w1, 4, true));
    geo.setAttribute('matW2', new THREE.BufferAttribute(w2, 4, true));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    if (cur) {
      cur.geometry.dispose();
      cur.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, shell ? tm!.shellMaterial : tm!.material);
      mesh.castShadow = !shell;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = shell ? 'terrain-shell' : 'terrain-region';
      if (shell) r.shellMesh = mesh;
      else r.mesh = mesh;
      group!.add(mesh);
    }
  }

  function remesh(ctx: RenderContext, ci: number): void {
    const world = ctx.sim.world;
    const edited = chunkVersion[ci] >= 0 && chunkVersion[ci] !== world.chunkVersion[ci];
    chunkVersion[ci] = world.chunkVersion[ci];
    const cut = ctx.view.cut.enabled ? ctx.view.cut : null;
    const data = meshChunk(world, ci, { cut });
    chunkData[ci] = data.vertexCount === 0 ? null : data;
    regions[chunkRegion[ci]].dirty = true;
    // floor apron in the entity slack slab past the cut plane
    chunkOrigin(world, ci, _o);
    let shell: MeshData | null = null;
    if (shellTouchesChunk(cut, _o)) {
      const opts: MeshOptionsB4 = { cut, shell: CUT_ENTITY_MARGIN };
      const raw = meshChunk(world, ci, opts);
      if (raw.vertexCount > 0) shell = floorsOnly(raw, ctx.map.flags.slab || ctx.map.boundary === 'glass' ? null : getEnv(ctx).ground);
    }
    if (shell || chunkShell[ci]) regions[chunkRegion[ci]].shellDirty = true;
    chunkShell[ci] = shell;
    if (edited && initialised) {
      chunkOrigin(world, ci, _o);
      getEnv(ctx).ground.refresh(world, _o[0] - 1, _o[2] - 1, _o[0] + CHUNK_SIZE, _o[2] + CHUNK_SIZE);
      if (slabTex) {
        const u0 = ctx.map.flags.slabAxis === 'x' ? _o[2] : _o[0];
        slabTex.refresh(world, u0 - 1, _o[1] - 1, u0 + CHUNK_SIZE, _o[1] + CHUNK_SIZE);
      }
    }
  }

  return {
    id: 'terrain',
    init(ctx) {
      const world = ctx.sim.world;
      const noise = acquireNoiseTextures(ctx.renderer);
      tm = createTerrainMaterial(ctx, noise);
      if (ctx.map.flags.slab) {
        slabTex = new SlabThickness(world, ctx.map.flags.slabAxis === 'x');
        tm.uniforms.uSlabTex.value = slabTex.tex;
      } else {
        const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        white.needsUpdate = true;
        tm.uniforms.uSlabTex.value = white;
      }
      group = new THREE.Group();
      group.name = 'terrain';
      ctx.scene.add(group);
      const n = world.ncx * world.ncy * world.ncz;
      const nrx = Math.ceil(world.ncx / REGION);
      const nrz = Math.ceil(world.ncz / REGION);
      chunkData = new Array<MeshData | null>(n).fill(null);
      chunkShell = new Array<MeshData | null>(n).fill(null);
      chunkVersion = new Array<number>(n).fill(-1);
      chunkRegion = new Array<number>(n).fill(0);
      regions = [];
      for (let i = 0; i < nrx * nrz; i++) regions.push({ chunks: [], mesh: null, dirty: false, shellMesh: null, shellDirty: false });
      centers.length = 0;
      for (let ci = 0; ci < n; ci++) {
        chunkOrigin(world, ci, _o);
        const ri = Math.floor(_o[0] / CHUNK_SIZE / REGION) + nrx * Math.floor(_o[2] / CHUNK_SIZE / REGION);
        chunkRegion[ci] = ri;
        regions[ri].chunks.push(ci);
        centers.push(new Float32Array([_o[0] + CHUNK_SIZE / 2, _o[1] + CHUNK_SIZE / 2, _o[2] + CHUNK_SIZE / 2]));
      }
      initialised = false;
      lastCut = '';
      lastCutPlane = null;
    },
    update(ctx: RenderContext, _frame: FrameInfo) {
      const world = ctx.sim.world;
      const cut = ctx.view.cut;
      const key = cutKey(cut);
      if (key !== lastCut) {
        // only chunks whose mesh depends on the old or the new plane need a remesh
        for (let ci = 0; ci < chunkVersion.length; ci++) {
          chunkOrigin(world, ci, _o);
          if (cutTouchesChunk(lastCutPlane, _o) || cutTouchesChunk(cut, _o) || shellTouchesChunk(lastCutPlane, _o) || shellTouchesChunk(cut, _o)) chunkVersion[ci] = -1;
        }
        lastCut = key;
        lastCutPlane = cut.enabled ? { ...cut } : null;
        // exact position of the capped face (see mesher: the cap sits on a cell boundary)
        const cp = tm!.uniforms.uCapPlane.value;
        if (cut.enabled) {
          const p = Math.ceil(cut.pos - 0.5);
          cp.set(cut.axis === 'x' ? 1 : 0, cut.axis === 'y' ? 1 : 0, cut.axis === 'z' ? 1 : 0, -p);
          tm!.uniforms.uShell.value.set(cut.sign, CUT_ENTITY_MARGIN, 0, 0);
        } else cp.set(0, 0, 0, 0);
      }
      dirty.length = 0;
      for (let ci = 0; ci < chunkVersion.length; ci++) if (chunkVersion[ci] !== world.chunkVersion[ci]) dirty.push(ci);
      if (dirty.length) {
        const f = ctx.view.camera.focus;
        const d2 = (ci: number): number => {
          const c = centers[ci];
          return (c[0] - f.x) ** 2 + (c[1] - f.y) ** 2 + (c[2] - f.z) ** 2;
        };
        dirty.sort((a, b) => d2(a) - d2(b));
        const t0 = performance.now();
        const budget = ctx.sync || !initialised ? Infinity : ctx.quality.remeshBudgetMs;
        let done = 0;
        for (const ci of dirty) {
          remesh(ctx, ci);
          done++;
          if (performance.now() - t0 > budget) break;
        }
        ctx.stats.pendingChunks = dirty.length - done;
        for (const r of regions) {
          if (r.dirty) {
            r.dirty = false;
            rebuildRegion(r, false);
          }
          if (r.shellDirty) {
            r.shellDirty = false;
            rebuildRegion(r, true);
          }
        }
        if (done === dirty.length) initialised = true;
      } else {
        ctx.stats.pendingChunks = 0;
        initialised = true;
      }
    },
    /** Renderer pre-warm hook: the cutaway shell material is compiled before the first cutaway. */
    prewarm(ctx: RenderContext): (() => void) | void {
      if (!tm) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
      for (const n of ['matW0', 'matW1', 'matW2']) geo.setAttribute(n, new THREE.BufferAttribute(new Uint8Array(12), 4, true));
      const mesh = new THREE.Mesh(geo, tm.shellMaterial);
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      ctx.scene.add(mesh);
      return () => {
        mesh.removeFromParent();
        geo.dispose();
      };
    },

    dispose() {
      for (const r of regions) {
        r.mesh?.geometry.dispose();
        r.shellMesh?.geometry.dispose();
      }
      tm?.material.dispose();
      tm?.shellMaterial.dispose();
      if (!slabTex) tm?.uniforms.uSlabTex.value?.dispose();
      slabTex?.dispose();
      slabTex = null;
      group?.removeFromParent();
      regions = [];
      chunkData = [];
      chunkShell = [];
      if (tm) releaseNoiseTextures();
      tm = null;
    },
  };
}

export const terrainModule: Module = createTerrainModule();
