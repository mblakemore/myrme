import { b3StateOf, COMBAT_MEM, CREATURE_MEM, creatureAnim, type AnySimEvent, type Creature, type CreatureGeometryKind, type CreatureId, type FrameInfo, type GeometryLod } from '../../core';
import { getCreature } from '../../sim/data/creatures';
import type { Module, RenderContext } from '../shared';
import { antsRuntime } from './ants';
import { createInstancedCreature, getChitinMaterials, type InstancedCreature } from './antsMaterial';
import { antState, farScale, pitchMatrix, rollMatrix, sunExposure, writeAttachedMatrix, writeMoverMatrix } from './antsShared';
import { particles } from './particles';
import { fxGlueAt, fxGlueLevel } from './fxShared';

/**
 * Predators, prey and livestock (§7): jumping spider, antlion, ground beetle, parasitic wasp,
 * mantis, aphids, caterpillar, worm. A4's geometry + chitin material, instanced per kind × LOD,
 * pose interpolated between ticks (D13), culled / LOD-ed / cut like the ants.
 *
 * What is read from the sim (all read-only):
 *   Creature.{def, pos/prevPos/up/forward (Pose), moveSpeed, phase, state, targetId, alive, mem}
 *   B1 `creatureAnim(c, tick)` → idle | walk | stalk | pounce | attack | eat | carry | flee |
 *     hidden | thrash | fly | stuck | dead, built from `CREATURE_MEM` (c.hide, c.atk, c.pounce,
 *     c.eat, c.thrash, c.carry) and `COMBAT_MEM` (st.glued, st.stun, gr.pin, hit.t)
 *   events `attack` (attacker = creature → strike envelope; also `mem['c.atk']`) and `damage`
 *     (target = creature → red hurt flash; also `mem['hit.t']`), collected by the ants module
 *   aphids: B3 `b3StateOf(sim).herds[]` (`aphids` ids, `tended`, `owner`) + the B3 `aphid`
 *     event (`op:'milked'`, `herd`) → a honeydew bead swells at the cornicles of a tended herd
 *     and flashes full when an ant milks it (`mem['honeydew']` 0..1 also honoured if present)
 *
 * Per-kind animation (shader pose channel `aInstD`, see antsMaterial.ts):
 *   spider   8-leg gait · crouch while stalking · pounce = lunge with raised front legs, nose
 *            down · pedipalps always twitching · prey in the fangs while carrying
 *   antlion  buried to the jaws while hidden (sunk + tilted back), sand flicks at passers-by,
 *            erupts and snaps on attack
 *   beetle   heavy lumber (slow roll with the gait)
 *   wasp     wings spread + beating, hover bob, banks into its velocity, dives on a swoop
 *   mantis   slow sway, head tracks the target, raptorial arms strike (+ lunge)
 *   caterpillar / worm   peristaltic crawl, sideways thrash when attacked
 *   aphid    far-zoom boost like ants, honeydew bead at the cornicles while being milked
 *   any      glued → frozen gait + stringy pale coat; stunned / pinned → frozen
 * Dead creatures are removed by the sim and leave a corpse item — drawn by the items module
 * with the creature's own mesh in the death pose.
 */

const HIGH_PX = 260;
const MED_PX = 46;

interface Kind {
  id: CreatureId;
  len: number;
  stride: number;
  color: readonly [number, number, number];
  lods: (InstancedCreature | null)[];
  need: Int32Array;
  n: Int32Array;
}

/** Per-creature smoothed render state, indexed by entity id. */
class PoseStore {
  cap = 0;
  crouch = new Float32Array(0);
  yaw = new Float32Array(0);
  bury = new Float32Array(0);
  flick = new Float32Array(0);
  dew = new Float32Array(0);
  dewT = new Float32Array(0);
  ensure(id: number): void {
    if (id < this.cap) return;
    const cap = Math.max(256, Math.ceil((id + 1) * 1.5));
    const grow = (old: Float32Array, fill: number): Float32Array<ArrayBuffer> => {
      const a = new Float32Array(cap);
      if (fill !== 0) a.fill(fill, old.length);
      a.set(old);
      return a;
    };
    this.crouch = grow(this.crouch, 0);
    this.yaw = grow(this.yaw, 0);
    this.bury = grow(this.bury, -1);
    this.flick = grow(this.flick, 0);
    this.dew = grow(this.dew, 0);
    this.dewT = grow(this.dewT, 0);
    this.cap = cap;
  }
  reset(): void {
    this.cap = 0;
    this.crouch = new Float32Array(0);
    this.yaw = new Float32Array(0);
    this.bury = new Float32Array(0);
    this.flick = new Float32Array(0);
    this.dew = new Float32Array(0);
    this.dewT = new Float32Array(0);
  }
}

const DEW_KEYS = ['honeydew', 'a.dew', 'milk', 'aphid.dew'] as const;
const tmpM = new Float32Array(16);
const pv = { x: 0, y: 0, z: 0 };
const nv = { x: 0, y: 1, z: 0 };

export function createCreaturesModule(): Module {
  const kinds = new Map<CreatureId, Kind>();
  const kindList: Kind[] = [];
  const pose = new PoseStore();
  let lodScratch = new Uint8Array(0);
  let dew: InstancedCreature | null = null;
  let prey: InstancedCreature | null = null;
  let sunCursor = 0;
  const milkedAt = new Map<number, number>();

  function kindFor(ctx: RenderContext, id: CreatureId): Kind {
    let k = kinds.get(id);
    if (k) return k;
    const probe = createInstancedCreature(id, 2, 8, ctx.uniforms);
    ctx.scene.add(probe.mesh);
    k = { id, len: getCreature(id).length, stride: probe.rig.stride, color: probe.look.color, lods: [null, null, probe], need: new Int32Array(3), n: new Int32Array(3) };
    kinds.set(id, k);
    kindList.push(k);
    // presence: the boss gets a stronger camera-facing rim so it separates from the foliage
    if (id === 'mantis') getChitinMaterials(id, ctx.uniforms).uniforms.uSurf.value.w = 0.95;
    else if (id === 'jumpingSpider' || id === 'groundBeetle') getChitinMaterials(id, ctx.uniforms).uniforms.uSurf.value.w = 0.6;
    return k;
  }

  function lodMesh(ctx: RenderContext, k: Kind, lod: GeometryLod, need: number): InstancedCreature {
    let m = k.lods[lod];
    if (!m) {
      m = createInstancedCreature(k.id, lod, Math.max(need, 4), ctx.uniforms);
      ctx.scene.add(m.mesh);
      k.lods[lod] = m;
    } else if (need > m.capacity) m.ensure(need);
    return m;
  }

  return {
    id: 'creatures',
    init() {
      pose.reset();
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      const sim = ctx.sim;
      const list = sim.creatures;
      const n = list.length;
      if (n === 0 && kindList.length === 0) return;
      const view = ctx.view;
      const culler = antsRuntime.culler;
      const clock = antsRuntime.clock;
      const dSim = antsRuntime.dSim;
      const alpha = frame.alpha;
      const tick = frame.tick;
      const tickF = tick + alpha;
      const st = antState;
      const world = sim.world;
      const sunDir = ctx.uniforms.uSunDir.value;
      const slab = ctx.map.flags.slab;
      const smooth = dSim > 0 ? Math.min(1, dSim * 7) : ctx.sync ? 1 : 0;

      // ---- aphid herds (B3): which aphids carry a honeydew bead ----
      const herds = b3StateOf(sim).herds;
      if (herds.length > 0) {
        const evs = frame.events as readonly AnySimEvent[];
        for (let i = 0; i < evs.length; i++) {
          const e = evs[i];
          if (e.type === 'aphid' && e.op === 'milked') milkedAt.set(e.herd, clock);
        }
        for (let h = 0; h < herds.length; h++) {
          const herd = herds[h];
          const since = clock - (milkedAt.get(herd.id) ?? -1e6);
          const level = since < 1.6 ? 1 - 0.4 * (since / 1.6) : herd.tended ? 0.55 : herd.owner ? 0.2 : 0;
          const ids = herd.aphids;
          for (let q = 0; q < ids.length; q++) {
            const id = ids[q];
            if (id >= pose.cap) pose.ensure(id);
            pose.dewT[id] = level;
          }
        }
      }

      if (lodScratch.length < n) lodScratch = new Uint8Array(Math.ceil(n * 1.5) + 8);
      for (let i = 0; i < kindList.length; i++) kindList[i].need.fill(0);

      // ---- pass 1: cull + LOD ---------------------------------------------------------------
      let nDew = 0;
      let nPrey = 0;
      for (let i = 0; i < n; i++) {
        const c = list[i];
        if (!c.alive) {
          lodScratch[i] = 255;
          continue;
        }
        const k = kindFor(ctx, c.def);
        const id = c.id;
        if (id >= st.cap) st.ensure(id);
        if (id >= pose.cap) pose.ensure(id);
        if (st.sun[id] < 0) {
          st.odo[id] = c.phase;
          st.spd[id] = 0;
          st.sun[id] = Math.max(slab ? 0.7 : 0, sunExposure(world, c.pos.x, c.pos.y + k.len * 0.2, c.pos.z, sunDir.x, sunDir.y, sunDir.z));
        }
        if (dSim > 0) {
          const o = st.odo[id] + (c.moveSpeed * dSim) / (k.stride * k.len);
          st.odo[id] = o - Math.floor(o);
          st.spd[id] += (Math.min(1, c.moveSpeed / Math.max(0.3, c.speed)) - st.spd[id]) * Math.min(1, dSim * 8);
        }
        const zc = culler.depthIfVisible(c.pos.x, c.pos.y, c.pos.z, k.len * 1.6);
        if (zc < 0) {
          lodScratch[i] = 255;
          continue;
        }
        const px = (k.len * culler.pxScale) / zc;
        const lod = px > HIGH_PX ? 0 : px > MED_PX ? 1 : 2;
        lodScratch[i] = lod;
        k.need[lod]++;
        if (c.def === 'aphid') nDew++;
        else if (c.mem[CREATURE_MEM.carrying] === 1) nPrey++;
      }
      // amortised sun refresh
      if (n > 0) {
        sunCursor = (sunCursor + 1) % n;
        const c = list[sunCursor];
        if (c.alive && c.id < st.cap) {
          const e = Math.max(slab ? 0.7 : 0, sunExposure(world, c.pos.x, c.pos.y + getCreature(c.def).length * 0.2, c.pos.z, sunDir.x, sunDir.y, sunDir.z));
          st.sun[c.id] += (e - st.sun[c.id]) * 0.5;
        }
      }
      for (let i = 0; i < kindList.length; i++) {
        const k = kindList[i];
        k.n.fill(0);
        for (let l = 0; l < 3; l++) if (k.need[l] > 0) lodMesh(ctx, k, l as GeometryLod, k.need[l]);
      }
      if (nDew > 0) {
        if (!dew) {
          dew = createInstancedCreature('honeydew', 1, Math.max(16, nDew), ctx.uniforms, { idle: 0 });
          dew.mesh.castShadow = false;
          ctx.scene.add(dew.mesh);
        } else dew.ensure(nDew);
      }
      if (nPrey > 0) {
        if (!prey) {
          prey = createInstancedCreature(`${sim.options.faction}:worker` as CreatureGeometryKind, 2, Math.max(4, nPrey), ctx.uniforms, { idle: 0 });
          ctx.scene.add(prey.mesh);
        } else prey.ensure(nPrey);
      }
      nDew = 0;
      nPrey = 0;

      // ---- pass 2: instances ------------------------------------------------------------------
      const hover = view.hoverId;
      for (let i = 0; i < n; i++) {
        const lod = lodScratch[i];
        if (lod === 255) continue;
        const c: Readonly<Creature> = list[i];
        const k = kinds.get(c.def)!;
        const m = k.lods[lod]!;
        const j = k.n[lod]++;
        const o = j * 16;
        const id = c.id;
        const ph = c.phase;
        const mem = c.mem;
        const anim = creatureAnim(c, tick);
        const def = c.def;
        const small = def === 'aphid';
        const ex = small ? farScale(view, culler.dist(c.pos.x, c.pos.y, c.pos.z)) : 1;
        const len = k.len * ex * (0.94 + 0.12 * ph);
        writeMoverMatrix(c, alpha, len, m.matrix, o, (ex - 1) * c.rideHeight);

        // strike envelope: event time (render clock) or the sim's attack tick, whichever is fresher
        let sinceAtk = clock - st.biteAt[id];
        const atkTick = mem[CREATURE_MEM.attackTick];
        if (atkTick !== undefined) sinceAtk = Math.min(sinceAtk, Math.max(0, (tickF - atkTick) / 30));
        let sinceHit = clock - st.hurtAt[id];
        const hitTick = mem[COMBAT_MEM.hitTick];
        if (hitTick !== undefined) sinceHit = Math.min(sinceHit, Math.max(0, (tickF - hitTick) / 30));

        const windup = def === 'mantis' ? 0.16 : 0.09;
        const recover = def === 'mantis' ? 0.3 : 0.16;
        let bite = sinceAtk < windup ? sinceAtk / windup : sinceAtk < windup + recover ? 1 - (sinceAtk - windup) / recover : 0;
        let crouchT = 0;
        let strike = 0;
        let headYaw = 0;
        let thrash = 0;
        let fly = 0;
        let spd = st.spd[id];

        const glued = (mem[COMBAT_MEM.glued] ?? 0) > tick;
        const stuck = anim === 'stuck';

        switch (def) {
          case 'jumpingSpider': {
            if (anim === 'stalk') crouchT = 0.85;
            else if (anim === 'eat') crouchT = 0.5;
            if (anim === 'pounce') {
              const until = mem[CREATURE_MEM.pounceUntil] ?? tick;
              const left = Math.max(0, until - tickF) / 30;
              strike = Math.min(1, 0.55 + left * 2);
              pitchMatrix(m.matrix, o, -0.22);
              crouchT = 0;
            }
            strike = Math.max(strike, bite * 0.8);
            if (anim === 'eat') bite = Math.max(bite, 0.3 + 0.3 * Math.sin(clock * 9 + ph * 6));
            break;
          }
          case 'antlion': {
            // buried to the jaws: sunk into the sand and tilted back so only the sickles show
            const hiddenT = anim === 'hidden' || c.state === 'ambush' ? 1 : anim === 'attack' || anim === 'eat' ? 0.25 : 0.55;
            if (pose.bury[id] < 0) pose.bury[id] = hiddenT;
            else pose.bury[id] += (hiddenT - pose.bury[id]) * Math.min(1, smooth * 1.6);
            const erupt = bite;
            const bury = pose.bury[id] * (1 - 0.75 * erupt);
            // height of the body centre over the real surface (static creatures do not ride it)
            const sd = world.sample(c.pos.x, c.pos.y, c.pos.z);
            const cur = sd > -1.9 && sd < 1.5 ? -sd : c.rideHeight;
            const sink = len * (0.2 - 0.3 * bury) - cur;
            pitchMatrix(m.matrix, o, 0.1 + 0.34 * bury - 0.15 * erupt);
            const ux = c.up.x;
            const uy = c.up.y;
            const uz = c.up.z;
            m.matrix[o + 12] += ux * sink;
            m.matrix[o + 13] += uy * sink;
            m.matrix[o + 14] += uz * sink;
            strike = erupt * 0.7;
            // jaws held wide open while waiting
            bite = Math.max(bite, anim === 'hidden' ? 0.42 + 0.06 * Math.sin(clock * 1.3 + ph * 9) : 0.2);
            // sand flick: something is in the pit (target) → sprays every ~0.9 s; idle → rarely
            if (dSim > 0 && anim !== 'stuck') {
              pose.flick[id] -= dSim;
              if (pose.flick[id] <= 0) {
                const hunting = c.targetId !== 0;
                pose.flick[id] = hunting ? 0.7 + 0.5 * ph : 4 + 5 * ph;
                if (hunting || pose.bury[id] > 0.8) {
                  pv.x = c.pos.x + c.forward.x * len * 0.3;
                  pv.y = c.pos.y + c.forward.y * len * 0.3 + 0.05;
                  pv.z = c.pos.z + c.forward.z * len * 0.3;
                  nv.x = c.forward.x * 0.9 + c.up.x;
                  nv.y = c.forward.y * 0.9 + c.up.y;
                  nv.z = c.forward.z * 0.9 + c.up.z;
                  particles.emitCustom('sandFlick', pv, nv, { count: hunting ? 14 : 6, speed: hunting ? 1 : 0.6 });
                  bite = Math.max(bite, 0.75);
                }
              }
            }
            spd = 0;
            break;
          }
          case 'groundBeetle': {
            // heavy lumber: the whole hull rolls with the stride
            rollMatrix(m.matrix, o, 0.045 * Math.sin(st.odo[id] * 6.2832) * spd);
            if (anim === 'eat') bite = Math.max(bite, 0.35 + 0.3 * Math.sin(clock * 7 + ph * 6));
            break;
          }
          case 'wasp': {
            const airborne = anim === 'fly' || anim === 'carry' || anim === 'pounce' || anim === 'attack' || anim === 'flee' || (c.locomotion === 'fly' && !stuck);
            if (airborne) {
              fly = 1;
              // bank into the vertical velocity, dive hard on a swoop
              const vy = (c.pos.y - c.prevPos.y) * 30;
              let pitch = Math.max(-0.7, Math.min(0.5, vy * 0.12)) - 0.12;
              if (anim === 'pounce') pitch -= 0.45;
              pitchMatrix(m.matrix, o, pitch);
              rollMatrix(m.matrix, o, 0.1 * Math.sin(clock * 2.3 + ph * 20));
              const bob = len * (0.035 * Math.sin(clock * 5.1 + ph * 30) + 0.015 * Math.sin(clock * 11.7 + ph * 7));
              m.matrix[o + 13] += bob;
              spd = 0;
            }
            break;
          }
          case 'mantis': {
            // slow predatory sway, like a leaf in the wind
            const sway = 0.035 * Math.sin(clock * 1.1 + ph * 6) + 0.02 * Math.sin(clock * 0.47 + ph * 13);
            rollMatrix(m.matrix, o, sway * (1 - spd * 0.5));
            let yawT = 0;
            const tgt = c.targetId ? sim.getEntity(c.targetId) : undefined;
            if (tgt) {
              // target direction in the body frame
              const dx = tgt.pos.x - c.pos.x;
              const dy = tgt.pos.y - c.pos.y;
              const dz = tgt.pos.z - c.pos.z;
              const s2 = len * len;
              const rx = (m.matrix[o] * dx + m.matrix[o + 1] * dy + m.matrix[o + 2] * dz) / s2;
              const fz = (m.matrix[o + 8] * dx + m.matrix[o + 9] * dy + m.matrix[o + 10] * dz) / s2;
              yawT = Math.max(-1.1, Math.min(1.1, Math.atan2(rx, Math.max(0.05, fz))));
            } else yawT = 0.35 * Math.sin(clock * 0.31 + ph * 9);
            pose.yaw[id] += (yawT - pose.yaw[id]) * Math.min(1, smooth * 0.8 + (ctx.sync && dSim === 0 ? 1 : 0));
            headYaw = pose.yaw[id];
            strike = bite * 0.55;
            if (anim === 'stalk') crouchT = 0.35;
            if (anim === 'eat') bite = Math.max(bite, 0.25 + 0.2 * Math.sin(clock * 5 + ph * 6));
            break;
          }
          case 'caterpillar':
          case 'worm': {
            if (anim === 'thrash') thrash = 1;
            else if (sinceHit < 0.5) thrash = 1 - sinceHit / 0.5;
            break;
          }
          default:
            break;
        }

        pose.crouch[id] += (crouchT - pose.crouch[id]) * (smooth > 0 ? Math.min(1, smooth * 1.4) : 0);
        if (ctx.sync && dSim === 0 && pose.crouch[id] === 0) pose.crouch[id] = crouchT;

        // albedo with a little per-individual variation
        const v = (0.85 + 0.3 * ph) * (def === 'mantis' ? 0.72 : 1);
        const c3 = j * 3;
        m.color[c3] = k.color[0] * v;
        m.color[c3 + 1] = k.color[1] * v;
        m.color[c3 + 2] = k.color[2] * v * (1.05 - 0.1 * ph);
        const c4 = j * 4;
        m.a[c4] = st.odo[id];
        m.a[c4 + 1] = stuck ? 0 : spd;
        m.a[c4 + 2] = ph;
        m.a[c4 + 3] = st.sun[id];
        m.b[c4] = bite;
        m.b[c4 + 1] = mem[CREATURE_MEM.carrying] === 1 ? 0.6 : 0;
        m.b[c4 + 2] = fly ? -1 : 0;
        m.b[c4 + 3] = 0;
        m.c[c4] = m.c[c4 + 1] = m.c[c4 + 2] = 0;
        // big bodies: a brief rim-weighted flash, not a solid red hull
        m.c[c4 + 3] = sinceHit < 0.22 ? -(1 - sinceHit / 0.22) * (k.len > 2 ? 0.3 : 0.7) : id === hover ? 0.85 : 0;
        m.d[c4] = pose.crouch[id];
        m.d[c4 + 1] = strike;
        m.d[c4 + 2] = headYaw;
        m.d[c4 + 3] = thrash > 0 ? thrash : glued ? -1 : fxGlueAt.size > 0 && fxGlueLevel(id) > 0 ? -0.44 * fxGlueLevel(id) : stuck ? -0.001 : 0;

        // ---- attachments ----
        if (small && dew) {
          // beads swell and are licked off in turn: each aphid on its own slow cycle
          const want = pose.dewT[id] * (0.55 + 0.45 * Math.sin(clock * 0.9 + ph * 40));
          pose.dew[id] += (Math.max(0, want) - pose.dew[id]) * (smooth > 0 ? Math.min(1, smooth * 0.6) : ctx.sync ? 1 : 0);
          let amount = pose.dew[id];
          for (let q = 0; q < DEW_KEYS.length; q++) {
            const val = mem[DEW_KEYS[q]];
            if (val !== undefined) {
              amount = Math.max(amount, val);
              break;
            }
          }
          if (amount > 0.02) {
            const jd = nDew++;
            const size = len * (0.14 + 0.24 * Math.min(1, amount));
            // (local offsets are in model units: the body matrix carries the scale)
            writeAttachedMatrix(m.matrix, o, 0, 0.08, -0.5 - (size / len) * 0.35, 0, 0, size, dew.matrix, jd * 16);
            dew.color[jd * 3] = dew.look.color[0];
            dew.color[jd * 3 + 1] = dew.look.color[1];
            dew.color[jd * 3 + 2] = dew.look.color[2];
            const d4 = jd * 4;
            dew.a[d4] = dew.a[d4 + 1] = 0;
            dew.a[d4 + 2] = ph;
            dew.a[d4 + 3] = st.sun[id];
            dew.b[d4] = dew.b[d4 + 1] = dew.b[d4 + 2] = dew.b[d4 + 3] = 0;
            dew.c[d4] = dew.c[d4 + 1] = dew.c[d4 + 2] = dew.c[d4 + 3] = 0;
          }
        } else if (prey && mem[CREATURE_MEM.carrying] === 1) {
          // a limp ant in the jaws / under the body
          const jp = nPrey++;
          const mouth = m.rig.mouth;
          const pl = 0.7;
          for (let q = 0; q < 16; q++) tmpM[q] = m.matrix[o + q];
          writeAttachedMatrix(tmpM, 0, mouth[0], mouth[1] - 0.02, mouth[2] + 0.02, 1.9, 1.2, pl, prey.matrix, jp * 16);
          prey.color[jp * 3] = prey.look.color[0] * 0.8;
          prey.color[jp * 3 + 1] = prey.look.color[1] * 0.8;
          prey.color[jp * 3 + 2] = prey.look.color[2] * 0.8;
          const p4 = jp * 4;
          prey.a[p4] = prey.a[p4 + 1] = 0;
          prey.a[p4 + 2] = ph;
          prey.a[p4 + 3] = st.sun[id];
          prey.b[p4] = prey.b[p4 + 1] = prey.b[p4 + 3] = 0;
          prey.b[p4 + 2] = 1;
          prey.c[p4] = prey.c[p4 + 1] = prey.c[p4 + 2] = prey.c[p4 + 3] = 0;
          prey.d[p4] = prey.d[p4 + 1] = prey.d[p4 + 2] = prey.d[p4 + 3] = 0;
        }
      }

      for (let i = 0; i < kindList.length; i++) {
        const k = kindList[i];
        for (let l = 0; l < 3; l++) k.lods[l]?.commit(k.n[l]);
      }
      dew?.commit(nDew);
      prey?.commit(nPrey);
    },

    dispose() {
      for (const k of kindList) for (const m of k.lods) m?.dispose();
      kinds.clear();
      kindList.length = 0;
      dew?.dispose();
      prey?.dispose();
      dew = prey = null;
      pose.reset();
      milkedAt.clear();
    },
  };
}

export const creaturesModule: Module = createCreaturesModule();
