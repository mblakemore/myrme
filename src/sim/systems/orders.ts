import { BALANCE } from '../data/balance';
import { releaseJob } from './jobsBoard';
import { ISO, MATERIALS, Mat, v3, v3clone, type Ant, type CellIndex, type Colony, type Designation, type Entity, type SimState, type SimSystem, type Task, type TaskKind, type Vec3 } from '../../core';
import { getSpecies } from '../data/species';
import { isFoodItem } from '../behaviors/util';
import { makeTask } from '../entities';
import { chamberOf } from './colonyState';

/** `Task.data` of a player gather task whose `targetId` is a wood dig designation (termites). */
export const GATHER_WOOD = 2;

const ORDER_TASK: Record<string, TaskKind> = { move: 'move', gather: 'gather', attack: 'attack', guard: 'guard', follow: 'follow', exile: 'exile' };

/** Golden-angle ring offsets so a group order does not stack every ant on one cell. */
function spread(i: number, out: { x: number; z: number }): void {
  if (i === 0) {
    out.x = 0;
    out.z = 0;
    return;
  }
  const r = 0.9 * Math.sqrt(i);
  const a = i * 2.39996323;
  out.x = Math.cos(a) * r;
  out.z = Math.sin(a) * r;
}

/** Food (source or loose item) nearest to a point, within `radius`. */
function foodNear(sim: SimState, colony: number, p: Vec3, radius: number): Entity | undefined {
  let best: Entity | undefined;
  let bestD = radius;
  for (const f of sim.foodSources) {
    if (!f.alive || f.amount <= 0) continue;
    const d = Math.hypot(f.pos.x - p.x, f.pos.y - p.y, f.pos.z - p.z) - f.radius;
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  for (const it of sim.items) {
    if (it.carriedBy || !isFoodItem(it, colony)) continue;
    const d = Math.hypot(it.pos.x - p.x, it.pos.y - p.y, it.pos.z - p.z);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

/**
 * Termites: a gather order on wood (or leaf litter) means "chew it here". The edible voxel nearest
 * the point (within `reach`) gets a dig designation of its own whose id the order carries; 0 when
 * there is no edible voxel there.
 */
export function woodDesignation(sim: SimState, colony: Colony, p: Vec3, radius: number = BALANCE.b3.termites.woodBrush, reach = 2.5): number {
  const w = sim.world;
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const cz = Math.floor(p.z);
  let best = -1;
  let bestD = reach;
  const R = Math.ceil(reach);
  for (let dy = -R; dy <= R; dy++)
    for (let dz = -R; dz <= R; dz++)
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        if (!w.inBounds(x, y, z)) continue;
        const c = w.index(x, y, z);
        if (w.density[c] < ISO || !MATERIALS[w.material[c]].edibleByTermites) continue;
        const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
  if (best < 0) return 0;
  // always a designation of the order's own: the works retire their wood faces by their own rules
  const at = w.cellCenter(best, v3());
  const d: Designation = { id: sim.nextId(), kind: 'dig', colony: colony.id, center: at, radius, material: Mat.Air, done: false };
  colony.designations.push(d);
  sim.emit({ type: 'designationChanged', tick: sim.tick, op: 'add', designation: d });
  return d.id;
}

function insertPlayerTask(sim: SimState, ant: Ant, kind: TaskKind, cell: CellIndex, pos: Vec3, targetId: number): Task {
  const task = makeTask(sim, kind, 'player', { cell, pos: v3clone(pos), targetId });
  // player tasks sit in front of colony/self tasks, in issue order
  let at = 0;
  while (at < ant.tasks.length && ant.tasks[at].source === 'player') at++;
  ant.tasks.splice(at, 0, task);
  ant.thinkAt = sim.tick; // react immediately (possessed ants keep the order for after release)
  return task;
}

function clearPlayerTasks(ant: Ant): void {
  ant.tasks = ant.tasks.filter((t) => t.source !== 'player');
  ant.mem['exiled'] = 0;
  if (!ant.possessed) ant.path.status = 'none';
}

/**
 * A direct order (stop included) overrides beacon duty and war-party membership at once: the ant
 * leaves its beacon / raid and is not drafted again for a while, so once the order is done it
 * goes back to normal work instead of returning to the beacon it was pulled from.
 */
function releaseFromBeacon(sim: SimState, ant: Ant): void {
  ant.mem['beacon'] = 0;
  ant.mem['raid'] = 0;
  ant.mem['raid.ret'] = 0;
  ant.mem['bc.no'] = sim.tick + Math.round(BALANCE.a2b.beaconOrderCooldown * 30);
}

/**
 * Player orders → tasks with `source:'player'` on the ordered ants (§5.2, §5.4). Without
 * `queue` an order replaces the ant's player tasks; with it (shift-queue) it is appended behind
 * them. Works the same for one ant or a group; colony tasks stay queued behind and resume later.
 *
 *   move    → each ant gets its own cell near the point (golden-angle spread)
 *   gather  → `targetId` = food source/item, or the food nearest `pos` (within 8); if there is
 *             none the ants go to the point and search there. Wood-eaters (termites) sent to
 *             wood chew it: `targetId` = a dig designation on it, `data` = GATHER_WOOD
 *   attack  → `targetId` = creature/ant: chase and bite; no target = attack-move to the point
 *   guard   → hold a spread position around the point (persistent)
 *   follow  → `targetId` = ant/creature to stay close to (persistent)
 *   exile   → `targetId` = own ant: THAT ant is banished to the midden for good (the selected
 *             ants are not affected); without a target the selected ants themselves are exiled
 *   stop    → drop all player tasks (also lifts an exile)
 * `setGroup` stores the control-group number on the ants.
 * Execution: behaviors/playerOrder.ts.
 */
export const ordersSystem: SimSystem = {
  id: 'orders',
  commands: ['order', 'setGroup'],
  onCommand(sim, cmd) {
    if (cmd.type === 'setGroup') {
      for (const id of cmd.ids) {
        const a = sim.getAnt(id);
        if (a && a.colony === sim.playerColony) a.group = cmd.group;
      }
      return;
    }
    if (cmd.type !== 'order') return;
    const colony = sim.getColony(sim.playerColony);
    const p = v3();
    let target = cmd.targetId ? sim.getEntity(cmd.targetId) : undefined;
    const base: Vec3 | null = cmd.pos ?? target?.pos ?? (cmd.cell !== undefined && cmd.cell >= 0 ? sim.world.cellCenter(cmd.cell, p) : null);

    if (cmd.order === 'exile' && colony) {
      const midden = chamberOf(colony, 'midden');
      const victims: Ant[] = [];
      if (target && target.kind === 'ant' && target.colony === colony.id) victims.push(target);
      else for (const id of cmd.ids) {
        const a = sim.getAnt(id);
        if (a && a.colony === colony.id) victims.push(a);
      }
      for (const a of victims) {
        if (a.caste === 'queen') continue; // nobody exiles the queen
        clearPlayerTasks(a);
        releaseFromBeacon(sim, a);
        // an exile gives up her duties: reservations go back to the board
        for (const t of a.tasks) if (t.jobId) releaseJob(sim, a, t.jobId);
        a.tasks.length = 0;
        a.followId = 0;
        insertPlayerTask(sim, a, 'exile', midden.cell, midden.pos, 0);
      }
      sim.emit({ type: 'orderIssued', tick: sim.tick, ids: victims.map((a) => a.id), order: 'exile', pos: v3clone(midden.pos) });
      return;
    }

    if (cmd.order === 'gather' && base && (!target || (target.kind !== 'food' && target.kind !== 'item'))) target = foodNear(sim, sim.playerColony, base, 8);
    // termites chew the wood they are sent to (before any loose food lying further off)
    let wood = 0;
    if (cmd.order === 'gather' && base && colony && getSpecies(colony.species).caps.eatsWood && (!target || !cmd.targetId)) {
      // a bigger bite for a bigger crew, so every ant finds a stamp of its own
      wood = woodDesignation(sim, colony, base, Math.min(4, BALANCE.b3.termites.woodBrush + 0.35 * Math.max(0, cmd.ids.length - 1)));
      if (wood) target = undefined;
    }

    const off = { x: 0, z: 0 };
    let n = 0;
    for (const id of cmd.ids) {
      const ant = sim.getAnt(id);
      if (!ant || ant.colony !== sim.playerColony) continue;
      if (!cmd.queue || cmd.order === 'stop') clearPlayerTasks(ant);
      releaseFromBeacon(sim, ant);
      if (cmd.order === 'stop') {
        ant.thinkAt = sim.tick;
        continue;
      }
      if (cmd.order === 'follow' && (!target || target.id === ant.id || (target.kind !== 'ant' && target.kind !== 'creature'))) continue;
      const at = cmd.order === 'gather' && target ? target.pos : base;
      if (!at) continue;
      let cell = -1;
      if (cmd.order === 'move' || cmd.order === 'guard' || (cmd.order === 'attack' && !target) || (cmd.order === 'gather' && !target)) {
        spread(n++, off);
        cell = sim.nav.nearestWalkable(at.x + off.x, at.y, at.z + off.z, 3, ant.clearance);
      }
      if (cell < 0) cell = sim.nav.nearestWalkable(at.x, at.y, at.z, 8, ant.clearance);
      if (cell < 0) continue;
      const keepTarget = target && (cmd.order === 'gather' || cmd.order === 'attack' || cmd.order === 'follow') ? target.id : 0;
      // guard/move remember the spot they were given, not the click
      const pos = cmd.order === 'move' || cmd.order === 'guard' ? sim.world.cellCenter(cell, p) : at;
      const task = insertPlayerTask(sim, ant, ORDER_TASK[cmd.order], cell, pos, wood || keepTarget);
      if (wood) task.data = GATHER_WOOD;
    }
    sim.emit({ type: 'orderIssued', tick: sim.tick, ids: cmd.ids.slice(), order: cmd.order, pos: base ? v3clone(base) : null });
  },
  update() {},
};
