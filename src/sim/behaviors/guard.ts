import type { Ant, Behavior, Mover, SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { bodyRadius, distance, isEnemy, isFighter, presenceAt, type Fighter } from '../systems/combatCore';
import { dutyTask } from '../systems/colonyState';
import { getJob } from '../systems/jobsBoard';
import { dutyScore, finishDuty, takeJob } from './dutyCommon';
import { fightExit, fightStep } from './fightCommon';
import { FAILED, approach, shuffle } from './util';

const G = BALANCE.b1.guard;
const _near: Mover[] = [];

function intruderNear(sim: SimState, ant: Ant, x: number, y: number, z: number): Fighter | null {
  sim.spatial.queryMovers(x, y, z, G.interceptRadius + 2, _near);
  let best: Fighter | null = null;
  let bestD = Infinity;
  for (const m of _near) {
    if (!m.alive || !isEnemy(sim, ant, m)) continue;
    const d = Math.hypot(m.pos.x - x, m.pos.y - y, m.pos.z - z) - bodyRadius(m);
    if (d < bestD && d <= G.interceptRadius) {
      bestD = d;
      best = m as Fighter;
    }
  }
  return best;
}

/**
 * Guard duty (`guard` jobs — the nest entrance posts; soldiers have the keen threshold).
 * A guard stands at its post for a shift, intercepts any enemy that comes within
 * `interceptRadius` of it (farther than a soldier would notice by itself), and — like every
 * brave caste — answers alarm calls through the `fight` behavior, which pre-empts this one.
 * Player `guard` orders are run by A2b's playerOrder behavior and bite through the same combat
 * system.
 */
export const guardBehavior: Behavior = {
  id: 'guard',
  band: 'duty',
  score: (ant, sim) => dutyScore(sim, ant, 'guard', 'guard', 'nj.guard'),
  run(ant, sim, dt) {
    const fresh = !dutyTask(ant);
    const t = dutyTask(ant) ?? takeJob(sim, ant, 'guard', 'guard', 'nj.guard');
    if (!t || t.kind !== 'guard') return;
    const job = getJob(sim, ant, t.jobId);
    const mem = ant.mem;
    if (fresh) mem['gd.t0'] = sim.tick;
    if (!job || sim.tick - (mem['gd.t0'] ?? 0) > G.shift * 30) {
      fightExit(ant);
      finishDuty(sim, ant, t, 'nj.guard', 15);
      return;
    }
    // intruders near the post
    if ((sim.tick + ant.id) % 10 === 0) {
      const e = presenceAt(sim, job.pos, ant.colony) !== 0 ? intruderNear(sim, ant, job.pos.x, job.pos.y, job.pos.z) : null;
      mem['gd.e'] = e ? e.id : 0;
    }
    const e = mem['gd.e'] ? sim.getEntity(mem['gd.e']) : undefined;
    if (isFighter(e) && isEnemy(sim, ant, e)) {
      if (fightStep(sim, ant, e) === FAILED) mem['gd.e'] = 0;
      return;
    }
    ant.targetId = 0;
    if (distance(ant.pos, job.pos) > G.postRadius + (ant.id % 3)) {
      if (approach(sim, ant, job.cell, job.pos, G.postRadius, 1) === FAILED) finishDuty(sim, ant, t, 'nj.guard', 20);
    } else shuffle(sim, ant, dt, 'gd', 0.15, 0.25);
  },
  exit(ant) {
    fightExit(ant);
  },
};
