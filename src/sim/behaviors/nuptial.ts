import { asSimEvent, v3, v3clone, type Behavior } from '../../core';
import { BALANCE } from '../data/balance';
import { alateDeparted, nuptialOf } from '../systems/goals';
import { approach, dist, pileCell, shuffle, stop } from './util';

/**
 * Nuptial flight, the alate's side (colony state machine: systems/goals.ts).
 *
 *   gather    walk out to the assembly point at the nest entrance and mill about there, each
 *             alate on its own spot (`mem['nf.at']` = 1 once arrived)
 *   takeoff   at its staggered take-off tick the alate switches to `fly` locomotion and spirals
 *             up and away from the nest; once it clears the top of the world (or after
 *             `flightTime`) it is gone — counted as launched and removed without a corpse
 *
 * Band `survival` with a high score: nothing short of the `forced` band interrupts the flight.
 * Outside a flight alates never score here (they idle in the nest).
 */
const _d = v3();

export const nuptialBehavior: Behavior = {
  id: 'nuptial',
  band: 'survival',
  score(ant, sim) {
    if (ant.caste !== 'alate') return 0;
    const n = nuptialOf(sim, ant.colony);
    if (!n) return 0;
    if (n.phase === 'gather' || n.phase === 'takeoff') return 10;
    // already airborne when the colony state moved on: finish the flight
    return ant.locomotion === 'fly' ? 10 : 0;
  },
  run(ant, sim, dt) {
    const G = BALANCE.b3.goals;
    const n = nuptialOf(sim, ant.colony);
    const colony = sim.getColony(ant.colony);
    if (!n || !colony) return;
    const mem = ant.mem;

    if (ant.locomotion === 'fly') {
      // spiral up and outward from the nest
      const t0 = mem['nf.t0'] ?? sim.tick;
      const age = (sim.tick - t0) / 30;
      const a = ant.phase * 6.2832 + age * 0.9;
      const c = n.gatherPos ?? colony.nestPos;
      let ox = ant.pos.x - c.x;
      let oz = ant.pos.z - c.z;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      _d.x = Math.cos(a) * 0.55 + ox * 0.35;
      _d.y = 0.9;
      _d.z = Math.sin(a) * 0.55 + oz * 0.35;
      const it = ant.intent;
      it.mode = 'dir';
      it.dir.x = _d.x;
      it.dir.y = _d.y;
      it.dir.z = _d.z;
      it.speedMul = G.flySpeed;
      ant.anim = 'fly';
      const w = sim.world;
      if (age > G.flightTime || ant.pos.y > w.sy - 1.5 || ant.pos.x < 1 || ant.pos.z < 1 || ant.pos.x > w.sx - 1 || ant.pos.z > w.sz - 1) alateDeparted(sim, ant);
      return;
    }

    if (n.phase === 'takeoff') {
      const go = mem['nf.go'] ?? 0;
      if (go > 0 && sim.tick >= go) {
        ant.locomotion = 'fly';
        ant.falling = false;
        ant.tasks.length = 0;
        ant.carrying = null;
        ant.path.status = 'none';
        mem['nf.t0'] = sim.tick;
        // hop clear of the ground so the flyer does not count as perched
        ant.pos.x += ant.up.x * 1.2;
        ant.pos.y += ant.up.y * 1.2 + 0.4;
        ant.pos.z += ant.up.z * 1.2;
        ant.intent.mode = 'dir';
        ant.intent.dir.x = 0;
        ant.intent.dir.y = 1;
        ant.intent.dir.z = 0;
        ant.anim = 'fly';
        sim.emit(asSimEvent({ type: 'alateTakeoff', tick: sim.tick, id: ant.id, colony: ant.colony, pos: v3clone(ant.pos) }));
        return;
      }
      // waiting for its slot: flutter on the spot
      shuffle(sim, ant, dt, 'nf', 0.5, 0.3);
      return;
    }

    // gather
    if (n.gatherCell < 0 || !n.gatherPos) {
      stop(ant);
      mem['nf.at'] = 1;
      return;
    }
    let spot = mem['nf.spot'] ?? -1;
    if (spot < 0 || !sim.nav.isWalkable(spot)) {
      spot = pileCell(sim, n.gatherPos, 3.5, ant.id);
      if (spot < 0) spot = n.gatherCell;
      mem['nf.spot'] = spot;
    }
    if (mem['nf.at'] && dist(ant.pos, n.gatherPos) < 7) {
      shuffle(sim, ant, dt, 'nf', 0.5, 0.3);
      return;
    }
    const r = approach(sim, ant, spot, null, 1.2);
    if (r !== 0 || dist(ant.pos, n.gatherPos) < 4.5) mem['nf.at'] = 1; // arrived (or as close as it gets)
  },
  exit(ant) {
    ant.mem['nf.spot'] = -1;
  },
};
