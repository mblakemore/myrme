import * as THREE from 'three';
import { b3StateOf, type AnySimEvent, type CreatureGeometryKind, type FrameInfo, type Vec3 } from '../../core';
import type { RenderContext } from '../shared';
import { createInstancedCreature, type InstancedCreature } from './antsMaterial';
import { fx, fxDemo } from './fxShared';
import { GlowBatch } from './keeperGlow';
import { particles } from './particles';
import { getEnv } from './skyEnv';

/**
 * Nuptial flight FX (B4; runs inside keeperFx on outdoor maps).
 *
 * The sim flies the colony's real alates up and out of the world (B3 behaviors/nuptial.ts; the
 * ants module draws them in the fly pose). This adds the spectacle around them:
 *  - gather: pollen / dust motes lift off around the assembly point, sun shafts fade in
 *  - takeoff: an instanced far swarm (`<species>:alate`, LOD 2, fly pose `b.z = −1`) on a rising,
 *    widening spiral that carries on above the top of the world where the real alates vanish —
 *    the rest of the valley's colonies flying on the same afternoon; wing glints on the swarm and
 *    on the real flying alates; warm bloom lift (returned to keeperFx, which owns `fx.bloom`)
 *
 * Sim inputs: events `nuptialFlight {colony, pos, phase}` and B3 `alateTakeoff {pos}`;
 * `b3StateOf(sim).nuptial[].phase` (ends the show when 'done' / 'none'); `ant.anim === 'fly'`
 * of alates for glints; sky env (sun direction / colour, day, cloudiness).
 * Demo: `fxDemo('nuptial')` — a permanent takeoff over the player nest.
 */

const SWARM = 120;
const SHAFTS = 6;
const LOOP = 17;
const SHOW = 46;

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const hash = (i: number, k: number): number => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const SHAFT_VERT = /* glsl */ `
attribute vec4 aShaft; // base xyz, width
attribute vec2 aShaftK; // length, seed
uniform vec3 uAxis;
uniform float uClock;
varying vec2 vUv;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = aShaftK.y;
  vec3 c = aShaft.xyz + uAxis * (uv.y * aShaftK.x);
  vec3 side = normalize(cross(uAxis, cameraPosition - c));
  float sway = sin(uClock * 0.21 + aShaftK.y * 40.0) * 0.6;
  vec3 w = c + side * ((uv.x - 0.5) * aShaft.w * (0.75 + 0.5 * uv.y) + sway);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const SHAFT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uK;
uniform float uClock;
varying vec2 vUv;
varying float vSeed;
void main() {
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float streak = 0.72 + 0.28 * sin(vUv.x * 23.0 + vSeed * 50.0 + uClock * 0.15);
  float a = pow(across, 1.6) * streak * smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.45, vUv.y);
  a *= 0.75 + 0.25 * sin(uClock * 0.5 + vSeed * 17.0);
  gl_FragColor = vec4(uColor * a * uK, 0.0);
}`;

export interface NuptialFx {
  /** Returns the bloom lift for this frame. */
  update(ctx: RenderContext, frame: FrameInfo): number;
  dispose(): void;
}

export function createNuptialFx(ctx: RenderContext): NuptialFx {
  const low = ctx.quality.preset === 'low';
  const nSwarm = low ? 48 : SWARM;
  const colony = ctx.sim.getColony(ctx.sim.playerColony) ?? ctx.sim.colonies[0];
  const kind = `${colony ? colony.species : 'gardenAnt'}:alate` as CreatureGeometryKind;
  const swarm: InstancedCreature = createInstancedCreature(kind, 2, nSwarm, ctx.uniforms);
  swarm.ensure(nSwarm);
  swarm.mesh.name = 'nuptial:swarm';
  swarm.mesh.frustumCulled = false;
  swarm.mesh.castShadow = false;
  swarm.commit(0);
  ctx.scene.add(swarm.mesh);
  const glow = new GlowBatch(ctx, 96, 'nuptial:glints');

  // sun shafts: one instanced draw, billboarded about the sun axis
  const sg = new THREE.InstancedBufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  sg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  sg.setIndex([0, 1, 2, 0, 2, 3]);
  const shaftP = new Float32Array(SHAFTS * 4);
  const shaftK = new Float32Array(SHAFTS * 2);
  const aShaft = new THREE.InstancedBufferAttribute(shaftP, 4);
  aShaft.setUsage(THREE.DynamicDrawUsage);
  sg.setAttribute('aShaft', aShaft);
  sg.setAttribute('aShaftK', new THREE.InstancedBufferAttribute(shaftK, 2));
  sg.instanceCount = SHAFTS;
  sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const shaftU = { uAxis: { value: new THREE.Vector3(0, 1, 0) }, uColor: { value: new THREE.Color(1, 0.8, 0.5) }, uK: { value: 0 }, uClock: fx.uClock };
  const shaftMat = new THREE.ShaderMaterial({ vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG, uniforms: shaftU, side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
  const shafts = new THREE.Mesh(sg, shaftMat);
  shafts.name = 'nuptial:shafts';
  shafts.frustumCulled = false;
  shafts.renderOrder = 21;
  shafts.visible = false;
  ctx.scene.add(shafts);

  particles.registerKind('nuptialPollen', { count: 4, color: [1.0, 0.86, 0.5], size: 0.05, sizeVar: 0.7, speed: 0.5, speedVar: 0.8, life: 7, lifeVar: 0.4, gravity: -0.12, drag: 0.5, spread: 1.2, radius: 4, additive: 1, shape: 3, grow: 1, opacity: 0.9, lit: 0.5 });

  let phase: 'idle' | 'gather' | 'takeoff' = 'idle';
  let t0 = -1e6;
  let k = 0;
  let acc = 0;
  let placed = false;
  const at = new THREE.Vector3();
  const p: Vec3 = { x: 0, y: 0, z: 0 };
  const up: Vec3 = { x: 0, y: 1, z: 0 };
  const col: [number, number, number] = [1, 0.86, 0.5];

  function begin(next: 'gather' | 'takeoff', pos: Readonly<Vec3>): void {
    if (phase !== next) t0 = fx.clock;
    phase = next;
    at.set(pos.x, pos.y, pos.z);
    placed = false;
  }

  return {
    update(c: RenderContext, frame: FrameInfo): number {
      const sim = c.sim;
      const clock = fx.clock;
      const env = getEnv(c);
      const events = frame.events as readonly AnySimEvent[];
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'nuptialFlight') begin(e.phase, e.pos);
        else if (e.type === 'alateTakeoff') {
          // a puff of dust and a flash off the wings as she leaves the ground
          particles.emit('dust', e.pos, up, { count: 2, size: 0.6 });
          particles.emitCustom('nuptialPollen', e.pos, up, { count: 3, radius: 0.6, life: 0.5 });
        }
      }
      const demo = fxDemo('nuptial');
      if (demo && phase !== 'takeoff') {
        const pc = sim.getColony(sim.playerColony);
        if (pc) begin('takeoff', pc.nestPos);
        // the nest position is underground: lift the show to the surface
        at.y = Math.max(at.y, getEnv(c).mapExtras?.surfaceY ?? at.y);
      }
      if (phase !== 'idle' && !demo) {
        // the colony's own state ends the show; a hard cap covers a missing B3 system
        let simPhase = '';
        const ns = b3StateOf(sim).nuptial;
        for (let i = 0; i < ns.length; i++) if (ns[i].phase === 'gather' || ns[i].phase === 'takeoff') simPhase = ns[i].phase;
        const age = clock - t0;
        if (phase === 'gather' && age > 90 && simPhase === '') phase = 'idle';
        if (phase === 'takeoff' && age > SHOW && simPhase !== 'takeoff') phase = 'idle';
      }
      const snap = c.sync || frame.frozen;
      const target = phase === 'takeoff' ? 1 : phase === 'gather' ? 0.45 : 0;
      k = snap && target > 0 ? target : k + (target - k) * Math.min(1, fx.dAnim * 0.8);
      if (k < 0.004 && target === 0) {
        k = 0;
        if (swarm.mesh.count !== 0) swarm.commit(0);
        shafts.visible = false;
        glow.begin();
        glow.end();
        return 0;
      }

      const sunK = Math.max(0.15, env.day) * (1 - 0.7 * env.cloudiness);
      const kc = env.keyColor;

      // ---- sun shafts --------------------------------------------------------------------------
      if (!placed) {
        placed = true;
        const axis = shaftU.uAxis.value.copy(env.sunDir);
        if (axis.y < 0.25) axis.set(axis.x, 0.25, axis.z).normalize();
        for (let i = 0; i < SHAFTS; i++) {
          const a = hash(i, 1) * 6.283;
          const r = 3 + hash(i, 2) * 16;
          shaftP[i * 4] = at.x + Math.cos(a) * r - axis.x * 3;
          shaftP[i * 4 + 1] = at.y - 1.5;
          shaftP[i * 4 + 2] = at.z + Math.sin(a) * r - axis.z * 3;
          shaftP[i * 4 + 3] = 2.5 + hash(i, 3) * 5;
          shaftK[i * 2] = 55 + hash(i, 4) * 30;
          shaftK[i * 2 + 1] = hash(i, 5);
        }
        aShaft.needsUpdate = true;
        (sg.attributes.aShaftK as THREE.BufferAttribute).needsUpdate = true;
      }
      shafts.visible = true;
      shaftU.uColor.value.setRGB(kc.r * 1.0 + 0.1, kc.g * 0.9 + 0.06, kc.b * 0.7 + 0.02);
      shaftU.uK.value = k * sunK * (0.14 + 0.12 * env.golden);

      // ---- pollen ------------------------------------------------------------------------------
      acc += fx.dAnim;
      if (acc > 0.16) {
        acc = 0;
        p.x = at.x;
        p.y = at.y + 2.5;
        p.z = at.z;
        col[0] = 0.5 + 0.5 * kc.r;
        col[1] = 0.42 + 0.45 * kc.g;
        col[2] = 0.2 + 0.3 * kc.b;
        particles.emitCustom('nuptialPollen', p, up, { count: low ? 2 : 4, radius: 9, color: col });
        p.y = at.y + 9;
        particles.emitCustom('nuptialPollen', p, up, { count: low ? 1 : 3, radius: 14, color: col, size: 1.5 });
      }

      // ---- the far swarm -----------------------------------------------------------------------
      glow.begin();
      const age0 = clock - t0;
      const flying = phase === 'takeoff';
      let n = 0;
      const m = swarm.matrix;
      const gk = sunK * k;
      for (let i = 0; i < nSwarm; i++) {
        const h1 = hash(i, 11);
        const h2 = hash(i, 12);
        const h3 = hash(i, 13);
        let age: number;
        if (flying) {
          age = age0 + 6 - h1 * (LOOP + 4); // the first wave is already up when the event lands
          if (age < 0) continue;
          age %= LOOP;
        } else {
          // gather: a few scouts circle high above
          if (i % 9 !== 0) continue;
          age = 6 + h1 * 5 + Math.sin(clock * 0.3 + h2 * 6) * 1.5;
        }
        const dir = h3 > 0.5 ? 1 : -1;
        const w = (0.55 + 0.5 * h3) * dir;
        const ang = h2 * 6.283 + age * w + Math.sin(age * 1.9 + h1 * 9) * 0.25;
        const dr = 1.5 + 2.2 * h2;
        const r = 3 + age * dr;
        const vy = 2.6 + 2.2 * h3;
        const bobW = 2.3 + 2 * h1;
        const px = at.x + Math.cos(ang) * r;
        const py = at.y + 1.5 + age * vy + Math.sin(clock * bobW + h2 * 30) * 0.5;
        const pz = at.z + Math.sin(ang) * r;
        // heading = analytic tangent of the spiral
        let fxv = -Math.sin(ang) * r * w + Math.cos(ang) * dr;
        let fyv = flying ? vy : Math.cos(clock * 0.3 + h2 * 6) * 0.4;
        let fzv = Math.cos(ang) * r * w + Math.sin(ang) * dr;
        const fl = Math.hypot(fxv, fyv, fzv) || 1;
        fxv /= fl;
        fyv /= fl;
        fzv /= fl;
        // right = up × forward (world up, banked a little into the turn), then true up
        let rx = fzv;
        let rz = -fxv;
        const rl = Math.hypot(rx, rz) || 1;
        rx /= rl;
        rz /= rl;
        const ry = -0.3 * dir;
        const ux = fyv * rz - fzv * ry;
        const uy = fzv * rx - fxv * rz;
        const uz = fxv * ry - fyv * rx;
        const s = (1.5 + 0.7 * h1) * 1.6 * (flying ? smooth(age / 0.8) * (1 - smooth((age - (LOOP - 2.5)) / 2.5)) : 1);
        if (s < 0.03) continue;
        const o = n * 16;
        m[o] = rx * s;
        m[o + 1] = ry * s;
        m[o + 2] = rz * s;
        m[o + 3] = 0;
        m[o + 4] = ux * s;
        m[o + 5] = uy * s;
        m[o + 6] = uz * s;
        m[o + 7] = 0;
        m[o + 8] = fxv * s;
        m[o + 9] = fyv * s;
        m[o + 10] = fzv * s;
        m[o + 11] = 0;
        m[o + 12] = px;
        m[o + 13] = py;
        m[o + 14] = pz;
        m[o + 15] = 1;
        const c3 = n * 3;
        swarm.color[c3] = swarm.look.color[0];
        swarm.color[c3 + 1] = swarm.look.color[1];
        swarm.color[c3 + 2] = swarm.look.color[2];
        const c4 = n * 4;
        swarm.a[c4] = h1 * 7;
        swarm.a[c4 + 1] = 1;
        swarm.a[c4 + 2] = h2;
        swarm.a[c4 + 3] = 1;
        swarm.b[c4] = 0;
        swarm.b[c4 + 1] = 0;
        swarm.b[c4 + 2] = -1;
        swarm.b[c4 + 3] = 0;
        swarm.c[c4] = swarm.c[c4 + 1] = swarm.c[c4 + 2] = swarm.c[c4 + 3] = 0;
        swarm.d[c4] = swarm.d[c4 + 1] = swarm.d[c4 + 2] = swarm.d[c4 + 3] = 0;
        n++;
        // wings catch the sun for an instant as she banks
        const tw = Math.sin(clock * (2.2 + 3 * h2) + h1 * 40);
        if (tw > 0.86) {
          const g = (tw - 0.86) / 0.14;
          glow.add(px, py + 0.3, pz, 1.6 + 2.2 * g, 1.0, 0.92, 0.7, gk * (0.5 + 1.6 * g), true);
        }
      }
      swarm.commit(n);

      // glints on the colony's real flying alates
      const ants = sim.ants;
      for (let i = 0; i < ants.length; i++) {
        const a = ants[i];
        if (a.caste !== 'alate' || !a.alive || a.anim !== 'fly') continue;
        const tw = Math.sin(clock * 5.1 + a.id * 2.399);
        if (tw > 0.6) glow.add(a.pos.x, a.pos.y + 0.4, a.pos.z, 1.2 + 1.4 * tw, 1.0, 0.93, 0.72, gk * 1.4 * (tw - 0.6), true);
      }
      // a soft warm bloom over the assembly point
      glow.add(at.x, at.y + 5, at.z, 26, kc.r, kc.g * 0.85, kc.b * 0.55, k * sunK * 0.05);
      glow.end();

      return k * (0.12 + 0.24 * sunK);
    },

    dispose() {
      swarm.mesh.removeFromParent();
      swarm.dispose();
      glow.dispose();
      shafts.removeFromParent();
      sg.dispose();
      shaftMat.dispose();
    },
  };
}
