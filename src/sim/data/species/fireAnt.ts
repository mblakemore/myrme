import './factionAttacks';
import type { SpeciesDef } from '../../../core';
import { BALANCE } from '../balance';
import { NO_CAPS, caste } from './shared';

/**
 * Fire ant (Solenopsis invicta) — fast, fragile, aggressive (§2).
 *
 * Twist: `rafts` — when its cells flood the colony links bodies into a floating raft carrying
 * queen and brood (systems/raft.ts). Stats: quick thin-skinned workers, cheap soldiers, every
 * caste stings (venom = damage over time, data in `BALANCE.b3.specialAttacks` for B1's status
 * effects), and even workers answer guard/patrol calls, so alarms draw a crowd.
 * All numbers live in `data/balance/b3.ts` (`fireAnt`).
 */
const F = BALANCE.b3.fireAnt;

export const fireAnt: SpeciesDef = {
  id: 'fireAnt',
  name: 'Fire ant',
  kind: 'ant',
  castes: {
    queen: caste('queen', 'Queen', { ...F.queen, attackKind: 'sting', lifespan: Infinity, canLay: true, digRate: 0, carryCapacity: 0 }),
    worker: caste('worker', 'Worker', { ...F.worker, attackKind: 'sting', thresholds: { ...F.worker.thresholds } }),
    soldier: caste('soldier', 'Soldier', { ...F.soldier, attackKind: 'sting', thresholds: { ...F.soldier.thresholds } }),
    alate: caste('alate', 'Alate', { ...F.alate, attackKind: 'sting', winged: true, carryCapacity: 0, digRate: 0 }),
  },
  caps: { ...NO_CAPS, rafts: true },
  defaultCasteRatio: { ...F.casteRatio },
  color: [0.46, 0.12, 0.05],
  startingWorkers: F.startingWorkers,
  startingFood: F.startingFood,
};
