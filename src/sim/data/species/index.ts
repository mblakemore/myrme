import type { CasteDef, CasteId, SpeciesDef, SpeciesId } from '../../../core';
import { fireAnt } from './fireAnt';
import { gardenAnt } from './gardenAnt';
import { leafcutter } from './leafcutter';
import { termite } from './termite';

/** Species registry (§5.1): explicit list, pre-populated by M0. */
export const SPECIES: Readonly<Record<SpeciesId, SpeciesDef>> = { gardenAnt, fireAnt, leafcutter, termite };

export function getSpecies(id: SpeciesId): SpeciesDef {
  return SPECIES[id];
}

/** Caste def with a fallback to the species' worker (every species defines `worker`). */
export function getCaste(species: SpeciesId, caste: CasteId): CasteDef {
  const s = SPECIES[species];
  return (s.castes[caste] ?? s.castes.worker) as CasteDef;
}
