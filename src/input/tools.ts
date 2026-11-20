import { MIN_BRUSH_RADIUS, type Ant, type Beacon, type ColonyId, type CutPlane, type EntityId, type RayHit, type Vec3 } from '../core';

/**
 * Pure helpers for the paint tools, beacons and possession hopping (unit-tested in tools.test.ts).
 */

export const BRUSH_SIZES: readonly number[] = [MIN_BRUSH_RADIUS, 2, 2.5, 3, 4, 5];

/** Step through the brush sizes (clamped at both ends). */
export function nextBrushSize(current: number, dir: 1 | -1): number {
  let i = 0;
  let best = Infinity;
  for (let k = 0; k < BRUSH_SIZES.length; k++) {
    const d = Math.abs(BRUSH_SIZES[k] - current);
    if (d < best) {
      best = d;
      i = k;
    }
  }
  return BRUSH_SIZES[Math.min(BRUSH_SIZES.length - 1, Math.max(0, i + dir))];
}

/** Minimum distance between two stamps of one stroke (overlapping spheres make smooth tunnels). */
export const stampSpacing = (radius: number): number => radius * 0.7;

export interface SlabInfo {
  axis: 'x' | 'z';
  /** Mid-slab coordinate along `axis`. */
  mid: number;
}

/**
 * Where a brush stamp goes for a cursor hit:
 *  - on the cutaway cross-section the sphere is centred exactly on the cut plane, so the painted
 *    disc you see is the widest slice of the chamber you get;
 *  - on farm slabs it is centred mid-slab, so every tunnel touches both panes (D7);
 *  - otherwise a dig stamp sinks a little into the surface and a build stamp sits proud of it.
 * Returns null when there is nothing to paint on (dig on a glass pane / open boundary).
 */
export function brushCenter(hit: RayHit, kind: 'dig' | 'build', radius: number, cut: CutPlane | null, slab: SlabInfo | null): { center: Vec3; onCutFace: boolean } | null {
  if (hit.boundary && kind === 'dig' && !slab) return null;
  const c = { x: hit.pos.x, y: hit.pos.y, z: hit.pos.z };
  if (slab) {
    if (slab.axis === 'z') c.z = slab.mid;
    else c.x = slab.mid;
    return { center: c, onCutFace: false };
  }
  if (cut && cut.enabled) {
    const coord = cut.axis === 'x' ? hit.pos.x : cut.axis === 'y' ? hit.pos.y : hit.pos.z;
    const n = cut.axis === 'x' ? hit.normal.x : cut.axis === 'y' ? hit.normal.y : hit.normal.z;
    if (Math.abs(coord - cut.pos) < 0.75 && Math.abs(n) > 0.7) {
      if (cut.axis === 'x') c.x = cut.pos;
      else if (cut.axis === 'y') c.y = cut.pos;
      else c.z = cut.pos;
      return { center: c, onCutFace: true };
    }
  }
  const k = radius * 0.35 * (kind === 'dig' ? -1 : 1);
  c.x += hit.normal.x * k;
  c.y += hit.normal.y * k;
  c.z += hit.normal.z * k;
  return { center: c, onCutFace: false };
}

/**
 * Id of the beacon under the cursor (0 = none): its marker projects within `px` pixels of the
 * cursor, or the cursor's world hit lies within 1.2 units of it.
 */
export function beaconUnderCursor(
  beacons: readonly Readonly<Beacon>[],
  cursorWorld: Vec3 | null,
  project: (p: Vec3) => { x: number; y: number } | null,
  x: number,
  y: number,
  px = 18,
): number {
  let best = 0;
  let bd = Infinity;
  for (const b of beacons) {
    let d = Infinity;
    const s = project(b.pos);
    if (s) {
      const ds = Math.hypot(s.x - x, s.y - y);
      if (ds <= px) d = ds;
    }
    if (cursorWorld) {
      const dw = Math.hypot(b.pos.x - cursorWorld.x, b.pos.y - cursorWorld.y, b.pos.z - cursorWorld.z);
      if (dw <= 1.2) d = Math.min(d, dw * 10);
    }
    if (d < bd) {
      bd = d;
      best = b.id;
    }
  }
  return best;
}

/**
 * Nestmates to hop to from the possessed ant, nearest first. Ants in `recent` (already visited)
 * are skipped so repeated "next" walks outwards through the neighbourhood instead of ping-ponging;
 * if everything nearby was visited the filter is dropped.
 */
export function hopCandidates(ants: readonly Readonly<Ant>[], from: Readonly<Ant>, colony: ColonyId, recent: readonly EntityId[], maxDist = 40): EntityId[] {
  const list: { id: EntityId; d: number }[] = [];
  for (const a of ants) {
    if (!a.alive || a.id === from.id || a.colony !== colony) continue;
    const d = Math.hypot(a.pos.x - from.pos.x, a.pos.y - from.pos.y, a.pos.z - from.pos.z);
    if (d <= maxDist) list.push({ id: a.id, d });
  }
  list.sort((p, q) => p.d - q.d || p.id - q.id);
  const fresh = list.filter((e) => !recent.includes(e.id));
  return (fresh.length ? fresh : list).map((e) => e.id);
}
