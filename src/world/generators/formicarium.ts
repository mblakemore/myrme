import { Mat, SeededRng, type FoodSpawn, type MapDef, type MapGenOptions, type MapGenResultA1, type MapSizePreset, type MaterialId, type PropDef, type SpawnPoint, type Vec3 } from '../../core';
import { createWorld } from '../VoxelWorld';
import { createNoise } from '../noise';
import { finishFarm } from './farm';
import { SdfCanvas, bezier, capsule, chain, displaced, ellipsoid, farmFlags, newExtras, pose, roomEnvironment, site, sizePreset, vec } from './shared';

/** Formicarium width per size preset. */
export const FORMICARIUM_WIDTH: Record<MapSizePreset, number> = { small: 88, medium: 128, large: 160 };
/** World depth (z). The nest is carved into the front face only. */
export const FORMICARIUM_DEPTH: number = 12;
/** D7: thickness of the carved / diggable plaster layer behind the front pane. */
export const FORMICARIUM_FRONT: number = 5;

/**
 * Formicarium — a cast plaster nest block with a glass front. Like a real ytong/plaster nest the
 * chambers are bowls carved into the FRONT face (the pane at max z), joined by half-pipe tubes,
 * so everything is visible through the pane; the plaster behind the 5-voxel front layer is
 * undiggable (D7: every tunnel touches the front pane). A tall water-tower chamber keeps the
 * nest humid. A tube leads out of the block into the outworld tray — an open-topped, full-depth
 * arena with a sand floor, a feeding dish, a twig and pebbles.
 */
export function generateFormicarium(seed: number, opts: MapGenOptions): MapGenResultA1 {
  const rng = new SeededRng(seed).fork('formicarium');
  const noise = createNoise(rng.fork('noise'));
  const size = sizePreset(opts);
  const W = FORMICARIUM_WIDTH[size];
  const H = 64;
  const D = FORMICARIUM_DEPTH;
  const world = createWorld(W, H, D, 'glass');
  const canvas = new SdfCanvas(W, H, D);
  const extras = newExtras(size);
  const bw = Math.round(W * 0.6); // nest block: x < bw; outworld tray: x >= bw
  const tw = W - bw;
  const zf = D - 1.2; // axis depth of carved features: just behind the front pane
  const frontZ = D - FORMICARIUM_FRONT;

  // ---- solids: plaster block + tray floor --------------------------------------------------------------
  const floorBase = 11;
  // sand banks up against the block and the tray walls, with a few soft undulations
  const floorY = (x: number, z: number): number => floorBase + 2.6 * Math.exp(-(x - bw) / 3.2) + 1.2 * Math.exp(-(W - x) / 2.5) + noise.fbm2(x * 0.07, z * 0.07, 2) * 0.7;
  canvas.addSolid(
    canvas.fullBox(),
    (x, y, z) => Math.max(bw - x, (floorY(x, z) - y) * 0.9),
    (x, y, z): MaterialId => {
      if (x >= bw) return y < floorBase - 4.5 ? Mat.Rock : Mat.Sand; // tray: thin sand bed over a hard bottom
      if (z < frontZ) return Mat.Rock; // back of the block: undiggable
      if (x < 2 || x >= bw - 3 || y < 2 || y >= H - 2) return Mat.Rock; // hard frame
      return noise.fbm2(x * 0.055, y * 0.055, 3) > 0.42 ? Mat.Rock : Mat.Clay; // plaster with hard inclusions
    },
  );

  // ---- chamber layout ----------------------------------------------------------------------------------------
  const lr = rng.fork('layout');
  const flip = lr.chance(0.5); // mirror the upper rows for variety (the exit side stays put)
  const ux = (u: number): number => 6 + (flip ? 1 - u : u) * (bw - 16);
  const rxMax = Math.min(8, bw * 0.105);
  interface Room {
    c: Vec3;
    rx: number;
    ry: number;
  }
  const room = (u: number, y: number, rx: number, ry: number, mirror = true): Room => ({
    c: vec((mirror ? ux(u) : 6 + u * (bw - 16)) + lr.range(-1.2, 1.2), y + lr.range(-1.2, 1.2), zf),
    rx: Math.min(rxMax, rx) * lr.range(0.92, 1.06),
    ry,
  });
  const A = room(0.16, 52, 7, 4.3);
  const B = room(0.5, 53, 7.5, 4.6);
  const C = room(0.84, 51, 6.5, 4.2);
  const E = room(0.3, 35, 7.5, 4.8);
  const F = room(0.7, 34, 7, 4.5);
  const Q = room(0.36, 16, 9, 5.6, false); // queen's hall, bottom
  const G = room(0.8, 17, 6.5, 4.4, false); // granary beside the exit
  const rooms = [A, B, C, E, F, Q, G];
  const kinds = ['nursery', 'nursery', 'barracks', 'nursery', 'granary', 'queen', 'granary'] as const;
  rooms.forEach((r, i) => {
    canvas.cut(ellipsoid(r.c, r.rx, r.ry, 3.8), 0.5);
    extras.chambers.push({ kind: kinds[i], owner: i === 5 ? 'colony' : 'neutral', pos: r.c, radii: vec(r.rx, r.ry, 3.8) });
  });

  // tubes: gently curved half-pipes in the front face
  const R = 2.3;
  const props: PropDef[] = [];
  const tube = (a: Vec3, b: Vec3, sag = 0.35): void => {
    // control point pulled towards the "L" corner so tubes leave chambers sideways and arrive from above
    const corner = Math.abs(a.y - b.y) > 6 ? vec(a.x, b.y, zf) : vec((a.x + b.x) / 2, Math.min(a.y, b.y) - 2.5, zf);
    const ctl = vec((a.x + b.x) / 2 + (corner.x - (a.x + b.x) / 2) * sag * 2, (a.y + b.y) / 2 + (corner.y - (a.y + b.y) / 2) * sag * 2, zf);
    const pts = bezier(a, ctl, b, 6);
    canvas.cut(chain(pts, R), 0.5);
    for (let i = 0; i + 1 < pts.length; i++) extras.tunnels.push({ a: pts[i], b: pts[i + 1], radius: R });
    props.push({ kind: 'tube', pos: a, end: b, radius: R, climbable: true, seed: lr.int(1 << 30) });
  };
  tube(A.c, B.c);
  tube(B.c, C.c);
  tube(A.c, E.c);
  tube(B.c, F.c);
  tube(C.c, F.c);
  tube(E.c, F.c);
  tube(E.c, Q.c);
  tube(F.c, G.c);
  tube(Q.c, G.c);

  // water tower: a tall reservoir chamber on the side away from the tray, fed from the middle row
  const towerX = 7.5;
  const towerLo = vec(towerX, 24, zf);
  const towerHi = vec(towerX, 43, zf);
  canvas.cut(capsule(towerLo, towerHi, 3.4), 0.5);
  const near = flip ? F : E; // whichever middle room ended up on the tower side
  tube(vec(near.c.x - near.rx + 1, near.c.y, zf), vec(towerX + 2, 38, zf), 0.2);
  extras.sites.push(site('waterTower', towerLo, 3.4, towerHi, 33));
  extras.chambers.push({ kind: 'midden', owner: 'neutral', pos: vec(towerX, 33.5, zf), radii: vec(3.4, 13, 3.4) });

  // port for a neighbouring farm's tube (rival invasion keeper event): stub from the top row to the side wall
  const portRoom = flip ? C : A;
  const port = vec(0.5, portRoom.c.y + 3, zf);
  tube(vec(portRoom.c.x - portRoom.rx + 1, portRoom.c.y, zf), vec(2.5, port.y, zf), 0.2);
  extras.sites.push(site('tubePort', port, R));

  // exit tube: granary → out of the block face, a little above the sand
  const exitY = floorY(bw, zf) + 3.2;
  const exit = vec(bw + 1.5, exitY, zf);
  tube(vec(G.c.x + G.rx - 1, G.c.y, zf), exit, 0.2);

  // ---- outworld furniture ----------------------------------------------------------------------------------------
  const dr = rng.fork('decor');
  const dishR = Math.min(6.5, tw * 0.17);
  const dx = bw + tw * 0.55 + dr.range(-2, 2);
  const dz = D * 0.62;
  const dg = floorY(dx, dz);
  // feeding dish: a low ceramic dome with a dimple
  canvas.blend(ellipsoid(vec(dx, dg + 0.3, dz), dishR, 2.3, Math.min(dishR, D * 0.3)), Mat.Rock, 1.2);
  canvas.cut(ellipsoid(vec(dx, dg + 3.1, dz), dishR * 0.72, 1.4, Math.min(dishR, D * 0.3) * 0.72), 0.8);
  const dish = vec(dx, dg + 2, dz);
  props.push({ kind: 'tray', pos: vec(bw, floorBase, 0), end: vec(W, H, D), radius: D, climbable: false, seed: dr.int(1 << 30) });
  // twig lying along the back of the tray, one end propped a little higher
  const ta = vec(bw + 8, floorY(bw + 8, 2.5) + 0.2, 2.5);
  const tb = vec(W - 5, floorY(W - 5, 4.5) + 2.2, 4.5);
  canvas.blend(displaced(capsule(ta, tb, 2.3, 2.0), (px, py, pz) => noise.n3(px * 0.4, py * 0.4, pz * 0.4), 0.25), Mat.Wood, 2.2);
  props.push({ kind: 'twig', pos: ta, end: tb, radius: 2.2, climbable: true, seed: dr.int(1 << 30) });
  for (const [px, pz, pr] of [
    [W - 7, D - 3.5, 2.7],
    [bw + tw * 0.27, D - 3, 2.3],
  ] as const) {
    const g = floorY(px, pz);
    canvas.blend(ellipsoid(vec(px, g - 0.3, pz), pr, pr * 0.8, pr), Mat.Rock, 1.6);
    props.push({ kind: 'pebble', pos: vec(px, g, pz), end: vec(px, g + pr * 0.5, pz), radius: pr, climbable: true, seed: dr.int(1 << 30) });
  }
  props.push({ kind: 'lamp', pos: vec(bw + tw / 2, H + 14, D + 10), end: dish, radius: 9, climbable: false, seed: dr.int(1 << 30) });

  // ---- commit --------------------------------------------------------------------------------------------------------
  const colony: SpawnPoint = { kind: 'colony', pos: vec(Q.c.x, Q.c.y - Q.ry + 1.1, D - 1.6), radius: Q.rx, entrance: exit, species: opts.faction };
  const foods: FoodSpawn[] = [
    { kind: 'sugar', pos: vec(dish.x - 1.5, dish.y + 0.4, dish.z), amount: 200, regen: 0.05 },
    { kind: 'seeds', pos: vec(dish.x + 2, dish.y + 0.4, dish.z + 1), amount: 150, regen: 0 },
    { kind: 'carcass', pos: vec(dx + dishR + 4, floorY(dx + dishR + 4, D - 3) + 0.6, D - 3), amount: 180, regen: 0 },
    { kind: 'fruit', pos: vec(bw + 10, floorY(bw + 10, D - 2.5) + 0.6, D - 2.5), amount: 220, regen: 0 },
  ];
  const done = finishFarm(canvas, world, colony, foods, Mat.Clay);
  extras.solidCells = done.solidCells;
  extras.slabThickness = FORMICARIUM_FRONT;
  extras.surfaceY = floorBase;
  extras.materialTints = { [Mat.Clay]: [0.9, 0.88, 0.82], [Mat.Rock]: [0.78, 0.77, 0.74] }; // cast plaster, slightly greyer where hard
  extras.sites.push(site('feedingDish', dish, dishR));
  extras.sites.push(site('dropZone', vec(dish.x, dish.y + 1, dish.z), dishR, vec(dish.x, H - 1, dish.z)));
  extras.sites.push(site('outworld', vec(bw, floorBase, 0), tw / 2, vec(W, H, D)));

  const cx = W / 2;
  const full = Math.max(88, W * 0.8);
  const tcx = bw + tw / 2;
  return {
    world,
    spawns: [colony],
    foodSources: done.foodSources,
    props,
    cameraMode: 'slab',
    environment: roomEnvironment(),
    boundary: 'glass',
    flags: farmFlags(),
    goal: { id: 'formicarium-population', kind: 'population', target: 140, label: 'Fill the formicarium: grow the colony to 140 ants' },
    cameraStart: pose([cx, 32, D + full], [cx, 32, D / 2]),
    shotPoses: {
      overview: pose([cx, 32, D + full], [cx, 32, D / 2]),
      // M3: a higher, wider view that keeps the space above the lid in frame (the keeper's hand)
      keeper: pose([cx, H + 6, D + full * 1.25], [cx, H - 10, D / 2]),
      front: pose([bw / 2, 33, D + 56], [bw / 2, 33, D]),
      chamber: pose([Q.c.x + 1, Q.c.y + 1, D + 16], [Q.c.x + 1, Q.c.y, D - 2]),
      outworld: pose([tcx + 3, floorBase + 15, D + 32], [tcx, floorBase + 4, D / 2]),
      tower: pose([towerX + 9, 34, D + 24], [towerX + 6, 34, D - 2]),
    },
    extras,
  };
}

export const formicarium: MapDef = {
  id: 'formicarium',
  name: 'Formicarium',
  kind: 'farm',
  description: 'Plaster nest block with carved chambers and tubes, a water tower, and an open outworld tray.',
  generate: generateFormicarium,
};
