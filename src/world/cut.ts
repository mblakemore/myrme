import type { CutPlane, Vec3, VoxelWorld } from '../core';
import { ISO, Mat } from '../core';

/**
 * How far past the cutaway plane underground entities stay visible (world units). A cut through
 * a chamber removes the near half of it; the queen, brood and workers standing in that half must
 * still be drawn and pickable. Render side: `applyCutPlane(…, { entity: true })`.
 */
export const CUT_ENTITY_MARGIN = 3.5;

/** Signed distance of a point past the cut plane (> 0 = on the removed side). */
export function cutDistance(p: Readonly<Vec3>, cut: Readonly<CutPlane>): number {
  if (!cut.enabled) return -Infinity;
  const c = cut.axis === 'x' ? p.x : cut.axis === 'y' ? p.y : p.z;
  return cut.sign * (c - cut.pos);
}

/** Ground materials (plants, wood and fungus stand in the open air — same set as the render height field). */
const GROUND: boolean[] = [];
for (const m of [Mat.Soil, Mat.Sand, Mat.Clay, Mat.Rock, Mat.Gel, Mat.LeafLitter, Mat.Mud]) GROUND[m] = true;

/** True when ground lies over the point (it is in a tunnel / chamber, not on the surface). */
function underGround(world: VoxelWorld, p: Readonly<Vec3>): boolean {
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  if (x < 0 || z < 0 || x >= world.sx || z >= world.sz) return false;
  const col = x + world.sx * z;
  const layer = world.sx * world.sz;
  for (let y = Math.floor(p.y) + 2; y < world.sy; y++) {
    const i = col + layer * y;
    if (world.density[i] >= ISO && GROUND[world.material[i]]) return true;
  }
  return false;
}

/**
 * Whether an entity at `p` is removed by the cutaway. Terrain is cut exactly at the plane;
 * entities below ground are kept up to `CUT_ENTITY_MARGIN` past it (`slackEverywhere` = farm
 * slabs, where there is no open surface to float over).
 */
export function cutEntityHidden(world: VoxelWorld, p: Readonly<Vec3>, cut: Readonly<CutPlane>, slackEverywhere = false): boolean {
  const d = cutDistance(p, cut);
  if (d <= 0) return false;
  if (d > CUT_ENTITY_MARGIN) return true;
  return !(slackEverywhere || underGround(world, p));
}
