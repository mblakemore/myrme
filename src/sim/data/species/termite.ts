import './factionAttacks';
import type { SpeciesDef } from '../../../core';
import { BALANCE } from '../balance';
import { NO_CAPS, caste } from './shared';

/**
 * Termite (a Nasutitermes / Macrotermes blend) — the playable non-ant (§2).
 *
 * Twists: `eatsWood` (workers tunnel into Wood / LeafLitter voxels; the pulp is digested into
 * food — nobody forages), `canFill` (mud shelter tubes, breach plugs, a mound, and the player's
 * build designations — systems/termiteBuild.ts, behaviors/build.ts), `sunSensitive` (exposed
 * termites desiccate in daylight — behaviors/seekShade.ts), and a royal pair: king AND
 * physogastric queen must both live (systems/goals.ts). Soft-bodied workers; mandibulate
 * soldiers hold tunnels; nasutes spray glue at range (`BALANCE.b3.specialAttacks`).
 * Numbers: `data/balance/b3.ts` (`termite`, `termites`).
 */
const T = BALANCE.b3.termite;

export const termite: SpeciesDef = {
  id: 'termite',
  name: 'Termite',
  kind: 'termite',
  castes: {
    queen: caste('queen', 'Queen', { ...T.queen, lifespan: Infinity, canLay: true, digRate: 0, carryCapacity: 0 }),
    king: caste('king', 'King', { ...T.king, lifespan: Infinity, digRate: 0, carryCapacity: 0 }),
    worker: caste('worker', 'Worker', { ...T.worker, thresholds: { ...T.worker.thresholds } }),
    soldier: caste('soldier', 'Soldier', { ...T.soldier, thresholds: { ...T.soldier.thresholds } }),
    nasute: caste('nasute', 'Nasute', { ...T.nasute, attackKind: 'glue', thresholds: { ...T.nasute.thresholds } }),
    alate: caste('alate', 'Alate', { ...T.alate, winged: true, carryCapacity: 0, digRate: 0 }),
  },
  caps: { ...NO_CAPS, canFill: true, eatsWood: true, sunSensitive: true },
  defaultCasteRatio: { ...T.casteRatio },
  color: [0.78, 0.66, 0.48],
  startingWorkers: T.startingWorkers,
  startingFood: T.startingFood,
};
