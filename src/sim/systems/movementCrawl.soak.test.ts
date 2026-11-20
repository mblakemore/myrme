import { describe, expect, it } from 'vitest';
import { v3isFinite, type MapId } from '../../core';
import { makeSim } from '../testUtil';

/**
 * Crawl soak (PLAN §11): 1,000 wander ants on each fixture map must never produce NaN poses,
 * never sit inside solid, always stay within reach of a surface (or be mid-fall), keep unit
 * orthogonal frames, move smoothly, and actually visit walls and ceilings.
 */
const ANTS = 1000;
const TICKS = 3000;

function soak(mapId: MapId) {
  const sim = makeSim(mapId, { seed: 7, ants: ANTS });
  expect(sim.ants.length).toBe(ANTS);
  const sideways = new Set<number>(); // up.y < 0.3 at some point (walls / ceilings)
  const inverted = new Set<number>(); // up.y < -0.5 (ceilings / undersides)
  let maxInside = -Infinity;
  let maxDetached = 0;
  let maxStep = 0;
  let maxUpTurn = 0;
  let falls = 0;
  let travelled = 0;
  let bad = 0;
  const lateTravel = new Map<number, number>();
  const t0 = performance.now();
  for (let t = 0; t < TICKS; t++) {
    sim.step();
    for (const a of sim.ants) {
      if (!v3isFinite(a.pos) || !v3isFinite(a.up) || !v3isFinite(a.forward)) {
        bad++;
        continue;
      }
      const s = sim.world.sample(a.pos.x, a.pos.y, a.pos.z);
      if (s > maxInside) maxInside = s;
      if (!a.falling && -s > maxDetached) maxDetached = -s;
      const step = Math.hypot(a.pos.x - a.prevPos.x, a.pos.y - a.prevPos.y, a.pos.z - a.prevPos.z);
      if (!a.falling && step > maxStep) maxStep = step;
      travelled += step;
      if (t >= TICKS - 900) lateTravel.set(a.id, (lateTravel.get(a.id) ?? 0) + step);
      const upDot = a.up.x * a.prevUp.x + a.up.y * a.prevUp.y + a.up.z * a.prevUp.z;
      if (!a.falling && 1 - upDot > maxUpTurn) maxUpTurn = 1 - upDot;
      const ul = Math.hypot(a.up.x, a.up.y, a.up.z);
      const fl = Math.hypot(a.forward.x, a.forward.y, a.forward.z);
      const uf = a.up.x * a.forward.x + a.up.y * a.forward.y + a.up.z * a.forward.z;
      if (Math.abs(ul - 1) > 1e-3 || Math.abs(fl - 1) > 1e-3 || Math.abs(uf) > 1e-3) bad++;
      if (a.up.y < 0.3) sideways.add(a.id);
      if (a.up.y < -0.5) inverted.add(a.id);
    }
    for (const e of sim.drainEvents()) if (e.type === 'fell') falls++;
  }
  const ms = (performance.now() - t0) / TICKS;
  const report = {
    mapId,
    msPerTick: +ms.toFixed(3),
    maxInside: +maxInside.toFixed(3),
    maxDetached: +maxDetached.toFixed(3),
    maxStep: +maxStep.toFixed(3),
    maxUpTurnDeg: +((Math.acos(1 - maxUpTurn) * 180) / Math.PI).toFixed(1),
    sideways: sideways.size,
    inverted: inverted.size,
    falls,
    stuck: [...lateTravel.values()].filter((d) => d < 3).length,
    meanSpeed: +((travelled / (ANTS * TICKS)) * 30).toFixed(2),
  };
  console.log('[crawl soak]', JSON.stringify(report));
  return { ...report, bad, sim };
}

describe.each(['meadow', 'gelFarm'] as const)('crawl soak: %s', (mapId) => {
  it(`${ANTS} wander ants × ${TICKS} ticks stay on surfaces`, () => {
    const r = soak(mapId);
    expect(r.bad).toBe(0); // no NaN, frames orthonormal
    expect(r.maxInside).toBeLessThan(0.1); // never inside solid beyond tolerance
    expect(r.maxDetached).toBeLessThan(1.0); // always within reach of a surface
    expect(r.maxStep).toBeLessThan(0.25); // no teleports (speed 2.4 → 0.08 / tick)
    expect(r.maxUpTurnDeg).toBeLessThan(40); // orientation is smooth
    expect(r.sideways).toBeGreaterThan(ANTS * 0.25); // ants really use walls…
    expect(r.inverted).toBeGreaterThan(5); // …and ceilings / undersides
    expect(r.falls).toBeLessThan(ANTS * 0.05);
    expect(r.stuck).toBe(0); // nobody wedged for the last 30 s
    expect(r.meanSpeed).toBeGreaterThan(1.2); // they are not stuck
    expect(r.sim.ants.length).toBe(ANTS);
  }, 120000);
});
