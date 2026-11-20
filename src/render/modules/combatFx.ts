import * as THREE from 'three';
import { COMBAT_MEM, Phero, type FrameInfo, type Mover, type Vec3 } from '../../core';
import { getCreature } from '../../sim/data/creatures';
import { getCaste } from '../../sim/data/species';
import type { Module, RenderContext } from '../shared';
import { antsRuntime } from './ants';
import { fx, fxDebug, fxDemo, fxGlueAt, fxGlueLevel, fxHurt, fxKick } from './fxShared';
import { particles, PHERO_COLORS } from './particles';

/**
 * Combat FX (§5.3) — diegetic, no numbers, no gore:
 *   attack  bite  → chitin chips + a few sparks at the contact point
 *           sting → a fine green venom mist
 *           acid  → yellow-green squirt from the attacker towards its target
 *           glue  → a taut pale jet from the nasute's nozzle to the victim (~0.45 s), stringy
 *                   globs along it and a splat on impact; the hit is remembered render-side
 *                   (`fxGlueAt`) so coat + strands linger while the victim is slowed
 *   damage  pale hemolymph droplets (amount scales the count)
 *   status  `mem['st.glued'] > tick`  → sagging glue strands tying the victim to the ground
 *           (plus the glue coat in the chitin shader, written by ants / creatures)
 *           `mem['st.poison'] > tick` → a slow green venom tick dripping off the body
 *   pheromoneBurst(alarm / attack) → an expanding ring on the surface: faint normally, bold in
 *           pheromone vision (the red puffs themselves come from the particles module)
 *   antDied(combat) / creatureDied → chips; dust comes from the particles module, the curl-up
 *           from the items module
 *   possession: own `attack` → `fxKick`; `damage` on the possessed ant → `fxHurt`
 *
 * Reads: events attack / damage / pheromoneBurst / antDied / creatureDied; `Ant.mem` /
 * `Creature.mem` keys from B1's `COMBAT_MEM`; `view.possessedId`.
 * Demo: `?fxdemo=glue` ties every 3rd visible ant down with strands (render-side only).
 */

const MAX_STRANDS = 256;
const MAX_JETS = 24;
const JET_TIME = 0.45;
const MAX_RINGS = 24;
const STRANDS_PER = 4;

const STRAND_VERT = /* glsl */ `
attribute vec4 aA; // start xyz, seed
attribute vec4 aB; // end xyz, width
uniform float uClock;
varying vec2 vUv;
varying float vSeed;
varying vec3 vWorld;
void main() {
  float t = position.y; // 0..1 along the strand
  vec3 p = mix(aA.xyz, aB.xyz, t);
  // sag + a slow elastic wobble
  // seed >= 2 marks a spray jet: nearly taut, with a fast ripple running down it
  float jet = step(2.0, aA.w);
  float sag = sin(t * 3.14159) * mix(0.12 + 0.1 * aA.w, 0.03, jet) * length(aB.xyz - aA.xyz);
  p.y -= sag * (0.8 + 0.2 * sin(uClock * 5.0 + aA.w * 40.0));
  p.y += jet * 0.02 * sin(t * 22.0 - uClock * 40.0 + aA.w * 9.0) * sin(t * 3.14159);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec3 dirV = normalize((viewMatrix * vec4(aB.xyz - aA.xyz, 0.0)).xyz + vec3(1e-4));
  vec2 side = normalize(vec2(-dirV.y, dirV.x) + vec2(1e-5));
  // thin in the middle, blobby at both anchor points
  float w = aB.w * mix(0.35 + 0.65 * pow(abs(t * 2.0 - 1.0), 2.0), 0.55 + 0.45 * t + 0.25 * sin(t * 30.0 - uClock * 50.0), jet);
  mv.xy += side * position.x * w;
  gl_Position = projectionMatrix * mv;
  vUv = vec2(position.x, t);
  vSeed = aA.w;
  vWorld = p;
}`;

const STRAND_FRAG = /* glsl */ `
uniform vec3 uSunColor;
uniform vec4 uCutPlane;
uniform float uCutSlack;
varying vec2 vUv;
varying float vSeed;
varying vec3 vWorld;
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > uCutSlack) discard;
  float x = abs(vUv.x);
  float a = smoothstep(1.0, 0.35, x);
  // a wet highlight down the middle
  float spec = smoothstep(0.35, 0.0, x);
  vec3 col = vec3(0.86, 0.82, 0.6) * (0.4 + 0.5 * uSunColor) + spec * 0.4 * uSunColor;
  gl_FragColor = vec4(col * a * 0.95, a * 0.92);
}`;

const RING_VERT = /* glsl */ `
attribute vec4 aC; // centre xyz, birth
attribute vec4 aN; // normal xyz, max radius
attribute vec3 aCol;
uniform float uClock;
varying vec2 vUv;
varying float vT;
varying vec3 vCol;
varying vec3 vWorld;
void main() {
  float age = uClock - aC.w;
  float t = clamp(age / 1.7, 0.0, 1.0);
  vT = age < 0.0 ? 1.0 : t;
  vec3 n = normalize(aN.xyz);
  vec3 tx = normalize(abs(n.y) < 0.95 ? cross(vec3(0.0, 1.0, 0.0), n) : vec3(1.0, 0.0, 0.0));
  vec3 tz = cross(n, tx);
  float r = aN.w * (0.12 + 0.88 * (1.0 - (1.0 - t) * (1.0 - t)));
  vec3 p = aC.xyz + n * 0.22 + (tx * position.x + tz * position.y) * r;
  vUv = position.xy;
  vCol = aCol;
  vWorld = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const RING_FRAG = /* glsl */ `
uniform float uPheroVision;
uniform vec4 uCutPlane;
varying vec2 vUv;
varying float vT;
varying vec3 vCol;
varying vec3 vWorld;
void main() {
  if (vT >= 1.0) discard;
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > 0.0) discard;
  float r = length(vUv);
  float w = 0.05 + 0.1 * vT;
  float ring = smoothstep(1.0 - w * 2.0, 1.0 - w, r) * smoothstep(1.0, 1.0 - w * 0.5, r);
  float trail = smoothstep(0.3, 1.0, r) * step(r, 1.0) * 0.18;
  float a = (ring + trail) * (1.0 - vT) * (1.0 - vT) * mix(0.045, 1.0, uPheroVision);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * a * (1.0 + 1.5 * uPheroVision), 0.0);
}`;

function hash(id: number, k: number): number {
  const s = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function createCombatFxModule(): Module {
  let strands: THREE.Mesh | null = null;
  let rings: THREE.Mesh | null = null;
  const sA = new Float32Array(MAX_STRANDS * 4);
  const sB = new Float32Array(MAX_STRANDS * 4);
  const rC = new Float32Array(MAX_RINGS * 4);
  const rN = new Float32Array(MAX_RINGS * 4);
  const rCol = new Float32Array(MAX_RINGS * 3);
  let ringCursor = 0;
  let ringLast = -1e6;
  // live spray jets: attacker id, target id, birth (FX clock)
  const jetA = new Int32Array(MAX_JETS);
  const jetB = new Int32Array(MAX_JETS);
  const jetT = new Float32Array(MAX_JETS).fill(-1e6);
  let jetCursor = 0;
  let venomCursor = 0;
  let venomTimer = 0;
  const p = { x: 0, y: 0, z: 0 };
  const nrm = { x: 0, y: 1, z: 0 };
  const dir = { x: 0, y: 1, z: 0 };

  function instanced(vert: string, frag: string, uniforms: Record<string, THREE.IUniform>, attrs: [string, Float32Array, number][], additive: boolean): THREE.Mesh {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(additive ? [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0] : [-1, 0, 0, 1, 0, 0, 1, 0.25, 0, -1, 0.25, 0, 1, 0.5, 0, -1, 0.5, 0, 1, 0.75, 0, -1, 0.75, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex(additive ? [0, 1, 2, 0, 2, 3] : [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5, 5, 4, 6, 5, 6, 7, 7, 6, 8, 7, 8, 9]);
    for (const [name, arr, size] of attrs) {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
    }
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    mesh.visible = false;
    return mesh;
  }

  return {
    id: 'combatFx',
    init(ctx) {
      // debug handle for scene inspection from the page (`__myrmeFx.scene`)
      (fxDebug() as Record<string, unknown>).scene = ctx.scene;
      (fxDebug() as Record<string, unknown>).renderer = ctx.renderer;
      // kinds shared with the creatures module (sand flick) — registered once, pooled by particles.ts
      particles.registerKind('chitinChip', { count: 5, color: [0.09, 0.07, 0.05], size: 0.05, sizeVar: 0.6, speed: 2.2, speedVar: 0.6, life: 0.7, lifeVar: 0.4, gravity: 9, drag: 0.8, spread: 0.9, radius: 0.04, additive: 0, shape: 1, grow: 1, opacity: 1, lit: 1 });
      particles.registerKind('hemolymph', { count: 5, color: [0.78, 0.84, 0.5], size: 0.045, sizeVar: 0.5, speed: 1.7, speedVar: 0.6, life: 0.6, lifeVar: 0.4, gravity: 8, drag: 0.6, spread: 0.8, radius: 0.03, additive: 0.15, shape: 2, grow: 0.6, opacity: 0.85, lit: 0.8 });
      particles.registerKind('venomMist', { count: 5, color: [0.4, 0.85, 0.22], size: 0.06, sizeVar: 0.5, speed: 0.7, speedVar: 0.6, life: 0.9, lifeVar: 0.4, gravity: -0.1, drag: 2.4, spread: 1, radius: 0.05, additive: 0.4, shape: 0, grow: 2.0, opacity: 0.26, lit: 0.3 });
      particles.registerKind('venomDrip', { count: 1, color: [0.4, 0.95, 0.2], size: 0.03, sizeVar: 0.3, speed: 0.3, speedVar: 0.5, life: 0.7, lifeVar: 0.3, gravity: 5, drag: 0.5, spread: 1.2, radius: 0.12, additive: 0.6, shape: 2, grow: 0.7, opacity: 0.9, lit: 0.2 });
      particles.registerKind('acidSquirt', { count: 12, color: [0.8, 1.0, 0.25], size: 0.04, sizeVar: 0.5, speed: 4.2, speedVar: 0.35, life: 0.5, lifeVar: 0.3, gravity: 5, drag: 0.7, spread: 0.16, radius: 0.03, additive: 0.5, shape: 2, grow: 0.8, opacity: 0.9, lit: 0.4 });
      particles.registerKind('glueGlob', { count: 9, color: [0.9, 0.86, 0.66], size: 0.05, sizeVar: 0.5, speed: 3.2, speedVar: 0.4, life: 0.65, lifeVar: 0.3, gravity: 6, drag: 1.2, spread: 0.2, radius: 0.03, additive: 0.1, shape: 2, grow: 1.3, opacity: 0.9, lit: 0.9 });
      particles.registerKind('glueSplat', { count: 10, color: [0.92, 0.88, 0.66], size: 0.07, sizeVar: 0.5, speed: 1.3, speedVar: 0.6, life: 0.8, lifeVar: 0.3, gravity: 7, drag: 1.6, spread: 1.0, radius: 0.12, additive: 0.05, shape: 2, grow: 1.5, opacity: 0.95, lit: 0.9 });
      particles.registerKind('sandFlick', { count: 12, color: [0.8, 0.68, 0.46], size: 0.05, sizeVar: 0.6, speed: 4.2, speedVar: 0.5, life: 0.9, lifeVar: 0.3, gravity: 9, drag: 0.5, spread: 0.35, radius: 0.15, additive: 0, shape: 1, grow: 1, opacity: 1, lit: 1 });

      strands = instanced(STRAND_VERT, STRAND_FRAG, { uClock: fx.uClock, uSunColor: ctx.uniforms.uSunColor, uCutPlane: ctx.uniforms.uCutPlane, uCutSlack: { value: 0 } }, [['aA', sA, 4], ['aB', sB, 4]], false);
      strands.name = 'combatFx:glueStrands';
      rings = instanced(RING_VERT, RING_FRAG, { uClock: fx.uClock, uPheroVision: ctx.uniforms.uPheroVision, uCutPlane: ctx.uniforms.uCutPlane }, [['aC', rC, 4], ['aN', rN, 4], ['aCol', rCol, 3]], true);
      rings.name = 'combatFx:alarmRings';
      ctx.scene.add(strands, rings);
      for (let i = 0; i < MAX_RINGS; i++) rC[i * 4 + 3] = -1e6;
      ringCursor = 0;
      ringLast = -1e6;
      jetT.fill(-1e6);
      fxGlueAt.clear();
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      if (!strands || !rings) return;
      const sim = ctx.sim;
      const world = sim.world;
      const view = ctx.view;
      const clock = fx.clock;
      const tick = frame.tick;
      const possessed = view.mode === 'possess' ? view.possessedId || sim.possessedId : 0;

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

      // ---- events ---------------------------------------------------------------------------
      const events = frame.events;
      let budget = 64;
      let ringsDirty = false;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'attack') {
          if (e.attacker === possessed && possessed) fxKick(0.9, 0, -1);
          if (budget-- <= 0) continue;
          if (e.kind === 'bite') {
            particles.emitCustom('chitinChip', e.pos, upAt(e.pos), { count: 4 });
          } else if (e.kind === 'sting') {
            particles.emitCustom('venomMist', e.pos, upAt(e.pos));
          } else {
            // sprays fly from the attacker to the contact point
            const a = sim.getEntity(e.attacker);
            if (a) {
              dir.x = e.pos.x - a.pos.x;
              dir.y = e.pos.y - a.pos.y + 0.15;
              dir.z = e.pos.z - a.pos.z;
              const d = Math.hypot(dir.x, dir.y, dir.z);
              p.x = a.pos.x + (dir.x / (d || 1)) * 0.3;
              p.y = a.pos.y + (dir.y / (d || 1)) * 0.3;
              p.z = a.pos.z + (dir.z / (d || 1)) * 0.3;
              particles.emitCustom(e.kind === 'acid' ? 'acidSquirt' : 'glueGlob', p, dir, { speed: Math.min(2, Math.max(0.5, d / 1.6)) });
              if (e.kind === 'glue') {
                jetA[jetCursor] = e.attacker;
                jetB[jetCursor] = e.target;
                jetT[jetCursor] = clock;
                jetCursor = (jetCursor + 1) % MAX_JETS;
              }
            }
            if (e.kind === 'glue') {
              fxGlueAt.set(e.target, clock);
              particles.emitCustom('glueSplat', e.pos, upAt(e.pos));
            }
          }
        } else if (e.type === 'damage') {
          if (e.target === possessed && possessed) fxHurt(Math.min(1, 0.4 + e.amount / 20));
          if (budget-- <= 0) continue;
          particles.emitCustom('hemolymph', e.pos, upAt(e.pos), { count: Math.min(9, 2 + Math.round(e.amount / 3)) });
        } else if ((e as { type: string }).type === 'sunburn') {
          // B3 termites in direct sun: a wisp of pale vapour off the cuticle
          const bp = (e as unknown as { pos: Vec3 }).pos;
          if (budget-- > 0) particles.emit('dust', bp, upAt(bp), { count: 2, size: 0.35, color: [0.95, 0.9, 0.8] });
        } else if ((e as { type: string }).type === 'leafCut') {
          // B3 leafcutters: green confetti where the mandibles shear the leaf
          const lp = (e as unknown as { pos: Vec3 }).pos;
          if (budget-- > 0) particles.emit('crumb', lp, upAt(lp), { count: 5, color: [0.3, 0.62, 0.16] });
        } else if (e.type === 'antDied') {
          if (e.cause === 'combat' && budget-- > 0) particles.emitCustom('chitinChip', e.pos, upAt(e.pos), { count: 6, speed: 0.7 });
        } else if (e.type === 'creatureDied') {
          if (budget-- > 0) particles.emitCustom('chitinChip', e.pos, upAt(e.pos), { count: 16, speed: 1.2, radius: 0.6, size: 1.8 });
        } else if (e.type === 'pheromoneBurst') {
          if (e.channel !== Phero.alarm && e.channel !== Phero.attack && e.channel !== Phero.rally) continue;
          // rate-limited: a panicking crowd emits many bursts
          if (clock - ringLast < (ctx.view.pheroVision ? 0.12 : 0.45)) continue;
          ringLast = clock;
          const j = ringCursor;
          ringCursor = (ringCursor + 1) % MAX_RINGS;
          const up = upAt(e.pos);
          const col = PHERO_COLORS[e.channel];
          rC[j * 4] = e.pos.x;
          rC[j * 4 + 1] = e.pos.y;
          rC[j * 4 + 2] = e.pos.z;
          rC[j * 4 + 3] = clock;
          rN[j * 4] = up.x;
          rN[j * 4 + 1] = up.y;
          rN[j * 4 + 2] = up.z;
          rN[j * 4 + 3] = e.channel === Phero.alarm ? 5.5 : 4;
          rCol[j * 3] = col[0];
          rCol[j * 3 + 1] = col[1];
          rCol[j * 3 + 2] = col[2];
          ringsDirty = true;
        }
      }
      // rings stay alive 1.7 s after the last one was born
      const ringsLive = clock - ringLast < 1.8;
      rings.visible = ringsLive;
      if (ringsDirty) {
        const g = rings.geometry as THREE.InstancedBufferGeometry;
        g.instanceCount = MAX_RINGS;
        (g.attributes.aC as THREE.BufferAttribute).needsUpdate = true;
        (g.attributes.aN as THREE.BufferAttribute).needsUpdate = true;
        (g.attributes.aCol as THREE.BufferAttribute).needsUpdate = true;
      }

      // ---- status: glue strands + venom tick ------------------------------------------------
      const culler = antsRuntime.culler;
      const demoGlue = fxDemo('glue');
      let ns = 0;
      const addStrands = (m: Readonly<Mover>, len: number, k_: number): void => {
        if (ns + STRANDS_PER > MAX_STRANDS) return;
        if (culler.depthIfVisible(m.pos.x, m.pos.y, m.pos.z, len * 2) < 0) return;
        const ux = m.up.x;
        const uy = m.up.y;
        const uz = m.up.z;
        const fx_ = m.forward.x;
        const fy_ = m.forward.y;
        const fz_ = m.forward.z;
        const rx = uy * fz_ - uz * fy_;
        const ry = uz * fx_ - ux * fz_;
        const rz = ux * fy_ - uy * fx_;
        for (let s = 0; s < STRANDS_PER; s++) {
          const h1 = hash(m.id, s * 3 + 1);
          const h2 = hash(m.id, s * 3 + 2);
          const ang = (s / STRANDS_PER + h1 * 0.2) * 6.283;
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          // body anchor: on the back, spread along the body
          const bz = (h2 - 0.5) * 0.7 * len;
          const bx = ca * 0.07 * len;
          const k = ns * 4;
          const kk = k_;
          sA[k] = m.pos.x + fx_ * bz + rx * bx + ux * 0.1 * len;
          sA[k + 1] = m.pos.y + fy_ * bz + ry * bx + uy * 0.1 * len;
          sA[k + 2] = m.pos.z + fz_ * bz + rz * bx + uz * 0.1 * len;
          sA[k + 3] = h1;
          // ground anchor: splayed out around the victim
          const gr = (0.45 + 0.5 * h2) * len;
          sB[k] = m.pos.x + (fx_ * sa + rx * ca) * gr - ux * m.rideHeight;
          sB[k + 1] = m.pos.y + (fy_ * sa + ry * ca) * gr - uy * m.rideHeight;
          sB[k + 2] = m.pos.z + (fz_ * sa + rz * ca) * gr - uz * m.rideHeight;
          sB[k + 3] = (0.02 + 0.016 * h1) * Math.sqrt(len / 0.7) * kk;
          ns++;
        }
      };
      const ants = sim.ants;
      const GL = COMBAT_MEM.glued;
      const PO = COMBAT_MEM.poison;
      for (let i = 0; i < ants.length; i++) {
        const a = ants[i];
        if (!a.alive) continue;
        const g = a.mem[GL];
        if ((g !== undefined && g > tick) || (demoGlue && a.id % 3 === 0)) addStrands(a, getCaste(a.species, a.caste).length, 1);
        else if (fxGlueAt.size > 0) {
          // slowed, no longer pinned: the strands thin out and let go
          const lv = fxGlueLevel(a.id);
          if (lv > 0.12) addStrands(a, getCaste(a.species, a.caste).length, 0.3 + 0.7 * lv);
        }
      }
      const creatures = sim.creatures;
      for (let i = 0; i < creatures.length; i++) {
        const c = creatures[i];
        if (!c.alive) continue;
        const g = c.mem[GL];
        if (g !== undefined && g > tick) addStrands(c, getCreature(c.def).length, 1);
        else if (fxGlueAt.size > 0) {
          const lv = fxGlueLevel(c.id);
          if (lv > 0.12) addStrands(c, getCreature(c.def).length, 0.3 + 0.7 * lv);
        }
      }
      // spray jets: two taut strands from the nozzle to the victim while the squirt lasts
      for (let j = 0; j < MAX_JETS; j++) {
        const age = clock - jetT[j];
        if (age < 0 || age > JET_TIME || ns + 2 > MAX_STRANDS) continue;
        const a = sim.getEntity(jetA[j]) as Readonly<Mover> | undefined;
        const b = sim.getEntity(jetB[j]) as Readonly<Mover> | undefined;
        if (!a || !b || !('up' in a) || !('up' in b)) continue;
        if (culler.depthIfVisible(b.pos.x, b.pos.y, b.pos.z, 3) < 0) continue;
        const fade = 1 - (age / JET_TIME) * (age / JET_TIME);
        for (let s = 0; s < 2; s++) {
          const k = ns * 4;
          const h = hash(jetA[j], s + 7);
          // nozzle: the tip of the nasute's head
          sA[k] = a.pos.x + a.forward.x * 0.34 + a.up.x * 0.08;
          sA[k + 1] = a.pos.y + a.forward.y * 0.34 + a.up.y * 0.08;
          sA[k + 2] = a.pos.z + a.forward.z * 0.34 + a.up.z * 0.08;
          sA[k + 3] = 2 + h;
          sB[k] = b.pos.x + b.up.x * 0.1 + (h - 0.5) * 0.25 * s;
          sB[k + 1] = b.pos.y + b.up.y * 0.1;
          sB[k + 2] = b.pos.z + b.up.z * 0.1 + (0.5 - h) * 0.25 * s;
          sB[k + 3] = (s === 0 ? 0.034 : 0.018) * fade;
          ns++;
        }
      }
      strands.visible = ns > 0;
      if (ns > 0) {
        const g = strands.geometry as THREE.InstancedBufferGeometry;
        g.instanceCount = ns;
        const aA = g.attributes.aA as THREE.BufferAttribute;
        const aB = g.attributes.aB as THREE.BufferAttribute;
        aA.clearUpdateRanges();
        aA.addUpdateRange(0, ns * 4);
        aA.needsUpdate = true;
        aB.clearUpdateRanges();
        aB.addUpdateRange(0, ns * 4);
        aB.needsUpdate = true;
        (strands.material as THREE.ShaderMaterial).uniforms.uCutSlack.value = ctx.uniforms.uCutEntity.value.z;
      }

      // venom tick: poisoned bodies drip green, a few per frame, round-robin
      venomTimer += fx.dAnim;
      if (venomTimer > 0.07) {
        venomTimer = 0;
        const total = ants.length + creatures.length;
        const scan = Math.min(total, 48);
        let emitted = 0;
        for (let q = 0; q < scan && emitted < 3; q++) {
          venomCursor = (venomCursor + 1) % total;
          const m: Readonly<Mover> = venomCursor < ants.length ? ants[venomCursor] : creatures[venomCursor - ants.length];
          if (!m.alive) continue;
          const pz = (m as { mem?: Record<string, number> }).mem?.[PO];
          if (pz === undefined || pz <= tick) continue;
          if (culler.depthIfVisible(m.pos.x, m.pos.y, m.pos.z, 1) < 0) continue;
          particles.emitCustom('venomDrip', m.pos, m.up);
          emitted++;
        }
      }
    },

    dispose() {
      for (const m of [strands, rings]) {
        if (!m) continue;
        m.removeFromParent();
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      strands = rings = null;
    },
  };
}

export const combatFxModule: Module = createCombatFxModule();
