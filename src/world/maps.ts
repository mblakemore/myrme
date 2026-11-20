import type { MapDef, MapId } from '../core';
import { desert } from './generators/desert';
import { forest } from './generators/forest';
import { formicarium } from './generators/formicarium';
import { gelFarm } from './generators/gelFarm';
import { meadow } from './generators/meadow';
import { sandFarm } from './generators/sandFarm';

/**
 * Map registry (§5.1): explicit list, pre-populated by M0. A1 fills in the generator files;
 * the list itself does not change.
 */
export const MAPS: readonly MapDef[] = [meadow, forest, desert, gelFarm, sandFarm, formicarium];

export function getMap(id: MapId): MapDef {
  const m = MAPS.find((d) => d.id === id);
  if (!m) throw new Error(`unknown map: ${id}`);
  return m;
}
