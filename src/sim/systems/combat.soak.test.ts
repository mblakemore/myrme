import { describe, expect, it } from 'vitest';
import type { FoodSpawn } from '../../core';
import { makeSim } from '../testUtil';
import { combatStats } from './combat';
import { makeArena, type Arena, type ArenaOptions } from './combatTestUtil';
import { spawnCreatureAt } from './creatures';
import { directorHistory } from './director';
import { rivalColonies } from './rivals';

/**
 * B1 soaks. Synthetic two-nest arena (cheap, fully under the test's control) plus a tolerant run
 * on the real meadow. Each test prints its ms/tick.
 */
const food = (): FoodSpawn[] => [
  { kind: 'seeds', pos: { x: 48, y: 20.5, z: 30 }, amount: 400, regen: 0.2 },
  { kind: 'seeds', pos: { x: 30, y: 20.5, z: 70 }, amount: 300, regen: 0.2 },
  { kind: 'seeds', pos: { x: 66, y: 20.5, z: 70 }, amount: 300, regen: 0.2 },
];
const TWO: ArenaOptions = { size: 96, nests: [{ x: 18, z: 48 }, { x: 78, z: 48 }], rivals: true, predators: true };

function finite(a: Arena['sim']): boolean {
  for (const x of a.ants) if (!Number.isFinite(x.pos.x + x.pos.y + x.pos.z + x.health)) return false;
  for (const c of a.creatures) if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.health)) return false;
  return Number.isFinite(a.director.budget);
}

function timed(sim: Arena['sim'], ticks: number, each?: () => void): { avg: number; worst: number } {
  const t0 = performance.now();
  let worst = 0;
  for (let done = 0; done < ticks; ) {
    const n = Math.min(300, ticks - done);
    const t1 = performance.now();
    for (let i = 0; i < n; i++) {
      sim.step();
      each?.();
    }
    worst = Math.max(worst, (performance.now() - t1) / n);
    done += n;
  }
  return { avg: (performance.now() - t0) / ticks, worst };
}

describe('B1 soak: combat', () => {
  it('a 30-ant mob kills a jumping spider; a lone worker loses to it', () => {
    const mob = makeArena({ seed: 4 });
    mob.clearWorkers();
    const spider = spawnCreatureAt(mob.sim, 'jumpingSpider', mob.at(14, 52));
    for (let i = 0; i < 30; i++) mob.ant(mob.player, 'worker', 22 + (i % 6), 50 + Math.floor(i / 6));
    for (let i = 0; i < 3600 && spider.alive; i++) mob.run(1);
    expect(spider.alive).toBe(false);
    const left = mob.sim.ants.filter((x) => x.caste === 'worker').length;
    expect(left).toBeGreaterThan(15); // costly but clearly won
    expect(mob.events.some((e) => e.type === 'creatureDied' && e.killerColony === mob.player.id)).toBe(true);

    const lone = makeArena({ seed: 4 });
    lone.clearWorkers();
    const spider2 = spawnCreatureAt(lone.sim, 'jumpingSpider', lone.at(14, 52));
    const w = lone.ant(lone.player, 'worker', 22, 52);
    for (let i = 0; i < 1800 && w.alive; i++) lone.run(1);
    expect(w.alive).toBe(false);
    expect(spider2.alive).toBe(true);
    expect(spider2.health).toBeGreaterThan(spider2.maxHealth * 0.9);
  });

  it('two colonies coexist for 10 sim-minutes with skirmishes', () => {
    const a = makeArena({ ...TWO, food: food(), seed: 5, director: { enabled: true, intensity: 1 } });
    const rival = rivalColonies(a.sim)[0];
    let attacks = 0;
    const perf = timed(a.sim, 18_000, () => {
      for (const e of a.sim.drainEvents()) if (e.type === 'attack') attacks++;
    });
    const pop = (id: number) => a.sim.ants.filter((x) => x.colony === id).length;
    console.log(`[b1 soak] two colonies: ${perf.avg.toFixed(3)} ms/tick (worst 300-tick window ${perf.worst.toFixed(3)}), player ${pop(a.player.id)} ants / ${a.player.stats.deaths} dead, rival ${pop(rival.id)} ants / ${rival.stats.deaths} dead, ${attacks} attacks, ${combatStats(a.sim).kills} kills`);
    expect(finite(a.sim)).toBe(true);
    expect(a.player.alive).toBe(true);
    expect(rival.alive).toBe(true);
    expect(pop(a.player.id)).toBeGreaterThan(5);
    expect(pop(rival.id)).toBeGreaterThan(2);
    expect(attacks).toBeGreaterThan(10);
    expect(a.player.stats.deaths + rival.stats.deaths).toBeGreaterThan(0);
    expect(perf.avg).toBeLessThan(3);
  });

  const outcomes: { seed: number; alive: boolean; pop: number; deaths: number; waves: number; ms: number }[] = [];
  it.each([1, 2, 3, 4])('director on normal, 15 sim-minutes, seed %i', (seed) => {
    const a = makeArena({ ...TWO, food: food(), seed, director: { enabled: true, intensity: 1 } });
    const perf = timed(a.sim, 27_000, () => a.sim.drainEvents());
    const pop = a.sim.ants.filter((x) => x.colony === a.player.id).length;
    const queen = a.sim.getAnt(a.player.queenId);
    outcomes.push({ seed, alive: a.player.alive && !!queen?.alive && pop >= 8, pop, deaths: a.player.stats.deaths, waves: directorHistory(a.sim).length, ms: perf.avg });
    expect(finite(a.sim)).toBe(true);
    expect(perf.avg).toBeLessThan(3);
  });

  it('…survives in at least 3 of 4 seeds while taking casualties', () => {
    console.log('[b1 soak] director normal: ' + outcomes.map((o) => `seed ${o.seed}: ${o.alive ? 'alive' : 'LOST'} pop ${o.pop}, ${o.deaths} dead, ${o.waves} waves, ${o.ms.toFixed(3)} ms/tick`).join(' | '));
    expect(outcomes.length).toBe(4);
    expect(outcomes.filter((o) => o.alive).length).toBeGreaterThanOrEqual(3);
    expect(outcomes.reduce((s, o) => s + o.deaths, 0)).toBeGreaterThan(8);
    expect(outcomes.filter((o) => o.deaths > 0).length).toBeGreaterThanOrEqual(3);
    for (const o of outcomes) expect(o.waves).toBeGreaterThan(3);
  });

  it('real meadow with director and rival: 6 sim-minutes, deterministic, no blow-up', () => {
    const run = () => {
      const sim = makeSim('meadow', { seed: 3, fixture: 'none', small: true });
      sim.command({ type: 'setDirector', enabled: true, intensity: 1 });
      let attacks = 0;
      const perf = timed(sim, 10_800, () => {
        for (const e of sim.drainEvents()) if (e.type === 'attack') attacks++;
      });
      return { sim, perf, attacks };
    };
    const a = run();
    const player = a.sim.getColony(a.sim.playerColony)!;
    console.log(`[b1 soak] meadow: ${a.perf.avg.toFixed(3)} ms/tick (worst ${a.perf.worst.toFixed(3)}), ${a.sim.ants.length} ants, ${a.sim.creatures.length} creatures, ${a.attacks} attacks, waves ${directorHistory(a.sim).map((h) => h.kind).join(',')}`);
    expect(finite(a.sim)).toBe(true);
    expect(player.alive).toBe(true);
    expect(rivalColonies(a.sim).length).toBeGreaterThan(0);
    expect(directorHistory(a.sim).length).toBeGreaterThan(0);
    expect(a.perf.avg).toBeLessThan(4);
    const b = run();
    expect(b.sim.stateHash()).toBe(a.sim.stateHash());
  });
});
