import { FZ_CONVULSE, FZ_DRAG, FZ_EXILE, HOME_UNREACHABLE, hash01, v3, v3rotateAbout, type Ant, type Behavior, type NavEx, type SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { exileCell, fungusCtx, isStalkStage, summitField } from '../systems/fungus';
import { followField } from './floodEscapeNav';
import { chase } from './playerOrder';
import { FAILED, approach, clearWorkAnim, dist, steer, stop } from './util';

/**
 * Zombie-fungus control (band `forced`: beats orders, survival and duty — only possession is
 * above it, and a possessed infected ant fights the controls, see the fungus system).
 *
 *   erratic   stumbling random walk with convulsions; drifts up and out of the nest
 *   summit    compelled climb down the `b2:summit` field to the nearest grip point
 *   gripped / fruiting / burst   clamped on, motionless (the fungus system runs the stalk)
 *   dragged   an infected ant held by a hygienic nestmate follows it out (`FZ_DRAG`)
 *   exiled    an infected ant under a player `exile` order or banished by its nestmates
 *             (`FZ_EXILE`) walks to the colony's exile spot — far from the nest — and stays
 *             there; when the summit compulsion comes it only finds stems near that spot
 */

const _d = v3();
const _c = v3();

function exiled(ant: Ant): boolean {
  return !!ant.mem[FZ_EXILE] || !!ant.mem['exiled'];
}

function stumble(sim: SimState, ant: Ant, dt: number, leashCell: number): void {
  const mem = ant.mem;
  const rng = fungusCtx(sim).rng;
  if (mem['fz.u'] === undefined || sim.tick >= mem['fz.u']) {
    const r = rng.next();
    mem[FZ_CONVULSE] = 0;
    if (r < 0.25) {
      mem['fz.m'] = 0; // convulse on the spot
      mem[FZ_CONVULSE] = 1;
      mem['fz.u'] = sim.tick + 10 + rng.int(25);
    } else if (r < 0.65) {
      mem['fz.m'] = 2; // drift up and out
      mem['fz.u'] = sim.tick + 30 + rng.int(60);
    } else {
      mem['fz.m'] = 1; // lurch somewhere
      mem['fz.t'] = rng.range(-2.6, 2.6);
      mem['fz.u'] = sim.tick + 8 + rng.int(28);
    }
    mem['fz.v'] = 0.35 + 0.75 * rng.next();
  }
  const mode = mem['fz.m'];
  if (mode === 0) {
    stop(ant);
    return;
  }
  if (leashCell >= 0) {
    sim.world.cellCenter(leashCell, _c);
    if (dist(ant.pos, _c) > 4) {
      if (approach(sim, ant, leashCell, null, 2, 0.6) === FAILED) mem['fz.ex'] = -1;
      return;
    }
  } else if (mode === 2 && ant.cell >= 0) {
    const nav = sim.nav as NavEx;
    if (!nav.isExposed(ant.cell) && followField(sim, ant, nav.skyField(), mem['fz.v'], 'fz.f', 2)) return;
  }
  v3rotateAbout(_d, ant.forward, ant.up, (mem['fz.t'] ?? 0) * dt + 0.5 * Math.sin(sim.tick * 0.7 + ant.phase * 40) * dt * 6);
  steer(ant, _d, mem['fz.v']);
}

/** Has this (exiled) ant a grip point close enough to go for? Decided once per summit stage. */
function summitAllowed(sim: SimState, ant: Ant): boolean {
  const mem = ant.mem;
  if (mem['fz.sc']) return mem['fz.sc'] === 1;
  const f = summitField(sim);
  if (!f || !f.ready) return true; // not known yet: try, decide later
  let ok = ant.cell >= 0 && f.distance(ant.cell) !== HOME_UNREACHABLE;
  if (ok && exiled(ant)) ok = f.distance(ant.cell) <= BALANCE.b2.exileSummitSteps;
  mem['fz.sc'] = ok ? 1 : 2;
  return ok;
}

function climb(sim: SimState, ant: Ant, dt: number): void {
  const nav = sim.nav as NavEx;
  const f = summitField(sim);
  const wob = 0.25 * Math.sin(sim.tick * 0.45 + ant.phase * 30);
  if (f && summitAllowed(sim, ant)) {
    if (followField(sim, ant, f, 0.8, 'fz.f')) {
      // a drunken line, not a march
      v3rotateAbout(ant.intent.dir, ant.intent.dir, ant.up, wob);
      return;
    }
    if (f.ready && ant.cell >= 0 && f.distance(ant.cell) !== HOME_UNREACHABLE && f.distance(ant.cell) > 1) {
      // wedged: let A* take it to the nearest grip cell
      let goal = ant.mem['fz.g'] ?? -1;
      if (goal < 0 || !sim.nav.isWalkable(goal)) {
        const src = fungusCtx(sim).summitSources;
        let bestD = Infinity;
        for (let i = 0; i < src.length; i++) {
          sim.world.cellCenter(src[i], _c);
          const d = dist(ant.pos, _c);
          if (d < bestD) {
            bestD = d;
            goal = src[i];
          }
        }
        ant.mem['fz.g'] = goal;
      }
      if (goal >= 0 && approach(sim, ant, goal, null, 0.8, 0.8) !== FAILED) return;
    }
  }
  // no grip point in reach: get out from under the ground, then just go UP whatever is there
  if (ant.cell >= 0 && !nav.isExposed(ant.cell) && followField(sim, ant, nav.skyField(), 0.8, 'fz.f2')) return;
  _d.x = ant.forward.x * 0.6 + wob;
  _d.y = 1;
  _d.z = ant.forward.z * 0.6 - wob;
  steer(ant, _d, 0.7);
  void dt;
}

export const infectedBehavior: Behavior = {
  id: 'infected',
  band: 'forced',
  score(ant) {
    const st = ant.infection.stage;
    if (st === 'none') return 0;
    if (isStalkStage(st)) return 10;
    if (st === 'exposed') return 0;
    if (ant.mem[FZ_DRAG]) return 5;
    if (st === 'erratic' || st === 'summit') return 3;
    // incubating: only when banished
    return exiled(ant) ? 2 : 0;
  },
  run(ant, sim, dt) {
    const st = ant.infection.stage;
    if (isStalkStage(st)) {
      stop(ant);
      ant.anim = 'grip';
      return;
    }
    clearWorkAnim(ant);
    if (st === 'summit') {
      ant.mem[FZ_CONVULSE] = 0;
      ant.mem[FZ_DRAG] = 0;
      climb(sim, ant, dt);
      return;
    }
    const dragId = ant.mem[FZ_DRAG];
    if (dragId) {
      const dragger = sim.getAnt(dragId);
      if (!dragger || dist(dragger.pos, ant.pos) > 12 || hash01(ant.id, sim.tick, 41) < 0.0008) ant.mem[FZ_DRAG] = 0; // slipped free
      else {
        ant.mem[FZ_CONVULSE] = 0;
        chase(sim, ant, dragger, 1.0, 'fz.dg', 1.1);
        return;
      }
    }
    if (exiled(ant)) {
      const colony = sim.getColony(ant.colony);
      let cell = ant.mem['fz.ex'] ?? -1;
      if (cell < 0 && colony) {
        cell = exileCell(sim, colony);
        ant.mem['fz.ex'] = cell;
      }
      if (cell >= 0) {
        if (st === 'erratic') {
          stumble(sim, ant, dt, cell);
          return;
        }
        sim.world.cellCenter(cell, _c);
        if (dist(ant.pos, _c) > 2.5) {
          if (approach(sim, ant, cell, null, 1.5) === FAILED) ant.mem['fz.ex'] = -1;
        } else stop(ant);
        return;
      }
    }
    if (st === 'erratic') stumble(sim, ant, dt, -1);
    else stop(ant);
  },
  exit(ant) {
    ant.mem[FZ_CONVULSE] = 0;
    ant.intent.mode = 'none';
  },
};
