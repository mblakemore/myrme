import { HOME_UNREACHABLE, v3, type Ant, type CellIndex, type DistanceField, type SimState } from '../../core';

/**
 * Small navigation helpers shared by the B2 behaviors (floodEscape, seekShade, infected):
 * steering down a distance field with stuck detection, and local cell searches.
 */

const _c = v3();

/**
 * Steer a few steps down a distance field (like A2b's `homeward`, for any field). Returns false
 * when the field gives no step from here (not ready, unreachable, already at a source) or the ant
 * has been wedged for a while — the caller then falls back to something else (`approach`).
 * `key` namespaces the stuck memory.
 */
export function followField(sim: SimState, ant: Ant, field: DistanceField, speedMul: number, key: string, steps = 3): boolean {
  const mem = ant.mem;
  const kNo = key + '.no';
  if (mem[kNo] !== undefined && sim.tick < mem[kNo]) return false;
  if (!field.ready || ant.cell < 0 || ant.falling) return false;
  if (field.distance(ant.cell) === HOME_UNREACHABLE) return false;
  let n = ant.cell;
  for (let k = 0; k < steps; k++) {
    const s = field.descend(n);
    if (s < 0) break;
    n = s;
  }
  if (n === ant.cell) return false;
  // real progress: the field distance has to keep dropping (an ant can jitter at full speed on
  // the lip of a ledge whose next cell is across a gap)
  const kD = key + '.d';
  const kT = key + '.t';
  const here = field.distance(ant.cell);
  if (mem[kT] === undefined || sim.tick - mem[kT] > 400 || here < mem[kD]) {
    mem[kD] = here;
    mem[kT] = sim.tick;
  } else if (sim.tick - mem[kT] > 75) {
    mem[kT] = undefined as unknown as number;
    mem[kNo] = sim.tick + 200;
    return false;
  }
  const kS = key + '.s';
  if (ant.intent.mode === 'dir' && ant.moveSpeed < ant.speed * 0.15) {
    const s = (mem[kS] ?? 0) + 1;
    mem[kS] = s;
    if (s > 45) {
      mem[kS] = 0;
      mem[kNo] = sim.tick + 200;
      return false;
    }
  } else mem[kS] = 0;
  sim.world.cellCenter(n, _c);
  const it = ant.intent;
  it.mode = 'dir';
  it.dir.x = _c.x - ant.pos.x;
  it.dir.y = _c.y - ant.pos.y;
  it.dir.z = _c.z - ant.pos.z;
  it.speedMul = speedMul;
  return true;
}

/**
 * Best walkable cell within `radius` cells of the ant by a caller-supplied cost (lower is
 * better; return Infinity to reject). Deterministic scan order. -1 if nothing qualifies.
 */
export function bestCellNear(sim: SimState, ant: Ant, radius: number, cost: (cell: CellIndex, dx: number, dy: number, dz: number) => number): CellIndex {
  const w = sim.world;
  const cx = Math.floor(ant.pos.x);
  const cy = Math.floor(ant.pos.y);
  const cz = Math.floor(ant.pos.z);
  let best = -1;
  let bestC = Infinity;
  for (let dy = -radius; dy <= radius; dy++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        if (!w.inBounds(x, y, z)) continue;
        const cell = w.index(x, y, z);
        if (!sim.nav.isWalkable(cell)) continue;
        const c = cost(cell, dx, dy, dz);
        if (c < bestC) {
          bestC = c;
          best = cell;
        }
      }
  return best;
}
