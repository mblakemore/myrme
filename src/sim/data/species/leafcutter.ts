import './factionAttacks';
import type { SpeciesDef } from '../../../core';
import { BALANCE } from '../balance';
import { NO_CAPS, caste } from './shared';

/**
 * Leafcutter ant (Atta) — leaves → fungus garden → food (§2).
 *
 * Twist: `farmsFungus` — the colony cannot eat forage. Media workers cut leaf fragments and
 * carry them home (behaviors/harvestLeaves.ts), minims bed them into the fungus garden, weed it
 * and harvest the fungus (behaviors/tendGarden.ts, systems/fungusGarden.ts); the harvested
 * fungus is the only thing that fills `stores.food`.
 *
 * Caste ids are the ones A4 has geometry for: `worker` = minim (tiny gardener / nurse),
 * `major` = media (cutter / carrier), `soldier` = major (huge-headed defender), plus queen and
 * alate. Nobody has a `forage` / `haulFood` threshold. Numbers: `data/balance/b3.ts`.
 */
const L = BALANCE.b3.leafcutter;

export const leafcutter: SpeciesDef = {
  id: 'leafcutter',
  name: 'Leafcutter ant',
  kind: 'ant',
  castes: {
    queen: caste('queen', 'Queen', { ...L.queen, lifespan: Infinity, canLay: true, digRate: 0, carryCapacity: 0 }),
    worker: caste('worker', 'Minim', { ...L.worker, thresholds: { ...L.worker.thresholds } }),
    major: caste('major', 'Media', { ...L.major, thresholds: { ...L.major.thresholds } }),
    soldier: caste('soldier', 'Major', { ...L.soldier, thresholds: { ...L.soldier.thresholds } }),
    alate: caste('alate', 'Alate', { ...L.alate, winged: true, carryCapacity: 0, digRate: 0 }),
  },
  caps: { ...NO_CAPS, farmsFungus: true },
  defaultCasteRatio: { ...L.casteRatio },
  color: [0.5, 0.22, 0.08],
  startingWorkers: L.startingWorkers,
  startingFood: L.startingFood,
};
