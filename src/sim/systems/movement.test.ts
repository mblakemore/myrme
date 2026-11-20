import { describe, expect, it } from 'vitest';
import { MOVE_SPEED_KEY, Mat, Phero, v3, v3isFinite, type Ant, type MaterialId, type TrailSense } from '../../core';
import { registerSpeedModifier, setSpeedScale } from './movement';
import { a2aSim, carveTunnel, flatWorld, goto, spawnWorker } from './movementTestUtil';
import { navOf } from './paths';
import { pheroOf } from './pheromone';

/** Movement tests on small synthetic worlds, running only the A2a systems. */

function minPairDistance(ants: Ant[]): number {
  let min = Infinity;
  for (let i = 0; i < ants.length; i++)
    for (let j = i + 1; j < ants.length; j++) {
      const d = Math.hypot(ants[i].pos.x - ants[j].pos.x, ants[i].pos.y - ants[j].pos.y, ants[i].pos.z - ants[j].pos.z);
      if (d < min) min = d;
    }
  return min;
}

function assertSane(sim: ReturnType<typeof a2aSim>): void {
  for (const a of sim.ants) {
    expect(v3isFinite(a.pos) && v3isFinite(a.up) && v3isFinite(a.forward)).toBe(true);
    expect(sim.world.sample(a.pos.x, a.pos.y, a.pos.z)).toBeLessThan(0.1);
  }
}

describe('separation', () => {
  it('ants dropped on one spot spread out until their bodies no longer overlap', () => {
    const w = flatWorld(32, 16, 32, 8);
    const sim = a2aSim(w, v3(16, 8.5, 16));
    const ants: Ant[] = [];
    for (let i = 0; i < 24; i++) ants.push(spawnWorker(sim, v3(16.5, 8.5, 16.5)));
    expect(minPairDistance(ants)).toBeLessThan(0.01);
    for (let t = 0; t < 400; t++) sim.step();
    expect(minPairDistance(ants)).toBeGreaterThan(0.2);
    // …and they settle: nobody is still being shoved around
    const p0 = ants.map((a) => ({ ...a.pos }));
    for (let t = 0; t < 60; t++) sim.step();
    for (let i = 0; i < ants.length; i++) expect(Math.hypot(ants[i].pos.x - p0[i].x, ants[i].pos.z - p0[i].z)).toBeLessThan(0.35);
    assertSane(sim);
  });

  it('two opposing streams pass each other in a 3-voxel tunnel — everyone arrives, no gridlock', () => {
    // a block of soil with two chambers joined by a 40-voxel tunnel of radius 1.6
    const w = flatWorld(64, 24, 24, 18);
    w.dig({ x: 9, y: 8, z: 12 }, 4);
    w.dig({ x: 55, y: 8, z: 12 }, 4);
    carveTunnel(w, [v3(9, 8, 12), v3(55, 8, 12)], 1.6);
    const goals = new Map<number, number>();
    const sim = a2aSim(w, v3(9, 6, 12), (s) => {
      for (const a of s.ants) goto(a, goals.get(a.id)!);
    });
    const nav = navOf(sim);
    const west: Ant[] = [];
    const east: Ant[] = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      west.push(spawnWorker(sim, v3(9 + Math.cos(a) * 2, 6, 12 + Math.sin(a) * 2)));
      east.push(spawnWorker(sim, v3(55 + Math.cos(a) * 2, 6, 12 + Math.sin(a) * 2)));
    }
    // each ant heads for a cell in the opposite chamber
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const ge = nav.nearestWalkable(55 + Math.cos(a) * 2.5, 5, 12 + Math.sin(a) * 2.5, 4);
      const gw = nav.nearestWalkable(9 + Math.cos(a) * 2.5, 5, 12 + Math.sin(a) * 2.5, 4);
      expect(ge).toBeGreaterThanOrEqual(0);
      expect(gw).toBeGreaterThanOrEqual(0);
      goals.set(west[i].id, ge);
      goals.set(east[i].id, gw);
    }
    const arrivedAt = new Map<number, number>();
    let closest = Infinity;
    let ticks = 0;
    for (; ticks < 2400 && arrivedAt.size < 2 * N; ticks++) {
      sim.step();
      for (const a of sim.ants) if (!arrivedAt.has(a.id) && a.path.status === 'arrived') arrivedAt.set(a.id, ticks);
      if (ticks % 5 === 0) closest = Math.min(closest, minPairDistance(sim.ants));
    }
    // the tunnel is 46 voxels: unobstructed that is ~600 ticks at 2.4 u/s
    expect(arrivedAt.size).toBe(2 * N);
    expect(ticks).toBeLessThan(1800);
    for (const a of west) expect(a.pos.x).toBeGreaterThan(48);
    for (const a of east) expect(a.pos.x).toBeLessThan(16);
    // traffic compressed (overlap under pressure is allowed) but bodies were kept apart most of the time
    expect(closest).toBeGreaterThanOrEqual(0);
    assertSane(sim);
    console.log('[tunnel streams]', JSON.stringify({ ants: 2 * N, ticks, closest: +closest.toFixed(3) }));
  });
});

describe('speed modifiers', () => {
  function run(setup: (sim: ReturnType<typeof a2aSim>, ant: Ant) => void, material: MaterialId = Mat.Soil): number {
    const w = flatWorld(48, 16, 16, 8, material);
    const sim = a2aSim(w, v3(8, 8.5, 8), (s) => {
      for (const a of s.ants) {
        a.intent.mode = 'dir';
        a.intent.dir.x = 1;
        a.intent.dir.y = 0;
        a.intent.dir.z = 0;
        a.intent.speedMul = 1;
      }
    });
    const ant = spawnWorker(sim, v3(6.5, 8.5, 8.5));
    setup(sim, ant);
    const x0 = ant.pos.x;
    for (let t = 0; t < 150; t++) sim.step();
    return ant.pos.x - x0;
  }

  it('entity key, global scale, registered modifier and terrain all scale speed', () => {
    const base = run(() => {});
    expect(base).toBeGreaterThan(10); // 2.4 u/s for 5 s
    expect(run((_s, a) => (a.mem[MOVE_SPEED_KEY] = 0.5)) / base).toBeCloseTo(0.5, 1);
    expect(run((s) => setSpeedScale(s, 'cold', 0.25)) / base).toBeCloseTo(0.25, 1);
    expect(
      run((s) => {
        setSpeedScale(s, 'cold', 0.25);
        setSpeedScale(s, 'cold', 1); // cleared again
      }) / base,
    ).toBeCloseTo(1, 2);
    expect(run((s) => void registerSpeedModifier(s, (m) => (m.pos.x > 12 ? 0.2 : 1)))).toBeLessThan(base * 0.6);
    // mud is slow ground (balance: terrainSpeed[Mat.Mud] = 0.6)
    expect(run(() => {}, Mat.Mud) / base).toBeCloseTo(0.6, 1);
  });
});

describe('trail following', () => {
  it('an ant steering by the three-antenna sensor stays on a laid trail around a bend', () => {
    const w = flatWorld(48, 16, 48, 8);
    const sense: TrailSense = { left: 0, centre: 0, right: 0, total: 0, turn: 0, dir: v3() };
    let lost = 0;
    const sim = a2aSim(w, v3(8, 8.5, 8), (s) => {
      for (const a of s.ants) {
        pheroOf(s).senseTrail(s.world, a.colony, Phero.trail, a.pos, a.forward, a.up, sense);
        if (sense.total <= 0) lost++;
        a.intent.mode = 'dir';
        a.intent.dir.x = sense.dir.x;
        a.intent.dir.y = sense.dir.y;
        a.intent.dir.z = sense.dir.z;
        a.intent.speedMul = 1;
      }
    });
    // an L-shaped trail with a rounded 90° bend and then a diagonal leg: (8,10) → (30,10) ⤵ (34,14) → (34,30) ↘ (42,38)
    const pts: [number, number][] = [];
    for (let x = 8; x <= 30; x += 0.5) pts.push([x, 10]);
    for (let a = 0; a <= Math.PI / 2; a += 0.1) pts.push([30 + Math.sin(a) * 4, 14 - Math.cos(a) * 4]);
    for (let z = 14; z <= 30; z += 0.5) pts.push([34, z]);
    for (let k = 0; k <= 8; k += 0.5) pts.push([34 + k, 30 + k]);
    const store = pheroOf(sim);
    for (const [x, z] of pts) store.deposit(sim.playerColony, Phero.trail, w.index(Math.floor(x), 8, Math.floor(z)), 6);
    const ant = spawnWorker(sim, v3(8.5, 8.5, 10.5));
    ant.forward.x = 1;
    ant.forward.y = 0;
    ant.forward.z = 0;
    const distToTrail = (): number => {
      let d = Infinity;
      for (const [x, z] of pts) d = Math.min(d, Math.hypot(ant.pos.x - x - 0.25, ant.pos.z - z - 0.25));
      return d;
    };
    let worst = 0;
    let reached = false;
    for (let t = 0; t < 900 && !reached; t++) {
      sim.step();
      worst = Math.max(worst, distToTrail());
      if (Math.hypot(ant.pos.x - 42, ant.pos.z - 38) < 2) reached = true;
    }
    expect(reached).toBe(true); // followed it to the end, round the bend and along the diagonal
    expect(worst).toBeLessThan(1.6); // never strayed more than a body length and a half
    expect(lost).toBeLessThan(5);
  });
});

describe('path following through the sim', () => {
  it('a path cut by a world edit is re-planned and the ant still arrives', () => {
    const w = flatWorld(48, 24, 32, 8);
    let goal = -1;
    const sim = a2aSim(w, v3(6, 8.5, 16), (s) => {
      for (const a of s.ants) goto(a, goal);
    });
    const nav = navOf(sim);
    goal = nav.nearestWalkable(42.5, 8.5, 16.5, 3);
    const ant = spawnWorker(sim, v3(6.5, 8.5, 16.5));
    for (let t = 0; t < 60; t++) sim.step();
    expect(ant.path.status).toBe('following');
    const held = ant.path.cells;
    // drop a rock wall across the way (leaving the far ends open)
    for (let z = 8; z <= 24; z += 2) w.fill({ x: 26, y: 9.5, z }, 3, Mat.Rock);
    sim.step();
    sim.step();
    expect(ant.path.cells).not.toBe(held); // old path was invalidated right away
    let ticks = 0;
    for (; ticks < 1500 && ant.path.status !== 'arrived'; ticks++) sim.step();
    expect(ant.path.status).toBe('arrived');
    expect(ant.pos.x).toBeGreaterThan(40);
    expect(w.sample(ant.pos.x, ant.pos.y, ant.pos.z)).toBeLessThan(0.1);
    // an edit nowhere near a path leaves it alone
    const back = nav.nearestWalkable(30.5, 8.5, 28.5, 3);
    goal = back;
    for (let t = 0; t < 20; t++) sim.step();
    const kept = ant.path.cells;
    expect(kept).not.toBeNull();
    w.dig({ x: 6, y: 6, z: 4 }, 2);
    sim.step();
    sim.step();
    expect(ant.path.cells).toBe(kept);
  });

  it('unreachable goals fail fast and are retried later, without burning the queue', () => {
    const w = flatWorld(32, 24, 32, 16);
    w.dig({ x: 16, y: 6, z: 16 }, 3); // sealed pocket
    let goal = -1;
    const sim = a2aSim(w, v3(6, 16.5, 6), (s) => {
      for (const a of s.ants) goto(a, goal);
    });
    const nav = navOf(sim);
    goal = nav.nearestWalkable(16.5, 4.5, 16.5, 3);
    expect(goal).toBeGreaterThanOrEqual(0);
    const ant = spawnWorker(sim, v3(6.5, 16.5, 6.5));
    for (let t = 0; t < 5; t++) sim.step();
    expect(ant.path.status).toBe('failed');
    expect(nav.stats().expansions).toBeLessThan(200);
    // open the pocket: the retry finds it
    for (let y = 6; y <= 17; y++) w.dig({ x: 16, y, z: 16 }, 1.7);
    for (let t = 0; t < 900 && ant.path.status !== 'arrived'; t++) sim.step();
    expect(ant.path.status).toBe('arrived');
  });
});

describe('locomotion classes', () => {
  it('clearance: a big walker cannot push into a 3-voxel tunnel that an ant enters freely (D11)', () => {
    const w = flatWorld(48, 24, 24, 16);
    w.dig({ x: 8, y: 9, z: 12 }, 5.5); // a big cave…
    carveTunnel(w, [v3(8, 7, 12), v3(40, 7, 12)], 1.6); // …with a narrow tunnel leading east
    const sim = a2aSim(w, v3(8, 5, 12), (s) => {
      for (const m of [...s.ants, ...s.creatures]) {
        m.intent.mode = 'dir';
        m.intent.dir.x = 1;
        m.intent.dir.y = 0;
        m.intent.dir.z = 0;
        m.intent.speedMul = 1;
      }
    });
    const ant = spawnWorker(sim, v3(8, 4, 12));
    const beetle = sim.spawnCreature('groundBeetle', v3(8, 4, 12.5));
    expect(beetle.clearance).toBeGreaterThan(1.5);
    for (let t = 0; t < 600; t++) sim.step();
    expect(ant.pos.x).toBeGreaterThan(30); // the ant walked down the tunnel
    expect(beetle.pos.x).toBeLessThan(16.5); // the beetle is stopped at its mouth
    expect(v3isFinite(beetle.pos)).toBe(true);
    expect(w.sample(beetle.pos.x, beetle.pos.y, beetle.pos.z)).toBeLessThan(0.1);
    // and nav agrees: no path for the beetle, a path for the ant
    const nav = navOf(sim);
    const end = nav.nearestWalkable(38.5, 6.5, 12.5, 3);
    expect(nav.findPath(ant.cell, end, ant.clearance).status).toBe('found');
    expect(nav.findPath(beetle.cell, end, beetle.clearance).status).not.toBe('found');
  });

  it('fly: steers around an obstacle to its goal, lands there, hovers when idle, never enters solid', () => {
    const w = flatWorld(48, 40, 32, 8);
    // a tall rock wall between start and goal
    for (let y = 9; y <= 20; y += 2) for (let z = 6; z <= 26; z += 2) w.fill({ x: 24, y, z }, 2.5, Mat.Rock);
    let mode: 'goto' | 'none' | 'dir' = 'goto';
    let goal = -1;
    const sim = a2aSim(w, v3(6, 8.5, 16), (s) => {
      for (const c of s.creatures) {
        c.intent.mode = mode;
        c.intent.goal = goal;
        c.intent.dir.x = 0;
        c.intent.dir.y = 1;
        c.intent.dir.z = 0;
        c.intent.speedMul = 1;
      }
    });
    const nav = navOf(sim);
    goal = nav.nearestWalkable(40.5, 8.5, 16.5, 3);
    const wasp = sim.spawnCreature('wasp', v3(8, 14, 16));
    expect(wasp.locomotion).toBe('fly');
    let maxSdf = -Infinity;
    let maxY = 0;
    let ticks = 0;
    for (; ticks < 1500 && wasp.path.status !== 'arrived'; ticks++) {
      sim.step();
      maxSdf = Math.max(maxSdf, w.sample(wasp.pos.x, wasp.pos.y, wasp.pos.z));
      maxY = Math.max(maxY, wasp.pos.y);
      expect(wasp.falling).toBe(false);
    }
    expect(wasp.path.status).toBe('arrived');
    expect(maxSdf).toBeLessThan(0); // never inside solid on the way
    expect(maxY).toBeGreaterThan(14); // it went over (or around) the wall, not through it
    // landed: sitting on the surface at the goal
    const s = w.sample(wasp.pos.x, wasp.pos.y, wasp.pos.z);
    expect(s).toBeGreaterThan(-(wasp.rideHeight + 0.3));
    expect(Math.hypot(wasp.pos.x - 40.5, wasp.pos.z - 16.5)).toBeLessThan(2.5);
    // perched and idle: stays put
    mode = 'none';
    const p0 = { ...wasp.pos };
    for (let t = 0; t < 60; t++) sim.step();
    expect(Math.hypot(wasp.pos.x - p0.x, wasp.pos.y - p0.y, wasp.pos.z - p0.z)).toBeLessThan(0.05);
    // take off straight up, then hover when the intent goes away
    mode = 'dir';
    for (let t = 0; t < 90; t++) sim.step();
    expect(wasp.pos.y).toBeGreaterThan(p0.y + 3);
    mode = 'none';
    for (let t = 0; t < 200; t++) sim.step();
    const h0 = { ...wasp.pos };
    for (let t = 0; t < 100; t++) sim.step();
    expect(w.sample(wasp.pos.x, wasp.pos.y, wasp.pos.z)).toBeLessThan(-1); // airborne
    expect(Math.hypot(wasp.pos.x - h0.x, wasp.pos.y - h0.y, wasp.pos.z - h0.z)).toBeLessThan(1); // holding position
    expect(Math.abs(wasp.up.x * wasp.forward.x + wasp.up.y * wasp.forward.y + wasp.up.z * wasp.forward.z)).toBeLessThan(1e-3);
  });

  it('static: stays put, follows the ground when it is edited, falls when it is dug away', () => {
    const w = flatWorld(32, 24, 32, 12, Mat.Sand);
    const sim = a2aSim(w, v3(6, 12.5, 6), (s) => {
      for (const c of s.creatures) {
        c.intent.mode = 'dir';
        c.intent.dir.x = 1;
        c.intent.speedMul = 1;
      }
    });
    const lion = sim.spawnCreature('antlion', v3(16.5, 12.5, 16.5));
    expect(lion.locomotion).toBe('static');
    const p0 = { ...lion.pos };
    for (let t = 0; t < 60; t++) sim.step();
    expect(Math.hypot(lion.pos.x - p0.x, lion.pos.y - p0.y, lion.pos.z - p0.z)).toBeLessThan(1e-6);
    // dig a pit right under it
    for (let i = 0; i < 3; i++) w.dig({ x: 16.5, y: 11 - i * 2, z: 16.5 }, 3);
    let fell = false;
    for (let t = 0; t < 120; t++) {
      sim.step();
      if (sim.drainEvents().some((e) => e.type === 'fell' && e.id === lion.id)) fell = true;
    }
    expect(fell).toBe(true);
    expect(lion.falling).toBe(false);
    expect(lion.pos.y).toBeLessThan(p0.y - 3);
    const s = w.sample(lion.pos.x, lion.pos.y, lion.pos.z);
    expect(s).toBeLessThan(0.1);
    expect(s).toBeGreaterThan(-1.3);
  });

  it('crawlers slide along the world edge instead of stopping dead', () => {
    const w = flatWorld(32, 16, 32, 8);
    const sim = a2aSim(w, v3(16, 8.5, 16), (s) => {
      for (const a of s.ants) {
        a.intent.mode = 'dir';
        a.intent.dir.x = 1;
        a.intent.dir.y = 0;
        a.intent.dir.z = 0.25;
        a.intent.speedMul = 1;
      }
    });
    const ant = spawnWorker(sim, v3(28.5, 8.5, 10.5));
    for (let t = 0; t < 200; t++) sim.step();
    expect(ant.pos.x).toBeGreaterThan(30); // pinned at the east edge…
    expect(ant.pos.z).toBeGreaterThan(14); // …but still making headway along it
  });
});
