import { Mat, v3, type Ant, type MapGenResult, type MaterialId, type SimState, type SimSystem, type Vec3, type VoxelWorld } from '../../core';
import { createWorld } from '../../world/VoxelWorld';
import { Simulation } from '../Simulation';
import { digSystem } from './dig';
import { fallingSystem } from './falling';
import { movementSystem } from './movement';
import { pathsSystem } from './paths';
import { pheromoneSystem } from './pheromone';

/**
 * Test support for the A2a systems: small synthetic worlds and a Simulation that runs ONLY the
 * A2a systems (paths → movement → falling → dig → pheromone) plus an optional per-tick driver,
 * so these tests do not depend on map generators or on other streams' behaviors.
 * Not used by the game.
 */

/** Solid block of `material` up to height `h` (flat floor at y = h) in an open world. */
export function flatWorld(sx: number, sy: number, sz: number, h: number, material: MaterialId = Mat.Soil, boundary: 'open' | 'glass' = 'open'): VoxelWorld {
  const w = createWorld(sx, sy, sz, boundary);
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) w.setCell(x, y, z, h - (y + 0.5), material);
  w.markAllDirty();
  return w;
}

/** Carve a tunnel of the given radius along a polyline (overlapping D4 dig stamps). */
export function carveTunnel(w: VoxelWorld, points: Vec3[], radius = 1.6): void {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / 0.75));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      w.dig({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }, radius);
    }
  }
}

export function syntheticMap(world: VoxelWorld, nest: Vec3, entrance: Vec3 | null = null): MapGenResult {
  return {
    world,
    spawns: [{ kind: 'colony', pos: nest, radius: 3, entrance }],
    foodSources: [],
    props: [],
    cameraMode: 'rts',
    environment: {
      backdrop: 'sky',
      sunDir: v3(0.3, 0.8, 0.5),
      sunColor: [1, 1, 1],
      sunIntensity: 1,
      skyTop: [0.3, 0.5, 0.9],
      skyHorizon: [0.7, 0.8, 0.9],
      groundColor: [0.3, 0.25, 0.2],
      ambientIntensity: 0.5,
      fogColor: [0.7, 0.8, 0.9],
      fogDensity: 0,
      dayLength: 0,
      baseTemperature: 22,
      rainChance: 0,
    },
    boundary: world.boundary,
    flags: { slab: false, slabAxis: 'z', weather: false, dayNight: false, keeperEvents: false, predators: false, rivals: false },
    goal: { id: 'sandbox', kind: 'sandbox', target: 0, label: 'test' },
    cameraStart: { pos: [0, 10, 10], target: [0, 0, 0] },
    shotPoses: { overview: { pos: [0, 10, 10], target: [0, 0, 0] } },
  };
}

export type Driver = (sim: Simulation, dt: number) => void;

/**
 * A Simulation over `world` running only the A2a systems. `driver` runs first every tick (set
 * intents there). The colony is created at `nest`; no ants are spawned.
 */
export function a2aSim(world: VoxelWorld, nest: Vec3, driver?: Driver, entrance: Vec3 | null = null, seed = 1): Simulation {
  const drive: SimSystem = {
    id: 'testDriver',
    update(sim, dt) {
      driver?.(sim as Simulation, dt);
    },
  };
  const systems: SimSystem[] = [drive, pathsSystem, movementSystem, fallingSystem, digSystem, pheromoneSystem];
  return new Simulation('meadow', syntheticMap(world, nest, entrance), { seed, faction: 'gardenAnt', fixture: 'wander', fixtureAnts: 0 }, systems);
}

/** Spawn a worker of the player colony at a position (snapped to the nearest surface). */
export function spawnWorker(sim: SimState, pos: Vec3): Ant {
  return sim.spawnAnt(sim.playerColony, 'worker', pos);
}

export function goto(ant: Ant, cell: number, speedMul = 1): void {
  ant.intent.mode = 'goto';
  ant.intent.goal = cell;
  ant.intent.speedMul = speedMul;
}
