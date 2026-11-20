import { ISO, v3, type Mover, type NavApi, type Vec3, type VoxelWorld } from '../../core';
import { samplerFor, type FieldSampler } from './movementField';

/**
 * D11 surface locomotion kernel — shared by every surface walker (ants, creatures, possessed
 * ants). Pure functions of (world, mover); no sim state, so it is directly unit/soak-testable.
 *
 * Model
 *  - The body centre `pos` is constrained to the level set `sdf(pos) = -rideHeight` of the
 *    trilinear density field (a smooth offset of the rendered isosurface).
 *  - A step moves along the wish direction projected onto the local tangent plane (normal from
 *    the smoothed density gradient at the current position), in sub-steps of ≤ MAX_SUBSTEP,
 *    each followed by a few clamped Newton iterations back onto the level set.
 *  - `up` follows the surface normal with exponential smoothing; `forward` is kept ⟂ `up`.
 *  - Because the field is a distance field and every feature is ≥ ~3 voxels (D4), the level set
 *    is smooth around convex and concave corners, so floors, walls, ceilings, tunnels and stems
 *    need no special cases.
 *
 * Obstacles
 *  - A sub-step is refused when it would not land cleanly on a well-formed part of the level
 *    set (acute crevices where the gradient cancels out, the world edge) or, for movers with a
 *    clearance radius > 1 (D11), when the body would not fit. A refused sub-step is retried
 *    deflected to either side (±50°, ±95° about the normal), so movers slide along obstacles
 *    and crevice mouths instead of stopping dead (CRAWL_DEFLECTED). Only if every direction is
 *    refused does the mover stay put (CRAWL_BLOCKED).
 *
 * Normals
 *  - Gradient of the trilinear field; where it is too weak (D11 fallback chain) the summed
 *    offsets to solid neighbour cells; failing that the previous `up`.
 *
 * Failure handling
 *  - Gradient vanishes far from any surface (sdf clamped at −2): CRAWL_LOST → caller starts a
 *    D12 fall.
 *  - Ended inside solid / non-finite: CRAWL_EMBEDDED → snapped to the nearest walkable cell.
 */

export const CRAWL_OK = 0;
export const CRAWL_LOST = 1;
export const CRAWL_EMBEDDED = 2;
/** A sub-step was refused in every direction (or clamped at the world edge): the mover did not advance fully. */
export const CRAWL_BLOCKED = 4;
/** A sub-step was refused straight ahead and taken deflected to one side. */
export const CRAWL_DEFLECTED = 8;

// module-local copies of hot imported bindings (imports are live lookups)
const ISO_ = ISO;
const sampler = samplerFor;

const MAX_SUBSTEP = 0.12;
const NEWTON_ITERS = 4;
const NEWTON_MAX_STEP = 0.3;
/** Per-tick blend of `up` towards the measured surface normal. */
const UP_SMOOTH = 0.35;
/** Per-tick blend of `forward` towards the travel direction. */
const TURN_SMOOTH = 0.3;
/** sdf below which a mover is considered detached from every surface. */
const LOST_SDF = -1.6;
/** sdf above which a mover is considered embedded. */
const EMBED_SDF = 0.35;
/** A resting body further than this from its level set has lost its footing (D12 fall). */
const GLUE_REACH = 1.0;
/** Margin kept from the world box on open maps. */
const EDGE_MARGIN = 0.75;
/** Minimum |∇sdf| for a position to count as a well-formed surface (see crawlStep). */
export const MIN_GRADIENT = 0.3;
/** Gradient length below which the direction is not trusted as a normal. */
const NORMAL_MIN_GRADIENT = 0.14;

/** Deflection angles tried when the straight sub-step is refused (cos, sin). */
const DEFLECT_COS = [Math.cos(0.87), Math.cos(1.66)];
const DEFLECT_SIN = [Math.sin(0.87), Math.sin(1.66)];

/** Diagnostics of the last projection (module-level to avoid allocation). */
let lastGrad = 0;
let lastErr = 0;

const _n = v3();
const _t = v3();
const _try = v3();
const _nn = v3();

/**
 * D11 fallback normal: sum of offsets from solid neighbour cells (points away from the solid).
 * Returns false if the 3×3×3 neighbourhood is all air or the offsets cancel.
 */
function neighbourNormal(world: VoxelWorld, p: Vec3, out: Vec3): boolean {
  const ix = Math.floor(p.x);
  const iy = Math.floor(p.y);
  const iz = Math.floor(p.z);
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (world.densityAt(ix + dx, iy + dy, iz + dz) < ISO_) continue;
        const ox = p.x - (ix + dx + 0.5);
        const oy = p.y - (iy + dy + 0.5);
        const oz = p.z - (iz + dz + 0.5);
        const l2 = ox * ox + oy * oy + oz * oz + 0.25;
        nx += ox / l2;
        ny += oy / l2;
        nz += oz / l2;
      }
  const l = Math.hypot(nx, ny, nz);
  if (l < 0.05) return false;
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return true;
}

function project(f: FieldSampler, p: Vec3, ride: number, outNormal: Vec3): number {
  let s = 0;
  let gl = 0;
  for (let i = 0; ; i++) {
    s = f.sampleGrad(p.x, p.y, p.z);
    const gx = f.gx;
    const gy = f.gy;
    const gz = f.gz;
    const g2 = gx * gx + gy * gy + gz * gz;
    gl = Math.sqrt(g2);
    const err = s + ride;
    if (i >= NEWTON_ITERS || g2 < 0.02 || (err < 0.004 && err > -0.004)) break;
    // Newton step along the gradient, clamped so a kinked field can never throw the body far.
    let k = err / g2;
    const stepLen = k * gl;
    if (stepLen > NEWTON_MAX_STEP) k = NEWTON_MAX_STEP / gl;
    else if (stepLen < -NEWTON_MAX_STEP) k = -NEWTON_MAX_STEP / gl;
    p.x -= gx * k;
    p.y -= gy * k;
    p.z -= gz * k;
  }
  lastGrad = gl;
  lastErr = s + ride;
  if (!(s === s) || !(gl === gl)) return CRAWL_EMBEDDED;
  const hasNormal = gl > NORMAL_MIN_GRADIENT;
  if (hasNormal) {
    outNormal.x = -f.gx / gl;
    outNormal.y = -f.gy / gl;
    outNormal.z = -f.gz / gl;
  }
  if (s > EMBED_SDF) return CRAWL_EMBEDDED;
  if (!hasNormal || s < LOST_SDF) return CRAWL_LOST;
  return CRAWL_OK;
}

/**
 * Pulls `p` onto the level set sdf = -ride with clamped Newton steps along the gradient and
 * writes the surface normal there to `outNormal` (left untouched if the gradient vanishes).
 * Returns CRAWL_OK / CRAWL_LOST / CRAWL_EMBEDDED.
 */
export function projectToSurface(world: VoxelWorld, p: Vec3, ride: number, outNormal: Vec3): number {
  return project(samplerFor(world), p, ride, outNormal);
}

function clampToWorld(world: VoxelWorld, p: Vec3): boolean {
  const m = world.boundary === 'open' ? EDGE_MARGIN : 0.02;
  let c = false;
  if (p.x < m) {
    p.x = m;
    c = true;
  } else if (p.x > world.sx - m) {
    p.x = world.sx - m;
    c = true;
  }
  if (p.z < m) {
    p.z = m;
    c = true;
  } else if (p.z > world.sz - m) {
    p.z = world.sz - m;
    c = true;
  }
  if (p.y < 0.02) {
    p.y = 0.02;
    c = true;
  } else if (p.y > world.sy - m) {
    p.y = world.sy - m;
    c = true;
  }
  return c;
}

/**
 * D11 clearance for big movers: the body sphere of radius `clearance`, resting on the surface
 * at `p` with normal `n`, must be in air. Mirrors `Nav.hasClearance` (with a little slack so a
 * mover standing on a nav-approved cell never fails).
 */
function bodyFits(f: FieldSampler, p: Vec3, n: Vec3, clearance: number): boolean {
  const probes = Math.min(8, Math.floor(clearance * 2));
  for (let t = 1; t <= probes; t++) {
    const s = f.sample(p.x + n.x * t, p.y + n.y * t, p.z + n.z * t);
    if (s > -Math.min(t * 0.6, 1.2) + 0.3) return false;
  }
  return true;
}

/**
 * Tries one sub-step of length `h` from `p` along tangent direction (tx,ty,tz) (unit). On
 * success `p` holds the new position and `_n` its normal; on refusal `p` is restored.
 * Returns 0 = refused, 1 = accepted, 2 = accepted but clamped at the world edge.
 */
function trySubstep(world: VoxelWorld, f: FieldSampler, p: Vec3, tx: number, ty: number, tz: number, h: number, ride: number, clearance: number): number {
  const ox = p.x;
  const oy = p.y;
  const oz = p.z;
  p.x += tx * h;
  p.y += ty * h;
  p.z += tz * h;
  const clamped = clampToWorld(world, p);
  const st = project(f, p, ride, _nn);
  // Accept the sub-step only if it landed cleanly on the level set, on a well-formed part
  // of the surface (gradient not cancelling out, as it does deep inside acute crevices —
  // e.g. where a log rests on the ground) and without a jump.
  const jx = p.x - ox;
  const jy = p.y - oy;
  const jz = p.z - oz;
  const jump2 = jx * jx + jy * jy + jz * jz;
  let ok = st === CRAWL_OK && lastGrad >= MIN_GRADIENT && lastErr <= 0.05 && lastErr >= -0.05 && jump2 <= (h + 0.1) * (h + 0.1);
  // a "step" that went nowhere (pushed straight back by the projection) is a refusal too
  if (ok && jump2 < h * h * 0.04) ok = false;
  if (ok && clearance > 1 && !bodyFits(f, p, _nn, clearance)) {
    // a mover already wedged somewhere too tight may still move (to get out)
    _try.x = ox;
    _try.y = oy;
    _try.z = oz;
    if (bodyFits(f, _try, _n, clearance)) ok = false;
  }
  if (!ok) {
    p.x = ox;
    p.y = oy;
    p.z = oz;
    return 0;
  }
  _n.x = _nn.x;
  _n.y = _nn.y;
  _n.z = _nn.z;
  return clamped ? 2 : 1;
}

/**
 * Advance a surface mover by one tick.
 * @param wish  desired travel direction in world space (any length; null/zero = stand still)
 * @param speed world units per second
 * @param alignForward turn `forward` towards the travel direction (false for possessed ants,
 *                     whose heading is driven by yaw input)
 * @returns bit flags CRAWL_*
 */
export function crawlStep(world: VoxelWorld, m: Mover, wish: Vec3 | null, speed: number, dt: number, alignForward: boolean): number {
  const f = sampler(world);
  const p = m.pos;
  let flags = CRAWL_OK;
  let moved = 0;
  let settled = false;
  // current surface normal (fall back to the smoothed up)
  _n.x = m.up.x;
  _n.y = m.up.y;
  _n.z = m.up.z;

  const dist = wish ? speed * dt : 0;
  let hasDir = false;
  if (dist > 1e-6 && wish) {
    const steps = Math.ceil(dist / MAX_SUBSTEP);
    const h = dist / steps;
    // which side to try first when deflecting: stable per mover so it does not dither
    const side = m.id & 1 ? 1 : -1;
    for (let i = 0; i < steps; i++) {
      if (i === 0) {
        f.sampleGrad(p.x, p.y, p.z);
        const gl = Math.sqrt(f.gx * f.gx + f.gy * f.gy + f.gz * f.gz);
        if (gl > NORMAL_MIN_GRADIENT) {
          _n.x = -f.gx / gl;
          _n.y = -f.gy / gl;
          _n.z = -f.gz / gl;
        } else neighbourNormal(world, p, _n);
      }
      const d = wish.x * _n.x + wish.y * _n.y + wish.z * _n.z;
      let tx = wish.x - _n.x * d;
      let ty = wish.y - _n.y * d;
      let tz = wish.z - _n.z * d;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl < 1e-5) break;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      hasDir = true;
      _t.x = tx;
      _t.y = ty;
      _t.z = tz;
      const ox = p.x;
      const oy = p.y;
      const oz = p.z;
      let r = trySubstep(world, f, p, tx, ty, tz, h, m.rideHeight, m.clearance);
      if (r === 0) {
        // deflect: rotate the tangent about the normal, nearer angles first, preferred side first
        const nx = _n.x;
        const ny = _n.y;
        const nz = _n.z;
        // b = n × t (unit, in the tangent plane, 90° to the left/right of t)
        const bx = ny * tz - nz * ty;
        const by = nz * tx - nx * tz;
        const bz = nx * ty - ny * tx;
        for (let a = 0; a < 2 && r === 0; a++) {
          for (let sgn = 0; sgn < 2 && r === 0; sgn++) {
            const sn = DEFLECT_SIN[a] * (sgn === 0 ? side : -side);
            const cs = DEFLECT_COS[a];
            r = trySubstep(world, f, p, tx * cs + bx * sn, ty * cs + by * sn, tz * cs + bz * sn, h, m.rideHeight, m.clearance);
          }
        }
        if (r === 0) {
          flags |= CRAWL_BLOCKED;
          settled = false;
          break;
        }
        flags |= CRAWL_DEFLECTED;
      }
      if (r === 2) flags |= CRAWL_BLOCKED;
      settled = true;
      moved += Math.hypot(p.x - ox, p.y - oy, p.z - oz);
    }
  }
  // Final settle (also the whole step when standing still — keeps movers glued after edits).
  if (!settled) {
    // Standing still (or the step was refused). Re-project only if the body is measurably off
    // the level set (world edited underneath, just landed): in weak-gradient spots a needless
    // Newton solve would make a resting mover creep.
    const e0 = f.sample(p.x, p.y, p.z) + m.rideHeight;
    if (e0 < -GLUE_REACH) {
      // The surface is gone from under the body (dug away): do not reel it in across open air
      // towards whatever wall is nearest — D12 says it falls.
      flags |= CRAWL_LOST;
    } else if (!(e0 < 0.06 && e0 > -0.06)) {
      const st = project(f, p, m.rideHeight, _n);
      flags |= st;
      // weak-gradient spot: orient by the solid neighbourhood rather than freezing a stale up
      if (st === CRAWL_LOST && lastErr > LOST_SDF + m.rideHeight && neighbourNormal(world, p, _n)) flags &= ~CRAWL_LOST;
      clampToWorld(world, p);
    }
  }

  // orientation
  const u = m.up;
  let ux = u.x + (_n.x - u.x) * UP_SMOOTH;
  let uy = u.y + (_n.y - u.y) * UP_SMOOTH;
  let uz = u.z + (_n.z - u.z) * UP_SMOOTH;
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-4) {
    ux = _n.x;
    uy = _n.y;
    uz = _n.z;
    ul = Math.hypot(ux, uy, uz) || 1;
  }
  u.x = ux / ul;
  u.y = uy / ul;
  u.z = uz / ul;

  const fw = m.forward;
  let fx = fw.x;
  let fy = fw.y;
  let fz = fw.z;
  if (alignForward && hasDir) {
    fx += (_t.x - fx) * TURN_SMOOTH;
    fy += (_t.y - fy) * TURN_SMOOTH;
    fz += (_t.z - fz) * TURN_SMOOTH;
  }
  orthonormalizeForward(fw, u, fx, fy, fz);
  m.moveSpeed = dt > 0 ? moved / dt : 0;
  return flags;
}

/** Writes into `f` the unit vector closest to (fx,fy,fz) that is perpendicular to unit `u`. */
export function orthonormalizeForward(f: Vec3, u: Vec3, fx: number, fy: number, fz: number): void {
  const d = fx * u.x + fy * u.y + fz * u.z;
  fx -= u.x * d;
  fy -= u.y * d;
  fz -= u.z * d;
  let fl = Math.hypot(fx, fy, fz);
  if (fl < 1e-4) {
    // heading was (anti)parallel to the new up: pick any perpendicular
    if (Math.abs(u.y) < 0.9) {
      fx = u.z;
      fy = 0;
      fz = -u.x;
    } else {
      fx = 0;
      fy = -u.z;
      fz = u.y;
    }
    fl = Math.hypot(fx, fy, fz) || 1;
  }
  f.x = fx / fl;
  f.y = fy / fl;
  f.z = fz / fl;
}

const _c = v3();

/**
 * Places a mover on the surface nearest to its current position: snaps to the nearest walkable
 * cell centre if needed, projects, and aligns `up`/`forward`. Used for spawning and as the
 * unstuck fallback. Returns false if no walkable cell is within `radius`.
 */
export function snapToSurface(world: VoxelWorld, nav: NavApi, m: Mover, radius = 8): boolean {
  const cell = nav.nearestWalkable(m.pos.x, m.pos.y, m.pos.z, radius, m.clearance);
  if (cell < 0) return false;
  const f = samplerFor(world);
  world.cellCenter(cell, _c);
  m.pos.x = _c.x;
  m.pos.y = _c.y;
  m.pos.z = _c.z;
  clampToWorld(world, m.pos);
  let st = project(f, m.pos, m.rideHeight, _n);
  for (let i = 0; i < 3 && (lastErr > 0.01 || lastErr < -0.01); i++) st = project(f, m.pos, m.rideHeight, _n);
  if (st === CRAWL_OK) {
    m.up.x = _n.x;
    m.up.y = _n.y;
    m.up.z = _n.z;
  }
  orthonormalizeForward(m.forward, m.up, m.forward.x, m.forward.y, m.forward.z);
  m.cell = cell;
  m.falling = false;
  return true;
}

/**
 * Nav cell for a mover standing at `m.pos`: the containing cell if walkable, else the cell half
 * a voxel further out along `up`, else the nearest walkable cell within 2.
 */
export function moverCell(world: VoxelWorld, nav: NavApi, m: Mover): number {
  const p = m.pos;
  let c = world.cellAt(p.x, p.y, p.z);
  if (c >= 0 && nav.isWalkable(c)) return c;
  c = world.cellAt(p.x + m.up.x * 0.55, p.y + m.up.y * 0.55, p.z + m.up.z * 0.55);
  if (c >= 0 && nav.isWalkable(c)) return c;
  return nav.nearestWalkable(p.x, p.y, p.z, 2);
}
