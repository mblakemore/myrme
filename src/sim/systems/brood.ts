import { v3, v3clone, type Brood, type CasteId, type Colony, type SimState, type SimSystem } from '../../core';
import { envState } from './weatherEnv';
import { BALANCE } from '../data/balance';
import { getCaste, getSpecies } from '../data/species';
import { alertOnce, getExt, type ColonyExt } from './colonyState';

/**
 * Brood lifecycle (§5.2).
 *
 *  - The queen lays at her feet. Interval = `layInterval` / foodFactor, foodFactor rising with the
 *    stored food per head; she stops when the stores are nearly empty, when she is starving, when
 *    the nursery is full (capacity grows with the worker count) or when ants + brood reach the
 *    population cap set by the nest volume.
 *  - Caste is fixed at laying from the colony's caste-ratio setting: the caste whose share among
 *    adults + brood is furthest below its target weight is laid next (deterministic).
 *  - egg → larva after `eggTime`; a larva must be fed `foodCost` in total by nurses and dies if it
 *    goes unfed for `larvaStarveTime`; fed and `larvaTime` old it pupates; the pupa ecloses after
 *    `pupaTime` as an adult of its caste where it lies.
 */

const _p = v3();

/** Next caste to lay: largest deficit against the caste-ratio weights. */
export function chooseCaste(sim: SimState, colony: Colony): CasteId {
  const species = getSpecies(colony.species);
  let total = 0;
  const weights: [CasteId, number][] = [];
  for (const k of Object.keys(colony.casteRatio) as CasteId[]) {
    const w = colony.casteRatio[k] ?? 0;
    if (w <= 0 || !species.castes[k] || species.castes[k]!.canLay || k === 'king') continue;
    weights.push([k, w]);
    total += w;
  }
  if (weights.length === 0 || total <= 0) return 'worker';
  const counts: Partial<Record<CasteId, number>> = {};
  let n = 0;
  for (const a of sim.ants) {
    if (a.alive && a.colony === colony.id && a.caste !== 'queen' && a.caste !== 'king') {
      counts[a.caste] = (counts[a.caste] ?? 0) + 1;
      n++;
    }
  }
  for (const b of sim.brood) {
    if (b.alive && b.colony === colony.id) {
      counts[b.caste] = (counts[b.caste] ?? 0) + 1;
      n++;
    }
  }
  let best: CasteId = weights[0][0];
  let bestDef = -Infinity;
  for (const [k, w] of weights) {
    const def = (w / total) * (n + 1) - (counts[k] ?? 0);
    if (def > bestDef) {
      bestDef = def;
      best = k;
    }
  }
  return best;
}

function lay(sim: SimState, colony: Colony, ext: ColonyExt): void {
  const B = BALANCE.a2b;
  if (sim.tick < colony.nextLayTick) return;
  const queen = colony.queenId ? sim.getAnt(colony.queenId) : undefined;
  if (!queen) return;
  const retry = (): void => {
    colony.nextLayTick = sim.tick + 30;
  };
  const pop = colony.population;
  const broodCount = pop.eggs + pop.larvae + pop.pupae;
  if (queen.falling || queen.cell < 0 || queen.energy < B.layMinEnergy || colony.stores.food < B.layMinFood) return retry();
  if (broodCount >= B.broodCapBase + B.broodCapPerWorker * ext.workers) return retry();
  if (ext.popCap > 0 && pop.total + broodCount >= ext.popCap) return retry();
  // M3: AI colonies stop growing at a difficulty-scaled size (see balance b1.rivals.popCap)
  if (colony.id !== sim.playerColony && pop.total + broodCount >= BALANCE.b1.rivals.popCap * Math.pow(Math.max(0.36, sim.director.intensity || 1), BALANCE.b1.rivals.popCapPow)) return retry();
  // food already promised to the brood in the nursery is not available for new eggs: the queen
  // only lays what the stores can raise (so larvae starve only when foraging collapses)
  // final round: while the weather keeps the foragers in, the colony lives off its stores — the
  // queen holds back so a long storm is sat out on the reserve instead of laid into the ground
  const sheltering = envState(sim).colonyState(colony.id).shelter !== 'none';
  let reserve = pop.total * B.layReservePerAnt * (sheltering ? BALANCE.b2.layReserveShelterMul : 1);
  for (const b of sim.brood) {
    if (!b.alive || b.colony !== colony.id || b.stage === 'pupa') continue;
    reserve += Math.max(0, getCaste(b.species, b.caste).foodCost - b.fed);
  }
  const spare = colony.stores.food - reserve;
  if (spare < B.layMinFood) return retry();
  const foodFactor = Math.max(0.15, Math.min(1, spare / (B.layFoodBase + B.layFoodPerAnt * pop.total)));
  colony.nextLayTick = sim.tick + Math.round((B.layInterval * 30) / foodFactor);
  colony.stores.food -= B.eggCost;
  const caste = chooseCaste(sim, colony);
  _p.x = queen.pos.x - queen.forward.x * 0.6;
  _p.y = queen.pos.y - queen.forward.y * 0.6;
  _p.z = queen.pos.z - queen.forward.z * 0.6;
  const b = sim.spawnBrood(colony.id, caste, _p);
  if (b.cell < 0) b.cell = queen.cell;
  // counted right away so the caps hold between population recounts
  pop.eggs++;
}

function setStage(sim: SimState, b: Brood, stage: 'larva' | 'pupa'): void {
  b.stage = stage;
  b.age = 0;
  b.hunger = 0;
  sim.emit({ type: 'broodStage', tick: sim.tick, id: b.id, colony: b.colony, stage, pos: v3clone(b.pos) });
}

function removeBrood(sim: SimState, b: Brood): void {
  if (b.carriedBy) {
    const carrier = sim.getAnt(b.carriedBy);
    if (carrier && carrier.carrying?.id === b.id) carrier.carrying = null;
    b.carriedBy = 0;
  }
  sim.remove(b);
}

export const broodSystem: SimSystem = {
  id: 'brood',
  update(sim) {
    const B = BALANCE.a2b;
    const eggTicks = B.eggTime * 30;
    const larvaTicks = B.larvaTime * 30;
    const pupaTicks = B.pupaTime * 30;
    const starveTicks = B.larvaStarveTime * 30;
    for (const colony of sim.colonies) {
      if (!colony.alive) continue;
      const ext = getExt(sim, colony.id);
      if (ext.active) lay(sim, colony, ext);
    }
    for (const b of sim.brood) {
      if (!b.alive) continue;
      const colony = sim.getColony(b.colony);
      if (!colony || !getExt(sim, colony.id).active) continue;
      b.age++;
      if (b.stage === 'egg') {
        if (b.age >= eggTicks) setStage(sim, b, 'larva');
      } else if (b.stage === 'larva') {
        const cost = getCaste(b.species, b.caste).foodCost;
        if (b.fed < cost) {
          b.hunger++;
          if (b.hunger > starveTicks) {
            sim.emit({ type: 'broodStage', tick: sim.tick, id: b.id, colony: b.colony, stage: 'dead', pos: v3clone(b.pos) });
            alertOnce(sim, colony, 'broodHungry', 'Larvae are starving', b.pos, b.id);
            removeBrood(sim, b);
            continue;
          }
          if (b.hunger === Math.floor(starveTicks * 0.6)) alertOnce(sim, colony, 'broodHungry', 'Larvae are going hungry', b.pos, b.id);
        } else if (b.age >= larvaTicks) setStage(sim, b, 'pupa');
      } else if (b.age >= pupaTicks) {
        sim.emit({ type: 'broodStage', tick: sim.tick, id: b.id, colony: b.colony, stage: 'adult', pos: v3clone(b.pos) });
        const pos = v3clone(b.pos);
        const caste = b.caste;
        removeBrood(sim, b);
        sim.spawnAnt(colony.id, caste, pos);
        colony.stats.born++;
      }
    }
  },
};
