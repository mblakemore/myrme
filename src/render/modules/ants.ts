import * as THREE from 'three';
import { COMBAT_MEM, type Ant, type Creature, type CasteId, type CreatureGeometryKind, type FrameInfo, type GeometryLod, type SpeciesId, type ViewState } from '../../core';
import { getCreatureRig, SPECIES_CASTES } from '../../assets/geometry';
import { getCreature } from '../../sim/data/creatures';
import { getCaste } from '../../sim/data/species';
import type { Module, RenderContext } from '../shared';
import { chitinEnv, createInstancedCreature, disposeChitinMaterials, getChitinMaterials, type InstancedCreature } from './antsMaterial';
import { antState, farScale, infectionAmount, sunExposure, ViewCuller, writeAttachedMatrix, writeMoverMatrix } from './antsShared';
import { fx, fxGlueAt, fxGlueLevel } from './fxShared';
import { getEnv } from './skyEnv';

/**
 * Ants (§5.3): InstancedMesh buckets per species × caste × LOD, pose interpolated between sim
 * ticks (D13), all motion in the vertex shader (see antsMaterial.ts):
 *  - gait phase is advanced by distance travelled, so feet plant at any speed,
 *  - manual frustum culling + LOD by projected size (no allocation per frame),
 *  - the possessed ant is always LOD 0 in third person; in first person its body is hidden and
 *    a camera-attached rig shows its own antennae and mandibles (animated, bite feedback).
 *
 * Instance basis: X = up × forward (right), Y = up, Z = forward, scaled by caste length.
 */

export { writeMoverMatrix } from './antsShared';

/** Projected body length (px) above which an ant gets the high / medium mesh. */
const HIGH_PX = 150;
const MED_PX = 30;
const MAX_HIGH = 48;

interface CasteBuckets {
  kind: CreatureGeometryKind;
  len: number;
  stride: number;
  color: readonly [number, number, number];
  lods: (InstancedCreature | null)[];
  need: Int32Array;
  n: Int32Array;
}

/** Shared with the other A4 modules and the gallery. */
export const antsRuntime: {
  ctx: RenderContext | null;
  culler: ViewCuller;
  /** Animation clock (seconds): render time, or sim time while the render clock is frozen. */
  clock: number;
  /** Sim seconds advanced since the previous frame. */
  dSim: number;
  /** True when more than one colony is alive (colony paint dots are shown). */
  marked: boolean;
  /** Instances drawn last frame per LOD (debug / perf report). */
  drawn: [number, number, number];
  /** Gallery/debug: show paint dots even with a single colony. */
  forceMarked: boolean;
} = { ctx: null, culler: new ViewCuller(), clock: 0, dSim: 0, marked: false, drawn: [0, 0, 0], forceMarked: false };

/**
 * Body matrix of an ant exactly as the ants module draws it (far-zoom exaggeration included).
 * Returns the world-space body length used. Carried items / rings use this to stay attached.
 */
export function writeAntBodyMatrix(a: Readonly<Ant>, alpha: number, view: Readonly<ViewState>, out: Float32Array | number[], offset: number): number {
  const len = getCaste(a.species, a.caste).length;
  const ex = farScale(view, antsRuntime.culler.dist(a.pos.x, a.pos.y, a.pos.z));
  writeMoverMatrix(a, alpha, len * ex, out, offset, (ex - 1) * a.rideHeight);
  return len * ex;
}

const LATCH_ID = COMBAT_MEM.latchId;
const LATCH_UNTIL = COMBAT_MEM.latchUntil;
const GLUED = COMBAT_MEM.glued;

// ---------------------------------------------------------------------------------------------
// Queen marker: a small three-point crown glint floating over the player's queen. Invisible up
// close (the queen is unmistakable there); fades in as she shrinks below ~40 px and then keeps a
// constant on-screen size, so she can be found at whole-nest zoom. Depth-tested, LDR-level
// (stays under the bloom threshold), one draw call.
// ---------------------------------------------------------------------------------------------
const CROWN_MAX = 4;
const crownPos = new Float32Array(CROWN_MAX * 4);

function createCrown(ctx: RenderContext): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(CROWN_MAX * 3), 3));
  const attr = new THREE.BufferAttribute(crownPos, 4);
  attr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aCrown', attr);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uClock: fx.uClock, uPx: { value: 500 }, uCutPlane: ctx.uniforms.uCutPlane, uCutSlack: { value: 0 }, uPheroVision: ctx.uniforms.uPheroVision },
    vertexShader: /* glsl */ `
      attribute vec4 aCrown;
      uniform float uPx;
      uniform float uClock;
      varying float vK;
      varying float vSeed;
      varying vec3 vWorld;
      void main() {
        vec4 mv = viewMatrix * vec4(aCrown.xyz, 1.0);
        float d = max(-mv.z, 0.05);
        float bodyPx = uPx * 1.1 / d;               // queen ≈ 1.1 units long
        vK = 1.0 - smoothstep(26.0, 60.0, bodyPx);  // only when she is small on screen
        float px = clamp(bodyPx * 0.9, 15.0, 22.0);
        mv.y += (px * 0.55 + bodyPx * 0.3) * d / uPx; // float just above her
        gl_Position = projectionMatrix * mv;
        gl_PointSize = px * step(0.01, vK);
        vSeed = aCrown.w;
        vWorld = aCrown.xyz;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uClock;
      uniform vec4 uCutPlane;
      uniform float uCutSlack;
      uniform float uPheroVision;
      varying float vK;
      varying float vSeed;
      varying vec3 vWorld;
      void main() {
        if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > uCutSlack) discard;
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        p.y = -p.y;
        // crown silhouette: a band with three points
        float band = step(abs(p.x), 0.62) * step(-0.5, p.y) * step(p.y, -0.12);
        float ax = abs(p.x);
        float tooth = max(0.0, 1.0 - abs(ax - 0.5) / 0.2) * step(ax, 0.72);
        tooth = max(tooth, max(0.0, 1.0 - ax / 0.2) * 1.15);
        float spikes = step(-0.12, p.y) * step(p.y, -0.12 + tooth * 0.62) * step(ax, 0.72);
        float shape = max(band, spikes);
        float halo = smoothstep(1.0, 0.2, length(p)) * 0.16;
        float tw = 0.85 + 0.15 * sin(uClock * 2.6 + vSeed * 40.0);
        float a = (shape * 0.8 + halo) * vK * tw;
        if (a < 0.01) discard;
        vec3 col = mix(vec3(0.95, 0.72, 0.2), vec3(1.0, 0.92, 0.6), shape * (0.5 + 0.5 * p.y));
        col = mix(col * 0.75, col, shape);
        gl_FragColor = vec4(col * a * (1.0 - 0.5 * uPheroVision), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
  const pts = new THREE.Points(g, mat);
  pts.name = 'ants:queenCrown';
  pts.frustumCulled = false;
  pts.renderOrder = 7;
  pts.visible = false;
  ctx.scene.add(pts);
  return pts;
}

function updateCrown(ctx: RenderContext, crown: THREE.Points, n: number): void {
  const firstPerson = ctx.view.mode === 'possess';
  crown.visible = n > 0 && !firstPerson;
  if (!crown.visible) return;
  crown.geometry.setDrawRange(0, n);
  (crown.geometry.attributes.aCrown as THREE.BufferAttribute).needsUpdate = true;
  const u = (crown.material as THREE.ShaderMaterial).uniforms;
  u.uPx.value = antsRuntime.culler.pxScale;
  u.uCutSlack.value = ctx.uniforms.uCutEntity.value.z;
}

export function createAntsModule(): Module {
  const buckets = new Map<string, CasteBuckets>();
  const bucketList: CasteBuckets[] = [];
  const fpRigs = new Map<string, InstancedCreature>();
  const selected = new Set<number>();
  let lodScratch = new Uint8Array(0);
  let distScratch = new Float32Array(0);
  let lastSim = -1;
  let sunCursor = 0;
  const culler = antsRuntime.culler;
  const skyBase = new THREE.Color();
  const groundBase = new THREE.Color();
  let crown: THREE.Points | null = null;

  function fpRigFor(ctx: RenderContext, kind: string): InstancedCreature {
    let rig = fpRigs.get(kind);
    if (!rig) {
      rig = createInstancedCreature(`fp:${kind}` as CreatureGeometryKind, 0, 1, ctx.uniforms);
      rig.mesh.castShadow = false;
      rig.mesh.name = 'ants:firstPerson';
      ctx.scene.add(rig.mesh);
      fpRigs.set(kind, rig);
    }
    return rig;
  }

  function bucketFor(ctx: RenderContext, species: SpeciesId, caste: CasteId): CasteBuckets {
    const key = species + ':' + caste;
    let b = buckets.get(key);
    if (b) return b;
    const modelled: CasteId = SPECIES_CASTES[species].includes(caste) ? caste : 'worker';
    const kind = `${species}:${modelled}` as CreatureGeometryKind;
    const probe = createInstancedCreature(kind, 2, 64, ctx.uniforms);
    ctx.scene.add(probe.mesh);
    b = { kind, len: getCaste(species, caste).length, stride: probe.rig.stride, color: probe.look.color, lods: [null, null, probe], need: new Int32Array(3), n: new Int32Array(3) };
    buckets.set(key, b);
    bucketList.push(b);
    return b;
  }

  function lodMesh(ctx: RenderContext, b: CasteBuckets, lod: GeometryLod, need: number): InstancedCreature {
    let m = b.lods[lod];
    if (!m) {
      m = createInstancedCreature(b.kind, lod, Math.max(need, lod === 0 ? 8 : 32), ctx.uniforms);
      ctx.scene.add(m.mesh);
      b.lods[lod] = m;
    } else if (need > m.capacity) m.ensure(need);
    return m;
  }

  return {
    id: 'ants',
    init(ctx) {
      antsRuntime.ctx = ctx;
      antsRuntime.clock = 0;
      antState.reset();
      lastSim = -1;
      const env = ctx.map.environment;
      // analytic sky reflection: horizon/zenith blend above, ground bounce below
      chitinEnv.uSkyC.value.setRGB((env.skyTop[0] + env.skyHorizon[0]) * 0.5, (env.skyTop[1] + env.skyHorizon[1]) * 0.5, (env.skyTop[2] + env.skyHorizon[2]) * 0.5).multiplyScalar(Math.max(0.35, env.ambientIntensity));
      chitinEnv.uGroundC.value.setRGB(env.groundColor[0], env.groundColor[1], env.groundColor[2]).multiplyScalar(Math.max(0.35, env.ambientIntensity));
      skyBase.copy(chitinEnv.uSkyC.value);
      groundBase.copy(chitinEnv.uGroundC.value);
      crown = createCrown(ctx);
      // warm the player's worker bucket so the first frame does not hitch
      const first = ctx.sim.ants[0];
      if (first) bucketFor(ctx, first.species, first.caste);
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      const sim = ctx.sim;
      const view = ctx.view;
      const ants = sim.ants;
      const n = ants.length;
      const alpha = frame.alpha;
      const cam = view.camera;
      culler.set(cam, ctx.camera.aspect, ctx.renderer.domElement.height);

      // ---- clocks ---------------------------------------------------------------------------
      const simNow = frame.tick + alpha;
      const dSim = lastSim < 0 ? 0 : Math.min(0.5, Math.max(0, (simNow - lastSim) / 30));
      lastSim = simNow;
      const dAnim = frame.dt > 0 ? frame.dt : dSim;
      antsRuntime.clock += dAnim;
      antsRuntime.dSim = dSim;
      // B4 FX clock (see fxShared): same animation clock for every effect module
      fx.clock = antsRuntime.clock;
      fx.dAnim = dAnim;
      fx.uClock.value = antsRuntime.clock;
      const clock = antsRuntime.clock;
      const st = antState;

      // ---- environment → analytic reflection colours (night: no daytime softbox, moon wrap) ----
      {
        const env = getEnv(ctx);
        const lum = env.room ? 0.35 + 0.65 * env.day : 0.05 + 0.95 * env.day;
        chitinEnv.uSkyC.value.copy(skyBase).multiplyScalar(lum);
        chitinEnv.uGroundC.value.copy(groundBase).multiplyScalar(lum);
        chitinEnv.uNightK.value = env.room ? 0 : env.night;
        // rooms: the backlit pane would push translucent bodies (sugar, grubs, honeydew) past the bloom threshold
        chitinEnv.uTranslK.value = env.room ? 0.42 : 1 - 0.6 * env.night;
      }

      // ---- events → per-ant animation triggers ----------------------------------------------
      const events = frame.events;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'attack') {
          st.ensure(e.attacker);
          st.biteAt[e.attacker] = clock;
        } else if (e.type === 'damage') {
          st.ensure(e.target);
          st.hurtAt[e.target] = clock;
        } else if ((e as { type: string }).type === 'sunburn') {
          // B3: a sun-sensitive termite scorching in the open flinches like a hit
          const id = (e as unknown as { id: number }).id;
          st.ensure(id);
          st.hurtAt[id] = clock;
        }
      }

      // ---- colonies ---------------------------------------------------------------------------
      let alive = 0;
      for (let i = 0; i < sim.colonies.length; i++) if (sim.colonies[i].alive) alive++;
      const marked = alive > 1 || antsRuntime.forceMarked;
      antsRuntime.marked = marked;
      selected.clear();
      for (let i = 0; i < view.selection.length; i++) selected.add(view.selection[i]);

      if (lodScratch.length < n) {
        lodScratch = new Uint8Array(Math.ceil(n * 1.5) + 16);
        distScratch = new Float32Array(lodScratch.length);
      }
      for (let i = 0; i < bucketList.length; i++) bucketList[i].need.fill(0);

      const possessed = view.mode === 'possess' ? view.possessedId : 0;
      const fpId = possessed && view.firstPerson ? possessed : 0;
      const sunDir = ctx.uniforms.uSunDir.value;
      const slab = ctx.map.flags.slab;
      const maxDetailed = ctx.quality.antLodCount;
      const world = sim.world;

      // ---- pass 1: state advance, cull, LOD -------------------------------------------------
      let high = 0;
      let detailed = 0;
      let prev: Readonly<Ant> | null = null;
      let prevBucket: CasteBuckets | null = null;
      for (let i = 0; i < n; i++) {
        const a = ants[i];
        if (!a.alive) {
          lodScratch[i] = 255;
          continue;
        }
        const id = a.id;
        if (id >= st.cap) st.ensure(id);
        const b: CasteBuckets = prev && prev.species === a.species && prev.caste === a.caste ? prevBucket! : bucketFor(ctx, a.species, a.caste);
        prev = a;
        prevBucket = b;
        if (st.sun[id] < 0) {
          // first sight of this ant: seed its state
          st.odo[id] = a.phase;
          st.spd[id] = Math.min(1, a.moveSpeed / 2.2);
          st.carry[id] = a.carrying ? 1 : 0;
          st.sun[id] = Math.max(slab ? 0.7 : 0, sunExposure(world, a.pos.x, a.pos.y, a.pos.z, sunDir.x, sunDir.y, sunDir.z));
        }
        // gait phase: cycles = distance / (stride × body length)
        if (dSim > 0) {
          const o = st.odo[id] + (a.moveSpeed * dSim) / (b.stride * b.len);
          st.odo[id] = o - Math.floor(o);
          const k = Math.min(1, dSim * 10);
          const target = Math.min(1, a.moveSpeed / 2.2);
          st.spd[id] += (target - st.spd[id]) * k;
          st.carry[id] += ((a.carrying ? 1 : 0) - st.carry[id]) * k;
        }
        if (id === fpId) {
          lodScratch[i] = 255;
          continue;
        }
        const zc = culler.depthIfVisible(a.pos.x, a.pos.y, a.pos.z, b.len * 2.5);
        if (zc < 0) {
          lodScratch[i] = 255;
          continue;
        }
        const dist = culler.dist(a.pos.x, a.pos.y, a.pos.z);
        distScratch[i] = dist;
        const px = (b.len * culler.pxScale) / zc;
        let lod = px > HIGH_PX ? 0 : px > MED_PX ? 1 : 2;
        if (id === possessed) lod = 0;
        else if (lod === 0 && high >= MAX_HIGH) lod = 1;
        if (lod < 2 && detailed >= maxDetailed && id !== possessed) lod = 2;
        if (lod === 0) high++;
        if (lod < 2) detailed++;
        lodScratch[i] = lod;
        b.need[lod]++;
      }

      // amortised sun-exposure refresh (ants walk in and out of tunnels)
      const refresh = Math.min(n, 48);
      for (let k = 0; k < refresh; k++) {
        sunCursor = (sunCursor + 1) % n;
        const a = ants[sunCursor];
        if (!a.alive || a.id >= st.cap) continue;
        const e = Math.max(slab ? 0.7 : 0, sunExposure(world, a.pos.x, a.pos.y, a.pos.z, sunDir.x, sunDir.y, sunDir.z));
        st.sun[a.id] += (e - st.sun[a.id]) * 0.5;
      }

      for (let i = 0; i < bucketList.length; i++) {
        const b = bucketList[i];
        b.n.fill(0);
        for (let l = 0; l < 3; l++) if (b.need[l] > 0) lodMesh(ctx, b, l as GeometryLod, b.need[l]);
      }

      // ---- pass 2: write instances ----------------------------------------------------------
      const playerColony = sim.playerColony;
      const hover = view.hoverId;
      const tick = frame.tick;
      let nCrown = 0;
      prev = null;
      prevBucket = null;
      for (let i = 0; i < n; i++) {
        const lod = lodScratch[i];
        if (lod === 255) continue;
        const a = ants[i];
        const id = a.id;
        const b: CasteBuckets = prev && prev.species === a.species && prev.caste === a.caste ? prevBucket! : buckets.get(a.species + ':' + a.caste)!;
        prev = a;
        prevBucket = b;
        const m = b.lods[lod]!;
        const j = b.n[lod]++;
        const ex = farScale(view, distScratch[i]);
        writeMoverMatrix(a, alpha, b.len * ex, m.matrix, j * 16, (ex - 1) * a.rideHeight);
        const anim = a.anim;
        const mem = a.mem;
        const c4 = j * 4;
        // pose channel: grapple cling (crouched, tugging), rafting (splayed, low in the water), glue
        let poseX = 0;
        let stuck = 0;
        const latchT = mem[LATCH_UNTIL];
        const latched = latchT !== undefined && latchT > tick && !!mem[LATCH_ID];
        // grapple cling: latchers are drawn hanging on the victim's body (the sim keeps them in one
        // bite-range clump on the ground) — eased in/out so nobody teleports
        {
          const target = st.cling[id] > 0.004 || latched ? sim.getEntity(mem[LATCH_ID]) : undefined;
          // (never the possessed ant: the camera and its ring follow the sim pose)
          const want = latched && id !== possessed && target && target.kind === 'creature' && target.alive ? 1 : 0;
          if (dSim > 0) st.cling[id] += (want - st.cling[id]) * Math.min(1, dSim * (want ? 7 : 4));
          const k = st.cling[id];
          if (k > 0.004 && target && target.kind === 'creature') clingTo(m.matrix, j * 16, target as Readonly<Creature>, id, k, b.len * ex);
        }
        if (latched) {
          poseX = 0.8;
          const o = j * 16;
          const tug = 0.05 * Math.sin(clock * 13 + a.phase * 6.283) + 0.02 * Math.sin(clock * 31 + a.phase * 17);
          m.matrix[o + 12] += m.matrix[o + 8] * tug;
          m.matrix[o + 13] += m.matrix[o + 9] * tug;
          m.matrix[o + 14] += m.matrix[o + 10] * tug;
        } else if (anim === 'raft') {
          poseX = -1;
          const o = j * 16;
          const bobY = -0.1 + 0.015 * Math.sin(clock * 2.1 + a.phase * 6.283);
          m.matrix[o + 12] += m.matrix[o + 4] * bobY;
          m.matrix[o + 13] += m.matrix[o + 5] * bobY;
          m.matrix[o + 14] += m.matrix[o + 6] * bobY;
        }
        const glueT = mem[GLUED];
        if (glueT !== undefined && glueT > tick) stuck = Math.min(1, 0.75 + (glueT - tick) / 90);
        else if (fxGlueAt.size > 0) stuck = 0.44 * fxGlueLevel(id); // lingering coat, gait not frozen
        m.d[c4] = poseX;
        m.d[c4 + 1] = 0;
        m.d[c4 + 2] = 0;
        // B2 fungus: an erratic ant convulsing on the spot (`fz.conv`) whips its body; glue wins
        m.d[c4 + 3] = stuck > 0 ? -stuck : a.mem['fz.conv'] === 1 ? 0.55 : 0;
        if (a.caste === 'queen' && a.colony === playerColony && nCrown < CROWN_MAX) {
          const o = j * 16;
          const k = nCrown++ * 4;
          const h = b.len * ex * 0.42;
          crownPos[k] = m.matrix[o + 12] + (m.matrix[o + 4] / (b.len * ex)) * h;
          crownPos[k + 1] = m.matrix[o + 13] + (m.matrix[o + 5] / (b.len * ex)) * h;
          crownPos[k + 2] = m.matrix[o + 14] + (m.matrix[o + 6] / (b.len * ex)) * h;
          crownPos[k + 3] = a.phase;
        }

        // albedo: species colour × per-ant variation, rivals pulled towards their colony tint
        const ph = a.phase;
        const v = 0.78 + 0.44 * ph;
        const hue = ((ph * 7.31) % 1) - 0.5;
        let r = b.color[0] * v * (1 + 0.12 * hue);
        let g = b.color[1] * v;
        let bl = b.color[2] * v * (1 - 0.12 * hue);
        let mr = 0;
        let mg = 0;
        let mb = 0;
        if (marked) {
          const col = sim.getColony(a.colony);
          if (col) {
            mr = col.color[0];
            mg = col.color[1];
            mb = col.color[2];
            if (a.colony !== playerColony) {
              // rivals: marker colour ×2 flags them for the shader (tinted cuticle, rim, bigger dots)
              r = r * 0.8 + mr * 0.04;
              g = g * 0.8 + mg * 0.04;
              bl = bl * 0.8 + mb * 0.04;
              // a rival whose colony tint matches its species' own colour (red fire ants under a red
              // banner) would be indistinguishable from ours: paint it dark instead, the rim keeps the tint
              const cl = Math.hypot(b.color[0], b.color[1], b.color[2]) * Math.hypot(mr, mg, mb) || 1;
              const same = (b.color[0] * mr + b.color[1] * mg + b.color[2] * mb) / cl;
              if (same > 0.9 && b.color[0] + b.color[1] + b.color[2] > 0.25) {
                const dk = 0.22 + 0.5 * Math.max(0, 1 - (same - 0.9) * 10);
                const lum = (r + g + bl) / 3;
                r = (r * 0.6 + lum * 0.4) * dk;
                g = (g * 0.6 + lum * 0.4) * dk;
                bl = (bl * 0.6 + lum * 0.4) * dk + 0.01;
              }
              mr *= 2;
              mg *= 2;
              mb *= 2;
            }
          }
        }
        const c3 = j * 3;
        m.color[c3] = r;
        m.color[c3 + 1] = g;
        m.color[c3 + 2] = bl;

        m.a[c4] = st.odo[id];
        m.a[c4 + 1] = st.spd[id];
        m.a[c4 + 2] = ph;
        m.a[c4 + 3] = st.sun[id];

        // bite envelope: jaws swing open, then snap shut
        const since = clock - st.biteAt[id];
        let bite = since < 0.11 ? since / 0.11 : since < 0.2 ? 1 - (since - 0.11) / 0.09 : 0;
        let curl = 0;
        if (anim === 'bite') bite = Math.max(bite, 0.5 + 0.5 * Math.sin(clock * 16 + ph * 6.28));
        else if (anim === 'dig') bite = Math.max(bite, 0.3 + 0.3 * Math.sin(clock * 11 + ph * 6.28));
        else if (anim === 'feed') bite = Math.max(bite, 0.18);
        else if (anim === 'fly') curl = -1;
        else if (anim === 'grip') curl = 0.08;
        m.b[c4] = bite;
        m.b[c4 + 1] = anim === 'carry' ? Math.max(st.carry[id], 0.6) : st.carry[id];
        m.b[c4 + 2] = curl;
        m.b[c4 + 3] = infectionAmount(a);

        const hurt = clock - st.hurtAt[id];
        m.c[c4] = mr;
        m.c[c4 + 1] = mg;
        m.c[c4 + 2] = mb;
        m.c[c4 + 3] = hurt < 0.25 ? -(1 - hurt / 0.25) : id === hover ? 0.85 : selected.has(id) ? 0.22 : 0;
      }

      let d0 = 0;
      let d1 = 0;
      let d2 = 0;
      for (let i = 0; i < bucketList.length; i++) {
        const b = bucketList[i];
        for (let l = 0; l < 3; l++) {
          const m = b.lods[l];
          if (!m) continue;
          m.commit(b.n[l]);
          if (b.n[l] > 0) getChitinMaterials(b.kind, ctx.uniforms).uniforms.uMark.value.w = marked ? 1 : 0;
        }
        d0 += b.n[0];
        d1 += b.n[1];
        d2 += b.n[2];
      }
      antsRuntime.drawn[0] = d0;
      antsRuntime.drawn[1] = d1;
      antsRuntime.drawn[2] = d2;
      if (crown) updateCrown(ctx, crown, nCrown);

      // ---- first-person rig: own antennae + mandibles, attached to the camera -------------
      let activeRig: InstancedCreature | null = null;
      if (fpId) {
        const a = sim.getAnt(fpId);
        if (a && a.alive) {
          const b = bucketFor(ctx, a.species, a.caste);
          const rig = fpRigFor(ctx, b.kind);
          activeRig = rig;
          const f = cam.forward;
          const u = cam.up;
          const s = b.len;
          const mtx = rig.matrix;
          // X = up × forward
          mtx[0] = (u.y * f.z - u.z * f.y) * s;
          mtx[1] = (u.z * f.x - u.x * f.z) * s;
          mtx[2] = (u.x * f.y - u.y * f.x) * s;
          mtx[3] = 0;
          mtx[4] = u.x * s;
          mtx[5] = u.y * s;
          mtx[6] = u.z * s;
          mtx[7] = 0;
          mtx[8] = f.x * s;
          mtx[9] = f.y * s;
          mtx[10] = f.z * s;
          mtx[11] = 0;
          // the rig's origin is the eye
          mtx[12] = cam.pos.x;
          mtx[13] = cam.pos.y;
          mtx[14] = cam.pos.z;
          mtx[15] = 1;
          const id = a.id;
          rig.color[0] = b.color[0];
          rig.color[1] = b.color[1];
          rig.color[2] = b.color[2];
          const since = clock - st.biteAt[id];
          let bite = since < 0.11 ? since / 0.11 : since < 0.2 ? 1 - (since - 0.11) / 0.09 : 0;
          if (a.anim === 'bite') bite = Math.max(bite, 0.5 + 0.5 * Math.sin(clock * 16));
          else if (a.anim === 'dig') bite = Math.max(bite, 0.3 + 0.3 * Math.sin(clock * 11));
          rig.a[0] = st.odo[id];
          rig.a[1] = st.spd[id];
          rig.a[2] = a.phase;
          rig.a[3] = st.sun[id];
          rig.b[0] = bite;
          rig.b[1] = st.carry[id] * 0.3;
          rig.b[2] = 0;
          rig.b[3] = infectionAmount(a);
          rig.c[0] = rig.c[1] = rig.c[2] = rig.c[3] = 0;
          rig.d[0] = rig.d[1] = rig.d[2] = rig.d[3] = 0;
          rig.commit(1);
        }
      }
      for (const rig of fpRigs.values()) if (rig !== activeRig) rig.commit(0);
    },

    /** Renderer pre-warm hook: the first-person rig of the player's species exists (hidden) from frame 1. */
    prewarm(ctx: RenderContext): (() => void) | void {
      const col = ctx.sim.getColony(ctx.sim.playerColony);
      if (!col) return;
      const rig = fpRigFor(ctx, bucketFor(ctx, col.species, 'worker').kind);
      rig.commit(1);
      return () => rig.commit(0);
    },

    dispose() {
      for (const b of bucketList) for (const m of b.lods) m?.dispose();
      for (const rig of fpRigs.values()) rig.dispose();
      if (crown) {
        crown.removeFromParent();
        crown.geometry.dispose();
        (crown.material as THREE.Material).dispose();
        crown = null;
      }
      buckets.clear();
      bucketList.length = 0;
      fpRigs.clear();
      if (antsRuntime.ctx) disposeChitinMaterials(antsRuntime.ctx.uniforms);
      antsRuntime.ctx = null;
    },
  };
}

export const antsModule: Module = createAntsModule();

// ---------------------------------------------------------------------------------------------
// Helpers for the sibling A4 modules (brood, items) and B4
// ---------------------------------------------------------------------------------------------

const mouthCache = new Map<string, readonly [number, number, number]>();
const carrierMatrix = new Float32Array(16);

/**
 * Matrix for something held in an ant's mandibles: `scale` in world units, offset from the
 * mouth in body lengths (dy up, dz forward), then pitch/yaw of the held thing. Follows the far-zoom
 * exaggeration of the carrier. Returns the carrier's drawn body length.
 */
export function writeCarriedMatrix(carrier: Readonly<Ant>, alpha: number, view: Readonly<ViewState>, scale: number, dy: number, dz: number, pitch: number, yaw: number, out: Float32Array | number[], offset: number): number {
  const key = carrier.species + ':' + carrier.caste;
  let mouth = mouthCache.get(key);
  if (!mouth) {
    const modelled: CasteId = SPECIES_CASTES[carrier.species].includes(carrier.caste) ? carrier.caste : 'worker';
    mouth = getCreatureRig(`${carrier.species}:${modelled}` as CreatureGeometryKind, 2).mouth;
    mouthCache.set(key, mouth);
  }
  const len = writeAntBodyMatrix(carrier, alpha, view, carrierMatrix, 0);
  const ex = len / getCaste(carrier.species, carrier.caste).length;
  // the head is raised while carrying (shader: −0.42 rad about the neck) → lift the grip point
  writeAttachedMatrix(carrierMatrix, 0, mouth[0], mouth[1] + 0.06 + dy, mouth[2] - 0.02 + dz, pitch, yaw, scale * ex, out, offset);
  return len;
}

/**
 * A kind drawn at two LODs with per-frame counts — the small sibling of the ant buckets, for
 * brood, items and food piles. `begin(max)` → `add(near)` returns the slot index in `cur` → `end()`.
 */
export class CreatureBatch {
  readonly near: InstancedCreature;
  readonly far: InstancedCreature;
  cur: InstancedCreature;
  private nNear = 0;
  private nFar = 0;

  constructor(ctx: RenderContext, kind: CreatureGeometryKind, nearLod: GeometryLod = 1, idle = 0) {
    this.near = createInstancedCreature(kind, nearLod, 8, ctx.uniforms, { idle });
    this.far = createInstancedCreature(kind, 2, 8, ctx.uniforms, { idle });
    ctx.scene.add(this.near.mesh, this.far.mesh);
    this.cur = this.near;
  }

  begin(max: number): void {
    this.nNear = 0;
    this.nFar = 0;
    if (max > this.near.capacity) {
      const parent = this.near.mesh.parent;
      this.near.ensure(max);
      this.far.ensure(max);
      parent?.add(this.near.mesh, this.far.mesh);
    }
  }

  /** Reserves a slot; write `this.cur.matrix/color/a/b/c` at the returned index. −1 when full. */
  add(near: boolean): number {
    this.cur = near ? this.near : this.far;
    if (near) return this.nNear < this.near.capacity ? this.nNear++ : -1;
    return this.nFar < this.far.capacity ? this.nFar++ : -1;
  }

  end(): void {
    this.near.commit(this.nNear);
    this.far.commit(this.nFar);
  }

  dispose(): void {
    this.near.dispose();
    this.far.dispose();
  }
}

/** Body ellipse (fractions of creature length) latchers hang on: along, across, height, back-shift. */
const CLING_SHAPE: Readonly<Record<string, readonly [number, number, number, number]>> = {
  jumpingSpider: [0.3, 0.24, 0.17, 0.05],
  groundBeetle: [0.34, 0.19, 0.13, 0.02],
  wasp: [0.3, 0.1, 0.08, 0.05],
  mantis: [0.26, 0.05, 0.1, 0.12],
  caterpillar: [0.4, 0.12, 0.1, 0],
  worm: [0.42, 0.07, 0.06, 0],
  antlion: [0.26, 0.2, 0.08, 0],
};
const CLING_DEFAULT: readonly [number, number, number, number] = [0.3, 0.2, 0.12, 0];

/**
 * Moves an ant instance (matrix at `m[o..]`, uniform scale `scale`) by `k` 0..1 from its sim pose
 * onto a deterministic slot on the creature's flank: feet on the body, head up, like a climber.
 */
function clingTo(m: Float32Array, o: number, c: Readonly<Creature>, id: number, k: number, scale: number): void {
  const sh = CLING_SHAPE[c.def] ?? CLING_DEFAULT;
  const len = getCreature(c.def).length;
  const h1 = ((id * 2654435761) >>> 0) / 4294967296;
  const h2 = ((id * 40503 + 977) % 1009) / 1009;
  const th = h1 * 6.2832;
  const ct = Math.cos(th);
  const sn = Math.sin(th);
  const ux = c.up.x, uy = c.up.y, uz = c.up.z;
  let fx = c.forward.x, fy = c.forward.y, fz = c.forward.z;
  const d = fx * ux + fy * uy + fz * uz;
  fx -= ux * d; fy -= uy * d; fz -= uz * d;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  const rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
  const a = (sh[0] * ct - sh[3]) * len;
  const bb = sh[1] * sn * len;
  const hh = sh[2] * len * (0.55 + 0.75 * h2);
  const px = c.pos.x + fx * a + rx * bb + ux * hh;
  const py = c.pos.y + fy * a + ry * bb + uy * hh;
  const pz = c.pos.z + fz * a + rz * bb + uz * hh;
  // outward normal of the ellipse, tipped up; ant head points up the flank
  let nx = fx * ct * sh[1] + rx * sn * sh[0];
  let ny = fy * ct * sh[1] + ry * sn * sh[0];
  let nz = fz * ct * sh[1] + rz * sn * sh[0];
  let l = Math.hypot(nx, ny, nz) || 1;
  const tip = 0.35 + 0.5 * h2;
  nx = nx / l + ux * tip; ny = ny / l + uy * tip; nz = nz / l + uz * tip;
  l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  // forward = creature up projected off the ant's up (climbing), slightly skewed per ant
  const skew = (h2 - 0.5) * 0.9;
  let gx = ux + (fx * -sn + rx * ct) * skew, gy = uy + (fy * -sn + ry * ct) * skew, gz = uz + (fz * -sn + rz * ct) * skew;
  const gd = gx * nx + gy * ny + gz * nz;
  gx -= nx * gd; gy -= ny * gd; gz -= nz * gd;
  l = Math.hypot(gx, gy, gz) || 1;
  gx /= l; gy /= l; gz /= l;
  const sx = ny * gz - nz * gy, sy = nz * gx - nx * gz, sz = nx * gy - ny * gx;
  const j = 1 - k;
  // blend basis (renormalised to the instance scale) and position
  const blend = (i: number, x: number, y: number, z: number): void => {
    let bx = m[o + i] * j + x * scale * k;
    let by = m[o + i + 1] * j + y * scale * k;
    let bz = m[o + i + 2] * j + z * scale * k;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx *= scale / bl; by *= scale / bl; bz *= scale / bl;
    m[o + i] = bx; m[o + i + 1] = by; m[o + i + 2] = bz;
  };
  blend(0, sx, sy, sz);
  blend(4, nx, ny, nz);
  blend(8, gx, gy, gz);
  m[o + 12] = m[o + 12] * j + px * k;
  m[o + 13] = m[o + 13] * j + py * k;
  m[o + 14] = m[o + 14] * j + pz * k;
}
