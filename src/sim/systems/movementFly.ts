import { v3, type Ant, type Creature, type Mover, type SimState, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { CRAWL_OK, orthonormalizeForward, projectToSurface } from './movementCrawl';
import { samplerFor } from './movementField';

/**
 * D11 `fly` locomotion (wasps, alates): free 3D steering, no A*.
 *
 * Intent semantics for flyers
 *  - `dir`   fly along `intent.dir` (full 3D, not projected onto a surface).
 *  - `goto`  fly straight towards the goal cell, steering around obstacles, and LAND there if it
 *            is walkable (the mover re-attaches to the surface; `path.status` becomes `arrived`).
 *            An unwalkable goal (a point in mid-air) is "arrived" once within ~1 voxel; the flyer
 *            then hovers.
 *  - `none`  perched on a surface → stay perched (it behaves like a `static` mover);
 *            airborne → hover in place, easing up to the preferred hover height above the ground
 *            and away from nearby surfaces.
 *  A perched flyer takes off as soon as its intent is `dir` or `goto`.
 *
 * Avoidance is two-layered: a short `world.raycast` along the velocity (steer along the hit
 * normal, biased upward) and a proximity push out of the distance field's 2-voxel band.
 * Velocity is carried between ticks in `mem` (keys `a2a.fv.x|y|z`; deterministic sim state).
 */

const VX = 'a2a.fv.x';
const VY = 'a2a.fv.y';
const VZ = 'a2a.fv.z';

const _v = v3();
const _w = v3();
const _g = v3();
const _n = v3();
const _c = v3();
const _o = v3();

/** True if the mover is close enough to a surface to count as perched on it. */
function perched(sim: SimState, m: Mover): boolean {
  const s = samplerFor(sim.world).sample(m.pos.x, m.pos.y, m.pos.z);
  return s > -(m.rideHeight + 0.3);
}

function land(sim: SimState, m: Mover, cell: number): boolean {
  const w = sim.world;
  w.cellCenter(cell, _c);
  _o.x = _c.x;
  _o.y = _c.y;
  _o.z = _c.z;
  let st = projectToSurface(w, _o, m.rideHeight, _n);
  if (st === CRAWL_OK) st = projectToSurface(w, _o, m.rideHeight, _n);
  if (st !== CRAWL_OK) return false;
  m.pos.x = _o.x;
  m.pos.y = _o.y;
  m.pos.z = _o.z;
  m.up.x = _n.x;
  m.up.y = _n.y;
  m.up.z = _n.z;
  orthonormalizeForward(m.forward, m.up, m.forward.x, m.forward.y, m.forward.z);
  m.cell = cell;
  m.moveSpeed = 0;
  const mem = (m as Ant | Creature).mem;
  mem[VX] = mem[VY] = mem[VZ] = 0;
  return true;
}

export function flyStep(sim: SimState, m: Mover, dt: number, speedScale: number): void {
  const w = sim.world;
  const f = samplerFor(w);
  const it = m.intent;
  const p = m.pos;
  const B = BALANCE.a2a;
  const isPerched = perched(sim, m);

  if (it.mode === 'none' && isPerched) {
    // behave like a static mover: stay glued, re-settle if the ground moved
    const e = f.sample(p.x, p.y, p.z) + m.rideHeight;
    if (!(e < 0.08 && e > -0.08)) projectToSurface(w, p, m.rideHeight, m.up);
    orthonormalizeForward(m.forward, m.up, m.forward.x, m.forward.y, m.forward.z);
    m.moveSpeed = 0;
    m.cell = w.cellAt(p.x, p.y, p.z);
    return;
  }

  // velocity carried over from the last tick
  // (kept in `mem`: `prevPos` is reset to `pos` at the start of every tick, so it carries no velocity)
  const inv = dt > 0 ? 1 / dt : 0;
  const mem = (m as Ant | Creature).mem;
  _v.x = mem[VX] ?? 0;
  _v.y = mem[VY] ?? 0;
  _v.z = mem[VZ] ?? 0;
  const speed = m.speed * it.speedMul * speedScale;
  const vmax = Math.max(speed, m.speed) * 1.5;
  const vl = Math.hypot(_v.x, _v.y, _v.z);
  if (vl > vmax) {
    // teleported / snapped last tick: do not inherit that as momentum
    _v.x = _v.y = _v.z = 0;
  }

  // wished velocity
  let wx = 0;
  let wy = 0;
  let wz = 0;
  let landing = false;
  let goalDist = Infinity;
  if (it.mode === 'dir') {
    const l = Math.hypot(it.dir.x, it.dir.y, it.dir.z);
    if (l > 1e-6) {
      wx = (it.dir.x / l) * speed;
      wy = (it.dir.y / l) * speed;
      wz = (it.dir.z / l) * speed;
    }
  } else if (it.mode === 'goto' && it.goal >= 0) {
    w.cellCenter(it.goal, _c);
    const dx = _c.x - p.x;
    const dy = _c.y - p.y;
    const dz = _c.z - p.z;
    goalDist = Math.hypot(dx, dy, dz);
    const walkable = sim.nav.isWalkable(it.goal);
    if (goalDist < (walkable ? 1.3 : 0.9)) {
      if (m.path.status !== 'arrived') {
        if (walkable) land(sim, m, it.goal);
        m.path.status = 'arrived';
        m.path.cells = null;
      }
      if (walkable) {
        m.moveSpeed = 0;
        return;
      }
    } else {
      if (m.path.status === 'arrived') m.path.status = 'following';
      // slow down on approach so the landing is not a crash
      const k = Math.min(1, goalDist / 3 + 0.25) * speed;
      wx = (dx / goalDist) * k;
      wy = (dy / goalDist) * k;
      wz = (dz / goalDist) * k;
      landing = goalDist < 3.5;
    }
  } else {
    // hover: ease up towards the preferred height above open ground
    const cell = w.cellAt(p.x, p.y, p.z);
    if (cell >= 0) {
      const ground = (sim.nav as { skyHeight?: (x: number, z: number) => number }).skyHeight?.(Math.floor(p.x), Math.floor(p.z)) ?? 0;
      const want = ground + B.flyHoverHeight;
      if (p.y >= ground && p.y < want) wy = Math.min(1, want - p.y) * m.speed * 0.4;
    }
  }

  // layer 1: look-ahead raycast along the wished direction
  const wl = Math.hypot(wx, wy, wz);
  if (wl > 0.05 && !landing) {
    const look = Math.max(2, wl * B.flyLookPerSpeed);
    _w.x = wx;
    _w.y = wy;
    _w.z = wz;
    const hit = w.raycast(p, _w, look);
    if (hit && hit.dist < goalDist - 0.5) {
      // slide along the obstacle instead of into it, and climb: flyers go over things
      const t = 1 - hit.dist / look;
      const into = wx * hit.normal.x + wy * hit.normal.y + wz * hit.normal.z;
      if (into < 0) {
        const k = into * Math.min(1, t * 2);
        wx -= hit.normal.x * k;
        wy -= hit.normal.y * k;
        wz -= hit.normal.z * k;
      }
      wy += (0.4 + t) * wl;
      const nl = Math.hypot(wx, wy, wz);
      if (nl > 1e-6) {
        wx = (wx / nl) * wl;
        wy = (wy / nl) * wl;
        wz = (wz / nl) * wl;
      }
    }
  }
  // layer 2: proximity push out of the distance band
  if (!landing) {
    const s = f.sample(p.x, p.y, p.z);
    if (s > -B.flyClearance) {
      f.gradient(p.x, p.y, p.z, _g);
      const gl = Math.hypot(_g.x, _g.y, _g.z);
      if (gl > 0.1) {
        const k = ((s + B.flyClearance) / B.flyClearance) * Math.max(speed, m.speed * 0.5);
        wx -= (_g.x / gl) * k;
        wy -= (_g.y / gl) * k;
        wz -= (_g.z / gl) * k;
      }
    }
  }

  // integrate
  const a = B.flyAccel;
  _v.x += (wx - _v.x) * a;
  _v.y += (wy - _v.y) * a;
  _v.z += (wz - _v.z) * a;
  const ox = p.x;
  const oy = p.y;
  const oz = p.z;
  p.x += _v.x * dt;
  p.y += _v.y * dt;
  p.z += _v.z * dt;
  // keep inside the world box
  const mgn = 1;
  if (p.x < mgn) p.x = mgn;
  else if (p.x > w.sx - mgn) p.x = w.sx - mgn;
  if (p.z < mgn) p.z = mgn;
  else if (p.z > w.sz - mgn) p.z = w.sz - mgn;
  if (p.y < mgn) p.y = mgn;
  else if (p.y > w.sy - mgn) p.y = w.sy - mgn;
  // never end inside solid: slide along the surface, else stay
  if (f.sample(p.x, p.y, p.z) > -0.12) {
    f.gradient(p.x, p.y, p.z, _g);
    const gl = Math.hypot(_g.x, _g.y, _g.z);
    let ok = false;
    if (gl > 0.1) {
      const mx = p.x - ox;
      const my = p.y - oy;
      const mz = p.z - oz;
      const d = (mx * _g.x + my * _g.y + mz * _g.z) / (gl * gl);
      if (d > 0) {
        p.x = ox + mx - _g.x * d;
        p.y = oy + my - _g.y * d;
        p.z = oz + mz - _g.z * d;
        ok = f.sample(p.x, p.y, p.z) <= -0.12;
      }
    }
    if (!ok) {
      p.x = ox;
      p.y = oy;
      p.z = oz;
    }
  }
  const mvx = p.x - ox;
  const mvy = p.y - oy;
  const mvz = p.z - oz;
  mem[VX] = mvx * inv;
  mem[VY] = mvy * inv;
  mem[VZ] = mvz * inv;
  m.moveSpeed = Math.hypot(mvx, mvy, mvz) * inv;

  // orientation: world-up with the nose along horizontal travel
  const u = m.up;
  u.x *= 0.8;
  u.z *= 0.8;
  u.y = u.y * 0.8 + 0.2;
  const ul = Math.hypot(u.x, u.y, u.z) || 1;
  u.x /= ul;
  u.y /= ul;
  u.z /= ul;
  const fw: Vec3 = m.forward;
  let fx = fw.x;
  let fy = fw.y;
  let fz = fw.z;
  if (m.moveSpeed > 0.2) {
    const il = 1 / (m.moveSpeed * dt);
    fx += (mvx * il - fx) * 0.25;
    fy += (mvy * il - fy) * 0.25;
    fz += (mvz * il - fz) * 0.25;
  }
  orthonormalizeForward(fw, u, fx, fy, fz);
  m.cell = w.cellAt(p.x, p.y, p.z);
}
