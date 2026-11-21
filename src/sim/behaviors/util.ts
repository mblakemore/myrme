import { HOME_UNREACHABLE, Mat, Phero, v3, v3clone, v3rotateAbout, type Ant, type Brood, type CellIndex, type Colony, type Entity, type Item, type ItemKind, type SimState, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { floorCellNear, getExt, nearestChamber } from '../systems/colonyState';
import { dropSpoil } from '../systems/dig';

/** Shared helpers for A2b behaviors: movement primitives, carrying, sensing. Allocation-free. */

export const MOVING = 0;
export const ARRIVED = 1;
export const FAILED = -1;

const _c = v3();
const _d = v3();
const _r = v3();

export function stop(ant: Ant): void {
  ant.intent.mode = 'none';
}

/** Work animations are sticky (movement only manages idle/walk/carry) — reset when leaving work. */
export function clearWorkAnim(ant: Ant): void {
  if (ant.anim === 'dig' || ant.anim === 'feed' || ant.anim === 'bite' || ant.anim === 'groom') ant.anim = 'idle';
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Walk to `cell` through the path queue. ARRIVED once the ant is within `reach` of `pos` (or of
 * the cell centre) or the path reports arrival; FAILED after the path kept failing for ~4 s.
 */
export function approach(sim: SimState, ant: Ant, cell: CellIndex, pos: Vec3 | null, reach: number, speedMul = 1): number {
  if (cell < 0) return FAILED;
  const t = pos ?? sim.world.cellCenter(cell, _c);
  if (dist(ant.pos, t) <= reach) {
    ant.intent.mode = 'none';
    ant.mem['mv.f'] = 0;
    return ARRIVED;
  }
  const it = ant.intent;
  it.mode = 'goto';
  it.goal = cell;
  it.speedMul = speedMul;
  const p = ant.path;
  if (p.goal === cell) {
    if (p.status === 'arrived') {
      ant.mem['mv.f'] = 0;
      return ARRIVED;
    }
    if (p.status === 'failed') {
      const f = (ant.mem['mv.f'] ?? 0) + 1;
      ant.mem['mv.f'] = f;
      if (f > 120) {
        ant.mem['mv.f'] = 0;
        it.mode = 'none';
        return FAILED;
      }
    }
  } else ant.mem['mv.f'] = 0;
  return MOVING;
}

/**
 * Homing on the colony's BFS home field (D15): steer towards the cell a few steps down the
 * field. Returns false when the field gives no step (dirty/unreachable) or the ant has been
 * making no progress — the caller then falls back to a `goto`.
 */
export function homeward(sim: SimState, ant: Ant, speedMul = 1): boolean {
  const mem = ant.mem;
  if (mem['hm.no'] !== undefined && sim.tick < mem['hm.no']) return false;
  if (ant.cell < 0 || ant.falling) {
    ant.intent.mode = 'none';
    return true;
  }
  const nav = sim.nav;
  const hd = nav.homeDistance(ant.colony, ant.cell);
  // stuck detection: homing by direction can wedge on awkward geometry → use A* for a while
  if (ant.intent.mode === 'dir' && ant.moveSpeed < ant.speed * 0.2) {
    const s = (mem['hm.s'] ?? 0) + 1;
    mem['hm.s'] = s;
    if (s > 40) {
      mem['hm.s'] = 0;
      mem['hm.no'] = sim.tick + 240;
      return false;
    }
  } else mem['hm.s'] = 0;
  // ...and it can also jitter at full speed without getting anywhere (a sharp lip: two cells
  // whose field steps pull opposite ways): the home distance itself must keep dropping
  if (mem['hm.lt'] === undefined || sim.tick - mem['hm.lt'] > 15 || hd < (mem['hm.b'] ?? Infinity)) {
    mem['hm.b'] = hd;
    mem['hm.bt'] = sim.tick;
  } else if (sim.tick - (mem['hm.bt'] ?? sim.tick) > 75) {
    mem['hm.bt'] = sim.tick;
    mem['hm.a'] = -1;
    mem['hm.no'] = sim.tick + 240;
    return false;
  }
  mem['hm.lt'] = sim.tick;
  // The aim cell is latched until it is reached (or overtaken): re-deriving it from `ant.cell`
  // every tick makes an ant standing on a cell boundary at a convex lip flip between two aims
  // that pull opposite ways along the surface — it turns on the spot and never crosses.
  let aim = mem['hm.a'] ?? -1;
  if (aim >= 0) {
    const ha = nav.homeDistance(ant.colony, aim);
    sim.world.cellCenter(aim, _c);
    if (ha === HOME_UNREACHABLE || hd <= ha || sim.tick >= (mem['hm.au'] ?? 0) || tangentDist2(ant, _c) < 0.2) aim = -1;
  }
  if (aim < 0) {
    aim = homeAim(sim, ant);
    if (aim < 0) return false;
    mem['hm.a'] = aim;
    mem['hm.au'] = sim.tick + 45;
    sim.world.cellCenter(aim, _c);
  }
  const it = ant.intent;
  it.mode = 'dir';
  it.dir.x = _c.x - ant.pos.x;
  it.dir.y = _c.y - ant.pos.y;
  it.dir.z = _c.z - ant.pos.z;
  it.speedMul = speedMul;
  return true;
}

/** Squared distance from the ant to `p` measured in its tangent plane. */
function tangentDist2(ant: Ant, p: Vec3): number {
  const dx = p.x - ant.pos.x;
  const dy = p.y - ant.pos.y;
  const dz = p.z - ant.pos.z;
  const dn = dx * ant.up.x + dy * ant.up.y + dz * ant.up.z;
  return dx * dx + dy * dy + dz * dz - dn * dn;
}

/**
 * Homing aim: a cell up to 3 steps down the home field — but never one that lies (almost)
 * straight beneath the ant's surface (the field shortcut over a lip into a shaft): its
 * tangent-plane direction is meaningless and can point backwards. Falls back to fewer steps.
 */
function homeAim(sim: SimState, ant: Ant): CellIndex {
  let n = ant.cell;
  let aim = -1;
  for (let k = 0; k < 3; k++) {
    const s = sim.nav.homeStep(ant.colony, n);
    if (s < 0) break;
    n = s;
    sim.world.cellCenter(n, _c);
    const dx = _c.x - ant.pos.x;
    const dy = _c.y - ant.pos.y;
    const dz = _c.z - ant.pos.z;
    const dn = dx * ant.up.x + dy * ant.up.y + dz * ant.up.z;
    const t2 = dx * dx + dy * dy + dz * dz - dn * dn;
    if (aim >= 0 && dn < 0 && t2 < dn * dn * 0.36) break;
    aim = n;
  }
  return aim === ant.cell ? -1 : aim;
}

/** Steer along `dir` (world space). */
export function steer(ant: Ant, dir: Vec3, speedMul = 1): void {
  const it = ant.intent;
  it.mode = 'dir';
  it.dir.x = dir.x;
  it.dir.y = dir.y;
  it.dir.z = dir.z;
  it.speedMul = speedMul;
}

/** Steer towards a world position. */
export function steerTo(ant: Ant, p: Vec3, speedMul = 1): void {
  const it = ant.intent;
  it.mode = 'dir';
  it.dir.x = p.x - ant.pos.x;
  it.dir.y = p.y - ant.pos.y;
  it.dir.z = p.z - ant.pos.z;
  it.speedMul = speedMul;
}

/** Slow random shuffle in place (resting ants, guards, the queen). `key` namespaces the memory. */
export function shuffle(sim: SimState, ant: Ant, dt: number, key: string, moveChance = 0.4, speedMul = 0.3): void {
  const mem = ant.mem;
  const ku = key + '.u';
  if (mem[ku] === undefined || sim.tick >= mem[ku]) {
    mem[key + '.t'] = sim.rng.range(-2, 2);
    mem[key + '.m'] = sim.rng.chance(moveChance) ? 1 : 0;
    mem[ku] = sim.tick + 15 + sim.rng.int(60);
  }
  if (!mem[key + '.m']) {
    ant.intent.mode = 'none';
    return;
  }
  v3rotateAbout(_d, ant.forward, ant.up, mem[key + '.t'] * dt);
  steer(ant, _d, speedMul);
}

// ---- pheromone sensing (D16: three forward sensors, no diffusion) --------------------------------

function bestTrailCellAround(sim: SimState, ant: Ant, cx: number, cy: number, cz: number, r: number, hd0: number, best: { cell: CellIndex; v: number }): void {
  const w = sim.world;
  const ph = sim.pheromones;
  const col = ant.colony;
  for (let dy = -r; dy <= r; dy++)
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        if (!w.inBounds(x, y, z)) continue;
        const cell = w.index(x, y, z);
        const v = ph.sample(col, Phero.food, cell) + 0.7 * ph.sample(col, Phero.trail, cell);
        if (v < BALANCE.a2b.trailSenseMin || v <= best.v) continue;
        const hd = sim.nav.homeDistance(col, cell);
        if (hd === HOME_UNREACHABLE || hd <= hd0) continue; // only outbound (away from the nest)
        best.v = v;
        best.cell = cell;
      }
}

const _best = { cell: -1, v: 0 };

/**
 * Trail sensing for outbound foragers: three sensors ahead (left / centre / right) each sniff a
 * 3×3×3 block for `food` (+ player `trail`) pheromone on cells FARTHER from home than the ant —
 * trails are laid along the homing route, so "pheromone and farther out" leads to the source.
 * Falls back to a whole-neighbourhood sniff (sharp bends in tunnels). Returns the strongest cell
 * or -1.
 */
export function senseTrail(sim: SimState, ant: Ant): CellIndex {
  if (ant.cell < 0) return -1;
  const hd0 = sim.nav.homeDistance(ant.colony, ant.cell);
  if (hd0 === HOME_UNREACHABLE) return -1;
  const B = BALANCE.a2b;
  _best.cell = -1;
  _best.v = 0;
  for (let s = -1; s <= 1; s++) {
    v3rotateAbout(_r, ant.forward, ant.up, s * B.sensorAngle);
    const x = Math.floor(ant.pos.x + _r.x * B.sensorDist);
    const y = Math.floor(ant.pos.y + _r.y * B.sensorDist);
    const z = Math.floor(ant.pos.z + _r.z * B.sensorDist);
    bestTrailCellAround(sim, ant, x, y, z, 1, hd0, _best);
  }
  if (_best.cell < 0) bestTrailCellAround(sim, ant, Math.floor(ant.pos.x), Math.floor(ant.pos.y), Math.floor(ant.pos.z), 2, hd0, _best);
  return _best.cell;
}

/** Strongest value of a channel over the three forward sensors (centre cell of each). */
export function senseChannel(sim: SimState, ant: Ant, channel: (typeof Phero)[keyof typeof Phero], angle: number, d: number): number {
  v3rotateAbout(_r, ant.forward, ant.up, angle);
  const cell = sim.world.cellAt(ant.pos.x + _r.x * d, ant.pos.y + _r.y * d, ant.pos.z + _r.z * d);
  return cell < 0 ? 0 : sim.pheromones.sample(ant.colony, channel, cell);
}

// ---- carrying ---------------------------------------------------------------------------------------

export function isFoodItemKind(k: ItemKind): boolean {
  return k === 'food' || k === 'seed' || k === 'honeydew' || k === 'fungus';
}

/** Loose item this colony treats as food: food-like kinds and corpses that are not its own dead. */
export function isFoodItem(it: Item, colony: number): boolean {
  if (!it.alive || it.amount <= 0) return false;
  return isFoodItemKind(it.itemKind) || (it.itemKind === 'corpse' && it.colony !== colony && !it.infected);
}

export function carriesFood(ant: Ant): boolean {
  const c = ant.carrying;
  if (!c) return false;
  if (c.kind === 'bulk') return c.itemKind === 'food' || isFoodItemKind(c.itemKind);
  if (c.kind === 'item') return isFoodItemKind(c.itemKind) || c.itemKind === 'corpse';
  return false;
}

export function pickUpItem(sim: SimState, ant: Ant, item: Item): void {
  item.carriedBy = ant.id;
  item.falling = false;
  ant.carrying = { kind: 'item', id: item.id, itemKind: item.itemKind, amount: item.amount, material: Mat.Air };
  sim.emit({ type: 'itemPicked', tick: sim.tick, by: ant.id, item: item.id, pos: v3clone(ant.pos) });
}

export function pickUpBrood(sim: SimState, ant: Ant, b: Brood): void {
  b.carriedBy = ant.id;
  ant.carrying = { kind: 'brood', id: b.id, itemKind: 'food', amount: 1, material: Mat.Air };
  sim.emit({ type: 'itemPicked', tick: sim.tick, by: ant.id, item: b.id, pos: v3clone(ant.pos) });
}

export function carryBulkFood(ant: Ant, amount: number, fromStores = false): void {
  ant.mem['crop'] = fromStores ? 1 : 0;
  ant.carrying = { kind: 'bulk', id: 0, itemKind: 'food', amount, material: Mat.Air };
}

/** Put whatever the ant holds down at its feet. Bulk food becomes a loose food item. */
export function dropCarry(sim: SimState, ant: Ant): Entity | null {
  const c = ant.carrying;
  if (!c) return null;
  ant.carrying = null;
  if (c.kind === 'bulk') {
    if (c.itemKind === 'debris') {
      // a dig pellet: A2a's spoil drop (grows the mound outdoors, packs into the wall inside)
      ant.carrying = c;
      dropSpoil(sim, ant, ant.possessed);
      ant.carrying = null;
      return null;
    }
    if (c.amount <= 0 || c.itemKind !== 'food') return null;
    const it = sim.spawnItem('food', c.amount, ant.pos, 0);
    it.up = v3clone(ant.up);
    sim.emit({ type: 'itemDropped', tick: sim.tick, by: ant.id, item: it.id, pos: v3clone(ant.pos) });
    return it;
  }
  const e = sim.getEntity(c.id);
  if (!e || (e.kind !== 'item' && e.kind !== 'brood')) return null;
  e.carriedBy = 0;
  e.pos.x = ant.pos.x;
  e.pos.y = ant.pos.y;
  e.pos.z = ant.pos.z;
  e.cell = ant.cell;
  e.up.x = ant.up.x;
  e.up.y = ant.up.y;
  e.up.z = ant.up.z;
  sim.emit({ type: 'itemDropped', tick: sim.tick, by: ant.id, item: e.id, pos: v3clone(ant.pos) });
  return e;
}

/** Put a carried item/brood down on a specific cell (pile placement). */
export function placeCarry(sim: SimState, ant: Ant, cell: CellIndex): Entity | null {
  const e = dropCarry(sim, ant);
  if (e && cell >= 0 && (e.kind === 'item' || e.kind === 'brood')) {
    sim.world.cellCenter(cell, e.pos);
    e.pos.y -= 0.3;
    e.cell = cell;
    e.up.x = 0;
    e.up.y = 1;
    e.up.z = 0;
  }
  return e;
}

/** Add a delivered load to the colony stores (+ event and stats). */
export function deliverFood(sim: SimState, colony: Colony, ant: Ant, amount: number): void {
  if (amount <= 0) return;
  if (getSpecies(colony.species).caps.farmsFungus) {
    // B3: fungus farmers cannot eat forage — whatever they bring in is garden substrate
    colony.stores.leaves += amount * BALANCE.b3.leafcutters.forageAsSubstrate;
    return;
  }
  colony.stores.food += amount;
  colony.stats.foodDelivered += amount;
  sim.emit({ type: 'foodDelivered', tick: sim.tick, colony: colony.id, by: ant.id, amount, pos: v3clone(ant.pos) });
}

/** Deliver whatever food the ant carries into the stores. Returns the amount delivered. */
export function deliverCarriedFood(sim: SimState, colony: Colony, ant: Ant): number {
  const c = ant.carrying;
  if (!c) return 0;
  let amount = 0;
  if (c.kind === 'bulk') {
    amount = c.amount;
    if (ant.mem['crop']) {
      // food taken from the stores for a feeding run and not used: put back, not a delivery
      ant.mem['crop'] = 0;
      colony.stores.food += amount;
    } else if (c.itemKind === 'leaf') colony.stores.leaves += amount;
    else if (c.itemKind === 'wood') colony.stores.wood += amount;
    else deliverFood(sim, colony, ant, amount);
  } else if (c.kind === 'item') {
    const e = sim.getEntity(c.id);
    if (e && e.kind === 'item') {
      amount = e.amount;
      if (e.itemKind === 'leaf') colony.stores.leaves += amount;
      else if (e.itemKind === 'wood') colony.stores.wood += amount;
      else deliverFood(sim, colony, ant, amount);
      e.carriedBy = 0;
      sim.remove(e);
    }
  }
  ant.carrying = null;
  return amount;
}

/** Deterministic spot inside a chamber for entity `id` (so piles spread instead of stacking). */
export function pileCell(sim: SimState, center: Vec3, radius: number, id: number): CellIndex {
  const a = id * 2.39996323;
  const r = radius * Math.sqrt(((id * 7) % 11) / 11);
  return floorCellNear(sim, center.x + Math.cos(a) * r, center.y, center.z + Math.sin(a) * r, 3);
}

/** The pantry door nearest to `p`: any granary (stores are shared), else the queen chamber. */
export function pantry(colony: Colony, p: Vec3) {
  return nearestChamber(colony, 'granary', p);
}

/** Where a carrier should take a piece of brood: the least crowded nursery, nearer ones first. */
export function nurseryFor(sim: SimState, colony: Colony, p: Vec3) {
  const load = getExt(sim, colony.id).nurseryLoad;
  let best = null;
  let bestS = Infinity;
  for (const c of colony.chambers) {
    if (c.kind !== 'nursery') continue;
    const n = load.get(c.id) ?? 0;
    const s = Math.max(0, n - BALANCE.a2b.nurseryBrood) * 10 + n * 0.5 + dist(c.pos, p) * 0.25;
    if (s < bestS) {
      bestS = s;
      best = c;
    }
  }
  return best ?? colony.chambers[0];
}
