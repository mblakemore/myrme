import { Mat, SeededRng, type FoodSpawn, type MapDef, type MapGenOptions, type MapGenResultA1, type PropDef, type SpawnPoint, type Vec3 } from '../../core';
import { createWorld } from '../VoxelWorld';
import { createNoise } from '../noise';
import { FARM_HEIGHT, FARM_THICKNESS, FARM_TUNNEL_RADIUS, FARM_WIDTH, bandAt, discZ, finishFarm, stackBands, type BandSpec } from './farm';
import { SdfCanvas, capsule, displaced, distToSegment, ellipsoid, farmFlags, newExtras, pose, roomEnvironment, site, sizePreset } from './shared';

/** Coloured-sand palette: voxel material (digging feel) + the tint A3 renders the band with. */
const PALETTE: Omit<BandSpec, 'thickness'>[] = [
  { material: Mat.Clay, tint: [0.56, 0.25, 0.17] }, // terracotta
  { material: Mat.Sand, tint: [0.87, 0.73, 0.46] }, // ochre
  { material: Mat.Soil, tint: [0.34, 0.23, 0.16] }, // umber
  { material: Mat.Sand, tint: [0.94, 0.91, 0.84] }, // white
  { material: Mat.Mud, tint: [0.2, 0.16, 0.14] }, // black
  { material: Mat.Sand, tint: [0.91, 0.58, 0.42] }, // salmon
  { material: Mat.Clay, tint: [0.72, 0.43, 0.28] }, // rust
  { material: Mat.Sand, tint: [0.36, 0.62, 0.66] }, // teal
  { material: Mat.Soil, tint: [0.5, 0.34, 0.2] }, // sienna
];
const TOP_BAND: Omit<BandSpec, 'thickness'> = { material: Mat.Sand, tint: [0.84, 0.72, 0.5] };

/**
 * Sand Farm — the classic sand-art ant farm: wavy colour strata between two panes (D6/D7).
 * Each band is Sand, Clay, Soil or Mud (so digging speed changes band to band) and carries a
 * colour hint in `extras.strata`. A twig and pebbles lie on the surface, a few stones are buried
 * in the layers, and a starter shaft leads to a small queen chamber.
 */
export function generateSandFarm(seed: number, opts: MapGenOptions): MapGenResultA1 {
  const rng = new SeededRng(seed).fork('sandFarm');
  const noise = createNoise(rng.fork('noise'));
  const size = sizePreset(opts);
  const W = FARM_WIDTH[size];
  const H = FARM_HEIGHT;
  const T = FARM_THICKNESS;
  const world = createWorld(W, H, T, 'glass');
  const canvas = new SdfCanvas(W, H, T);
  const extras = newExtras(size);
  const top = H - 15;
  const zc = T / 2;
  const P = (x: number, y: number): Vec3 => ({ x, y, z: zc });
  const cx = W / 2;
  const k = W / 96;
  const ex = cx - 19 * k;
  // poured sand: a low dune towards one side, plus the spoil heap beside the entrance
  const tilt = rng.chance(0.5) ? 1 : -1;
  const surface = (x: number): number => top + tilt * 1.6 * Math.sin((x / W - 0.5) * 2.6) + noise.n2(x * 0.06, 1.7) * 0.7 + 1.5 * Math.exp(-(((x - ex + 6.5) / 3.2) ** 2));

  // ---- strata --------------------------------------------------------------------------------------
  const sr = rng.fork('strata');
  const specs: BandSpec[] = [];
  let start = sr.int(PALETTE.length);
  let y = 0;
  let prev = -1;
  while (y < top - 9) {
    let pick = PALETTE[start % PALETTE.length];
    if (pick.material === prev) pick = PALETTE[++start % PALETTE.length]; // never two bands of the same material in a row
    start += 1 + sr.int(2);
    const thickness = Math.min(sr.range(4, 8.5), top - 5 - y);
    specs.push({ ...pick, thickness });
    prev = pick.material;
    y += thickness;
  }
  specs.push({ ...TOP_BAND, thickness: 20 });
  const bands = stackBands(specs, sr, 2.2);
  extras.strata = bands;

  canvas.addSolid(
    canvas.fullBox(),
    (x, yy) => surface(x) - yy,
    (x, yy) => bands[bandAt(bands, x + 0.5, yy + 0.5)].material,
  );

  // ---- starter shaft & chamber ---------------------------------------------------------------------------
  const r = FARM_TUNNEL_RADIUS;
  const entrance = P(ex, surface(ex) + 1.5);
  const chamber = P(cx - 3 * k, top - 21);
  const segs: [Vec3, Vec3][] = [
    [entrance, P(ex + 3 * k, top - 8)],
    [P(ex + 3 * k, top - 8), P(ex - 2 * k, top - 15)],
    [P(ex - 2 * k, top - 15), P(chamber.x - 5, chamber.y + 0.5)],
    [P(chamber.x + 4, chamber.y), P(chamber.x + 15 * k, chamber.y - 5)], // the first gallery beyond the chamber
  ];
  for (const [a, b] of segs) {
    canvas.cut(capsule(a, b, r), 0.6);
    extras.tunnels.push({ a, b, radius: r });
  }
  canvas.cut(ellipsoid(chamber, 6.5, 3.7, 6.5), 0.6);
  extras.chambers.push({ kind: 'queen', owner: 'colony', pos: chamber, radii: { x: 6.5, y: 3.7, z: T / 2 } });
  extras.chambers.push({ kind: 'entrance', owner: 'colony', pos: entrance, radii: { x: r, y: r, z: T / 2 } });

  // ---- buried stones, surface pebbles, a twig ---------------------------------------------------------------
  const props: PropDef[] = [];
  const dr = rng.fork('decor');
  const stones: { x: number; y: number; r: number }[] = [];
  for (let i = 0, n = Math.round(6 * k), tries = 0; i < n && tries < 200; tries++) {
    const rad = dr.range(2, 3.4);
    const x = dr.range(rad + 3, W - rad - 3);
    const yy = dr.range(rad + 3, top - rad - 5);
    if (segs.some(([a, b]) => distToSegment(x, yy, zc, a, b) < rad + r + 3.5)) continue;
    if (Math.hypot((x - chamber.x) / (6.5 + rad + 4), (yy - chamber.y) / (3.7 + rad + 4)) < 1) continue;
    if (stones.some((q) => Math.hypot(x - q.x, yy - q.y) < rad + q.r + 4)) continue;
    stones.push({ x, y: yy, r: rad });
    const ox = dr.range(0, 50);
    canvas.blend(displaced(discZ(x, yy, rad, T), (px, py) => noise.n2(px * 0.5 + ox, py * 0.5), 0.35), Mat.Rock, 0);
    props.push({ kind: 'pebble', pos: P(x, yy), end: P(x, yy), radius: rad, climbable: true, seed: dr.int(1 << 30) });
    i++;
  }
  // surface: keep clear of the entrance
  const side = (min: number, max: number): number => cx + dr.range(min, max) * k;
  const twigA = side(4, 9);
  const twigB = twigA + dr.range(17, 22) * Math.min(1, k * 1.2);
  const ta = P(twigA, surface(twigA) - 0.2);
  const tb = P(Math.min(W - 6, twigB), surface(Math.min(W - 6, twigB)) + 0.5);
  canvas.blend(capsule(ta, tb, 2.25, 2.05), Mat.Wood, 1.6);
  props.push({ kind: 'twig', pos: ta, end: tb, radius: 2.2, climbable: true, seed: dr.int(1 << 30) });
  for (const px of [ex - 14 * k, tb.x + 5.5]) {
    if (px < 5 || px > W - 5) continue;
    const rad = dr.range(2.4, 3.3);
    canvas.blend(discZ(px, surface(px) - rad * 0.25, rad, T), Mat.Rock, 1.4);
    props.push({ kind: 'pebble', pos: P(px, surface(px)), end: P(px, surface(px) + rad * 0.75), radius: rad, climbable: true, seed: dr.int(1 << 30) });
  }

  // ---- commit ----------------------------------------------------------------------------------------------------
  const colony: SpawnPoint = { kind: 'colony', pos: { x: chamber.x, y: chamber.y - 2.5, z: zc }, radius: 6.5, entrance, species: opts.faction };
  const f1 = cx - 2 * k;
  const f2 = ex - 7 * k;
  const f3 = (ta.x + tb.x) / 2;
  const foods: FoodSpawn[] = [
    { kind: 'seeds', pos: P(f1, surface(f1) + 0.6), amount: 120, regen: 0 },
    { kind: 'sugar', pos: P(f2, surface(f2) + 0.6), amount: 100, regen: 0 },
    { kind: 'carcass', pos: P(f3, surface(f3) + 3.2), amount: 150, regen: 0 }, // a dead fly on the twig
  ];
  const done = finishFarm(canvas, world, colony, foods, Mat.Sand);
  extras.solidCells = done.solidCells;
  extras.slabThickness = T;
  extras.surfaceY = top;
  extras.sites.push(site('dropZone', P(cx, top + 2), W * 0.4, P(cx, H - 1)));
  extras.sites.push(site('tubePort', P(W - 0.5, top + 7), 2.2));
  extras.sites.push(site('deadwood', P((ta.x + tb.x) / 2, (ta.y + tb.y) / 2), 2.2, tb));

  const full = Math.max(78, W * 0.82);
  return {
    world,
    spawns: [colony],
    foodSources: done.foodSources,
    props,
    cameraMode: 'slab',
    environment: roomEnvironment(),
    boundary: 'glass',
    flags: farmFlags(),
    goal: { id: 'sand-population', kind: 'population', target: 120, label: 'Grow the colony to 120 ants' },
    cameraStart: pose([cx, 32, T + full], [cx, 32, zc]),
    shotPoses: {
      overview: pose([cx, 32, T + full], [cx, 32, zc]),
      // M3: a higher, wider view that keeps the space above the lid in frame (the keeper's hand)
      keeper: pose([cx, H + 6, T + full * 1.25], [cx, H - 10, zc]),
      front: pose([cx - 6 * k, top - 14, T + 36], [cx - 6 * k, top - 15, zc]),
      chamber: pose([chamber.x + 1, chamber.y + 0.5, T + 13], [chamber.x + 1, chamber.y, zc]),
      surface: pose([f3 - 4, top + 6, T + 24], [f3 - 2, top + 1, zc]),
    },
    extras,
  };
}

export const sandFarm: MapDef = {
  id: 'sandFarm',
  name: 'Sand Farm',
  kind: 'farm',
  description: 'Layered coloured sand between two panes, with a twig and pebbles on top.',
  generate: generateSandFarm,
};
