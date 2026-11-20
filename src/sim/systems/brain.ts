import { BEHAVIOR_BANDS, hash01, type Ant, type Behavior, type BehaviorBand, type SimState, type SimSystem } from '../../core';
import { BEHAVIORS } from '../behaviors';
import { BALANCE } from '../data/balance';

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
  for (const b of behaviors) {
    byBand[b.band].push(b);
    byId.set(b.id, b);
  }

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
