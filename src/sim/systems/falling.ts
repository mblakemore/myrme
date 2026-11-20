import { v3, type Brood, type FoodSource, type Item, type Mover, type SimState, type SimSystem, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { CRAWL_OK, orthonormalizeForward, projectToSurface } from './movementCrawl';
import { samplerFor } from './movementField';

/**
 * D12 loss of support.
 *
 *  - Movers (ants, creatures — `surface` and `static`; flyers never fall) flagged `falling` by
 *    the movement system drop along −y until they come within reach of a surface, re-attach and
 *    carry on; no damage. The `fell` event is emitted by movement when the fall starts.
 *  - Loose things — items (food, corpses, debris), brood and food sources that nobody carries —
 *    are checked for support right after every world edit that touches them and otherwise once
 *    a second. Unsupported ones fall the same way; ones buried by a `fill` are lifted to the
 *    nearest walkable cell. On landing they are seated on the surface (`up` = surface normal).
 *
 * Brood and food sources have no `falling` flag in the contract, so the set of those currently
 * in the air is kept here per simulation (plain deterministic state).
 */

/** Height above the surface at which loose things rest. */
const LOOSE_RIDE = 0.12;

interface FallCtx {
  /** Edit boxes (x0,y0,z0,x1,y1,z1) not yet applied to loose things. */
  boxes: number[];
  /** Brood / food sources currently falling. */
  loose: (Brood | FoodSource)[];
}

const ctxs = new WeakMap<SimState, FallCtx>();
const _n = v3();

function fallMover(sim: SimState, m: Mover, dt: number): void {
  const w = sim.world;
  const f = samplerFor(w);
  m.moveSpeed = 0;
  const step = BALANCE.a2a.fallSpeed * dt;
  // sub-step so a fast fall cannot tunnel through a thin floor
  const n = Math.ceil(step / 0.4);
  // touch down once the body is within a sub-step of its riding height (no visible snap)
  const reach = m.rideHeight + 0.45;
  for (let i = 0; i < n; i++) {
    m.pos.y -= step / n;
    if (m.pos.y <= 0.5) {
      m.pos.y = 0.5;
      break;
    }
    if (f.sample(m.pos.x, m.pos.y, m.pos.z) > -reach) break;
  }
  // ease up towards world-up while airborne
  const u = m.up;
  u.x *= 0.8;
  u.z *= 0.8;
  u.y = u.y * 0.8 + 0.2;
  const ul = Math.hypot(u.x, u.y, u.z) || 1;
  u.x /= ul;
  u.y /= ul;
  u.z /= ul;
  orthonormalizeForward(m.forward, u, m.forward.x, m.forward.y, m.forward.z);

  if (f.sample(m.pos.x, m.pos.y, m.pos.z) > -reach || m.pos.y <= 0.5) {
    if (projectToSurface(w, m.pos, m.rideHeight, _n) === CRAWL_OK) {
      m.falling = false;
      m.cell = sim.nav.nearestWalkable(m.pos.x, m.pos.y, m.pos.z, 2);
    } else if (m.pos.y <= 0.5) {
      // bottom of the world and still nothing to stand on: give up falling to avoid a loop
      m.falling = false;
      m.cell = sim.nav.nearestWalkable(m.pos.x, m.pos.y, m.pos.z, 6);
    }
  }
}

/** Seats a loose thing on the surface under/around `e.pos`; returns false if nothing is in reach. */
function seat(sim: SimState, e: { pos: Vec3; up: Vec3; cell: number }): boolean {
  const cell = sim.nav.nearestWalkable(e.pos.x, e.pos.y, e.pos.z, 3);
  if (cell < 0) return false;
  const w = sim.world;
  if (w.cellAt(e.pos.x, e.pos.y, e.pos.z) !== cell && samplerFor(w).sample(e.pos.x, e.pos.y, e.pos.z) > 0.1) w.cellCenter(cell, e.pos);
  if (projectToSurface(w, e.pos, LOOSE_RIDE, _n) === CRAWL_OK) {
    e.up.x = _n.x;
    e.up.y = _n.y;
    e.up.z = _n.z;
  }
  e.cell = cell;
  return true;
}

/** One falling tick for a loose thing. Returns true when it has landed. */
function fallLoose(sim: SimState, e: { pos: Vec3; up: Vec3; cell: number }, dt: number): boolean {
  const f = samplerFor(sim.world);
  const step = BALANCE.a2a.fallSpeed * dt;
  const n = Math.ceil(step / 0.4);
  for (let i = 0; i < n; i++) {
    e.pos.y -= step / n;
    if (e.pos.y <= 0.5) {
      e.pos.y = 0.5;
      break;
    }
    if (f.sample(e.pos.x, e.pos.y, e.pos.z) > -0.5) break;
  }
  if (e.pos.y > 0.5 && f.sample(e.pos.x, e.pos.y, e.pos.z) <= -0.5) return false;
  e.up.x = 0;
  e.up.y = 1;
  e.up.z = 0;
  if (!seat(sim, e)) e.cell = sim.nav.nearestWalkable(e.pos.x, e.pos.y, e.pos.z, 6);
  return true;
}

/**
 * Support check for a resting loose thing: 0 = fine, 1 = hanging in the air (must fall),
 * 2 = buried (was lifted out).
 */
function checkLoose(sim: SimState, e: { pos: Vec3; up: Vec3; cell: number }): number {
  const s = samplerFor(sim.world).sample(e.pos.x, e.pos.y, e.pos.z);
  if (s > 0.25) {
    // buried by a fill: pop out at the nearest walkable cell
    const cell = sim.nav.nearestWalkable(e.pos.x, e.pos.y, e.pos.z, 5);
    if (cell >= 0) {
      sim.world.cellCenter(cell, e.pos);
      seat(sim, e);
    }
    return 2;
  }
  if (s < -1.1) return 1;
  if (!sim.nav.isWalkable(e.cell)) {
    // the surface moved a little: re-seat if something is still in reach, else fall
    return seat(sim, e) ? 0 : 1;
  }
  return 0;
}

function inBoxes(boxes: number[], p: Vec3): boolean {
  for (let k = 0; k < boxes.length; k += 6) {
    if (p.x >= boxes[k] && p.y >= boxes[k + 1] && p.z >= boxes[k + 2] && p.x <= boxes[k + 3] && p.y <= boxes[k + 4] && p.z <= boxes[k + 5]) return true;
  }
  return false;
}

export const fallingSystem: SimSystem = {
  id: 'falling',
  init(sim) {
    const ctx: FallCtx = { boxes: [], loose: [] };
    ctxs.set(sim, ctx);
    sim.world.onEdit((_res, c, radius) => {
      // an edit changes the field up to 2 voxels beyond the brush; things resting just
      // outside can lose their footing too
      const r = radius + 3;
      if (ctx.boxes.length < 6 * 64) ctx.boxes.push(c.x - r, c.y - r, c.z - r, c.x + r, c.y + r, c.z + r);
      else {
        // too many edits in one tick: check everything once
        ctx.boxes.length = 0;
        ctx.boxes.push(-1, -1, -1, sim.world.sx + 1, sim.world.sy + 1, sim.world.sz + 1);
      }
    });
  },
  update(sim, dt) {
    for (const a of sim.ants) if (a.alive && a.falling && a.locomotion !== 'fly') fallMover(sim, a, dt);
    for (const c of sim.creatures) if (c.alive && c.falling && c.locomotion !== 'fly') fallMover(sim, c, dt);

    const ctx = ctxs.get(sim);
    const boxes = ctx && ctx.boxes.length ? ctx.boxes : null;
    for (const it of sim.items) {
      if (!it.alive || it.carriedBy) continue;
      if (it.falling) {
        if (fallLoose(sim, it, dt)) it.falling = false;
      } else if ((boxes && inBoxes(boxes, it.pos)) || (sim.tick + it.id) % 30 === 0) {
        if (checkLoose(sim, it) === 1) it.falling = true;
      }
    }
    if (!ctx) return;
    // brood & food sources: no flag in the contract → tracked in `ctx.loose`
    const loose = ctx.loose;
    for (let i = loose.length - 1; i >= 0; i--) {
      const e = loose[i];
      if (!e.alive || (e.kind === 'brood' && e.carriedBy) || fallLoose(sim, e, dt)) {
        loose[i] = loose[loose.length - 1];
        loose.pop();
      }
    }
    for (const b of sim.brood) {
      if (!b.alive || b.carriedBy) continue;
      if ((boxes && inBoxes(boxes, b.pos)) || (sim.tick + b.id) % 30 === 0) {
        if (!loose.includes(b) && checkLoose(sim, b) === 1) loose.push(b);
      }
    }
    for (const fs of sim.foodSources) {
      if (!fs.alive) continue;
      if ((boxes && inBoxes(boxes, fs.pos)) || (sim.tick + fs.id) % 30 === 0) {
        if (!loose.includes(fs) && checkLoose(sim, fs) === 1) loose.push(fs);
      }
    }
    if (boxes) boxes.length = 0;
  },
};
