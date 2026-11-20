import { describe, expect, it } from 'vitest';
import { SeededRng, type MapId, type SimSystem } from '../../core';
import { getMap } from '../../world/maps';
import { Simulation } from '../Simulation';
import { digSystem } from './dig';
import { fallingSystem } from './falling';
import { SYSTEMS } from './index';
import { movementSystem } from './movement';
import { pathsSystem } from './paths';
import { pheromoneSystem } from './pheromone';

/** Systems owned by stream A2a — the §12 budget below is asserted on their sum. */
const A2A = ['paths', 'movement', 'falling', 'dig', 'pheromone'];

/** §12 perf proxy: 1,000 wandering ants under every registered system, per-system cost breakdown. */
function bench(mapId: MapId, ants: number, ticks: number) {
  const acc = new Map<string, number>();
  const wrapped: SimSystem[] = SYSTEMS.map((s) => ({
    ...s,
    update(sim, dt) {
      const t = performance.now();
      s.update(sim, dt);
      acc.set(s.id, (acc.get(s.id) ?? 0) + performance.now() - t);
    },
  }));
  const map = getMap(mapId).generate(7, { faction: 'gardenAnt' });
  const sim = new Simulation(mapId, map, { seed: 7, faction: 'gardenAnt', fixture: 'wander', fixtureAnts: ants }, wrapped);
  for (let i = 0; i < 100; i++) sim.step();
  acc.clear();
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    sim.step();
    sim.drainEvents();
  }
  const total = (performance.now() - t0) / ticks;
  const parts: Record<string, number> = {};
  for (const [k, v] of acc) if (v / ticks > 0.01) parts[k] = +(v / ticks).toFixed(3);
  let mine = 0;
  for (const id of A2A) mine += (acc.get(id) ?? 0) / ticks;
  console.log('[perf]', JSON.stringify({ mapId, ants, msPerTick: +total.toFixed(3), a2a: +mine.toFixed(3), parts }));
  return { total, mine };
}

/**
 * 500 wanderers + 500 path followers under the A2a systems only: every follower walks to a
 * random walkable cell and picks a new one on arrival / failure, so the path queue, the follower,
 * separation and the crawl kernel are all under steady load.
 */
function benchMixed(mapId: MapId, ants: number, ticks: number) {
  const acc = new Map<string, number>();
  const timed = (s: SimSystem): SimSystem => ({
    ...s,
    update(sim, dt) {
      const t = performance.now();
      s.update(sim, dt);
      acc.set(s.id, (acc.get(s.id) ?? 0) + performance.now() - t);
    },
  });
  const rng = new SeededRng(5);
  let cells: number[] = [];
  let repaths = 0;
  let arrivals = 0;
  const driver: SimSystem = {
    id: 'driver',
    update(sim) {
      for (const a of sim.ants) {
        const it = a.intent;
        if (a.id & 1) {
          // path follower
          if (it.mode !== 'goto' || a.path.status === 'arrived' || a.path.status === 'failed') {
            if (a.path.status === 'arrived') arrivals++;
            it.mode = 'goto';
            it.goal = cells[rng.int(cells.length)];
            it.speedMul = 1;
            repaths++;
          }
        } else if (it.mode !== 'dir' || (sim.tick + a.id) % 45 === 0) {
          // wanderer: new heading every 1.5 s
          const ang = rng.range(0, Math.PI * 2);
          it.mode = 'dir';
          it.dir.x = Math.cos(ang);
          it.dir.y = rng.range(-0.3, 0.3);
          it.dir.z = Math.sin(ang);
          it.speedMul = 1;
        }
      }
    },
  };
  const map = getMap(mapId).generate(7, { faction: 'gardenAnt' });
  const sim = new Simulation(mapId, map, { seed: 7, faction: 'gardenAnt', fixture: 'wander', fixtureAnts: ants }, [driver, ...[pathsSystem, movementSystem, fallingSystem, digSystem, pheromoneSystem].map(timed)]);
  const n = sim.world.sx * sim.world.sy * sim.world.sz;
  // goals: cells the colony can actually reach (home field), so followers really travel
  sim.nav.updateFields(0);
  for (let c = 0; c < n; c += 3) if (sim.nav.isWalkable(c) && sim.nav.homeDistance(sim.playerColony, c) < 200) cells.push(c);
  if (cells.length < 100) {
    cells = [];
    for (let c = 0; c < n; c += 3) if (sim.nav.isWalkable(c)) cells.push(c);
  }
  for (let i = 0; i < 150; i++) sim.step();
  acc.clear();
  repaths = 0;
  arrivals = 0;
  let worst = 0;
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    const t = performance.now();
    sim.step();
    sim.drainEvents();
    worst = Math.max(worst, performance.now() - t);
  }
  const total = (performance.now() - t0) / ticks;
  const parts: Record<string, number> = {};
  let mine = 0;
  for (const [k, v] of acc) {
    if (v / ticks > 0.005) parts[k] = +(v / ticks).toFixed(3);
    mine += v / ticks;
  }
  const following = sim.ants.filter((a) => a.path.status === 'following').length;
  console.log('[perf mixed]', JSON.stringify({ mapId, ants, msPerTick: +total.toFixed(3), a2a: +mine.toFixed(3), worstTick: +worst.toFixed(2), parts, repathsPerTick: +(repaths / ticks).toFixed(2), arrivals, following, pending: sim.nav.pendingCount }));
  return { mine, arrivals };
}

describe('perf (§12: movement + paths for 1,000 ants ≤ 4 ms/tick)', () => {
  it.each(['meadow', 'gelFarm'] as const)('1000 wanderers on %s (all systems)', (mapId) => {
    const r = bench(mapId, 1000, 600);
    expect(r.mine).toBeLessThan(4);
  }, 60000);

  it.each(['meadow', 'gelFarm'] as const)('500 wanderers + 500 path followers on %s', (mapId) => {
    const r = benchMixed(mapId, 1000, 900);
    expect(r.mine).toBeLessThan(4);
    expect(r.arrivals).toBeGreaterThan(50); // the followers really are following paths
  }, 60000);
});
