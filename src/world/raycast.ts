import { ISO, Mat, type MaterialId, type RayHit, type RaycastOptions, type Vec3, type VoxelWorld } from '../core';

/**
 * D10 raycast. The density field is a clamped distance field, so instead of a cell-by-cell DDA
 * the ray is sphere-traced through the trilinear field (step ∝ distance to the surface, at most
 * the 2-voxel clamp band) and the crossing is refined by bisection. This hits exactly the
 * surface the mesher renders and the one locomotion walks on.
 */
export function raycastWorld(world: VoxelWorld, origin: Vec3, dirIn: Vec3, maxDist: number, opts?: RaycastOptions): RayHit | null {
  const visual = !!opts?.visual;
  const cut = visual && opts?.cut && opts.cut.enabled ? opts.cut : null;
  const dl = Math.hypot(dirIn.x, dirIn.y, dirIn.z);
  if (!(dl > 1e-12) || !(maxDist > 0)) return null;
  const dx = dirIn.x / dl;
  const dy = dirIn.y / dl;
  const dz = dirIn.z / dl;

  // Clip the ray to the world box (grown by 1 so boundary faces are inside the interval).
  let t0 = 0;
  let t1 = maxDist;
  const lo = -1;
  const o = [origin.x, origin.y, origin.z];
  const d = [dx, dy, dz];
  const hi = [world.sx + 1, world.sy + 1, world.sz + 1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo || o[a] > hi[a]) return null;
    } else {
      let ta = (lo - o[a]) / d[a];
      let tb = (hi[a] - o[a]) / d[a];
      if (ta > tb) {
        const t = ta;
        ta = tb;
        tb = t;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
  }
  let cutStart = false;
  if (cut) {
    const a = cut.axis === 'x' ? 0 : cut.axis === 'y' ? 1 : 2;
    // Visible half-space: sign * (coord - pos) <= 0.
    const side = cut.sign * (o[a] - cut.pos);
    const rate = cut.sign * d[a];
    if (Math.abs(rate) < 1e-9) {
      if (side > 0) return null;
    } else {
      const tc = -side / rate;
      if (rate < 0) {
        // moving from hidden into visible
        if (tc > t0) {
          t0 = tc;
          cutStart = true;
        }
      } else if (tc < t1) t1 = tc;
    }
  }
  if (t0 >= t1) return null;

  const f = visual ? (x: number, y: number, z: number) => world.sampleVisual(x, y, z) : (x: number, y: number, z: number) => world.sample(x, y, z);

  let t = t0 + (cutStart ? 1e-3 : 0);
  let s = f(origin.x + dx * t, origin.y + dy * t, origin.z + dz * t);
  let hitT = -1;
  if (s >= 0) {
    hitT = t;
  } else {
    for (let iter = 0; iter < 2048; iter++) {
      let step = -s * 0.7;
      if (step < 0.04) step = 0.04;
      else if (step > 1.4) step = 1.4;
      let tn = t + step;
      let last = false;
      if (tn >= t1) {
        tn = t1;
        last = true;
      }
      const sn = f(origin.x + dx * tn, origin.y + dy * tn, origin.z + dz * tn);
      if (sn >= 0) {
        let a = t;
        let b = tn;
        for (let k = 0; k < 10; k++) {
          const m = (a + b) * 0.5;
          if (f(origin.x + dx * m, origin.y + dy * m, origin.z + dz * m) >= 0) b = m;
          else a = m;
        }
        hitT = (a + b) * 0.5;
        break;
      }
      t = tn;
      s = sn;
      if (last) break;
    }
  }

  if (hitT < 0) {
    // Visual rays on glass maps resolve to the pane they leave through.
    if (!visual || world.boundary !== 'glass' || t1 >= maxDist) return null;
    return exitPaneHit(world, origin, dx, dy, dz, maxDist);
  }

  const pos = { x: origin.x + dx * hitT, y: origin.y + dy * hitT, z: origin.z + dz * hitT };
  const h = 0.5;
  let nx = f(pos.x - h, pos.y, pos.z) - f(pos.x + h, pos.y, pos.z);
  let ny = f(pos.x, pos.y - h, pos.z) - f(pos.x, pos.y + h, pos.z);
  let nz = f(pos.x, pos.y, pos.z - h) - f(pos.x, pos.y, pos.z + h);
  if (cutStart && hitT <= t0 + 2e-3 && cut) {
    // Started inside solid at the cut face: the visible surface is the cap.
    nx = cut.axis === 'x' ? cut.sign : 0;
    ny = cut.axis === 'y' ? cut.sign : 0;
    nz = cut.axis === 'z' ? cut.sign : 0;
  }
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-4) {
    nx = -dx;
    ny = -dy;
    nz = -dz;
    nl = 1;
  }
  nx /= nl;
  ny /= nl;
  nz /= nl;

  let solidCell = -1;
  let material: MaterialId = Mat.Air;
  for (const k of [0.35, 0.7, 1.1]) {
    const c = world.cellAt(pos.x - nx * k, pos.y - ny * k, pos.z - nz * k);
    if (c >= 0 && world.density[c] >= ISO) {
      solidCell = c;
      material = world.material[c] as MaterialId;
      break;
    }
  }
  let airCell = -1;
  for (const k of [0.35, 0.7, 1.1]) {
    const c = world.cellAt(pos.x + nx * k, pos.y + ny * k, pos.z + nz * k);
    if (c >= 0 && world.density[c] < ISO) {
      airCell = c;
      break;
    }
  }
  return { pos, normal: { x: nx, y: ny, z: nz }, dist: hitT, solidCell, airCell, material, boundary: solidCell < 0 };
}

function exitPaneHit(world: VoxelWorld, origin: Vec3, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
  // Exact exit from the true world box.
  let tExit = Infinity;
  let axis = -1;
  const o = [origin.x, origin.y, origin.z];
  const d = [dx, dy, dz];
  const size = [world.sx, world.sy, world.sz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) continue;
    const tb = ((d[a] > 0 ? size[a] : 0) - o[a]) / d[a];
    if (tb < tExit) {
      tExit = tb;
      axis = a;
    }
  }
  if (axis < 0 || tExit <= 0 || tExit > maxDist) return null;
  const pos = { x: origin.x + dx * tExit, y: origin.y + dy * tExit, z: origin.z + dz * tExit };
  const normal = { x: 0, y: 0, z: 0 };
  const sgn = d[axis] > 0 ? -1 : 1;
  if (axis === 0) normal.x = sgn;
  else if (axis === 1) normal.y = sgn;
  else normal.z = sgn;
  const airCell = world.cellAt(
    Math.min(world.sx - 0.01, Math.max(0.01, pos.x + normal.x * 0.3)),
    Math.min(world.sy - 0.01, Math.max(0.01, pos.y + normal.y * 0.3)),
    Math.min(world.sz - 0.01, Math.max(0.01, pos.z + normal.z * 0.3)),
  );
  if (airCell < 0 || world.density[airCell] >= ISO) return null;
  return { pos, normal, dist: tExit, solidCell: -1, airCell, material: Mat.Air, boundary: true };
}
