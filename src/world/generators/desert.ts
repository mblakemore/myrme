import { Mat, type MapDef, type MapGenOptions, type MapGenResultA1, type MaterialId, type Vec3 } from '../../core';
import {
  addArch,
  addCreatureSite,
  addFood,
  addGroundFood,
  addLog,
  addRock,
  addShrub,
  addStem,
  carveNest,
  count,
  createOutdoor,
  decor,
  finishOutdoor,
  ground,
  reserveNest,
  stemPoint,
  type Outdoor,
  type Stem,
} from './outdoor';
import { buildHeightField, capsule, desertEnvironment, displaced, ellipsoid, lerp, orbitPose, outdoorFlags, pose, site, smoothstep, unionOf, vec } from './shared';
import type { SeededRng } from '../../core';

/**
 * Desert — wind-rippled sand dunes with gentle windward slopes and steep slip faces, a cracked
 * clay pan, sandstone outcrops with a hoodoo, a ledge and a natural arch (overhangs to crawl
 * under), a field of antlion pits, dry scrub and barrel cacti. Food is scarce and far away.
 */
export function generateDesert(seed: number, opts: MapGenOptions): MapGenResultA1 {
  const o = createOutdoor(seed, opts, 'desert');
  const { rng, noise, S, canvas, placer } = o;
  const c = S / 2;
  const base = 20;
  const layout = rng.fork('layout');

  // ---- layout -------------------------------------------------------------------------------------
  const nestDir = 0;
  reserveNest(o, c, c, nestDir);
  const wind = layout.range(0, Math.PI * 2);
  const ux = Math.cos(wind);
  const uz = Math.sin(wind);

  // three sectors around the nest: clay pan, pit field, rival; outcrops go in between
  const a0 = layout.range(0, Math.PI * 2);
  const panA = a0;
  const pitA = a0 + (Math.PI * 2) / 3 + layout.range(-0.25, 0.25);
  const rivA = a0 + (Math.PI * 4) / 3 + layout.range(-0.25, 0.25);
  const clampXZ = (v: number): number => Math.min(S - 0.19 * S, Math.max(0.19 * S, v));
  const ent = { x: c + 14, z: c };
  // a spot in direction `a`, pushed out to distance `d` but kept `keep` voxels away from the nest entrance
  const spot = (a: number, d: number, keep: number): { x: number; z: number } => {
    for (let t = 0; t < 16; t++) {
      const aa = a + (t % 2 ? -1 : 1) * Math.ceil(t / 2) * 0.35;
      const p = { x: clampXZ(c + Math.cos(aa) * d), z: clampXZ(c + Math.sin(aa) * d) };
      if (Math.hypot(p.x - ent.x, p.z - ent.z) >= keep && Math.hypot(p.x - c, p.z - c) >= keep) return p;
    }
    return { x: clampXZ(c - d), z: clampXZ(c + (Math.sin(a) < 0 ? -d : d)) }; // the corner behind the nest
  };
  const panR = 0.19 * S;
  const pan = spot(panA, 0.3 * S, panR * 0.9);
  const panLevel = base - 1.5;
  placer.reserve(pan.x, pan.z, panR * 0.8);
  const fieldR = Math.max(17, 0.13 * S);
  const field = spot(pitA, 0.31 * S, fieldR + 9);
  placer.reserve(field.x, field.z, fieldR);
  const pits: { x: number; z: number; r: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const a = layout.range(0, 6.28) + (i * Math.PI * 2) / 3;
    const d = i === 0 ? 0 : fieldR * 0.62;
    pits.push({ x: field.x + Math.cos(a) * d, z: field.z + Math.sin(a) * d, r: i === 0 ? 9 : layout.range(5.8, 7) });
  }
  const rival = spot(rivA, 0.37 * S, 0.3 * S);
  const rivalX = rival.x;
  const rivalZ = rival.z;
  const rivalDir = Math.atan2(c - rivalZ, c - rivalX) + layout.range(-0.4, 0.4);
  reserveNest(o, rivalX, rivalZ, rivalDir, 0.85);
  placer.reserve(rivalX, rivalZ, 12);

  const outcrops: { x: number; z: number }[] = [];
  for (let i = 0, n = o.size === 'small' ? 1 : 2; i < n; i++) {
    const a = (i === 0 ? (panA + pitA) / 2 : (pitA + rivA) / 2) + layout.range(-0.2, 0.2);
    const p = spot(a, (i === 0 ? 0.33 : 0.36) * S, 36);
    if (Math.hypot(p.x - rivalX, p.z - rivalZ) < 30) continue; // never bury the rival's entrance
    outcrops.push(p);
    placer.reserve(p.x, p.z, 25);
  }

  const panW = (x: number, z: number): number => {
    const d = Math.hypot(x - pan.x, z - pan.z) + noise.n2(x * 0.03, z * 0.03 + 40) * 5;
    return 1 - smoothstep(panR * 0.72, panR * 1.12, d);
  };
  const flatW = (x: number, z: number): number => {
    // 1 where dunes are suppressed: pit field, nest surroundings, outcrop feet
    let w = 1 - smoothstep(fieldR * 0.8, fieldR * 1.25, Math.hypot(x - field.x, z - field.z));
    w = Math.max(w, 1 - smoothstep(6, 22, Math.hypot(x - c - 7, z - c)));
    w = Math.max(w, 1 - smoothstep(6, 22, Math.hypot(x - rivalX, z - rivalZ)));
    for (const oc of outcrops) w = Math.max(w, 0.6 * (1 - smoothstep(8, 22, Math.hypot(x - oc.x, z - oc.z))));
    return w;
  };
  const cell = { f1: 0, edge: 0, id: 0 };
  const height = (x: number, z: number): number => {
    const along = x * ux + z * uz;
    const pw = panW(x, z);
    const amp = (0.62 + 0.38 * noise.n2(x * 0.008 + 7, z * 0.008)) * 11 * (1 - flatW(x, z));
    const phase = along / 46 + noise.fbm2(x * 0.007, z * 0.007 + 3, 2) * 1.3;
    const s = phase - Math.floor(phase);
    const prof = s < 0.66 ? smoothstep(0, 0.66, s) : 1 - smoothstep(0.66, 1, s);
    const ripple = 0.34 * (1 - pw) * Math.sin(along * 1.2 + noise.n2(x * 0.04, z * 0.04) * 3); // wind ripples, crest to crest ≈ 5 voxels
    let h = base + amp * prof + ripple + noise.fbm2(x * 0.02 + 90, z * 0.02, 3) * 1.6;
    if (pw > 0) {
      noise.cell2(x / 8.5, z / 8.5, cell);
      const e = cell.edge * 8.5;
      const plate = panLevel + (cell.id - 0.5) * 0.35 - 0.95 * (1 - smoothstep(0, 1.8, e)) + 0.2 * smoothstep(0.5, 3.5, e); // curled plates, V cracks
      h = lerp(h, plate, pw);
    }
    for (const p of pits) {
      const d = Math.hypot(x - p.x, z - p.z) / p.r;
      if (d < 1.6) h += 0.6 * smoothstep(1.6, 1.0, d) - p.r * 0.58 * smoothstep(1.0, 0.1, d);
    }
    return h;
  };
  o.hf = buildHeightField(S, S, height);

  canvas.fillTerrain(o.hf, (x, y, z, depth): MaterialId => {
    let bed = 6 + noise.fbm2(x * 0.02 + 100, z * 0.02, 3) * 3.5;
    for (const oc of outcrops) bed += 15 * Math.exp(-((x - oc.x) ** 2 + (z - oc.z) ** 2) / (15 * 15));
    if (y < bed) return Mat.Rock;
    const pw = panW(x, z);
    if (pw > 0.45 && depth < 5.5) return Mat.Clay;
    const w = noise.fbm2(x * 0.025 - 60, z * 0.025, 2) * 3;
    if (depth > 2.5 && noise.n3(x * 0.2, y * 0.2, z * 0.2 + 77) > 0.83) return Mat.Rock;
    if (depth < 11 + w) return Mat.Sand;
    return Math.sin((y + w) * 0.7) > 0.2 ? Mat.Clay : Mat.Soil; // banded hardpan under the sand
  });

  // ---- plants first (fixtures use the first three climbable props) -----------------------------------
  const pr = rng.fork('plants');
  const stems: Stem[] = [];
  {
    const a = 2.3 + pr.range(-0.3, 0.3);
    const x = c + Math.cos(a) * 12;
    const z = c + Math.sin(a) * 12;
    placer.reserve(x, z, 5);
    stems.push(addStem(o, x, z, 21, pr, { lean: 0.12, bow: 0, head: true }));
  }
  for (let i = 0, n = count(o, 5, 2); i < n; i++) {
    const p = placer.find(pr, 5, { accept: (x, z) => panW(x, z) < 0.2 });
    if (p) stems.push(addStem(o, p.x, p.z, pr.range(13, 24), pr, { head: i % 2 === 0, bow: i < 2 ? 0 : undefined }));
  }
  const shrubs: Stem[] = [];
  for (let i = 0, n = count(o, 5, 2); i < n; i++) {
    const p = placer.find(pr, 7, { tries: 150, accept: (x, z) => panW(x, z) < 0.3 });
    if (p) shrubs.push(addShrub(o, p.x, p.z, pr.range(13, 19), pr));
  }
  const cacti: Vec3[] = [];
  for (let i = 0, n = count(o, 3, 1); i < n; i++) {
    const p = placer.find(pr, 8, { around: { x: c, z: c, min: 0.22 * S, max: 0.44 * S }, tries: 60, accept: (x, z) => panW(x, z) < 0.2 });
    if (p) cacti.push(addCactus(o, p.x, p.z, pr.range(4.6, 5.8), pr));
  }

  // ---- sandstone outcrops ---------------------------------------------------------------------------
  const rr = rng.fork('rocks');
  const hoodoos: Vec3[] = [];
  const ledges: Vec3[] = [];
  const archTops: Vec3[] = [];
  outcrops.forEach((oc, i) => {
    const rough = (px: number, py: number, pz: number): number => noise.n3(px * 0.13 + i * 20, py * 0.3, pz * 0.13); // bedding: more detail vertically
    const g = height(oc.x, oc.z);
    const mr = rr.range(11, 13.5);
    const top = addRock(o, oc.x, oc.z, mr, rr, { squash: 0.62, lift: -0.05 });
    // a ledge jutting out of the massif: a roof to shelter under
    const la = rr.range(0, 6.28);
    const lc = vec(oc.x + Math.cos(la) * mr * 0.72, g + mr * 0.62 * 0.72, oc.z + Math.sin(la) * mr * 0.72);
    canvas.blend(displaced(ellipsoid(lc, 9.5, 2.5, 7), rough, 0.5), Mat.Rock, 2);
    ledges.push(vec(oc.x + Math.cos(la) * (mr + 4), g + 1, oc.z + Math.sin(la) * (mr + 4)));
    // hoodoo: a capstone balanced on a waisted pillar
    const ha = la + Math.PI * rr.range(0.65, 0.95);
    const hx = oc.x + Math.cos(ha) * (mr + 5);
    const hz = oc.z + Math.sin(ha) * (mr + 5);
    const hg = height(hx, hz);
    const hh = rr.range(12, 16);
    const pillar = capsule(vec(hx, hg - 4, hz), vec(hx + rr.range(-1, 1), hg + hh, hz + rr.range(-1, 1)), 4.4, 3.1);
    const cap = ellipsoid(vec(hx, hg + hh + 1.2, hz), rr.range(8, 9.5), 3.6, rr.range(7, 8.5));
    canvas.blend(displaced(unionOf([pillar, cap], 2.2), rough, 0.55), Mat.Rock, 2.6);
    const htop = vec(hx, hg + hh + 4.8, hz);
    hoodoos.push(htop);
    o.props.push({ kind: 'rock', pos: vec(hx, hg, hz), end: htop, radius: 9, climbable: true, seed: rr.int(1 << 30) });
    // natural arch springing from the far side of the massif
    const aa = la - Math.PI * rr.range(0.5, 0.8);
    const s0 = { x: oc.x + Math.cos(aa) * (mr * 0.75), z: oc.z + Math.sin(aa) * (mr * 0.75) };
    const s1 = { x: oc.x + Math.cos(aa) * (mr + 19), z: oc.z + Math.sin(aa) * (mr + 19) };
    if (i === 0 || o.size !== 'small') archTops.push(addArch(o, s0, s1, rr.range(12, 15), 4.6, 3.6, Mat.Rock, rr, 'rock'));
    o.extras.sites.push(site('summit', top, mr));
  });
  for (let i = 0, n = count(o, 5, 2); i < n; i++) {
    const r = rr.range(3, 5.5);
    const p = placer.find(rr, r + 3, { accept: (x, z) => panW(x, z) < 0.5 });
    if (p) addRock(o, p.x, p.z, r, rr, { squash: rr.range(0.55, 0.8) });
  }
  for (let i = 0, n = count(o, 14, 5); i < n; i++) {
    const r = rr.range(1.9, 2.7);
    const p = placer.find(rr, r + 1.5);
    if (p) addRock(o, p.x, p.z, r, rr, { lift: -0.2 });
  }
  const wr = rng.fork('wood');
  for (let i = 0, n = count(o, 3, 1); i < n; i++) {
    const p = placer.find(wr, 3);
    if (!p) continue;
    const a = wr.range(0, Math.PI);
    const q = { x: p.x + Math.cos(a) * wr.range(12, 18), z: p.z + Math.sin(a) * wr.range(12, 18) };
    if (!placer.isFree(q.x, q.z, 3)) continue;
    placer.reserve(q.x, q.z, 3);
    placer.reserve((p.x + q.x) / 2, (p.z + q.z) / 2, 3);
    addLog(o, p, q, wr.range(2.1, 2.5), wr);
  }
  const dr = rng.fork('decor');
  for (let i = 0, n = count(o, 50, 15); i < n; i++) decor(o, i % 5 === 0 ? 'grassPatch' : 'pebble', dr.range(3, S - 3), dr.range(3, S - 3), dr.range(0.4, 1.5), dr);

  // ---- nests ------------------------------------------------------------------------------------------
  const nest = carveNest(o, c, c, nestDir, 'colony', { soil: Mat.Sand });
  carveNest(o, rivalX, rivalZ, rivalDir, 'rival', { scale: 0.85, soil: Mat.Sand });

  // ---- food: one small cache to get going, everything else far away ----------------------------------------
  const fr = rng.fork('food');
  const far = (x: number, z: number): boolean => Math.hypot(x - c, z - c) > 0.24 * S;
  {
    const a = fr.range(2.2, 4.1);
    addGroundFood(o, 'seeds', nest.entrance.x + Math.cos(a) * 20, nest.entrance.z + Math.sin(a) * 20, 90);
  }
  for (const s of shrubs.filter((sh) => far(sh.base.x, sh.base.z)).slice(0, 2)) addGroundFood(o, 'seeds', s.base.x + 5.5, s.base.z + 4, 190);
  for (const k of cacti) addFood(o, 'fruit', vec(k.x, k.y + 0.6, k.z), 260, 0.01);
  {
    // a dead beetle out on the pan
    const a = panA + fr.range(-0.4, 0.4);
    addGroundFood(o, 'carcass', pan.x + Math.cos(a) * panR * 0.3, pan.z + Math.sin(a) * panR * 0.3, 340);
    if (archTops[0] && far(archTops[0].x, archTops[0].z)) addGroundFood(o, 'carcass', archTops[0].x + 5, archTops[0].z + 5, 200);
  }
  const hd = stems.find((s) => far(s.base.x, s.base.z));
  if (hd) {
    const hp = stemPoint(hd, 0.6, fr.range(0, 6.28));
    addFood(o, 'honeydew', hp, 30, 0.05);
    o.extras.sites.push(site('aphidStem', hp, hd.radius, hd.tip));
    addCreatureSite(o, 'aphid', hp);
  }

  // ---- creatures & sites --------------------------------------------------------------------------------------
  for (const p of pits) {
    const b = vec(p.x, height(p.x, p.z) + 0.5, p.z);
    addCreatureSite(o, 'antlion', b, p.r);
    o.extras.sites.push(site('antlionPit', b, p.r));
  }
  if (ledges[0]) {
    addCreatureSite(o, 'jumpingSpider', ledges[0], 6);
    o.extras.sites.push(site('lair', ledges[0], 6));
  }
  if (ledges[1]) {
    addCreatureSite(o, 'groundBeetle', ledges[1], 6);
    o.extras.sites.push(site('lair', ledges[1], 6));
  }
  for (const h of hoodoos) o.extras.sites.push(site('summit', h, 8));
  o.extras.sites.push(site('puddle', vec(pan.x, panLevel, pan.z), panR * 0.8, vec(pan.x, panLevel, pan.z), panLevel + 0.5));
  o.extras.surfaceY = base;

  const done = finishOutdoor(o, Mat.Sand);
  const w = done.world;
  const e = nest.entrance;
  const hoodoo = hoodoos[0] ?? ground(o, c + 30, c);
  const arch = archTops[0] ?? hoodoo;
  const oc0 = outcrops[0] ?? { x: c, z: c };
  const windYaw = (Math.atan2(ux, uz) * 180) / Math.PI;
  return {
    world: w,
    spawns: done.spawns.map((s) => (s.kind === 'colony' ? { ...s, species: opts.faction } : s)),
    foodSources: done.foodSources,
    props: o.props,
    cameraMode: 'rts',
    environment: desertEnvironment(),
    boundary: 'open',
    flags: outdoorFlags(),
    goal: { id: 'desert-flight', kind: 'nuptialFlight', target: 100, label: 'Raise 100 ants in the dunes and launch a nuptial flight' },
    cameraStart: pose([e.x + 22, e.y + 26, e.z + 34], [c + 4, base, c]),
    shotPoses: {
      overview: orbitPose(null, vec(c, base, c), 24, 34, S * 0.98),
      outcrop: orbitPose(w, vec(hoodoo.x, hoodoo.y - 7, hoodoo.z), (Math.atan2(hoodoo.x - oc0.x, hoodoo.z - oc0.z) * 180) / Math.PI + 30, 4, 36, { fov: 48 }, 12),
      arch: orbitPose(w, vec(arch.x, arch.y - 5, arch.z), (Math.atan2(arch.x - oc0.x, arch.z - oc0.z) * 180) / Math.PI + 80, 3, 30, { fov: 48 }, 12),
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
      pits: orbitPose(w, vec(field.x, height(field.x, field.z) + 3, field.z), 35, 30, 44, { fov: 45 }),
      pan: orbitPose(w, vec(pan.x, panLevel, pan.z), windYaw + 90, 13, 30, { fov: 50 }),
      dunes: orbitPose(w, vec(c - ux * 0.3 * S, base + 5, c - uz * 0.3 * S), windYaw + 70, 9, 44, { fov: 50 }),
    },
    extras: o.extras,
  };
}

/** Barrel cactus: a ribbed globe (Plant voxels). Returns the crown, where its fruit sits. */
function addCactus(o: Outdoor, x: number, z: number, r: number, rng: SeededRng): Vec3 {
  const g = o.hf.at(x, z);
  const ry = r * 1.1;
  const cy = g + ry * 0.3;
  const ribs = 7;
  const ph = rng.range(0, 6.28);
  const body = displaced(ellipsoid(vec(x, cy, z), r, ry, r), (px, _py, pz) => Math.cos(Math.atan2(pz - z, px - x) * ribs + ph) * smoothstep(0.8, 2.5, Math.hypot(px - x, pz - z)), 0.42);
  o.canvas.blend(body, Mat.Plant, 2.8);
  const top = vec(x, cy + ry, z);
  o.props.push({ kind: 'flower', pos: vec(x, g, z), end: top, radius: r, climbable: true, seed: rng.int(1 << 30) });
  return top;
}

export const desert: MapDef = {
  id: 'desert',
  name: 'Desert',
  kind: 'outdoor',
  description: 'Rippled dunes, a cracked clay pan, sandstone arches and antlion pits. Food is far away.',
  generate: generateDesert,
};
