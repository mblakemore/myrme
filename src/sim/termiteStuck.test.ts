import { describe, expect, it } from 'vitest';
import { HOME_UNREACHABLE, Mat, type Ant, type MapId, type NavEx, type SpeciesId, type Vec3 } from '../core';
import { BALANCE } from './data/balance';
import { makeFullGame } from './fullGameKit';
import type { Simulation } from './Simulation';
import { spawnCreatureAt } from './systems/creatures';
import { plugCuts } from './systems/termiteBuild';
import { makeSim } from './testUtil';

/**
 * Termite regressions (sibling of stuckAnts.test.ts): termites spinning on the spot or wedged
 * (diagonal pinches in the nav graph, a path follower whose stuck counter decayed while it
 * oscillated, fighters sliding under a target they cannot reach, sun-shy duty flip-flops at the
 * nest mouth), dying in the sun (damage and flight disagreed on what "sun" is; a royal chamber
 * breached from the side was never plugged), and player orders — move, gather on wood, attack —
 * that must take effect on termites too. Counted for the player colony only. Plus the two traps
 * that starved late-game termites beside full stores: a mud plug or stamp sealing the only gallery
 * between the royal chamber and the log, and ants hanging "falling" forever in a pinched crack.
 */
const d3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

interface Probe {
  /** 3 s windows in which a trying ant turned > 6 rad but moved < 0.3. */
  windows: number;
  /** Ants that stayed within 1.5 of one spot for 20 s while trying to go somewhere. */
  stuck: number;
  /** Sun deaths outside combat (a fighter caught far out in the open, or fleeing home wounded, is the fight's risk). */
  sunDeaths: number;
  pop: number;
}

function probe(map: MapId, faction: SpeciesId, seed: number, minutes: number): Probe {
  const sim = makeFullGame(map, { seed, faction, difficulty: 'normal' });
  const colony = sim.getColony(sim.playerColony)!;
  const spin = new Map<number, { x: Vec3; f: Vec3; rot: number; n: number }>();
  const anchor = new Map<number, { a: Vec3; t: number; tr: number; rep: boolean }>();
  const r: Probe = { windows: 0, stuck: 0, sunDeaths: 0, pop: 0 };
  const sortie = new Set<number>();
  for (let t = 1; t <= minutes * 1800; t++) {
    sim.step();
    for (const e of sim.drainEvents()) if (e.type === 'antDied' && e.colony === colony.id && e.cause === 'sun' && !sortie.has(e.id)) r.sunDeaths++;
    if (t % 15 === 0)
      for (const a of sim.ants) {
        if (!a.alive || a.colony !== colony.id || a.behavior === 'flee') continue;
        if (a.behavior === 'fight') sortie.add(a.id);
        else sortie.delete(a.id);
      }
    for (const a of sim.ants) {
      if (!a.alive || a.possessed || a.locomotion !== 'surface' || a.colony !== colony.id) continue;
      const trying = !a.falling && ((a.intent.mode === 'goto' && a.path.status !== 'arrived') || (a.intent.mode === 'dir' && a.intent.speedMul > 0.5));
      const s = spin.get(a.id);
      if (!s) spin.set(a.id, { x: { ...a.pos }, f: { ...a.forward }, rot: 0, n: 0 });
      else {
        s.rot += Math.acos(Math.max(-1, Math.min(1, s.f.x * a.forward.x + s.f.y * a.forward.y + s.f.z * a.forward.z)));
        s.f = { ...a.forward };
        if (++s.n >= 90) {
          if (trying && d3(a.pos, s.x) < 0.3 && s.rot > 6) r.windows++;
          s.x = { ...a.pos };
          s.rot = 0;
          s.n = 0;
        }
      }
      const k = anchor.get(a.id);
      if (!k || d3(a.pos, k.a) > 1.5) anchor.set(a.id, { a: { ...a.pos }, t, tr: 0, rep: false });
      else {
        if (trying) k.tr++;
        if (!k.rep && t - k.t >= 600 && k.tr > 450) {
          k.rep = true;
          r.stuck++;
        }
      }
    }
  }
  r.pop = colony.population.total;
  return r;
}

function run(sim: Simulation, ticks: number, each?: (t: number) => void): void {
  for (let t = 0; t < ticks; t++) {
    each?.(t);
    sim.step();
    sim.drainEvents();
  }
}

describe('termites do not spin or wedge', () => {
  it('meadow seed 3, 10 minutes', () => {
    // before the fixes: 263 windows, 26 stuck ants (now ~80 / 8)
    const r = probe('meadow', 'termite', 3, 10);
    expect(r.windows, JSON.stringify(r)).toBeLessThanOrEqual(150);
    expect(r.stuck, JSON.stringify(r)).toBeLessThanOrEqual(14);
    expect(r.pop).toBeGreaterThan(35);
  });

  it('forest seed 3, 10 minutes', () => {
    // before: 187 windows, 15 stuck ants (now ~80 / 8)
    const r = probe('forest', 'termite', 3, 10);
    expect(r.windows, JSON.stringify(r)).toBeLessThanOrEqual(140);
    expect(r.stuck, JSON.stringify(r)).toBeLessThanOrEqual(12);
    expect(r.pop).toBeGreaterThan(30);
  });
});

describe('termites keep out of the sun', () => {
  it('meadow seed 2: no sun deaths off the battlefield over the first 15 minutes', () => {
    // before: 285 spin windows (now ~150). The 3–4 sun deaths this run has, old code and new,
    // are all fighters caught far out on open ground — the risk of the sortie, not counted here.
    const r = probe('meadow', 'termite', 2, 15);
    expect(r.sunDeaths, JSON.stringify(r)).toBeLessThanOrEqual(1);
    expect(r.windows, JSON.stringify(r)).toBeLessThanOrEqual(240);
    expect(r.pop).toBeGreaterThan(50);
  });
});

describe('other species do not circle at diagonal pinches', () => {
  it('sand farm garden ants, 10 minutes', () => {
    // before: 22 windows (ants circling ~20 s at a corner pinch until the watchdog; now ~5)
    const r = probe('sandFarm', 'gardenAnt', 1, 10);
    expect(r.windows, JSON.stringify(r)).toBeLessThanOrEqual(14);
  });
});

describe('player orders reach termites', () => {
  it('move / gather on wood / attack take effect', () => {
    const sim = makeFullGame('meadow', { seed: 1, faction: 'termite', difficulty: 'normal' });
    run(sim, 4 * 60 * 30);
    const colony = sim.getColony(sim.playerColony)!;
    const nav = sim.nav as NavEx;
    const w = sim.world;
    const home = w.cellCenter(colony.entrances[0] ?? colony.nestCell, { x: 0, y: 0, z: 0 });
    const pool = sim.ants.filter((a) => a.alive && a.colony === colony.id && a.caste === 'worker' && !a.possessed && a.infection.stage === 'none');
    expect(pool.length).toBeGreaterThanOrEqual(12);
    const take = (k: number): Ant[] => pool.splice(0, k);

    // wood: the reachable cell beside a Wood voxel nearest the nest (but out of it)
    let wood: Vec3 | null = null;
    let best = Infinity;
    for (let y = 1; y < w.sy - 1; y++)
      for (let z = 1; z < w.sz - 1; z++)
        for (let x = 1; x < w.sx - 1; x++) {
          const c = w.index(x, y, z);
          if (!nav.isWalkable(c) || nav.homeDistance(colony.id, c) > 1e5) continue;
          const d = Math.hypot(x + 0.5 - home.x, y + 0.5 - home.y, z + 0.5 - home.z);
          if (d < 12 || d >= best) continue;
          for (const o of [-1, 1, -w.sx, w.sx, -w.sx * w.sz])
            if (w.material[c + o] === Mat.Wood && w.density[c + o] >= 128) {
              best = d;
              wood = w.cellCenter(c + o, { x: 0, y: 0, z: 0 });
            }
        }
    expect(wood).toBeTruthy();

    const movers = take(4);
    const goalCell = nav.nearestWalkable(home.x + 6, home.y, home.z + 4, 6, 0.5);
    const goal = w.cellCenter(goalCell, { x: 0, y: 0, z: 0 });
    sim.command({ type: 'order', ids: movers.map((a) => a.id), order: 'move', pos: goal, cell: goalCell });
    // gather on wood = what a right-click on the log issues for termites (input/orders.ts)
    const chewers = take(4);
    sim.command({ type: 'order', ids: chewers.map((a) => a.id), order: 'gather', pos: { ...wood! } });
    const spider = spawnCreatureAt(sim, 'jumpingSpider', { x: home.x - 5, y: home.y + 1, z: home.z - 5 });
    const attackers = take(4);
    sim.command({ type: 'order', ids: attackers.map((a) => a.id), order: 'attack', targetId: spider.id });

    const arrived = new Set<number>();
    const chewed = new Set<number>();
    const engaged = new Set<number>();
    let woodEaten = 0;
    const solid0 = w.density.slice();
    run(sim, 60 * 30, () => {
      for (const a of movers) if (a.alive && d3(a.pos, goal) < 2.5) arrived.add(a.id);
      for (const a of chewers) if (a.alive && a.anim === 'dig' && a.tasks[0]?.source === 'player' && a.tasks[0]?.kind === 'gather') chewed.add(a.id);
      for (const a of attackers) if (a.alive && (!spider.alive || d3(a.pos, spider.pos) < BALANCE.a2b.attackRange + 1.5)) engaged.add(a.id);
    });
    // wood voxels near the click that were eaten away
    const R = 6;
    for (let dy = -R; dy <= R; dy++)
      for (let dz = -R; dz <= R; dz++)
        for (let dx = -R; dx <= R; dx++) {
          const x = Math.floor(wood!.x) + dx;
          const y = Math.floor(wood!.y) + dy;
          const z = Math.floor(wood!.z) + dz;
          if (!w.inBounds(x, y, z)) continue;
          const c = w.index(x, y, z);
          if (solid0[c] >= 128 && w.density[c] < 128) woodEaten++;
        }
    expect(arrived.size, 'move orders').toBeGreaterThanOrEqual(movers.length - 1);
    expect(chewed.size, 'gather-on-wood orders chew the wood').toBeGreaterThanOrEqual(chewers.length - 1);
    expect(woodEaten, 'wood eaten at the ordered spot').toBeGreaterThan(10);
    expect(engaged.size, 'attack orders').toBeGreaterThanOrEqual(attackers.length - 1);
  });
});

describe('termite starvation traps', () => {
  /** Re-seats the nav and its fields after hand-editing the density of a block. */
  const settle = (sim: Simulation, x: number, y: number, z: number, r: number, ticks: number) => {
    sim.world.markAllDirty();
    (sim.nav as unknown as { onWorldEdit(c: Vec3, r: number): void }).onWorldEdit({ x, y, z }, r);
    for (let t = 0; t < ticks; t++) sim.step();
  };

  it('a mud fill that would seal the only gallery to a nest-connected room is recognised', () => {
    // meadow seed 3, ~35 min: the breach plug over the royal chamber went into the gallery shaft up
    // into the log and cut 39 ants off from the granary; they starved beside 80+ food
    const sim = makeSim('meadow', { fixture: 'none', small: true });
    const colony = sim.getColony(sim.playerColony)!;
    const w = sim.world;
    const nav = sim.nav as NavEx;
    const c0 = w.cellCenter(colony.nestCell, { x: 0, y: 0, z: 0 });
    for (let t = 0; t < 30; t++) sim.step();
    // a soil block beside the nest: a one-tube corridor runs 12 voxels in to a room
    const X = Math.floor(c0.x) + 8;
    const Y = Math.floor(c0.y);
    const Z = Math.floor(c0.z);
    for (let y = Y - 3; y <= Y + 8; y++)
      for (let z = Z - 8; z <= Z + 8; z++)
        for (let x = X; x <= X + 20; x++) w.setCell(x, y, z, Math.min(1.5, x - X + 0.5, X + 20 - x + 0.5, Z + 8 - z + 0.5, z - (Z - 8) + 0.5, Y + 8 - y + 0.5), Mat.Soil);
    for (let x = X - 2; x <= X + 10; x++) w.dig({ x: x + 0.5, y: Y + 1, z: Z + 0.5 }, 1.3);
    w.dig({ x: X + 14.5, y: Y + 2, z: Z + 0.5 }, 3.2);
    settle(sim, X + 10, Y, Z, 14, 300);
    const room = nav.nearestWalkable(X + 14.5, Y + 0.5, Z + 0.5, 3);
    expect(room).toBeGreaterThanOrEqual(0);
    expect(nav.homeDistance(colony.id, room), 'the room is reachable from the nest').not.toBe(HOME_UNREACHABLE);
    expect(plugCuts(sim, colony.id, X + 5.5, Y + 1, Z + 0.5, 2), 'a plug in the corridor cuts the room off').toBe(true);
    expect(plugCuts(sim, colony.id, X + 14.5, Y + 3.5, Z + 0.5, 1.2), 'a stamp on the room ceiling does not').toBe(false);
    expect(plugCuts(sim, colony.id, c0.x - 6, c0.y + 1, c0.z, 2), 'nor one on open ground').toBe(false);
  });

  it('an ant that drops into a pinched crack lands instead of hanging in the fall forever', () => {
    // meadow seed 2: diggers left a crack whose walls' fields cancel (density just under the
    // surface); ants falling in touched down with nothing to project onto, stayed "falling" with
    // no cell or path, and starved there
    for (const deep of [false, true]) {
      const sim = makeSim('meadow', { fixture: 'none', small: true });
      const ant = sim.ants.find((a) => a.caste === 'worker')!;
      for (let t = 0; t < 30; t++) sim.step();
      const w = sim.world;
      const x0 = Math.floor(ant.pos.x) + 6;
      const z0 = Math.floor(ant.pos.z);
      const yb = Math.floor(ant.pos.y);
      // a block with a one-voxel slot down its middle, barely open
      for (let y = yb - 6; y <= yb + 1; y++)
        for (let z = z0 - 4; z <= z0 + 4; z++)
          for (let x = x0 - 4; x <= x0 + 4; x++) {
            const slot = x === x0 && Math.abs(z - z0) <= 3 && y > yb - (deep ? 7 : 5);
            w.setCell(x, y, z, slot ? -0.05 : deep && y < yb - 4 ? 0.2 : 1.5, Mat.Rock);
          }
      settle(sim, x0, yb, z0, 8, 0);
      ant.pos.x = x0 + 0.5;
      ant.pos.y = yb - 1.5;
      ant.pos.z = z0 + 0.5;
      ant.falling = true;
      ant.cell = -1;
      ant.path.status = 'none';
      ant.path.cells = null;
      let falling = 0;
      for (let t = 0; t < 300; t++) {
        sim.step();
        if (ant.falling) falling++;
      }
      expect(falling, `ticks spent falling (${deep ? 'deep' : 'shallow'} crack)`).toBeLessThan(30);
      expect(ant.cell).toBeGreaterThanOrEqual(0);
    }
  });
});
