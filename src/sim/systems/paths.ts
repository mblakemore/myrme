import type { Mover, NavEx, SimState, SimSystem } from '../../core';
import { BALANCE } from '../data/balance';
import type { PathStateEx } from './movement';

/**
 * D15 path queue servicing.
 *
 * Each tick, for every mover whose intent is `goto`:
 *   service  → issue / cancel requests, drop paths that world edits broke (re-requested at once)
 *   process  → nav spends this tick's A* node budget (resumable, FIFO, deterministic)
 *   collect  → finished paths are handed to their movers
 * then the distance fields (home fields etc.) get their BFS node budget.
 *
 * `PathState.status` as seen by behaviors:
 *   none      no goto intent (or a request is about to be issued)
 *   pending   waiting for the queue
 *   following walking a path (possibly a partial one — the mover re-requests at its end)
 *   arrived   standing on the goal cell
 *   failed    unreachable goal, or the unstuck ladder gave up; re-requested automatically after
 *             `pathRetryTicks` while the intent stays `goto` with the same goal
 *
 * Flyers (`locomotion: 'fly'`) never use A*: for them this system only tracks the goal, and
 * the movement system flies them straight there (status following → arrived).
 */

/** `sim.nav` with the A2a extensions (distance fields, sky exposure, reachability…). */
export function navOf(sim: SimState): NavEx {
  return sim.nav as NavEx;
}

function drop(sim: SimState, p: PathStateEx): void {
  if (p.ticket) sim.nav.cancelPath(p.ticket);
  p.ticket = 0;
  p.cells = null;
  p.status = 'none';
}

function service(sim: SimState, nav: NavEx, m: Mover): void {
  const it = m.intent;
  const p = m.path as PathStateEx;
  if (it.mode !== 'goto' || it.goal < 0) {
    if (p.status !== 'none' || p.goal !== -1) {
      drop(sim, p);
      p.goal = -1;
    }
    return;
  }
  // goal changed → drop whatever we had
  if (p.goal !== it.goal) {
    drop(sim, p);
    p.goal = it.goal;
    p.retryAt = 0;
    p.stuck = 0;
    p.replans = 0;
    p.partials = 0;
  }
  if (m.locomotion !== 'surface') {
    // flyers steer directly (movementFly); static movers cannot go anywhere
    if (m.locomotion === 'fly') {
      if (p.status === 'none' || p.status === 'pending' || p.status === 'failed') p.status = 'following';
    } else p.status = 'failed';
    return;
  }
  if (p.status === 'following' && p.cells && p.seq !== nav.editSeq) {
    // the world was edited since this path was last checked
    if (nav.pathBroken(p.cells, p.index, m.cell, p.seq ?? 0)) drop(sim, p);
    else p.seq = nav.editSeq;
  }
  if (p.status === 'none' || (p.status === 'failed' && p.retryAt > 0 && sim.tick >= p.retryAt)) {
    if (m.falling || m.cell < 0) return;
    if (m.cell === it.goal) {
      p.status = 'arrived';
      return;
    }
    // after a stuck re-plan ask for the raw cell-by-cell path: whatever wedged the mover may
    // have been a pulled leg
    p.ticket = nav.requestPath(m.cell, it.goal, m.clearance, (p.replans ?? 0) < 1);
    p.status = 'pending';
    p.stuck = 0;
  } else if (p.status === 'arrived' && m.cell !== it.goal && !m.falling && m.cell >= 0) {
    // pushed / fell / dug off the goal after arriving: only re-path if it drifted well away
    const w = sim.world;
    const gy = Math.floor(it.goal / (w.sx * w.sz));
    const gr = it.goal - gy * w.sx * w.sz;
    const gz = Math.floor(gr / w.sx);
    const dx = m.pos.x - (gr - gz * w.sx + 0.5);
    const dy = m.pos.y - (gy + 0.5);
    const dz = m.pos.z - (gz + 0.5);
    if (dx * dx + dy * dy + dz * dz > 6.25) p.status = 'none';
  }
}

function fail(sim: SimState, p: PathStateEx): void {
  p.status = 'failed';
  p.retryAt = sim.tick + BALANCE.a2a.pathRetryTicks;
  p.cells = null;
}

function collect(sim: SimState, nav: NavEx, m: Mover): void {
  const p = m.path as PathStateEx;
  if (p.status !== 'pending' || !p.ticket) return;
  const r = nav.takePath(p.ticket);
  if (!r) return;
  p.ticket = 0;
  if (r.status === 'failed') {
    fail(sim, p);
    return;
  }
  if (r.cells.length === 0) {
    // `found` with no cells: already there
    p.status = 'arrived';
    p.cells = null;
    return;
  }
  if (r.status === 'partial') {
    // A capped search gives a path towards the goal; the mover re-requests at its end. Bound
    // that so an effectively unreachable goal cannot keep an ant shuttling forever.
    const n = (p.partials ?? 0) + 1;
    p.partials = n;
    if (n > BALANCE.a2a.maxPartials) {
      p.partials = 0;
      fail(sim, p);
      return;
    }
  } else p.partials = 0;
  p.cells = r.cells;
  p.index = 0;
  p.stuck = 0;
  p.seq = nav.editSeq;
  p.status = 'following';
}

export const pathsSystem: SimSystem = {
  id: 'paths',
  update(sim) {
    const nav = navOf(sim);
    const B = BALANCE.a2a;
    for (const a of sim.ants) if (a.alive) service(sim, nav, a);
    for (const c of sim.creatures) if (c.alive) service(sim, nav, c);
    nav.process(B.pathBudgetPerTick);
    for (const a of sim.ants) if (a.alive) collect(sim, nav, a);
    for (const c of sim.creatures) if (c.alive) collect(sim, nav, c);
    nav.updateFields(sim.tick, B.fieldBudgetPerTick);
  },
};
