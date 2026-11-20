import type { FixtureMode, MapId, SpeciesId } from '../core';
import { getMap } from '../world/maps';
import { Simulation } from './Simulation';

/** Builds a headless simulation for tests and soaks. */
export function makeSim(mapId: MapId, opts: { seed?: number; fixture?: FixtureMode; ants?: number; faction?: SpeciesId; small?: boolean } = {}): Simulation {
  const seed = opts.seed ?? 1;
  const faction = opts.faction ?? 'gardenAnt';
  const map = getMap(mapId).generate(seed, { faction, small: opts.small });
  return new Simulation(mapId, map, { seed, faction, fixture: opts.fixture ?? 'wander', fixtureAnts: opts.ants });
}
