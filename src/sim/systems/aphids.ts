import { CREATURE_MEM, HOME_UNREACHABLE, asSimEvent, b3StateOf, getMapExtras, v3, v3clone, type AphidHerdState, type Creature, type FoodSource, type Job, type NavEx, type SimState, type SimSystem } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { alertOnce, getExt } from './colonyState';
import { bumpDemand, closeJob, postJob } from './keeperEnv';

/**
 * APHID HERDING (`herdsAphids`, PLAN §2 — garden ants, or any species with the flag).
 *
 * One herd per `aphidStem` map site (tests may add herds with `addAphidHerd`). A herd is a set
 * of `aphid` creatures sitting on the stem plus the stem's `honeydew` FoodSource:
 *  - each aphid secretes honeydew into the source (`regen` and `maxAmount` follow the herd size);
 *    a TENDED herd secretes ~3× as much and breeds ~3× as fast, up to `capacity`
 *  - a herd is wild until an ant of a herding colony comes within `discoverRadius`: that colony
 *    becomes the owner (`Creature.colony` of the aphids), gets an info alert, and from then on a
 *    `herdAphids` job keeps shepherds there (behaviors/herdAphids.ts: guard / stroke the aphids,
 *    then carry a crop of honeydew home)
 *  - any ant of the owner within `tendRadius` counts as tending — so a player `gather` order on
 *    the aphids (the orders system retargets it to the honeydew) tends the herd as well
 *  - aphids carry the B1 `prey` tag: ladybirds and other predators eat them; a herd that loses
 *    its last aphid is gone (`aphid` event `lost`) and its honeydew dries up.
 *
 * State for render/UI: `b3StateOf(sim).herds[]`; events `aphid`.
 */

interface HerdCtx {
  state: AphidHerdState;
  slot: { job: Job | null };
  breed: number;
  lastTend: number;
  /** Tick the current owner adopted the herd (a fresh claim is not contestable at once). */
  claimedAt: number;
  stocked: boolean;
  lastMilkEvent: number;
}

interface Ctx {
  herds: HerdCtx[];
  ready: boolean;
}

const ctxs = new WeakMap<SimState, Ctx>();
const _p = v3();

function ctxOf(sim: SimState): Ctx {
  let c = ctxs.get(sim);
  if (!c) ctxs.set(sim, (c = { herds: [], ready: false }));
  return c;
}

/** Register a herd on a stem from `pos` to `end` (map sites do this automatically). */
export function addAphidHerd(sim: SimState, pos: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }, radius = 3): AphidHerdState {
  const A = BALANCE.b3.aphids;
  const state: AphidHerdState = { id: sim.nextId(), pos: v3(pos.x, pos.y, pos.z), end: v3(end.x, end.y, end.z), radius, sourceId: 0, aphids: [], capacity: A.capacity, owner: 0, tenders: 0, tended: false, honeydewRate: 0 };
  ctxOf(sim).herds.push({ state, slot: { job: null }, breed: 0, lastTend: -1e9, claimedAt: -1e9, stocked: false, lastMilkEvent: 0 });
  b3StateOf(sim).herds.push(state);
  return state;
}

export function herdOf(sim: SimState, herdId: number): AphidHerdState | null {
  for (const h of ctxOf(sim).herds) if (h.state.id === herdId) return h.state;
  return null;
}

/** A shepherd stroked the herd: marks it tended; returns the honeydew source to drink from. */
export function milkHerd(sim: SimState, herdId: number, by: number): FoodSource | null {
  const ctx = ctxOf(sim);
  const h = ctx.herds.find((x) => x.state.id === herdId);
  if (!h) return null;
  h.lastTend = sim.tick;
  const src = sim.getEntity(h.state.sourceId);
  if (!src || src.kind !== 'food') return null;
  if (sim.tick - h.lastMilkEvent > 60) {
    h.lastMilkEvent = sim.tick;
    sim.emit(asSimEvent({ type: 'aphid', tick: sim.tick, op: 'milked', herd: h.state.id, colony: h.state.owner, pos: v3clone(src.pos), by }));
  }
  return src;
}

/** Distance from `p` to the segment a–b. */
function segDist(p: { x: number; y: number; z: number }, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t);
}

function spawnAphid(sim: SimState, h: HerdCtx): Creature | null {
  const s = h.state;
  const nav = sim.nav as NavEx;
  const n = s.aphids.length;
  // spread along the lower two thirds of the stem
  const t = 0.12 + 0.6 * (((n * 0.61803) % 1 + 1) % 1);
  const a = n * 2.39996323;
  const cell = nav.nearestWalkable(s.pos.x + (s.end.x - s.pos.x) * t + Math.cos(a) * 0.6, s.pos.y + (s.end.y - s.pos.y) * t, s.pos.z + (s.end.z - s.pos.z) * t + Math.sin(a) * 0.6, 4);
  if (cell < 0) return null;
  sim.world.cellCenter(cell, _p);
  const c = sim.spawnCreature('aphid', _p, s.owner);
  c.mem[CREATURE_MEM.prey] = 1;
  c.home = v3clone(_p);
  s.aphids.push(c.id);
  return c;
}

function stock(sim: SimState, h: HerdCtx): void {
  const A = BALANCE.b3.aphids;
  const s = h.state;
  h.stocked = true;
  // the stem's honeydew source (map generators place one at the site), else make one
  let src: FoodSource | null = null;
  let best = 8;
  for (const f of sim.foodSources) {
    if (f.foodKind !== 'honeydew') continue;
    const d = Math.min(Math.hypot(f.pos.x - s.pos.x, f.pos.y - s.pos.y, f.pos.z - s.pos.z), Math.hypot(f.pos.x - s.end.x, f.pos.y - s.end.y, f.pos.z - s.end.z));
    if (d < best) {
      best = d;
      src = f;
    }
  }
  if (!src) {
    const cell = (sim.nav as NavEx).nearestWalkable(s.pos.x, s.pos.y + 1, s.pos.z, 5);
    if (cell < 0) return;
    sim.world.cellCenter(cell, _p);
    src = sim.spawnFood('honeydew', A.capPerAphid * A.startHerd * 0.5, _p, 0);
  }
  s.sourceId = src.id;
  // adopt aphids already there, then top up to the starting herd
  for (const c of sim.creatures) if (c.alive && c.def === 'aphid' && Math.hypot(c.pos.x - s.pos.x, c.pos.z - s.pos.z) < s.radius + 6 && !s.aphids.includes(c.id)) s.aphids.push(c.id);
  for (let i = s.aphids.length; i < A.startHerd; i++) if (!spawnAphid(sim, h)) break;
}

function herdTick(sim: SimState, h: HerdCtx): void {
  const A = BALANCE.b3.aphids;
  const s = h.state;
  if (!h.stocked) stock(sim, h);
  const src = sim.getEntity(s.sourceId);
  const had = s.aphids.length;
  for (let i = s.aphids.length - 1; i >= 0; i--) {
    const c = sim.getEntity(s.aphids[i]);
    if (!c || !c.alive) s.aphids.splice(i, 1);
  }
  const n = s.aphids.length;
  if (had > 0 && n === 0) {
    sim.emit(asSimEvent({ type: 'aphid', tick: sim.tick, op: 'lost', herd: s.id, colony: s.owner, pos: v3clone(s.pos), by: 0 }));
    const owner = sim.getColony(s.owner);
    if (owner) alertOnce(sim, owner, 'info', 'An aphid herd has been wiped out', s.pos, 0, 0);
  }
  if (!src || src.kind !== 'food') {
    s.honeydewRate = 0;
    return;
  }
  // who is here?
  const segLen = Math.hypot(s.end.x - s.pos.x, s.end.y - s.pos.y, s.end.z - s.pos.z);
  let tenders = 0;
  let finder = 0;
  let finderColony = 0;
  let ownerNear = 0;
  let rival = 0;
  let rivalColony = 0;
  for (const a of sim.ants) {
    if (!a.alive || !getSpecies(a.species).caps.herdsAphids) continue;
    let d = Math.hypot(a.pos.x - src.pos.x, a.pos.y - src.pos.y, a.pos.z - src.pos.z);
    if (d > A.discoverRadius) {
      // final round: the herd sits along the stem, and a forager passing its foot smells it too
      // (the honeydew source can be well up the plant, out of range of anyone on the ground)
      // …and honeydew drips: an ant on the ground under a herd high on its stem finds it as well
      const under = Math.hypot(a.pos.x - s.pos.x, a.pos.z - s.pos.z) <= A.discoverRadius && a.pos.y < s.pos.y && s.pos.y - a.pos.y <= A.discoverBelow;
      if (!under && (d > A.discoverRadius + segLen || segDist(a.pos, s.pos, s.end) > A.discoverRadius)) continue;
      d = A.discoverRadius;
    }
    if (s.owner === 0 && n > 0 && !finder) {
      finder = a.id;
      finderColony = a.colony;
    }
    if (s.owner !== 0) {
      if (a.colony === s.owner) ownerNear++;
      else if (!rival && !a.mem['raid']) {
        rival = a.id;
        rivalColony = a.colony;
      }
    }
    if (a.colony === (s.owner || finderColony) && d <= A.tendRadius) tenders++;
  }
  // final round — a claim lapses: a herd nobody of its owner has visited for `abandonAfter`
  // seconds (or whose owner is gone) is adopted by the next herding colony whose ants find it.
  // A rival scout passing the stem by the player's door used to own that herd for the whole game.
  if (rival && n > 0 && ownerNear === 0) {
    const cur = sim.getColony(s.owner);
    if (!cur || !cur.alive || sim.tick - Math.max(h.lastTend, h.claimedAt) > A.abandonAfter * 30) {
      if (cur) closeJob(sim, cur, h.slot);
      s.owner = 0;
      finder = rival;
      finderColony = rivalColony;
    }
  }
  if (finder) {
    h.claimedAt = sim.tick;
    s.owner = finderColony;
    for (const id of s.aphids) {
      const c = sim.getEntity(id);
      if (c && c.kind === 'creature') c.colony = s.owner;
    }
    sim.emit(asSimEvent({ type: 'aphid', tick: sim.tick, op: 'discovered', herd: s.id, colony: s.owner, pos: v3clone(src.pos), by: finder }));
    const owner = sim.getColony(s.owner);
    if (owner) alertOnce(sim, owner, 'info', 'Scouts have found an aphid herd — workers will tend it for honeydew', src.pos, 0, 0);
  }
  s.tenders = tenders;
  if (tenders > 0) h.lastTend = sim.tick;
  s.tended = sim.tick - h.lastTend < A.tendedFor * 30;
  s.honeydewRate = n * (s.tended ? A.honeydewTended : A.honeydew);
  src.regen = s.honeydewRate;
  src.maxAmount = Math.max(1, n * A.capPerAphid);
  if (src.amount > src.maxAmount) src.amount = src.maxAmount;
  // breeding
  if (n > 0 && n < s.capacity) {
    h.breed += ((1 - n / s.capacity) * 2) / (s.tended ? A.breedTimeTended : A.breedTime);
    if (h.breed >= 1) {
      h.breed = 0;
      const c = spawnAphid(sim, h);
      if (c) sim.emit(asSimEvent({ type: 'aphid', tick: sim.tick, op: 'born', herd: s.id, colony: s.owner, pos: v3clone(c.pos), by: c.id }));
    }
  }
  // shepherds
  const owner = s.owner ? sim.getColony(s.owner) : undefined;
  if (owner && owner.alive && n > 0 && getExt(sim, owner.id).active) {
    const nav = sim.nav as NavEx;
    const cell = nav.nearestWalkable(src.pos.x, src.pos.y, src.pos.z, 4);
    if (cell >= 0 && nav.homeDistance(owner.id, cell) !== HOME_UNREACHABLE) {
      // a small standing crew, growing with the herd: tenders plus a guard or two
      postJob(sim, owner, h.slot, 'herdAphids', cell, src.pos, src.id, A.urgency, Math.min(A.slotsMax, A.slots + Math.floor(n / A.aphidsPerSlot)), s.id);
      bumpDemand(sim, owner, 'herdAphids');
      return;
    }
  }
  if (owner) closeJob(sim, owner, h.slot);
}

export const aphidsSystem: SimSystem = {
  id: 'aphids',
  init(sim) {
    if (sim.options.fixture === 'wander') return;
    const extras = getMapExtras(sim.map);
    if (!extras) return;
    for (const s of extras.sites) if (s.kind === 'aphidStem') addAphidHerd(sim, s.pos, s.end, s.radius);
  },
  update(sim) {
    if (sim.tick % 30 !== 17) return;
    const ctx = ctxOf(sim);
    for (const h of ctx.herds) herdTick(sim, h);
  },
};
