import { Phero, v3, v3clone, v3cross, v3rotateAbout, type Ant, type Brood, type FoodSource, type Item, type SimState, type SimSystem } from '../../core';
import { carryBulkFood, deliverCarriedFood, dropCarry, isFoodItem, pickUpBrood, pickUpItem } from '../behaviors/util';
import { BALANCE } from '../data/balance';
import { getCaste } from '../data/species';
import { chamberAt, getExt, hasPlayerTask } from './colonyState';
import { digDirect } from './dig';
import { orthonormalizeForward } from './movementCrawl';
import { attackStats, profileOf } from './combatCore';
import { biteCandidate, biteTarget, isHostile } from './ordersCombat';

const _right = v3();

/**
 * Possession (§5.2, D14). A possessed ant keeps its task queue untouched; the brain skips it and
 * this system turns the held `possessInput` into a movement intent on the same D11 locomotion:
 *   - `yawDelta` (> 0 = turn right) rotates `forward` about the ant's local `up`
 *   - `move` (x = strafe right, y = forward) becomes a world-space wish direction
 * Actions (edge-triggered, consumed every tick):
 *   bite     bite whatever is right in front (hostiles preferred): `attack` + `damage` events
 *   dig      carve a bite out of the surface ahead/below (same executor as the dig duty)
 *   pickup   toggle: holding something → put it down (food put down in the pantry is stored);
 *            empty → pick up the nearest item / brood / corpse / pellet, else cut a load from a
 *            food source in reach, else take a load from the pantry
 *   trail    toggle laying `trail` pheromone along the path walked (foragers follow it outbound)
 *   recruit  toggle: call nearby idle nestmates to follow (`followId`), or dismiss them
 * On release the followers are dismissed and the ant resumes its queue. If the possessed ant
 * dies: `possession` stop with reason 'died' and a `possessedDied` alert.
 */
export const possessionSystem: SimSystem = {
  id: 'possession',
  commands: ['possessStart', 'possessStop', 'possessInput'],
  onCommand(sim, cmd) {
    if (cmd.type === 'possessStart') {
      const ant = sim.getAnt(cmd.id);
      if (!ant || ant.colony !== sim.playerColony) {
        sim.emit({ type: 'possession', tick: sim.tick, id: cmd.id, op: 'stop', reason: 'invalid' });
        return;
      }
      release(sim, 'player');
      ant.possessed = true;
      ant.intent.mode = 'none';
      sim.possessedId = ant.id;
      resetInput(sim);
      sim.emit({ type: 'possession', tick: sim.tick, id: ant.id, op: 'start', reason: 'player' });
      if (ant.caste === 'queen') sim.emit({ type: 'alert', tick: sim.tick, code: 'queenInDanger', colony: ant.colony, pos: v3clone(ant.pos), id: ant.id, text: 'You are controlling the queen — keep her safe' });
    } else if (cmd.type === 'possessStop') {
      release(sim, 'player');
    } else if (cmd.type === 'possessInput') {
      const inp = sim.possessInput;
      inp.move.x = Math.max(-1, Math.min(1, cmd.move.x));
      inp.move.y = Math.max(-1, Math.min(1, cmd.move.y));
      inp.yawDelta += cmd.yawDelta;
      inp.sprint = cmd.sprint;
      inp.actions.bite ||= cmd.actions.bite;
      inp.actions.dig ||= cmd.actions.dig;
      inp.actions.pickup ||= cmd.actions.pickup;
      inp.actions.trail ||= cmd.actions.trail;
      inp.actions.recruit ||= cmd.actions.recruit;
    }
  },
  update(sim) {
    if (!sim.possessedId) return;
    const ant = sim.getAnt(sim.possessedId);
    if (!ant) {
      const id = sim.possessedId;
      sim.possessedId = 0;
      resetInput(sim);
      dismissFollowers(sim, id);
      sim.emit({ type: 'possession', tick: sim.tick, id, op: 'stop', reason: 'died' });
      sim.emit({ type: 'alert', tick: sim.tick, code: 'possessedDied', colony: sim.playerColony, pos: null, id, text: 'The ant you were controlling has died' });
      return;
    }
    const inp = sim.possessInput;
    if (inp.yawDelta !== 0) {
      v3rotateAbout(ant.forward, ant.forward, ant.up, -inp.yawDelta);
      orthonormalizeForward(ant.forward, ant.up, ant.forward.x, ant.forward.y, ant.forward.z);
      inp.yawDelta = 0;
    }
    const mx = inp.move.x;
    const my = inp.move.y;
    if (mx === 0 && my === 0) {
      ant.intent.mode = 'none';
    } else {
      v3cross(_right, ant.forward, ant.up);
      const d = ant.intent.dir;
      d.x = ant.forward.x * my + _right.x * mx;
      d.y = ant.forward.y * my + _right.y * mx;
      d.z = ant.forward.z * my + _right.z * mx;
      ant.intent.mode = 'dir';
      ant.intent.speedMul = (inp.sprint ? BALANCE.core.possessSprint : 1) * Math.min(1, Math.hypot(mx, my));
    }

    const a = inp.actions;
    if (a.bite) actBite(sim, ant);
    if (a.dig) actDig(sim, ant);
    if (a.pickup) actPickup(sim, ant);
    if (a.trail) actTrail(sim, ant);
    if (a.recruit) actRecruit(sim, ant);
    // Actions are edge-triggered: consumed every tick whether or not anything handled them.
    a.bite = a.dig = a.pickup = a.trail = a.recruit = false;

    // lay trail while the toggle is on
    if (ant.mem['p.trail'] && ant.cell >= 0 && ant.cell !== ant.mem['p.tc']) {
      ant.mem['p.tc'] = ant.cell;
      sim.pheromones.deposit(ant.colony, Phero.trail, ant.cell, BALANCE.a2b.trailLayDeposit);
    }
    // work animations time out on their own
    if ((ant.anim === 'bite' || ant.anim === 'dig') && sim.tick - (ant.mem['bite.t'] ?? 0) > 8) ant.anim = 'idle';
  },
};

type S = SimState;

function actBite(sim: S, ant: Ant): void {
  ant.anim = 'bite';
  ant.mem['bite.t'] = sim.tick;
  if (sim.tick < ant.attackReadyAt) return;
  // M3: ranged castes (the nasute's glue squirt) keep their reach when driven by the player —
  // the nearest thing in mandible range first, else a hostile out to the attack's own range
  let target = biteCandidate(sim, ant, BALANCE.a2b.possessBiteRange);
  const reach = profileOf(ant, attackStats(ant).kind).range ?? 0;
  if (reach > BALANCE.a2b.possessBiteRange && !(target && isHostile(ant, target as Ant))) {
    const far = biteCandidate(sim, ant, reach);
    if (far && isHostile(ant, far as Ant)) target = far;
  }
  if (target && (target.kind === 'ant' || target.kind === 'creature')) biteTarget(sim, ant, target as Ant);
  else ant.attackReadyAt = sim.tick + Math.round(getCaste(ant.species, ant.caste).attackCooldown * 30);
}

function actDig(sim: S, ant: Ant): void {
  if (sim.tick < (ant.mem['p.dig'] ?? 0) || ant.falling) return;
  ant.mem['p.dig'] = sim.tick + Math.round(BALANCE.a2b.possessDigCooldown * 30);
  ant.anim = 'dig';
  ant.mem['bite.t'] = sim.tick;
  // the surface just ahead of the head, a little below the feet
  const x = ant.pos.x + ant.forward.x * 1.1 - ant.up.x * 0.8;
  const y = ant.pos.y + ant.forward.y * 1.1 - ant.up.y * 0.8;
  const z = ant.pos.z + ant.forward.z * 1.1 - ant.up.z * 0.8;
  digDirect(sim, ant, v3(x, y, z));
}

function actPickup(sim: S, ant: Ant): void {
  const colony = sim.getColony(ant.colony);
  const B = BALANCE.a2b;
  if (ant.carrying) {
    const c = ant.carrying;
    const food = c.kind === 'bulk' ? c.itemKind === 'food' : false;
    if (colony && food && chamberAt(colony, 'granary', ant.pos, 0.5)) deliverCarriedFood(sim, colony, ant);
    else dropCarry(sim, ant);
    return;
  }
  const R = B.possessPickupRange;
  let best: Item | Brood | null = null;
  let bestD: number = R;
  for (const it of sim.items) {
    if (!it.alive || it.carriedBy) continue;
    const d = Math.hypot(it.pos.x - ant.pos.x, it.pos.y - ant.pos.y, it.pos.z - ant.pos.z);
    if (d < bestD) {
      bestD = d;
      best = it;
    }
  }
  for (const b of sim.brood) {
    if (!b.alive || b.carriedBy || b.colony !== ant.colony) continue;
    const d = Math.hypot(b.pos.x - ant.pos.x, b.pos.y - ant.pos.y, b.pos.z - ant.pos.z);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  const cap = Math.max(1, getCaste(ant.species, ant.caste).carryCapacity);
  if (best) {
    if (best.kind === 'brood') pickUpBrood(sim, ant, best);
    else if (isFoodItem(best, ant.colony) && best.amount > cap) {
      // too big to lift: cut a load off it
      best.amount -= cap;
      carryBulkFood(ant, cap);
      sim.emit({ type: 'itemPicked', tick: sim.tick, by: ant.id, item: best.id, pos: v3clone(ant.pos) });
    } else pickUpItem(sim, ant, best);
    return;
  }
  let src: FoodSource | null = null;
  for (const f of sim.foodSources) {
    if (!f.alive || f.amount <= 0) continue;
    const d = Math.hypot(f.pos.x - ant.pos.x, f.pos.y - ant.pos.y, f.pos.z - ant.pos.z) - f.radius;
    if (d < bestD) {
      bestD = d;
      src = f;
    }
  }
  if (src) {
    const take = Math.min(cap, src.amount);
    src.amount -= take;
    carryBulkFood(ant, take);
    sim.emit({ type: 'itemPicked', tick: sim.tick, by: ant.id, item: src.id, pos: v3clone(ant.pos) });
    if (colony) {
      const ext = getExt(sim, colony.id);
      if (!ext.knownSources.has(src.id)) {
        ext.knownSources.set(src.id, sim.tick);
        sim.emit({ type: 'foodFound', tick: sim.tick, colony: colony.id, by: ant.id, source: src.id, pos: v3clone(src.pos) });
      }
    }
    return;
  }
  if (colony && colony.stores.food > 0 && chamberAt(colony, 'granary', ant.pos, 0.5)) {
    const take = Math.min(cap, colony.stores.food);
    colony.stores.food -= take;
    carryBulkFood(ant, take, true);
  }
}

function actTrail(sim: S, ant: Ant): void {
  const on = ant.mem['p.trail'] ? 0 : 1;
  ant.mem['p.trail'] = on;
  ant.mem['p.tc'] = -1;
  if (on) sim.emit({ type: 'pheromoneBurst', tick: sim.tick, colony: ant.colony, channel: Phero.trail, pos: v3clone(ant.pos) });
}

function dismissFollowers(sim: S, leaderId: number): number {
  let n = 0;
  for (const a of sim.ants) {
    if (a.followId === leaderId) {
      a.followId = 0;
      a.thinkAt = sim.tick;
      n++;
    }
  }
  return n;
}

function actRecruit(sim: S, ant: Ant): void {
  if (dismissFollowers(sim, ant.id) > 0) return;
  const B = BALANCE.a2b;
  const cands: { a: Ant; d: number }[] = [];
  for (const a of sim.ants) {
    if (!a.alive || a === ant || a.colony !== ant.colony || a.caste === 'queen' || a.caste === 'king') continue;
    if (a.followId || a.mem['exiled'] || hasPlayerTask(a) || a.carrying) continue;
    const d = Math.hypot(a.pos.x - ant.pos.x, a.pos.y - ant.pos.y, a.pos.z - ant.pos.z);
    if (d <= B.recruitRadius) cands.push({ a, d });
  }
  cands.sort((x, y) => x.d - y.d || x.a.id - y.a.id);
  for (let i = 0; i < cands.length && i < B.recruitMax; i++) {
    cands[i].a.followId = ant.id;
    cands[i].a.thinkAt = sim.tick;
  }
  sim.emit({ type: 'pheromoneBurst', tick: sim.tick, colony: ant.colony, channel: Phero.rally, pos: v3clone(ant.pos) });
}

function resetInput(sim: S): void {
  const inp = sim.possessInput;
  inp.move.x = inp.move.y = 0;
  inp.yawDelta = 0;
  inp.sprint = false;
  const a = inp.actions;
  a.bite = a.dig = a.pickup = a.trail = a.recruit = false;
}

function release(sim: S, reason: 'player' | 'died'): void {
  if (!sim.possessedId) return;
  const ant = sim.getAnt(sim.possessedId);
  const id = sim.possessedId;
  sim.possessedId = 0;
  resetInput(sim);
  dismissFollowers(sim, id);
  if (ant) {
    ant.possessed = false;
    ant.intent.mode = 'none';
    ant.path.status = 'none';
    ant.mem['p.trail'] = 0;
    if (ant.anim === 'bite' || ant.anim === 'dig') ant.anim = 'idle';
    ant.thinkAt = sim.tick; // resume the queue right away
  }
  sim.emit({ type: 'possession', tick: sim.tick, id, op: 'stop', reason });
}
