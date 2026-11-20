import { Mat, type MaterialDef, type MaterialId } from './contracts';

/** D5 material table, indexed by MaterialId. */
export const MATERIALS: readonly MaterialDef[] = [
  { id: Mat.Air, name: 'Air', digCost: 0, edibleByAnts: false, edibleByTermites: false, nutrition: 0, color: [0, 0, 0] },
  { id: Mat.Soil, name: 'Soil', digCost: 1, edibleByAnts: false, edibleByTermites: false, nutrition: 0, color: [0.52, 0.38, 0.26] },
  { id: Mat.Sand, name: 'Sand', digCost: 0.7, edibleByAnts: false, edibleByTermites: false, nutrition: 0, color: [0.76, 0.66, 0.44] },
  { id: Mat.Clay, name: 'Clay', digCost: 1.8, edibleByAnts: false, edibleByTermites: false, nutrition: 0, color: [0.6, 0.38, 0.28] },
  { id: Mat.Rock, name: 'Rock', digCost: Infinity, edibleByAnts: false, edibleByTermites: false, nutrition: 0, color: [0.42, 0.42, 0.44] },
  { id: Mat.Gel, name: 'Gel', digCost: 0.6, edibleByAnts: true, edibleByTermites: false, nutrition: 0.5, color: [0.25, 0.62, 0.95] },
  { id: Mat.Wood, name: 'Wood', digCost: 3, edibleByAnts: false, edibleByTermites: true, nutrition: 1, color: [0.5, 0.36, 0.22] },
  { id: Mat.LeafLitter, name: 'Leaf litter', digCost: 0.8, edibleByAnts: false, edibleByTermites: true, nutrition: 0.6, color: [0.45, 0.33, 0.14] },
  { id: Mat.Plant, name: 'Plant', digCost: 2.5, edibleByAnts: false, edibleByTermites: false, nutrition: 0, color: [0.42, 0.66, 0.27] },
  { id: Mat.Mud, name: 'Mud', digCost: 1.2, edibleByAnts: false, edibleByTermites: false, nutrition: 0, color: [0.3, 0.22, 0.16] },
  { id: Mat.Fungus, name: 'Fungus', digCost: 1, edibleByAnts: true, edibleByTermites: false, nutrition: 1, color: [0.85, 0.82, 0.7] },
];

export function materialDef(id: MaterialId | number): MaterialDef {
  return MATERIALS[id] ?? MATERIALS[0];
}
