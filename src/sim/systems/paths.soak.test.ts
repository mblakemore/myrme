import { describe, expect, it } from 'vitest';
import { SeededRng, v3, type MapId } from '../../core';
import { makeSim } from '../testUtil';

/**
 * Path-following soak: ants spread over the map are each ordered to a random reachable walkable
 * cell (nest ↔ surface ↔ stems, tunnels ↔ panes). Almost all must arrive and none may end up
 * off-surface. Guards the cell-waypoint follower against tunnels, corners and climbs.
 */
function run(mapId: MapId) {
  const sim = makeSim(mapId, { seed: 11, ants: 80 });
  const rng = new SeededRng(99);
  const cells: number[] = [];
  const n = sim.world.sx * sim.world.sy * sim.world.sz;
  for (let c = 0; c < n; c++) if (sim.nav.isWalkable(c)) cells.push(c);
  const p = v3();
  let ordered = 0;
  const goals = new Map<number, number>();
  for (const a of sim.ants) {
    for (let tries = 0; tries < 20; tries++) {
      const goal = cells[rng.int(cells.length)];
      const path = sim.nav.findPath(a.cell, goal, a.clearance, 200000);
      if (path.status !== 'found' || path.cells.length < 8 || path.cells.length > 110) continue;
      sim.world.cellCenter(goal, p);
      sim.command({ type: 'order', ids: [a.id], order: 'move', pos: { ...p } });
      goals.set(a.id, goal);
      ordered++;
      break;
    }
  }
  // distance to the goal at the tick the order completed (ants wander off again afterwards)
  const doneAt = new Map<number, number>();
  let ticks = 0;
  for (; ticks < 2400 && doneAt.size < ordered; ticks++) {
    sim.step();
    for (const a of sim.ants) {
      const goal = goals.get(a.id);
      if (goal === undefined || doneAt.has(a.id) || a.tasks.length > 0) continue;
      sim.world.cellCenter(goal, p);
      doneAt.set(a.id, Math.hypot(a.pos.x - p.x, a.pos.y - p.y, a.pos.z - p.z));
    }
    if (ticks % 50 === 0) {
      for (const a of sim.ants) {
        const s = sim.world.sample(a.pos.x, a.pos.y, a.pos.z);
        expect(s).toBeLessThan(0.1);
        expect(a.falling || s > -1).toBe(true);
      }
    }
  }
  const arrived = doneAt.size;
  // "far": the task was dropped (gave up) rather than completed next to the goal
  const far = [...doneAt.values()].filter((d) => d > 4.5).length;
  const worst = Math.max(0, ...doneAt.values());
  console.log('[path soak]', JSON.stringify({ mapId, ordered, arrived, far, worst: +worst.toFixed(2), ticks }));
  return { ordered, arrived, far };
}

describe.each(['meadow', 'gelFarm'] as const)('path soak: %s', (mapId) => {
  it('ordered ants reach their goals', () => {
    const r = run(mapId);
    expect(r.ordered).toBeGreaterThan(60);
    expect(r.arrived / r.ordered).toBeGreaterThanOrEqual(0.95);
    expect(r.far).toBe(0);
  });
});
