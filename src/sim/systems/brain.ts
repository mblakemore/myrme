import { BEHAVIOR_BANDS, hash01, type Ant, type Behavior, type BehaviorBand, type SimState, type SimSystem } from '../../core';
import { BEHAVIORS } from '../behaviors';
import { BALANCE } from '../data/balance';
import { removeTask } from './colonyState';
import { releaseJob } from './jobsBoard';
import type { PathStateEx } from './movement';

/** Behaviors the watchdog leaves alone: scripted end states and group moves with their own clocks. */
const WATCHDOG_EXEMPT: Readonly<Record<string, 1>> = { infected: 1, raft: 1, nuptial: 1, queen: 1 };

/**
 * Brain watchdog (safety net, checked at think time): an ant that keeps TRYING to go somewhere
 * (a goto, or a brisk directed walk — not a resting shuffle) without getting anywhere and without
 * its behavior / task / phase changing is wedged on something no behavior noticed.
 *   after `watchdogSeconds`      re-plan: drop the path, home by A* for a while, think afresh
 *   after twice that             give the front task up (its job reservation goes back to the
 *                                board; a dead player order is dropped) and think afresh
 * Progress (moving > 1.5 voxels from the anchor, or any change of behavior/task/phase/load)
 * resets the clock.
 */
function watchdog(ant: Ant, sim: SimState, current: Behavior | undefined, behaviorKey: (b: Behavior | undefined) => number): boolean {
  const mem = ant.mem;
  const t = ant.tasks[0];
  const sig = (t ? t.id * 16 + t.phase : 0) * 4 + (ant.carrying ? 1 + (ant.carrying.kind === 'brood' ? 1 : 0) : 0);
  const it = ant.intent;
  const trying = !ant.falling && (it.mode === 'goto' || (it.mode === 'dir' && it.speedMul > 0.5));
  const dx = ant.pos.x - (mem['wd.x'] ?? 1e9);
  const dy = ant.pos.y - (mem['wd.y'] ?? 1e9);
  const dz = ant.pos.z - (mem['wd.z'] ?? 1e9);
  if (!trying || !current || WATCHDOG_EXEMPT[current.id] || ant.caste === 'queen' || ant.caste === 'king' || mem['wd.s'] !== sig || mem['wd.b'] !== behaviorKey(current) || dx * dx + dy * dy + dz * dz > 2.25) {
    mem['wd.x'] = ant.pos.x;
    mem['wd.y'] = ant.pos.y;
    mem['wd.z'] = ant.pos.z;
    mem['wd.s'] = sig;
    mem['wd.b'] = behaviorKey(current);
    mem['wd.t'] = sim.tick;
    mem['wd.n'] = 0;
    return false;
  }
  const limit = BALANCE.a2b.watchdogSeconds * 30;
  if (sim.tick - (mem['wd.t'] ?? sim.tick) < limit) return false;
  mem['wd.t'] = sim.tick;
  const stage = (mem['wd.n'] ?? 0) + 1;
  mem['wd.n'] = stage;
  // stage 1: re-plan from scratch
  const p = ant.path as PathStateEx;
  if (p.ticket) sim.nav.cancelPath(p.ticket);
  p.ticket = 0;
  p.cells = null;
  p.status = 'none';
  p.replans = 0;
  p.partials = 0;
  mem['hm.no'] = sim.tick + 240;
  mem['hm.a'] = -1;
  if (stage >= 2 && t) {
    // stage 2: this task is not going to happen from here
    if (t.jobId) releaseJob(sim, ant, t.jobId);
    removeTask(ant, t);
    mem['wd.n'] = 0;
  }
  mem['wd.c'] = (mem['wd.c'] ?? 0) + 1; // diagnostics: how often the watchdog had to step in
  return true;
}

/**
 * The brain (§5.2).
 *
 * THINK (staggered: each ant every 0.2–0.5 s, phase from a stateless hash of id and tick, so it
 * is deterministic and independent of every other random stream):
 *   bands are tried strongest first — forced > player > survival > duty > idle — and the first
 *   band in which any behavior scores > 0 wins outright; inside it the top scorer is chosen.
 *   Hysteresis: the behavior that is already running has its score multiplied by `hysteresisMul`
 *   and raised by `hysteresisAdd`, so near-ties do not make ants dither; a challenger must beat
 *   it clearly (or come from a stronger band, which always pre-empts).
 * RUN: the chosen behavior's `run` is called every tick until the next think. When the choice
 *   changes the old behavior's `exit` is called first.
 * Behaviors are small state machines over the ant's task queue (conventions: contracts/a2b.ts).
 * Possessed ants are skipped entirely — queue, behavior id and reservations stay as they were,
 * so on release the ant resumes exactly where it was.
 *
 * Contract for other streams' behaviors (B waves): `score` must be cheap and side-effect free;
 * return ≤ 0 when not applicable. A2b duty behaviors score `commitScore` (1.2) while they hold a
 * duty task and ≤ 1 when merely proposing one; survival/forced behaviors pre-empt by band.
 */
export interface Brain {
  readonly system: SimSystem;
  /** The selection rule on its own (tests, debug overlays): what would this ant pick right now? */
  choose(ant: Ant, sim: SimState): Behavior | null;
}

export function createBrain(behaviors: readonly Behavior[]): Brain {
  const byBand: Record<BehaviorBand, Behavior[]> = { forced: [], player: [], survival: [], duty: [], idle: [] };
  const byId = new Map<string, Behavior>();
  const keys = new Map<string, number>();
  for (const b of behaviors) {
    byBand[b.band].push(b);
    byId.set(b.id, b);
    keys.set(b.id, keys.size + 1);
  }
  const behaviorKey = (b: Behavior | undefined): number => (b ? (keys.get(b.id) ?? 0) : 0);

  function choose(ant: Ant, sim: SimState): Behavior | null {
    const mul = BALANCE.a2b.hysteresisMul;
    const add = BALANCE.a2b.hysteresisAdd;
    for (const band of BEHAVIOR_BANDS) {
      let best: Behavior | null = null;
      let bestScore = 0;
      const list = byBand[band];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        let s = b.score(ant, sim);
        if (!(s > 0)) continue;
        if (b.id === ant.behavior) s = s * mul + add;
        if (s > bestScore) {
          bestScore = s;
          best = b;
        }
      }
      if (best) return best;
    }
    return null;
  }

  const system: SimSystem = {
    id: 'brain',
    update(sim, dt) {
      const min = BALANCE.core.thinkMinTicks;
      const span = BALANCE.core.thinkMaxTicks - min + 1;
      const ants = sim.ants;
      for (let i = 0; i < ants.length; i++) {
        const ant = ants[i];
        if (!ant.alive || ant.possessed) continue;
        let current = byId.get(ant.behavior);
        if (sim.tick >= ant.thinkAt && watchdog(ant, sim, current, behaviorKey)) {
          current?.exit?.(ant, sim);
          ant.intent.mode = 'none';
          current = undefined;
          ant.behavior = '';
        }
        if (sim.tick >= ant.thinkAt || !current) {
          const next = choose(ant, sim);
          ant.thinkAt = sim.tick + min + Math.floor(hash01(ant.id, sim.tick, 77) * span);
          if (next !== current) {
            current?.exit?.(ant, sim);
            current = next ?? undefined;
            ant.behavior = next ? next.id : '';
          }
        }
        if (current) current.run(ant, sim, dt);
        else ant.intent.mode = 'none';
      }
    },
  };
  return { system, choose };
}

const brain = createBrain(BEHAVIORS);

/** Registered brain over the behavior registry. */
export const brainSystem: SimSystem = brain.system;
export const chooseBehavior = brain.choose;
