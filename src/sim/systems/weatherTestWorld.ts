import { DENSITY_PER_VOXEL, ISO, Mat, type MapGenResult, type MaterialId, type SpeciesId, type VoxelWorld } from '../../core';
import { createWorld } from '../../world/VoxelWorld';
import { Simulation } from '../Simulation';
import { makeTestMap, type TestWorldOptions } from './colonyTestWorld';

/**
 * Synthetic worlds for the B2 tests and soaks (weather, water, temperature, fungus): the A2b test
 * map with weather / day-night switched on and optional climbable stems, plus a bare two-chamber
 * block for the water-field unit tests.
 */

export interface EnvWorldOptions extends TestWorldOptions {
  seed?: number;
  faction?: SpeciesId;
  weather?: boolean;
  dayNight?: boolean;
  baseTemperature?: number;
  rainChance?: number;
  /** Plant stems to add: column (x, z), rising `height` above the ground. */
  stems?: { x: number; z: number; height: number }[];
}

/** Write a vertical Plant cylinder into a generated world (and report it as a climbable prop). */
export function addStem(map: MapGenResult, x: number, z: number, y0: number, height: number, radius = 1.3): void {
  const w = map.world;
  const R = Math.ceil(radius + 2);
  for (let cy = Math.floor(y0) - 1; cy <= y0 + height + 2; cy++)
    for (let cz = Math.floor(z) - R; cz <= z + R; cz++)
      for (let cx = Math.floor(x) - R; cx <= x + R; cx++) {
        if (!w.inBounds(cx, cy, cz)) continue;
        const py = cy + 0.5;
        const dh = Math.hypot(cx + 0.5 - x, cz + 0.5 - z);
        // capped cylinder as a signed distance (+ inside)
        const dTop = y0 + height - py;
        const d = Math.min(radius - dh, dTop);
        const cur = (w.density[w.index(cx, cy, cz)] - ISO) / DENSITY_PER_VOXEL;
        if (d > cur) w.setCell(cx, cy, cz, d, d > 0 || cur <= 0 ? Mat.Plant : (w.material[w.index(cx, cy, cz)] as MaterialId));
      }
  w.markAllDirty();
  map.props.push({ kind: 'stem', pos: { x, y: y0, z }, end: { x, y: y0 + height, z }, radius, climbable: true, seed: 1 });
}

export function makeEnvMap(opts: EnvWorldOptions = {}): MapGenResult {
  const map = makeTestMap(opts);
  map.flags.weather = opts.weather ?? true;
  map.flags.dayNight = opts.dayNight ?? true;
  map.environment.dayLength = 720;
  map.environment.rainChance = opts.rainChance ?? 0.3;
  if (opts.baseTemperature !== undefined) map.environment.baseTemperature = opts.baseTemperature;
  const G = opts.ground ?? 20;
  for (const s of opts.stems ?? []) addStem(map, s.x, s.z, G, s.height);
  return map;
}

/** A colony sim (queen + workers) on the synthetic map with the environment switched on. */
export function makeEnvSim(opts: EnvWorldOptions = {}, mapId: 'meadow' | 'forest' | 'desert' = 'meadow'): Simulation {
  const seed = opts.seed ?? 1;
  const faction = opts.faction ?? 'gardenAnt';
  return new Simulation(mapId, makeEnvMap(opts), { seed, faction, fixture: 'none' });
}

/** Solid block of `material` with boxes of air carved out (binary densities — fine for water). */
export function makeBlock(sx: number, sy: number, sz: number, material: MaterialId, boxes: readonly (readonly [number, number, number, number, number, number])[], boundary: 'open' | 'glass' = 'glass'): VoxelWorld {
  const w = createWorld(sx, sy, sz, boundary);
  for (let y = 0; y < sy; y++)
    for (let z = 0; z < sz; z++)
      for (let x = 0; x < sx; x++) {
        let air = false;
        for (const b of boxes) if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]) air = true;
        w.setCell(x, y, z, air ? -1 : 1, material);
      }
  w.markAllDirty();
  return w;
}
