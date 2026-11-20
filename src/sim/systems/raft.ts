import { NO_DROWN_KEY, asSimEvent, b3StateOf, v3, v3clone, type Ant, type Brood, type CellIndex, type Colony, type NavEx, type RaftState, type SimState, type SimSystem, type WaterFieldEx } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { syncPrev } from '../entities';
import { alertOnce } from './colonyState';
import { envState } from './weatherEnv';
import { snapToSurface } from './movementCrawl';

/**
 * FIRE-ANT RAFTS (`rafts` capability, PLAN §2).
 *
 * Forming: when at least `minMembers` ants of a rafting colony stand in flooded cells within
 * `joinRadius` of each other (the queen, if she is among them, is the seed), they link up. The
 * queen / king / alates and every brood item in the flooded patch ride on top.
 * Afloat: each tick the raft finds the free water surface under it and re-seats its members on a
 * golden-spiral disc at that level (`anim: 'raft'`, intent none, no drowning — B2's water system
 * skips ants with `anim === 'raft'` / `mem[NO_DROWN_KEY]`). It rises and falls with the water,
 * drifts with the wind (and a slow default current), bounces off shores it cannot land on, and
 * picks up flooded nestmates within `boardRadius` of its rim.
 * Landing: after `minAfloat` seconds, as soon as a dry walkable cell is within reach of the rim
 * at about surface height — or the water under it has drained away — everybody is put ashore
 * there and the raft dissolves. The colony then waits `cooldown` before it will raft again.
 *
 * `mem['raft']` = raft id on members and riders (behaviors/raft.ts keeps them still).
 * State for render: `b3StateOf(sim).rafts[]`; events `raft` (formed / landed / lost).
 */

interface RaftCtx {
  state: RaftState;
  brood: number[];
  level: number;
}

interface Ctx {
  rafts: RaftCtx[];
  cooldown: Map<number, number>;
}

const ctxs = new WeakMap<SimState, Ctx>();
const _flooded: Ant[] = [];

function ctxOf(sim: SimState): Ctx {
  let c = ctxs.get(sim);
  if (!c) ctxs.set(sim, (c = { rafts: [], cooldown: new Map() }));
  return c;
}

/** World y of the free water surface in the column through (x, y, z), searching a little up and down; −1 if dry. */
export function waterSurfaceAt(sim: SimState, x: number, y: number, z: number): number {
  const w = sim.world;
  const water = sim.water as Partial<WaterFieldEx> & SimState['water'];
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= w.sx || cz >= w.sz) return -1;
  const y0 = Math.max(0, Math.min(w.sy - 1, Math.floor(y)));
  for (const dy of [0, -1, 1, -2, 2, -3]) {
    let cy = y0 + dy;
    if (cy < 0 || cy >= w.sy) continue;
    let c = w.index(cx, cy, cz);
    if (water.depthAt(c) <= 0.02) continue;
    while (cy + 1 < w.sy && water.depthAt(w.index(cx, cy + 1, cz)) > 0.02) cy++;
    c = w.index(cx, cy, cz);
    return cy + Math.min(1, water.depthAt(c));
  }
  return -1;
}

function isRider(a: Ant): boolean {
  return a.caste === 'queen' || a.caste === 'king' || a.caste === 'alate';
}

function join(sim: SimState, rc: RaftCtx, a: Ant): void {
  const list = isRider(a) ? rc.state.riders : rc.state.members;
  if (!list.includes(a.id)) list.push(a.id);
  // brood in its mandibles comes aboard as a rider
  const c = a.carrying;
  if (c && c.kind === 'brood') {
    const b = sim.getEntity(c.id);
    a.carrying = null;
    if (b && b.kind === 'brood' && b.alive) {
      b.carriedBy = 0;
      if (!rc.brood.includes(b.id)) rc.brood.push(b.id);
      if (!rc.state.riders.includes(b.id)) rc.state.riders.push(b.id);
    }
  }
  a.mem[CALL_MEM] = 0;
  a.mem['raft'] = rc.state.id;
  a.mem[NO_DROWN_KEY] = 1;
  a.anim = 'raft';
  a.path.status = 'none';
  a.intent.mode = 'none';
  a.thinkAt = 0;
}

/** `mem` key of an ant walking to its colony's raft (behaviors/raft.ts): the raft id. */
export const CALL_MEM = 'raft.c';

/** The raft of `colony` that is taking on nestmates, if any (behaviors/raft.ts). */
export function boardingRaft(sim: SimState, colony: number): RaftState | null {
  const list = b3StateOf(sim).rafts;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.colony === colony && r.phase !== 'landing' && r.members.length < BALANCE.b3.rafts.maxMembers) return r;
  }
  return null;
}

function canLink(a: Ant): boolean {
  return a.alive && !a.mem['raft'] && !a.possessed && a.locomotion !== 'fly' && a.cell >= 0 && !a.falling && !a.mem['raid'] && !a.mem['exiled'] && a.infection.stage !== 'gripped' && a.infection.stage !== 'fruiting' && a.infection.stage !== 'burst';
}

function release(a: Ant): void {
  a.mem['raft'] = 0;
  a.mem[NO_DROWN_KEY] = 0;
  if (a.anim === 'raft') a.anim = 'idle';
}

function tryForm(sim: SimState, colony: Colony, ctx: Ctx): void {
  const R = BALANCE.b3.rafts;
  const water = sim.water;
  _flooded.length = 0;
  let seed: Ant | null = null;
  for (const a of sim.ants) {
    if (a.colony !== colony.id || !canLink(a)) continue;
    if (water.depthAt(a.cell) <= R.floodDepth) continue;
    _flooded.push(a);
    if (a.caste === 'queen') seed = a;
  }
  // final round: a flooding NEST musters everybody near the water, in it or not — the old rule
  // (only ants already swimming) made rafts of four, because the flood response gets most ants
  // and the queen out of the water before they can link
  const nestFlood = envState(sim).colonyState(colony.id).flooded;
  if (_flooded.length < (nestFlood ? 1 : R.minMembers)) return;
  if (!seed) seed = _flooded[0];
  let group = _flooded.filter((a) => Math.hypot(a.pos.x - seed!.pos.x, a.pos.y - seed!.pos.y, a.pos.z - seed!.pos.z) <= R.joinRadius);
  if (nestFlood) {
    const near: Ant[] = [];
    for (const a of sim.ants) {
      if (a.colony !== colony.id || !canLink(a) || group.includes(a)) continue;
      const d = Math.hypot(a.pos.x - seed.pos.x, a.pos.y - seed.pos.y, a.pos.z - seed.pos.z);
      if (d <= (isRider(a) ? R.musterRadius + 4 : R.musterRadius)) near.push(a);
    }
    near.sort((a, b) => Math.hypot(a.pos.x - seed!.pos.x, a.pos.y - seed!.pos.y, a.pos.z - seed!.pos.z) - Math.hypot(b.pos.x - seed!.pos.x, b.pos.y - seed!.pos.y, b.pos.z - seed!.pos.z) || a.id - b.id);
    group = group.concat(near);
  }
  if (group.filter((a) => !isRider(a)).length < R.minMembers) return;
  // cap the body (riders always come)
  let body = 0;
  group = group.filter((a) => isRider(a) || ++body <= R.maxMembers);
  const wet = _flooded.filter((a) => group.includes(a));
  let x = 0;
  let y = 0;
  let z = 0;
  // the raft forms where the water is: centre on the swimmers, not on the dry bystanders
  for (const a of wet) {
    x += a.pos.x;
    y += a.pos.y;
    z += a.pos.z;
  }
  x /= wet.length;
  y /= wet.length;
  z /= wet.length;
  let level = waterSurfaceAt(sim, x, y, z);
  if (level < 0) {
    x = seed.pos.x;
    y = seed.pos.y;
    z = seed.pos.z;
    level = waterSurfaceAt(sim, x, y, z);
    if (level < 0) return;
  }
  const state: RaftState = { id: sim.nextId(), colony: colony.id, pos: v3(x, level, z), radius: 1, drift: v3(), members: [], riders: [], phase: 'forming', formedTick: sim.tick };
  const rc: RaftCtx = { state, brood: [], level };
  for (const a of group) join(sim, rc, a); // (brood they carry comes along)
  // brood in the flooded patch — in a flooding nest: any brood near the water — is lifted aboard
  for (const b of sim.brood) {
    if (!b.alive || b.colony !== colony.id || b.carriedBy || rc.brood.includes(b.id)) continue;
    const d = Math.hypot(b.pos.x - x, b.pos.y - y, b.pos.z - z);
    if (d > R.joinRadius + 2) continue;
    if (b.cell < 0) continue;
    if (water.depthAt(b.cell) <= 0.15 && !(nestFlood && d <= R.musterRadius && b.pos.y < level + 2.5)) continue;
    rc.brood.push(b.id);
    state.riders.push(b.id);
  }
  // a first push away from where it formed, deterministic per raft
  const ang = (state.id * 2.39996323) % (Math.PI * 2);
  state.drift.x = Math.cos(ang) * R.drift;
  state.drift.z = Math.sin(ang) * R.drift;
  ctx.rafts.push(rc);
  b3StateOf(sim).rafts.push(state);
  sim.emit(asSimEvent({ type: 'raft', tick: sim.tick, op: 'formed', raft: state.id, colony: colony.id, pos: v3clone(state.pos), members: state.members.length }));
  alertOnce(sim, colony, 'flooding', 'The colony has linked into a living raft', state.pos, 0, 20);
}

/** A dry, walkable landing cell within reach of the rim at about surface height, or −1. */
function findShore(sim: SimState, rc: RaftCtx): CellIndex {
  const nav = sim.nav as NavEx;
  const w = sim.world;
  const s = rc.state;
  const p = v3();
  for (const reach of [s.radius + 1.2, s.radius + 2.4]) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + s.id;
      const x = s.pos.x + Math.cos(a) * reach;
      const z = s.pos.z + Math.sin(a) * reach;
      const c = nav.nearestWalkable(x, rc.level + 0.6, z, 1.6);
      if (c < 0 || sim.water.depthAt(c) > 0.15) continue;
      w.cellCenter(c, p);
      if (p.y < rc.level - 0.6 || p.y > rc.level + 2.6) continue;
      // not a ceiling or a wall above the water: something to stand ON
      if (w.sample(p.x, p.y - 1.2, p.z) < 0 && w.sample(p.x, p.y - 2, p.z) < 0) continue;
      return c;
    }
  }
  return -1;
}

function dissolve(sim: SimState, ctx: Ctx, rc: RaftCtx, cell: CellIndex, op: 'landed' | 'lost'): void {
  const R = BALANCE.b3.rafts;
  const s = rc.state;
  const w = sim.world;
  const nav = sim.nav as NavEx;
  const p = v3();
  if (cell >= 0) w.cellCenter(cell, p);
  let i = 0;
  for (const id of [...s.members, ...s.riders]) {
    const e = sim.getEntity(id);
    if (!e || !e.alive) continue;
    if (e.kind === 'ant') {
      release(e);
      if (cell >= 0) {
        const a = i * 2.39996323;
        const r = 0.35 * Math.sqrt(i);
        e.pos.x = p.x + Math.cos(a) * r;
        e.pos.y = p.y;
        e.pos.z = p.z + Math.sin(a) * r;
        e.falling = !snapToSurface(w, nav, e, 6);
        e.cell = w.cellAt(e.pos.x, e.pos.y, e.pos.z);
        syncPrev(e);
        i++;
      } else e.falling = true;
      e.thinkAt = sim.tick;
    } else if (e.kind === 'brood' && cell >= 0) {
      e.pos.x = p.x;
      e.pos.y = p.y - 0.3;
      e.pos.z = p.z;
      e.cell = cell;
    }
  }
  s.phase = 'landing';
  sim.emit(asSimEvent({ type: 'raft', tick: sim.tick, op, raft: s.id, colony: s.colony, pos: v3clone(s.pos), members: s.members.length }));
  const colony = sim.getColony(s.colony);
  if (colony && op === 'landed') alertOnce(sim, colony, 'info', 'The raft has reached dry ground', s.pos, 0, 0);
  ctx.cooldown.set(s.colony, sim.tick + Math.round(R.cooldown * 30));
  ctx.rafts.splice(ctx.rafts.indexOf(rc), 1);
  const list = b3StateOf(sim).rafts;
  const k = list.indexOf(s);
  if (k >= 0) list.splice(k, 1);
}

function floatRaft(sim: SimState, ctx: Ctx, rc: RaftCtx, dt: number): void {
  const R = BALANCE.b3.rafts;
  const s = rc.state;
  const w = sim.world;
  // roll call
  for (let i = s.members.length - 1; i >= 0; i--) {
    const a = sim.getEntity(s.members[i]);
    if (!a || !a.alive || a.kind !== 'ant' || a.mem['raft'] !== s.id) s.members.splice(i, 1);
  }
  for (let i = s.riders.length - 1; i >= 0; i--) {
    const e = sim.getEntity(s.riders[i]);
    if (!e || !e.alive || (e.kind === 'brood' && e.carriedBy)) s.riders.splice(i, 1);
  }
  if (s.members.length < 2) {
    dissolve(sim, ctx, rc, (sim.nav as NavEx).nearestWalkable(s.pos.x, s.pos.y, s.pos.z, 4), 'lost');
    return;
  }
  s.radius = Math.max(0.8, R.spacing * Math.sqrt(s.members.length) * 1.05);
  const afloat = (sim.tick - s.formedTick) / 30;
  if (s.phase === 'forming' && afloat > 1) s.phase = 'afloat';

  let level = waterSurfaceAt(sim, s.pos.x, rc.level, s.pos.z);
  if (level < 0) {
    // the water is gone from under it
    dissolve(sim, ctx, rc, (sim.nav as NavEx).nearestWalkable(s.pos.x, rc.level, s.pos.z, 5), 'landed');
    return;
  }
  // drift: wind plus the raft's own slow current; shores turn it round
  const wind = sim.weather.wind;
  const vx = s.drift.x + wind.x * R.windFactor;
  const vz = s.drift.z + wind.z * R.windFactor;
  const nx = s.pos.x + vx * dt;
  const nz = s.pos.z + vz * dt;
  const ahead = waterSurfaceAt(sim, nx + Math.sign(vx) * s.radius, level, nz + Math.sign(vz) * s.radius);
  if (ahead >= 0 && nx > 1 && nz > 0.6 && nx < w.sx - 1 && nz < w.sz - 0.6) {
    s.pos.x = nx;
    s.pos.z = nz;
    const l2 = waterSurfaceAt(sim, nx, level, nz);
    if (l2 >= 0) level = l2;
  } else {
    // turn by the golden angle and try again next tick
    const c = Math.cos(2.39996323);
    const sn = Math.sin(2.39996323);
    const dx = s.drift.x * c - s.drift.z * sn;
    s.drift.z = s.drift.x * sn + s.drift.z * c;
    s.drift.x = dx;
  }
  rc.level += (level - rc.level) * Math.min(1, dt * 6);
  s.pos.y = rc.level;

  if (afloat >= R.minAfloat && sim.tick % 6 === 0) {
    const shore = findShore(sim, rc);
    if (shore >= 0) {
      dissolve(sim, ctx, rc, shore, 'landed');
      return;
    }
  }
  // late joiners: swimmers near the rim, nestmates that answered the call (behaviors/raft.ts)
  // and have reached the water's edge, royals within a few steps; loose brood in the water
  if (sim.tick % 10 === 3) {
    for (const a of sim.ants) {
      if (a.colony !== s.colony || !canLink(a)) continue;
      const rider = isRider(a);
      if (!rider && s.members.length >= R.maxMembers) continue;
      const dh = Math.hypot(a.pos.x - s.pos.x, a.pos.z - s.pos.z);
      if (Math.abs(a.pos.y - s.pos.y) > 3) continue;
      const called = a.mem[CALL_MEM] === s.id;
      const wet = sim.water.depthAt(a.cell) > (called ? 0.1 : R.floodDepth);
      if (wet ? dh > s.radius + R.boardRadius : !(called || rider) || dh > s.radius + (rider ? 2.5 : 1.4)) continue;
      join(sim, rc, a);
    }
    for (const b of sim.brood) {
      if (!b.alive || b.colony !== s.colony || b.carriedBy || b.cell < 0 || rc.brood.includes(b.id)) continue;
      if (sim.water.depthAt(b.cell) <= 0.15 || Math.abs(b.pos.y - s.pos.y) > 3) continue;
      if (Math.hypot(b.pos.x - s.pos.x, b.pos.z - s.pos.z) > s.radius + R.boardRadius) continue;
      rc.brood.push(b.id);
      s.riders.push(b.id);
    }
  }
  // seat everybody
  let k = 0;
  for (const id of s.members) {
    const a = sim.getEntity(id) as Ant;
    const ang = k * 2.39996323;
    const r = R.spacing * Math.sqrt(k + 0.5);
    seat(sim, a, s.pos.x + Math.cos(ang) * r, rc.level + 0.05, s.pos.z + Math.sin(ang) * r, ang);
    k++;
  }
  k = 0;
  for (const id of s.riders) {
    const e = sim.getEntity(id);
    if (!e) continue;
    const ang = k * 2.39996323 + 1;
    const r = Math.min(s.radius * 0.6, 0.3 * Math.sqrt(k));
    if (e.kind === 'ant') seat(sim, e, s.pos.x + Math.cos(ang) * r, rc.level + 0.3, s.pos.z + Math.sin(ang) * r, ang);
    else if (e.kind === 'brood') {
      const b = e as Brood;
      b.pos.x = s.pos.x + Math.cos(ang) * r;
      b.pos.y = rc.level + 0.25;
      b.pos.z = s.pos.z + Math.sin(ang) * r;
      // keep its cell reference just above the water so nothing counts it as submerged
      b.cell = w.inBounds(Math.floor(b.pos.x), Math.floor(rc.level) + 1, Math.floor(b.pos.z)) ? w.index(Math.floor(b.pos.x), Math.floor(rc.level) + 1, Math.floor(b.pos.z)) : b.cell;
    }
    k++;
  }
}

function seat(sim: SimState, a: Ant, x: number, y: number, z: number, heading: number): void {
  const w = sim.world;
  a.pos.x = Math.max(0.5, Math.min(w.sx - 0.5, x));
  a.pos.y = y;
  a.pos.z = Math.max(0.3, Math.min(w.sz - 0.3, z));
  a.up.x = 0;
  a.up.y = 1;
  a.up.z = 0;
  a.forward.x = Math.cos(heading);
  a.forward.y = 0;
  a.forward.z = Math.sin(heading);
  a.falling = false;
  a.cell = w.cellAt(a.pos.x, a.pos.y, a.pos.z);
  a.intent.mode = 'none';
  a.path.status = 'none';
  a.anim = 'raft';
  a.mem[NO_DROWN_KEY] = 1;
}

export const raftSystem: SimSystem = {
  id: 'raft',
  update(sim, dt) {
    const ctx = ctxOf(sim);
    for (let i = ctx.rafts.length - 1; i >= 0; i--) floatRaft(sim, ctx, ctx.rafts[i], dt);
    if (sim.tick % 10 !== 5 || sim.water.floodedCount === 0) return;
    for (const colony of sim.colonies) {
      if (!colony.alive || !getSpecies(colony.species).caps.rafts) continue;
      if (sim.tick < (ctx.cooldown.get(colony.id) ?? 0)) continue;
      if (ctx.rafts.some((r) => r.state.colony === colony.id)) continue;
      tryForm(sim, colony, ctx);
    }
  },
};
