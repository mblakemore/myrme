/** Global constants. Tuning numbers for gameplay live in sim/data/balance.ts, not here. */

/** Fixed simulation rate (§5.1). */
export const TICK_HZ = 30;
export const TICK_DT = 1 / TICK_HZ;

/** D1: worker ant body length in world units. */
export const WORKER_LENGTH = 0.7;
/** Ride height (body centre above the surface) as a fraction of body length. */
export const RIDE_PER_LENGTH = 0.22;

/** Minimum brush radius (D4). */
export const MIN_BRUSH_RADIUS = 1.5;

/**
 * Walkable band (D15): a cell is walkable when its density is in [WALK_MIN_DENSITY, ISO), i.e.
 * the cell centre is in air and within ~1.1 voxels of a surface.
 */
export const WALK_MIN_DENSITY = 58;

/** Spatial hash cell size in world units. */
export const SPATIAL_CELL = 4;

/** Lock file used to serialise browser runs between agents (D22). */
export const BROWSER_LOCK = '/tmp/myrme-browser.lock';
