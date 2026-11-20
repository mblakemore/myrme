import type { Brood, FrameInfo } from '../../core';
import { getCaste } from '../../sim/data/species';
import type { Module, RenderContext } from '../shared';
import { antsRuntime, CreatureBatch, writeCarriedMatrix } from './ants';
import { readableScale, writeSurfaceMatrix } from './antsShared';

/**
 * Brood (§5.3): instanced egg clusters, larvae and pupae resting on the nursery floor (snapped
 * to the surface along their `up`), gently wriggling (shader body wave driven by a slow phase),
 * or held in a nurse's mandibles while carried. Pale, waxy and translucent — in the backlit gel
 * farm the grubs glow.
 */

const STAGES = ['egg', 'larva', 'pupa'] as const;

/** Stable 0..1 hash of an entity id. */
function hash(id: number, k: number): number {
  const s = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export function createBroodModule(): Module {
  const batches: Partial<Record<(typeof STAGES)[number], CreatureBatch>> = {};
  let ctxRef: RenderContext | null = null;

  return {
    id: 'brood',
    init(ctx) {
      ctxRef = ctx;
    },
    update(ctx: RenderContext, frame: FrameInfo) {
      const brood = ctx.sim.brood;
      const n = brood.length;
      if (n === 0 && !batches.egg) return;
      for (const s of STAGES) {
        let b = batches[s];
        if (!b) b = batches[s] = new CreatureBatch(ctx, s, 1, 1);
        b.begin(n);
      }
      const culler = antsRuntime.culler;
      const clock = antsRuntime.clock;
      const world = ctx.sim.world;
      const view = ctx.view;
      const slab = ctx.map.flags.slab;
      const sun = slab ? 0.85 : 0.25;
      for (let i = 0; i < n; i++) {
        const br: Readonly<Brood> = brood[i];
        if (!br.alive) continue;
        const batch = batches[br.stage]!;
        const adult = getCaste(br.species, br.caste).length;
        const h1 = hash(br.id, 1);
        // eggs are tiny clusters, larvae grow as they are fed, pupae are nearly adult-sized
        const size = br.stage === 'egg' ? adult * 0.3 : br.stage === 'larva' ? adult * (0.34 + 0.4 * Math.min(1, br.fed / Math.max(1, getCaste(br.species, br.caste).foodCost)) + 0.06 * h1) : adult * 0.78;
        const zc = culler.depthIfVisible(br.pos.x, br.pos.y, br.pos.z, size * 2);
        if (zc < 0) continue;
        const near = (size * culler.pxScale) / zc > 26;
        const j = batch.add(near);
        if (j < 0) continue;
        const m = batch.cur;
        const carrier = br.carriedBy ? ctx.sim.getAnt(br.carriedBy) : undefined;
        if (carrier) {
          writeCarriedMatrix(carrier, frame.alpha, view, size, 0.02, 0.12, 0, Math.PI / 2, m.matrix, j * 16);
        } else {
          // rest on the floor: move along −up by the distance to the surface, then lift by half a thickness
          const sd = world.sample(br.pos.x, br.pos.y, br.pos.z);
          const drop = sd < 0 && sd > -1.5 ? sd : 0;
          const ex = readableScale(view, culler.dist(br.pos.x, br.pos.y, br.pos.z), (size * culler.pxScale) / zc, br.stage === 'egg' ? 5 : 7);
          const s = size * ex;
          const thick = br.stage === 'egg' ? 0.3 : br.stage === 'larva' ? 0.27 : 0.2;
          writeSurfaceMatrix(br.pos.x + br.up.x * drop, br.pos.y + br.up.y * drop, br.pos.z + br.up.z * drop, br.up.x, br.up.y, br.up.z, h1 * 6.283, s, s, s, s * thick, m.matrix, j * 16);
        }
        const v = 0.92 + 0.16 * hash(br.id, 2);
        const c = m.look.color;
        // hungry larvae lose their plump sheen and go greyish
        const hungry = br.stage === 'larva' ? Math.min(1, br.hunger / 1800) : 0;
        m.color[j * 3] = c[0] * v * (1 - 0.25 * hungry);
        m.color[j * 3 + 1] = c[1] * v * (1 - 0.3 * hungry);
        m.color[j * 3 + 2] = c[2] * v * (1 - 0.3 * hungry);
        const k = j * 4;
        // slow peristaltic wriggle: the "gait phase" channel doubles as the wave phase
        m.a[k] = br.stage === 'egg' ? 0 : clock * (br.stage === 'larva' ? 0.22 + 0.2 * hungry : 0.05) + h1 * 7;
        m.a[k + 1] = 0;
        m.a[k + 2] = h1;
        m.a[k + 3] = sun;
        m.b[k] = br.stage === 'larva' ? 0.5 + 0.5 * Math.sin(clock * 2 + h1 * 30) * hungry : 0;
        m.b[k + 1] = 0;
        m.b[k + 2] = 0;
        m.b[k + 3] = 0;
        m.c[k] = m.c[k + 1] = m.c[k + 2] = 0;
        m.c[k + 3] = br.id === view.hoverId ? 0.8 : 0;
      }
      for (const s of STAGES) batches[s]!.end();
    },
    dispose() {
      for (const s of STAGES) {
        batches[s]?.dispose();
        delete batches[s];
      }
      void ctxRef;
      ctxRef = null;
    },
  };
}

export const broodModule: Module = createBroodModule();
