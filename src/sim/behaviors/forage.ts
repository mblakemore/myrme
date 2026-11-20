import { inDangerZone } from '../systems/colonyState';
import { hash01, v3clone, type Behavior } from '../../core';
import { underWater } from './forageCore';
import { BALANCE } from '../data/balance';
import { makeTask } from '../entities';
import { dutyTask, getExt, removeTask } from '../systems/colonyState';
import { isBlocked, response, updateForageDemand } from '../systems/jobsBoard';
import { forageExit, runForage } from './forageCore';

/**
 * Foraging duty (§1 pillar 2): scouts explore, find food, carry loads home laying a `food`
 * trail; recruits follow the trail. The state machine lives in `forageCore.ts`; this behavior
 * owns the ant's `gather` duty task (source 'self').
 */
export const forageBehavior: Behavior = {
  id: 'forage',
  band: 'duty',
  score(ant, sim) {
    const t = dutyTask(ant);
    if (t) return t.kind === 'gather' ? BALANCE.a2b.commitScore : 0;
    if (ant.carrying || isBlocked(ant, sim, 'nj.forage')) return 0;
    return response(sim, ant, 'forage');
  },
  run(ant, sim, dt) {
    let t = dutyTask(ant);
    if (!t) {
      t = makeTask(sim, 'gather', 'self');
      ant.tasks.push(t);
      ant.mem['f.t0'] = sim.tick;
      const colony = sim.getColony(ant.colony);
      if (colony) {
        const ext = getExt(sim, colony.id);
        ext.foragers++;
        updateForageDemand(colony, ext);
        // recruitment inside the nest: returning foragers tell some nestmates where the food is
        // (the rest go by the trail, or scout)
        // an experienced forager goes back to her own source while it lasts
        const own = ant.mem['f.src'] ? sim.getEntity(ant.mem['f.src']) : undefined;
        if (own && (own.kind === 'food' || own.kind === 'item') && own.amount > 0 && !underWater(sim, own) && !inDangerZone(sim, ant.colony, own.pos)) {
          t.targetId = own.id;
          t.pos = v3clone(own.pos);
          t.cell = own.cell;
        } else if (ext.knownSources.size > 0 && hash01(ant.id, sim.tick, 5) < BALANCE.a2b.recruitKnownChance) {
          let best = 0;
          let bestD = Infinity;
          for (const id of ext.knownSources.keys()) {
            const f = sim.getEntity(id);
            if (!f || (f.kind !== 'food' && f.kind !== 'item') || f.amount < 4 || underWater(sim, f) || inDangerZone(sim, ant.colony, f.pos)) continue;
            const d = Math.hypot(f.pos.x - colony.nestPos.x, f.pos.y - colony.nestPos.y, f.pos.z - colony.nestPos.z) * (0.75 + 0.5 * hash01(ant.id, id, 6));
            if (d < bestD) {
              bestD = d;
              best = id;
            }
          }
          const f = best ? sim.getEntity(best) : undefined;
          if (f) {
            t.targetId = f.id;
            t.pos = v3clone(f.pos);
            t.cell = f.cell;
          }
        }
      }
    }
    if (t.kind !== 'gather') return;
    if (runForage(sim, ant, t, dt, false)) {
      removeTask(ant, t);
      forageExit(ant);
      ant.thinkAt = sim.tick;
    }
  },
  exit: forageExit,
};
