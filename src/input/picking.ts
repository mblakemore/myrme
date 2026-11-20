import { cameraRay, projectToNdc, v3, type AppContext, type CutPlane, type Entity, type EntityId, type EntityKind, type RayHit, type Vec3 } from '../core';
import { getCreature } from '../sim/data/creatures';
import { getCaste } from '../sim/data/species';
import { cutEntityHidden } from '../world/cut';
import { pickRadiusPx, type ScreenCandidate } from './selection';

/**
 * Screen-space picking of sim entities (§5.4). Entities are projected with the plain-data camera
 * (no three.js); occlusion is a voxel raycast with *visual* semantics and the active cutaway, so
 * nothing can be picked through terrain, but everything exposed by the cut plane can.
 */

export function hiddenByCut(p: Vec3, cut: CutPlane): boolean {
  if (!cut.enabled) return false;
  const c = cut.axis === 'x' ? p.x : cut.axis === 'y' ? p.y : p.z;
  return cut.sign * (c - cut.pos) > 0;
}

/** Entity variant: matches what the renderer draws (underground entities keep a slack past the plane). */
function entityCutAway(app: AppContext, p: Vec3): boolean {
  const cut = app.view.cut;
  if (!cut.enabled) return false;
  const map = app.sim.map;
  return cutEntityHidden(app.sim.world, p, cut, map.flags.slab || map.boundary === 'glass');
}

export interface HoverResult {
  id: EntityId;
  kind: EntityKind;
  entity: Readonly<Entity>;
}

interface Scored {
  e: Readonly<Entity>;
  s: number;
}

const UP = v3(0, 1, 0);

export class Picker {
  private readonly ndc = v3();
  private readonly dir = v3();
  private readonly tmp = v3();
  /** Screen position written by `project`. */
  sx = 0;
  sy = 0;
  depth = 0;

  constructor(private readonly app: AppContext) {}

  private aspect(): number {
    const v = this.app.viewport();
    return v.width / Math.max(1, v.height);
  }

  /** Voxel ray through a canvas pixel (visual semantics, honours the cutaway). */
  rayAt(x: number, y: number): RayHit | null {
    const v = this.app.viewport();
    const cam = this.app.view.camera;
    cameraRay(cam, (x / Math.max(1, v.width)) * 2 - 1, 1 - (y / Math.max(1, v.height)) * 2, this.aspect(), this.dir);
    return this.app.sim.world.raycast(cam.pos, this.dir, 1500, { visual: true, cut: this.app.view.cut });
  }

  /** Project a world point; false if behind the camera or outside the viewport (+margin px). */
  project(p: Vec3, margin = 0): boolean {
    const v = this.app.viewport();
    if (!projectToNdc(this.app.view.camera, p, this.aspect(), this.ndc)) return false;
    this.sx = (this.ndc.x * 0.5 + 0.5) * v.width;
    this.sy = (0.5 - this.ndc.y * 0.5) * v.height;
    this.depth = this.ndc.z;
    return this.sx >= -margin && this.sx <= v.width + margin && this.sy >= -margin && this.sy <= v.height + margin;
  }

  /** True if nothing solid (and visible) lies between the camera and a point just above `pos`. */
  visible(pos: Vec3, up: Vec3 = UP): boolean {
    const cam = this.app.view.camera;
    const t = this.tmp;
    t.x = pos.x + up.x * 0.15 - cam.pos.x;
    t.y = pos.y + up.y * 0.15 - cam.pos.y;
    t.z = pos.z + up.z * 0.15 - cam.pos.z;
    const d = Math.hypot(t.x, t.y, t.z);
    if (d < 1e-4) return true;
    const hit = this.app.sim.world.raycast(cam.pos, t, d, { visual: true, cut: this.app.view.cut });
    return !hit || hit.dist > d - 0.6;
  }

  /** Own-colony ants on screen (not cut away). Occlusion is NOT tested here. */
  ownAnts(minPx = 12): ScreenCandidate[] {
    const { sim, view } = this.app;
    const h = this.app.viewport().height;
    const out: ScreenCandidate[] = [];
    for (const a of sim.ants) {
      if (!a.alive || a.colony !== sim.playerColony) continue;
      if (entityCutAway(this.app, a.pos)) continue;
      if (!this.project(a.pos)) continue;
      out.push({ id: a.id, x: this.sx, y: this.sy, depth: this.depth, r: pickRadiusPx(getCaste(a.species, a.caste).length, this.depth, view.camera.fov, h, minPx) });
    }
    return out;
  }

  /** Is this ant (by id) currently visible on screen? */
  antVisible(id: EntityId): boolean {
    const a = this.app.sim.getAnt(id);
    return !!a && !entityCutAway(this.app, a.pos) && this.project(a.pos) && this.visible(a.pos, a.up);
  }

  /**
   * The entity under a canvas pixel: any ant, creature, food source, loose item or brood.
   * `ownScale` shrinks the pick radius of own ants (RMB "follow" needs a deliberate click).
   */
  entityAt(x: number, y: number, ownScale = 1): HoverResult | null {
    const { sim, view } = this.app;
    const h = this.app.viewport().height;
    const fov = view.camera.fov;
    const best: Scored[] = [];
    const consider = (e: Readonly<Entity>, length: number, minPx: number, scale: number): void => {
      if (!e.alive || entityCutAway(this.app, e.pos)) return;
      if (!this.project(e.pos, 40)) return;
      const r = pickRadiusPx(length, this.depth, fov, h, minPx) * scale;
      const d = Math.hypot(this.sx - x, this.sy - y);
      if (d > r) return;
      const s = d / r + this.depth * 1e-4;
      // keep the three best
      let i = best.length;
      while (i > 0 && best[i - 1].s > s) i--;
      if (i < 3) {
        best.splice(i, 0, { e, s });
        if (best.length > 3) best.length = 3;
      }
    };
    for (const a of sim.ants) consider(a, getCaste(a.species, a.caste).length, 12, a.colony === sim.playerColony ? ownScale : 1);
    for (const c of sim.creatures) consider(c, getCreature(c.def).length, 14, 1);
    for (const f of sim.foodSources) consider(f, Math.max(0.6, f.radius * 2), 12, 1);
    for (const it of sim.items) if (!it.carriedBy) consider(it, 0.5, 9, 1);
    for (const b of sim.brood) if (!b.carriedBy) consider(b, 0.4, 8, 1);
    for (const { e } of best) {
      const up = (e as { up?: Vec3 }).up ?? UP;
      if (this.visible(e.pos, up)) return { id: e.id, kind: e.kind, entity: e };
    }
    return null;
  }
}
