import type * as THREE from 'three';
import { BodyPart, type BroodGeometryKind, type CreatureLook, type GeometryLod, type ItemGeometryKind } from '../../core';
import { GeoBuilder, add, gauss, hash1, mul, norm, prof, sstep, vnoise, type RGB, type V3 } from './builder';

/**
 * Brood (egg cluster, larva, pupa) and item meshes (crumb, seed, leaf fragment, pellet, wood
 * chip, honeydew drop, fungus tuft, fruit chunk, sugar crystal). Unit size: longest extent ≈ 1,
 * centred on the origin (the renderers rest them on the surface). Same attribute layout as the
 * creatures, so brood can use the chitin material's soft-body mode.
 */

const RAD = [18, 9, 5];
const RNG = [14, 7, 4];

function eggCluster(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.set(BodyPart.thorax);
  const n = lod === 2 ? 3 : 7;
  for (let i = 0; i < n; i++) {
    const a = hash1(i * 3.1) * Math.PI * 2;
    const rr = i === 0 ? 0 : 0.2 + 0.14 * hash1(i * 7.7);
    const c: V3 = [Math.cos(a) * rr, -0.18 + (i > 3 ? 0.2 : 0) + 0.08 * hash1(i * 1.3), Math.sin(a) * rr];
    const d = norm([hash1(i * 5.5) - 0.5, (hash1(i * 9.1) - 0.5) * 0.6, hash1(i * 2.9) - 0.5]);
    b.blob({ a: add(c, mul(d, -0.26)), b: add(c, mul(d, 0.26)), rings: lod === 0 ? 8 : 4, radial: lod === 0 ? 10 : 6, rx: (t) => 0.15 * prof(t, 0.5, 0.42, 0.42), w: () => i / n, ao: () => 0.8 + 0.2 * hash1(i) });
  }
  return b.build({ legs: 0, crawl: 0, neck: [0, 0, 0], waist: [0, 0, 0] });
}

function larva(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const segs = 10;
  b.set(BodyPart.thorax);
  // C-curved grub, fat tail, narrow hooked head end
  b.blob({
    a: [0, -0.08, -0.46],
    b: [0, -0.08, 0.44],
    rings: lod === 0 ? segs * 3 : lod === 1 ? segs : 5,
    radial: RAD[lod],
    even: true,
    rx: (t) => 0.2 * prof(t, 0.36, 0.42, 0.75) * (1 + (lod < 2 ? 0.07 * Math.cos(t * segs * Math.PI * 2) : 0)),
    off: (t) => [0, 0.24 * t * t - 0.05],
    w: (t) => t,
    col: (t) => [1 - 0.12 * sstep(0.85, 1, t), 1 - 0.2 * sstep(0.85, 1, t), 1 - 0.3 * sstep(0.85, 1, t)],
  });
  if (lod < 2) {
    // dark mouthparts and the gut showing through the cuticle
    b.set(BodyPart.mandible, 0, [0, 0.14, 0.43]);
    b.blob({ a: [0, 0.135, 0.42], b: [0, 0.14, 0.47], rings: 3, radial: 5, rx: (t) => 0.025 * prof(t), col: [0.25, 0.12, 0.05] });
  }
  return b.build({ legs: 0, crawl: 0.03, neck: [0, 0, 0.3], waist: [0, -0.08, 0] });
}

function pupa(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.set(BodyPart.thorax);
  // silk cocoon with the meconium spot at one end and a faint impression of the folded pupa
  b.blob({
    a: [0, 0, -0.5],
    b: [0, 0, 0.5],
    rings: RNG[lod] + 2,
    radial: RAD[lod],
    rx: (t) => 0.21 * prof(t, 0.45, 0.4, 0.45) * (1 - 0.06 * gauss(t - 0.62, 0.05)),
    w: (t) => t,
    shape: (th, t) => 1 + 0.025 * vnoise(th * 5, t * 14, 2),
    col: (t, th) => {
      const spot = sstep(0.12, 0.02, t);
      const k = 0.92 + 0.16 * vnoise(th * 6, t * 30, 7);
      return [k * (1 - 0.7 * spot), k * (1 - 0.78 * spot), k * (1 - 0.85 * spot)];
    },
  });
  return b.build({ legs: 0, crawl: 0.006, neck: [0, 0, 0.3], waist: [0, 0, 0] });
}

export function buildBrood(kind: BroodGeometryKind, lod: GeometryLod): THREE.BufferGeometry {
  return kind === 'egg' ? eggCluster(lod) : kind === 'larva' ? larva(lod) : pupa(lod);
}

// ---------------------------------------------------------------------------------------------

function lump(b: GeoBuilder, lod: GeometryLod, seed: number, rough: number, squash: V3, col: (n: number) => RGB): void {
  b.blob({
    a: [0, 0, -0.5 * squash[2]],
    b: [0, 0, 0.5 * squash[2]],
    rings: RNG[lod],
    radial: RAD[lod],
    rx: (t) => 0.5 * squash[0] * prof(t, 0.5, 0.45, 0.45),
    ry: (t) => 0.5 * squash[1] * prof(t, 0.5, 0.45, 0.45),
    shape: (th, t) => 1 - rough * 0.5 + rough * vnoise(Math.cos(th) * 2.2 + seed, Math.sin(th) * 2.2 + seed * 1.7, t * 4.4),
    col: (t, th) => col(vnoise(Math.cos(th) * 4 + seed, Math.sin(th) * 4, t * 8)),
  });
}

function leaf(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.set(BodyPart.other);
  const nu = lod === 0 ? 28 : lod === 1 ? 18 : 9;
  const nv = lod === 0 ? 12 : lod === 1 ? 8 : 4;
  // A fragment sheared out of a leaf blade (blade in XY, midrib along X, material `leaf` look):
  //  - v = 1: the natural margin, finely serrate;
  //  - v = 0: the CUT edge — a row of overlapping mandible bites, ragged and scalloped;
  //  - cupped across the midrib, curled at the tips and slightly twisted, like a drying sail.
  const halfW = (u: number): number => 0.5 * Math.sqrt(Math.max(0, 1 - 3.7 * (u - 0.5) * (u - 0.5)));
  b.sheet(
    nu,
    nv,
    (u, v) => {
      const x = u - 0.5;
      const hw = halfW(u);
      // natural margin: small forward-pointing teeth
      const saw = 1 - 0.07 * Math.abs((((u * 11) % 1) + 1) % 1 - 0.35) * 2;
      const top = hw * 0.92 * saw;
      // cut edge: scalloped bites of uneven depth plus tear noise
      const bite = Math.abs(Math.sin(u * Math.PI * 4.5 + 0.6));
      const bot = -hw * (0.5 + 0.2 * bite + 0.16 * vnoise(u * 13, 5, 2) + 0.06 * vnoise(u * 41, 9, 4));
      const y = bot + (top - bot) * v;
      const z = 0.2 * (4 * x * x - 0.45) + 0.16 * y * y + 0.22 * x * y + 0.025 * Math.sin(y * 9 + x * 5);
      return [x, y, z];
    },
    () => 0,
    // AO channel = distance to the margin (0.5 at the rim → 1 inside): darkens the rim and lets the
    // shader find the cut edge
    (u, v) => 0.5 + 0.5 * sstep(0, 0.22, Math.min(v * 0.8, 1 - v, u * 1.6, (1 - u) * 1.6)),
    (u, v) => {
      const k = 0.9 + 0.14 * vnoise(u * 5, v * 5, 11);
      return [k * 0.95, k, k * 0.7];
    },
  );
  return b.build({ legs: 0 }, false);
}

export function buildItem(kind: Exclude<ItemGeometryKind, 'corpse'>, lod: GeometryLod): THREE.BufferGeometry {
  if (kind === 'leaf') return leaf(lod);
  const b = new GeoBuilder();
  b.set(BodyPart.other);
  switch (kind) {
    case 'crumb':
      lump(b, lod, 3.3, 0.45, [0.9, 0.72, 1], (n) => [0.8 + 0.4 * n, 0.75 + 0.4 * n, 0.65 + 0.45 * n]);
      break;
    case 'pellet':
      lump(b, lod, 9.1, 0.3, [0.92, 0.85, 1], (n) => [0.75 + 0.5 * n, 0.75 + 0.5 * n, 0.75 + 0.5 * n]);
      break;
    case 'fruit':
      lump(b, lod, 5.7, 0.22, [1, 0.8, 1], (n) => [0.9 + 0.2 * n, 0.8 + 0.4 * n, 0.8 + 0.3 * n]);
      break;
    case 'woodChip':
      lump(b, lod, 1.9, 0.5, [0.34, 0.14, 1], (n) => [0.7 + 0.6 * n, 0.7 + 0.5 * n, 0.65 + 0.5 * n]);
      break;
    case 'honeydew':
      b.blob({ a: [0, 0, -0.5], b: [0, 0, 0.5], rings: RNG[lod] + 2, radial: RAD[lod], rx: (t) => 0.5 * prof(t) });
      break;
    case 'sugar': {
      // a faceted crystal: 4-sided prism with bevelled ends
      b.blob({ a: [0, -0.42, 0], b: [0, 0.42, 0], up: [0, 0, 1], rings: 3, radial: 4, even: true, rx: (t) => (t <= 0 || t >= 1 ? 0 : 0.5), col: [1, 1, 1] });
      break;
    }
    case 'seed': {
      // teardrop achene with ribs and a pale hilum
      b.blob({
        a: [0, 0, -0.5],
        b: [0, 0, 0.5],
        rings: RNG[lod] + 2,
        radial: RAD[lod],
        rx: (t) => 0.27 * prof(t, 0.36, 0.5, 0.95),
        ry: (t) => 0.2 * prof(t, 0.36, 0.5, 0.95),
        shape: (th) => 1 + (lod === 0 ? 0.05 * Math.cos(th * 9) : 0),
        col: (t, th) => {
          const rib = 0.82 + 0.3 * (0.5 + 0.5 * Math.cos(th * 9));
          const hil = sstep(0.1, 0.0, t) * 1.5;
          return [rib + hil, rib + hil, rib + hil * 0.8];
        },
      });
      break;
    }
    case 'fungusTuft': {
      // gongylidia: a cauliflower of pale swollen hyphal tips on short stalks
      const n = lod === 2 ? 4 : 11;
      for (let i = 0; i < n; i++) {
        const a = hash1(i * 4.4) * Math.PI * 2;
        const rr = 0.32 * Math.sqrt(hash1(i * 8.8));
        const h = 0.1 + 0.3 * hash1(i * 2.2) * (1 - rr);
        const base: V3 = [Math.cos(a) * rr, -0.3, Math.sin(a) * rr];
        const top: V3 = add(base, [Math.cos(a) * 0.08, 0.2 + h, Math.sin(a) * 0.08]);
        if (lod < 2) b.limb({ pts: [base, top], r: [0.035, 0.03], radial: 4, col: [0.85, 0.85, 0.8] });
        const r = 0.11 + 0.08 * hash1(i * 6.1);
        b.blob({ a: add(top, [0, -r, 0]), b: add(top, [0, r, 0]), up: [0, 0, 1], rings: lod === 0 ? 6 : 3, radial: lod === 0 ? 8 : 5, rx: (t) => r * prof(t), ao: () => 0.75 + 0.25 * hash1(i) });
      }
      break;
    }
  }
  return b.build({ legs: 0 });
}

const SOFT: CreatureLook = {
  color: [0.85, 0.8, 0.68],
  roughness: 0.4,
  clearcoat: 0.45,
  iridescence: 0,
  translucency: 0.6,
  translucencyColor: [1, 0.78, 0.5],
  translucencyAll: true,
  wax: 1,
  sheen: 0.5,
  bands: 0,
  sting: 0,
};

export const BROOD_LOOKS: Record<BroodGeometryKind, CreatureLook> = {
  egg: { ...SOFT, color: [0.92, 0.9, 0.82], roughness: 0.25, clearcoat: 0.9, iridescence: 0.25 },
  larva: { ...SOFT, color: [0.88, 0.82, 0.66], roughness: 0.32, clearcoat: 0.6 },
  pupa: { ...SOFT, color: [0.74, 0.6, 0.4], roughness: 0.75, clearcoat: 0.05, translucency: 0.3, sheen: 1 },
};
