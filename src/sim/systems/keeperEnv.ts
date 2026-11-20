import { RIDE_PER_LENGTH, envOf, type Ant, type CasteId, type CellIndex, type Colony, type Job, type JobKind, type NavEx, type SimState, type Vec3 } from '../../core';
import { getCaste, getSpecies } from '../data/species';
import { getExt } from './colonyState';

/**
 * Shared helpers of the B3 systems (keeper, goals, raft, termite works, gardens, aphids):
 * environment adapters (one place that knows how to ask B2 about sun, temperature and water),
 * job-board glue for jobs that B3 systems post themselves, and small entity utilities.
 */

// ---- environment --------------------------------------------------------------------------------

/** Is the sun up? Farm maps (no day/night cycle) are lit by room light only: never "sun". */
export function isDaylight(sim: SimState, from = 0.25, to = 0.75): boolean {
  if (!sim.map.flags.dayNight) return false;
  const t = sim.weather.timeOfDay;
  return t > from && t < to;
}

/**
 * 0..1 strength of direct sun on a cell right now: daylight × sky exposure × cloud cover.
 * Rain, storms and cold snaps block it; `cloudy` halves it. The keeper's desk lamp counts as a
 * small sun within its reach on farm maps.
 */
export function sunAt(sim: SimState, cell: CellIndex, pos: Vec3, from = 0.25, to = 0.75): number {
  if (cell < 0) return 0;
  const lamp = sim.weather.lamp;
  let s = 0;
  const env = envOf(sim);
  if (env) {
    // B2's sun (elevation × clear sky, 0 under cover) — the same signal its `seekShade` reacts to
    s = env.sunExposure(cell);
    if (s > 0) return s;
    if (!lamp) return 0;
    const d = Math.hypot(pos.x - lamp.x, pos.y - lamp.y, pos.z - lamp.z);
    return d < 14 && (sim.nav as NavEx).isExposed(cell) ? 0.6 * (1 - d / 14) : 0;
  }
  if (isDaylight(sim, from, to)) {
    const k = sim.weather.kind;
    s = k === 'rain' || k === 'storm' ? 0 : k === 'cloudy' || k === 'cold' ? 0.4 : k === 'heat' ? 1.3 : 1;
    // low sun burns less
    const t = sim.weather.timeOfDay;
    const edge = Math.min(t - from, to - t) / 0.08;
    if (edge < 1) s *= Math.max(0.3, edge);
  } else if (lamp) {
    const d = Math.hypot(pos.x - lamp.x, pos.y - lamp.y, pos.z - lamp.z);
    s = d < 14 ? 0.6 * (1 - d / 14) : 0;
  }
  if (s <= 0) return 0;
  return (sim.nav as NavEx).isExposed(cell) ? s : 0;
}

/** Is the sun (or the keeper's lamp) burning anywhere right now? */
export function sunIsUp(sim: SimState, from = 0.25, to = 0.75): boolean {
  if (sim.weather.lamp) return true;
  const env = envOf(sim) as { sun?: number } | null;
  if (env && typeof env.sun === 'number') return env.sun > 0.05;
  return isDaylight(sim, from, to) && !isRaining(sim);
}

/** Ambient temperature at a position (°C). */
export function temperatureAt(sim: SimState, pos: Vec3): number {
  // B2's temperature field (time of day, depth, shade, heat sources such as the keeper's lamp)
  const env = envOf(sim);
  if (env) return env.temperatureAt(pos);
  let t = sim.weather.temperature;
  const lamp = sim.weather.lamp;
  if (lamp) {
    const d = Math.hypot(pos.x - lamp.x, pos.y - lamp.y, pos.z - lamp.z);
    if (d < 20) t += 10 * (1 - d / 20);
  }
  return t;
}

export function isRaining(sim: SimState): boolean {
  const k = sim.weather.kind;
  return (k === 'rain' || k === 'storm') && sim.weather.intensity > 0.05;
}

/** Depth 0..1 of water in a cell (`WaterField`, D17). */
export function waterDepth(sim: SimState, cell: CellIndex): number {
  return cell < 0 ? 0 : sim.water.depthAt(cell);
}

// ---- job-board glue -----------------------------------------------------------------------------

/**
 * Post (or refresh) a job owned by a B3 system. The job goes on `colony.jobs` and into A2b's
 * id index, so `getJob` / `claimJob` / reservation validation work on it; A2b's board only
 * retires jobs it keyed itself, so B3 jobs live until `closeJob`.
 */
export function postJob(sim: SimState, colony: Colony, slot: { job: Job | null }, kind: JobKind, cell: CellIndex, pos: Vec3, targetId: number, urgency: number, slots: number, data = 0): Job {
  const ext = getExt(sim, colony.id);
  let job = slot.job;
  if (job && ext.jobsById.get(job.id) !== job) job = null;
  if (!job) {
    job = { id: sim.nextId(), kind, colony: colony.id, cell, pos: { x: pos.x, y: pos.y, z: pos.z }, targetId, urgency, slots, assigned: [], remaining: 1, designationId: 0, createdTick: sim.tick, data };
    colony.jobs.push(job);
    ext.jobsById.set(job.id, job);
    slot.job = job;
  } else {
    job.cell = cell;
    job.pos.x = pos.x;
    job.pos.y = pos.y;
    job.pos.z = pos.z;
    job.targetId = targetId;
    job.urgency = urgency;
    job.slots = slots;
    job.data = data;
  }
  return job;
}

export function closeJob(sim: SimState, colony: Colony, slot: { job: Job | null }): void {
  const job = slot.job;
  if (!job) return;
  slot.job = null;
  const ext = getExt(sim, colony.id);
  const i = colony.jobs.indexOf(job);
  if (i >= 0) colony.jobs.splice(i, 1);
  if (ext.jobsById.get(job.id) === job) ext.jobsById.delete(job.id);
}

/** Refresh `ext.demand[kind]` right away from the open jobs (the board does it every 10 ticks). */
export function bumpDemand(sim: SimState, colony: Colony, kind: JobKind): void {
  const ext = getExt(sim, colony.id);
  let d = 0;
  for (const job of colony.jobs) {
    if (job.kind !== kind || job.cell < 0 || job.assigned.length >= job.slots) continue;
    const s = job.urgency * colony.priorities[kind];
    if (s > d) d = s;
  }
  ext.demand[kind] = d;
}

// ---- entities -----------------------------------------------------------------------------------

/** Turn an ant into another caste of its species in place (founding cohorts, succession). */
export function recaste(ant: Ant, casteId: CasteId): void {
  const c = getCaste(ant.species, casteId);
  const hpFrac = ant.maxHealth > 0 ? ant.health / ant.maxHealth : 1;
  ant.caste = c.id;
  ant.clearance = c.clearance;
  ant.speed = c.speed;
  ant.maxHealth = c.maxHealth;
  ant.health = c.maxHealth * hpFrac;
  ant.rideHeight = Math.min(1.2, c.length * RIDE_PER_LENGTH);
  if (!Number.isFinite(c.lifespan)) ant.lifespan = Infinity;
  else if (!Number.isFinite(ant.lifespan)) ant.lifespan = ant.age + Math.round(c.lifespan * 30);
}

export function capsOf(sim: SimState, colonyId: number) {
  const c = sim.getColony(colonyId);
  return c ? getSpecies(c.species).caps : null;
}

/** Adult ants of a colony that are neither royals nor winged (the workforce). */
export function countWorkers(sim: SimState, colony: Colony): number {
  const p = colony.population.byCaste;
  return colony.population.total - (p.queen ?? 0) - (p.king ?? 0) - (p.alate ?? 0);
}
