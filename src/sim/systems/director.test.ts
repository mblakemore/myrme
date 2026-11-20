import { describe, expect, it } from 'vitest';
import { DIFFICULTY_INTENSITY, type FoodSpawn } from '../../core';
import { BALANCE } from '../data/balance';
import { makeArena, type ArenaOptions } from './combatTestUtil';
import { isAsleep, spawnCreatureAt } from './creatures';
import { defencePower, directorDebug, directorHistory, forceDirectorEvent } from './director';
import { rivalColonies } from './rivals';

const D = BALANCE.b1.director;
const food = (): FoodSpawn[] => [
  { kind: 'seeds', pos: { x: 48, y: 20.5, z: 30 }, amount: 400, regen: 0.2 },
  { kind: 'seeds', pos: { x: 30, y: 20.5, z: 70 }, amount: 300, regen: 0.2 },
  { kind: 'seeds', pos: { x: 66, y: 20.5, z: 70 }, amount: 300, regen: 0.2 },
];
const OUTDOOR: ArenaOptions = { size: 96, nests: [{ x: 18, z: 48 }, { x: 78, z: 48 }], rivals: true, predators: true };

function world(intensity: number, seed = 7, extra: ArenaOptions = {}) {
  return makeArena({ ...OUTDOOR, food: food(), seed, director: { enabled: true, intensity }, ...extra });
}

describe('threat director', () => {
  it('is off by default and does nothing when disabled (sandbox switch)', () => {
    const a = makeArena({ ...OUTDOOR });
    expect(a.sim.director.enabled).toBe(false);
    a.run(6000);
    expect(a.sim.director.budget).toBe(0);
    expect(directorHistory(a.sim).length).toBe(0);
    expect(rivalColonies(a.sim).length).toBe(0);
    expect(a.events.some((e) => e.type === 'directorWave')).toBe(false);
    // peaceful difficulty = intensity 0 = disabled even when asked for
    const p = world(DIFFICULTY_INTENSITY.peaceful);
    expect(p.sim.director.enabled).toBe(false);
  });

  it('can be switched at runtime with the setDirector command', () => {
    const a = makeArena({ ...OUTDOOR });
    a.sim.command({ type: 'setDirector', enabled: true, intensity: 1.5 });
    a.run(120);
    expect(a.sim.director.enabled).toBe(true);
    expect(a.sim.director.intensity).toBe(1.5);
    expect(a.sim.director.budget).toBeGreaterThan(0);
    expect(rivalColonies(a.sim).length).toBe(1); // founded on first sight of an enabled director
    a.sim.command({ type: 'setDirector', enabled: false });
    a.run(10);
    const b = a.sim.director.budget;
    a.run(600);
    expect(a.sim.director.budget).toBe(b);
  });

  it('schedule is deterministic for a seed and differs between seeds', () => {
    const run = (seed: number) => {
      const a = world(1, seed);
      a.run(9000);
      return { h: JSON.stringify(directorHistory(a.sim)), hash: a.sim.stateHash(), budget: a.sim.director.budget };
    };
    const x = run(7);
    const y = run(7);
    const z = run(8);
    expect(x.h).toBe(y.h);
    expect(x.hash).toBe(y.hash);
    expect(x.budget).toBe(y.budget);
    expect(JSON.parse(x.h).length).toBeGreaterThan(1);
    expect(z.hash).not.toBe(x.hash);
  });

  it('respects the grace period, starts with stage 0 events and escalates', () => {
    const a = world(1);
    const grace = D.graceTime * 30;
    a.run(grace - 10);
    expect(directorHistory(a.sim).length).toBe(0);
    expect(a.sim.creatures.filter((c) => c.def === 'jumpingSpider' && !isAsleep(a.sim, c)).length).toBe(0);
    a.run(15000 - a.sim.tick);
    const h = directorHistory(a.sim);
    expect(h.length).toBeGreaterThan(2);
    // the first waves are cheap ones
    expect(D.events[h[0].kind].stage).toBe(0);
    // nothing fires before its stage is unlocked
    const waves = a.events.filter((e) => e.type === 'directorWave');
    expect(waves.length).toBe(h.length);
    for (let i = 0; i < h.length; i++) {
      const w = waves[i];
      if (w.type === 'directorWave') expect(D.events[h[i].kind].stage).toBeLessThanOrEqual(w.stage);
    }
    expect(a.sim.director.stage).toBeGreaterThanOrEqual(1);
    // every heavy wave came with a positioned warning
    const warn = a.events.filter((e) => e.type === 'alert' && (e.code === 'predatorNear' || e.code === 'raidIncoming'));
    const heavy = h.filter((e) => D.events[e.kind].cost > 1.5);
    if (heavy.length > 0) expect(warn.length).toBeGreaterThan(0);
    for (const w of warn) if (w.type === 'alert') expect(Number.isFinite(w.pos?.x)).toBe(true);
  });

  it('scales with difficulty: more budget, earlier and heavier waves', () => {
    const total = (intensity: number) => {
      const a = world(intensity, 11);
      a.run(15000);
      const h = directorHistory(a.sim);
      return { first: h[0]?.tick ?? Infinity, threat: h.reduce((s, e) => s + e.threat, 0) + a.sim.director.budget, n: h.length };
    };
    const easy = total(DIFFICULTY_INTENSITY.easy);
    const normal = total(DIFFICULTY_INTENSITY.normal);
    const brutal = total(DIFFICULTY_INTENSITY.brutal);
    expect(easy.first).toBeGreaterThan(normal.first);
    expect(normal.first).toBeGreaterThan(brutal.first);
    expect(brutal.threat).toBeGreaterThan(normal.threat);
    expect(normal.threat).toBeGreaterThan(easy.threat);
    expect(brutal.n).toBeGreaterThanOrEqual(normal.n);
  });

  it('never buys a wave heavier than the colony can take, and goes quiet after heavy losses', () => {
    // (final round: seed chosen so that the opening border skirmishes do not trigger the quiet period early)
    const a = world(1, 3);
    a.run(D.graceTime * 30 + 200);
    // a tiny colony: the cap excludes the expensive events whatever the budget
    a.sim.director.budget = D.budgetMax;
    a.sim.director.stage = 4;
    a.sim.director.nextWaveTick = a.sim.tick;
    const n0 = directorHistory(a.sim).length;
    a.run(90);
    const h = directorHistory(a.sim);
    expect(h.length).toBeGreaterThan(n0);
    const cap = directorDebug(a.sim).cap;
    expect(cap).toBeLessThan(D.events.boss.cost);
    for (const e of h.slice(n0)) expect(e.kind === 'boss' || e.kind === 'waspSeason').toBe(false);
    expect(defencePower(a.sim)).toBeGreaterThan(0);
    // heavy losses → quiet period: no new wave, no budget growth
    const mine = a.sim.ants.filter((x) => x.colony === a.player.id && x.caste === 'worker');
    for (let i = 0; i < Math.ceil(mine.length * 0.6); i++) a.sim.killAnt(mine[i], 'combat');
    a.run(D.thinkEvery * 30 + 5);
    expect(directorDebug(a.sim).quietUntil).toBeGreaterThan(a.sim.tick);
    const budget = a.sim.director.budget;
    const n1 = directorHistory(a.sim).length;
    a.run(D.quietTime * 30 - 200);
    expect(a.sim.director.budget).toBe(budget);
    expect(directorHistory(a.sim).length).toBe(n1);
  });

  it('wakes a resident predator rather than spawning a second one', () => {
    const a = world(1);
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(48, 80), { asleep: true });
    a.run(5);
    expect(forceDirectorEvent(a.sim, 'predator')).toBeGreaterThan(0);
    expect(a.sim.creatures.filter((c) => c.def === 'jumpingSpider').length).toBe(1);
    expect(isAsleep(a.sim, spider)).toBe(false);
    a.run(1);
    expect(a.events.some((e) => e.type === 'alert' && e.code === 'predatorNear' && e.id === spider.id)).toBe(true);
    // every outdoor event can be staged without error
    a.run(300);
    for (const k of ['scout', 'prey', 'beetleRaid', 'waspSeason', 'boss'] as const) expect(forceDirectorEvent(a.sim, k), k).toBeGreaterThan(0);
    a.run(1200);
    expect(a.sim.creatures.some((c) => c.def === 'wasp') || a.events.some((e) => e.type === 'attack' && e.kind === 'sting')).toBe(true);
    expect(a.sim.creatures.some((c) => c.def === 'mantis')).toBe(true);
  });

  it('farm maps use the tube table: invaders through the tube port', () => {
    const a = makeArena({ tubePort: { x: 10, z: 10 }, predators: false, rivals: false, seed: 3, director: { enabled: true, intensity: 1 } });
    a.run(18000);
    const kinds = new Set(directorHistory(a.sim).map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(0);
    for (const k of kinds) expect(['tubeRaid', 'scout', 'prey']).toContain(k);
    expect(kinds.has('scout') || kinds.has('tubeRaid')).toBe(true);
    expect(a.sim.creatures.filter((c) => c.def === 'jumpingSpider' || c.def === 'wasp' || c.def === 'mantis').length).toBe(0);
    expect(a.player.alive).toBe(true);
  });
});
