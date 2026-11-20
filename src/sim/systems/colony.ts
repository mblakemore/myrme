import { ISO, MATERIALS, Mat, clamp, getMapExtras, v3, v3clone, type CellIndex, type ChamberKind, type Colony, type Designation, type SimState, type SimSystem, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { addChamber, alertOnce, chamberOf, floorCellNear, getExt, type ColonyExt } from './colonyState';

/**
 * Colony bookkeeping and the colony's own initiative (§5.2):
 *  - commands: priority sliders, caste ratio
 *  - at start: staggers the founding workers' ages (so there are nurses AND foragers), designates
 *    chambers in the starter nest (queen / nursery / granary / entrance / midden), patrol ring
 *  - population counts by caste and brood stage (HUD), nest volume → population cap
 *  - autonomous growth: when the nest is crowded (or the colony is hungry and lives in edible
 *    ground) it plans a tunnel + chamber as ordinary dig designations; when they are dug the new
 *    chamber is registered ("new chamber complete") and brood / stores move there
 *  - queen death alert
 * Inactive (only commands + counts) in the wander fixture.
 */

const EXPANSION_KINDS: readonly ChamberKind[] = ['nursery', 'granary', 'barracks'];
const _p = v3();

function horizontalDir(sim: SimState, from: Vec3, to: Vec3 | null): Vec3 {
  const d = v3(1, 0, 0);
  if (to) {
    d.x = to.x - from.x;
    d.z = to.z - from.z;
  }
  if (sim.map.flags.slab) {
    if (sim.map.flags.slabAxis === 'z') d.z = 0;
    else d.x = 0;
  }
  const l = Math.hypot(d.x, d.z);
  if (l < 1e-3) {
    d.x = sim.map.flags.slab && sim.map.flags.slabAxis === 'x' ? 0 : 1;
    d.z = sim.map.flags.slab && sim.map.flags.slabAxis === 'x' ? 1 : 0;
  } else {
    d.x /= l;
    d.z /= l;
  }
  return d;
}

function countAir(sim: SimState, c: Vec3, r: number): number {
  const w = sim.world;
  let n = 0;
  const R = Math.ceil(r);
  for (let y = Math.floor(c.y - R); y <= c.y + R; y++)
    for (let z = Math.floor(c.z - R); z <= c.z + R; z++)
      for (let x = Math.floor(c.x - R); x <= c.x + R; x++) {
        if (!w.inBounds(x, y, z)) continue;
        const dx = x + 0.5 - c.x;
        const dy = y + 0.5 - c.y;
        const dz = z + 0.5 - c.z;
        if (dx * dx + dy * dy + dz * dz > r * r) continue;
        if (w.density[w.index(x, y, z)] < ISO) n++;
      }
  return n;
}

function setupColony(sim: SimState, colony: Colony, ext: ColonyExt): void {
  const B = BALANCE.a2b;
  const spawn = sim.map.spawns.find((s) => s.kind === 'colony');
  const R = spawn?.radius ?? 5;
  const nest = colony.nestPos;

  // founding workers: ages spread so the colony starts with both nurses and foragers
  const founders = sim.ants.filter((a) => a.colony === colony.id && Number.isFinite(a.lifespan));
  founders.forEach((a, i) => {
    a.age = Math.round(a.lifespan * B.startAgeSpread * ((i + 0.5) / founders.length));
  });

  const entranceCell = colony.entrances[0] ?? -1;
  const entrancePos = entranceCell >= 0 ? sim.world.cellCenter(entranceCell, v3()) : null;
  const dirE = horizontalDir(sim, nest, entrancePos);

  const queen = colony.chambers[0];
  queen.radius = Math.max(2.5, R * 0.5);
  const sub = Math.max(2.2, R * 0.42);
  // nursery deep in the room (away from the entrance), pantry on the entrance side
  addChamber(sim, colony, 'nursery', v3(nest.x - dirE.x * R * 0.52, nest.y, nest.z - dirE.z * R * 0.52), sub);
  addChamber(sim, colony, 'granary', v3(nest.x + dirE.x * R * 0.52, nest.y, nest.z + dirE.z * R * 0.52), sub);

  if (entrancePos) {
    const e = addChamber(sim, colony, 'entrance', entrancePos, 2.5);
    e.cell = entranceCell;
    e.pos = v3clone(entrancePos);
  }

  // midden: outside, beyond the entrance, away from the nest and brood
  let middenCell = -1;
  if (entrancePos) {
    for (const sgn of [1, -1]) {
      for (const dist of [B.middenDistance, B.middenDistance * 0.6]) {
        const x = entrancePos.x + dirE.x * dist * sgn;
        const z = entrancePos.z + dirE.z * dist * sgn;
        if (x < 3 || z < 3 || x > sim.world.sx - 3 || z > sim.world.sz - 3) continue;
        const c = floorCellNear(sim, x, entrancePos.y, z, 5);
        if (c >= 0) {
          sim.world.cellCenter(c, _p);
          // must be outside the nest and its nursery
          if (Math.hypot(_p.x - nest.x, _p.y - nest.y, _p.z - nest.z) > R + 3) {
            middenCell = c;
            break;
          }
        }
      }
      if (middenCell >= 0) break;
    }
  }
  if (middenCell >= 0) {
    const m = addChamber(sim, colony, 'midden', sim.world.cellCenter(middenCell, v3()), B.middenRadius);
    m.cell = middenCell;
  } else {
    // sealed nest: a corner of the room, as far from the nursery as the room allows
    const px = -dirE.z;
    const pz = dirE.x;
    addChamber(sim, colony, 'midden', v3(nest.x + dirE.x * R * 0.55 + px * R * 0.55, nest.y, nest.z + dirE.z * R * 0.55 + pz * R * 0.55), 1.8);
  }

  // patrol ring around the entrance (or the nest if it has none)
  const c0 = entrancePos ?? nest;
  const n = sim.map.flags.slab ? 2 : B.patrolPoints;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = c0.x + (sim.map.flags.slab ? (i === 0 ? 1 : -1) * dirE.x : Math.cos(a)) * B.patrolRadius;
    const z = c0.z + (sim.map.flags.slab ? (i === 0 ? 1 : -1) * dirE.z : Math.sin(a)) * B.patrolRadius;
    const cell = sim.nav.nearestWalkable(x, c0.y, z, 5);
    if (cell >= 0) ext.patrolPoints.push(cell);
  }
  if (entranceCell >= 0) ext.patrolPoints.push(entranceCell);

  ext.baseVolume = countAir(sim, v3(nest.x, nest.y + 1.5, nest.z), R + 1.5);
  // M3: pre-carved, unowned rooms of a farm (the formicarium's plaster chambers) are living space
  // too — without them the population cap sat below the map's own goal in undiggable plaster
  if (sim.map.flags.slab && colony.controller === 'player') {
    for (const ch of getMapExtras(sim.map)?.chambers ?? []) {
      if (ch.owner !== 'neutral' || ch.kind === 'midden') continue;
      ext.baseVolume += countAir(sim, ch.pos, Math.max(1.5, Math.min(ch.radii.x, ch.radii.y)));
    }
  }
  ext.nextExpandTick = Math.round(B.expandCooldown * 30);
  ext.lastQueenId = colony.queenId;
}

// ---- autonomous expansion ---------------------------------------------------------------------

function solidAt(sim: SimState, x: number, y: number, z: number, margin: number, min: number): boolean {
  const w = sim.world;
  const slab = sim.map.flags.slab ? sim.map.flags.slabAxis : '';
  if (y < margin || y > w.sy - margin) return false;
  if (slab !== 'x' && (x < margin || x > w.sx - margin)) return false;
  if (slab !== 'z' && (z < margin || z > w.sz - margin)) return false;
  if (!w.inBounds(Math.floor(x), Math.floor(y), Math.floor(z))) return false;
  if (w.sample(x, y, z) < min) return false;
  return Number.isFinite(MATERIALS[w.materialAt(Math.floor(x), Math.floor(y), Math.floor(z))].digCost);
}

function addAutoDesignation(sim: SimState, colony: Colony, ext: ColonyExt, center: Vec3, radius: number): number {
  const d: Designation = { id: sim.nextId(), kind: 'dig', colony: colony.id, center: v3clone(center), radius, material: Mat.Air, done: false };
  colony.designations.push(d);
  ext.autoDesignations.add(d.id);
  sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'add', designation: d });
  return d.id;
}

/** Find room for a tunnel + chamber next to an existing chamber and designate it. */
export function planExpansion(sim: SimState, colony: Colony, ext: ColonyExt, kind: ChamberKind): boolean {
  const B = BALANCE.a2b;
  const slab = sim.map.flags.slab ? sim.map.flags.slabAxis : '';
  const sources = colony.chambers.filter((c) => c.kind !== 'midden' && c.kind !== 'entrance');
  // newest rooms last in the list → try the royal chamber first, then outward
  const angles: number[] = [];
  if (slab === 'z') angles.push(0, Math.PI);
  else if (slab === 'x') angles.push(Math.PI / 2, -Math.PI / 2);
  else for (let i = 0; i < 8; i++) angles.push((i / 8) * Math.PI * 2);
  // (M3: slabs may also climb steeply — once the band around the royal chamber is eaten out, the
  // untouched fill is mostly above it)
  const pitches = slab ? [-0.45, 0, -0.9, 0.45, 0.9, 1.25] : [-0.2, 0, -0.5];
  const CR = B.chamberRadius;
  // M3: with one fixed reach the candidate spots form a lattice that closes on itself after two or
  // three rooms (every spot lands on an existing room or its margin) — seen on the gel farm, where
  // the nest stopped growing at 326 voxels and the population cap froze the colony. Longer
  // connecting tunnels are tried when the short one finds nothing (the score still prefers near).
  const reaches = slab ? [1, 1.6, 2.3, 3.1] : [1, 1.6, 2.3];
  const start = v3();
  const T = v3();
  const dir = v3();
  let best: { start: Vec3; dir: Vec3; T: Vec3; L: number } | null = null;
  let bestScore = Infinity;
  for (const reach of reaches) {
    if (best) break;
    const L = B.tunnelLength * reach;
    for (let si = 0; si < sources.length; si++) {
      const src = sources[(si + ext.expansions) % sources.length];
      for (const pitch of pitches) {
        for (let k = 0; k < angles.length; k++) {
          const a = angles[(k + ext.expansions * 3 + src.id) % angles.length];
          const cp = Math.cos(pitch);
          dir.x = Math.cos(a) * cp;
          dir.y = Math.sin(pitch);
          dir.z = Math.sin(a) * cp;
          if (slab === 'z') dir.z = 0;
          if (slab === 'x') dir.x = 0;
          // tunnel axis starts at ant height above the chamber floor, just inside its wall
          const edge = Math.max(1, src.radius - 0.5);
          start.x = src.pos.x + dir.x * edge;
          start.y = src.pos.y + 1.2 + dir.y * edge;
          start.z = src.pos.z + dir.z * edge;
          const reachLen = L + CR + 1.5;
          T.x = start.x + dir.x * reachLen;
          T.y = start.y + dir.y * reachLen;
          T.z = start.z + dir.z * reachLen;
          // the chamber must sit in undisturbed diggable ground with a roof and walls to spare
          const probe = CR + 1.6;
          let ok = solidAt(sim, T.x, T.y, T.z, 4, 0.6);
          ok = ok && solidAt(sim, T.x, T.y + probe, T.z, 3, 0.6) && solidAt(sim, T.x, T.y + probe + 2, T.z, 2, 0.3) && solidAt(sim, T.x, T.y - probe, T.z, 3, 0.6);
          if (ok && slab !== 'x') ok = solidAt(sim, T.x + probe, T.y, T.z, 3, 0.6) && solidAt(sim, T.x - probe, T.y, T.z, 3, 0.6);
          if (ok && slab !== 'z') ok = solidAt(sim, T.x, T.y, T.z + probe, 3, 0.6) && solidAt(sim, T.x, T.y, T.z - probe, 3, 0.6);
          ok = ok && solidAt(sim, T.x + dir.x * probe, T.y + dir.y * probe, T.z + dir.z * probe, 3, 0.6);
          for (let s = 3; ok && s <= L; s += 1.5) ok = solidAt(sim, start.x + dir.x * s, start.y + dir.y * s, start.z + dir.z * s, 3, 0.3);
          if (!ok) continue;
          let clear = true;
          for (const ch of colony.chambers) if (Math.hypot(ch.pos.x - T.x, ch.pos.y - T.y, ch.pos.z - T.z) < ch.radius + CR + 2) clear = false;
          for (const d of colony.designations) if (Math.hypot(d.center.x - T.x, d.center.y - T.y, d.center.z - T.z) < d.radius + CR + 1) clear = false;
          if (!clear) continue;
          // compact nests: prefer the spot closest to the royal chamber (short hauls), flat over steep
          const score = Math.hypot(T.x - colony.nestPos.x, T.y - colony.nestPos.y, T.z - colony.nestPos.z) + Math.abs(pitch) * 3;
          if (score < bestScore) {
            bestScore = score;
            best = { start: v3clone(start), dir: v3clone(dir), T: v3clone(T), L };
          }
        }
      }
    }
  }
  if (!best) return false;
  {
    {
      {
        const { start: s0, dir: d0, T: t0, L } = best;
        const ids: number[] = [];
        for (let s = 0; s <= L + 0.01; s += 1.5) ids.push(addAutoDesignation(sim, colony, ext, v3(s0.x + d0.x * s, s0.y + d0.y * s, s0.z + d0.z * s), B.tunnelRadius));
        ids.push(addAutoDesignation(sim, colony, ext, t0, CR));
        // widen the room sideways (in the slab plane on farm maps) for a low, broad chamber
        const side = CR * 0.7;
        const offs: [number, number][] = slab === 'z' ? [[1, 0], [-1, 0]] : slab === 'x' ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [ox, oz] of offs) ids.push(addAutoDesignation(sim, colony, ext, v3(t0.x + ox * side, t0.y - 0.3, t0.z + oz * side), CR - 0.5));
        ext.plan = { kind, designations: ids, center: v3clone(t0), radius: CR + side * 0.6, startedTick: sim.tick };
        return true;
      }
    }
  }
  return false;
}

function updateExpansion(sim: SimState, colony: Colony, ext: ColonyExt): void {
  const B = BALANCE.a2b;
  const plan = ext.plan;
  if (plan) {
    plan.designations = plan.designations.filter((id) => colony.designations.some((d) => d.id === id));
    if (plan.designations.length === 0) {
      const ch = addChamber(sim, colony, plan.kind, v3(plan.center.x, plan.center.y - 1, plan.center.z), plan.radius);
      ext.plan = null;
      ext.expansions++;
      ext.nextExpandTick = sim.tick + Math.round(B.expandCooldown * 30);
      alertOnce(sim, colony, 'info', `New chamber complete: ${plan.kind}`, ch.pos, 0, 0);
    } else if (sim.tick - plan.startedTick > 300 * 30) {
      // stalled (rock, flooded, nobody free): give up on the rest and plan elsewhere later
      for (const id of plan.designations) {
        const i = colony.designations.findIndex((d) => d.id === id);
        if (i < 0) continue;
        const [d] = colony.designations.splice(i, 1);
        ext.autoDesignations.delete(id);
        sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'remove', designation: d });
      }
      ext.plan = null;
      ext.expansions++;
      ext.nextExpandTick = sim.tick + Math.round(B.expandCooldown * 30);
    }
    return;
  }
  if (sim.tick < ext.nextExpandTick || ext.workers < 4) return;
  const pop = colony.population;
  const load = pop.total + pop.eggs + pop.larvae + pop.pupae;
  const brood = pop.eggs + pop.larvae + pop.pupae;
  const nurseries = colony.chambers.filter((c) => c.kind === 'nursery').length;
  const granaries = colony.chambers.filter((c) => c.kind === 'granary').length;
  const wantNursery = brood > B.nurseryBrood * nurseries;
  const wantGranary = colony.stores.food > B.granaryFood * granaries;
  const crowded = wantNursery || wantGranary || load > ext.popCap * B.crowdedFraction;
  // living in edible ground (gel farm): tunnelling IS foraging when the stores run low
  let hungryDig = false;
  if (!crowded && colony.stores.food < B.foodLowPerAnt * 3 * pop.total) {
    const q = chamberOf(colony, 'queen');
    const w = sim.world;
    hungryDig = MATERIALS[w.materialAt(Math.floor(q.pos.x), Math.floor(q.pos.y) - 2, Math.floor(q.pos.z))].edibleByAnts;
  }
  if (!crowded && !hungryDig) return;
  const kind = wantNursery ? 'nursery' : wantGranary || hungryDig ? 'granary' : EXPANSION_KINDS[ext.expansions % EXPANSION_KINDS.length];
  if (!planExpansion(sim, colony, ext, kind)) ext.nextExpandTick = sim.tick + Math.round(B.expandCooldown * 30 * 2);
}

const anchoredAt = new WeakMap<Colony, number>();

/**
 * Digging (the colony's own expansions included) can turn an anchor cell into open air: the nest
 * cell in the middle of a widened chamber is no longer next to a surface, so it stops being
 * walkable. Without a walkable source the home field goes blank and every ant's way home fails
 * (seen on the sand farm, where the first expansion starts at the nest itself). After each world
 * edit, move such anchors to the nearest walkable cell.
 */
function reanchor(sim: SimState, colony: Colony, ext: ColonyExt): void {
  if (anchoredAt.get(colony) === sim.world.version) return;
  anchoredAt.set(colony, sim.world.version);
  const nav = sim.nav;
  const fix = (cell: CellIndex, pos: Readonly<Vec3>, radius: number): CellIndex => {
    if (cell >= 0 && nav.isWalkable(cell)) return cell;
    const c = nav.nearestWalkable(pos.x, pos.y, pos.z, radius);
    return c >= 0 ? c : cell;
  };
  const nest = fix(colony.nestCell, colony.nestPos, 8);
  if (nest !== colony.nestCell) {
    colony.nestCell = nest;
    nav.setHome(colony.id, [nest]);
  }
  for (const ch of colony.chambers) ch.cell = fix(ch.cell, ch.pos, Math.max(4, Math.ceil(ch.radius) + 2));
  for (let i = 0; i < colony.entrances.length; i++) {
    const c = colony.entrances[i];
    if (c >= 0 && !nav.isWalkable(c)) colony.entrances[i] = fix(c, sim.world.cellCenter(c, _p), 4);
  }
  for (let i = 0; i < ext.patrolPoints.length; i++) {
    const c = ext.patrolPoints[i];
    if (c >= 0 && !nav.isWalkable(c)) ext.patrolPoints[i] = fix(c, sim.world.cellCenter(c, _p), 4);
  }
}

function countPopulation(sim: SimState): void {
  for (const c of sim.colonies) {
    c.population.total = 0;
    c.population.byCaste = {};
    c.population.eggs = c.population.larvae = c.population.pupae = 0;
  }
  for (const a of sim.ants) {
    const c = sim.getColony(a.colony);
    if (!c || !a.alive) continue;
    // M3: a death-gripped fungus host is a corpse on a stem, not a colony member (it used to
    // count towards population goals, the nuptial flight threshold and the pop cap)
    const st = a.infection.stage;
    if (st === 'gripped' || st === 'fruiting' || st === 'burst') continue;
    c.population.total++;
    c.population.byCaste[a.caste] = (c.population.byCaste[a.caste] ?? 0) + 1;
  }
  for (const b of sim.brood) {
    const c = sim.getColony(b.colony);
    if (!c || !b.alive) continue;
    if (b.stage === 'egg') c.population.eggs++;
    else if (b.stage === 'larva') c.population.larvae++;
    else c.population.pupae++;
  }
}

export const colonySystem: SimSystem = {
  id: 'colony',
  commands: ['setPriority', 'setCasteRatio'],
  init(sim) {
    for (const colony of sim.colonies) {
      const ext = getExt(sim, colony.id);
      if (ext.active) setupColony(sim, colony, ext);
    }
    countPopulation(sim);
  },
  onCommand(sim, cmd) {
    const colony = sim.getColony(sim.playerColony);
    if (!colony) return;
    if (cmd.type === 'setPriority') colony.priorities[cmd.job] = clamp(cmd.value, 0, 2);
    else if (cmd.type === 'setCasteRatio') colony.casteRatio[cmd.caste] = Math.max(0, cmd.value);
  },
  update(sim) {
    if (sim.tick % 15 !== 0) return;
    countPopulation(sim);
    for (const colony of sim.colonies) {
      const ext = getExt(sim, colony.id);
      if (!ext.active || !colony.alive) continue;
      // colonies founded after init (rivals, B1) get their chambers on first sight
      if (ext.baseVolume === 0 && colony.chambers.length <= 1) setupColony(sim, colony, ext);
      reanchor(sim, colony, ext);
      ext.workers = colony.population.total - (colony.population.byCaste.queen ?? 0) - (colony.population.byCaste.king ?? 0);
      ext.nestVolume = ext.baseVolume + colony.stats.dugVoxels;
      ext.popCap = Math.max(12, Math.floor(ext.nestVolume / BALANCE.a2b.voxelsPerAnt));
      if (ext.lastQueenId && !sim.getAnt(ext.lastQueenId)) {
        ext.lastQueenId = 0;
        colony.queenId = 0;
        alertOnce(sim, colony, 'queenDead', 'The queen is dead', colony.nestPos, 0, 0);
      } else if (colony.queenId && colony.queenId !== ext.lastQueenId) ext.lastQueenId = colony.queenId;
      if (sim.tick % 30 === 0) updateExpansion(sim, colony, ext);
    }
  },
};

/** Read-only peek for tests/debug: population cap and nest volume of a colony. */
export function colonyCapacity(sim: SimState, colonyId: number) {
  const ext = getExt(sim, colonyId);
  return { popCap: ext.popCap, nestVolume: ext.nestVolume, expansions: ext.expansions, planning: ext.plan !== null, ...ext.counters };
}
