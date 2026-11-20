import {
  Mat,
  SeededRng,
  type CreatureId,
  type FoodKind,
  type FoodSpawn,
  type MapExtras,
  type MapGenOptions,
  type MapSizePreset,
  type MaterialId,
  type PropDef,
  type PropKind,
  type SpawnPoint,
  type Vec3,
  type VoxelWorld,
} from '../../core';
import { createWorld } from '../VoxelWorld';
import { createNoise, type Noise } from '../noise';
import {
  OUTDOOR_HEIGHT,
  OUTDOOR_SIZE,
  Placer,
  Reach,
  SdfCanvas,
  capsule,
  clipPlane,
  clipY,
  bezier,
  chain,
  displaced,
  ellipsoid,
  newExtras,
  settleFood,
  site,
  sizePreset,
  unionOf,
  vec,
  vlerp,
  type HeightField,
  type Shape,
} from './shared';

/**
 * Shared scaffolding of the three outdoor maps: canvas + placement bookkeeping, voxel props
 * (rocks, logs, litter, plants, mushrooms — all climbable, D18), nests and the post-commit
 * reachability pass. Each map file supplies its own heightfield, strata and layout.
 */
export interface Outdoor {
  readonly rng: SeededRng;
  readonly noise: Noise;
  readonly size: MapSizePreset;
  /** Horizontal world size. */
  readonly S: number;
  readonly H: number;
  /** S / 160 — multiply distances that should scale with the map. */
  readonly scale: number;
  /** scale² — multiply prop counts. */
  readonly area: number;
  readonly canvas: SdfCanvas;
  readonly placer: Placer;
  readonly props: PropDef[];
  readonly foods: FoodSpawn[];
  readonly spawns: SpawnPoint[];
  readonly extras: MapExtras;
  hf: HeightField;
}

export function createOutdoor(seed: number, opts: MapGenOptions, label: string): Outdoor {
  const rng = new SeededRng(seed).fork(label);
  const size = sizePreset(opts);
  const S = OUTDOOR_SIZE[size];
  const H = OUTDOOR_HEIGHT;
  return {
    rng,
    noise: createNoise(rng.fork('noise')),
    size,
    S,
    H,
    scale: S / 160,
    area: (S / 160) ** 2,
    canvas: new SdfCanvas(S, H, S),
    placer: new Placer(S, S),
    props: [],
    foods: [],
    spawns: [],
    extras: newExtras(size),
    hf: null as unknown as HeightField,
  };
}

/** Number of props for the current map size (at least `min`). */
export function count(o: Outdoor, atMedium: number, min = 1): number {
  return Math.max(min, Math.round(atMedium * o.area));
}

export function ground(o: Outdoor, x: number, z: number): Vec3 {
  return { x, y: o.hf.at(x, z), z };
}

function prop(o: Outdoor, kind: PropKind, pos: Vec3, end: Vec3, radius: number, climbable: boolean, rng: SeededRng): PropDef {
  const p: PropDef = { kind, pos: { ...pos }, end: { ...end }, radius, climbable, seed: rng.int(1 << 30) };
  o.props.push(p);
  return p;
}

/** Render-only decoration hint (grass tufts, loose leaves, grit). */
export function decor(o: Outdoor, kind: PropKind, x: number, z: number, radius: number, rng: SeededRng): void {
  const p = { x, y: o.canvas.topY(x, z), z };
  prop(o, kind, p, p, radius, false, rng);
}

// ---- rocks, wood, litter ---------------------------------------------------------------------

/**
 * A boulder / pebble. The centre sits slightly below ground so the junction with the soil stays
 * obtuse, and the smooth union fillets it.
 */
export function addRock(o: Outdoor, x: number, z: number, r: number, rng: SeededRng, q: { squash?: number; lift?: number; mat?: MaterialId | ((x: number, y: number, z: number) => MaterialId); kind?: PropKind; mossy?: boolean } = {}): Vec3 {
  const g = o.hf.at(x, z);
  const squash = q.squash ?? rng.range(0.6, 0.9);
  const ry = r * squash;
  const c = vec(x, g + ry * (q.lift ?? -0.12), z);
  const rx = r * rng.range(0.85, 1.2);
  const rz = r * rng.range(0.85, 1.2);
  const ox = rng.range(0, 100);
  const f = 1.1 / r;
  const n = o.noise;
  const shape = displaced(ellipsoid(c, rx, ry, rz), (px, py, pz) => n.n3(px * f + ox, py * f, pz * f), Math.min(1.2, r * 0.13));
  const mossLine = c.y + ry * 0.45;
  const mat = q.mossy ? (px: number, py: number, pz: number): MaterialId => (py > mossLine + n.n2(px * 0.2, pz * 0.2) * 1.5 ? Mat.Plant : Mat.Rock) : (q.mat ?? Mat.Rock);
  o.canvas.blend(shape, mat, Math.min(2.6, 1 + r * 0.3));
  const top = vec(x, c.y + ry, z);
  prop(o, q.kind ?? (r < 3 ? 'pebble' : 'rock'), vec(x, g, z), top, r, true, rng);
  return top;
}

/** A log / twig lying on the ground between two points, sunk so that it does not undercut. */
export function addLog(o: Outdoor, a: { x: number; z: number }, b: { x: number; z: number }, r: number, rng: SeededRng, q: { hollow?: boolean; kind?: PropKind; lift?: number; r1?: number } = {}): { a: Vec3; b: Vec3 } {
  const lift = q.lift ?? -0.05;
  const r1 = q.r1 ?? r * 0.9;
  const pa = vec(a.x, o.hf.at(a.x, a.z) + r * lift, a.z);
  const pb = vec(b.x, o.hf.at(b.x, b.z) + r1 * lift, b.z);
  const n = o.noise;
  const ox = rng.range(0, 100);
  const l = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
  const dir = vec((pb.x - pa.x) / l, (pb.y - pa.y) / l, (pb.z - pa.z) / l);
  const bark = (px: number, py: number, pz: number): number => n.n3(px * 0.35 + ox, py * 0.5, pz * 0.35);
  if (q.hollow && r >= 5) {
    // Broken-off end at `b` (flat, so the wall keeps its thickness) with a rotted core: a gallery
    // inside the wood that ants can walk into.
    const beyond = vec(pb.x + dir.x * (r1 + 2), pb.y + dir.y * (r1 + 2), pb.z + dir.z * (r1 + 2));
    const body = clipPlane(displaced(capsule(pa, beyond, r, r1), bark, Math.min(0.45, r * 0.09)), pb, dir, 0.7);
    o.canvas.blend(body, Mat.Wood, 2.8);
    const from = vlerp(pa, pb, 0.3);
    const up = r * 0.12;
    o.canvas.cut(capsule(vec(from.x, from.y + up, from.z), vec(beyond.x + dir.x * 3, beyond.y + up + dir.y * 3, beyond.z + dir.z * 3), r - 3, r1 - 2.8), 0.7);
  } else {
    o.canvas.blend(displaced(capsule(pa, pb, r, r1), bark, Math.min(0.45, r * 0.09)), Mat.Wood, 2.8);
  }
  prop(o, q.kind ?? (r < 3 ? 'twig' : 'log'), pa, pb, r, true, rng);
  return { a: pa, b: pb };
}

/**
 * A hoop of wood (or rock) springing out of the ground at `a` and diving back in at `b`: root
 * arches, bowed branches, natural rock arches. Both feet are sunk and enter steeply, so the
 * junctions stay obtuse. Returns the apex.
 */
export function addArch(o: Outdoor, a: { x: number; z: number }, b: { x: number; z: number }, rise: number, r0: number, r1: number, mat: MaterialId, rng: SeededRng, kind: PropKind = 'log'): Vec3 {
  const ga = o.hf.at(a.x, a.z);
  const gb = o.hf.at(b.x, b.z);
  const pa = vec(a.x, ga - 4.5, a.z);
  const pb = vec(b.x, gb - 4.5, b.z);
  const apexY = Math.min(o.H - 4 - r0, Math.max(ga, gb) + rise);
  const mx = (a.x + b.x) / 2 + rng.range(-2, 2);
  const mz = (a.z + b.z) / 2 + rng.range(-2, 2);
  const ctl = vec(mx, 2 * apexY - (pa.y + pb.y) / 2, mz);
  const n = o.noise;
  const ox = rng.range(0, 100);
  const shape = displaced(chain(bezier(pa, ctl, pb, 9), r0, r1), (px, py, pz) => n.n3(px * 0.3 + ox, py * 0.3, pz * 0.3), Math.min(0.4, r1 * 0.12));
  o.canvas.blend(shape, mat, 2.6);
  const apex = vec(mx, apexY, mz);
  prop(o, kind, vec(a.x, ga, a.z), apex, r0, true, rng);
  prop(o, kind, apex, vec(b.x, gb, b.z), r1, true, rng);
  return apex;
}

/** A low mound of leaf litter (termite food): a few overlapping lenses. */
export function addLitter(o: Outdoor, x: number, z: number, r: number, rng: SeededRng, thick = 1.7): void {
  const lenses: Shape[] = [];
  const k = 2 + rng.int(3);
  for (let i = 0; i < k; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = i === 0 ? 0 : rng.range(0.3, 0.75) * r;
    const lx = x + Math.cos(a) * d;
    const lz = z + Math.sin(a) * d;
    const lr = r * rng.range(0.55, 0.9);
    lenses.push(ellipsoid(vec(lx, o.hf.at(lx, lz) - 0.25 + i * 0.25, lz), lr, thick * rng.range(0.85, 1.25), lr * rng.range(0.7, 1)));
  }
  const n = o.noise;
  o.canvas.blend(displaced(unionOf(lenses, 1.2), (px, py, pz) => n.n3(px * 0.4, py * 0.4, pz * 0.4 + 31), 0.3), Mat.LeafLitter, 1.6);
  prop(o, 'leaf', ground(o, x, z), ground(o, x, z), r, true, rng);
  for (let i = 0; i < 4; i++) decor(o, 'leaf', x + rng.range(-1.3, 1.3) * r, z + rng.range(-1.3, 1.3) * r, rng.range(1.5, 3), rng);
}

// ---- plants (all Mat.Plant / Mat.Fungus voxels; thin leaves are A3's render-only job) -----------

export interface Stem {
  base: Vec3;
  tip: Vec3;
  radius: number;
  prop: PropDef;
}

/** Surface point on a stem at parameter t (0 = ground, 1 = tip), on the side given by `angle`. */
export function stemPoint(s: Stem, t: number, angle: number): Vec3 {
  const p = vlerp(s.base, s.tip, t);
  return vec(p.x + Math.cos(angle) * (s.radius + 0.5), p.y, p.z + Math.sin(angle) * (s.radius + 0.5));
}

/**
 * A grass stem: tapered, gently bowed, rooted 3.5 voxels deep with a flared base; optionally
 * carrying a seed head. (Leaf blades are too thin for voxels — A3 adds them as render-only decor.)
 */
export function addStem(
  o: Outdoor,
  x: number,
  z: number,
  height: number,
  rng: SeededRng,
  q: { r0?: number; r1?: number; lean?: number; bow?: number; head?: boolean; mat?: MaterialId; kind?: PropKind } = {},
): Stem {
  const g = o.hf.at(x, z);
  const r0 = q.r0 ?? rng.range(1.9, 2.35);
  const r1 = q.r1 ?? Math.max(1.6, r0 * 0.74);
  const la = rng.range(0, Math.PI * 2);
  const lean = (q.lean ?? rng.range(0.04, 0.22)) * height;
  const top = Math.min(o.H - (q.head ? 9 : 5), g + height);
  const root = vec(x, g - 3.5, z);
  const tip = vec(x + Math.cos(la) * lean, top, z + Math.sin(la) * lean);
  // a gentle bow (the stem stays within ~1.5 voxels of the straight root→tip segment)
  const bow = q.bow ?? rng.range(0, 3);
  const ba = la + rng.range(-1, 1);
  const ctl = vec((root.x + tip.x) / 2 - Math.cos(ba) * bow, (root.y + tip.y) / 2, (root.z + tip.z) / 2 - Math.sin(ba) * bow);
  const parts: Shape[] = [chain(bezier(root, ctl, tip, 6), r0, r1)];
  let end = tip;
  if (q.head) {
    // seed head: a plump spike the stem carries at its tip
    const hl = rng.range(4.5, 6);
    const dy = tip.y - root.y;
    const hc = vec(tip.x + ((tip.x - root.x) / dy) * hl * 0.8, tip.y + hl * 0.8, tip.z + ((tip.z - root.z) / dy) * hl * 0.8);
    parts.push(ellipsoid(hc, 2.9, hl, 2.9));
    end = vec(hc.x, hc.y + hl, hc.z);
  }
  o.canvas.blend(parts.length > 1 ? unionOf(parts, 1.6) : parts[0], q.mat ?? Mat.Plant, 2.6);
  const base = vlerp(root, tip, 3.5 / (tip.y - root.y));
  const radius = (r0 + r1) / 2;
  return { base, tip: end, radius, prop: prop(o, q.kind ?? 'stem', base, tip, radius, true, rng) };
}

/** Clover: a stem carrying three thick round leaflets — a platform in the canopy. */
export function addClover(o: Outdoor, x: number, z: number, height: number, rng: SeededRng): Stem {
  const g = o.hf.at(x, z);
  const root = vec(x, g - 3.5, z);
  const tip = vec(x + rng.range(-1.5, 1.5), Math.min(o.H - 7, g + height), z + rng.range(-1.5, 1.5));
  const parts: Shape[] = [capsule(root, tip, 2.2, 1.9)];
  const a0 = rng.range(0, Math.PI * 2);
  const lr = rng.range(4.2, 5);
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i * Math.PI * 2) / 3;
    parts.push(ellipsoid(vec(tip.x + Math.cos(a) * lr * 0.95, tip.y + 0.6, tip.z + Math.sin(a) * lr * 0.95), lr, 1.75, lr));
  }
  o.canvas.blend(unionOf(parts, 1.6), Mat.Plant, 2.6);
  const base = vlerp(root, tip, 3.5 / (tip.y - root.y));
  const p = prop(o, 'stem', base, tip, 2.05, true, rng);
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i * Math.PI * 2) / 3;
    const c = vec(tip.x + Math.cos(a) * lr * 0.95, tip.y + 0.6, tip.z + Math.sin(a) * lr * 0.95);
    prop(o, 'leaf', c, c, lr, true, rng);
  }
  return { base, tip, radius: 2.05, prop: p };
}

/** Dandelion: the tallest thing on the map, a thick scape with a flower-head disc. */
export function addDandelion(o: Outdoor, x: number, z: number, height: number, rng: SeededRng): Stem {
  const g = o.hf.at(x, z);
  const root = vec(x, g - 4, z);
  const tip = vec(x + rng.range(-2.5, 2.5), Math.min(o.H - 8, g + height), z + rng.range(-2.5, 2.5));
  const head = ellipsoid(vec(tip.x, tip.y + 1.6, tip.z), 6, 3.2, 6);
  o.canvas.blend(unionOf([capsule(root, tip, 2.6, 2.1), head], 2), Mat.Plant, 2.8);
  const base = vlerp(root, tip, 4 / (tip.y - root.y));
  const p = prop(o, 'stem', base, tip, 2.35, true, rng);
  const top = vec(tip.x, tip.y + 4.8, tip.z);
  prop(o, 'flower', vec(tip.x, tip.y + 1.6, tip.z), top, 6, true, rng);
  return { base, tip: top, radius: 2.35, prop: p };
}

/** Mushroom: stalk + domed cap (Fungus — edible to ants). Returns the cap top. */
export function addMushroom(o: Outdoor, x: number, z: number, height: number, capR: number, rng: SeededRng): Vec3 {
  const g = o.canvas.topY(x, z);
  const root = vec(x, g - 3, z);
  const top = vec(x + rng.range(-1, 1), Math.min(o.H - 6 - capR * 0.6, g + height), z + rng.range(-1, 1));
  const cap = clipY(ellipsoid(vec(top.x, top.y - 0.4, top.z), capR, capR * 0.66, capR * rng.range(0.9, 1.05)), top.y - 1.1, true, 0.9);
  o.canvas.blend(unionOf([capsule(root, top, 2.5, 2.0), cap], 1.4), Mat.Fungus, 2.4);
  const capTop = vec(top.x, top.y - 0.4 + capR * 0.66, top.z);
  prop(o, 'mushroom', vec(x, g, z), capTop, capR, true, rng);
  return capTop;
}

/** Dry desert scrub: a short woody trunk that forks into a few stiff twigs. */
export function addShrub(o: Outdoor, x: number, z: number, height: number, rng: SeededRng): Stem {
  const g = o.hf.at(x, z);
  const root = vec(x, g - 3.5, z);
  const fork = vec(x + rng.range(-1, 1), g + height * 0.24, z + rng.range(-1, 1));
  const parts: Shape[] = [capsule(root, fork, 2.5, 2.2)];
  const n = 3 + rng.int(2);
  const a0 = rng.range(0, Math.PI * 2);
  let best: Vec3 = fork;
  for (let i = 0; i < n; i++) {
    // stiff twigs that sweep out and then up
    const a = a0 + (i * Math.PI * 2) / n + rng.range(-0.3, 0.3);
    const len = height * rng.range(0.75, 1.05);
    const spread = rng.range(0.5, 0.75);
    const ox = Math.cos(a);
    const oz = Math.sin(a);
    const elbow = vec(fork.x + ox * len * spread * 0.75, fork.y + len * 0.3, fork.z + oz * len * spread * 0.75);
    const tip = vec(fork.x + ox * len * spread, Math.min(o.H - 5, fork.y + len * 0.85), fork.z + oz * len * spread);
    parts.push(chain(bezier(fork, elbow, tip, 5), 1.95, 1.6));
    if (tip.y > best.y) best = tip;
    prop(o, 'twig', fork, tip, 1.8, true, rng);
  }
  o.canvas.blend(unionOf(parts, 1.8), Mat.Wood, 2.6);
  const base = vlerp(root, fork, 3.5 / (fork.y - root.y));
  return { base, tip: best, radius: 2.2, prop: prop(o, 'stem', base, fork, 2.4, true, rng) };
}

// ---- nests -----------------------------------------------------------------------------------

export interface Nest {
  chamber: Vec3;
  radii: Vec3;
  /** Top of the entrance shaft (in the crater of the mound). */
  entrance: Vec3;
  spawn: SpawnPoint;
}

/**
 * Starter nest: crater mound → inclined shaft → gallery → queen chamber, all in one vertical
 * plane through `dir` so a single cutaway shows the whole run. `scale` 1 fits ~30 ants.
 * Call after every solid has been placed; it also softens the surrounding ground to `soil`.
 */
export function carveNest(o: Outdoor, cx: number, cz: number, dir: number, kind: 'colony' | 'rival', q: { scale?: number; soil?: MaterialId; depth?: number; side?: boolean } = {}): Nest {
  const s = q.scale ?? 1;
  const soil = q.soil ?? Mat.Soil;
  const dx = Math.cos(dir);
  const dz = Math.sin(dir);
  const reach = 14 * s;
  const ex = cx + dx * reach;
  const ez = cz + dz * reach;
  const eg = o.hf.at(ex, ez);
  const g0 = Math.min(o.hf.at(cx, cz), eg);
  const depth = q.depth ?? 13.5;
  const radii = vec(7 * s, Math.max(3.6, 4.5 * s), 6 * s);
  const chamber = vec(cx, Math.max(8 + radii.y, g0 - depth * Math.max(s, 0.85)), cz);
  const R = 2.05;

  // soften: no rock or clay around the nest or below it (ants must be able to extend it)
  const pad = radii.x + 9;
  o.canvas.paint({ x0: Math.min(cx, ex) - pad, x1: Math.max(cx, ex) + pad, z0: Math.min(cz, ez) - pad, z1: Math.max(cz, ez) + pad, y0: 0, y1: o.H - 1 }, (_x, _y, _z, m) =>
    m === Mat.Rock || m === Mat.Clay ? soil : -1,
  );

  // crater mound of excavated spoil
  o.canvas.blend(ellipsoid(vec(ex, eg - 0.4, ez), 6.2, 2.5, 6.2), soil, 2.2);

  const at = (d: number, y: number): Vec3 => vec(cx + dx * d, y, cz + dz * d);
  const mouth = at(reach + 1.2, eg + 4.2);
  const p1 = at(reach - 4.5, eg - 5.5);
  const p2 = at(radii.x + 2.5, chamber.y + 2.2);
  const p3 = at(radii.x - 3, chamber.y + 0.3);
  // safety: nothing may roof over the mouth (keeps the nest connected whatever the layout did)
  o.canvas.cut(capsule(vec(mouth.x, mouth.y + 1, mouth.z), vec(mouth.x + dx * 2, o.H + 4, mouth.z + dz * 2), 2.6, 4), 0.8);
  const tunnel: Vec3[] = [mouth, p1, p2, p3];
  for (let i = 0; i + 1 < tunnel.length; i++) {
    o.canvas.cut(capsule(tunnel[i], tunnel[i + 1], R), 0.9);
    o.extras.tunnels.push({ a: tunnel[i], b: tunnel[i + 1], radius: R });
  }
  o.canvas.cut(ellipsoid(chamber, radii.x, radii.y, radii.z), 0.9);
  o.extras.chambers.push({ kind: 'queen', owner: kind, pos: chamber, radii });
  o.extras.chambers.push({ kind: 'entrance', owner: kind, pos: vec(ex, eg + 1.5, ez), radii: vec(R, R, R) });

  if (q.side ?? kind === 'colony') {
    // a side pocket opposite the entrance gallery (first granary)
    const c2 = at(-(radii.x + 6.5), chamber.y + 1.6);
    const r2 = vec(4.4, 2.9, 4.2);
    o.canvas.cut(capsule(at(-(radii.x - 2), chamber.y + 0.4), c2, R), 0.9);
    o.canvas.cut(ellipsoid(c2, r2.x, r2.y, r2.z), 0.9);
    o.extras.chambers.push({ kind: 'granary', owner: kind, pos: c2, radii: r2 });
    o.extras.tunnels.push({ a: at(-(radii.x - 2), chamber.y + 0.4), b: c2, radius: R });
  }

  const entrance = vec(ex, eg + 2.4, ez);
  const spawn: SpawnPoint = { kind, pos: vec(chamber.x, chamber.y - radii.y + 1.1, chamber.z), radius: radii.x, entrance };
  o.spawns.push(spawn);
  return { chamber, radii, entrance, spawn };
}

/** Reserve the ground a nest will need (call before placing props; carve the nest afterwards). */
export function reserveNest(o: Outdoor, cx: number, cz: number, dir: number, scale = 1): void {
  const reach = 14 * scale;
  o.placer.reserve(cx + Math.cos(dir) * reach, cz + Math.sin(dir) * reach, 9);
  o.placer.reserve(cx + Math.cos(dir) * reach * 0.5, cz + Math.sin(dir) * reach * 0.5, 6);
  o.placer.reserve(cx, cz, 5);
}

// ---- food & creatures ------------------------------------------------------------------------

export function addFood(o: Outdoor, kind: FoodKind, pos: Vec3, amount: number, regen = 0): void {
  o.foods.push({ kind, pos: { ...pos }, amount, regen });
}

/** Food resting on whatever is the top surface at (x, z). */
export function addGroundFood(o: Outdoor, kind: FoodKind, x: number, z: number, amount: number, regen = 0): void {
  addFood(o, kind, vec(x, o.canvas.topY(x, z) + 0.5, z), amount, regen);
}

export function addCreatureSite(o: Outdoor, creature: CreatureId, pos: Vec3, radius = 0): void {
  o.spawns.push({ kind: 'creature', pos: { ...pos }, radius, entrance: null, creature });
}

// ---- finish ----------------------------------------------------------------------------------

export interface Finished {
  world: VoxelWorld;
  reach: Reach;
  foodSources: FoodSpawn[];
  spawns: SpawnPoint[];
}

/**
 * Commit the canvas and make the result playable: entrances, food and creature sites are snapped
 * onto walkable cells connected to the player nest; unreachable food is dropped.
 */
export function finishOutdoor(o: Outdoor, fallback: MaterialId = Mat.Soil): Finished {
  const world = createWorld(o.S, o.H, o.S, 'open');
  o.extras.solidCells = o.canvas.commit(world, fallback);
  const colony = o.spawns.find((s) => s.kind === 'colony')!;
  const reach = new Reach(world, colony.pos);
  const spawns: SpawnPoint[] = [];
  for (const s of o.spawns) {
    if (s.kind === 'creature') {
      if (!reach.snap(s.pos, 10)) continue;
    } else if (s.entrance) reach.snap(s.entrance, 6);
    spawns.push(s);
  }
  for (const st of o.extras.sites) if (st.kind === 'aphidStem' || st.kind === 'lair') reach.snap(st.pos, 6);
  return { world, reach, foodSources: settleFood(reach, o.foods, 10), spawns };
}

export { site };
