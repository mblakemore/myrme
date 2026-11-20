import { envOf, type SimState, type Vec3 } from '../../core';

/**
 * Optional bridges from keeper events to other streams' systems. Each hook returns true when it
 * handled the effect; when a hook is absent (or returns false) the keeper falls back to the
 * frozen-contract API (`sim.water.addWater`, `weather.lamp`, `Item.infected`).
 */
export interface KeeperHooks {
  /** Pour `amount` voxels of water at a surface position. */
  addWater?: (sim: SimState, pos: Vec3, amount: number) => boolean;
  /** Register / move / remove (pos = null) a named heat source. */
  setHeatSource?: (sim: SimState, key: string, pos: Vec3 | null, strength: number) => boolean;
  /** Expose everything within `radius` of `pos` to fungus spores with the given load 0..1. */
  exposeToSpores?: (sim: SimState, pos: Vec3, radius: number, load: number) => boolean;
}

/** Wired to B2's environment API (`envOf(sim)`); each returns false before B2's systems ran `init`. */
export const keeperHooks: KeeperHooks = {
  addWater(sim, pos, amount) {
    const env = envOf(sim);
    if (!env) return false;
    env.addWater(pos, amount);
    return true;
  },
  // setHeatSource: not wired — B2's temperature field already reads the keeper lamp from `weather.lamp`.
  exposeToSpores(sim, pos, radius, load) {
    const env = envOf(sim);
    if (!env) return false;
    env.exposeToSpores(pos, radius, load, false);
    return true;
  },
};
