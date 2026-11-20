import { inDangerZone } from '../systems/colonyState';
import { HOME_UNREACHABLE, ISO, Phero, hash01, v3, v3clone, v3rotateAbout, type Ant, type Colony, type FoodSource, type Item, type SimState, type Task, type TrailSense } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste, getSpecies } from '../data/species';
import { exploredAt, getExt, markExplored, type ColonyExt } from '../systems/colonyState';
import type { Vec3 } from '../../core';
import { inAvoidZone } from '../systems/jobsBoard';
import { pheroOf } from '../systems/pheromone';
import { ARRIVED, FAILED, approach, carriesFood, carryBulkFood, clearWorkAnim, deliverCarriedFood, dist, homeward, isFoodItem, pantry, senseChannel, senseTrail, steer, steerTo } from './util';

/**
 * The forage state machine (pillar 2: real trail dynamics). Runs over a `gather` task — the
 * colony's own (`forage` behavior) or a player `gather` order / Gather beacon — so all three share
 * one implementation. `task.targetId`/`task.pos` remember the food the ant is working;
 * `task.phase` is one of the phases below (labels in contracts/a2b.ts FORAGE_PHASES).
 *
 *   LEAVE    walk to the nest entrance
 *   SCOUT    correlated random walk biased away from home and from explored / low-yield areas;
 *            smelling food → APPROACH; crossing a trail → TRAIL
 *   TRAIL    follow `food` pheromone outbound with three forward sensors
 *   APPROACH path to the food
 *   CUT      cut a load (carcasses are butchered into loads on site — slower)
 *   HOME     return down the home distance field, laying `food` trail ∝ source quality; deliver
 *            to the pantry; then go again (BACK) or finish
 *   EMPTY    scout timed out / source gone: go home without laying a trail
 *   BACK     experienced forager: path straight back to the remembered source
 *
 * A source that runs dry gets no fresh trail, so its trail evaporates and recruits stop coming.
 */
export const F_LEAVE = 0;
export const F_SCOUT = 1;
export const F_TRAIL = 2;
export const F_APPROACH = 3;
export const F_CUT = 4;
export const F_HOME = 5;
export const F_EMPTY = 6;
export const F_BACK = 7;

const _d = v3();
const _p = v3();
const _sense: TrailSense = { left: 0, centre: 0, right: 0, total: 0, turn: 0, dir: v3() };

type Food = FoodSource | Item;

function setPhase(sim: SimState, ant: Ant, task: Task, phase: number): void {
  task.phase = phase;
  ant.mem['f.t0'] = sim.tick;
  ant.mem['f.next'] = 0;
  ant.mem['f.go'] = 0;
  clearWorkAnim(ant);
}

/** The food entity a task points at, if it still has something to take. */
export function foodTarget(sim: SimState, ant: Ant, task: Task): Food | null {
  if (!task.targetId) return null;
  const e = sim.getEntity(task.targetId);
  if (!e) return null;
  if (e.kind === 'food') return e.amount > 0 && !underWater(sim, e) && !inDangerZone(sim, ant.colony, e.pos) ? e : null;
  if (e.kind === 'item') return !e.carriedBy && isFoodItem(e, ant.colony) ? e : null;
  return null;
}

/** Final round: a source standing in deep water is left alone until the puddle is gone. */
export function underWater(sim: SimState, f: { cell: number }): boolean {
  return sim.water.floodedCount > 0 && f.cell >= 0 && sim.water.depthAt(f.cell) > BALANCE.b2.floodDepth;
}

/** Nearest food the ant can smell from where it stands (sources and loose food-like items). */
export function smellFood(sim: SimState, ant: Ant, colony: Colony, extraRadius = 0): Food | null {
  const R = BALANCE.a2b.foodSenseRadius + extraRadius;
  let best: Food | null = null;
  let bestD = Infinity;
  for (const f of sim.foodSources) {
    if (!f.alive || f.amount <= 0 || underWater(sim, f) || inDangerZone(sim, ant.colony, f.pos)) continue;
    // final round: a big pile smells further than a crumb (up to +`foodSenseBig` voxels) — scouts
    // used to walk past a 260-unit seed pile 20 voxels from the nest for ten minutes (forest)
    const d = dist(f.pos, ant.pos) - f.radius - Math.min(BALANCE.a2b.foodSenseBig, f.amount / 60);
    if (d < R && d < bestD) {
      best = f;
      bestD = d;
    }
  }
  const store = pantry(colony, ant.pos);
  for (const it of sim.items) {
    if (it.carriedBy || !isFoodItem(it, ant.colony)) continue;
    const d = dist(it.pos, ant.pos);
    if (d < R && d < bestD && dist(it.pos, store.pos) > store.radius) {
      best = it;
      bestD = d;
    }
  }
  if (best && inAvoidZone(colony, best.pos)) return null;
  return best;
}

function setTarget(sim: SimState, ant: Ant, colony: Colony, ext: ColonyExt, task: Task, f: Food): void {
  task.targetId = f.id;
  task.pos = v3clone(f.pos);
  task.cell = f.cell;
  if (!ext.knownSources.has(f.id)) {
    ext.knownSources.set(f.id, sim.tick);
    sim.emit({ type: 'foodFound', tick: sim.tick, colony: colony.id, by: ant.id, source: f.id, pos: v3clone(f.pos) });
  }
}

function isInside(sim: SimState, ant: Ant, colony: Colony): boolean {
  const e = colony.entrances[0];
  if (e === undefined || e < 0 || ant.cell < 0) return false;
  const he = sim.nav.homeDistance(colony.id, e);
  const ha = sim.nav.homeDistance(colony.id, ant.cell);
  return he !== HOME_UNREACHABLE && ha !== HOME_UNREACHABLE && ha < he - 1;
}

/** Correlated random walk for scouts. Re-decides every ~10 ticks, steers every tick. */
/**
 * B3 chore (slab maps): is (x, y) a bare stretch of pane — no material anywhere across the slab
 * at this height nor just below it? Scouts have nothing to find out there.
 */
function barePane(sim: SimState, x: number, y: number, below = 2): boolean {
  const w = sim.world;
  const alongZ = sim.map.flags.slabAxis === 'z';
  const n = alongZ ? w.sz : w.sx;
  const cx = Math.floor(x);
  if (y >= w.sy) return true;
  for (let dy = 0; dy >= -below; dy--) {
    const cy = Math.floor(y) + dy;
    for (let k = 0; k < n; k++) {
      const ix = alongZ ? cx : k;
      const iz = alongZ ? k : cx;
      if (!w.inBounds(ix, cy, iz)) return false;
      if (w.density[w.index(ix, cy, iz)] >= ISO) return false;
    }
  }
  return true;
}

function scoutSteer(sim: SimState, ant: Ant, colony: Colony, ext: ColonyExt, dt: number, anchor: Vec3 | null): void {
  const mem = ant.mem;
  const B = BALANCE.a2b;
  if (sim.tick >= (mem['f.next'] ?? 0)) {
    mem['f.next'] = sim.tick + 8 + Math.floor(hash01(ant.id, sim.tick, 3) * 8);
    markExplored(ext, ant.pos, 0.3);
    // Search is anchored (the entrance, or the spot the player/beacon pointed at) with a leash
    // that grows with search time: nearby ground is covered before anyone wanders far.
    const e = colony.entrances[0];
    const home = anchor ?? (e !== undefined && e >= 0 ? sim.world.cellCenter(e, _p) : colony.nestPos);
    let ox = ant.pos.x - home.x;
    let oz = ant.pos.z - home.z;
    const ol = Math.hypot(ox, oz);
    if (ol > 1e-3) {
      ox /= ol;
      oz /= ol;
    }
    const t0 = mem['f.t0'] ?? sim.tick;
    const elapsed = (sim.tick - t0) / 30;
    const leash = B.scoutLeashBase + elapsed * B.scoutLeashGrow;
    const outward = ol > leash ? -1.6 : 0.15;
    // each scout leaves in its own direction so the cohort fans out
    const sec = hash01(ant.id, t0, 91) * Math.PI * 2;
    const fan = Math.max(0, 1 - elapsed / B.scoutFanTime) * 0.9;
    const sx = Math.cos(sec);
    const sz = Math.sin(sec);
    let bestS = -Infinity;
    let bestK = 0;
    const pane = sim.map.flags.slab;
    const alongZ = sim.map.flags.slabAxis === 'z';
    // clinging to the glass (up along the slab axis) with nothing behind it at this height
    const onPane = pane && Math.abs(alongZ ? ant.up.z : ant.up.x) > 0.7 && barePane(sim, alongZ ? ant.pos.x : ant.pos.z, ant.pos.y, 0);
    for (let k = -1; k <= 1; k++) {
      v3rotateAbout(_d, ant.forward, ant.up, k * 0.85);
      const px = ant.pos.x + _d.x * B.exploreCell;
      const py = ant.pos.y + _d.y * B.exploreCell;
      const pz = ant.pos.z + _d.z * B.exploreCell;
      let s = -exploredAt(ext, px, py, pz) * 0.9;
      s += (_d.x * ox + _d.z * oz) * outward + (_d.x * sx + _d.z * sz) * fan;
      s += hash01(ant.id, sim.tick, 10 + k) * 1.1;
      s += k === 0 ? 0.25 : 0; // persistence
      s -= senseChannel(sim, ant, Phero.avoid, k * 0.85, 2.5) * 3;
      if (pane) {
        // B3 chore (farm maps): bare glass with nothing behind it is not worth scouting —
        // penalise candidates out on the pane, and prefer heading back down once on it
        if (barePane(sim, alongZ ? px : pz, py)) s -= 6;
        if (onPane) s -= _d.y * 6;
        // the slab is only a few voxels thick: walking across it just leads up the glass
        else s -= Math.abs(alongZ ? _d.z : _d.x) * 3;
      }
      if (s > bestS) {
        bestS = s;
        bestK = k;
      }
    }
    mem['f.turn'] = bestK * 1.5 + (hash01(ant.id, sim.tick, 20) - 0.5) * 0.8;
    // on bare glass and not yet heading down: turn round sharply (B3 chore)
    if (onPane && ant.forward.y > -0.5) mem['f.turn'] = (bestK >= 0 ? 1 : -1) * 4.5;
    // wedged against something: turn hard
    if (ant.intent.mode === 'dir' && ant.moveSpeed < ant.speed * 0.25) mem['f.turn'] = hash01(ant.id, sim.tick, 21) < 0.5 ? 4.5 : -4.5;
  }
  v3rotateAbout(_d, ant.forward, ant.up, (mem['f.turn'] ?? 0) * dt);
  const w = sim.world;
  if (w.boundary === 'open') {
    const m = 4;
    const p = ant.pos;
    if (p.x < m || p.z < m || p.x > w.sx - m || p.z > w.sz - m) {
      _d.x = w.sx / 2 - p.x;
      _d.y = 0;
      _d.z = w.sz / 2 - p.z;
    }
  }
  steer(ant, _d, 1);
}

/** Take a load from a source/item. Returns the amount taken (0 = nothing left). */
function cutLoad(sim: SimState, ant: Ant, f: Food): number {
  const cap = Math.max(0.5, getCaste(ant.species, ant.caste).carryCapacity);
  // a hungry forager feeds first (and can then share by trophallaxis back home)
  // (not fungus farmers: leafcutters cannot eat forage — their only food is the garden's)
  if (ant.energy < 0.8 && f.amount > 0.05 && !getSpecies(ant.species).caps.farmsFungus) {
    const eat = Math.min(f.amount * 0.5, (1 - ant.energy) * BALANCE.a2b.foodPerEnergy * 0.5);
    f.amount -= eat;
    ant.energy = Math.min(1, ant.energy + eat / (BALANCE.a2b.foodPerEnergy * 0.5));
  }
  const take = Math.min(cap, f.amount);
  if (take <= 0) return 0;
  f.amount -= take;
  if (f.amount <= 1e-6) {
    f.amount = 0;
    if (f.kind === 'item') sim.remove(f); // sources are retired by the food system
  }
  carryBulkFood(ant, take);
  return take;
}

/**
 * Advance the forage machine one tick. Returns true when the task is finished (caller pops it).
 * `persist`: keep going back for more while the source lasts (player gather / beacon), regardless
 * of colony demand.
 */
export function runForage(sim: SimState, ant: Ant, task: Task, dt: number, persist: boolean): boolean {
  const colony = sim.getColony(ant.colony);
  if (!colony) return true;
  const ext = getExt(sim, colony.id);
  const B = BALANCE.a2b;
  const mem = ant.mem;

  // an ant that already holds food just brings it in
  if (task.phase !== F_HOME && carriesFood(ant)) {
    mem['f.q'] = 0;
    setPhase(sim, ant, task, F_HOME);
  }

  switch (task.phase) {
    case F_LEAVE: {
      const known = foodTarget(sim, ant, task);
      const e = colony.entrances[0];
      if (e !== undefined && e >= 0 && isInside(sim, ant, colony) && sim.tick - (mem['f.t0'] ?? sim.tick) < 900) {
        const r = approach(sim, ant, e, null, 2.2);
        if (r !== ARRIVED && r !== FAILED) return false;
      }
      setPhase(sim, ant, task, known ? F_BACK : F_SCOUT);
      return false;
    }

    case F_SCOUT: {
      const f = smellFood(sim, ant, colony);
      if (f) {
        ext.counters.scoutFinds++;
        setTarget(sim, ant, colony, ext, task, f);
        setPhase(sim, ant, task, F_APPROACH);
        return false;
      }
      if (sim.tick >= (mem['f.notrail'] ?? 0) && sim.tick >= (mem['f.next'] ?? 0) && senseTrail(sim, ant) >= 0) {
        ext.counters.trailFollows++;
        setPhase(sim, ant, task, F_TRAIL);
        return false;
      }
      if (sim.tick - (mem['f.t0'] ?? 0) > B.scoutTime * 30) {
        setPhase(sim, ant, task, F_EMPTY);
        return false;
      }
      scoutSteer(sim, ant, colony, ext, dt, task.targetId ? null : task.pos);
      return false;
    }

    case F_TRAIL: {
      const f = smellFood(sim, ant, colony);
      if (f) {
        ext.counters.trailFinds++;
        setTarget(sim, ant, colony, ext, task, f);
        setPhase(sim, ant, task, F_APPROACH);
        return false;
      }
      if (sim.tick >= (mem['f.next'] ?? 0)) {
        mem['f.next'] = sim.tick + 5;
        // A2a's three-antenna sensor steers along the trail; it cannot tell "out" from "home",
        // so its heading is only taken while it leads away from the nest. Otherwise (bends,
        // wrong way round, trail under the feet only) the outbound-cell sniff takes over.
        let tc = -1;
        mem['f.sd'] = 0;
        const s = pheroOf(sim).senseTrail(sim.world, colony.id, Phero.food, ant.pos, ant.forward, ant.up, _sense, B.sensorDist, B.sensorAngle);
        if (s.total >= B.trailSenseMin && ant.cell >= 0) {
          const ahead = sim.nav.nearestWalkable(ant.pos.x + s.dir.x * B.sensorDist, ant.pos.y + s.dir.y * B.sensorDist, ant.pos.z + s.dir.z * B.sensorDist, 1);
          const h0 = sim.nav.homeDistance(colony.id, ant.cell);
          const h1 = ahead >= 0 ? sim.nav.homeDistance(colony.id, ahead) : HOME_UNREACHABLE;
          if (h1 !== HOME_UNREACHABLE && h0 !== HOME_UNREACHABLE && h1 > h0) {
            mem['f.sd'] = 1;
            mem['f.dx'] = s.dir.x;
            mem['f.dy'] = s.dir.y;
            mem['f.dz'] = s.dir.z;
            tc = ahead;
          }
        }
        if (tc < 0) tc = senseTrail(sim, ant);
        mem['f.tc'] = tc;
        if (tc >= 0) mem['f.lost'] = sim.tick;
        else if (sim.tick - (mem['f.lost'] ?? mem['f.t0'] ?? 0) > B.trailLostTime * 30) {
          // trail ran out with no food at its end: stale trail → remember the area as low-yield
          markExplored(ext, ant.pos, 1.5);
          mem['f.notrail'] = sim.tick + 600;
          const t0 = mem['f.t0'];
          setPhase(sim, ant, task, F_SCOUT);
          mem['f.t0'] = t0 ?? sim.tick;
          return false;
        }
      }
      const tc = mem['f.tc'] ?? -1;
      if (mem['f.sd']) {
        _d.x = mem['f.dx'];
        _d.y = mem['f.dy'];
        _d.z = mem['f.dz'];
        steer(ant, _d, 1);
      } else if (tc >= 0) {
        sim.world.cellCenter(tc, _p);
        steerTo(ant, _p, 1);
      } else scoutSteer(sim, ant, colony, ext, dt, null);
      return false;
    }

    case F_BACK:
    case F_APPROACH: {
      const f = foodTarget(sim, ant, task);
      if (!f) {
        // gone or exhausted: the area is low-yield now; look around, then give up
        if (task.pos) {
          _p.x = task.pos.x;
          _p.y = task.pos.y;
          _p.z = task.pos.z;
          markExplored(ext, _p, B.lowYieldPenalty);
        }
        task.targetId = 0;
        if (persist) return true;
        setPhase(sim, ant, task, F_SCOUT);
        mem['f.t0'] = sim.tick - Math.round(B.scoutTime * 30 * 0.6);
        return false;
      }
      const reach = (f.kind === 'food' ? f.radius : 0.4) + 1.1;
      const r = approach(sim, ant, f.cell, f.pos, reach);
      if (r === ARRIVED) setPhase(sim, ant, task, F_CUT);
      else if (r === FAILED) {
        task.targetId = 0;
        markExplored(ext, f.pos, 2);
        if (persist) return true;
        setPhase(sim, ant, task, F_SCOUT);
      }
      return false;
    }

    case F_CUT: {
      const f = foodTarget(sim, ant, task);
      if (!f) {
        setPhase(sim, ant, task, F_APPROACH);
        return false;
      }
      ant.intent.mode = 'none';
      ant.anim = 'bite';
      const butcher = f.kind === 'item' ? f.amount > 3 : f.foodKind === 'carcass';
      if (sim.tick - (mem['f.t0'] ?? 0) < (butcher ? B.butcherTime : B.harvestTime) * 30) return false;
      const got = cutLoad(sim, ant, f);
      // trail quality: rich sources recruit harder; an exhausted one, or one that only gave a
      // scrap (a trickle of honeydew), lays next to nothing — and is not worth coming back to
      const cap = Math.max(0.5, getCaste(ant.species, ant.caste).carryCapacity);
      const full = Math.min(1, got / cap);
      mem['f.q'] = f.amount > 0 ? Math.max(0.3, Math.min(1, f.amount / B.trailQualityAmount)) * (f.kind === 'food' && f.foodKind === 'carcass' ? 1.2 : 1) * full * full : 0;
      mem['f.lc'] = -1;
      if (full < 0.34) task.targetId = 0;
      if (got <= 0) {
        setPhase(sim, ant, task, F_APPROACH);
        return false;
      }
      setPhase(sim, ant, task, F_HOME);
      return false;
    }

    case F_HOME:
    case F_EMPTY: {
      const home = task.phase === F_HOME;
      const store = pantry(colony, ant.pos);
      if (home) {
        if (!ant.carrying) {
          // load lost (dropped by the player, stolen…): start over
          setPhase(sim, ant, task, F_LEAVE);
          return false;
        }
        const q = mem['f.q'] ?? 0;
        if (q > 0 && ant.cell >= 0 && ant.cell !== mem['f.lc']) {
          mem['f.lc'] = ant.cell;
          sim.pheromones.deposit(colony.id, Phero.food, ant.cell, B.trailDeposit * q);
        }
      }
      const d = dist(ant.pos, store.pos);
      const speed = home ? B.carrySpeed : 1;
      // final approach by path (latched, so the field and the path never fight each other)
      if (!mem['f.go'] && (d < 8 || !homeward(sim, ant, speed))) mem['f.go'] = 1;
      if (mem['f.go']) {
        const r = approach(sim, ant, store.cell, store.pos, home ? 1.5 : 4, speed);
        if (r === ARRIVED) {
          if (!home) return true;
          deliverCarriedFood(sim, colony, ant);
          ext.counters.deliveries++;
          // A delivery is a natural break: the colony forager re-decides what is most needed
          // (it remembers its source and goes straight back if it forages again).
          const f = foodTarget(sim, ant, task);
          mem['f.src'] = f ? f.id : 0;
          if (!persist || !f) return true;
          setPhase(sim, ant, task, F_LEAVE);
        } else if (r === FAILED) {
          // cannot reach the pantry (cut off): drop the claim on the path and retry via the field
          mem['hm.no'] = 0;
          mem['f.go'] = 0;
          if (!home) return true;
        }
      }
      return false;
    }
  }
  return true;
}

/** Cleanup when a forage run is interrupted for good (task removed while mid-run). */
export function forageExit(ant: Ant): void {
  clearWorkAnim(ant);
  ant.intent.mode = 'none';
}
