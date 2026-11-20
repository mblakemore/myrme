import { describe, expect, it } from 'vitest';
import { ISO, Mat, b3StateOf, v3, type NavEx } from '../../core';
import { syncPrev } from '../entities';
import type { Simulation } from '../Simulation';
import { GROUND, makeB3Sim } from './goalsTestKit';
import { snapToSurface } from './movementCrawl';
import { termiteOpOf } from './termiteBuild';
import { envState } from './weatherEnv';

const LOG = { ax: 57, az: 18, bx: 57, bz: 46, r: 3 };

function countMat(sim: Simulation, mat: number): number {
  const w = sim.world;
  let n = 0;
  for (let i = 0; i < w.density.length; i++) if (w.density[i] >= ISO && w.material[i] === mat) n++;
  return n;
}

function run(sim: Simulation, ticks: number, each?: (t: number) => boolean | void): string[] {
  const types: string[] = [];
  for (let t = 0; t < ticks; t++) {
    sim.step();
    for (const e of sim.drainEvents()) types.push((e as { type: string }).type);
    if (each?.(t)) break;
  }
  return types;
}

describe('termites', () => {
  it('eat wood: tunnelling into the log removes Wood voxels and credits stores (wood → food), with no foraging', () => {
    const sim = makeB3Sim({ faction: 'termite', seed: 4, size: 64, log: LOG, noon: false });
    const colony = sim.getColony(1)!;
    const wood0 = countMat(sim, Mat.Wood);
    let woodIn = 0;
    let last = colony.stores.wood;
    const food0 = colony.stats.foodDelivered;
    run(sim, 90 * 30, () => {
      if (colony.stores.wood > last) woodIn += colony.stores.wood - last;
      last = colony.stores.wood;
    });
    expect(countMat(sim, Mat.Wood)).toBeLessThan(wood0 - 50);
    expect(woodIn).toBeGreaterThan(5);
    expect(colony.stats.foodDelivered).toBeGreaterThan(food0 + 5); // digested
    expect(sim.ants.some((a) => a.behavior === 'forage')).toBe(false);
    // swallowed spoil became building mud; nobody carries pellets around
    expect(colony.stores.mud).toBeGreaterThan(14);
    expect(sim.ants.some((a) => a.carrying?.itemKind === 'debris')).toBe(false);
  });

  it('build a shelter tube of Mud from the nest entrance toward the wood, on their own', () => {
    const sim = makeB3Sim({ faction: 'termite', seed: 4, size: 64, log: LOG, noon: false });
    const st = b3StateOf(sim).termite[0];
    const types = run(sim, 60 * 30, () => st.tubes.length > 0 && st.tubes[0].done);
    expect(st.tubes.length).toBeGreaterThan(0);
    const tube = st.tubes[0];
    expect(tube.built).toBeGreaterThanOrEqual(3);
    expect(types).toContain('shelterTube');
    expect(types).toContain('build');
    expect(countMat(sim, Mat.Mud)).toBeGreaterThan(20);
    // it heads for the log, and its walkway is roofed but still walkable
    const colony = sim.getColony(1)!;
    const e = sim.world.cellCenter(colony.entrances[0], v3());
    expect(Math.abs(tube.to.x - LOG.ax)).toBeLessThan(Math.abs(e.x - LOG.ax));
    const nav = sim.nav as NavEx;
    const mid = nav.nearestWalkable((tube.from.x + tube.to.x) / 2, tube.from.y, (tube.from.z + tube.to.z) / 2, 2);
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(nav.isExposed(mid)).toBe(false);
  });

  it('are sun-sensitive: an exposed termite burns in daylight, a covered one does not; neither at night', () => {
    for (const noon of [true, false]) {
      const sim = makeB3Sim({ faction: 'termite', seed: 5, size: 64, noon });
      const nav = sim.nav as NavEx;
      const workers = sim.ants.filter((a) => a.caste === 'worker');
      const out = workers[0];
      const inside = workers[1];
      out.pos.x = 14;
      out.pos.y = GROUND + 0.6;
      out.pos.z = 14;
      expect(snapToSurface(sim.world, nav, out, 4)).toBe(true);
      syncPrev(out);
      let burns = 0;
      let minOut = out.maxHealth;
      for (let t = 0; t < 90; t++) {
        // hold both in place: this is about the sun, not about what they do next
        out.thinkAt = sim.tick + 100;
        inside.thinkAt = sim.tick + 100;
        out.intent.mode = 'none';
        inside.intent.mode = 'none';
        sim.step();
        for (const e of sim.drainEvents()) if ((e as { type: string }).type === 'sunburn') burns++;
        minOut = Math.min(minOut, out.health);
      }
      expect(nav.isExposed(out.cell)).toBe(true);
      expect(nav.isExposed(inside.cell)).toBe(false);
      expect(inside.health).toBe(inside.maxHealth);
      if (noon) {
        expect(minOut).toBeLessThan(out.maxHealth - 0.5);
        expect(burns).toBeGreaterThan(0);
        expect(b3StateOf(sim).termite[0].scorched).toBeGreaterThanOrEqual(0);
      } else {
        expect(minOut).toBe(out.maxHealth);
        expect(burns).toBe(0);
      }
    }
  });

  it('scorched termites run for cover (seekShade) and the sun can kill', () => {
    const sim = makeB3Sim({ faction: 'termite', seed: 6, size: 64, noon: true });
    const nav = sim.nav as NavEx;
    const a = sim.ants.filter((x) => x.caste === 'worker')[0];
    a.pos.x = 44;
    a.pos.y = GROUND + 0.6;
    a.pos.z = 40;
    snapToSurface(sim.world, nav, a, 4);
    syncPrev(a);
    a.health = a.maxHealth * 0.5;
    let shade = false;
    run(sim, 40 * 30, () => {
      if (a.behavior === 'seekShade') shade = true;
      return shade && a.alive && !nav.isExposed(a.cell);
    });
    expect(shade).toBe(true);
    expect(a.alive && !nav.isExposed(a.cell)).toBe(true);
    // pinned out in the open it dies of the sun
    const b = sim.ants.filter((x) => x.caste === 'worker' && x !== a)[0];
    b.pos.x = 12;
    b.pos.y = GROUND + 0.6;
    b.pos.z = 50;
    snapToSurface(sim.world, nav, b, 4);
    b.health = 1;
    let cause = '';
    for (let t = 0; t < 300 && b.alive; t++) {
      b.thinkAt = sim.tick + 100;
      b.intent.mode = 'none';
      sim.step();
      for (const e of sim.drainEvents()) if (e.type === 'antDied' && e.id === b.id) cause = e.cause;
    }
    expect(cause).toBe('sun');
  });

  it('execute a player build designation with mud (canFill)', () => {
    const sim = makeB3Sim({ faction: 'termite', seed: 7, size: 64, noon: false });
    const colony = sim.getColony(1)!;
    colony.stores.mud = 60;
    const e = sim.world.cellCenter(colony.entrances[0], v3());
    const at = v3(e.x - 6, GROUND + 1.2, e.z + 5);
    const mud0 = countMat(sim, Mat.Mud);
    sim.command({ type: 'designate', kind: 'build', op: 'add', center: at, radius: 2.2, material: Mat.Mud });
    let built = false;
    const types = run(sim, 120 * 30, () => {
      if (sim.ants.some((a) => a.behavior === 'build')) built = true;
      return countMat(sim, Mat.Mud) > mud0 + 12;
    });
    expect(built).toBe(true);
    expect(countMat(sim, Mat.Mud)).toBeGreaterThan(mud0 + 12);
    expect(colony.stores.mud).toBeLessThan(60);
    expect(types).toContain('build');
    // an ant species without the flag ignores build jobs
    const ants = makeB3Sim({ faction: 'gardenAnt', seed: 7, size: 64, noon: false });
    ants.getColony(1)!.stores.mud = 60;
    ants.command({ type: 'designate', kind: 'build', op: 'add', center: at, radius: 2.2, material: Mat.Mud });
    run(ants, 40 * 30);
    expect(countMat(ants, Mat.Mud)).toBe(0);
  });

  it('seal a breach in the nest roof and raise a mound from spare mud', () => {
    const sim = makeB3Sim({ faction: 'termite', seed: 8, size: 64, noon: false });
    const colony = sim.getColony(1)!;
    const st = b3StateOf(sim).termite[0];
    run(sim, 20 * 30); // let the colony lay out its chambers
    const ch = colony.chambers.find((c) => c.kind === 'nursery') ?? colony.chambers[0];
    const nav = sim.nav as NavEx;
    expect(nav.isExposed(ch.cell)).toBe(false);
    // an anteater's claw: a shaft straight down into the chamber
    for (let y = ch.pos.y; y <= GROUND + 2; y += 1) sim.world.dig(v3(ch.pos.x, y, ch.pos.z), 1.6);
    sim.nav.updateFields(sim.tick);
    expect(nav.isExposed(ch.cell)).toBe(true);
    let plugged = false;
    let sawPlug = false;
    run(sim, 150 * 30, () => {
      if (termiteOpOf(sim, 1)?.kind === 'plug') sawPlug = true;
      plugged = sawPlug && !nav.isExposed(ch.cell);
      return plugged;
    });
    expect(sawPlug).toBe(true);
    expect(plugged).toBe(true);
    colony.stores.mud = 200;
    run(sim, 150 * 30, () => st.mound.stamps >= 4);
    expect(st.mound.stamps).toBeGreaterThanOrEqual(4);
    expect(st.mound.height).toBeGreaterThan(1);
  });
  it('build in daylight: a shelter tube is extended from under cover and the mound rises, with no builder scorched to death', () => {
    const sim = makeB3Sim({ faction: 'termite', seed: 4, size: 64, log: LOG, noon: true });
    const colony = sim.getColony(1)!;
    const st = b3StateOf(sim).termite[0];
    colony.stores.mud = 120;
    let sunDeaths = 0;
    let dayBuilds = 0;
    let last = 0;
    for (let t = 0; t < 240 * 30; t++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        const ev = e as { type: string; cause?: string; colony?: number };
        if (ev.type === 'antDied' && ev.cause === 'sun' && ev.colony === 1) sunDeaths++;
      }
      const built = st.tubes.reduce((n, tube) => n + tube.built, 0) + st.mound.stamps;
      if (built > last && envState(sim).sun > 0.5) dayBuilds += built - last;
      last = built;
      if (st.mound.stamps >= 6 && st.tubes.some((tube) => tube.done && tube.built >= 3)) break;
    }
    expect(envState(sim).sun).toBeGreaterThan(0.5); // it stayed day throughout
    expect(st.tubes.some((tube) => tube.built >= 3)).toBe(true);
    expect(st.mound.stamps).toBeGreaterThanOrEqual(6);
    expect(dayBuilds).toBeGreaterThanOrEqual(9);
    expect(sunDeaths).toBe(0);
  });
});
