import type { NavEx, PheromoneStoreEx, SimState, SimSystem } from '../../core';
import { BALANCE } from '../data/balance';

/**
 * Pheromone upkeep (D16).
 *
 *  - init: applies the balance file to the store (per-channel keep factors, caps, floor, pool
 *    size cap, foreign-smell factor) and tells it how to recognise sky-exposed cells.
 *  - every `evaporateEveryTicks` (2 Hz): one evaporation step. Entries on sky-exposed cells
 *    additionally decay with the weather — wind speed and rain intensity from `sim.weather`
 *    (trail washout) — entries inside the nest do not.
 *
 * Hooks for other streams (no need to edit this file):
 *   pheroOf(sim)                               the store with the A2a extensions
 *   pheroOf(sim).setDecayScale(k)              global evaporation multiplier (everything)
 *   pheroOf(sim).setChannelScale(channel, k)   per-channel multiplier
 *   setPheromoneWeatherOverride(sim, k | null) replace the built-in wind/rain formula for
 *                                              exposed cells (null = back to the formula)
 * Deposits are made by behaviors (`sim.pheromones.deposit`); cells are cleared on world edits by
 * the Simulation's edit hook.
 */

/** `sim.pheromones` with the A2a extensions (trail sensor, foreign smell, decay scales, stats). */
export function pheroOf(sim: SimState): PheromoneStoreEx {
  return sim.pheromones as PheromoneStoreEx;
}

const overrides = new WeakMap<SimState, number>();

/** Fix the evaporation multiplier of sky-exposed cells (null = derive it from `sim.weather`). */
export function setPheromoneWeatherOverride(sim: SimState, scale: number | null): void {
  if (scale === null) overrides.delete(sim);
  else overrides.set(sim, scale);
}

/** The exposed-cell evaporation multiplier the system would use right now. */
export function pheromoneWeatherScale(sim: SimState): number {
  const o = overrides.get(sim);
  if (o !== undefined) return o;
  const B = BALANCE.a2a;
  const wth = sim.weather;
  const wind = Math.hypot(wth.wind.x, wth.wind.y, wth.wind.z);
  const rain = wth.kind === 'rain' || wth.kind === 'storm' ? wth.intensity : 0;
  return 1 + wind * B.pheroWindDecay + rain * B.pheroRainDecay;
}

export const pheromoneSystem: SimSystem = {
  id: 'pheromone',
  init(sim) {
    const B = BALANCE.a2a;
    const store = pheroOf(sim);
    store.configure({ keep: B.pheroKeep, max: B.pheroMax, floor: B.pheroFloor, maxEntries: B.pheroMaxEntries, foreignFactor: B.pheroForeignFactor });
    const nav = sim.nav as NavEx;
    store.setExposure((cell) => nav.isExposed(cell));
  },
  update(sim) {
    if (sim.tick % BALANCE.a2a.evaporateEveryTicks !== 0) return;
    const store = pheroOf(sim);
    store.setWeatherScale(pheromoneWeatherScale(sim));
    store.evaporate(1);
  },
};
