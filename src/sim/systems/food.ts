import { v3, type Ant, type Mover, type SimState, type SimSystem } from '../../core';
import { isFoodItem } from '../behaviors/util';
import { BALANCE } from '../data/balance';
import { alertOnce, chamberAt, chamberOf, getExt, markExplored } from './colonyState';

/**
 * Food economy and upkeep:
 *  - every ant ages and burns energy; at energy 0 it loses health and dies of starvation; past
 *    its lifespan it dies of old age (corpses → necrophoresis)
 *  - trophallaxis: a well-fed ant standing next to a hungry nestmate shares part of its crop
 *    (this is how the queen and nest-bound workers get fed by returning foragers between the
 *    explicit feeding runs)
 *  - food sources regenerate / are retired when exhausted; loose food lying in the pantry is
 *    absorbed into the stores; old corpses in the midden decay
 *  - carried items and brood ride with their carrier
 *  - alerts: food low, ants starving
 * Runs for active colonies only (the wander fixture has no economy).
 */

const _near: Mover[] = [];
const _p = v3();

function upkeep(sim: SimState, ant: Ant, dt: number): void {
  const B = BALANCE.a2b;
  ant.age++;
  if (ant.age > ant.lifespan) {
    sim.killAnt(ant, 'age');
    return;
  }
  const colony = sim.getColony(ant.colony);
  let drain = dt / B.energyDuration;
  if (ant.caste === 'queen') drain *= B.queenEnergyMul;
  ant.energy -= drain;
  // the ant you are driving does not have to commute to the pantry
  if (ant.possessed && ant.energy < B.hungryEnergy && colony && colony.stores.food > 0.2) {
    const eat = Math.min(colony.stores.food, (0.8 - ant.energy) * B.foodPerEnergy);
    colony.stores.food -= eat;
    ant.energy += eat / B.foodPerEnergy;
  }
  if (ant.energy <= 0) {
    ant.energy = 0;
    ant.health -= B.starveDamage * dt;
    if (colony) alertOnce(sim, colony, 'starving', ant.caste === 'queen' ? 'The queen is starving' : 'Ants are starving', ant.pos, ant.id);
    if (ant.health <= 0) sim.killAnt(ant, 'starvation');
  }
}

function trophallaxis(sim: SimState, ant: Ant): void {
  const B = BALANCE.a2b;
  if (ant.energy >= B.trophReceiver || ant.falling) return;
  sim.spatial.queryMovers(ant.pos.x, ant.pos.y, ant.pos.z, B.trophRadius, _near);
  let donor: Ant | null = null;
  for (const m of _near) {
    if (m.kind !== 'ant' || m === ant) continue;
    const a = m as Ant;
    if (!a.alive || a.colony !== ant.colony || a.energy < B.trophDonor || a.caste === 'queen') continue;
    if (!donor || a.energy > donor.energy || (a.energy === donor.energy && a.id < donor.id)) donor = a;
  }
  if (!donor) return;
  const amt = Math.min(B.trophAmount, donor.energy - B.trophDonor + 0.1);
  donor.energy -= amt;
  ant.energy += amt;
  if (donor.anim === 'idle') donor.anim = 'feed';
  if (ant.anim === 'idle') ant.anim = 'feed';
}

export const foodSystem: SimSystem = {
  id: 'food',
  update(sim, dt) {
    const B = BALANCE.a2b;
    let anyActive = false;
    for (const colony of sim.colonies) if (getExt(sim, colony.id).active) anyActive = true;

    if (anyActive) {
      for (const ant of sim.ants) {
        if (!ant.alive || !getExt(sim, ant.colony).active) continue;
        upkeep(sim, ant, dt);
        if (ant.alive && (sim.tick + ant.id) % 30 === 0) {
          if (ant.anim === 'feed' && ant.behavior !== 'eat' && ant.behavior !== 'nurse' && ant.behavior !== 'tendQueen') ant.anim = 'idle';
          trophallaxis(sim, ant);
        }
      }
    }

    // carried things ride along (also in the fixture: possession pick-ups work there too)
    for (const it of sim.items) {
      if (!it.alive || !it.carriedBy) continue;
      const c = sim.getAnt(it.carriedBy);
      if (!c || c.carrying?.id !== it.id) {
        it.carriedBy = 0;
        it.cell = sim.nav.nearestWalkable(it.pos.x, it.pos.y, it.pos.z, 3);
        continue;
      }
      it.pos.x = c.pos.x + c.forward.x * 0.35 + c.up.x * 0.15;
      it.pos.y = c.pos.y + c.forward.y * 0.35 + c.up.y * 0.15;
      it.pos.z = c.pos.z + c.forward.z * 0.35 + c.up.z * 0.15;
      it.cell = c.cell;
    }
    for (const b of sim.brood) {
      if (!b.alive || !b.carriedBy) continue;
      const c = sim.getAnt(b.carriedBy);
      if (!c || c.carrying?.id !== b.id) {
        b.carriedBy = 0;
        b.cell = sim.nav.nearestWalkable(b.pos.x, b.pos.y, b.pos.z, 3);
        continue;
      }
      b.pos.x = c.pos.x + c.forward.x * 0.35 + c.up.x * 0.15;
      b.pos.y = c.pos.y + c.forward.y * 0.35 + c.up.y * 0.15;
      b.pos.z = c.pos.z + c.forward.z * 0.35 + c.up.z * 0.15;
      b.cell = c.cell;
    }
    // a carrier whose load vanished (eaten, eclosed, removed) has empty mandibles
    if (sim.tick % 30 === 0) {
      for (const a of sim.ants) {
        const c = a.carrying;
        if (c && c.kind !== 'bulk' && !sim.getEntity(c.id)) a.carrying = null;
      }
    }

    if (!anyActive || sim.tick % 30 !== 0) return;

    // sources: regenerate, retire when exhausted
    for (const f of sim.foodSources) {
      if (!f.alive) continue;
      if (f.regen > 0) f.amount = Math.min(f.maxAmount, f.amount + f.regen);
      else if (f.amount <= 0) {
        for (const colony of sim.colonies) {
          const ext = getExt(sim, colony.id);
          if (ext.knownSources.delete(f.id)) markExplored(ext, f.pos, B.lowYieldPenalty);
        }
        sim.remove(f);
      }
    }

    for (const colony of sim.colonies) {
      const ext = getExt(sim, colony.id);
      if (!ext.active || !colony.alive) continue;
      const pantry = chamberOf(colony, 'granary');
      const decayTicks = B.middenDecay * 30;
      for (const it of sim.items) {
        if (!it.alive || it.carriedBy || it.falling) continue;
        if (isFoodItem(it, colony.id) && chamberAt(colony, 'granary', it.pos, 0)) {
          // loose food put down in the pantry joins the stores
          colony.stores.food += it.amount;
          colony.stats.foodDelivered += it.amount;
          _p.x = it.pos.x;
          _p.y = it.pos.y;
          _p.z = it.pos.z;
          sim.emit({ type: 'foodDelivered', tick: sim.tick, colony: colony.id, by: 0, amount: it.amount, pos: { x: _p.x, y: _p.y, z: _p.z } });
          sim.remove(it);
        } else if (it.itemKind === 'corpse' && it.colony === colony.id && sim.tick - it.bornTick > decayTicks && chamberAt(colony, 'midden', it.pos, 0.5)) {
          sim.remove(it);
        }
      }
      for (const [id] of ext.knownSources) if (!sim.getEntity(id)) ext.knownSources.delete(id);
      const pop = colony.population.total;
      if (pop > 0 && colony.stores.food < B.foodLowPerAnt * pop) alertOnce(sim, colony, 'starving', 'Food stores are low', pantry.pos, 0);
    }
  },
};
