import { FZ_DRAG, FZ_EXILE, STUN_KEY, type Ant, type Behavior, type SimState, type Task } from '../../core';
import { BALANCE } from '../data/balance';
import { makeTask } from '../entities';
import { dutyTask, getExt, removeTask } from '../systems/colonyState';
import { EXILE, GROOM, addLoad, cure, exileCell, fungusCtx, hygieneTargets, markExiled } from '../systems/fungus';
import { chase } from './playerOrder';
import { ARRIVED, FAILED, approach, clearWorkAnim, dist, stop } from './util';

/**
 * Social immunity (§7). The fungus system's smell detection puts late-incubation and erratic
 * nestmates on the colony's hygiene list; this duty behavior answers it:
 *
 *   GROOM  (victim still incubating)  walk up, groom it for `groomTime` — `groomCure` chance to
 *          clean the infection out for good; a failed grooming escalates to EXILE; the groomer
 *          risks a little dusting
 *   EXILE  (victim erratic, or grooming failed)  grab it and drag it out to the colony's exile
 *          spot, far from the nest; there it is banished (`FZ_EXILE`) and never returns
 *
 * The behavior owns non-player tasks of kind `exile` (`targetId` = victim, `data` = GROOM | EXILE,
 * `phase` = progress). Its stimulus is the player's `exile` priority slider (0 = hygiene off).
 * Corpse removal is A2b's necrophoresis; the fungus system makes infected corpses smell at once
 * and lays `avoid` scent under known fruiting bodies.
 */

function pickTarget(sim: SimState, ant: Ant): number {
  const targets = hygieneTargets(sim, ant.colony);
  if (!targets || targets.size === 0) return 0;
  const claims = fungusCtx(sim).claims;
  let best = 0;
  let bestD = 16;
  for (const id of targets.keys()) {
    const by = claims.get(id);
    if (by !== undefined && by !== ant.id) continue;
    const v = sim.getAnt(id);
    if (!v) continue;
    const d = dist(v.pos, ant.pos);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function finish(sim: SimState, ant: Ant, t: Task): void {
  const ctx = fungusCtx(sim);
  if (ctx.claims.get(t.targetId) === ant.id) ctx.claims.delete(t.targetId);
  const v = sim.getAnt(t.targetId);
  if (v && v.mem[FZ_DRAG] === ant.id) v.mem[FZ_DRAG] = 0;
  removeTask(ant, t);
  clearWorkAnim(ant);
  ant.intent.mode = 'none';
  ant.thinkAt = sim.tick;
}

export const hygieneBehavior: Behavior = {
  id: 'hygiene',
  band: 'duty',
  score(ant, sim) {
    const st = ant.infection.stage;
    if (st !== 'none' && st !== 'exposed') return 0;
    const t = dutyTask(ant);
    if (t) return t.kind === 'exile' ? BALANCE.a2b.commitScore : 0;
    if (ant.carrying || ant.caste === 'queen' || ant.caste === 'king') return 0;
    if (!getExt(sim, ant.colony).active) return 0;
    const colony = sim.getColony(ant.colony);
    if (!colony) return 0;
    const p = colony.priorities.exile;
    if (!(p > 0)) return 0;
    if (pickTarget(sim, ant) === 0) return 0;
    return Math.min(1.1, BALANCE.b2.hygieneScore * p);
  },
  run(ant, sim) {
    const B = BALANCE.b2;
    const ctx = fungusCtx(sim);
    let t = dutyTask(ant);
    if (!t) {
      const id = pickTarget(sim, ant);
      if (!id) {
        stop(ant);
        return;
      }
      ctx.claims.set(id, ant.id);
      t = makeTask(sim, 'exile', 'self', { targetId: id, data: hygieneTargets(sim, ant.colony)?.get(id) ?? GROOM });
      ant.tasks.push(t);
    }
    if (t.kind !== 'exile') return;
    const victim = sim.getAnt(t.targetId);
    const vs = victim?.infection.stage;
    if (!victim || victim.mem[FZ_EXILE] || !(vs === 'incubating' || vs === 'erratic')) {
      finish(sim, ant, t);
      return;
    }
    // the list may have escalated the case while we were on the way
    if (t.data === GROOM && (vs === 'erratic' || hygieneTargets(sim, ant.colony)?.get(victim.id) === EXILE)) {
      t.data = EXILE;
      t.phase = 0;
    }

    if (t.data === GROOM) {
      const r = chase(sim, ant, victim, 1.2, 'hy.g', 1.15);
      if (r === FAILED) {
        finish(sim, ant, t);
        return;
      }
      if (r !== ARRIVED) return;
      ant.anim = 'groom';
      // the patient holds still while it is being cleaned
      if (!victim.possessed) victim.mem[STUN_KEY] = Math.max(victim.mem[STUN_KEY] ?? 0, sim.tick + 6);
      if (++t.phase < B.groomTime * 30) return;
      if (ctx.rng.chance(B.groomRisk)) addLoad(sim, ant, 0.35);
      if (ctx.rng.chance(B.groomCure)) {
        cure(sim, victim);
        finish(sim, ant, t);
      } else {
        // could not clean it: this one has to go
        ctx.targets[ant.colony]?.set(victim.id, EXILE);
        t.data = EXILE;
        t.phase = 0;
        clearWorkAnim(ant);
      }
      return;
    }

    // EXILE: phase 0 = fetch, 1 = drag out
    if (t.phase === 0) {
      const r = chase(sim, ant, victim, 1.3, 'hy.g', 1.2);
      if (r === FAILED) finish(sim, ant, t);
      else if (r === ARRIVED) {
        victim.mem[FZ_DRAG] = ant.id;
        victim.thinkAt = sim.tick;
        const colony = sim.getColony(ant.colony);
        t.cell = colony ? exileCell(sim, colony) : -1;
        t.phase = 1;
        if (t.cell < 0) {
          // nowhere to take it: banished where it stands
          markExiled(sim, victim, victim.cell);
          finish(sim, ant, t);
        }
      }
      return;
    }
    if (victim.mem[FZ_DRAG] !== ant.id) {
      t.phase = 0; // it slipped free
      return;
    }
    const gap = dist(victim.pos, ant.pos);
    if (gap > 9) {
      victim.mem[FZ_DRAG] = 0;
      t.phase = 0;
      return;
    }
    if (gap > 3.2) {
      stop(ant); // wait for it to catch up
      return;
    }
    const r = approach(sim, ant, t.cell, null, 1.6, B.dragSpeed);
    if (r === ARRIVED || r === FAILED) {
      markExiled(sim, victim, r === ARRIVED ? t.cell : victim.cell);
      finish(sim, ant, t);
    }
  },
  exit(ant, sim) {
    // interrupted (orders, danger): let go of the victim; the task stays and is resumed from the fetch
    const t = dutyTask(ant);
    if (t && t.kind === 'exile') {
      const v = sim.getAnt(t.targetId);
      if (v && v.mem[FZ_DRAG] === ant.id) v.mem[FZ_DRAG] = 0;
      if (t.data === EXILE) t.phase = 0;
    }
    clearWorkAnim(ant);
    ant.intent.mode = 'none';
  },
};
