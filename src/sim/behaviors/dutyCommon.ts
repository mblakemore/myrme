import { v3clone, type Ant, type Job, type JobKind, type SimState, type Task, type TaskKind } from '../../core';
import { BALANCE } from '../data/balance';
import { makeTask } from '../entities';
import { dutyTask, removeTask } from '../systems/colonyState';
import { block, claimJob, isBlocked, releaseJob, response } from '../systems/jobsBoard';
import { clearWorkAnim } from './util';

/** Shared skeleton of job-board duty behaviors (claim → task → state machine → finish). */

/** Standard duty score: commitment while holding the task, else the response-threshold value. */
export function dutyScore(sim: SimState, ant: Ant, taskKind: TaskKind, jobKind: JobKind, key: string, owns?: (t: Task) => boolean): number {
  const t = dutyTask(ant);
  if (t) return t.kind === taskKind && (!owns || owns(t)) ? BALANCE.a2b.commitScore : 0;
  if (ant.carrying || isBlocked(ant, sim, key)) return 0;
  return response(sim, ant, jobKind);
}

/** Claim a job of `jobKind` and push the matching duty task; null (and a cooldown) if none is free. */
export function takeJob(sim: SimState, ant: Ant, taskKind: TaskKind, jobKind: JobKind, key: string, filter?: (job: Job) => boolean): Task | null {
  const colony = sim.getColony(ant.colony);
  const job = colony ? claimJob(sim, colony, ant, jobKind, filter) : null;
  if (!job) {
    block(ant, sim, key);
    ant.intent.mode = 'none';
    return null;
  }
  const t = makeTask(sim, taskKind, 'colony', { jobId: job.id, targetId: job.targetId, cell: job.cell, pos: v3clone(job.pos), data: job.data });
  ant.tasks.push(t);
  return t;
}

/** End a duty task: free the reservation, pop the task, think again immediately. */
export function finishDuty(sim: SimState, ant: Ant, t: Task, cooldownKey?: string, cooldown?: number): void {
  releaseJob(sim, ant, t.jobId);
  removeTask(ant, t);
  clearWorkAnim(ant);
  ant.intent.mode = 'none';
  ant.thinkAt = sim.tick;
  if (cooldownKey) block(ant, sim, cooldownKey, cooldown);
}
