import { BEACON_CHANNEL, JOB_KINDS, MATERIALS, Mat, Phero, v3, v3clone, type Ant, type Beacon, type Colony, type Creature, type Designation, type Job, type JobKind, type Mover, type SimState, type SimSystem, type Vec3 } from '../../core';
import { isFoodItem } from '../behaviors/util';
import { BALANCE } from '../data/balance';
import { getCreature } from '../data/creatures';
import { getCaste } from '../data/species';
import { broodPilePos, chamberAt, dutyTask, getExt, hasPlayerTask, type ColonyExt } from './colonyState';
import { designationProgress } from './dig';
import { retireJob, updateForageDemand } from './jobsBoard';

/**
 * Colony job board (§5.2). Every `jobsEveryTicks` the board is re-derived from world state:
 *
 *   feedLarva    one per hungry larva                    feedQueen   when the queen is hungry
 *   carryBrood   brood outside the nursery / wrong pile  carryCorpse dead nestmates after the delay
 *   haulFood     loose food the colony knows about       dig / build one per designation stamp
 *   patrol       the ring around the entrance            guard       entrance posts (B1 behavior)
 *
 * Jobs are keyed by what they are about, so they persist (with their reservations) while the
 * need lasts and disappear when it is met. From the open jobs the per-kind stimulus
 * `ext.demand` is computed (see jobsBoard.ts for how ants respond). Foraging has no board entry:
 * its stimulus comes from the food stores, the forager head-count and the trail at the entrance.
 *
 * Also owns the `beacon` and `designate` commands: beacons deposit their pheromone channel over
 * their radius and get nearby ants assigned up to a quota (see behaviors/beacon.ts).
 */

const _p = v3();
const seen = new Set<string>();

function ensureJob(sim: SimState, colony: Colony, ext: ColonyExt, key: string, kind: JobKind, cell: number, pos: Vec3, targetId: number, urgency: number, slots: number, designationId = 0, data = 0): Job {
  seen.add(key);
  let job = ext.jobByKey.get(key);
  if (!job) {
    job = { id: sim.nextId(), kind, colony: colony.id, cell, pos: v3clone(pos), targetId, urgency, slots, assigned: [], remaining: 1, designationId, createdTick: sim.tick, data };
    colony.jobs.push(job);
    ext.jobByKey.set(key, job);
    ext.jobsById.set(job.id, job);
  } else {
    job.cell = cell;
    job.pos.x = pos.x;
    job.pos.y = pos.y;
    job.pos.z = pos.z;
    job.urgency = urgency;
    job.slots = slots;
  }
  return job;
}

function holdsJob(ant: Ant, jobId: number): boolean {
  for (const t of ant.tasks) if (t.jobId === jobId) return true;
  return false;
}

function inDigBeacon(colony: Colony, p: Vec3): boolean {
  for (const b of colony.beacons) if (b.kind === 'dig' && Math.hypot(b.pos.x - p.x, b.pos.y - p.y, b.pos.z - p.z) < b.radius + 2) return true;
  return false;
}

function updateBoard(sim: SimState, colony: Colony, ext: ColonyExt): void {
  const B = BALANCE.a2b;
  seen.clear();
  ext.nurseryLoad.clear();

  // ---- brood ----
  const hungryTicks = B.larvaHungryTime * 30;
  const starveTicks = B.larvaStarveTime * 30;
  for (const b of sim.brood) {
    if (!b.alive || b.colony !== colony.id || b.carriedBy) continue;
    if (b.cell < 0) b.cell = sim.nav.nearestWalkable(b.pos.x, b.pos.y, b.pos.z, 4);
    if (b.stage === 'larva' && b.hunger > hungryTicks && b.fed < getCaste(b.species, b.caste).foodCost && colony.stores.food > 0.05) {
      ensureJob(sim, colony, ext, 'fl' + b.id, 'feedLarva', b.cell, b.pos, b.id, Math.min(1, 0.5 + 0.5 * (b.hunger / starveTicks)), 1);
    }
    const nursery = chamberAt(colony, 'nursery', b.pos, 0.8);
    if (!nursery) {
      ensureJob(sim, colony, ext, 'cb' + b.id, 'carryBrood', b.cell, b.pos, b.id, 0.65, 1);
      continue;
    }
    ext.nurseryLoad.set(nursery.id, (ext.nurseryLoad.get(nursery.id) ?? 0) + 1);
    broodPilePos(sim, nursery, b.stage, _p);
    const d = Math.hypot(b.pos.x - _p.x, b.pos.y - _p.y, b.pos.z - _p.z);
    if (d > B.broodPileRadius + 1.4) ensureJob(sim, colony, ext, 'cb' + b.id, 'carryBrood', b.cell, b.pos, b.id, 0.28, 1);
  }

  // ---- queen ----
  const queen = colony.queenId ? sim.getAnt(colony.queenId) : undefined;
  if (queen && queen.energy < 0.6 && colony.stores.food > 0.05) {
    ensureJob(sim, colony, ext, 'fq', 'feedQueen', queen.cell, queen.pos, queen.id, Math.min(1, 0.55 + (0.6 - queen.energy)), queen.energy < 0.3 ? 2 : 1);
  }

  // ---- corpses and loose food ----
  const corpseTicks = B.corpseDelay * 30;
  const entrance = colony.entrances[0] ?? -1;
  if (entrance >= 0) sim.world.cellCenter(entrance, _p);
  for (const it of sim.items) {
    if (!it.alive || it.carriedBy || it.falling) continue;
    if (it.itemKind === 'corpse' && it.colony === colony.id) {
      if (sim.tick - it.bornTick < corpseTicks || chamberAt(colony, 'midden', it.pos, 0.5)) continue;
      if (it.cell < 0 || !sim.nav.isWalkable(it.cell)) it.cell = sim.nav.nearestWalkable(it.pos.x, it.pos.y, it.pos.z, 4);
      // the death signal: oleic acid starts to rise from the body
      sim.pheromones.deposit(colony.id, Phero.death, it.cell, B.deathDeposit);
      const inNest = Math.hypot(it.pos.x - colony.nestPos.x, it.pos.y - colony.nestPos.y, it.pos.z - colony.nestPos.z) < 10;
      ensureJob(sim, colony, ext, 'cc' + it.id, 'carryCorpse', it.cell, it.pos, it.id, inNest ? 0.75 : 0.5, 1);
    } else if (isFoodItem(it, colony.id)) {
      if (chamberAt(colony, 'granary', it.pos, 0)) continue; // absorbed into the stores by the food system
      const dn = Math.hypot(it.pos.x - colony.nestPos.x, it.pos.y - colony.nestPos.y, it.pos.z - colony.nestPos.z);
      const de = entrance >= 0 ? Math.hypot(it.pos.x - _p.x, it.pos.y - _p.y, it.pos.z - _p.z) : Infinity;
      if (!ext.knownSources.has(it.id) && dn > 14 && de > 10) continue; // nobody has found it yet
      if (it.cell < 0 || !sim.nav.isWalkable(it.cell)) it.cell = sim.nav.nearestWalkable(it.pos.x, it.pos.y, it.pos.z, 4);
      ensureJob(sim, colony, ext, 'hf' + it.id, 'haulFood', it.cell, it.pos, it.id, 0.6, Math.max(1, Math.min(4, Math.ceil(it.amount / 3))));
    }
  }

  // ---- designations ----
  const pop = colony.population;
  const crowd = pop.total + pop.eggs + pop.larvae + pop.pupae > ext.popCap * 0.8 ? 0.2 : 0;
  // the colony's own building projects never tie up more than a share of the workforce
  let autoDiggers = 0;
  for (const job of colony.jobs) if (job.kind === 'dig' && ext.autoDesignations.has(job.designationId)) autoDiggers += job.assigned.length;
  let autoRoom = Math.max(1, Math.round(ext.workers * B.autoDigShare)) - autoDiggers;
  for (const d of colony.designations) {
    if (d.done) continue;
    const key = (d.kind === 'dig' ? 'dg' : 'bd') + d.id;
    const old = ext.jobByKey.get(key);
    let cell = old ? old.cell : -1;
    if (cell < 0 || !sim.nav.isWalkable(cell) || (sim.tick + d.id) % 50 < B.jobsEveryTicks) cell = sim.nav.nearestWalkable(d.center.x, d.center.y, d.center.z, Math.ceil(d.radius + 2.5));
    if (d.kind === 'dig') {
      const auto = ext.autoDesignations.has(d.id);
      let u = auto ? B.autoDigUrgency + crowd : 0.72;
      if (inDigBeacon(colony, d.center)) u = Math.min(1, u * 1.5);
      const blocked = ext.digBlocked.get(d.id);
      if (blocked !== undefined) {
        if (sim.tick < blocked) u = 0;
        else ext.digBlocked.delete(d.id);
      }
      const left = designationProgress(sim, d.id)?.left ?? 2;
      let slots = Math.max(1, Math.min(3, Math.ceil(left / 2)));
      if (auto && u > 0) {
        const have = old ? old.assigned.length : 0;
        slots = Math.min(slots, have + Math.max(0, autoRoom));
        autoRoom -= Math.max(0, slots - have);
      }
      ensureJob(sim, colony, ext, key, 'dig', cell, d.center, 0, u, slots, d.id, d.radius);
    } else {
      ensureJob(sim, colony, ext, key, 'build', cell, d.center, 0, 0.6, 1, d.id, d.material);
    }
  }

  // ---- posts ----
  if (ext.patrolPoints.length > 0) {
    const soldiers = pop.byCaste.soldier ?? 0;
    sim.world.cellCenter(ext.patrolPoints[0], _p);
    ensureJob(sim, colony, ext, 'pt', 'patrol', ext.patrolPoints[0], _p, 0, 0.35, Math.max(1, Math.ceil(soldiers * 0.7)));
    if (entrance >= 0) {
      sim.world.cellCenter(entrance, _p);
      ensureJob(sim, colony, ext, 'gd', 'guard', entrance, _p, 0, 0.4, 2);
    }
  }

  // ---- retire met needs; validate reservations ----
  for (let i = colony.jobs.length - 1; i >= 0; i--) {
    const job = colony.jobs[i];
    const mine = ext.jobsById.get(job.id) === job;
    if (!mine) continue; // jobs added by other streams' systems are left alone
    for (let k = job.assigned.length - 1; k >= 0; k--) {
      const a = sim.getAnt(job.assigned[k]);
      if (!a || !holdsJob(a, job.id)) job.assigned.splice(k, 1);
    }
  }
  for (const [key, job] of ext.jobByKey) if (!seen.has(key)) retireJob(colony, ext, job, key);

  // ---- stimulus per kind ----
  for (const k of JOB_KINDS) ext.demand[k] = 0;
  for (const job of colony.jobs) {
    if (job.cell < 0 || job.assigned.length >= job.slots) continue;
    const s = job.urgency * colony.priorities[job.kind];
    if (s > ext.demand[job.kind]) ext.demand[job.kind] = s;
  }

  // foraging: need from the stores, capped by how many are already out, boosted by a live trail
  let foragers = 0;
  for (const a of sim.ants) {
    if (!a.alive || a.colony !== colony.id) continue;
    const t = dutyTask(a);
    if (t && t.kind === 'gather') foragers++;
  }
  ext.foragers = foragers;
  let trail = 0;
  if (entrance >= 0) {
    const w = sim.world;
    w.cellCoords(entrance, _p);
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!w.inBounds(_p.x + dx, _p.y + dy, _p.z + dz)) continue;
          const v = sim.pheromones.sample(colony.id, Phero.food, w.index(_p.x + dx, _p.y + dy, _p.z + dz));
          if (v > trail) trail = v;
        }
  }
  ext.entranceTrail = trail;
  updateForageDemand(colony, ext);
}

// ---- beacons ---------------------------------------------------------------------------------------

function beaconCells(sim: SimState, ext: ColonyExt, b: Beacon) {
  let bc = ext.beaconCells.get(b.id);
  if (bc && bc.version === sim.world.version) return bc;
  const w = sim.world;
  const cells: number[] = [];
  const weights: number[] = [];
  const r = Math.ceil(b.radius);
  for (let y = Math.floor(b.pos.y - r); y <= b.pos.y + r; y++)
    for (let z = Math.floor(b.pos.z - r); z <= b.pos.z + r; z++)
      for (let x = Math.floor(b.pos.x - r); x <= b.pos.x + r; x++) {
        if (!w.inBounds(x, y, z)) continue;
        const d = Math.hypot(x + 0.5 - b.pos.x, y + 0.5 - b.pos.y, z + 0.5 - b.pos.z);
        if (d > b.radius) continue;
        const cell = w.index(x, y, z);
        if (!sim.nav.isWalkable(cell)) continue;
        cells.push(cell);
        weights.push(1 - 0.7 * (d / b.radius));
      }
  bc = { version: w.version, cells: Int32Array.from(cells), weights: Float32Array.from(weights) };
  ext.beaconCells.set(b.id, bc);
  return bc;
}

function eligible(sim: SimState, ant: Ant, b: Beacon): boolean {
  if (ant.caste === 'queen' || ant.caste === 'king' || ant.possessed || ant.followId || ant.mem['exiled'] || ant.mem['beacon'] || hasPlayerTask(ant)) return false;
  // just given a direct order: the beacon does not pull it straight back
  if ((ant.mem['bc.no'] ?? 0) > sim.tick) return false;
  const th = getCaste(ant.species, ant.caste).thresholds;
  if (b.kind === 'gather') return th.forage !== undefined;
  if (b.kind === 'dig') return th.dig !== undefined && th.dig < 1;
  return true;
}

/** Per sim: attack beacon id → last tick it had something to do (a hostile near, or nobody there yet). */
const beaconBusy = new WeakMap<SimState, Map<number, number>>();
const _movers: Mover[] = [];
const _bp = v3();

/** The living rival colony whose nest or entrance an Attack beacon sits on (a standing war), if any. */
function warTarget(sim: SimState, colony: Colony, b: Beacon): Colony | undefined {
  const r = BALANCE.b1.raid.beaconNestRadius;
  for (const c of sim.colonies) {
    if (!c.alive || c.id === colony.id) continue;
    if (Math.hypot(b.pos.x - c.nestPos.x, b.pos.y - c.nestPos.y, b.pos.z - c.nestPos.z) <= r) return c;
    for (const e of c.entrances) {
      sim.world.cellCenter(e, _bp);
      if (Math.hypot(b.pos.x - _bp.x, b.pos.y - _bp.y, b.pos.z - _bp.z) <= r) return c;
    }
  }
  return undefined;
}

/**
 * Attack beacons are not permanent: one expires once it has had nothing to fight for
 * `attackBeaconIdle` seconds (hostiles gone, ants standing around), and in any case after
 * `attackBeaconLife` — re-placing it starts a fresh one. A beacon on a living rival nest is a
 * declared war (rivalsRaid.ts musters the party) and stands until that colony falls.
 */
function attackBeaconExpired(sim: SimState, colony: Colony, b: Beacon): boolean {
  const B = BALANCE.a2b;
  let busy = beaconBusy.get(sim);
  if (!busy) beaconBusy.set(sim, (busy = new Map()));
  if (warTarget(sim, colony, b)) {
    busy.set(b.id, sim.tick);
    return false;
  }
  if (sim.tick - b.createdTick > B.attackBeaconLife * 30) return true;
  let hostile = false;
  let manned = false;
  sim.spatial.queryMovers(b.pos.x, b.pos.y, b.pos.z, b.radius + 2 + BALANCE.b1.combat.bodyRadiusMax, _movers);
  for (const mv of _movers) {
    const m = mv as Ant | Creature;
    if (!m.alive) continue;
    const dd = Math.hypot(m.pos.x - b.pos.x, m.pos.y - b.pos.y, m.pos.z - b.pos.z);
    if (m.kind === 'ant') {
      if (m.colony !== colony.id) hostile ||= dd <= b.radius + 2;
      else manned ||= dd <= b.radius;
    } else if ((m.colony === 0 || m.colony !== colony.id) && getCreature(m.def).role !== 'herd') hostile ||= dd <= b.radius + 2 + m.clearance;
  }
  // idle clock: runs only while own ants are there and nothing hostile is
  const last = hostile || !manned ? sim.tick : (busy.get(b.id) ?? b.createdTick);
  busy.set(b.id, last);
  return sim.tick - last > B.attackBeaconIdle * 30;
}

function updateBeacons(sim: SimState, colony: Colony, ext: ColonyExt): void {
  const B = BALANCE.a2b;
  for (let i = colony.beacons.length - 1; i >= 0; i--) {
    const b = colony.beacons[i];
    if (b.kind !== 'attack' || !attackBeaconExpired(sim, colony, b)) continue;
    colony.beacons.splice(i, 1);
    beaconBusy.get(sim)?.delete(b.id);
    removeBeacon(sim, colony, ext, b);
  }
  for (const b of colony.beacons) {
    if (sim.tick % 30 < B.jobsEveryTicks) {
      const bc = beaconCells(sim, ext, b);
      const ch = BEACON_CHANNEL[b.kind];
      for (let i = 0; i < bc.cells.length; i++) sim.pheromones.deposit(colony.id, ch, bc.cells[i], B.beaconDeposit * bc.weights[i]);
    }
    const quota = B.beaconQuota[b.kind];
    if (quota <= 0) continue;
    let list = ext.beaconAssigned.get(b.id);
    if (!list) ext.beaconAssigned.set(b.id, (list = []));
    for (let i = list.length - 1; i >= 0; i--) {
      const a = sim.getAnt(list[i]);
      if (!a || a.mem['beacon'] !== b.id) list.splice(i, 1);
    }
    if (list.length >= quota) continue;
    const range = b.radius * B.beaconCallRange;
    const cands: { ant: Ant; d: number }[] = [];
    for (const a of sim.ants) {
      if (!a.alive || a.colony !== colony.id || !eligible(sim, a, b)) continue;
      let d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
      const fighter = b.kind === 'rally' || b.kind === 'attack';
      if (fighter && a.caste === 'soldier') d *= 0.4; // soldiers answer first and from farther away
      if (d > range) continue;
      cands.push({ ant: a, d });
    }
    cands.sort((x, y) => x.d - y.d || x.ant.id - y.ant.id);
    for (const c of cands) {
      if (list.length >= quota) break;
      c.ant.mem['beacon'] = b.id;
      c.ant.thinkAt = sim.tick;
      list.push(c.ant.id);
    }
  }
}

function removeBeacon(sim: SimState, colony: Colony, ext: ColonyExt, b: Beacon): void {
  for (const id of ext.beaconAssigned.get(b.id) ?? []) {
    const a = sim.getAnt(id);
    if (a && a.mem['beacon'] === b.id) {
      a.mem['beacon'] = 0;
      a.thinkAt = sim.tick;
    }
  }
  ext.beaconAssigned.delete(b.id);
  ext.beaconCells.delete(b.id);
  sim.emit({ type: 'beaconChanged', tick: sim.tick, op: 'remove', beacon: b });
}

export const jobsSystem: SimSystem = {
  id: 'jobs',
  commands: ['beacon', 'designate'],
  onCommand(sim, cmd) {
    const colony = sim.getColony(sim.playerColony);
    if (!colony) return;
    const ext = getExt(sim, colony.id);
    if (cmd.type === 'beacon') {
      if (cmd.op === 'place') {
        const b: Beacon = {
          id: sim.nextId(),
          kind: cmd.kind,
          colony: colony.id,
          pos: v3clone(cmd.pos),
          cell: sim.nav.nearestWalkable(cmd.pos.x, cmd.pos.y, cmd.pos.z, 6),
          radius: cmd.radius ?? BALANCE.a2b.beaconRadius,
          createdTick: sim.tick,
        };
        colony.beacons.push(b);
        sim.emit({ type: 'beaconChanged', tick: sim.tick, op: 'place', beacon: b });
        sim.emit({ type: 'pheromoneBurst', tick: sim.tick, colony: colony.id, channel: BEACON_CHANNEL[b.kind], pos: v3clone(b.pos) });
        // a Dig beacon on bare ground is a "dig here" marker
        if (b.kind === 'dig' && ext.active && !colony.designations.some((d) => d.kind === 'dig' && Math.hypot(d.center.x - b.pos.x, d.center.y - b.pos.y, d.center.z - b.pos.z) < b.radius + 2)) {
          const w = sim.world;
          const cx = Math.floor(b.pos.x);
          const cy = Math.floor(b.pos.y - 1.2);
          const cz = Math.floor(b.pos.z);
          if (w.inBounds(cx, cy, cz) && w.isSolid(cx, cy, cz) && Number.isFinite(MATERIALS[w.materialAt(cx, cy, cz)].digCost)) {
            const d: Designation = { id: sim.nextId(), kind: 'dig', colony: colony.id, center: v3(b.pos.x, b.pos.y - 1.2, b.pos.z), radius: 2, material: Mat.Air, done: false };
            colony.designations.push(d);
            sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'add', designation: d });
          }
        }
      } else {
        const i = colony.beacons.findIndex((b) => b.id === cmd.id);
        if (i >= 0) {
          const [b] = colony.beacons.splice(i, 1);
          removeBeacon(sim, colony, ext, b);
        }
      }
    } else if (cmd.type === 'designate') {
      if (cmd.op === 'add') {
        const d: Designation = {
          id: sim.nextId(),
          kind: cmd.kind,
          colony: colony.id,
          center: v3clone(cmd.center),
          radius: Math.max(1.5, cmd.radius),
          material: cmd.kind === 'build' ? (cmd.material ?? Mat.Mud) : Mat.Air,
          done: false,
        };
        colony.designations.push(d);
        sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'add', designation: d });
      } else {
        // remove every designation of that kind whose centre lies inside the eraser brush
        for (let i = colony.designations.length - 1; i >= 0; i--) {
          const d = colony.designations[i];
          if (d.kind !== cmd.kind) continue;
          if (Math.hypot(d.center.x - cmd.center.x, d.center.y - cmd.center.y, d.center.z - cmd.center.z) > cmd.radius) continue;
          colony.designations.splice(i, 1);
          ext.autoDesignations.delete(d.id);
          ext.digBlocked.delete(d.id);
          sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'remove', designation: d });
        }
      }
    }
  },
  update(sim) {
    const every = BALANCE.a2b.jobsEveryTicks;
    for (const colony of sim.colonies) {
      if (!colony.alive || (sim.tick + colony.id * 3) % every !== 0) continue;
      const ext = getExt(sim, colony.id);
      if (ext.active) {
        updateBoard(sim, colony, ext);
        if (sim.tick % 150 < every) {
          const k = BALANCE.a2b.exploreDecay;
          for (const [key, v] of ext.explored) {
            if (v * k < 0.05) ext.explored.delete(key);
            else ext.explored.set(key, v * k);
          }
        }
      }
      if (colony.beacons.length > 0) updateBeacons(sim, colony, ext);
    }
  },
};
