import { Mat, type FoodSpawn, type MapGenResult, type MaterialId, type SpeciesId, type Vec3 } from '../../core';
import { createWorld } from '../../world/VoxelWorld';
import { Simulation } from '../Simulation';

/**
 * Small synthetic map for A2b tests and soaks (independent of the real generators, which other
 * streams are free to change): flat soil over rock, an underground starter chamber with a bent
 * entrance tunnel, and whatever food piles the test asks for.
 */
export interface TestWorldOptions {
  size?: number;
  height?: number;
  ground?: number;
  food?: FoodSpawn[];
  /** Soil material (Mat.Gel makes the ground edible). */
  material?: MaterialId;
  /** Leave out the entrance tunnel (sealed nest). */
  sealed?: boolean;
}

function segDist(x: number, y: number, z: number, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((x - a.x) * abx + (y - a.y) * aby + (z - a.z) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - a.x - abx * t, y - a.y - aby * t, z - a.z - abz * t);
}

export function makeTestMap(opts: TestWorldOptions = {}): MapGenResult {
  const S = opts.size ?? 48;
  const H = opts.height ?? 32;
  const G = opts.ground ?? 20;
  const world = createWorld(S, H, S, 'open');
  const c = S / 2;
  const nest: Vec3 = { x: c, y: G - 9, z: c };
  const rx = 5;
  const ry = 3;
  const bend: Vec3 = { x: c + 7, y: G - 5, z: c };
  const mouth: Vec3 = { x: c + 10, y: G + 1.5, z: c };
  const soil = opts.material ?? Mat.Soil;
  for (let y = 0; y < H; y++)
    for (let z = 0; z < S; z++)
      for (let x = 0; x < S; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const pz = z + 0.5;
        let d = G - py; // + inside the ground
        // chamber (ellipsoid, first-order distance)
        const ex = (px - nest.x) / rx;
        const ey = (py - nest.y) / ry;
        const ez = (pz - nest.z) / rx;
        const k = Math.hypot(ex, ey, ez);
        const g = Math.hypot(ex / rx, ey / ry, ez / rx) || 1e-6;
        const cav = k < 1e-6 ? -ry : (k - 1) * (k / g); // − inside the cavity
        d = Math.min(d, cav);
        if (!opts.sealed) {
          d = Math.min(d, segDist(px, py, pz, { x: nest.x + 3, y: nest.y + 0.5, z: nest.z }, bend) - 1.9);
          d = Math.min(d, segDist(px, py, pz, bend, mouth) - 1.9);
        }
        world.setCell(x, y, z, d, y < 3 ? Mat.Rock : soil);
      }
  world.markAllDirty();
  const food = opts.food ?? [
    { kind: 'seeds', pos: { x: c - 13, y: G + 0.5, z: c - 9 }, amount: 160, regen: 0 },
    { kind: 'carcass', pos: { x: c + 12, y: G + 0.5, z: c + 13 }, amount: 110, regen: 0 },
    { kind: 'honeydew', pos: { x: c - 4, y: G + 0.5, z: c + 16 }, amount: 30, regen: 0.12 },
  ];
  return {
    world,
    spawns: [{ kind: 'colony', pos: { x: nest.x, y: nest.y - ry + 0.6, z: nest.z }, radius: rx, entrance: opts.sealed ? null : { x: mouth.x, y: G + 0.5, z: mouth.z } }],
    foodSources: food,
    props: [],
    cameraMode: 'rts',
    environment: {
      backdrop: 'sky',
      sunDir: { x: 0.4, y: 0.8, z: 0.3 },
      sunColor: [1, 1, 1],
      sunIntensity: 1,
      skyTop: [0.3, 0.5, 0.9],
      skyHorizon: [0.8, 0.9, 1],
      groundColor: [0.4, 0.3, 0.2],
      ambientIntensity: 0.5,
      fogColor: [0.8, 0.9, 1],
      fogDensity: 0,
      dayLength: 0,
      baseTemperature: 22,
      rainChance: 0,
    },
    boundary: 'open',
    flags: { slab: false, slabAxis: 'z', weather: false, dayNight: false, keeperEvents: false, predators: false, rivals: false },
    goal: { id: 'test', kind: 'sandbox', target: 0, label: 'test' },
    cameraStart: { pos: [c + 20, G + 20, c + 20], target: [c, G, c] },
    shotPoses: { overview: { pos: [c + 20, G + 20, c + 20], target: [c, G, c] } },
  };
}

/** A non-fixture simulation on the synthetic map (queen + starting workers + stored food). */
export function makeColonySim(opts: TestWorldOptions & { seed?: number; faction?: SpeciesId } = {}): Simulation {
  const seed = opts.seed ?? 1;
  const faction = opts.faction ?? 'gardenAnt';
  return new Simulation('meadow', makeTestMap(opts), { seed, faction, fixture: 'none' });
}
