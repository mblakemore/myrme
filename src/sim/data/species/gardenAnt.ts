import type { SpeciesDef } from '../../../core';
import { BALANCE } from '../balance';
import { NO_CAPS, caste } from './shared';

/**
 * Black garden ant (Lasius niger) — the balanced faction; herds aphids (§2).
 *
 * Castes: worker (does everything; age decides inside vs outside work), soldier (guards and
 * patrols, hauls corpses when bored, never nurses), queen (lays, never leaves her chamber) and
 * alate (winged reproductive — placeholder for the nuptial-flight goal, B3).
 *
 * Thresholds are response thresholds per job (lower = keener); the job board multiplies them by
 * an age factor (see `systems/jobsBoard.ts`). All numbers live in `data/balance/a2b.ts` (`gardenAnt` for the
 * castes, the rest for the colony economy).
 */
const G = BALANCE.a2b.gardenAnt;

export const gardenAnt: SpeciesDef = {
  id: 'gardenAnt',
  name: 'Black garden ant',
  kind: 'ant',
  castes: {
    queen: caste('queen', 'Queen', { ...G.queen, lifespan: Infinity, canLay: true, digRate: 0, carryCapacity: 0 }),
    worker: caste('worker', 'Worker', { ...G.worker, thresholds: { ...G.worker.thresholds } }),
    soldier: caste('soldier', 'Soldier', { ...G.soldier, thresholds: { ...G.soldier.thresholds } }),
    alate: caste('alate', 'Alate', { ...G.alate, winged: true, carryCapacity: 0, digRate: 0 }),
  },
  caps: { ...NO_CAPS, herdsAphids: true },
  defaultCasteRatio: { ...G.casteRatio },
  color: [0.1, 0.085, 0.075],
  startingWorkers: G.startingWorkers,
  startingFood: G.startingFood,
};
