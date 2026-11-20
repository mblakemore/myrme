import { smoothstep, type Ant, type Beacon, type Colony, type Job, type JobKind, type SimState, type Vec3 } from '../../core';
import { BALANCE } from '../data/balance';
import { getCaste } from '../data/species';
import { getExt, type ColonyExt } from './colonyState';

/**
 * Job-board access for duty behaviors (§5.2): response-threshold scoring, reservations.
 *
 * Allocation model. For every job kind the jobs system publishes a stimulus
 * `ext.demand[kind]` = (most urgent job with a free slot) × (player priority slider). An ant's
 * response is the classic threshold function  s² / (s² + θ²)  where θ is the caste threshold from
 * the species def times an age factor: young ants have low thresholds for inside work (brood,
 * queen) and high ones for outside work (forage, corpses, patrol); old ants the reverse
 * (age polyethism). Reservations: a job has `slots`; `claimJob` adds the ant to `job.assigned`,
 * the jobs system drops assignees that died or no longer hold a task for the job.
 */

const INSIDE: Partial<Record<JobKind, 1>> = { feedLarva: 1, feedQueen: 1, carryBrood: 1, tendGarden: 1 };
const OUTSIDE: Partial<Record<JobKind, 1>> = { forage: 1, haulFood: 1, carryCorpse: 1, patrol: 1, guard: 1, harvestLeaves: 1, herdAphids: 1 };

/** 0 = freshly eclosed … 1 = old (saturates at half the lifespan). */
export function ageFactor(ant: Ant): number {
  if (!Number.isFinite(ant.lifespan) || ant.lifespan <= 0) return 0.5;
  return smoothstep(0.04, 0.45, ant.age / ant.lifespan);
}

/** Effective response threshold of this ant for a job kind, or -1 if its caste never does it. */
export function thresholdFor(ant: Ant, kind: JobKind): number {
  const base = getCaste(ant.species, ant.caste).thresholds[kind];
  if (base === undefined) return -1;
  const a = ageFactor(ant);
  const lo = BALANCE.a2b.ageThresholdLo;
  const hi = BALANCE.a2b.ageThresholdHi;
  if (INSIDE[kind]) return base * (lo + (hi - lo) * a);
  if (OUTSIDE[kind]) return base * (hi + (lo - hi) * a);
  return base;
}

/** Response 0..1 of an ant to the colony's current stimulus for `kind`. */
export function response(sim: SimState, ant: Ant, kind: JobKind): number {
  const ext = getExt(sim, ant.colony);
  if (!ext.active) return 0;
  const s = ext.demand[kind];
  if (!(s > 0)) return 0;
  const th = thresholdFor(ant, kind);
  if (th < 0) return 0;
  const r = (s * s) / (s * s + th * th);
  // any duty outranks idling, so weak responses must not count as a "yes"
  return r < BALANCE.a2b.minResponse ? 0 : r;
}

/**
 * Foraging stimulus: need from the food stores, capped by how many foragers are already out,
 * boosted by a live trail at the entrance (recruitment). Recomputed by the jobs system and
 * whenever an ant starts/stops foraging, so a whole cohort thinking in the same tick cannot all
 * walk out at once.
 */
export function updateForageDemand(colony: Colony, ext: ColonyExt): void {
  const B = BALANCE.a2b;
  const pop = colony.population.total;
  const want = B.foodTargetBase + B.foodTargetPerAnt * pop;
  const need = Math.max(B.forageDemandMin, Math.min(1, 1 - colony.stores.food / want));
  const pri = colony.priorities.forage;
  const maxForagers = Math.max(2, ext.workers * (B.foragerFracMin + (B.foragerFracMax - B.foragerFracMin) * need)) * pri;
  const room = 1 - ext.foragers / Math.max(1, maxForagers);
  ext.demand.forage = room <= 0 ? 0 : (0.35 + 0.65 * need) * pri * (0.3 + 0.7 * room) * (1 + Math.min(0.5, ext.entranceTrail * 0.1));
}

/** Per-ant, per-behavior cooldown after a failed claim so `score` stops proposing it for a while. */
export function isBlocked(ant: Ant, sim: SimState, key: string): boolean {
  const until = ant.mem[key];
  return until !== undefined && sim.tick < until;
}
export function block(ant: Ant, sim: SimState, key: string, seconds: number = BALANCE.a2b.noJobCooldown): void {
  ant.mem[key] = sim.tick + Math.round(seconds * 30);
  ant.thinkAt = sim.tick; // pick something else right away
}

export function getJob(sim: SimState, ant: Ant, jobId: number): Job | undefined {
  return jobId ? getExt(sim, ant.colony).jobsById.get(jobId) : undefined;
}

export function inAvoidZone(colony: Colony, p: Vec3): Beacon | null {
  for (const b of colony.beacons) {
    if (b.kind !== 'avoid') continue;
    const dx = p.x - b.pos.x;
    const dy = p.y - b.pos.y;
    const dz = p.z - b.pos.z;
    if (dx * dx + dy * dy + dz * dz < b.radius * b.radius) return b;
  }
  return null;
}

/**
 * Reserve the best open job of `kind` for the ant (highest urgency, nearer first). Returns null
 * when every job is full, unreachable or inside an Avoid beacon.
 */
export function claimJob(sim: SimState, colony: Colony, ant: Ant, kind: JobKind, filter?: (job: Job) => boolean): Job | null {
  let best: Job | null = null;
  let bestScore = -Infinity;
  const hasAvoid = colony.beacons.some((b) => b.kind === 'avoid');
  for (const j of colony.jobs) {
    if (j.kind !== kind || j.urgency <= 0 || j.assigned.length >= j.slots || j.cell < 0) continue;
    if (filter && !filter(j)) continue;
    if (hasAvoid && inAvoidZone(colony, j.pos)) continue;
    const d = Math.hypot(j.pos.x - ant.pos.x, j.pos.y - ant.pos.y, j.pos.z - ant.pos.z);
    const s = j.urgency - d * 0.012;
    if (s > bestScore) {
      bestScore = s;
      best = j;
    }
  }
  if (best) best.assigned.push(ant.id);
  return best;
}

export function releaseJob(sim: SimState, ant: Ant, jobId: number): void {
  const job = getJob(sim, ant, jobId);
  if (!job) return;
  const i = job.assigned.indexOf(ant.id);
  if (i >= 0) job.assigned.splice(i, 1);
}

/** Remove a job from the board (work finished or target gone). Assignees notice via `getJob`. */
export function retireJob(colony: Colony, ext: ColonyExt, job: Job, key?: string): void {
  const i = colony.jobs.indexOf(job);
  if (i >= 0) colony.jobs.splice(i, 1);
  ext.jobsById.delete(job.id);
  if (key !== undefined) ext.jobByKey.delete(key);
  else
    for (const [k, v] of ext.jobByKey)
      if (v === job) {
        ext.jobByKey.delete(k);
        break;
      }
}
