import { Mat, SeededRng, type FoodSpawn, type MapDef, type MapGenOptions, type MapGenResultA1, type SpawnPoint, type Vec3 } from '../../core';
import { createWorld } from '../VoxelWorld';
import { createNoise } from '../noise';
import { FARM_HEIGHT, FARM_THICKNESS, FARM_TUNNEL_RADIUS, FARM_WIDTH, bandAt, discZ, finishFarm, stackBands } from './farm';
import { SdfCanvas, capsule, distToSegment, ellipsoid, farmFlags, newExtras, pose, roomEnvironment, site, sizePreset } from './shared';

export { FARM_THICKNESS, FARM_TUNNEL_RADIUS } from './farm';

/**
 * Gel Farm — a thin slab of edible blue gel between two panes (D6/D7) with an air gap on top.
 * The gel was poured in layers: two wavy "nutrient" strata (Fungus voxels: richer and a little
 * harder to dig than gel) run through it, and sealed air bubbles hang in it like in a lava lamp —
 * break into one and it becomes a ready-made chamber. A starter tunnel leads to the queen's room.
 */
export function generateGelFarm(seed: number, opts: MapGenOptions): MapGenResultA1 {
  const rng = new SeededRng(seed).fork('gelFarm');
  const noise = createNoise(rng.fork('noise'));
  const size = sizePreset(opts);
  const W = FARM_WIDTH[size];
  const H = FARM_HEIGHT;
  const T = FARM_THICKNESS;
  const world = createWorld(W, H, T, 'glass');
  const canvas = new SdfCanvas(W, H, T);
  const extras = newExtras(size);
  const top = H - 13;
  // poured gel: a slow undulation and a meniscus climbing the side walls
  const surface = (x: number): number => top + noise.n2(x * 0.04, 3.3) * 0.8 + 1.7 * Math.exp(-Math.min(x, W - x) / 2.8);

  const bands = stackBands(
    [
      { thickness: top * 0.27, material: Mat.Gel, tint: [0.1, 0.3, 0.8] },
      { thickness: 3, material: Mat.Fungus, tint: [0.98, 0.66, 0.25] },
      { thickness: top * 0.44, material: Mat.Gel, tint: [0.18, 0.5, 0.93] },
      { thickness: 2.6, material: Mat.Fungus, tint: [0.98, 0.5, 0.6] },
      { thickness: 20, material: Mat.Gel, tint: [0.36, 0.76, 0.98] },
    ],
    rng.fork('bands'),
    1.6,
  );
  extras.strata = bands;
  extras.materialTints = { [Mat.Fungus]: [0.98, 0.62, 0.3] };

  canvas.addSolid(
    canvas.fullBox(),
    (x, y) => surface(x) - y,
    (x, y) => bands[bandAt(bands, x + 0.5, y + 0.5)].material,
  );

  // ---- starter nest ------------------------------------------------------------------------------
  const zc = T / 2;
  const P = (x: number, y: number): Vec3 => ({ x, y, z: zc });
  const cx = W / 2;
  const k = W / 96;
  const r = FARM_TUNNEL_RADIUS;
  const ex = cx - 14 * k;
  const entrance = P(ex, surface(ex) + 1.5);
  const chamber = P(cx + 2 * k, 29);
  const bend = P(cx - 8 * k, 34);
  const segs: [Vec3, Vec3][] = [
    [entrance, P(cx - 16 * k, 42)],
    [P(cx - 16 * k, 42), bend],
    [bend, chamber],
    // a side gallery with a rising dead end, and a descending branch to a nook
    [chamber, P(cx + 18 * k, 25)],
    [P(cx + 18 * k, 25), P(cx + 24 * k, 36)],
    [bend, P(cx - 22 * k, 23)],
  ];
  const nook = P(cx - 23 * k, 22);
  for (const [a, b] of segs) {
    canvas.cut(capsule(a, b, r), 0.6);
    extras.tunnels.push({ a, b, radius: r });
  }
  canvas.cut(ellipsoid(chamber, 7, 3.9, 7), 0.6);
  canvas.cut(ellipsoid(nook, 4.6, 3.1, 4.6), 0.6);
  extras.chambers.push({ kind: 'queen', owner: 'colony', pos: chamber, radii: { x: 7, y: 3.9, z: T / 2 } });
  extras.chambers.push({ kind: 'granary', owner: 'colony', pos: nook, radii: { x: 4.6, y: 3.1, z: T / 2 } });
  extras.chambers.push({ kind: 'entrance', owner: 'colony', pos: entrance, radii: { x: r, y: r, z: T / 2 } });

  // ---- bubbles ---------------------------------------------------------------------------------------
  const br = rng.fork('bubbles');
  const bubbles: { x: number; y: number; r: number }[] = [];
  const clear = (x: number, y: number, rad: number): boolean => {
    if (x < rad + 2.5 || x > W - rad - 2.5 || y < rad + 2.5 || y > surface(x) - rad - 3) return false;
    for (const [a, b] of segs) if (distToSegment(x, y, zc, a, b) < rad + r + 3) return false;
    if (Math.hypot((x - chamber.x) / (7 + rad + 3), (y - chamber.y) / (3.9 + rad + 3)) < 1) return false;
    if (Math.hypot(x - nook.x, y - nook.y) < 4.6 + rad + 3) return false;
    for (const q of bubbles) if (Math.hypot(x - q.x, y - q.y) < rad + q.r + 2.6) return false;
    return true;
  };
  const addBubble = (x: number, y: number, rad: number): boolean => {
    if (!clear(x, y, rad)) return false;
    bubbles.push({ x, y, r: rad });
    canvas.cut(discZ(x, y, rad, T), 0);
    extras.sites.push(site('bubble', P(x, y), rad));
    return true;
  };
  // streams: strings of bubbles that grow as they rise
  for (let s = 0, n = Math.max(2, Math.round(3 * k)); s < n; s++) {
    let x = br.range(8, W - 8);
    let y = br.range(6, 14);
    let rad = 1.6;
    for (let i = 0; i < 5 && y < top - 8; i++) {
      addBubble(x, y, rad);
      rad = Math.min(3.4, rad + br.range(0.2, 0.55));
      y += rad * 2 + br.range(3, 5.5);
      x += br.range(-3, 3);
    }
  }
  for (let i = 0, n = Math.round(9 * k); i < n; i++) addBubble(br.range(5, W - 5), br.range(5, top - 6), br.range(1.6, 3.3));

  // ---- commit & place things ------------------------------------------------------------------------------
  const colony: SpawnPoint = { kind: 'colony', pos: { x: chamber.x, y: chamber.y - 2.7, z: zc }, radius: 7, entrance, species: opts.faction };
  const fx = [cx + 20 * k, cx - 30 * k, cx + 36 * k];
  const foods: FoodSpawn[] = [
    { kind: 'sugar', pos: P(fx[0], surface(fx[0]) + 0.6), amount: 90, regen: 0 },
    { kind: 'seeds', pos: P(fx[1], surface(fx[1]) + 0.6), amount: 60, regen: 0 },
    { kind: 'seeds', pos: P(fx[2], surface(fx[2]) + 0.6), amount: 60, regen: 0 },
  ];
  const done = finishFarm(canvas, world, colony, foods, Mat.Gel);
  extras.solidCells = done.solidCells;
  extras.slabThickness = T;
  extras.surfaceY = top;
  extras.sites.push(site('dropZone', P(cx, top + 1), W * 0.4, P(cx, H - 1)));
  extras.sites.push(site('tubePort', P(W - 0.5, top + 6), 2.2));

  const big = bubbles.reduce((a, b) => (b.r > a.r ? b : a), bubbles[0] ?? { x: cx, y: 20, r: 2 });
  const full = Math.max(78, W * 0.82);
  return {
    world,
    spawns: [colony],
    foodSources: done.foodSources,
    props: [],
    cameraMode: 'slab',
    environment: roomEnvironment(),
    boundary: 'glass',
    flags: farmFlags(),
    goal: { id: 'gel-excavate', kind: 'excavate', target: 25, label: 'Excavate 25% of the gel' },
    cameraStart: pose([cx, 32, T + full], [cx, 32, zc]),
    shotPoses: {
      overview: pose([cx, 32, T + full], [cx, 32, zc]),
      // M3: a higher, wider view that keeps the space above the lid in frame (the keeper's hand)
      keeper: pose([cx, H + 6, T + full * 1.25], [cx, H - 10, zc]),
      front: pose([cx + 1, 31, T + 34], [cx + 1, 30, zc]),
      chamber: pose([chamber.x + 1, chamber.y + 0.5, T + 13], [chamber.x + 1, chamber.y, zc]),
      bubbles: pose([big.x + 2, big.y + 1, T + 16], [big.x, big.y, zc]),
      surface: pose([ex + 6, top + 5, T + 22], [ex + 3, top - 1, zc]),
    },
    extras,
  };
}

export const gelFarm: MapDef = {
  id: 'gelFarm',
  name: 'Gel Farm',
  kind: 'farm',
  description: 'A backlit slab of blue gel between two panes, layered with nutrients and bubbles. The gel is edible.',
  generate: generateGelFarm,
};
