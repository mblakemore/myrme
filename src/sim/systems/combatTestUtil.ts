import { Mat, type Ant, type CasteId, type Colony, type Creature, type FoodSpawn, type MapGenResult, type MapGenResultA1, type MapSite, type SimEvent, type SimOptionsB1, type SpawnPoint, type Vec3 } from '../../core';
import { createWorld } from '../../world/VoxelWorld';
import { Simulation } from '../Simulation';

/**
 * Synthetic worlds for B1 tests and soaks (independent of the real generators): flat soil over
 * rock with any number of pre-carved nests (chamber + bent entrance tunnel), an optional conical
 * antlion pit, optional farm-style sites. Small enough to step tens of thousands of ticks.
 */
export interface ArenaOptions {
  size?: number;
  height?: number;
  ground?: number;
  /** Nest centres (x, z); the first is the player's, the rest are rival nests. Default: one in the middle. */
  nests?: { x: number; z: number }[];
  /** Conical pit dug into the ground (antlion site). */
  pit?: { x: number; z: number; r: number };
  /** Tube port site (farm-style invasions). */
  tubePort?: { x: number; z: number };
  food?: FoodSpawn[];
  /** Map flags. */
  predators?: boolean;
  rivals?: boolean;
  seed?: number;
  /** Start with no player nest (pure combat arenas): the colony spawn is on the surface. */
  director?: { enabled?: boolean; intensity?: number };
  foundRivals?: boolean;
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

export function makeArenaMap(opts: ArenaOptions = {}): MapGenResult {
  const S = opts.size ?? 64;
  const H = opts.height ?? 36;
  const G = opts.ground ?? 20;
  const world = createWorld(S, H, S, 'open');
  const nests = opts.nests ?? [{ x: S / 2, z: S / 2 }];
  const rx = 5;
  const ry = 3;
  const shapes = nests.map((n, i) => {
    // entrance tunnels point towards the middle of the map
    const dir = n.x <= S / 2 ? 1 : -1;
    const nest: Vec3 = { x: n.x, y: G - 9, z: n.z };
    const bend: Vec3 = { x: n.x + dir * 7, y: G - 5, z: n.z };
    const mouth: Vec3 = { x: n.x + dir * 10, y: G + 1.5, z: n.z };
    return { nest, bend, mouth, dir, i };
  });
  const pit = opts.pit;
  for (let y = 0; y < H; y++)
    for (let z = 0; z < S; z++)
      for (let x = 0; x < S; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const pz = z + 0.5;
        let d = G - py; // + inside the ground
        if (pit) {
          // cone: depth grows towards the centre
          const r = Math.hypot(px - pit.x, pz - pit.z);
          if (r < pit.r) d = Math.min(d, G - (pit.r - r) * 0.75 - py);
        }
        for (const s of shapes) {
          const ex = (px - s.nest.x) / rx;
          const ey = (py - s.nest.y) / ry;
          const ez = (pz - s.nest.z) / rx;
          const k = Math.hypot(ex, ey, ez);
          const g = Math.hypot(ex / rx, ey / ry, ez / rx) || 1e-6;
          d = Math.min(d, k < 1e-6 ? -ry : (k - 1) * (k / g));
          d = Math.min(d, segDist(px, py, pz, { x: s.nest.x + s.dir * 3, y: s.nest.y + 0.5, z: s.nest.z }, s.bend) - 1.9);
          d = Math.min(d, segDist(px, py, pz, s.bend, s.mouth) - 1.9);
        }
        world.setCell(x, y, z, d, y < 3 ? Mat.Rock : pit && Math.hypot(px - pit.x, pz - pit.z) < pit.r + 2 ? Mat.Sand : Mat.Soil);
      }
  world.markAllDirty();
  const spawns: SpawnPoint[] = shapes.map((s) => ({ kind: s.i === 0 ? 'colony' : 'rival', pos: { x: s.nest.x, y: s.nest.y - ry + 0.6, z: s.nest.z }, radius: rx, entrance: { x: s.mouth.x, y: G + 0.5, z: s.mouth.z } }));
  const sites: MapSite[] = [];
  if (pit) {
    const bottom = { x: pit.x, y: G - pit.r * 0.75 + 0.6, z: pit.z };
    sites.push({ kind: 'antlionPit', pos: bottom, radius: pit.r, end: bottom, level: 0 });
    spawns.push({ kind: 'creature', pos: bottom, radius: pit.r, entrance: null, creature: 'antlion' });
  }
  if (opts.tubePort) {
    const p = { x: opts.tubePort.x, y: G + 0.6, z: opts.tubePort.z };
    sites.push({ kind: 'tubePort', pos: p, radius: 2, end: p, level: 0 });
  }
  const c = S / 2;
  const map: MapGenResultA1 = {
    world,
    spawns,
    foodSources: opts.food ?? [],
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
    flags: { slab: false, slabAxis: 'z', weather: false, dayNight: false, keeperEvents: false, predators: opts.predators ?? false, rivals: opts.rivals ?? false },
    goal: { id: 'test', kind: 'sandbox', target: 0, label: 'test' },
    cameraStart: { pos: [c + 20, G + 20, c + 20], target: [c, G, c] },
    shotPoses: { overview: { pos: [c + 20, G + 20, c + 20], target: [c, G, c] } },
    extras: { size: 'small', materialTints: {}, strata: [], sites, chambers: [], tunnels: [], slabThickness: 0, surfaceY: G, solidCells: 0 },
  };
  return map;
}

export interface Arena {
  sim: Simulation;
  /** Ground level. */
  G: number;
  player: Colony;
  /** A point on the open surface. */
  at(x: number, z: number): Vec3;
  events: SimEvent[];
  /** Step n ticks, collecting events. */
  run(n: number): void;
  /** Kill every player ant except the queen (pure arenas). */
  clearWorkers(): void;
  ant(colony: Colony, caste: CasteId, x: number, z: number): Ant;
  creatureAt(c: Creature, x: number, z: number): void;
}

export function makeArena(opts: ArenaOptions = {}): Arena {
  const map = makeArenaMap(opts);
  const options: SimOptionsB1 = { seed: opts.seed ?? 1, faction: 'gardenAnt', fixture: 'none', director: opts.director, rivals: opts.foundRivals };
  const sim = new Simulation('meadow', map, options);
  const G = opts.ground ?? 20;
  const events: SimEvent[] = [];
  const at = (x: number, z: number): Vec3 => ({ x, y: G + 0.3, z });
  return {
    sim,
    G,
    player: sim.getColony(sim.playerColony)!,
    at,
    events,
    run(n) {
      for (let i = 0; i < n; i++) {
        sim.step();
        for (const e of sim.drainEvents()) events.push(e);
      }
    },
    clearWorkers() {
      for (const a of sim.ants) if (a.caste !== 'queen') sim.remove(a);
      sim.step();
    },
    ant(colony, caste, x, z) {
      return sim.spawnAnt(colony.id, caste, at(x, z));
    },
    creatureAt(c, x, z) {
      c.pos.x = x;
      c.pos.z = z;
    },
  };
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Make `a` face the point `p` (heading only). */
export function face(a: { pos: Vec3; forward: Vec3 }, p: Vec3): void {
  const dx = p.x - a.pos.x;
  const dz = p.z - a.pos.z;
  const l = Math.hypot(dx, dz) || 1;
  a.forward.x = dx / l;
  a.forward.y = 0;
  a.forward.z = dz / l;
}
