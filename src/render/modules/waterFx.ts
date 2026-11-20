import * as THREE from 'three';
import { b3StateOf, ISO, waterEx, type CellIndex, type FrameInfo, type MapId } from '../../core';
import type { Module, RenderContext } from '../shared';
import { fx } from './fxShared';
import { getEnv } from './skyEnv';
import { addRipple, resetWaterShared, RIPPLE_COUNT, waterShared } from './waterShared';
import { weatherDrops } from './weatherFx';

/**
 * Water FX (§5.3, D17): renders the sim's sparse flooded-cell field (`sim.water`) as a real water
 * body.
 *
 *  - One merged mesh rebuilt (throttled) whenever `water.version` or the cutaway changes:
 *    smoothed top faces (corner heights averaged over neighbouring cells, tucked half a cell into
 *    the surrounding rock so the shoreline follows the terrain isosurface), open side faces, and
 *    CAP faces wherever the water body meets a glass pane, the diorama edge or the cutaway plane —
 *    so a flooded tunnel reads as a filled cross-section with a bright meniscus line.
 *  - Drawn twice: a depth-only prepass, then the shaded pass at equal depth, so only the nearest
 *    water layer is blended (no patchy double tint) and AO / DoF / fog see the surface.
 *  - Shading: murky depth absorption (per-vertex column depth), fresnel reflection of the sky cube
 *    (faded underground), sun glint, travelling wavelets, shoreline foam from the terrain SDF,
 *    expanding ripple rings (`waterShared.uRipples`: swimming / drowning / rafting ants, floating
 *    items, droplet impacts) and procedural rain rings while it rains (`waterShared.uRain`).
 *  - Surface puddles come from the same field and get the open-sky treatment automatically.
 *  - `keeper` event `dropWater`: a giant drop is handed to weatherFx (falls, splashes, ripples).
 *
 * Sim inputs: `water.forEachFlooded/depthAt/isFlooded/version/floodedCount`, `ant.submerged`,
 * `ant.cell`, `ant.anim === 'raft'`, `item.cell/carriedBy`, `view.cut`, events `keeper`, `flood`;
 * B2 `waterEx(water).revision` (depth-only changes) and B3 `b3StateOf(sim).rafts` (pos, radius,
 * drift, phase) when those streams are present.
 */

const MIN_DEPTH = 0.04;

const TINTS: Record<MapId, { deep: [number, number, number]; shallow: [number, number, number] }> = {
  meadow: { deep: [0.025, 0.065, 0.085], shallow: [0.15, 0.25, 0.27] },
  forest: { deep: [0.025, 0.06, 0.06], shallow: [0.13, 0.21, 0.19] },
  desert: { deep: [0.07, 0.1, 0.1], shallow: [0.3, 0.33, 0.28] },
  // teal, not blue: it has to stand out against both the blue gel and the pale tunnels
  gelFarm: { deep: [0.0, 0.16, 0.17], shallow: [0.06, 0.46, 0.42] },
  sandFarm: { deep: [0.05, 0.1, 0.13], shallow: [0.3, 0.42, 0.46] },
  formicarium: { deep: [0.05, 0.09, 0.12], shallow: [0.4, 0.5, 0.55] },
};

const VERT = /* glsl */ `
attribute vec4 aInfo; // surface y, column depth, shore 0..1, sky 0..1
varying vec3 vW;
varying vec4 vInfo;
varying vec3 vN;
void main() {
  vW = position;
  vInfo = aInfo;
  vN = normal;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const PRE_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
varying vec3 vW;
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  gl_FragColor = vec4(0.0);
}`;

const FRAG = /* glsl */ `
uniform samplerCube uEnvCube;
uniform float uHasCube;
uniform vec3 uSkyA;
uniform vec3 uSkyB;
uniform vec3 uSunDirW;
uniform vec3 uKeyColor;
uniform vec3 uAmbientColor;
uniform vec4 uCutPlane;
uniform float uClock;
uniform vec4 uRipples[${RIPPLE_COUNT}];
uniform vec4 uRain;
uniform vec4 uRafts[4]; // xz, radius, strength
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uPheroVision;
uniform float uRoom;
varying vec3 vW;
varying vec4 vInfo;
varying vec3 vN;

float wHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 skyAt(vec3 d, float lod) {
  vec3 a = mix(uSkyA, uSkyB, smoothstep(-0.1, 0.8, d.y));
  if (uHasCube > 0.5) return textureCube(uEnvCube, d, lod).rgb;
  return a;
}
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  bool top = vN.y > 0.5;
  float t = uClock;
  float sky = vInfo.w;
  vec2 p = top ? vW.xz : vec2(vW.x + vW.z, vW.y);
  // ---- surface slope: wavelets + ripple rings + rain rings ----
  vec2 g = vec2(0.0);
  float crest = 0.0;
  {
    vec2 q = p * 1.7 + vec2(wNoise(p * 0.6 + t * 0.05), wNoise(p * 0.6 - t * 0.04)) * 1.5;
    g += 0.05 * vec2(cos(q.x * 2.3 + t * 1.1) + 0.6 * cos(q.x * 4.9 - q.y * 3.1 + t * 1.7), cos(q.y * 2.7 - t * 0.9) + 0.6 * cos(q.y * 5.3 + q.x * 2.2 - t * 1.4));
    float n1 = wNoise(p * 5.0 + vec2(t * 0.35, -t * 0.22));
    float n2 = wNoise(p * 5.0 + vec2(0.31, 0.17) + vec2(t * 0.35, -t * 0.22));
    g += 0.07 * vec2(n1 - 0.5, n2 - 0.5);
  }
  if (top) {
    for (int i = 0; i < ${RIPPLE_COUNT}; i++) {
      vec4 r = uRipples[i];
      float age = t - r.z;
      if (r.w <= 0.0 || age < 0.0 || age > 3.2) continue;
      vec2 dv = vW.xz - r.xy;
      float d = length(dv);
      float x = d - age * 1.7 - 0.15;
      float env = exp(-x * x * 4.0) * r.w * (1.0 - age / 3.2) / (1.0 + d * 0.45) * smoothstep(0.0, 0.25, age);
      g += (dv / max(d, 1e-3)) * (-sin(x * 9.0) * env * 0.9);
      crest += max(cos(x * 9.0), 0.0) * env * 0.22;
    }
    if (uRain.x > 0.01 && sky > 0.05) {
      // rain rings: one random expanding ring per grid cell, two offset layers
      for (int l = 0; l < 2; l++) {
        vec2 gp = vW.xz * (l == 0 ? 0.9 : 0.61) + float(l) * 17.3;
        vec2 id = floor(gp);
        vec2 f = fract(gp) - 0.5;
        float h = wHash(id + float(l) * 7.0);
        float ph = fract(t * (0.8 + 0.5 * h) + h * 9.0);
        vec2 c = (vec2(wHash(id + 3.1), wHash(id + 8.7)) - 0.5) * 0.5;
        vec2 dv = f - c;
        float d = length(dv);
        float x = d - ph * 0.42;
        float env = exp(-x * x * 260.0) * (1.0 - ph) * step(h, uRain.x * 1.2) * sky;
        g += (dv / max(d, 1e-3)) * (-sin(x * 40.0) * env * 1.6);
        crest += max(cos(x * 40.0), 0.0) * env * 0.6;
      }
    }
  }
  vec3 N = top ? normalize(vec3(-g.x, 1.0, -g.y)) : normalize(vN + vec3(g.x, g.y * 0.5, g.x) * 0.6);
  vec3 V = normalize(cameraPosition - vW);
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  // ---- body: depth absorption ----
  float depth = top ? vInfo.y : max(vInfo.x - vW.y, 0.0) + 0.35;
  float absorb = 1.0 - exp(-depth * 0.8);
  float murk = wNoise(p * 0.9 + vec2(t * 0.06, t * 0.03)) * 0.5 + wNoise(p * 2.7 - t * 0.05) * 0.25;
  vec3 light = uAmbientColor * (0.75 + 0.5 * uRoom) + uKeyColor * 0.32 * sky * max(uSunDirW.y, 0.0) + vec3(0.03, 0.028, 0.024);
  vec3 body = mix(uShallow, uDeep, absorb) * (0.8 + 0.5 * murk) * light * 2.2;
  float alpha = top ? mix(0.4, 0.9, absorb) : mix(0.55, 0.93, absorb);

  // ---- reflection ----
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = skyAt(R, 1.0) * mix(0.12, 1.0, max(sky, uRoom * 0.7));
  vec3 col = body;
  col += refl * fres;
  vec3 H = normalize(V + uSunDirW);
  col += uKeyColor * pow(max(dot(N, H), 0.0), 420.0) * 3.0 * sky;
  col += (uAmbientColor + uKeyColor * 0.3 * sky) * crest * 0.5;
  alpha = max(alpha, fres);

  if (top) {
    // shallow puddles: the water body is lit far less than the sunlit ground around it, so a thin
    // film at 40 % opacity read as a dark hole — let the bed show through and carry the puddle on
    // a soft sky sheen instead
    float thin = (1.0 - smoothstep(0.12, 0.8, vInfo.y)) * (1.0 - uRoom);
    alpha = mix(alpha, max(0.16, fres), thin * 0.8);
    col += skyAt(R, 2.0) * 0.16 * sky * (1.0 - fres) * (0.4 + 0.6 * thin);
    // shoreline foam: broken, lazy bubbles where the surface meets the wall
    float fn = wNoise(p * 3.1 + t * 0.15) * 0.6 + wNoise(p * 7.3 - t * 0.22) * 0.4;
    float foam = smoothstep(0.8, 1.05, vInfo.z + (fn - 0.5) * 0.4) * smoothstep(0.25, 0.7, fn);
    foam += crest * 0.25;
    // living rafts: a dimpled meniscus hugging the raft's rim, the water darkened under the bodies
    for (int i = 0; i < 4; i++) {
      vec4 rf = uRafts[i];
      if (rf.w <= 0.0) continue;
      float dr = length(vW.xz - rf.xy) - rf.z;
      float wob = 0.12 * sin(atan(vW.z - rf.y, vW.x - rf.x) * 9.0 + t * 0.7);
      foam += exp(-pow((dr - 0.05 + wob) * 6.0, 2.0)) * (0.1 + 0.45 * fn) * rf.w;
      col *= 1.0 - 0.3 * rf.w * (1.0 - smoothstep(-0.6, 0.15, dr));
    }
    foam = clamp(foam, 0.0, 1.0);
    vec3 foamC = (uAmbientColor * 1.6 + uKeyColor * 0.45 * sky + 0.03) * mix(vec3(0.8, 0.78, 0.7), vec3(1.0), sky);
    col = mix(col, foamC, foam * 0.6);
    alpha = max(alpha, foam * 0.7);
  } else {
    // cross-section: meniscus — a bright lens line along the surface, darker just below
    float dS = vInfo.x - vW.y;
    float men = 1.0 - smoothstep(0.02, 0.12, dS);
    men *= men;
    float under = smoothstep(0.08, 0.14, dS) * (1.0 - smoothstep(0.14, 0.5, dS));
    col *= 1.0 - 0.25 * under;
    col += (uAmbientColor * 2.2 + uKeyColor * 0.35 + skyAt(vec3(0.0, 1.0, 0.0), 2.0) * 0.5 * max(sky, uRoom)) * men * 0.2;
    // suspended silt drifting in the section
    float silt = smoothstep(0.72, 0.95, wNoise(p * 9.0 + vec2(t * 0.1, t * 0.04)));
    col += light * silt * 0.12 * absorb;
    alpha = max(alpha, men * 0.55);
  }
  float lum = dot(col, vec3(0.3, 0.6, 0.1));
  col = mix(col, vec3(lum * 0.35) + vec3(0.03, 0.09, 0.14) * (0.4 + fres), uPheroVision * 0.85);
  gl_FragColor = vec4(col, alpha);
}`;

export function createWaterFxModule(): Module {
  let geo: THREE.BufferGeometry | null = null;
  let mesh: THREE.Mesh | null = null;
  let pre: THREE.Mesh | null = null;
  let mat: THREE.ShaderMaterial | null = null;
  let preMat: THREE.ShaderMaterial | null = null;
  let cap = 0;
  let pos = new Float32Array(0);
  let nrm = new Float32Array(0);
  let info = new Float32Array(0);
  let idx = new Uint32Array(0);
  let nv = 0;
  let ni = 0;
  let lastVersion = -1;
  let lastCutKey = '';
  let lastBuild = -1e9;
  // scratch (not per-frame: per rebuild)
  let cells = new Int32Array(1024);
  let depths = new Float32Array(1024);
  let nCells = 0;
  const cornerSum = new Map<number, number>();
  const cornerCnt = new Map<number, number>();
  const cornerDep = new Map<number, number>();
  const colTop = new Map<number, number>();
  let worldSx = 1;
  const collect = (cell: CellIndex, d: number): void => {
    if (d < MIN_DEPTH || cell < 0) return;
    if (nCells >= cells.length) {
      const c2 = new Int32Array(cells.length * 2);
      c2.set(cells);
      cells = c2;
      const d2 = new Float32Array(depths.length * 2);
      d2.set(depths);
      depths = d2;
    }
    cells[nCells] = cell;
    depths[nCells++] = d;
  };

  function ensure(verts: number): void {
    if (verts <= cap || !geo) return;
    cap = Math.max(verts, Math.ceil(cap * 1.7), 2048);
    const p2 = new Float32Array(cap * 3);
    p2.set(pos.subarray(0, nv * 3));
    pos = p2;
    const n2 = new Float32Array(cap * 3);
    n2.set(nrm.subarray(0, nv * 3));
    nrm = n2;
    const i2 = new Float32Array(cap * 4);
    i2.set(info.subarray(0, nv * 4));
    info = i2;
    const x2 = new Uint32Array(Math.ceil(cap * 1.5));
    x2.set(idx.subarray(0, ni));
    idx = x2;
    geo.dispose();
    const mk = (arr: Float32Array, size: number): THREE.BufferAttribute => {
      const a = new THREE.BufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('position', mk(pos, 3));
    geo.setAttribute('normal', mk(nrm, 3));
    geo.setAttribute('aInfo', mk(info, 4));
    const ia = new THREE.BufferAttribute(idx, 1);
    ia.setUsage(THREE.DynamicDrawUsage);
    geo.setIndex(ia);
  }

  function vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, surf: number, depth: number, shore: number, sky: number): number {
    const k = nv * 3;
    pos[k] = x;
    pos[k + 1] = y;
    pos[k + 2] = z;
    nrm[k] = nx;
    nrm[k + 1] = ny;
    nrm[k + 2] = nz;
    const j = nv * 4;
    info[j] = surf;
    info[j + 1] = depth;
    info[j + 2] = shore;
    info[j + 3] = sky;
    return nv++;
  }
  function quad(a: number, b: number, c: number, d: number): void {
    idx[ni++] = a;
    idx[ni++] = b;
    idx[ni++] = c;
    idx[ni++] = a;
    idx[ni++] = c;
    idx[ni++] = d;
  }

  function rebuild(ctx: RenderContext): void {
    const sim = ctx.sim;
    const world = sim.world;
    const water = sim.water;
    const env = getEnv(ctx);
    const { sx, sy, sz } = world;
    const layer = sx * sz;
    const dens = world.density;
    const cut = ctx.view.cut;
    const room = env.room;
    worldSx = sx;
    nCells = 0;
    water.forEachFlooded(collect);
    cornerSum.clear();
    cornerCnt.clear();
    cornerDep.clear();
    colTop.clear();
    nv = 0;
    ni = 0;
    waterShared.flooded = nCells;

    const wet = (x: number, y: number, z: number): boolean => x >= 0 && z >= 0 && y >= 0 && x < sx && z < sz && y < sy && water.depthAt(x + sx * (z + sz * y)) >= MIN_DEPTH;
    const solid = (x: number, y: number, z: number): boolean => x >= 0 && z >= 0 && y >= 0 && x < sx && z < sz && y < sy && dens[x + sx * (z + sz * y)] >= ISO;
    const oob = (x: number, z: number): boolean => x < 0 || z < 0 || x >= sx || z >= sz;
    const cutPos = cut.pos;
    const cutSign = cut.sign;
    const hiddenC = (x: number, y: number, z: number): boolean => cut.enabled && cutSign * ((cut.axis === 'x' ? x : cut.axis === 'y' ? y : z) + 0.5 - cutPos) > 0;
    const ckey = (vx: number, vz: number, y: number): number => vx + (sx + 1) * (vz + (sz + 1) * y);

    // pass 1: corner heights of the top faces
    for (let i = 0; i < nCells; i++) {
      const c = cells[i];
      const x = c % sx;
      const z = Math.floor(c / sx) % sz;
      const y = Math.floor(c / layer);
      if (hiddenC(x, y, z)) continue;
      const d = depths[i];
      if (wet(x, y + 1, z)) continue;
      const h = y + Math.min(1, d);
      const col = x + sx * z;
      const prev = colTop.get(col);
      if (prev === undefined || h > prev) colTop.set(col, h);
      let colDepth = Math.min(1, d);
      for (let yy = y - 1; yy >= 0 && colDepth < 10 && wet(x, yy, z); yy--) colDepth += 1;
      for (let k = 0; k < 4; k++) {
        const key = ckey(x + (k & 1), z + (k >> 1), y);
        cornerDep.set(key, (cornerDep.get(key) ?? 0) + colDepth);
        cornerSum.set(key, (cornerSum.get(key) ?? 0) + h);
        cornerCnt.set(key, (cornerCnt.get(key) ?? 0) + 1);
      }
    }
    const cornerH = (vx: number, vz: number, y: number, fallback: number): number => {
      const key = ckey(vx, vz, y);
      const n = cornerCnt.get(key);
      return n ? cornerSum.get(key)! / n : fallback;
    };
    const cornerD = (vx: number, vz: number, y: number): number => {
      const key = ckey(vx, vz, y);
      const n = cornerCnt.get(key);
      return n ? cornerDep.get(key)! / n : 0.5;
    };
    const shoreAt = (x: number, y: number, z: number): number => {
      const s = world.sample(x, y + 0.2, z);
      const t = Math.min(1, Math.max(0, (s + 0.7) / 0.7));
      return t * t * (3 - 2 * t);
    };
    const skyAt = (x: number, z: number, h: number): number => {
      if (room) return 0.5;
      const gh = env.ground.heightAt(x, z);
      return Math.min(1, Math.max(0, (h - (gh - 1.6)) / 1.0));
    };

    ensure(nCells * 8 + 64);
    // pass 2: faces
    for (let i = 0; i < nCells; i++) {
      const c = cells[i];
      const x = c % sx;
      const z = Math.floor(c / sx) % sz;
      const y = Math.floor(c / layer);
      if (hiddenC(x, y, z)) continue;
      if (nv + 24 > cap) ensure(nv + 4096);
      const d = Math.min(1, depths[i]);
      const aboveWet = wet(x, y + 1, z);
      const h = aboveWet ? y + 1 : y + d;
      // column: surface height and depth below it
      let surf = h;
      if (aboveWet) {
        let yy = y + 1;
        while (yy < sy && wet(x, yy, z)) {
          surf = yy + Math.min(1, water.depthAt(x + sx * (z + sz * yy)));
          yy++;
        }
      }
      const ex0 = solid(x - 1, y, z) ? 0.5 : 0;
      const ex1 = solid(x + 1, y, z) ? 0.5 : 0;
      const ez0 = solid(x, y, z - 1) ? 0.5 : 0;
      const ez1 = solid(x, y, z + 1) ? 0.5 : 0;
      const h00 = aboveWet ? y + 1 : cornerH(x, z, y, h);
      const h10 = aboveWet ? y + 1 : cornerH(x + 1, z, y, h);
      const h11 = aboveWet ? y + 1 : cornerH(x + 1, z + 1, y, h);
      const h01 = aboveWet ? y + 1 : cornerH(x, z + 1, y, h);

      if (!aboveWet && !(d >= 0.995 && solid(x, y + 1, z))) {
        const sky = skyAt(x + 0.5, z + 0.5, h);
        const s00 = ex0 || ez0 ? 1 : shoreAt(x, h00, z);
        const s10 = ex1 || ez0 ? 1 : shoreAt(x + 1, h10, z);
        const s11 = ex1 || ez1 ? 1 : shoreAt(x + 1, h11, z + 1);
        const s01 = ex0 || ez1 ? 1 : shoreAt(x, h01, z + 1);
        const a = vert(x - ex0, h00, z - ez0, 0, 1, 0, h00, cornerD(x, z, y) * (1 - 0.6 * s00), s00, sky);
        const b = vert(x - ex0, h01, z + 1 + ez1, 0, 1, 0, h01, cornerD(x, z + 1, y) * (1 - 0.6 * s01), s01, sky);
        const cc = vert(x + 1 + ex1, h11, z + 1 + ez1, 0, 1, 0, h11, cornerD(x + 1, z + 1, y) * (1 - 0.6 * s11), s11, sky);
        const dd = vert(x + 1 + ex1, h10, z - ez0, 0, 1, 0, h10, cornerD(x + 1, z, y) * (1 - 0.6 * s10), s10, sky);
        quad(a, b, cc, dd);
      }

      // side faces / caps
      const yb = y - (solid(x, y - 1, z) ? 0.5 : 0);
      const topPad = aboveWet ? 0 : 0;
      for (let dir = 0; dir < 4; dir++) {
        const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
        const dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
        const nx = x + dx;
        const nz = z + dz;
        const out = oob(nx, nz);
        const cutN = !out && hiddenC(nx, y, nz);
        if (!out && !cutN && (solid(nx, y, nz) || wet(nx, y, nz))) continue;
        const capFace = out || cutN;
        const sky = capFace ? skyAt(x + 0.5, z + 0.5, surf) : skyAt(x + 0.5, z + 0.5, h);
        if (dx !== 0) {
          let fx_ = dx > 0 ? x + 1 : x;
          if (cutN && cut.axis === 'x') fx_ = dx > 0 ? Math.min(fx_, cutPos) - 0.012 : Math.max(fx_, cutPos) + 0.012;
          else if (out) fx_ += dx > 0 ? -0.012 : 0.012;
          const t0 = z - (capFace ? ez0 : 0);
          const t1 = z + 1 + (capFace ? ez1 : 0);
          const ha = dx > 0 ? h10 : h00;
          const hb = dx > 0 ? h11 : h01;
          const a = vert(fx_, yb, t0, dx, 0, 0, surf, 0, 0, sky);
          const b = vert(fx_, yb, t1, dx, 0, 0, surf, 0, 0, sky);
          const cc = vert(fx_, hb + topPad, t1, dx, 0, 0, surf, 0, 0, sky);
          const dd = vert(fx_, ha + topPad, t0, dx, 0, 0, surf, 0, 0, sky);
          if (dx > 0) quad(a, dd, cc, b);
          else quad(a, b, cc, dd);
        } else {
          let fz = dz > 0 ? z + 1 : z;
          if (cutN && cut.axis === 'z') fz = dz > 0 ? Math.min(fz, cutPos) - 0.012 : Math.max(fz, cutPos) + 0.012;
          else if (out) fz += dz > 0 ? -0.012 : 0.012;
          const t0 = x - (capFace ? ex0 : 0);
          const t1 = x + 1 + (capFace ? ex1 : 0);
          const ha = dz > 0 ? h01 : h00;
          const hb = dz > 0 ? h11 : h10;
          const a = vert(t0, yb, fz, 0, 0, dz, surf, 0, 0, sky);
          const b = vert(t1, yb, fz, 0, 0, dz, surf, 0, 0, sky);
          const cc = vert(t1, hb + topPad, fz, 0, 0, dz, surf, 0, 0, sky);
          const dd = vert(t0, ha + topPad, fz, 0, 0, dz, surf, 0, 0, sky);
          if (dz > 0) quad(a, b, cc, dd);
          else quad(a, dd, cc, b);
        }
      }
    }

    if (geo) {
      const up = (name: string, n: number): void => {
        const a = geo!.getAttribute(name) as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, n);
        a.needsUpdate = true;
      };
      up('position', nv * 3);
      up('normal', nv * 3);
      up('aInfo', nv * 4);
      const ia = geo.index!;
      ia.clearUpdateRanges();
      ia.addUpdateRange(0, ni);
      ia.needsUpdate = true;
      geo.setDrawRange(0, ni);
    }
    if (mesh && pre) mesh.visible = pre.visible = ni > 0;
  }

  return {
    id: 'waterFx',
    init(ctx) {
      resetWaterShared();
      const env = getEnv(ctx);
      const tint = TINTS[ctx.sim.mapId] ?? TINTS.meadow;
      geo = new THREE.BufferGeometry();
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      cap = 0;
      nv = ni = 0;
      pos = new Float32Array(0);
      nrm = new Float32Array(0);
      info = new Float32Array(0);
      idx = new Uint32Array(0);
      ensure(2048);
      geo.setDrawRange(0, 0);
      const cutU = ctx.uniforms.uCutPlane;
      mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uEnvCube: env.uniforms.uEnvCube,
          uHasCube: { value: 0 },
          uSkyA: { value: env.horizon },
          uSkyB: { value: env.zenith },
          uSunDirW: ctx.uniforms.uSunDir,
          uKeyColor: env.uniforms.uKeyColor,
          uAmbientColor: env.uniforms.uAmbientColor,
          uCutPlane: cutU,
          uClock: fx.uClock,
          uRipples: waterShared.uRipples,
          uRain: waterShared.uRain,
          uRafts: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
          uDeep: { value: new THREE.Color(...tint.deep) },
          uShallow: { value: new THREE.Color(...tint.shallow) },
          uPheroVision: ctx.uniforms.uPheroVision,
          uRoom: { value: env.room ? 1 : 0 },
        },
        transparent: true,
        depthWrite: false,
        depthFunc: THREE.LessEqualDepth,
        side: THREE.DoubleSide,
      });
      preMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: PRE_FRAG, uniforms: { uCutPlane: cutU }, transparent: true, depthWrite: true, colorWrite: false, side: THREE.DoubleSide });
      pre = new THREE.Mesh(geo, preMat);
      pre.name = 'water:depth';
      pre.renderOrder = 1;
      mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'water';
      mesh.renderOrder = 2;
      pre.frustumCulled = mesh.frustumCulled = false;
      pre.visible = mesh.visible = false;
      ctx.scene.add(pre, mesh);
      lastVersion = -1;
      lastCutKey = '';
      lastBuild = -1e9;
      waterShared.surfaceAt = (x, z) => {
        if (colTop.size === 0) return -Infinity;
        const v = colTop.get(Math.floor(x) + worldSx * Math.floor(z));
        return v === undefined ? -Infinity : v;
      };
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      if (!mat || !mesh) return;
      const sim = ctx.sim;
      const water = sim.water;
      const cut = ctx.view.cut;
      mat.uniforms.uHasCube.value = getEnv(ctx).uniforms.uEnvCube.value ? 1 : 0;

      // ---- keeper water dropper: a giant drop handed to the droplet system ----
      const events = frame.events;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'keeper' && e.action === 'dropWater' && e.pos) weatherDrops.spawn(e.pos.x, e.pos.y + 26, e.pos.z, 1.5, 0, -30, 0, e.pos.y);
        else if (e.type === 'flood' && e.rising) addRipple(e.pos.x, e.pos.z, fx.clock, 0.5);
      }

      // ---- mesh ----
      const cutKey = cut.enabled ? cut.axis + cut.sign + ':' + cut.pos.toFixed(2) : '';
      // B2's field also reports depth-only changes (`revision`); the frozen contract only the wet set
      const rev = waterEx(water).revision;
      const stamp = typeof rev === 'number' ? rev * 31 + water.version : water.version;
      const dirty = stamp !== lastVersion || cutKey !== lastCutKey;
      const every = nCells > 4000 ? 0.3 : nCells > 1500 ? 0.18 : 0.1;
      if (dirty && (water.floodedCount > 0 || ni > 0) && (ctx.sync || frame.frozen || Math.abs(fx.clock - lastBuild) > every)) {
        lastVersion = stamp;
        lastCutKey = cutKey;
        lastBuild = fx.clock;
        rebuild(ctx);
      }
      if (water.floodedCount === 0 && ni === 0) return;

      // ---- fire-ant rafts (B3 state): rim meniscus + a slow bow wave ----
      const dA = fx.dAnim;
      const clock = fx.clock;
      const rafts = b3StateOf(sim).rafts;
      const ru = mat.uniforms.uRafts.value as THREE.Vector4[];
      for (let i = 0; i < 4; i++) {
        const r = i < rafts.length ? rafts[i] : null;
        if (!r) {
          ru[i].w = 0;
          continue;
        }
        ru[i].set(r.pos.x, r.pos.z, r.radius + 0.25, r.phase === 'afloat' ? 1 : 0.6);
        const sp = Math.hypot(r.drift.x, r.drift.z);
        const rate = 0.35 + 0.8 * Math.min(1, sp);
        if (dA > 0 && Math.floor((clock + i * 0.37) * rate) !== Math.floor((clock - dA + i * 0.37) * rate)) {
          const k = sp > 0.02 ? r.radius / sp : 0;
          addRipple(r.pos.x + r.drift.x * k, r.pos.z + r.drift.z * k, clock, 0.7);
        }
      }

      // ---- ripple sources: swimmers, floating items ----
      if (dA <= 0) return;
      const ants = sim.ants;
      let budget = 5;
      const cam = ctx.view.camera.focus;
      const maxD2 = 70 * 70;
      for (let i = 0; i < ants.length && budget > 0; i++) {
        const a = ants[i];
        if (!a.alive) continue;
        const raft = a.anim === 'raft';
        if (raft && rafts.length > 0) continue; // the raft itself makes the waves
        if (!raft && !(a.submerged > 0) && !(a.cell >= 0 && water.depthAt(a.cell) >= 0.25)) continue;
        const dx = a.pos.x - cam.x;
        const dz = a.pos.z - cam.z;
        if (dx * dx + dz * dz > maxD2) continue;
        const rate = raft ? 0.22 : a.submerged > 0 ? 1.2 : 0.5 + 0.5 * Math.min(1, a.moveSpeed);
        const ph = a.phase * 7.13;
        if (Math.floor((clock + ph) * rate) !== Math.floor((clock - dA + ph) * rate)) {
          addRipple(a.pos.x, a.pos.z, clock, raft ? 0.45 : a.submerged > 0 ? 1 : 0.6);
          budget--;
        }
      }
      const items = sim.items;
      for (let i = 0; i < items.length && budget > 0; i++) {
        const it = items[i];
        if (!it.alive || it.carriedBy || it.cell < 0 || water.depthAt(it.cell) < 0.25) continue;
        const ph = (it.id % 97) * 0.173;
        if (Math.floor((clock + ph) * 0.3) !== Math.floor((clock - dA + ph) * 0.3)) {
          addRipple(it.pos.x, it.pos.z, clock, 0.35);
          budget--;
        }
      }
    },

    dispose() {
      mesh?.removeFromParent();
      pre?.removeFromParent();
      geo?.dispose();
      mat?.dispose();
      preMat?.dispose();
      mesh = pre = null;
      geo = null;
      mat = preMat = null;
      cornerSum.clear();
      cornerCnt.clear();
      cornerDep.clear();
      colTop.clear();
      resetWaterShared();
    },
  };
}

export const waterFxModule: Module = createWaterFxModule();
