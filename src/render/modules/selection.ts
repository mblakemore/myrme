import * as THREE from 'three';
import { viewExt, type A4ViewExt, type BeaconKind, type Designation, type FrameInfo, type OrderKind, type TaskKind, type Vec3, type ViewState, type VoxelWorld } from '../../core';
import { getCaste } from '../../sim/data/species';
import { CUT_ENTITY_MARGIN, cutEntityHidden } from '../../world/cut';
import type { Module, RenderContext } from '../shared';
import { antsRuntime } from './ants';
import { farScale, writeMoverMatrix, writeSurfaceMatrix } from './antsShared';

/**
 * Selection & feedback (§5.3, §5.4). Everything is overlay geometry owned by this module — no
 * terrain-shader support needed:
 *  - decals: one instanced quad batch with a procedural shader; each instance lies in the local
 *    surface plane (ant `up`, or the terrain normal from the density gradient), so rings hug
 *    walls and ceilings. Styles: selection ring, hover ring, possessed marker, order ping,
 *    order target, beacon base, dig-designation dot, brush cursor.
 *  - beacon pillars: columns of drifting coloured scent glow along the surface normal,
 *  - dig / build designations: a faint fresnel shell around the brush volume plus glowing dots
 *    on every terrain surface cell inside it (the region that will be dug),
 *  - rally lines: dashed lines from selected ants to their player-order targets.
 */

const DECAL_CAP = 4096;
const PILLAR_CAP = 64;
const SHELL_CAP = 128;
const LINE_CAP = 96;
const PING_CAP = 24;
const DOTS_PER_DESIGNATION = 140;

const STYLE = { select: 0, hover: 1, possessed: 2, ping: 3, target: 4, beacon: 5, dot: 6, brush: 7 } as const;

type RGB = readonly [number, number, number];
const C_SELECT: RGB = [0.35, 1.0, 0.5];
const C_HOVER: RGB = [1.0, 1.0, 0.9];
const C_POSSESS: RGB = [1.0, 0.78, 0.25];
const C_DIG: RGB = [1.0, 0.72, 0.22];
const C_BUILD: RGB = [0.45, 0.8, 1.0];
const C_ERASE: RGB = [1.0, 0.32, 0.26];
const ORDER_COLOR: Record<OrderKind, RGB> = {
  move: [0.4, 1.0, 0.5],
  gather: [1.0, 0.85, 0.3],
  attack: [1.0, 0.25, 0.2],
  guard: [0.3, 0.6, 1.0],
  follow: [0.3, 0.9, 0.9],
  exile: [0.8, 0.4, 1.0],
  stop: [0.7, 0.7, 0.7],
};
const BEACON_COLOR: Record<BeaconKind, RGB> = {
  gather: [1.0, 0.85, 0.25],
  dig: [1.0, 0.6, 0.2],
  rally: [0.2, 0.85, 1.0],
  attack: [1.0, 0.15, 0.2],
  avoid: [0.7, 0.5, 1.0],
};

function taskColor(kind: TaskKind): RGB {
  switch (kind) {
    case 'attack':
      return ORDER_COLOR.attack;
    case 'gather':
    case 'haul':
      return ORDER_COLOR.gather;
    case 'guard':
    case 'patrol':
      return ORDER_COLOR.guard;
    case 'follow':
    case 'rally':
      return ORDER_COLOR.follow;
    case 'dig':
    case 'build':
      return C_DIG;
    case 'exile':
      return ORDER_COLOR.exile;
    default:
      return ORDER_COLOR.move;
  }
}

const DECAL_VERT = /* glsl */ `
attribute vec4 aStyle; // rgb, style id
attribute vec4 aParam; // progress, alpha, seed, cut slack (world units past the cut plane still drawn)
varying vec2 vUv;
varying vec4 vStyle;
varying vec4 vParam;
varying vec3 vWorld;
void main() {
  vUv = position.xz;
  vStyle = aStyle;
  vParam = aParam;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DECAL_FRAG = /* glsl */ `
uniform float uTime;
uniform vec4 uCutPlane;
uniform vec4 uDecal; // base gain, extra gain at the ring core, soft-fill scale, additive (pillar/shell) gain
varying vec2 vUv;
varying vec4 vStyle;
varying vec4 vParam;
varying vec3 vWorld;
float ring(float r, float at, float w) {
  return smoothstep(at - w, at - w * 0.4, r) * (1.0 - smoothstep(at + w * 0.4, at + w, r));
}
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > vParam.w * dot(uCutPlane.xyz, uCutPlane.xyz)) discard;
  float r = length(vUv);
  if (r > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float id = vStyle.a;
  float prog = vParam.x;
  float a = 0.0;
  vec3 col = vStyle.rgb;
  if (id < 0.5) {
    // selected: bright ring broken into three slowly turning arcs + soft inner glow
    float arcs = smoothstep(-0.2, 0.1, sin(ang * 3.0 + uTime * 0.9 + vParam.z * 6.0));
    a = ring(r, 0.84, 0.075) * (0.45 + 0.55 * arcs) + smoothstep(0.35, 0.84, r) * (1.0 - step(0.84, r)) * 0.12 * uDecal.z;
  } else if (id < 1.5) {
    a = ring(r, 0.88, 0.05) * 0.8 + (1.0 - r) * 0.06 * uDecal.z;
  } else if (id < 2.5) {
    // possessed: double ring with four chevrons pointing forward
    float chev = smoothstep(0.75, 0.95, sin(ang * 4.0 - uTime * 2.0));
    a = ring(r, 0.9, 0.05) + ring(r, 0.72, 0.03) * (0.35 + 0.65 * chev) + smoothstep(0.3, 0.9, r) * (1.0 - step(0.9, r)) * 0.1;
    // heading notch (+z of the ant)
    a += (1.0 - smoothstep(0.0, 0.12, abs(vUv.x))) * smoothstep(0.86, 0.9, vUv.y) * (1.0 - step(1.0, vUv.y));
  } else if (id < 3.5) {
    // ping: expanding double ripple
    float e = 1.0 - prog;
    a = (ring(r, 0.15 + 0.8 * prog, 0.07) + 0.5 * ring(r, 0.1 + 0.5 * prog, 0.05)) * e * e + (1.0 - smoothstep(0.0, 0.25, r)) * e * 0.6;
  } else if (id < 4.5) {
    // order target: pulsing reticle
    float pulse = 0.5 + 0.5 * sin(uTime * 4.0 + vParam.z * 6.0);
    float ticks = smoothstep(0.8, 0.95, abs(sin(ang * 2.0)));
    a = ring(r, 0.6 + 0.08 * pulse, 0.06) * (0.4 + 0.6 * ticks) + (1.0 - smoothstep(0.06, 0.13, r)) * 0.9;
  } else if (id < 5.5) {
    // beacon base: waves of scent rolling outwards
    float w = fract(r * 2.5 - uTime * 0.45);
    a = smoothstep(0.0, 0.15, w) * (1.0 - smoothstep(0.15, 0.6, w)) * (1.0 - r) * 0.8 + ring(r, 0.93, 0.04) * 0.5 + (1.0 - smoothstep(0.0, 0.3, r)) * 0.5;
  } else if (id < 6.5) {
    // designation dot: soft hex cell that breathes (phase offset per dot → a shimmer over the region)
    float hexr = r * (0.9 + 0.1 * cos(ang * 6.0));
    float pulse = 0.55 + 0.45 * sin(uTime * 2.2 + vParam.z * 40.0);
    a = (1.0 - smoothstep(0.55, 0.8, hexr)) * (0.1 + 0.16 * pulse) + ring(hexr, 0.78, 0.07) * (0.35 + 0.4 * pulse);
  } else {
    // brush cursor: dashed rim + faint fill
    float dash = step(0.5, fract(ang * 3.8197 + uTime * 0.6));
    a = ring(r, 0.93, 0.045) * (0.35 + 0.65 * dash) + (1.0 - r * r) * 0.08;
  }
  a *= vParam.y;
  if (a < 0.004) discard;
  // emissive level stays under the bloom threshold on the farm maps (they bloomed into white
  // discs under the slab DoF); outdoors the ring core may glow a little
  gl_FragColor = vec4(col * (uDecal.x + uDecal.y * a), a);
}
`;

const PILLAR_VERT = /* glsl */ `
attribute vec4 aStyle;
varying vec2 vUv;
varying vec4 vStyle;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vStyle = aStyle;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PILLAR_FRAG = /* glsl */ `
uniform float uTime;
uniform vec4 uCutPlane;
uniform vec4 uDecal;
varying vec2 vUv;
varying vec4 vStyle;
varying vec3 vWorld;
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > 0.0) discard;
  // wisps rising up the column, fading with height
  float h = vUv.y;
  float wisp = noise(vec2(vUv.x * 10.0, h * 5.0 - uTime * 0.7 + vStyle.a * 9.0)) * 0.7 + noise(vec2(vUv.x * 22.0 + 3.0, h * 11.0 - uTime * 1.3)) * 0.3;
  float a = pow(1.0 - h, 1.8) * (0.08 + 0.9 * wisp * wisp * wisp) * smoothstep(0.0, 0.04, h);
  gl_FragColor = vec4(vStyle.rgb * a * 0.55 * uDecal.w, 0.0);
}
`;

const SHELL_VERT = /* glsl */ `
attribute vec4 aStyle;
varying vec4 vStyle;
varying vec3 vWorld;
varying vec3 vN;
void main() {
  vStyle = aStyle;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_FRAG = /* glsl */ `
uniform float uTime;
uniform vec4 uCutPlane;
uniform vec4 uDecal;
varying vec4 vStyle;
varying vec3 vWorld;
varying vec3 vN;
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > 0.0) discard;
  vec3 V = normalize(cameraPosition - vWorld);
  float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.5);
  float scan = 0.75 + 0.25 * sin(vWorld.y * 9.0 - uTime * 1.5);
  float a = (f * 0.55 + 0.03) * scan * vStyle.a;
  gl_FragColor = vec4(vStyle.rgb * a * uDecal.w, 0.0);
}
`;

interface DotCache {
  version: number;
  count: number;
  data: Float32Array;
}

function computeDots(world: VoxelWorld, d: Readonly<Designation>, cache: DotCache, g: Vec3): void {
  const r = d.radius;
  const x0 = Math.max(0, Math.floor(d.center.x - r));
  const x1 = Math.min(world.sx - 1, Math.ceil(d.center.x + r));
  const y0 = Math.max(0, Math.floor(d.center.y - r));
  const y1 = Math.min(world.sy - 1, Math.ceil(d.center.y + r));
  const z0 = Math.max(0, Math.floor(d.center.z - r));
  const z1 = Math.min(world.sz - 1, Math.ceil(d.center.z + r));
  let n = 0;
  const data = cache.data;
  const max = data.length / 6;
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const cz = z + 0.5;
        const dx = cx - d.center.x;
        const dy = cy - d.center.y;
        const dz = cz - d.center.z;
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        if (!world.isSolid(x, y, z)) continue;
        // surface cell: solid with at least one open face (visual semantics: panes count as open)
        const open = world.densityVisual(x + 1, y, z) < 128 || world.densityVisual(x - 1, y, z) < 128 || world.densityVisual(x, y + 1, z) < 128 || world.densityVisual(x, y - 1, z) < 128 || world.densityVisual(x, y, z + 1) < 128 || world.densityVisual(x, y, z - 1) < 128;
        if (!open) continue;
        if (n >= max) continue;
        world.gradient(cx, cy, cz, g);
        const gl = Math.hypot(g.x, g.y, g.z);
        if (gl < 0.05) continue;
        const nx = -g.x / gl;
        const ny = -g.y / gl;
        const nz = -g.z / gl;
        const sd = Math.min(1, Math.max(0, world.sampleVisual(cx, cy, cz)));
        const k = n * 6;
        data[k] = cx + nx * (sd + 0.04);
        data[k + 1] = cy + ny * (sd + 0.04);
        data[k + 2] = cz + nz * (sd + 0.04);
        data[k + 3] = nx;
        data[k + 4] = ny;
        data[k + 5] = nz;
        n++;
      }
    }
  }
  cache.count = n;
  cache.version = world.version;
}

export function createSelectionModule(): Module {
  let decals: THREE.InstancedMesh | null = null;
  let pillars: THREE.InstancedMesh | null = null;
  let shells: THREE.InstancedMesh | null = null;
  let lines: THREE.LineSegments | null = null;
  let dStyle = new Float32Array(0);
  let dParam = new Float32Array(0);
  let pStyle = new Float32Array(0);
  let sStyle = new Float32Array(0);
  let linePos = new Float32Array(0);
  let lineCol = new Float32Array(0);
  let lineDist = new Float32Array(0);
  /** Highest A5 `OrderPing.seq` already turned into a ping marker. */
  let lastPingSeq = -1;
  const pings: { x: number; y: number; z: number; nx: number; ny: number; nz: number; t0: number; color: RGB; size: number }[] = [];
  const dots = new Map<number, DotCache>();
  const g: Vec3 = { x: 0, y: 0, z: 0 };
  const rayO: Vec3 = { x: 0, y: 0, z: 0 };
  const rayD: Vec3 = { x: 0, y: 1, z: 0 };
  const disposables: { dispose(): void }[] = [];

  const instAttr = (geo: THREE.BufferGeometry, name: string, cap: number): Float32Array<ArrayBuffer> => {
    const arr = new Float32Array(cap * 4);
    const a = new THREE.InstancedBufferAttribute(arr, 4);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return arr;
  };

  return {
    id: 'selection',
    init(ctx) {
      const farm = ctx.map.flags.slab || ctx.map.environment.backdrop === 'room';
      const u = { uTime: ctx.uniforms.uTime, uCutPlane: ctx.uniforms.uCutPlane, uDecal: { value: farm ? new THREE.Vector4(0.62, 0.1, 0.35, 0.45) : new THREE.Vector4(0.9, 0.45, 1, 1) } };

      // decals: unit quad in the XZ plane
      const quad = new THREE.BufferGeometry();
      quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]), 3));
      quad.setIndex([0, 2, 1, 0, 3, 2]);
      dStyle = instAttr(quad, 'aStyle', DECAL_CAP);
      dParam = instAttr(quad, 'aParam', DECAL_CAP);
      const decalMat = new THREE.ShaderMaterial({
        vertexShader: DECAL_VERT,
        fragmentShader: DECAL_FRAG,
        uniforms: u,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        toneMapped: false,
      });
      decals = new THREE.InstancedMesh(quad, decalMat, DECAL_CAP);
      decals.name = 'selection';
      decals.frustumCulled = false;
      decals.count = 0;
      decals.renderOrder = 3;
      decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      // beacon pillars: open cylinder, base at the origin, 1 unit tall
      const cyl = new THREE.CylinderGeometry(0.55, 1, 1, 20, 1, true);
      cyl.translate(0, 0.5, 0);
      pStyle = instAttr(cyl, 'aStyle', PILLAR_CAP);
      const glow = { transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false } as const;
      const pillarMat = new THREE.ShaderMaterial({ vertexShader: PILLAR_VERT, fragmentShader: PILLAR_FRAG, uniforms: u, ...glow });
      pillars = new THREE.InstancedMesh(cyl, pillarMat, PILLAR_CAP);
      pillars.name = 'selection:beacons';
      pillars.frustumCulled = false;
      pillars.count = 0;
      pillars.renderOrder = 4;

      const ico = new THREE.IcosahedronGeometry(1, 4);
      sStyle = instAttr(ico, 'aStyle', SHELL_CAP);
      const shellMat = new THREE.ShaderMaterial({ vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, uniforms: u, ...glow, side: THREE.FrontSide });
      shells = new THREE.InstancedMesh(ico, shellMat, SHELL_CAP);
      shells.name = 'selection:designations';
      shells.frustumCulled = false;
      shells.count = 0;
      shells.renderOrder = 4;

      const lg = new THREE.BufferGeometry();
      linePos = new Float32Array(LINE_CAP * 6);
      lineCol = new Float32Array(LINE_CAP * 6);
      lineDist = new Float32Array(LINE_CAP * 2);
      lg.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
      lg.setAttribute('color', new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage));
      lg.setAttribute('lineDistance', new THREE.BufferAttribute(lineDist, 1).setUsage(THREE.DynamicDrawUsage));
      lg.setDrawRange(0, 0);
      lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const lineMat = new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, opacity: 0.5, dashSize: 0.3, gapSize: 0.22, depthTest: false, depthWrite: false, toneMapped: false });
      lines = new THREE.LineSegments(lg, lineMat);
      lines.name = 'selection:rally';
      lines.frustumCulled = false;
      lines.renderOrder = 4;

      ctx.scene.add(decals, pillars, shells, lines);
      disposables.push(quad, decalMat, cyl, pillarMat, ico, shellMat, lg, lineMat);
      pings.length = 0;
      lastPingSeq = -1;
      dots.clear();
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      if (!decals || !pillars || !shells || !lines) return;
      const sim = ctx.sim;
      const view = ctx.view as ViewState & A4ViewExt;
      // presentation state published by the input layer (A5): tool brush, stroke, beacon preview,
      // order pings, hover classification. Absent in headless / fixture setups → A4ViewExt fallbacks.
      const ext = viewExt(ctx.view);
      const world = sim.world;
      const slackEverywhere = ctx.map.flags.slab || ctx.map.boundary === 'glass';
      const culler = antsRuntime.culler;
      const clock = antsRuntime.clock;
      const dm = decals.instanceMatrix.array as Float32Array;
      let nd = 0;

      const style = (r: number, gg: number, b: number, id: number, prog: number, alpha: number, seed: number, slack = 0): void => {
        const k = nd * 4;
        dStyle[k] = r;
        dStyle[k + 1] = gg;
        dStyle[k + 2] = b;
        dStyle[k + 3] = id;
        dParam[k] = prog;
        dParam[k + 1] = alpha;
        dParam[k + 2] = seed;
        dParam[k + 3] = slack;
        nd++;
      };
      /** Decal on the terrain at a point; normal from the density gradient when not given. */
      const decalAt = (x: number, y: number, z: number, radius: number, c: RGB, id: number, prog: number, alpha: number, seed: number, nx = 0, ny = 0, nz = 0): void => {
        if (nd >= DECAL_CAP) return;
        if (nx === 0 && ny === 0 && nz === 0) {
          world.gradient(x, y, z, g);
          const l = Math.hypot(g.x, g.y, g.z);
          if (l > 0.05) {
            nx = -g.x / l;
            ny = -g.y / l;
            nz = -g.z / l;
            // drop onto the surface
            const sd = world.sampleVisual(x, y, z);
            if (sd > -2 && sd < 1.5) {
              x += nx * sd;
              y += ny * sd;
              z += nz * sd;
            }
          } else ny = 1;
        }
        writeSurfaceMatrix(x, y, z, nx, ny, nz, 0, radius, radius, radius, 0.05, dm, nd * 16);
        style(c[0], c[1], c[2], id, prog, alpha, seed);
      };
      const ringUnder = (id: number, c: RGB, styleId: number, k: number): void => {
        if (nd >= DECAL_CAP) return;
        const a = sim.getAnt(id);
        if (!a || !a.alive) return;
        // same rule as the creature materials: underground ants stay visible a little past the cut
        if (view.cut.enabled && cutEntityHidden(world, a.pos, view.cut, slackEverywhere)) return;
        const len = getCaste(a.species, a.caste).length;
        const ex = farScale(view, culler.dist(a.pos.x, a.pos.y, a.pos.z));
        // on the ground under the ant (pos is rideHeight above it), in the ant's own surface frame
        writeMoverMatrix(a, frame.alpha, len * ex * k, dm, nd * 16, -a.rideHeight * 0.86);
        style(c[0], c[1], c[2], styleId, 0, 1, a.phase, CUT_ENTITY_MARGIN);
      };

      // ---- selection / possession / hover rings ------------------------------------------------
      const possessed = view.mode === 'possess' ? view.possessedId : 0;
      {
        for (let i = 0; i < view.selection.length; i++) if (view.selection[i] !== possessed) ringUnder(view.selection[i], C_SELECT, STYLE.select, 0.78);
        if (possessed && !view.firstPerson) ringUnder(possessed, C_POSSESS, STYLE.possessed, 0.95);
        if (view.hoverId && view.hoverId !== possessed) {
          const e = sim.getEntity(view.hoverId);
          if (e && e.alive) {
            // colour = the order a right-click would issue with the current selection
            const hasSel = view.selection.length > 0 && view.mode !== 'possess';
            const c = view.hoverOrder
              ? ORDER_COLOR[view.hoverOrder]
              : ext?.hoverHostile
                ? ORDER_COLOR.attack
                : hasSel && e.kind === 'food'
                  ? ORDER_COLOR.gather
                  : hasSel && e.kind === 'ant' && e.colony === sim.playerColony && !view.selection.includes(e.id)
                    ? ORDER_COLOR.follow
                    : C_HOVER;
            if (e.kind === 'ant') ringUnder(e.id, c, STYLE.hover, 0.92);
            else {
              const rad = e.kind === 'food' ? e.radius + 0.5 : e.kind === 'creature' ? Math.max(0.6, e.clearance * 1.1) : 0.5;
              decalAt(e.pos.x, e.pos.y, e.pos.z, rad, c, STYLE.hover, 0, 1, 0);
            }
          }
        }
      }

      // ---- order pings (D19 events) ------------------------------------------------------------
      for (let i = 0; i < frame.events.length; i++) {
        const e = frame.events[i];
        let pos: Vec3 | null = null;
        let color: RGB = C_SELECT;
        let size = 1.3;
        if (e.type === 'orderIssued' && e.pos) {
          if (ext) continue; // the input layer's own pings (below) are immediate and know entity targets
          pos = e.pos;
          color = ORDER_COLOR[e.order];
        } else if (e.type === 'beaconChanged' && e.op === 'place') {
          pos = e.beacon.pos;
          color = BEACON_COLOR[e.beacon.kind];
          size = Math.max(1.5, e.beacon.radius * 0.5);
        } else if (e.type === 'designationChanged' && e.op === 'add') {
          pos = e.designation.center;
          color = e.designation.kind === 'dig' ? C_DIG : C_BUILD;
          size = e.designation.radius * 1.2;
        }
        if (!pos) continue;
        if (pings.length >= PING_CAP) pings.shift();
        world.gradient(pos.x, pos.y, pos.z, g);
        const l = Math.hypot(g.x, g.y, g.z);
        const sd = world.sampleVisual(pos.x, pos.y, pos.z);
        const nx = l > 0.05 ? -g.x / l : 0;
        const ny = l > 0.05 ? -g.y / l : 1;
        const nz = l > 0.05 ? -g.z / l : 0;
        const k = l > 0.05 && sd > -2 && sd < 1.5 ? sd : 0;
        pings.push({ x: pos.x + nx * k, y: pos.y + ny * k, z: pos.z + nz * k, nx, ny, nz, t0: clock, color, size });
      }
      if (ext) {
        const op = ext.orderPings;
        if (op.length === 0 || op[op.length - 1].seq < lastPingSeq) lastPingSeq = op.length ? op[0].seq - 1 : -1; // input layer restarted
        for (let i = 0; i < op.length; i++) {
          const o = op[i];
          if (o.seq <= lastPingSeq) continue;
          lastPingSeq = o.seq;
          const te = o.targetId ? sim.getEntity(o.targetId) : undefined;
          const pos = te && te.alive ? te.pos : o.pos;
          if (!pos) continue;
          if (pings.length >= PING_CAP) pings.shift();
          world.gradient(pos.x, pos.y, pos.z, g);
          const l = Math.hypot(g.x, g.y, g.z);
          const sd = world.sampleVisual(pos.x, pos.y, pos.z);
          const nx = l > 0.05 ? -g.x / l : 0;
          const ny = l > 0.05 ? -g.y / l : 1;
          const nz = l > 0.05 ? -g.z / l : 0;
          const k = l > 0.05 && sd > -2 && sd < 1.5 ? sd : 0;
          pings.push({ x: pos.x + nx * k, y: pos.y + ny * k, z: pos.z + nz * k, nx, ny, nz, t0: clock, color: ORDER_COLOR[o.order], size: o.targetId ? 1.6 : 1.3 });
        }
      }
      for (let i = pings.length - 1; i >= 0; i--) {
        const p = pings[i];
        const t = (clock - p.t0) / 0.9;
        if (t >= 1) {
          pings.splice(i, 1);
          continue;
        }
        decalAt(p.x, p.y, p.z, p.size, p.color, STYLE.ping, Math.max(0, t), 1, i, p.nx, p.ny, p.nz);
      }

      // ---- rally lines + order targets for the selection --------------------------------------
      let nl = 0;
      for (let i = 0; i < view.selection.length && nl < LINE_CAP; i++) {
        const a = sim.getAnt(view.selection[i]);
        if (!a || !a.alive) continue;
        const task = a.tasks[0];
        if (!task || task.source !== 'player') continue;
        let tp = task.pos;
        if (task.targetId) {
          const te = sim.getEntity(task.targetId);
          if (te && te.alive) tp = te.pos;
        }
        if (!tp) continue;
        const c = taskColor(task.kind);
        const k = nl * 6;
        linePos[k] = a.pos.x;
        linePos[k + 1] = a.pos.y;
        linePos[k + 2] = a.pos.z;
        linePos[k + 3] = tp.x;
        linePos[k + 4] = tp.y;
        linePos[k + 5] = tp.z;
        for (let q = 0; q < 6; q += 3) {
          lineCol[k + q] = c[0];
          lineCol[k + q + 1] = c[1];
          lineCol[k + q + 2] = c[2];
        }
        lineDist[nl * 2] = 0;
        lineDist[nl * 2 + 1] = Math.hypot(tp.x - a.pos.x, tp.y - a.pos.y, tp.z - a.pos.z);
        nl++;
        // one reticle per target (the first few selected ants are enough to mark it)
        if (i < 12) decalAt(tp.x, tp.y, tp.z, task.targetId ? 0.9 : 0.6, c, STYLE.target, 0, 0.9, task.id % 7);
      }
      const lg = lines.geometry;
      lg.setDrawRange(0, nl * 2);
      lines.visible = nl > 0;
      if (nl > 0) {
        lg.attributes.position.needsUpdate = true;
        lg.attributes.color.needsUpdate = true;
        lg.attributes.lineDistance.needsUpdate = true;
      }

      // ---- beacons + designations of the player's colony ----------------------------------
      const colony = sim.getColony(sim.playerColony);
      const pm = pillars.instanceMatrix.array as Float32Array;
      const sm = shells.instanceMatrix.array as Float32Array;
      let np = 0;
      let ns = 0;
      const shell = (c: Readonly<Vec3>, r: number, col: RGB, alpha: number): void => {
        if (ns >= SHELL_CAP) return;
        writeSurfaceMatrix(c.x, c.y, c.z, 0, 1, 0, 0, r, r, r, 0, sm, ns * 16);
        sStyle[ns * 4] = col[0];
        sStyle[ns * 4 + 1] = col[1];
        sStyle[ns * 4 + 2] = col[2];
        sStyle[ns * 4 + 3] = alpha;
        ns++;
      };
      if (colony) {
        for (let i = 0; i < colony.beacons.length; i++) {
          const b = colony.beacons[i];
          const c = BEACON_COLOR[b.kind];
          world.gradient(b.pos.x, b.pos.y, b.pos.z, g);
          const l = Math.hypot(g.x, g.y, g.z);
          const nx = l > 0.05 ? -g.x / l : 0;
          const ny = l > 0.05 ? -g.y / l : 1;
          const nz = l > 0.05 ? -g.z / l : 0;
          const sd = l > 0.05 ? world.sampleVisual(b.pos.x, b.pos.y, b.pos.z) : 0;
          const k = sd > -2 && sd < 1.5 ? sd : 0;
          const bx = b.pos.x + nx * k;
          const by = b.pos.y + ny * k;
          const bz = b.pos.z + nz * k;
          decalAt(bx, by, bz, Math.max(1.2, b.radius * 0.45), c, STYLE.beacon, 0, 0.9, b.id % 13, nx, ny, nz);
          if (np < PILLAR_CAP) {
            // taller in the open, shorter where there is a ceiling
            rayO.x = bx + nx * 0.3;
            rayO.y = by + ny * 0.3;
            rayO.z = bz + nz * 0.3;
            rayD.x = nx;
            rayD.y = ny;
            rayD.z = nz;
            const hit = world.raycast(rayO, rayD, 9);
            const h = hit ? Math.max(1.2, hit.dist) : 9;
            writeSurfaceMatrix(bx, by, bz, nx, ny, nz, 0, 0.36, h, 0.36, 0, pm, np * 16);
            pStyle[np * 4] = c[0];
            pStyle[np * 4 + 1] = c[1];
            pStyle[np * 4 + 2] = c[2];
            pStyle[np * 4 + 3] = (b.id % 17) / 17;
            np++;
          }
        }

        let recompute = ctx.sync ? 1e9 : 2;
        for (let i = 0; i < colony.designations.length; i++) {
          const d = colony.designations[i];
          if (d.done) continue;
          const col = d.kind === 'dig' ? C_DIG : C_BUILD;
          if (culler.depthIfVisible(d.center.x, d.center.y, d.center.z, d.radius + 1) < 0) continue;
          shell(d.center, d.radius, col, 0.3); // faint: the colony brain designates a lot on its own
          if (d.kind !== 'dig') continue;
          let cache = dots.get(d.id);
          if (!cache) dots.set(d.id, (cache = { version: -1, count: 0, data: new Float32Array(DOTS_PER_DESIGNATION * 6) }));
          if (cache.version !== world.version && recompute > 0) {
            computeDots(world, d, cache, g);
            recompute--;
          }
          const data = cache.data;
          for (let q = 0; q < cache.count && nd < DECAL_CAP; q++) {
            const k = q * 6;
            writeSurfaceMatrix(data[k], data[k + 1], data[k + 2], data[k + 3], data[k + 4], data[k + 5], 0, 0.36, 0.36, 0.36, 0.03, dm, nd * 16);
            style(col[0], col[1], col[2], STYLE.dot, 0, 0.7, (q * 0.618) % 1);
          }
        }
        // forget finished / removed designations
        if (dots.size > colony.designations.length + 8) {
          for (const id of dots.keys()) if (!colony.designations.some((d) => d.id === id && !d.done)) dots.delete(id);
        }
      }

      // ---- paint-tool cursor / beacon placement preview ---------------------------------------
      const cw = view.cursorWorld;
      if (ext && view.mode !== 'possess') {
        // stamps of the stroke being painted (until the sim's designations take over)
        const st = ext.stroke;
        for (let i = Math.max(0, st.length - 48); i < st.length; i++) {
          const sp = st[i];
          shell(sp.center, sp.radius, sp.erase ? C_ERASE : sp.kind === 'dig' ? C_DIG : C_BUILD, 0.45);
        }
        const br = ext.brush;
        if (br) {
          const col = br.erase ? C_ERASE : br.kind === 'dig' ? C_DIG : C_BUILD;
          // ring on the surface under the cursor, sphere = the volume a click designates
          const at = cw ?? br.center;
          decalAt(at.x, at.y, at.z, br.radius, col, STYLE.brush, 0, 1, 0, br.normal.x, br.normal.y, br.normal.z);
          shell(br.center, br.radius, col, 0.6);
        }
        const bp = ext.beaconPreview;
        if (bp) {
          const col = bp.removeId ? C_ERASE : BEACON_COLOR[bp.kind];
          decalAt(bp.pos.x, bp.pos.y, bp.pos.z, Math.max(1.2, bp.radius * 0.45), col, STYLE.brush, 0, 1, 0);
          if (!bp.removeId) decalAt(bp.pos.x, bp.pos.y, bp.pos.z, bp.radius, col, STYLE.select, 0, 0.5, 0);
        }
      } else if (cw && view.mode !== 'possess') {
        if (view.tool) {
          const r = view.toolRadius ?? 1.5;
          const col = view.tool === 'dig' ? C_DIG : C_BUILD;
          decalAt(cw.x, cw.y, cw.z, r, col, STYLE.brush, 0, 1, 0);
          shell(cw, r, col, 0.5);
        } else if (view.beaconPreview) {
          decalAt(cw.x, cw.y, cw.z, 1.4, BEACON_COLOR[view.beaconPreview], STYLE.brush, 0, 1, 0);
        }
      }

      decals.count = nd;
      decals.visible = nd > 0;
      if (nd > 0) {
        const up = (a: THREE.BufferAttribute, size: number): void => {
          a.clearUpdateRanges();
          a.addUpdateRange(0, nd * size);
          a.needsUpdate = true;
        };
        up(decals.instanceMatrix, 16);
        up(decals.geometry.attributes.aStyle as THREE.BufferAttribute, 4);
        up(decals.geometry.attributes.aParam as THREE.BufferAttribute, 4);
      }
      pillars.count = np;
      pillars.visible = np > 0;
      if (np > 0) {
        pillars.instanceMatrix.needsUpdate = true;
        (pillars.geometry.attributes.aStyle as THREE.BufferAttribute).needsUpdate = true;
      }
      shells.count = ns;
      shells.visible = ns > 0;
      if (ns > 0) {
        shells.instanceMatrix.needsUpdate = true;
        (shells.geometry.attributes.aStyle as THREE.BufferAttribute).needsUpdate = true;
      }
    },

    dispose() {
      decals?.removeFromParent();
      pillars?.removeFromParent();
      shells?.removeFromParent();
      lines?.removeFromParent();
      decals?.dispose();
      pillars?.dispose();
      shells?.dispose();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      decals = pillars = shells = null;
      lines = null;
      dots.clear();
      pings.length = 0;
    },
  };
}

export const selectionModule: Module = createSelectionModule();
