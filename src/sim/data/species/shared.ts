import { WORKER_LENGTH, type CapabilityFlags, type CasteDef, type CasteId } from '../../../core';

export const NO_CAPS: CapabilityFlags = { canFill: false, eatsWood: false, farmsFungus: false, rafts: false, herdsAphids: false, sunSensitive: false };

/** Baseline caste stats; species files spread and override. */
export function caste(id: CasteId, name: string, over: Partial<CasteDef> = {}): CasteDef {
  return {
    id,
    name,
    length: WORKER_LENGTH,
    clearance: 0.5,
    speed: 2.4,
    maxHealth: 10,
    attack: 1,
    attackKind: 'bite',
    attackCooldown: 0.8,
    carryCapacity: 1,
    digRate: 1,
    lifespan: 900,
    foodCost: 4,
    canLay: false,
    winged: false,
    thresholds: {},
    ...over,
  };
}
