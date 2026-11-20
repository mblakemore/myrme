import type { Ant, Behavior, Brood, SimState } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { CALL_MEM, boardingRaft } from '../systems/raft';
import { FAILED, approach, pickUpBrood, steerTo } from './util';

/**
 * Raft (band `survival`, above everything but forced states).
 *
 *  member   an ant linked into a raft (`mem['raft']` ≠ 0, set by systems/raft.ts) holds perfectly
 *           still — the raft system seats it on the water every tick. Releasing is the system's
 *           job (landing / dissolving).
 *  call     final round: while the colony has a raft afloat, nestmates within `callRadius` make
 *           for it — the queen and the other royals first of all, workers picking up a piece of
 *           brood on the way if one lies close — and are taken aboard by the raft system when
 *           they reach the water's edge beside it (`mem[CALL_MEM]` = raft id). This is what
 *           turns four linked swimmers into a real raft carrying queen and brood.
 */

const BLOCK = 'raft.no';

function called(sim: SimState, ant: Ant): boolean {
  if (!getSpecies(ant.species).caps.rafts || ant.cell < 0 || ant.falling) return false;
  if ((ant.mem[BLOCK] ?? 0) > sim.tick || ant.mem['raid'] || ant.mem['exiled']) return false;
  const st = ant.infection.stage;
  if (st !== 'none' && st !== 'exposed' && st !== 'incubating') return false;
  if (ant.carrying && ant.carrying.kind !== 'brood') return false;
  const raft = boardingRaft(sim, ant.colony);
  if (!raft) return false;
  const R = BALANCE.b3.rafts;
  if (Math.abs(ant.pos.y - raft.pos.y) > 8) return false;
  return Math.hypot(ant.pos.x - raft.pos.x, ant.pos.y - raft.pos.y, ant.pos.z - raft.pos.z) <= R.callRadius;
}

/** Loose brood of the colony within `r` of the ant. */
function broodNear(sim: SimState, ant: Ant, r: number): Brood | null {
  let best: Brood | null = null;
  let bd = r;
  for (const b of sim.brood) {
    if (!b.alive || b.colony !== ant.colony || b.carriedBy) continue;
    const d = Math.hypot(b.pos.x - ant.pos.x, b.pos.y - ant.pos.y, b.pos.z - ant.pos.z);
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}

export const raftBehavior: Behavior = {
  id: 'raft',
  band: 'survival',
  score(ant, sim) {
    if (ant.mem['raft']) return 20;
    return called(sim, ant) ? 3 : 0;
  },
  run(ant, sim) {
    if (ant.mem['raft']) {
      ant.intent.mode = 'none';
      ant.path.status = 'none';
      ant.anim = 'raft';
      return;
    }
    const raft = boardingRaft(sim, ant.colony);
    if (!raft) {
      ant.mem[CALL_MEM] = 0;
      ant.thinkAt = sim.tick;
      return;
    }
    ant.mem[CALL_MEM] = raft.id;
    // a worker with empty mandibles takes a piece of brood along if one lies within reach
    if (!ant.carrying && ant.caste === 'worker' && (sim.tick + ant.id) % 15 === 0) {
      const b = broodNear(sim, ant, 1.6);
      if (b) pickUpBrood(sim, ant, b);
    }
    const dh = Math.hypot(ant.pos.x - raft.pos.x, ant.pos.z - raft.pos.z);
    if (dh < raft.radius + 3 && Math.abs(ant.pos.y - raft.pos.y) < 2.5) {
      // at the water's edge: wade straight in, the raft takes it from here
      steerTo(ant, raft.pos, 1.1);
      return;
    }
    const cell = sim.nav.nearestWalkable(raft.pos.x, raft.pos.y + 0.5, raft.pos.z, 4);
    if (cell < 0 || approach(sim, ant, cell, raft.pos, raft.radius + 1, 1.2) === FAILED) {
      ant.mem[BLOCK] = sim.tick + 240;
      ant.mem[CALL_MEM] = 0;
      ant.thinkAt = sim.tick;
    }
  },
  exit(ant) {
    if (!ant.mem['raft']) {
      ant.mem[CALL_MEM] = 0;
      if (ant.anim === 'raft') ant.anim = 'idle';
    }
  },
};
