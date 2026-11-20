import { describe, expect, it } from 'vitest';
import type { MapId, SpeciesId } from '../core';
import { makeFullGame, runFullGame, type FullResult } from './fullGameKit';

/**
 * M3 full-game soaks: the simulation exactly as the menu starts it on "normal" — director,
 * rivals, weather, fungus, keeper, goals, every Wave-B system at once — for 20 sim-minutes.
 * Each run prints a per-minute timeline (population by caste, food, brood, weather, director,
 * rivals, creatures, goal, deaths by cause) that is meant to be READ; the assertions are the
 * invariants plus loose floors under the outcomes seen while balancing (see the M3 report).
 */
const MINUTES = 20;
const TIMEOUT = 150_000;

function invariants(r: FullResult): void {
  expect(r.bad, 'non-finite pose / stat samples').toBe(0);
  expect(r.maxInside, 'ant inside solid (voxels)').toBeLessThan(0.75);
  expect(r.msPerTick, 'sim ms per tick').toBeLessThan(4);
  expect(r.foreignAlerts, "alerts of other colonies reaching the player's HUD").toBe(0);
  expect(r.wall).toBeLessThan(90);
}

function popAt(r: FullResult, min: number): number {
  return r.rows.find((x) => x.min === min)?.pop ?? r.rows[r.rows.length - 1].pop;
}

describe('M3 full game — every faction on the meadow, normal difficulty, 20 sim-minutes', () => {
  const floors: Record<SpeciesId, number> = { gardenAnt: 60, fireAnt: 35, leafcutter: 50, termite: 80 };
  for (const faction of ['gardenAnt', 'fireAnt', 'leafcutter', 'termite'] as const) {
    it(
      `${faction}: colony grows through raids, predators and weather`,
      () => {
        const r = runFullGame(`${faction} on meadow`, makeFullGame('meadow', { seed: 1, faction }), MINUTES, { stopOnEnd: false });
        invariants(r);
        expect(r.status).not.toBe('lost');
        expect(r.queenAlive).toBe(true);
        expect(popAt(r, 20)).toBeGreaterThanOrEqual(floors[faction]);
        expect(popAt(r, 10)).toBeGreaterThan(popAt(r, 2));
        // the world was actually on
        expect(r.waves).toBeGreaterThan(3);
        expect(r.weatherSeen.length).toBeGreaterThan(1);
        expect(r.sim.colonies.length).toBeGreaterThan(1);
      },
      TIMEOUT,
    );
  }
});

describe('M3 full game — garden ants on every other map, default mode', () => {
  const floors: Record<string, number> = { forest: 50, desert: 25, gelFarm: 50, sandFarm: 50, formicarium: 50 };
  for (const map of ['forest', 'desert', 'gelFarm', 'sandFarm', 'formicarium'] as const) {
    it(
      `${map}: survives and grows`,
      () => {
        const r = runFullGame(`gardenAnt on ${map}`, makeFullGame(map as MapId, { seed: 1 }), MINUTES, { stopOnEnd: false });
        invariants(r);
        expect(r.status).not.toBe('lost');
        expect(r.queenAlive).toBe(true);
        expect(popAt(r, 20)).toBeGreaterThanOrEqual(floors[map]);
      },
      TIMEOUT,
    );
  }
});

describe('M3 full game — outcome distribution and determinism', () => {
  it(
    'meadow garden ant, seeds 1–3: no seed loses, all are on course for the flight; same seed → same stateHash',
    () => {
      const runs = [1, 2, 3].map((seed) => runFullGame(`gardenAnt on meadow seed ${seed}`, makeFullGame('meadow', { seed }), MINUTES, { stopOnEnd: false, quiet: true }));
      const again = runFullGame('gardenAnt on meadow seed 1 (rerun)', makeFullGame('meadow', { seed: 1 }), MINUTES, { stopOnEnd: false, quiet: true });
      console.log(
        '[full game] meadow garden ant distribution @20 min\n' +
          runs.map((r, i) => `  seed ${i + 1}: pop ${popAt(r, 5)}/${popAt(r, 10)}/${popAt(r, 15)}/${popAt(r, 20)} food ${r.rows[r.rows.length - 1].food.toFixed(0)} deaths ${JSON.stringify(r.deaths)} waves ${r.waves} ${r.msPerTick.toFixed(2)} ms/tick`).join('\n'),
      );
      for (const r of runs) {
        expect(r.bad).toBe(0);
        expect(r.status).not.toBe('lost');
        expect(r.queenAlive).toBe(true);
        expect(popAt(r, 20)).toBeGreaterThanOrEqual(50);
      }
      expect(again.hash).toBe(runs[0].hash);
    },
    240_000,
  );

  for (const faction of ['fireAnt', 'leafcutter', 'termite'] as const) {
    it(
      `${faction}: 6 sim-minutes twice → same stateHash`,
      () => {
        const a = runFullGame(faction, makeFullGame('meadow', { seed: 7, faction }), 6, { quiet: true });
        const b = runFullGame(faction, makeFullGame('meadow', { seed: 7, faction }), 6, { quiet: true });
        expect(a.bad + b.bad).toBe(0);
        expect(b.hash).toBe(a.hash);
      },
      TIMEOUT,
    );
  }
});
