import { b3StateOf, materialDef, type Ant, type CasteId, type CreatureGeometryKind, type FoodKind, type FrameInfo, type Item, type ItemKind, type SimView, type SpeciesId } from '../../core';
import { CREATURE_IDS, SPECIES_CASTES } from '../../assets/geometry';
import { getCreature } from '../../sim/data/creatures';
import { getCaste } from '../../sim/data/species';
import type { Module, RenderContext } from '../shared';
import { fxReveal } from './fxShared';
import { antsRuntime, CreatureBatch, writeCarriedMatrix } from './ants';
import { antState, farScale, readableScale, rollMatrix, writeAttachedMatrix, writeSurfaceMatrix } from './antsShared';

/**
 * Items, carried loads and food sources (§5.3):
 *  - loose items on the ground (crumbs, seeds, leaf fragments, wood chips, soil/gel pellets,
 *    honeydew drops, fungus tufts) snapped to the surface; they pile up where ants drop them
 *    (granary, midden),
 *  - corpses: the dead ant's OWN mesh (species × caste, resolved from the `antDied` event that
 *    spawned the corpse) curling up and keeling over onto its side over half a second; creature
 *    corpses (`creatureDied`) keep the creature's mesh, slumped belly-down with folded legs,
 *  - carried things attached at the carrier's mandibles — leafcutters hold leaf fragments
 *    overhead like sails; bulk loads (dig spoil, building mud) show as a pellet tinted by the
 *    voxel material,
 *  - food sources drawn as piles / chunks that visibly shrink as `amount` falls.
 */

type BatchKind = 'crumb' | 'seed' | 'leaf' | 'pellet' | 'woodChip' | 'honeydew' | 'fungusTuft' | 'fruit' | 'sugar' | 'caterpillar';

const ITEM_BATCH: Record<ItemKind, BatchKind> = { food: 'crumb', seed: 'seed', leaf: 'leaf', wood: 'woodChip', corpse: 'crumb', debris: 'pellet', honeydew: 'honeydew', fungus: 'fungusTuft' };
const ITEM_SIZE: Record<ItemKind, number> = { food: 0.24, seed: 0.26, leaf: 0.55, wood: 0.4, corpse: 0.7, debris: 0.24, honeydew: 0.2, fungus: 0.32 };
/** How high the item's centre sits above the surface, as a fraction of its size. */
const ITEM_REST: Record<BatchKind, number> = { crumb: 0.3, seed: 0.18, leaf: 0.05, pellet: 0.36, woodChip: 0.07, honeydew: 0.38, fungusTuft: 0.3, fruit: 0.32, sugar: 0.3, caterpillar: 0.22 };

const PILE: Record<FoodKind, { kind: BatchKind; max: number; size: number; color?: readonly [number, number, number] }> = {
  seeds: { kind: 'seed', max: 18, size: 0.26 },
  leaves: { kind: 'leaf', max: 10, size: 0.5 },
  sugar: { kind: 'sugar', max: 18, size: 0.19 },
  honeydew: { kind: 'honeydew', max: 7, size: 0.2 },
  gel: { kind: 'pellet', max: 12, size: 0.3, color: [0.2, 0.55, 0.95] },
  fruit: { kind: 'crumb', max: 6, size: 0.22, color: [0.8, 0.2, 0.15] },
  carcass: { kind: 'crumb', max: 4, size: 0.2, color: [0.35, 0.4, 0.12] },
};

function hash(id: number, k: number): number {
  const s = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

const tmp = new Float32Array(16);

interface CorpseInfo {
  kind: CreatureGeometryKind;
  len: number;
  creature: boolean;
}

/** Recent deaths (ring), matched to the corpse items the sim spawns in the same tick. */
const DEATHS = 64;
const deathTick = new Int32Array(DEATHS).fill(-1);
const deathPos = new Float32Array(DEATHS * 3);
const deathInfo: (CorpseInfo | null)[] = new Array<CorpseInfo | null>(DEATHS).fill(null);
let deathCursor = 0;
const infoCache = new Map<string, CorpseInfo>();

function antCorpse(species: SpeciesId, caste: CasteId): CorpseInfo {
  const key = species + ':' + caste;
  let c = infoCache.get(key);
  if (!c) {
    const modelled: CasteId = SPECIES_CASTES[species].includes(caste) ? caste : 'worker';
    c = { kind: `${species}:${modelled}` as CreatureGeometryKind, len: getCaste(species, caste).length, creature: false };
    infoCache.set(key, c);
  }
  return c;
}
function creatureCorpse(def: (typeof CREATURE_IDS)[number]): CorpseInfo {
  let c = infoCache.get(def);
  if (!c) {
    c = { kind: def, len: getCreature(def).length, creature: true };
    infoCache.set(def, c);
  }
  return c;
}

function resolveCorpse(sim: SimView, it: Readonly<Item>): CorpseInfo {
  let best: CorpseInfo | null = null;
  let bd = 1.5;
  for (let i = 0; i < DEATHS; i++) {
    const info = deathInfo[i];
    if (!info || Math.abs(deathTick[i] - it.bornTick) > 1) continue;
    const d = Math.hypot(deathPos[i * 3] - it.pos.x, deathPos[i * 3 + 1] - it.pos.y, deathPos[i * 3 + 2] - it.pos.z);
    if (d < bd && info.creature === (it.colony === 0 && info.creature)) {
      bd = d;
      best = info;
    }
  }
  if (best) return best;
  // no event seen (corpse older than this renderer): colony species, or the creature whose
  // food value matches the corpse
  const col = sim.getColony(it.colony);
  if (col) return antCorpse(col.species, 'worker');
  if (it.colony === 0) for (const id of CREATURE_IDS) if (Math.abs(getCreature(id).foodValue - it.amount) < 0.5) return creatureCorpse(id);
  return antCorpse(sim.options.faction, 'worker');
}

export function createItemsModule(): Module {
  const batches = new Map<string, CreatureBatch>();
  const order: CreatureBatch[] = [];
  let cap = 64;
  const corpses = new Map<number, CorpseInfo>();
  let sweepAt = 0;

  function batch(ctx: RenderContext, kind: CreatureGeometryKind): CreatureBatch {
    let b = batches.get(kind);
    if (!b) {
      b = new CreatureBatch(ctx, kind, 1, 0);
      batches.set(kind, b);
      order.push(b);
      b.begin(cap);
    }
    return b;
  }

  return {
    id: 'items',
    init() {},
    update(ctx: RenderContext, frame: FrameInfo) {
      const sim = ctx.sim;
      const view = ctx.view;
      const items = sim.items;
      const foods = sim.foodSources;
      const ants = sim.ants;
      const culler = antsRuntime.culler;
      const world = sim.world;
      const alpha = frame.alpha;
      const slab = ctx.map.flags.slab;

      // deaths this frame → what the corpse items spawned in the same tick should look like
      const events = frame.events;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type !== 'antDied' && e.type !== 'creatureDied') continue;
        const k = deathCursor;
        deathCursor = (deathCursor + 1) % DEATHS;
        deathTick[k] = e.tick;
        deathPos[k * 3] = e.pos.x;
        deathPos[k * 3 + 1] = e.pos.y;
        deathPos[k * 3 + 2] = e.pos.z;
        if (e.type === 'antDied') {
          const col = sim.getColony(e.colony);
          deathInfo[k] = antCorpse(col ? col.species : sim.options.faction, e.caste);
        } else deathInfo[k] = creatureCorpse(e.def);
      }
      if (corpses.size > 0 && frame.frame >= sweepAt) {
        sweepAt = frame.frame + 600;
        for (const id of corpses.keys()) if (!sim.getEntity(id)) corpses.delete(id);
      }
      const tickF = frame.tick + alpha;

      // capacity: every batch can hold everything that could map to it this frame
      const maxCount = items.length + foods.length * 20 + 64;
      if (cap < maxCount) cap = maxCount + 128;
      for (let i = 0; i < order.length; i++) order[i].begin(cap);

      const put = (b: CreatureBatch, near: boolean, r: number, g: number, bl: number, seed: number, sun: number, curl: number, infect: number, hl: number): number => {
        const j = b.add(near);
        if (j < 0) return -1;
        const m = b.cur;
        m.color[j * 3] = r;
        m.color[j * 3 + 1] = g;
        m.color[j * 3 + 2] = bl;
        const k = j * 4;
        m.a[k] = seed;
        m.a[k + 1] = 0;
        m.a[k + 2] = seed;
        m.a[k + 3] = sun;
        m.b[k] = 0;
        m.b[k + 1] = 0;
        m.b[k + 2] = curl;
        m.b[k + 3] = infect;
        m.c[k] = m.c[k + 1] = m.c[k + 2] = 0;
        m.c[k + 3] = hl;
        return j;
      };

      const groundSun = (x: number, y: number, z: number): number => (slab ? 0.85 : world.sampleVisual(x, y + 2.5, z) > 0.2 ? 0.2 : 1);

      // ---- loose + carried item entities ------------------------------------------------------
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.alive) continue;
        if (fxReveal(it.id) < 0.5) continue;
        const carrier = it.carriedBy ? sim.getAnt(it.carriedBy) : undefined;
        const px = carrier ? carrier.pos.x : it.pos.x;
        const py = carrier ? carrier.pos.y : it.pos.y;
        const pz = carrier ? carrier.pos.z : it.pos.z;
        const zc = culler.depthIfVisible(px, py, pz, 1.5);
        if (zc < 0) continue;
        const h1 = hash(it.id, 1);
        const hl = it.id === view.hoverId ? 0.8 : 0;
        if (it.itemKind === 'corpse') {
          let info = corpses.get(it.id);
          if (!info) corpses.set(it.id, (info = resolveCorpse(sim, it)));
          const b = batch(ctx, info.kind);
          const len = info.len;
          const c = b.near.look.color;
          // death: legs fold in over half a second while the body keels over
          const age = Math.max(0, (tickF - it.bornTick) / 30);
          const ct = Math.min(1, age / 0.55);
          const curl = ct * ct * (3 - 2 * ct);
          const dim = 0.7 + 0.3 * (1 - curl);
          const j = put(b, (len * culler.pxScale) / zc > 34, c[0] * dim, c[1] * dim, c[2] * dim, h1, groundSun(px, py, pz), curl, it.infected ? 1 : 0, hl);
          if (j < 0) continue;
          if (carrier) {
            // dragged by the waist, belly up, slung back over the carrier's head
            const cl = Math.min(len, getCaste(carrier.species, carrier.caste).length * 1.6);
            writeCarriedMatrix(carrier, alpha, view, cl * 0.9, 0.12, 0.1, Math.PI * 0.9, Math.PI / 2, b.cur.matrix, j * 16);
          } else {
            const sd = it.falling ? 0 : world.sample(px, py, pz);
            const drop = sd < 0 && sd > -1.5 ? sd : 0;
            const s = len * (info.creature ? 1 : farScale(view, culler.dist(px, py, pz)));
            writeSurfaceMatrix(px + it.up.x * drop, py + it.up.y * drop, pz + it.up.z * drop, it.up.x, it.up.y, it.up.z, h1 * 6.283, s, s, s, s * (info.creature ? 0.2 - 0.07 * curl : 0.2 - 0.1 * curl), b.cur.matrix, j * 16);
            const rt = Math.min(1, Math.max(0, (age - 0.08) / 0.6));
            const roll = rt * rt * (3 - 2 * rt);
            // ants keel over onto one side, legs folded in; big creatures slump
            rollMatrix(b.cur.matrix, j * 16, (h1 > 0.5 ? 1 : -1) * (info.creature ? 0.22 : Math.PI * (0.5 + 0.14 * h1)) * roll);
          }
          continue;
        }
        const bk = ITEM_BATCH[it.itemKind];
        const b = batch(ctx, bk);
        const size = ITEM_SIZE[it.itemKind] * Math.min(1.6, Math.max(0.6, Math.cbrt(Math.max(0.2, it.amount))));
        const c = b.near.look.color;
        const v = 0.85 + 0.3 * hash(it.id, 2);
        const j = put(b, (size * culler.pxScale) / zc > 22, c[0] * v, c[1] * v, c[2] * v, h1, groundSun(px, py, pz), 0, it.infected ? 0.8 : 0, hl);
        if (j < 0) continue;
        if (carrier) carryPose(carrier, it.itemKind, size, h1, b.cur.matrix, j * 16);
        else {
          const sd = it.falling ? 0 : world.sample(px, py, pz);
          const drop = sd < 0 && sd > -1.5 ? sd : 0;
          const s = size * readableScale(view, culler.dist(px, py, pz), (size * culler.pxScale) / zc, 5);
          groundPose(bk, px + it.up.x * drop, py + it.up.y * drop, pz + it.up.z * drop, it.up.x, it.up.y, it.up.z, h1, s, b.cur.matrix, j * 16);
        }
      }

      // ---- bulk loads (no entity): dig spoil, mud, forage ---------------------------------
      for (let i = 0; i < ants.length; i++) {
        const a = ants[i];
        const carry = a.carrying;
        if (!carry || carry.kind !== 'bulk' || !a.alive) continue;
        if (a.id === view.possessedId && view.firstPerson && view.mode === 'possess') continue;
        const zc = culler.depthIfVisible(a.pos.x, a.pos.y, a.pos.z, 1.5);
        if (zc < 0) continue;
        const bk = ITEM_BATCH[carry.itemKind];
        const b = batch(ctx, bk);
        const size = ITEM_SIZE[carry.itemKind] * Math.min(1.5, Math.max(0.7, Math.cbrt(Math.max(0.3, carry.amount))));
        let c = b.near.look.color;
        if (carry.itemKind === 'debris' && carry.material) c = materialDef(carry.material).color;
        const sun = a.id < antState.cap ? Math.max(0, antState.sun[a.id]) : 1;
        const j = put(b, (size * culler.pxScale) / zc > 22, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, a.phase, sun, 0, 0, 0);
        if (j >= 0) carryPose(a, carry.itemKind, size, a.phase, b.cur.matrix, j * 16);
      }

      // ---- food sources: piles that shrink ---------------------------------------------------
      // an aphid herd's honeydew source is shown by the aphids themselves (beads at the cornicles):
      // its generic pile floated big yellow balls in the air around the thin stem
      const herds = b3StateOf(sim).herds;
      for (let i = 0; i < foods.length; i++) {
        const f = foods[i];
        if (!f.alive || f.amount <= 0) continue;
        if (f.foodKind === 'honeydew') {
          let herd = false;
          for (let h = 0; h < herds.length; h++) if (herds[h].sourceId === f.id) herd = true;
          if (herd) continue;
        }
        const zc = culler.depthIfVisible(f.pos.x, f.pos.y, f.pos.z, f.radius + 2);
        if (zc < 0) continue;
        const reveal = fxReveal(f.id);
        if (reveal <= 0) continue;
        const frac = Math.min(1, f.amount / Math.max(1e-3, f.maxAmount));
        const ex = farScale(view, culler.dist(f.pos.x, f.pos.y, f.pos.z)) * reveal;
        const near = (0.4 * culler.pxScale) / zc > 22;
        const sun = groundSun(f.pos.x, f.pos.y, f.pos.z);
        const hl = f.id === view.hoverId ? 0.6 : 0;
        const R = Math.max(0.6, f.radius);
        const sd0 = world.sample(f.pos.x, f.pos.y, f.pos.z);
        const drop0 = sd0 < 0 && sd0 > -2 ? sd0 : 0;
        const bx = f.pos.x + f.up.x * drop0;
        const by = f.pos.y + f.up.y * drop0;
        const bz = f.pos.z + f.up.z * drop0;
        // centre-piece: one big body that is eaten away
        if (f.foodKind === 'fruit' || f.foodKind === 'carcass') {
          const k = f.foodKind === 'fruit' ? 'fruit' : 'caterpillar';
          const b = batch(ctx, k);
          const s = (f.foodKind === 'fruit' ? R * 1.15 : R * 1.9) * (0.35 + 0.65 * Math.cbrt(frac)) * ex;
          const c = b.near.look.color;
          const dead = f.foodKind === 'carcass' ? 0.55 : 1;
          const j = put(b, (s * culler.pxScale) / zc > 40, c[0] * (f.foodKind === 'carcass' ? 1.1 : 1), c[1] * dead * 0.9, c[2] * dead, hash(f.id, 1), sun, f.foodKind === 'carcass' ? 1 : 0, 0, hl);
          if (j >= 0) writeSurfaceMatrix(bx, by, bz, f.up.x, f.up.y, f.up.z, hash(f.id, 3) * 6.283, s, s * (f.foodKind === 'fruit' ? 0.4 + 0.6 * frac : 1), s, s * ITEM_REST[k] * (f.foodKind === 'fruit' ? 0.5 + 0.5 * frac : 1), b.cur.matrix, j * 16);
        }
        const pile = PILE[f.foodKind];
        const exSmall = readableScale(view, culler.dist(f.pos.x, f.pos.y, f.pos.z), (pile.size * culler.pxScale) / zc, 4.5);
        const b = batch(ctx, pile.kind);
        const count = Math.max(1, Math.ceil(frac * pile.max));
        const c = pile.color ?? b.near.look.color;
        // tangent frame of the surface
        let tx: number;
        let ty: number;
        let tz: number;
        if (Math.abs(f.up.y) < 0.9) {
          tx = f.up.z;
          ty = 0;
          tz = -f.up.x;
        } else {
          tx = 1;
          ty = 0;
          tz = 0;
        }
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const ux = f.up.y * tz - f.up.z * ty;
        const uy = f.up.z * tx - f.up.x * tz;
        const uz = f.up.x * ty - f.up.y * tx;
        for (let p = 0; p < count; p++) {
          const h = hash(f.id * 31 + p, 5);
          const ang = p * 2.39996 + h;
          const centre = f.foodKind === 'fruit' || f.foodKind === 'carcass';
          const rr = R * (centre ? 0.75 + 0.3 * h : 0.62 * Math.sqrt((p + 0.5) / pile.max));
          const ox = Math.cos(ang) * rr;
          const oz = Math.sin(ang) * rr;
          let x = bx + tx * ox + ux * oz;
          let y = by + ty * ox + uy * oz;
          let z = bz + tz * ox + uz * oz;
          const sd = world.sample(x + f.up.x * 0.5, y + f.up.y * 0.5, z + f.up.z * 0.5);
          const adj = sd > -2 && sd < 1.5 ? sd + 0.5 : 0.5;
          x += f.up.x * (adj - 0.5);
          y += f.up.y * (adj - 0.5);
          z += f.up.z * (adj - 0.5);
          const s = pile.size * (0.8 + 0.4 * h) * exSmall * reveal;
          // inner pieces are stacked on the ring below them
          const layer = !centre && p < pile.max * 0.35 ? s * 0.5 : 0;
          const v = 0.85 + 0.3 * hash(f.id * 17 + p, 6);
          const j = put(b, near, c[0] * v, c[1] * v, c[2] * v, h, sun, 0, 0, hl);
          if (j < 0) break;
          groundPose(pile.kind, x + f.up.x * layer, y + f.up.y * layer, z + f.up.z * layer, f.up.x, f.up.y, f.up.z, h, s, b.cur.matrix, j * 16);
        }
      }

      for (let i = 0; i < order.length; i++) order[i].end();

      // ---- pose helpers (closures over frame state) ------------------------------------------
      function groundPose(kind: BatchKind, x: number, y: number, z: number, ux: number, uy: number, uz: number, h: number, s: number, out: Float32Array, off: number): void {
        if (kind === 'leaf') {
          // the leaf mesh stands in its XY plane: lay it flat with a slight random tilt
          writeSurfaceMatrix(x, y, z, ux, uy, uz, h * 6.283, 1, 1, 1, s * 0.06, tmp, 0);
          writeAttachedMatrix(tmp, 0, 0, 0, 0, Math.PI / 2 - 0.25 * (h - 0.3), 0, s, out, off);
        } else writeSurfaceMatrix(x, y, z, ux, uy, uz, h * 6.283, s, s, s, s * ITEM_REST[kind], out, off);
      }
      function carryPose(carrier: Readonly<Ant>, kind: ItemKind, size: number, h: number, out: Float32Array, off: number): void {
        if (kind === 'leaf') {
          // leafcutter parade: the fragment is held edge-on above the head like a sail
          const sail = carrier.species === 'leafcutter';
          if (sail) writeCarriedMatrix(carrier, alpha, view, size * 1.25, 0.5, -0.12, -0.25, Math.PI / 2 + (h - 0.5) * 0.3, out, off);
          else writeCarriedMatrix(carrier, alpha, view, size, 0.12, 0.12, 0.9, h * 0.6, out, off);
        } else writeCarriedMatrix(carrier, alpha, view, size, 0.02, 0.1, h * 2, h * 6.283, out, off);
      }
    },
    dispose() {
      for (const b of order) b.dispose();
      batches.clear();
      order.length = 0;
      corpses.clear();
      cap = 64;
    },
  };
}

export const itemsModule: Module = createItemsModule();
