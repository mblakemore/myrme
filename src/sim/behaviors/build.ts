import type { Behavior } from '../../core';
import { dutyTask } from '../systems/colonyState';
import { runDigDuty, stopDigDuty } from '../systems/dig';
import { getJob } from '../systems/jobsBoard';
import { failTermiteOp, termiteOpOf, workTermiteOp } from '../systems/termiteBuild';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { ARRIVED, FAILED, approach, clearWorkAnim } from './util';

/**
 * Mud building (`build` jobs; only castes with a `build` threshold — termite workers — respond).
 *
 * Two kinds of job share the board:
 *  - a player-painted BUILD DESIGNATION (`job.designationId` ≠ 0, posted by the job board): the
 *    stamps are placed through A2a's dig-site API — `runDigDuty(kind: 'build')` claims a site,
 *    walks there and calls `applyBuildWork`, which spends `stores.mud`. When the mud runs out the
 *    ant backs off for a while.
 *  - the colony's own WORKS (`job.designationId` = 0, posted by systems/termiteBuild.ts — breach
 *    plugs, shelter-tube segments, mound stamps): walk to the operation's standing cell and work
 *    it with `workTermiteOp`; `task.data` holds the operation serial the job was claimed for.
 * Either way finishing a stamp is a natural break: the ant re-decides.
 */
export const buildBehavior: Behavior = {
  id: 'build',
  band: 'duty',
  score(ant, sim) {
    return dutyScore(sim, ant, 'build', 'build', 'nj.build');
  },
  run(ant, sim, dt) {
    const t = dutyTask(ant) ?? takeJob(sim, ant, 'build', 'build', 'nj.build') ?? undefined;
    if (!t || t.kind !== 'build') return;
    const colony = sim.getColony(ant.colony);
    const job = getJob(sim, ant, t.jobId);
    if (!colony || !job) {
      stopDigDuty(sim, ant);
      finishDuty(sim, ant, t);
      return;
    }
    if (job.designationId) {
      const d = colony.designations.find((x) => x.id === job.designationId);
      if (!d || d.kind !== 'build') {
        stopDigDuty(sim, ant);
        finishDuty(sim, ant, t);
        return;
      }
      const st = runDigDuty(sim, ant, dt, { kind: 'build', designationId: d.id });
      if (st === 'done') {
        // nothing workable (finished, out of reach, or out of mud)
        stopDigDuty(sim, ant);
        finishDuty(sim, ant, t, 'nj.build', colony.stores.mud < 1 ? 8 : 2);
      } else if (st === 'idle') {
        if (++t.phase > 90) {
          stopDigDuty(sim, ant);
          finishDuty(sim, ant, t, 'nj.build', 3);
        }
      } else t.phase = 0;
      return;
    }
    // the colony's own works
    const op = termiteOpOf(sim, colony.id);
    if (!op || op.serial !== job.data || op.serial !== t.data) {
      finishDuty(sim, ant, t);
      return;
    }
    // Final round: a builder on the colony's works carries wet mud and plasters itself in as it
    // goes — it is not driven off by sun or ordinary rain (seekShade) and is not scorched
    // (termiteBuild.sunAndPellets) while the flag is fresh.
    ant.mem['tb.w'] = sim.tick;
    let r = workTermiteOp(sim, ant, op.serial, dt, ant.mem['tb.at'] === op.serial);
    if (r === 'far') {
      const a = approach(sim, ant, op.cell, null, 0.9);
      if (a === ARRIVED) {
        ant.mem['tb.at'] = op.serial;
        r = workTermiteOp(sim, ant, op.serial, dt, true);
        if (r === 'far') {
          failTermiteOp(sim, colony.id, op.serial);
          finishDuty(sim, ant, t, 'nj.build', 4);
          return;
        }
      } else if (a === FAILED) {
        failTermiteOp(sim, colony.id, op.serial);
        finishDuty(sim, ant, t, 'nj.build', 4);
        return;
      }
    }
    if (r === 'done' || r === 'none') finishDuty(sim, ant, t, r === 'none' ? 'nj.build' : undefined, 3);
  },
  exit(ant, sim) {
    stopDigDuty(sim, ant);
    clearWorkAnim(ant);
  },
};
