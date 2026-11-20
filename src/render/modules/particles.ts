import * as THREE from 'three';
import { materialDef, PHERO_CHANNELS, type FrameInfo, type ParticleEmitter, type ParticleKind, type ParticleParams, type ParticlePreset, type Vec3 } from '../../core';
import type { Module, RenderContext } from '../shared';
import { antsRuntime } from './ants';

/**
 * Shared GPU particle base (§5.3 FX; emit API documented in `core/contracts/a4.ts`).
 *
 * One instanced-quad draw call over a ring-buffer pool. Simulation is stateless on the GPU:
 * each particle stores its birth state (position, velocity, birth time, life, gravity, drag…)
 * and the vertex shader integrates it analytically from the particle clock, so the CPU only
 * touches the slots it emits into. Soft round sprites, hard chunks, velocity streaks and
 * twinkles; per-particle blend between alpha and additive (premultiplied output).
 *
 * A second tiny draw call renders ambient dust motes / pollen: a camera-wrapped volume of
 * drifting specks that catch the sun.
 *
 * Driven from sim events drained once per frame (D19): dig debris + dust, crumbs, bite sparks,
 * pheromone puffs, death/fall dust, plus footstep dust under ants close to the camera.
 */

const POOL = 6144;
const MOTES = 420;

const BASE: ParticlePreset = {
  count: 6,
  color: [1, 1, 1],
  size: 0.1,
  sizeVar: 0.4,
  speed: 1,
  speedVar: 0.5,
  life: 1,
  lifeVar: 0.3,
  gravity: 0,
  drag: 1,
  spread: 0.6,
  radius: 0.05,
  additive: 0,
  shape: 0,
  grow: 1,
  opacity: 1,
  lit: 1,
};

const PRESETS: Record<string, ParticlePreset> = {
  digDebris: { ...BASE, count: 9, color: [0.42, 0.3, 0.2], size: 0.07, sizeVar: 0.7, speed: 2.4, speedVar: 0.6, life: 0.9, gravity: 9, drag: 0.6, spread: 0.75, radius: 0.25, shape: 1 },
  dust: { ...BASE, count: 5, color: [0.62, 0.52, 0.4], size: 0.34, sizeVar: 0.5, speed: 0.5, life: 1.6, lifeVar: 0.4, gravity: -0.15, drag: 2.2, spread: 1, radius: 0.2, grow: 2.6, opacity: 0.32 },
  footDust: { ...BASE, count: 1, color: [0.66, 0.56, 0.44], size: 0.08, sizeVar: 0.4, speed: 0.22, life: 0.7, gravity: -0.05, drag: 3, spread: 1, radius: 0.02, grow: 2.8, opacity: 0.22 },
  crumb: { ...BASE, count: 4, color: [0.85, 0.7, 0.4], size: 0.045, sizeVar: 0.6, speed: 1.2, life: 0.8, gravity: 8, drag: 0.8, spread: 0.8, radius: 0.08, shape: 1 },
  spark: { ...BASE, count: 5, color: [1.0, 0.75, 0.3], size: 0.04, sizeVar: 0.5, speed: 3.4, speedVar: 0.7, life: 0.28, lifeVar: 0.5, gravity: 4, drag: 2.5, spread: 0.9, radius: 0.03, additive: 1, shape: 2, grow: 0.3, opacity: 1.0, lit: 0 },
  pheroPuff: { ...BASE, count: 12, color: [0.5, 1, 0.4], size: 0.2, sizeVar: 0.6, speed: 0.6, life: 2.2, lifeVar: 0.4, gravity: -0.25, drag: 1.6, spread: 1.2, radius: 0.25, additive: 1, grow: 2.4, opacity: 0.4, lit: 0 },
  mote: { ...BASE, count: 6, color: [1, 0.95, 0.8], size: 0.035, sizeVar: 0.6, speed: 0.15, life: 5, lifeVar: 0.4, gravity: -0.02, drag: 0.6, spread: 1.5, radius: 0.8, additive: 1, shape: 3, opacity: 0.8, lit: 0.6 },
  droplet: { ...BASE, count: 7, color: [0.6, 0.8, 1.0], size: 0.05, sizeVar: 0.5, speed: 2.6, life: 0.7, gravity: 10, drag: 0.4, spread: 0.6, radius: 0.04, additive: 0.3, shape: 2, opacity: 0.9, lit: 0.6 },
  spore: { ...BASE, count: 16, color: [0.5, 1.0, 0.7], size: 0.045, sizeVar: 0.6, speed: 0.5, life: 6, lifeVar: 0.5, gravity: -0.04, drag: 1.2, spread: 1.4, radius: 0.3, additive: 1, shape: 3, opacity: 0.9, lit: 0 },
};

/** Colour per pheromone channel (shared with pheromoneViz). */
export const PHERO_COLORS: readonly (readonly [number, number, number])[] = [
  [0.45, 1.0, 0.35], // food
  [1.0, 0.28, 0.1], // alarm
  [0.62, 0.4, 0.9], // death
  [1.0, 0.72, 0.2], // dig
  [0.2, 0.85, 1.0], // rally
  [1.0, 0.1, 0.35], // attack
  [0.75, 0.85, 1.0], // avoid
  [0.4, 0.65, 1.0], // trail
];

const VERT = /* glsl */ `
attribute vec4 aP0;  // xyz origin, w birth time
attribute vec4 aV0;  // xyz velocity, w life
attribute vec4 aCol; // rgb, opacity
attribute vec4 aPar; // size, gravity, drag, shape + 8*additive
attribute vec4 aPar2; // grow, lit, seed, unused
uniform float uClock;
uniform vec3 uWind;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPar; // t, shape, additive, seed
varying float vLit;
varying vec3 vWorld;
varying float vSoft;
varying float vFlip;
uniform vec4 uCutEntity;
uniform sampler2D uCutGround;
void main() {
  vFlip = 1.0;
  vSoft = 1.0;
  float age = uClock - aP0.w;
  float life = aV0.w;
  float t = age / max(life, 1e-3);
  vUv = position.xy;
  if (t < 0.0 || t >= 1.0 || life <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float drag = max(aPar.z, 1e-3);
  float travel = (1.0 - exp(-drag * age)) / drag;
  vec3 vel = aV0.xyz * exp(-drag * age) + vec3(0.0, -aPar.y * age, 0.0);
  vec3 wp = aP0.xyz + aV0.xyz * travel + vec3(0.0, -0.5 * aPar.y * age * age, 0.0);
  // light things drift with the wind
  wp.xz += uWind.xy * age * 0.25 * step(aPar.y, 0.5);
  float shapeF = mod(aPar.w, 8.0);
  float additive = floor(aPar.w / 8.0) / 100.0;
  float size = aPar.x * mix(1.0, aPar2.x, t);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vec2 corner = position.xy;
  if (shapeF > 1.5 && shapeF < 2.5) {
    // streak: stretch along the screen-space velocity
    vec3 vv = (viewMatrix * vec4(vel, 0.0)).xyz;
    vec2 dir = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
    float stretch = 1.0 + min(6.0, length(vv) * 0.35);
    corner = dir * corner.y * stretch + vec2(-dir.y, dir.x) * corner.x * 0.55;
  } else if (shapeF > 0.5 && shapeF < 1.5) {
    float a = aPar2.z * 6.283 + age * (4.0 + aPar2.z * 8.0);
    corner = mat2(cos(a), -sin(a), sin(a), cos(a)) * corner;
  } else if (shapeF > 3.5) {
    // leaf: spins in the screen plane and flips edge-on as it tumbles
    float a = aPar2.z * 6.283 + age * (2.0 + aPar2.z * 5.0);
    float flip = cos(age * (5.0 + aPar2.z * 6.0) + aPar2.z * 20.0);
    vFlip = flip;
    corner.x *= 0.5 * (0.25 + 0.75 * abs(flip));
    corner = mat2(cos(a), -sin(a), sin(a), cos(a)) * corner;
    wp.y += sin(age * 3.1 + aPar2.z * 40.0) * 0.25;
    mv = viewMatrix * vec4(wp, 1.0);
  }
  mv.xy += corner * size;
  gl_Position = projectionMatrix * mv;
  // soft ground fade (outdoor maps): how far this corner of a puff is above the ground field
  vSoft = 1.0;
  if (uCutEntity.w > 0.5 && shapeF < 0.5) {
    float gh = textureLod(uCutGround, clamp(wp.xz * uCutEntity.xy, 0.0, 1.0), 0.0).r;
    // only for puffs born above ground (tunnel dust is left alone)
    float above = step(gh - 0.6, aP0.y);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float cy = wp.y + up.y * corner.y * size;
    vSoft = mix(1.0, smoothstep(-0.12 * size, 0.55 * size, cy - gh), above);
  }
  vCol = aCol;
  vPar = vec4(t, shapeF, additive, aPar2.z);
  vLit = aPar2.y;
  vWorld = wp;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunColor;
uniform vec4 uCutPlane;
uniform float uPheroVision;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vPar;
varying float vLit;
varying vec3 vWorld;
varying float vSoft;
varying float vFlip;
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > 0.0) discard;
  float t = vPar.x;
  float shape = vPar.y;
  float r = length(vUv);
  float a;
  if (shape < 0.5) {
    a = smoothstep(1.0, 0.0, r);
    a *= a;
  } else if (shape < 1.5) {
    // chunk: a lumpy hard-edged polygon, shaded as if lit from above
    float ang = atan(vUv.y, vUv.x);
    float edge = 0.62 + 0.2 * sin(ang * 3.0 + vPar.w * 40.0) + 0.12 * sin(ang * 5.0 + vPar.w * 13.0);
    a = 1.0 - smoothstep(edge - 0.08, edge, r);
  } else if (shape < 2.5) {
    a = smoothstep(1.0, 0.2, abs(vUv.x)) * smoothstep(1.0, 0.0, abs(vUv.y));
  } else if (shape > 3.5) {
    // leaf: pointed ellipse with a midrib
    float w = 1.0 - vUv.y * vUv.y;
    a = 1.0 - smoothstep(w * 0.85, w, abs(vUv.x) + 0.02);
  } else {
    // twinkle: bright core + faint cross
    float core = smoothstep(0.5, 0.0, r);
    float cross_ = smoothstep(0.12, 0.0, min(abs(vUv.x), abs(vUv.y))) * smoothstep(1.0, 0.1, r);
    a = core * core + cross_ * 0.35;
    a *= 0.6 + 0.4 * sin(t * 40.0 + vPar.w * 50.0);
  }
  float fade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.55, 1.0, t));
  a *= fade * vCol.a * vSoft;
  if (a < 0.003) discard;
  vec3 light = mix(vec3(1.0), uSunColor * 1.15 + vec3(0.28, 0.32, 0.38), vLit);
  vec3 col = vCol.rgb * light;
  if (shape > 0.5 && shape < 1.5) col *= 0.7 + 0.5 * vUv.y;
  if (shape > 3.5) col *= (0.62 + 0.38 * vFlip) * (1.0 - 0.35 * smoothstep(0.12, 0.0, abs(vUv.x)));
  col = mix(col, vec3(dot(col, vec3(0.33))) * 0.5, uPheroVision * 0.8 * (1.0 - vPar.z));
  gl_FragColor = vec4(col * a, a * (1.0 - vPar.z));
}
`;

const MOTE_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uCamPos;
uniform float uBox;
uniform float uPx;
varying float vTw;
varying vec3 vWorld;
void main() {
  vec3 drift = vec3(uWind.x * 0.5, 0.06, uWind.y * 0.5) * uTime + vec3(sin(uTime * 0.31 + aSeed.w * 30.0), sin(uTime * 0.23 + aSeed.w * 17.0), cos(uTime * 0.27 + aSeed.w * 11.0)) * 0.35;
  // wrap a fixed lattice of specks around the camera: stable in the world, endless
  vec3 wp = uCamPos + (fract(aSeed.xyz + (drift - uCamPos) / uBox) - 0.5) * uBox;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  float edge = smoothstep(uBox * 0.5, uBox * 0.3, length(wp - uCamPos)) * smoothstep(0.15, 0.6, d);
  vTw = edge * (0.45 + 0.55 * sin(uTime * (0.8 + aSeed.w * 2.0) + aSeed.w * 90.0));
  gl_PointSize = clamp(uPx * (0.012 + 0.02 * aSeed.w) / max(d, 0.05), 1.0, 24.0);
  vWorld = wp;
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uSunColor;
uniform vec4 uCutPlane;
uniform float uStrength;
varying float vTw;
varying vec3 vWorld;
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > 0.0) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.0, length(p));
  a = a * a * vTw * uStrength;
  gl_FragColor = vec4((uSunColor + vec3(0.15)) * a, 0.0);
}
`;

class ParticleSystem implements ParticleEmitter {
  readonly capacity = POOL;
  mesh: THREE.Mesh | null = null;
  private p0 = new Float32Array(POOL * 4);
  private v0 = new Float32Array(POOL * 4);
  private col = new Float32Array(POOL * 4);
  private par = new Float32Array(POOL * 4);
  private par2 = new Float32Array(POOL * 4);
  private attrs: THREE.InstancedBufferAttribute[] = [];
  private cursor = 0;
  private dirtyLo = POOL;
  private dirtyHi = -1;
  private wrapped = false;
  private seed = 12345;
  clock = 0;
  uClock: THREE.IUniform<number> = { value: 0 };
  /** Density multiplier from the quality preset. */
  density = 1;

  private rand(): number {
    // deterministic LCG: shots must not depend on Math.random
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
    return (this.seed >>> 8) / 16777216;
  }

  init(ctx: RenderContext): THREE.Mesh {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (name: string, arr: Float32Array): void => {
      const a = new THREE.InstancedBufferAttribute(arr, 4);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      this.attrs.push(a);
    };
    this.attrs = [];
    mk('aP0', this.p0);
    mk('aV0', this.v0);
    mk('aCol', this.col);
    mk('aPar', this.par);
    mk('aPar2', this.par2);
    g.instanceCount = POOL;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uClock: this.uClock, uCutEntity: ctx.uniforms.uCutEntity, uCutGround: ctx.uniforms.uCutGround, uWind: ctx.uniforms.uWind, uSunColor: ctx.uniforms.uSunColor, uCutPlane: ctx.uniforms.uCutPlane, uPheroVision: ctx.uniforms.uPheroVision },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'particles';
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    this.mesh = mesh;
    this.v0.fill(0);
    this.cursor = 0;
    this.clock = 0;
    return mesh;
  }

  registerKind(name: string, preset: Partial<ParticlePreset>): void {
    PRESETS[name] = { ...(PRESETS[name] ?? BASE), ...preset };
  }

  emit(kind: ParticleKind, pos: Readonly<Vec3>, normal?: Readonly<Vec3> | null, params?: ParticleParams): void {
    this.emitCustom(kind, pos, normal, params);
  }

  emitCustom(name: string, pos: Readonly<Vec3>, normal?: Readonly<Vec3> | null, params?: ParticleParams): void {
    const pr = PRESETS[name];
    if (!pr || !this.mesh) return;
    let nx = normal ? normal.x : 0;
    let ny = normal ? normal.y : 1;
    let nz = normal ? normal.z : 0;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-5) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    const want = params?.count ?? pr.count;
    const count = want <= 1 ? want : Math.max(1, Math.round(want * this.density));
    const c = params?.color ?? pr.color;
    const sizeK = params?.size ?? 1;
    const speedK = params?.speed ?? 1;
    const lifeK = params?.life ?? 1;
    const radius = params?.radius ?? pr.radius;
    const spread = params?.spread ?? pr.spread;
    for (let i = 0; i < count; i++) {
      const j = this.cursor;
      this.cursor = (this.cursor + 1) % POOL;
      if (this.cursor === 0) this.wrapped = true;
      if (j < this.dirtyLo) this.dirtyLo = j;
      if (j > this.dirtyHi) this.dirtyHi = j;
      const k = j * 4;
      // random unit vector, blended with the normal by `spread`
      const u = this.rand() * 2 - 1;
      const th = this.rand() * 6.2832;
      const sq = Math.sqrt(1 - u * u);
      const rx = sq * Math.cos(th);
      const ry = u;
      const rz = sq * Math.sin(th);
      let dx = nx + rx * spread;
      let dy = ny + ry * spread;
      let dz = nz + rz * spread;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const sp = pr.speed * speedK * (1 - pr.speedVar * this.rand());
      const rr = radius * Math.cbrt(this.rand());
      this.p0[k] = pos.x + rx * rr + nx * 0.02;
      this.p0[k + 1] = pos.y + ry * rr + ny * 0.02;
      this.p0[k + 2] = pos.z + rz * rr + nz * 0.02;
      this.p0[k + 3] = this.clock - this.rand() * 0.03;
      this.v0[k] = dx * sp;
      this.v0[k + 1] = dy * sp;
      this.v0[k + 2] = dz * sp;
      this.v0[k + 3] = pr.life * lifeK * (1 - pr.lifeVar * this.rand());
      const tint = 0.8 + 0.4 * this.rand();
      this.col[k] = c[0] * tint;
      this.col[k + 1] = c[1] * tint;
      this.col[k + 2] = c[2] * tint;
      this.col[k + 3] = pr.opacity;
      this.par[k] = pr.size * sizeK * (1 - pr.sizeVar * this.rand());
      this.par[k + 1] = pr.gravity;
      this.par[k + 2] = pr.drag;
      this.par[k + 3] = pr.shape + 8 * Math.round(pr.additive * 100);
      this.par2[k] = pr.grow;
      this.par2[k + 1] = pr.lit;
      this.par2[k + 2] = this.rand();
      this.par2[k + 3] = 0;
    }
  }

  /** Uploads the slots written since the last flush. */
  flush(): void {
    if (this.dirtyHi < 0) return;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      if (!this.wrapped) a.addUpdateRange(this.dirtyLo * 4, (this.dirtyHi - this.dirtyLo + 1) * 4);
      a.needsUpdate = true;
    }
    this.dirtyLo = POOL;
    this.dirtyHi = -1;
    this.wrapped = false;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh = null;
  }
}

const system = new ParticleSystem();

/** The shared emitter (see `ParticleEmitter` in core/contracts/a4.ts). */
export const particles: ParticleEmitter = system;

export function createParticlesModule(): Module {
  let motes: THREE.Points | null = null;
  let moteU: { uCamPos: THREE.IUniform<THREE.Vector3>; uPx: THREE.IUniform<number>; uStrength: THREE.IUniform<number>; uBox: THREE.IUniform<number> } | null = null;
  let lastTick = -1;
  let footCursor = 0;
  const p = { x: 0, y: 0, z: 0 };
  const nrm = { x: 0, y: 1, z: 0 };

  return {
    id: 'particles',
    init(ctx) {
      system.density = Math.min(1.5, Math.max(0.35, ctx.quality.decoration));
      ctx.scene.add(system.init(ctx));
      lastTick = -1;

      // ambient motes
      const n = Math.round(MOTES * Math.min(1.5, ctx.quality.decoration));
      const seeds = new Float32Array(n * 4);
      let s = 987654321;
      for (let i = 0; i < seeds.length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) | 0;
        seeds[i] = (s >>> 8) / 16777216;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      moteU = { uCamPos: { value: new THREE.Vector3() }, uPx: { value: 500 }, uStrength: { value: 0.5 }, uBox: { value: 26 } };
      const mat = new THREE.ShaderMaterial({
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        uniforms: { ...moteU, uTime: ctx.uniforms.uTime, uWind: ctx.uniforms.uWind, uSunColor: ctx.uniforms.uSunColor, uCutPlane: ctx.uniforms.uCutPlane },
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
      });
      motes = new THREE.Points(g, mat);
      motes.name = 'particles:motes';
      motes.frustumCulled = false;
      motes.renderOrder = 5;
      ctx.scene.add(motes);
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      // particle clock: render time, or sim time while the render clock is frozen (shots)
      const dTick = lastTick < 0 ? 0 : Math.max(0, frame.tick - lastTick);
      lastTick = frame.tick;
      system.clock += frame.dt > 0 ? frame.dt : Math.min(0.5, dTick / 30);
      system.uClock.value = system.clock;
      const sim = ctx.sim;
      const world = sim.world;

      const upAt = (pos: Readonly<Vec3>): Vec3 => {
        world.gradient(pos.x, pos.y, pos.z, nrm);
        const l = Math.hypot(nrm.x, nrm.y, nrm.z);
        if (l < 0.05) {
          nrm.x = 0;
          nrm.y = 1;
          nrm.z = 0;
        } else {
          nrm.x = -nrm.x / l;
          nrm.y = -nrm.y / l;
          nrm.z = -nrm.z / l;
        }
        return nrm;
      };

      // ---- sim events → bursts (D19). Budgeted so a 4× catch-up frame cannot flood the pool.
      const events = frame.events;
      let budget = 96;
      for (let i = 0; i < events.length && budget > 0; i++) {
        const e = events[i];
        switch (e.type) {
          case 'dig': {
            const c = materialDef(e.material).color;
            const up = upAt(e.pos);
            system.emit('digDebris', e.pos, up, { color: [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8], radius: Math.min(0.5, e.radius * 0.25) });
            system.emit('dust', e.pos, up, { color: [c[0] * 1.1, c[1] * 1.1, c[2] * 1.1], count: 3 });
            budget--;
            break;
          }
          case 'build': {
            const c = materialDef(e.material).color;
            system.emit('dust', e.pos, upAt(e.pos), { color: c, count: 3, size: 0.7 });
            budget--;
            break;
          }
          case 'attack': {
            const up = upAt(e.pos);
            if (e.kind === 'acid') system.emit('droplet', e.pos, up, { color: [0.7, 1.0, 0.2] });
            else if (e.kind === 'glue') system.emit('droplet', e.pos, up, { color: [0.95, 0.95, 0.85], speed: 0.7 });
            else system.emit('spark', e.pos, up, e.kind === 'sting' ? { color: [1.0, 0.95, 0.4] } : undefined);
            budget--;
            break;
          }
          case 'damage':
            system.emit('spark', e.pos, upAt(e.pos), { color: [1.0, 0.3, 0.15], count: 2, speed: 0.6 });
            budget--;
            break;
          case 'foodDelivered':
          case 'itemPicked':
            system.emit('crumb', e.pos, upAt(e.pos), { count: 3 });
            budget--;
            break;
          case 'antDied':
          case 'fell':
            system.emit('dust', e.pos, upAt(e.pos), { count: 3, size: 0.6 });
            budget--;
            break;
          case 'creatureDied':
            system.emit('dust', e.pos, upAt(e.pos), { count: 10, size: 1.6, radius: 0.8 });
            budget--;
            break;
          case 'pheromoneBurst':
            // a brawl fires dozens of bursts on one spot: additive puffs stacked into a white-hot
            // blob. One puff per ~1.3 units per 0.7 s, and only a whisper outside pheromone vision.
            if (puffGate(e.pos.x, e.pos.y, e.pos.z, particleClock())) {
              const c = PHERO_COLORS[e.channel % PHERO_CHANNELS];
              if (ctx.view.pheroVision) system.emit('pheroPuff', e.pos, upAt(e.pos), { color: [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75], count: 9 });
              else system.emit('pheroPuff', e.pos, upAt(e.pos), { color: [c[0] * 0.2, c[1] * 0.2, c[2] * 0.2], count: 4, size: 0.8 });
              budget--;
            }
            break;
          case 'broodStage':
            if (e.stage === 'adult') system.emit('mote', e.pos, upAt(e.pos), { count: 5, radius: 0.3, life: 0.4 });
            budget--;
            break;
          case 'sporeBurst':
            system.emit('spore', e.pos, upAt(e.pos), { count: 40, radius: e.radius * 0.3 });
            budget--;
            break;
          default:
            break;
        }
      }

      // ---- footstep dust under ants close to the camera ------------------------------------
      const ants = sim.ants;
      const dSim = antsRuntime.dSim;
      if (dSim > 0 && ants.length > 0 && !ctx.map.flags.slab) {
        const cam = ctx.view.camera.pos;
        const scan = Math.min(ants.length, 160);
        for (let k = 0; k < scan; k++) {
          footCursor = (footCursor + 1) % ants.length;
          const a = ants[footCursor];
          if (!a.alive || a.moveSpeed < 0.6) continue;
          const dx = a.pos.x - cam.x;
          const dy = a.pos.y - cam.y;
          const dz = a.pos.z - cam.z;
          if (dx * dx + dy * dy + dz * dz > 49) continue;
          // only on dusty ground: soil / sand, facing up
          if (a.up.y < 0.5) continue;
          p.x = a.pos.x - a.up.x * a.rideHeight + (((footCursor * 7) % 5) - 2) * 0.06;
          p.y = a.pos.y - a.up.y * a.rideHeight;
          p.z = a.pos.z - a.up.z * a.rideHeight + (((footCursor * 3) % 5) - 2) * 0.06;
          system.emit('footDust', p, a.up);
        }
      }

      system.flush();

      if (motes && moteU) {
        const cam = ctx.view.camera;
        moteU.uCamPos.value.set(cam.pos.x, cam.pos.y, cam.pos.z);
        moteU.uPx.value = ctx.renderer.domElement.height / (2 * Math.tan((cam.fov * Math.PI) / 360));
        // sunny outdoor scenes sparkle; rooms and pheromone vision keep them subtle
        const room = ctx.map.environment.backdrop === 'room';
        moteU.uStrength.value = (room ? 0.3 : 0.55) * (1 - 0.7 * ctx.uniforms.uPheroVision.value) * (1 - 0.5 * ctx.uniforms.uWetness.value);
        moteU.uBox.value = ctx.view.mode === 'possess' ? 14 : Math.min(60, Math.max(18, cam.focusDist * 1.2));
      }
    },

    dispose() {
      system.dispose();
      if (motes) {
        motes.removeFromParent();
        motes.geometry.dispose();
        (motes.material as THREE.Material).dispose();
        motes = null;
      }
    },
  };
}

export const particlesModule: Module = createParticlesModule();

// ---- pheromone puff rate limiter -----------------------------------------------------------
const PUFF_SLOTS = 24;
const puffRecent = new Float32Array(PUFF_SLOTS * 4).fill(-1e6);
let puffCursor = 0;
function particleClock(): number {
  return antsRuntime.clock;
}
/** True when no puff was emitted within 1.3 units during the last 0.7 s (and records this one). */
function puffGate(x: number, y: number, z: number, t: number): boolean {
  for (let i = 0; i < PUFF_SLOTS; i++) {
    const o = i * 4;
    const age = t - puffRecent[o + 3];
    if (age < 0) puffRecent[o + 3] = -1e6; // clock was reset (new game)
    else if (age < 0.7) {
      const dx = puffRecent[o] - x;
      const dy = puffRecent[o + 1] - y;
      const dz = puffRecent[o + 2] - z;
      if (dx * dx + dy * dy + dz * dz < 1.7) return false;
    }
  }
  const o = puffCursor * 4;
  puffCursor = (puffCursor + 1) % PUFF_SLOTS;
  puffRecent[o] = x;
  puffRecent[o + 1] = y;
  puffRecent[o + 2] = z;
  puffRecent[o + 3] = t;
  return true;
}
