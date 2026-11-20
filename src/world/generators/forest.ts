import { Mat, type MapDef, type MapGenOptions, type MapGenResultA1, type MaterialId, type Vec3 } from '../../core';
import {
  addArch,
  addCreatureSite,
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
import { buildHeightField, clipY, displaced, ellipsoid, forestEnvironment, orbitPose, outdoorFlags, pose, site, smoothstep, vec, vlerp, type Shape } from './shared';

/**
 * Forest floor — dark loam under a deep leaf-litter blanket at the foot of a giant tree. The
 * trunk fills one corner of the block and throws buttress roots across the map, some of them
 * arching clear of the ground; a gully cuts through, bridged by a fallen hollow branch; mossy
 * boulders, mushroom troops and bracket fungi give lots of vertical relief.
 */
export function generateForest(seed: number, opts: MapGenOptions): MapGenResultA1 {
  const o = createOutdoor(seed, opts, 'forest');
  const { rng, noise, S, H, canvas, placer } = o;
  const c = S / 2;
  const base = 25;
  const layout = rng.fork('layout');

  // ---- the tree: which corner, how big ------------------------------------------------------------
  const corner = layout.int(4);
  const sgx = corner & 1 ? -1 : 1; // direction from the trunk corner into the map
  const sgz = corner & 2 ? -1 : 1;
  const tx = corner & 1 ? S - 5 : 5;
  const tz = corner & 2 ? S - 5 : 5;
  const trunkR = Math.max(22, 0.19 * S);
  const trunkDist = (x: number, z: number): number => Math.hypot(x - tx, z - tz);
  placer.reserve(tx, tz, trunkR + 9);

  // ---- nest & rival -------------------------------------------------------------------------------
  const nestDir = 0;
  reserveNest(o, c, c, nestDir);
  const rivalX = tx + sgx * (S - 10 - 0.17 * S);
  const rivalZ = tz + sgz * (S - 10 - 0.17 * S); // the corner opposite the tree
  const rivalDir = Math.atan2(c - rivalZ, c - rivalX) + layout.range(-0.4, 0.4);
  reserveNest(o, rivalX, rivalZ, rivalDir, 0.85);

  // ---- gully: a winding stream bed on the far side of the nest from the tree ---------------------------
  const gPhase = layout.range(0, 6.28);
  const gOff = 0.27 * S;
  // signed distance (in voxels) from the gully centre line; the line runs across the tree→rival diagonal
  const gullyD = (x: number, z: number): number => {
    const u = ((x - c) * sgx + (z - c) * sgz) * Math.SQRT1_2; // along the diagonal, + away from the tree
    const v = ((x - c) * sgx - (z - c) * sgz) * Math.SQRT1_2; // across it
    return u - gOff * 0.55 - Math.sin(v * 0.045 + gPhase) * 9 - Math.sin(v * 0.11 + gPhase * 2) * 2.5;
  };
  const gullyW = 8.5;
  const gullyAt = (x: number, z: number): number => 1 - smoothstep(0, gullyW, Math.abs(gullyD(x, z)));

  const height = (x: number, z: number): number => {
    let h = base + noise.fbm2(x * 0.012, z * 0.012, 4) * 8 + noise.ridged2(x * 0.03 + 20, z * 0.03, 2) * 2.6 - 1.3 + noise.n2(x * 0.12, z * 0.12) * 0.35;
    h += 2.5 * Math.exp(-((x - c) ** 2 + (z - c) ** 2) / (30 * 30));
    h -= 5.6 * gullyAt(x, z);
    // root plate: the ground heaves up towards the trunk
    h += 7 * smoothstep(trunkR + 30, trunkR, trunkDist(x, z));
    return h;
  };
  o.hf = buildHeightField(S, S, height);

  canvas.fillTerrain(o.hf, (x, y, z, depth): MaterialId => {
    if (y < 6 + noise.fbm2(x * 0.02 + 100, z * 0.02, 3) * 3.5) return Mat.Rock;
    const gl = gullyAt(x, z);
    if (gl > 0.25 && depth < 3) return noise.n3(x * 0.3, y * 0.3, z * 0.3) > 0.45 ? Mat.Rock : gl > 0.6 ? Mat.Sand : Mat.Mud; // washed gravel bed
    if (depth < 2.4 && noise.fbm2(x * 0.03 + 300, z * 0.03, 3) > -0.42) return Mat.LeafLitter; // litter blanket
    if (depth > 2.5 && noise.n3(x * 0.17, y * 0.17, z * 0.17 + 77) > 0.78) return Mat.Rock;
    const w = noise.fbm2(x * 0.03 - 60, z * 0.03, 2) * 3;
    if (depth < 7.5 + w) return Mat.Mud; // dark humus / loam
    if (depth > 12 + w && depth < 16 + w && noise.n3(x * 0.05, y * 0.1, z * 0.05) > 0) return Mat.Clay;
    return Mat.Soil;
  });

  // ---- plants first (fixtures expect the first three props to be climbable stems) ------------------
  const pr = rng.fork('plants');
  const stems: Stem[] = [];
  {
    const a = 2.3 + pr.range(-0.3, 0.3);
    const x = c + Math.cos(a) * 11;
    const z = c + Math.sin(a) * 11;
    placer.reserve(x, z, 5);
    stems.push(addStem(o, x, z, 25, pr, { lean: 0.08, r0: 2.3, bow: 0 }));
  }
  for (let i = 0, n = count(o, 7, 3); i < n; i++) {
    const p = placer.find(pr, 6, { accept: (x, z) => gullyAt(x, z) < 0.2 });
    if (p) stems.push(addStem(o, p.x, p.z, pr.range(14, 28), pr, { r0: pr.range(2.1, 2.5), head: i % 3 === 2, bow: i < 2 ? 0 : undefined }));
  }

  // ---- the trunk ------------------------------------------------------------------------------------
  const tr = rng.fork('tree');
  const tg = height(tx + sgx * trunkR * 0.7, tz + sgz * trunkR * 0.7);
  const trunk: Shape = {
    box: { x0: tx - trunkR - 16, x1: tx + trunkR + 16, z0: tz - trunkR - 16, z1: tz + trunkR + 16, y0: 0, y1: H },
    d: (x, y, z) => {
      const d = Math.hypot(x - tx, z - tz);
      const ang = Math.atan2(z - tz, x - tx);
      const flare = 9 * Math.exp(-Math.max(0, y - tg + 2) / 5.5); // root flare
      const furrow = noise.n2(ang * trunkR * 0.16, y * 0.035 + 5) * 1.1 + noise.n2(ang * trunkR * 0.45, y * 0.09) * 0.35; // bark ridges run up the trunk
      return (trunkR + flare + furrow - d) * 0.8;
    },
  };
  canvas.blend(trunk, Mat.Wood, 3);
  o.props.push({ kind: 'log', pos: vec(tx, tg, tz), end: vec(tx, H, tz), radius: trunkR, climbable: true, seed: tr.int(1 << 30) });
  o.extras.sites.push(site('deadwood', vec(tx + sgx * trunkR * 0.7, tg, tz + sgz * trunkR * 0.7), trunkR, vec(tx, H, tz)));

  // buttress roots fan out over the quarter circle that lies inside the map
  const rootAng0 = Math.atan2(sgz, sgx) - Math.PI / 4;
  const nRoots = 5;
  const arches: Vec3[] = [];
  for (let i = 0; i < nRoots; i++) {
    const a = rootAng0 + ((i + 0.5) / nRoots) * (Math.PI / 2) + tr.range(-0.08, 0.08);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const from = { x: tx + dx * (trunkR - 2), z: tz + dz * (trunkR - 2) };
    const len = tr.range(0.16, 0.26) * S;
    const to = { x: from.x + dx * len, z: from.z + dz * len };
    // the buttress itself: high on the trunk → into the ground
    const top = vec(from.x, Math.min(H - 12, tg + tr.range(15, 24)), from.z);
    const toe = vec(to.x, height(to.x, to.z) - 4, to.z);
    const knee = vec(from.x + dx * len * 0.45, height(from.x + dx * len * 0.45, from.z + dz * len * 0.45) + tr.range(3.5, 6), from.z + dz * len * 0.45);
    const r0 = tr.range(5, 6.5);
    canvas.blend(displaced(capsuleChain([top, knee, toe], r0, 3), (px, py, pz) => noise.n3(px * 0.25, py * 0.25, pz * 0.25 + i * 9), 0.4), Mat.Wood, 3);
    o.props.push({ kind: 'log', pos: knee, end: toe, radius: 3.5, climbable: true, seed: tr.int(1 << 30) });
    for (const k of [0.3, 0.6, 0.9, 1.1]) placer.reserve(from.x + dx * len * k, from.z + dz * len * k, 6);
    // every other root surfaces again further out as a free-standing arch
    if (i % 2 === 0) {
      const a2 = a + tr.range(-0.35, 0.35);
      const s0 = { x: to.x + Math.cos(a2) * 7, z: to.z + Math.sin(a2) * 7 };
      const span = tr.range(19, 25);
      const s1 = { x: s0.x + Math.cos(a2) * span, z: s0.z + Math.sin(a2) * span };
      if (Math.min(s0.x, s0.z, s1.x, s1.z) > 8 && Math.max(s0.x, s0.z, s1.x, s1.z) < S - 8 && placer.isFree(s1.x, s1.z, 2, 7) && gullyAt(s1.x, s1.z) < 0.3) {
        placer.reserve(s0.x, s0.z, 6);
        placer.reserve(s1.x, s1.z, 6);
        arches.push(addArch(o, s0, s1, tr.range(9, 13), 3.6, 2.7, Mat.Wood, tr));
      }
    }
  }
  // root loops surfacing further out on the forest floor
  for (let i = 0, n = count(o, 3, 1); i < n; i++) {
    const p = placer.find(tr, 5, { accept: (x, z) => gullyAt(x, z) < 0.2, tries: 60 });
    if (!p) continue;
    const a = Math.atan2(p.z - tz, p.x - tx) + tr.range(-0.5, 0.5);
    const span = tr.range(18, 24);
    const q = { x: p.x + Math.cos(a) * span, z: p.z + Math.sin(a) * span };
    if (!placer.isFree(q.x, q.z, 4, 8) || gullyAt(q.x, q.z) > 0.2) continue;
    placer.reserve(q.x, q.z, 6);
    arches.push(addArch(o, p, q, tr.range(8, 12), 3.4, 2.6, Mat.Wood, tr));
  }
  // bracket fungi: shelves on the bark
  const brackets: Vec3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = rootAng0 + tr.range(0.12, 0.88) * (Math.PI / 2);
    const y = Math.min(H - 8, tg + 13 + i * 6.5 + tr.range(-1.5, 1.5));
    const rr = trunkR + 1.2;
    const bc = vec(tx + Math.cos(a) * rr, y, tz + Math.sin(a) * rr);
    const br = tr.range(5, 7.5);
    canvas.blend(clipY(ellipsoid(bc, br, 2.3, br), y - 1.3, true, 0.8), Mat.Fungus, 1.8);
    const top = vec(tx + Math.cos(a) * (rr + br * 0.5), y + 2.3, tz + Math.sin(a) * (rr + br * 0.5));
    brackets.push(top);
    o.props.push({ kind: 'mushroom', pos: bc, end: top, radius: br, climbable: true, seed: tr.int(1 << 30) });
  }

  // ---- fallen wood ------------------------------------------------------------------------------------
  const wr = rng.fork('wood');
  // a hollow branch bridging the gully
  let bridge: { a: Vec3; b: Vec3 } | null = null;
  for (let t = 0; t < 80 && !bridge; t++) {
    const v = wr.range(-0.3, 0.3) * S;
    // walk along the gully line: find the point on the centre line for this v
    const u = gOff * 0.55 + Math.sin(v * 0.045 + gPhase) * 9 + Math.sin(v * 0.11 + gPhase * 2) * 2.5;
    const mx = c + (u * sgx + v * sgx) * Math.SQRT1_2;
    const mz = c + (u * sgz - v * sgz) * Math.SQRT1_2;
    const a = Math.atan2(sgz, sgx) + wr.range(-0.35, 0.35);
    const half = gullyW + 11;
    const pts = [-1, -0.5, 0, 0.5, 1].map((k) => ({ x: mx + Math.cos(a) * half * k, z: mz + Math.sin(a) * half * k }));
    if (!placer.isFree(pts[0].x, pts[0].z, 6, 9) || !placer.isFree(pts[4].x, pts[4].z, 6, 9)) continue;
    for (const p of pts) placer.reserve(p.x, p.z, 7);
    bridge = addLog(o, pts[0], pts[4], 5.6, wr, { hollow: true, r1: 5.2, lift: 0.1 });
    o.extras.sites.push(site('deadwood', vlerp(bridge.a, bridge.b, 0.5), half, bridge.b));
  }
  // branches: some lie flat, some are propped on a boulder at one end (lean-to arches)
  const rr = rng.fork('rocks');
  for (let i = 0, n = count(o, 5, 2); i < n; i++) {
    const p = placer.find(wr, 4, { accept: (x, z) => gullyAt(x, z) < 0.3 });
    if (!p) continue;
    const a = wr.range(0, Math.PI * 2);
    const len = wr.range(22, 34);
    const q = { x: p.x + Math.cos(a) * len, z: p.z + Math.sin(a) * len };
    const m = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
    if (!placer.isFree(q.x, q.z, 5, 7) || !placer.isFree(m.x, m.z, 3.5, 7)) continue;
    placer.reserve(q.x, q.z, 7);
    placer.reserve(m.x, m.z, 4);
    if (i % 2 === 0) {
      const rock = wr.range(6, 8.5);
      const top = addRock(o, q.x, q.z, rock, rr, { squash: 0.95, lift: 0.1, mossy: true });
      const pa = vec(p.x, height(p.x, p.z) - 3, p.z);
      const pb = vec(q.x + Math.cos(a) * 5, top.y + 2.2, q.z + Math.sin(a) * 5);
      canvas.blend(displaced(capsuleChain([pa, pb], 3.3, 2.6), (px, py, pz) => noise.n3(px * 0.3, py * 0.3, pz * 0.3 + 50), 0.35), Mat.Wood, 2.6);
      o.props.push({ kind: 'log', pos: pa, end: pb, radius: 3, climbable: true, seed: wr.int(1 << 30) });
    } else addLog(o, p, q, wr.range(2.6, 3.6), wr);
  }

  // ---- boulders, litter, mushrooms -----------------------------------------------------------------------
  const boulders: Vec3[] = [];
  for (let i = 0, n = count(o, 8, 3); i < n; i++) {
    const r = rr.range(5, 10.5);
    const p = placer.find(rr, r + 3);
    if (p) boulders.push(addRock(o, p.x, p.z, r, rr, { mossy: true, squash: rr.range(0.7, 1.0) }));
  }
  for (let i = 0, n = count(o, 12, 5); i < n; i++) {
    const r = rr.range(2, 3.2);
    const p = placer.find(rr, r + 1.5);
    if (p) addRock(o, p.x, p.z, r, rr, { lift: -0.2 });
  }
  const lr = rng.fork('litter');
  for (let i = 0, n = count(o, 16, 6); i < n; i++) {
    const r = lr.range(7, 12);
    const p = placer.find(lr, r * 0.6, { reserve: r * 0.35, accept: (x, z) => gullyAt(x, z) < 0.4 });
    if (p) addLitter(o, p.x, p.z, r, lr, 2.3);
  }
  const mr = rng.fork('mushrooms');
  const caps: Vec3[] = [];
  for (let i = 0, n = count(o, 5, 2); i < n; i++) {
    // troops: one big cap with one or two smaller neighbours
    const p = placer.find(mr, 8, { accept: (x, z) => gullyAt(x, z) < 0.3 });
    if (!p) continue;
    caps.push(addMushroom(o, p.x, p.z, mr.range(11, 17), mr.range(7.5, 10.5), mr));
    for (let k = 0, kn = 1 + mr.int(2); k < kn; k++) {
      const q = placer.find(mr, 5.5, { around: { x: p.x, z: p.z, min: 12, max: 16 }, tries: 12 });
      if (q && gullyAt(q.x, q.z) < 0.3) caps.push(addMushroom(o, q.x, q.z, mr.range(6, 9), mr.range(4.5, 6), mr));
    }
  }

  const dr = rng.fork('decor');
  for (let i = 0, n = count(o, 110, 30); i < n; i++) decor(o, i % 4 === 0 ? 'grassPatch' : i % 4 === 1 ? 'pebble' : 'leaf', dr.range(3, S - 3), dr.range(3, S - 3), dr.range(1, 3.5), dr);

  // ---- nests -------------------------------------------------------------------------------------------
  const nest = carveNest(o, c, c, nestDir, 'colony', { soil: Mat.Mud });
  carveNest(o, rivalX, rivalZ, rivalDir, 'rival', { scale: 0.85, soil: Mat.Mud });

  // ---- food & creatures -----------------------------------------------------------------------------------
  const fr = rng.fork('food');
  const ring = (min: number, max: number): { x: number; z: number } => {
    for (let t = 0; t < 80; t++) {
      const a = fr.range(0, Math.PI * 2);
      const d = fr.range(min, max);
      const x = nest.entrance.x + Math.cos(a) * d;
      const z = nest.entrance.z + Math.sin(a) * d;
      if (placer.isFree(x, z, 2, 6) && gullyAt(x, z) < 0.3) return { x, z };
    }
    return { x: c + min, z: c - min * 0.5 };
  };
  const near = Math.min(27, 0.2 * S);
  let p = ring(near * 0.7, near);
  addGroundFood(o, 'seeds', p.x, p.z, 260);
  p = ring(near, near * 1.5);
  addGroundFood(o, 'carcass', p.x, p.z, 220);
  p = ring(0.26 * S, 0.38 * S);
  addGroundFood(o, 'fruit', p.x, p.z, 380);
  p = ring(0.3 * S, 0.42 * S);
  addGroundFood(o, 'fruit', p.x, p.z, 320);
  p = ring(0.3 * S, 0.44 * S);
  addGroundFood(o, 'carcass', p.x, p.z, 300);
  p = ring(0.24 * S, 0.4 * S);
  addGroundFood(o, 'seeds', p.x, p.z, 200);
  for (const s of [stems[0], stems[stems.length - 1]]) {
    const hp = stemPoint(s, 0.6, fr.range(0, 6.28));
    addFood(o, 'honeydew', hp, 40, 0.08);
    o.extras.sites.push(site('aphidStem', hp, s.radius, s.tip));
    addCreatureSite(o, 'aphid', hp);
  }
  if (stems[1]) {
    addFood(o, 'leaves', stemPoint(stems[1], 0.8, 1), 240, 0.03);
    addCreatureSite(o, 'caterpillar', stemPoint(stems[1], 0.5, 2));
  }
  const lair = arches[0] ? vec(arches[0].x, height(arches[0].x, arches[0].z) + 1, arches[0].z) : ground(o, c - sgx * 0.2 * S, c - sgz * 0.2 * S);
  addCreatureSite(o, 'jumpingSpider', lair, 6);
  o.extras.sites.push(site('lair', lair, 6));
  if (bridge) {
    const under = vlerp(bridge.a, bridge.b, 0.5);
    addCreatureSite(o, 'groundBeetle', vec(under.x + 6, under.y - 5, under.z - 6), 5);
    o.extras.sites.push(site('puddle', vec(under.x, under.y - 7, under.z), gullyW, vec(under.x, under.y - 7, under.z), under.y - 5));
    addCreatureSite(o, 'worm', vec(under.x - 8, under.y - 5, under.z + 8));
  }
  if (boulders[0]) addCreatureSite(o, 'mantis', boulders[0], 8);
  for (const b of brackets) o.extras.sites.push(site('summit', b, 5));
  for (const m of caps.slice(0, 3)) o.extras.sites.push(site('summit', m, 6));
  o.extras.surfaceY = base;

  const done = finishOutdoor(o, Mat.Mud);

  const e = nest.entrance;
  const w = done.world;
  const ax = arches[0] ?? vec(tx + sgx * (trunkR + 24), tg, tz + sgz * (trunkR + 24));
  const cap = caps[0] ?? ground(o, c + 20, c + 20);
  const br = bridge ? vlerp(bridge.a, bridge.b, 0.5) : ground(o, c, c + 30);
  // yaw that looks from the open side of the map towards the tree
  const treeYaw = (Math.atan2(sgx, sgz) * 180) / Math.PI;
  return {
    world: done.world,
    spawns: done.spawns.map((s) => (s.kind === 'colony' ? { ...s, species: opts.faction } : s)),
    foodSources: done.foodSources,
    props: o.props,
    cameraMode: 'rts',
    environment: forestEnvironment(),
    boundary: 'open',
    flags: outdoorFlags(),
    goal: { id: 'forest-rival', kind: 'eliminateRival', target: 1, label: 'Destroy the rival colony across the gully' },
    cameraStart: pose([e.x + 22, e.y + 26, e.z + 34], [c + 4, base, c]),
    shotPoses: {
      overview: orbitPose(null, vec(c - sgx * 6, base, c - sgz * 6), treeYaw + 28, 36, S * 0.98),
      roots: orbitPose(w, vec(ax.x, ax.y - 5, ax.z), (Math.atan2(ax.x - tx, ax.z - tz) * 180) / Math.PI + 75, 6, 30, { fov: 48 }, 9),
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
      // M3: the nest mouth, as on the other outdoor maps
      entrance: orbitPose(w, vec(e.x, e.y - 0.5, e.z), 38, 30, 15),
      mushroom: orbitPose(w, vec(cap.x, cap.y - 4, cap.z), treeYaw + 60, 2, 24, { fov: 42 }, 12),
      bridge: orbitPose(w, vec(br.x, br.y, br.z), treeYaw + 100, 14, 34, { fov: 45 }, 14),
      trunk: orbitPose(w, vec(tx + sgx * trunkR * 0.75, tg + 16, tz + sgz * trunkR * 0.75), treeYaw + 12, 6, 62, { fov: 50 }),
    },
    extras: o.extras,
  };
}

/** Chain of capsules with linearly tapering radius (local helper so the roots read as one limb). */
function capsuleChain(pts: Vec3[], r0: number, r1: number): Shape {
  // subdivide with a slight sag so that long limbs are not ruler-straight
  const out: Vec3[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const n = 4;
    for (let k = 0; k < n; k++) out.push(vlerp(pts[i], pts[i + 1], k / n));
  }
  out.push(pts[pts.length - 1]);
  return chainOf(out, r0, r1);
}

import { chain as chainOf } from './shared';

export const forest: MapDef = {
  id: 'forest',
  name: 'Forest Floor',
  kind: 'outdoor',
  description: 'Dark loam and deep leaf litter between the roots of a giant tree.',
  generate: generateForest,
};
