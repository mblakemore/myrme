import { Mat, type MapDef, type MapGenOptions, type MapGenResultA1, type MaterialId, type Vec3 } from '../../core';
import {
  addClover,
  addCreatureSite,
  addDandelion,
  addFood,
  addGroundFood,
  addLitter,
  addLog,
  addMushroom,
  addRock,
  addStem,
  carveNest,
  count,
  createOutdoor,
  decor,
  finishOutdoor,
  ground,
  reserveNest,
  stemPoint,
  type Stem,
} from './outdoor';
import { buildHeightField, orbitPose, outdoorEnvironment, outdoorFlags, pose, site, smoothstep, vec, vlerp } from './shared';

/**
 * Meadow — the default outdoor map. Rolling soil over clay lenses and bedrock with buried
 * pebbles; moss and sand patches; two puddle basins; an antlion's sand pit; a half-buried hollow
 * log, twigs and leaf-litter mounds (termite food); grass stems, clover, a dandelion and
 * mushrooms as climbable voxels (D18); a starter nest in the centre and a rival site in a corner.
 */
export function generateMeadow(seed: number, opts: MapGenOptions): MapGenResultA1 {
  const o = createOutdoor(seed, opts, 'meadow');
  const { rng, noise, S, canvas, placer } = o;
  const c = S / 2;
  const base = 27;
  const layout = rng.fork('layout');

  // ---- layout decisions that shape the ground -------------------------------------------------
  const nestDir = 0; // entrance towards +x: a z cutaway through the centre shows the whole nest
  reserveNest(o, c, c, nestDir);
  const corner = layout.int(4);
  const rivalX = (corner & 1 ? 0.83 : 0.17) * S;
  const rivalZ = (corner & 2 ? 0.83 : 0.17) * S;
  const rivalDir = Math.atan2(c - rivalZ, c - rivalX) + layout.range(-0.4, 0.4);
  reserveNest(o, rivalX, rivalZ, rivalDir, 0.85);

  const basins: { x: number; z: number; r: number; depth: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const r = layout.range(9, 12) * Math.max(0.8, Math.sqrt(o.scale));
    const p = placer.find(layout, r + 2, { around: { x: c, z: c, min: 0.2 * S, max: 0.4 * S }, tries: 80 });
    if (p) basins.push({ ...p, r, depth: layout.range(3, 3.8) });
  }
  const pitR = 8.5;
  const pit = placer.find(layout, pitR + 4, { around: { x: c, z: c, min: 0.24 * S, max: 0.42 * S }, tries: 80 }) ?? { x: 0.2 * S, z: 0.75 * S };

  // the log's bed is chosen now (so it always fits) and built after the stems
  let logLine: { x: number; z: number }[] | null = null;
  for (let t = 0; t < 200 && !logLine; t++) {
    const a = layout.range(0, Math.PI * 2);
    const d = layout.range(0.2, 0.34) * S;
    const la = a + Math.PI / 2 + layout.range(-0.5, 0.5);
    const half = Math.min(19, 0.15 * S);
    const pts = [-1, -0.5, 0, 0.5, 1].map((k) => ({ x: c + Math.cos(a) * d + Math.cos(la) * half * k, z: c + Math.sin(a) * d + Math.sin(la) * half * k }));
    if (!pts.every((q) => placer.isFree(q.x, q.z, 7, 8))) continue;
    for (const q of pts) placer.reserve(q.x, q.z, 7.5);
    logLine = pts;
  }

  const basinAt = (x: number, z: number): number => {
    let v = 0;
    for (const b of basins) v = Math.max(v, 1 - smoothstep(0, b.r, Math.hypot(x - b.x, z - b.z)));
    return v;
  };
  const pitAt = (x: number, z: number): number => Math.hypot(x - pit.x, z - pit.z) / pitR;

  const height = (x: number, z: number): number => {
    let h = base + noise.fbm2(x * 0.011, z * 0.011, 4) * 6 + noise.fbm2(x * 0.05 + 50, z * 0.05, 3) * 1.25 + noise.n2(x * 0.14, z * 0.14 + 9) * 0.3;
    h += 2.2 * Math.exp(-((x - c) ** 2 + (z - c) ** 2) / (34 * 34)); // the nest sits on a slight rise
    for (const b of basins) h -= b.depth * (1 - smoothstep(0, b.r, Math.hypot(x - b.x, z - b.z)));
    const pd = pitAt(x, z);
    if (pd < 1.6) h += 0.7 * smoothstep(1.6, 1.0, pd) - 4.9 * smoothstep(1.0, 0.12, pd); // rim + cone
    return h;
  };
  o.hf = buildHeightField(S, S, height);

  // ---- strata ---------------------------------------------------------------------------------
  canvas.fillTerrain(o.hf, (x, y, z, depth): MaterialId => {
    if (y < 6.5 + noise.fbm2(x * 0.02 + 100, z * 0.02, 3) * 3.5) return Mat.Rock;
    if (pitAt(x, z) < 1.45 && depth < 7) return Mat.Sand;
    if (depth < 3.2 && basinAt(x, z) > 0.12) return Mat.Mud;
    if (depth < 1.6) {
      const m = noise.fbm2(x * 0.035 + 300, z * 0.035, 3);
      if (m > 0.3) return Mat.Plant; // moss carpet
      if (m < -0.5) return Mat.Sand; // bare sandy scald
    }
    if (depth > 2.2 && noise.n3(x * 0.19, y * 0.19, z * 0.19 + 77) > 0.76) return Mat.Rock; // buried pebbles
    const w = noise.fbm2(x * 0.03 - 60, z * 0.03, 2) * 3.5;
    if (depth > 8.5 + w && depth < 12 + w * 1.4) return Mat.Clay; // clay stratum
    if (depth > 4 && noise.n3(x * 0.06, y * 0.11, z * 0.06) > 0.6) return Mat.Clay; // clay lenses
    return Mat.Soil;
  });

  // ---- plants (the first three props must be climbable stems: fixtures use them) ---------------
  const pr = rng.fork('plants');
  const stems: Stem[] = [];
  {
    const a = 2.2 + pr.range(-0.3, 0.3);
    const x = c + Math.cos(a) * 11;
    const z = c + Math.sin(a) * 11;
    placer.reserve(x, z, 5);
    stems.push(addStem(o, x, z, 24, pr, { lean: 0.1, bow: 0 }));
  }
  const nStems = count(o, 14, 6);
  for (let i = 0; i < nStems; i++) {
    // every third stem joins a tuft next to an earlier one
    const mate = i % 3 === 2 ? stems[pr.int(stems.length)] : null;
    const p = placer.find(pr, 4.6, mate ? { around: { x: mate.base.x, z: mate.base.z, min: 8.5, max: 12 }, tries: 12 } : { tries: 30 });
    if (!p || basinAt(p.x, p.z) > 0.5 || pitAt(p.x, p.z) < 1.5) continue;
    stems.push(addStem(o, p.x, p.z, pr.range(13, 32), pr, { head: i % 4 === 1, bow: i < 2 ? 0 : undefined }));
  }
  const clovers: Stem[] = [];
  for (let i = 0, n = count(o, 4); i < n; i++) {
    const p = placer.find(pr, 8, { accept: (x, z) => basinAt(x, z) < 0.3 && pitAt(x, z) > 1.6 });
    if (p) clovers.push(addClover(o, p.x, p.z, pr.range(10, 15), pr));
  }
  let dandelion: Stem | null = null;
  for (let i = 0, n = o.size === 'large' ? 2 : 1; i < n; i++) {
    const p = placer.find(pr, 9, { around: { x: c, z: c, min: 0.17 * S, max: 0.33 * S }, tries: 80, accept: (x, z) => basinAt(x, z) < 0.3 && pitAt(x, z) > 1.6 });
    if (p) dandelion = addDandelion(o, p.x, p.z, pr.range(27, 31), pr);
  }

  // ---- wood, litter, rocks --------------------------------------------------------------------
  const wr = rng.fork('wood');
  let log: { a: Vec3; b: Vec3 } | null = null;
  if (logLine) {
    log = addLog(o, logLine[0], logLine[4], 6.2, wr, { hollow: true, r1: 5.8 });
    o.extras.sites.push(site('deadwood', vlerp(log.a, log.b, 0.5), 19, log.b));
  }
  for (let i = 0, n = count(o, 5, 2); i < n; i++) {
    const p = placer.find(wr, 3, { accept: (x, z) => basinAt(x, z) < 0.4 && pitAt(x, z) > 1.5 });
    if (!p) continue;
    const a = wr.range(0, Math.PI);
    const half = wr.range(6, 10);
    const q = { x: p.x + Math.cos(a) * half * 2, z: p.z + Math.sin(a) * half * 2 };
    if (!placer.isFree(q.x, q.z, 3) || !placer.isFree((p.x + q.x) / 2, (p.z + q.z) / 2, 3)) continue;
    placer.reserve(q.x, q.z, 3);
    placer.reserve((p.x + q.x) / 2, (p.z + q.z) / 2, 3);
    addLog(o, p, q, wr.range(2.1, 2.6), wr);
  }
  for (let i = 0, n = count(o, 7, 3); i < n; i++) {
    // litter gathers against the log and in hollows
    const near = log && i < 2 ? vlerp(log.a, log.b, wr.range(0.2, 0.8)) : null;
    const r = wr.range(6, 10);
    const p = near ? { x: near.x + wr.range(-1, 1) * 11, z: near.z + wr.range(-1, 1) * 11 } : placer.find(wr, r * 0.7, { reserve: r * 0.45 });
    if (p && pitAt(p.x, p.z) > 1.5 && basinAt(p.x, p.z) < 0.5 && p.x > 8 && p.z > 8 && p.x < S - 8 && p.z < S - 8) addLitter(o, p.x, p.z, r, wr);
  }
  const rr = rng.fork('rocks');
  const boulders: Vec3[] = [];
  for (let i = 0, n = count(o, 7, 3); i < n; i++) {
    const r = rr.range(3.5, 7.5);
    const p = placer.find(rr, r + 2.5, { accept: (x, z) => pitAt(x, z) > 1.7 });
    if (p) boulders.push(addRock(o, p.x, p.z, r, rr));
  }
  for (let i = 0, n = count(o, 16, 6); i < n; i++) {
    const r = rr.range(1.9, 2.8);
    const p = placer.find(rr, r + 1.5, { accept: (x, z) => pitAt(x, z) > 1.3 });
    if (p) addRock(o, p.x, p.z, r, rr, { squash: rr.range(0.7, 0.95), lift: -0.2 });
  }
  const mr = rng.fork('mushrooms');
  const mushrooms: Vec3[] = [];
  for (let i = 0, n = count(o, 4, 2); i < n; i++) {
    const near = log && i < 2 ? vlerp(log.a, log.b, i === 0 ? 0.25 : 0.7) : null;
    const p = placer.find(mr, 6.5, near ? { around: { x: near.x, z: near.z, min: 11, max: 17 }, tries: 30 } : {});
    if (p && pitAt(p.x, p.z) > 1.6) mushrooms.push(addMushroom(o, p.x, p.z, mr.range(7, 12), mr.range(5.5, 8), mr));
  }

  // ---- render-only scatter hints -----------------------------------------------------------------
  const dr = rng.fork('decor');
  for (let i = 0, n = count(o, 90, 30); i < n; i++) {
    const x = dr.range(3, S - 3);
    const z = dr.range(3, S - 3);
    if (!placer.isFree(x, z, 0.5, 2) || basinAt(x, z) > 0.45 || pitAt(x, z) < 1.3) continue;
    decor(o, 'grassPatch', x, z, dr.range(2, 5), dr);
  }
  for (let i = 0, n = count(o, 40, 12); i < n; i++) decor(o, i % 3 ? 'pebble' : 'leaf', dr.range(3, S - 3), dr.range(3, S - 3), dr.range(0.4, 1.2), dr);

  // ---- nests (after all solids) ------------------------------------------------------------------
  const nest = carveNest(o, c, c, nestDir, 'colony');
  carveNest(o, rivalX, rivalZ, rivalDir, 'rival', { scale: 0.85 });

  // ---- food ---------------------------------------------------------------------------------------
  const fr = rng.fork('food');
  const ring = (min: number, max: number): { x: number; z: number } => {
    for (let t = 0; t < 60; t++) {
      const a = fr.range(0, Math.PI * 2);
      const d = fr.range(min, max);
      const x = nest.entrance.x + Math.cos(a) * d;
      const z = nest.entrance.z + Math.sin(a) * d;
      if (placer.isFree(x, z, 2, 6) && basinAt(x, z) < 0.3 && pitAt(x, z) > 1.5) return { x, z };
    }
    return { x: c + min, z: c - min * 0.5 };
  };
  const near = Math.min(26, 0.2 * S);
  let p = ring(near * 0.7, near);
  addGroundFood(o, 'seeds', p.x, p.z, 220);
  p = ring(near, near * 1.4);
  addGroundFood(o, 'carcass', p.x, p.z, 180);
  p = ring(0.28 * S, 0.4 * S);
  addGroundFood(o, 'seeds', p.x, p.z, 160);
  p = ring(0.3 * S, 0.42 * S);
  addGroundFood(o, 'fruit', p.x, p.z, 450);
  p = ring(0.3 * S, 0.44 * S);
  addGroundFood(o, 'carcass', p.x, p.z, 260);
  // honeydew high on two stems (aphid herds, D18)
  for (const s of [stems[0], stems[Math.min(stems.length - 1, 2)]]) {
    const hp = stemPoint(s, 0.62, fr.range(0, 6.28));
    addFood(o, 'honeydew', hp, 40, 0.08);
    o.extras.sites.push(site('aphidStem', hp, s.radius, s.tip));
    addCreatureSite(o, 'aphid', hp);
  }
  if (clovers[0]) {
    addFood(o, 'leaves', vec(clovers[0].tip.x, clovers[0].tip.y + 3, clovers[0].tip.z), 200, 0.02);
    addCreatureSite(o, 'caterpillar', vec(clovers[0].tip.x + 3, clovers[0].tip.y + 3, clovers[0].tip.z));
  }

  // ---- creature sites & points of interest ----------------------------------------------------------
  const pitBottom = vec(pit.x, height(pit.x, pit.z) + 0.5, pit.z);
  addCreatureSite(o, 'antlion', pitBottom, pitR);
  o.extras.sites.push(site('antlionPit', pitBottom, pitR));
  const lair = log ? vec(log.b.x + (log.b.x - log.a.x) * 0.12, log.b.y + 1, log.b.z + (log.b.z - log.a.z) * 0.12) : ground(o, 0.7 * S, 0.3 * S);
  addCreatureSite(o, 'jumpingSpider', lair, 5);
  o.extras.sites.push(site('lair', lair, 5));
  if (boulders[0]) addCreatureSite(o, 'groundBeetle', vec(boulders[0].x + 7, boulders[0].y, boulders[0].z + 3), 4);
  for (const b of basins) {
    const bp = vec(b.x, height(b.x, b.z), b.z);
    o.extras.sites.push(site('puddle', bp, b.r, bp, bp.y + b.depth * 0.6));
  }
  if (basins[0]) addCreatureSite(o, 'worm', vec(basins[0].x + basins[0].r * 0.8, height(basins[0].x, basins[0].z) + 3, basins[0].z));
  if (dandelion) o.extras.sites.push(site('summit', dandelion.tip, 6));
  for (const m of mushrooms) o.extras.sites.push(site('summit', m, 5));
  o.extras.surfaceY = base;

  const done = finishOutdoor(o);

  const s0 = stems[0];
  const mid = vlerp(s0.base, s0.tip, 0.55);
  const e = nest.entrance;
  const w = done.world;
  const logEnd = log ? log.b : ground(o, c - 20, c + 20);
  const logYaw = log ? (Math.atan2(log.b.x - log.a.x, log.b.z - log.a.z) * 180) / Math.PI : 30;
  const tall = dandelion ?? stems[stems.length - 1];
  return {
    world: done.world,
    spawns: done.spawns.map((s) => (s.kind === 'colony' ? { ...s, species: opts.faction } : s)),
    foodSources: done.foodSources,
    props: o.props,
    cameraMode: 'rts',
    environment: outdoorEnvironment(),
    boundary: 'open',
    flags: outdoorFlags(),
    goal: { id: 'meadow-flight', kind: 'nuptialFlight', target: 150, label: 'Raise 150 ants and launch a nuptial flight' },
    cameraStart: pose([e.x + 22, e.y + 26, e.z + 34], [c + 4, base, c]),
    shotPoses: {
      overview: orbitPose(null, vec(c, base - 2, c), 28, 36, S * 0.98),
      stem: pose([mid.x + 10, mid.y + 3, mid.z + 13], [mid.x, mid.y - 1, mid.z], { fov: 40 }),
      nest: pose([nest.chamber.x + 4, nest.chamber.y + 13, nest.chamber.z + 36], [nest.chamber.x + 3, nest.chamber.y + 6, nest.chamber.z], {
        fov: 40,
        cut: { enabled: true, axis: 'z', pos: Math.round(nest.chamber.z), sign: 1 },
      }),
      // close-up of the queen chamber (the cut sits a little in front of its centre; entities in
      // the removed part stay visible, see world/cut.ts)
      queen: pose([nest.chamber.x + 1.5, nest.chamber.y + 6.5, nest.chamber.z + 18], [nest.chamber.x, nest.chamber.y + 1, nest.chamber.z], {
        fov: 40,
        cut: { enabled: true, axis: 'z', pos: Math.round(nest.chamber.z) + 2, sign: 1 },
      }),
      entrance: orbitPose(w, vec(e.x, e.y - 0.5, e.z), 38, 30, 15),
      log: orbitPose(w, vec(logEnd.x, logEnd.y + 1, logEnd.z), logYaw + 24, 10, 21, { fov: 42 }, 9),
      macro: orbitPose(w, vec(tall.base.x, tall.base.y + 11, tall.base.z), 52, -6, 36, { fov: 50 }, 8),
    },
    extras: o.extras,
  };
}

export const meadow: MapDef = {
  id: 'meadow',
  name: 'Meadow',
  kind: 'outdoor',
  description: 'Sunlit grassland: soft soil, tall stems, clover, a hollow log and a puddle or two.',
  generate: generateMeadow,
};
