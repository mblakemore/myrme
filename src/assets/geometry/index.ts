import type * as THREE from 'three';
import { SPECIES_IDS, type BroodGeometryKind, type CasteId, type CreatureGeometryKind, type CreatureId, type CreatureLook, type CreatureRig, type GeometryLod, type ItemGeometryKind, type SpeciesId } from '../../core';
import { antLook, antParams, buildAnt, buildFirstPersonRig } from './ant';
import { buildCreature, CREATURE_LOOKS } from './creatures';
import { BROOD_LOOKS, buildBrood, buildItem } from './props';

/**
 * Creature geometry registry (A4). `getCreatureGeometry(kind, lod)` builds lazily and caches;
 * the returned BufferGeometry is shared — do NOT add instanced attributes to it or dispose it
 * (use `createInstancedCreature` in `render/modules/antsMaterial.ts`, which wraps it).
 *
 * Kinds: `"<species>:<caste>"` · CreatureId · 'egg' | 'larva' | 'pupa' · item kinds.
 * Conventions and the vertex attribute layout are documented in `core/contracts/a4.ts`.
 */

export const CREATURE_IDS: readonly CreatureId[] = ['jumpingSpider', 'antlion', 'groundBeetle', 'wasp', 'mantis', 'aphid', 'caterpillar', 'worm'];
export const BROOD_KINDS: readonly BroodGeometryKind[] = ['egg', 'larva', 'pupa'];
export const ITEM_KINDS: readonly ItemGeometryKind[] = ['crumb', 'seed', 'leaf', 'pellet', 'woodChip', 'honeydew', 'fungusTuft', 'fruit', 'sugar', 'corpse'];
/** Castes each species is modelled with (others fall back to the worker). */
export const SPECIES_CASTES: Readonly<Record<SpeciesId, readonly CasteId[]>> = {
  gardenAnt: ['worker', 'soldier', 'queen', 'alate'],
  fireAnt: ['worker', 'soldier', 'queen', 'alate'],
  leafcutter: ['worker', 'major', 'soldier', 'queen', 'alate'],
  termite: ['worker', 'soldier', 'nasute', 'queen', 'king', 'alate'],
};

const cache = new Map<string, THREE.BufferGeometry>();

function isSpecies(s: string): s is SpeciesId {
  return (SPECIES_IDS as readonly string[]).includes(s);
}

function splitAnt(kind: string): [SpeciesId, CasteId] | null {
  if (kind.startsWith('fp:')) kind = kind.slice(3);
  const i = kind.indexOf(':');
  if (i < 0) return null;
  const sp = kind.slice(0, i);
  if (!isSpecies(sp)) return null;
  const caste = kind.slice(i + 1) as CasteId;
  return [sp, SPECIES_CASTES[sp].includes(caste) ? caste : 'worker'];
}

export function getCreatureGeometry(kind: CreatureGeometryKind, lod: GeometryLod): THREE.BufferGeometry {
  const key = `${kind}|${lod}`;
  let g = cache.get(key);
  if (g) return g;
  const ant = splitAnt(kind);
  if (ant && kind.startsWith('fp:')) g = buildFirstPersonRig(antParams(ant[0], ant[1]));
  else if (ant) g = buildAnt(antParams(ant[0], ant[1]), lod);
  else if (kind === 'corpse') g = getCreatureGeometry('gardenAnt:worker', lod === 0 ? 1 : lod);
  else if ((CREATURE_IDS as readonly string[]).includes(kind)) g = buildCreature(kind as CreatureId, lod);
  else if ((BROOD_KINDS as readonly string[]).includes(kind)) g = buildBrood(kind as BroodGeometryKind, lod);
  else g = buildItem(kind as Exclude<ItemGeometryKind, 'corpse'>, lod);
  g.name = key;
  cache.set(key, g);
  return g;
}

export function getCreatureRig(kind: CreatureGeometryKind, lod: GeometryLod): CreatureRig {
  return getCreatureGeometry(kind, lod).userData.rig as CreatureRig;
}

const ITEM_LOOK: CreatureLook = {
  color: [0.6, 0.5, 0.35],
  roughness: 0.75,
  clearcoat: 0,
  iridescence: 0,
  translucency: 0,
  translucencyColor: [1, 0.8, 0.5],
  translucencyAll: true,
  wax: 0,
  sheen: 0,
  bands: 0,
  sting: 0,
};

const ITEM_LOOKS: Record<ItemGeometryKind, CreatureLook> = {
  crumb: { ...ITEM_LOOK, color: [0.72, 0.56, 0.3], roughness: 0.9, translucency: 0.2, wax: 0.5 },
  seed: { ...ITEM_LOOK, color: [0.34, 0.2, 0.09], roughness: 0.45, clearcoat: 0.4 },
  leaf: { ...ITEM_LOOK, color: [0.15, 0.36, 0.06], roughness: 0.5, clearcoat: 0.3, translucency: 0.85, translucencyColor: [0.6, 1, 0.16], wax: 0.3, leaf: 1 },
  pellet: { ...ITEM_LOOK, color: [0.3, 0.2, 0.12], roughness: 0.95 },
  woodChip: { ...ITEM_LOOK, color: [0.5, 0.34, 0.18], roughness: 0.9 },
  honeydew: { ...ITEM_LOOK, color: [1.0, 0.72, 0.2], roughness: 0.05, clearcoat: 1, translucency: 1, translucencyColor: [1, 0.75, 0.2], wax: 1 },
  fungusTuft: { ...ITEM_LOOK, color: [0.86, 0.86, 0.78], roughness: 0.7, translucency: 0.5, wax: 1, sheen: 1 },
  fruit: { ...ITEM_LOOK, color: [0.8, 0.16, 0.12], roughness: 0.3, clearcoat: 0.7, translucency: 0.6, translucencyColor: [1, 0.3, 0.2], wax: 0.8 },
  sugar: { ...ITEM_LOOK, color: [0.95, 0.95, 0.92], roughness: 0.12, clearcoat: 1, translucency: 0.8, translucencyColor: [1, 1, 1], wax: 1, iridescence: 0.3 },
  corpse: antLook('gardenAnt', 'worker'),
};

export function getCreatureLook(kind: CreatureGeometryKind): CreatureLook {
  const ant = splitAnt(kind);
  if (ant) return antLook(ant[0], ant[1]);
  if (kind in CREATURE_LOOKS) return CREATURE_LOOKS[kind as CreatureId];
  if (kind in BROOD_LOOKS) return BROOD_LOOKS[kind as BroodGeometryKind];
  return ITEM_LOOKS[kind as ItemGeometryKind];
}

/** All ant kinds, for galleries and warm-up. */
export function allAntKinds(): CreatureGeometryKind[] {
  const out: CreatureGeometryKind[] = [];
  for (const sp of SPECIES_IDS) for (const c of SPECIES_CASTES[sp]) out.push(`${sp}:${c}`);
  return out;
}

export type { CreatureGeometryKind, CreatureLook, CreatureRig, GeometryLod } from '../../core';
