import type * as THREE from 'three';
import { BodyPart, RIDE_PER_LENGTH, type CreatureId, type CreatureLook, type GeometryLod } from '../../core';
import { GeoBuilder, add, gauss, lerp, mul, prof, sstep, vnoise, type RGB, type V3 } from './builder';

/**
 * Non-ant fauna (§7): jumping spider, antlion larva, ground beetle, parasitic wasp, mantis,
 * aphid, caterpillar, worm. Same attribute layout / rig conventions as the ants so B4 can draw
 * them with the shared chitin material and gait shader.
 */

const FOOT = -RIDE_PER_LENGTH;
const RAD = [20, 10, 5];
const RNG = [16, 8, 4];
const LRAD = [7, 4, 3];

interface LegSpec {
  hip: V3;
  foot: V3;
  /** Knee height (absolute y). */
  knee: number;
  /** Knee position along hip→foot 0..1. */
  kneeAt?: number;
  r: number;
}

function addLegs(b: GeoBuilder, lod: GeometryLod, specs: LegSpec[], col: RGB, colAlt?: RGB): void {
  specs.forEach((sp, pair) => {
    for (const sd of [-1, 1]) {
      const hip: V3 = [sd * sp.hip[0], sp.hip[1], sp.hip[2]];
      const ft: V3 = [sd * sp.foot[0], sp.foot[1], sp.foot[2]];
      const ka = sp.kneeAt ?? 0.48;
      const knee: V3 = [lerp(hip[0], ft[0], ka), sp.knee, lerp(hip[2], ft[2], ka)];
      const ankle: V3 = [lerp(hip[0], ft[0], 0.9), ft[1] + sp.r * 1.6, lerp(hip[2], ft[2], 0.9)];
      b.set(BodyPart.leg, pair * 2 + (sd > 0 ? 1 : 0), hip);
      const c2 = colAlt ?? col;
      if (lod === 2) b.limb({ pts: [hip, knee, ft], r: [sp.r, sp.r * 0.8, sp.r * 0.35], w: [0, 0.5, 1], radial: 3, col });
      else {
        const fm: V3 = add(mul(hip, 0.5), mul(knee, 0.5));
        const tm: V3 = add(mul(knee, 0.5), mul(ankle, 0.5));
        b.limb({
          pts: [hip, fm, knee, tm, ankle, ft],
          r: [sp.r * 1.05, sp.r * 1.1, sp.r * 0.8, sp.r * 0.72, sp.r * 0.5, sp.r * 0.25],
          w: [0, 0.25, 0.5, 0.75, 1, 1],
          radial: LRAD[lod],
          col: [col, c2, col, c2, col, c2],
          ao: [0.55, 0.8, 0.95, 1, 1, 1],
        });
      }
    }
  });
}

function sphere(b: GeoBuilder, c: V3, r: number, col: RGB, lod: GeometryLod, squashZ = 1): void {
  b.blob({ a: add(c, [0, 0, -r * squashZ]), b: add(c, [0, 0, r * squashZ]), rings: lod === 0 ? 8 : 4, radial: lod === 0 ? 12 : 6, rx: (t) => r * prof(t), col, ao: () => 1 });
}

// ---------------------------------------------------------------------------------------------
function jumpingSpider(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = RAD[lod];
  const K = RNG[lod];
  const waist: V3 = [0, 0.01, 0.0];
  const neck: V3 = [0, 0.02, 0.2];
  // abdomen with chevron pattern
  b.set(BodyPart.gaster, 0, waist);
  b.blob({
    a: [0, 0.02, 0.03],
    b: [0, -0.01, -0.5],
    rings: K + 2,
    radial: R,
    rx: (t) => 0.19 * prof(t, 0.45, 0.5, 0.6),
    ry: (t) => 0.165 * prof(t, 0.45, 0.5, 0.6),
    off: (t) => [0, 0.03 * Math.sin(Math.PI * t)],
    w: (t) => t,
    col: (t, th) => {
      const top = Math.max(0, Math.sin(th));
      const chev = Math.abs(((t * 4.5 + Math.abs(Math.cos(th)) * 1.2) % 1) - 0.5) < 0.14 ? 1 : 0;
      const k = 1 + top * chev * 2.2 + 0.9 * gauss(Math.cos(th), 0.12) * top;
      return [k, k * 0.95, k * 0.85];
    },
  });
  // cephalothorax: tall, flat-faced box
  b.set(BodyPart.head, 0, neck);
  b.blob({
    a: [0, 0.01, -0.03],
    b: [0, 0.01, 0.455],
    rings: K + 2,
    radial: R,
    rx: (t) => 0.2 * prof(t, 0.6, 0.45, 0.2),
    ry: (t) => 0.155 * prof(t, 0.62, 0.5, 0.2),
    off: (t) => [0, 0.035 * sstep(0.2, 0.8, t)],
    shape: (th) => 1 + 0.1 * Math.pow(Math.abs(Math.sin(2 * th)), 2) - (Math.sin(th) < 0 ? 0.25 * Math.pow(-Math.sin(th), 2) : 0),
    col: (t, th) => {
      const band = gauss(t - 0.72, 0.07) * Math.max(0, Math.sin(th) + 0.3);
      const k = 1 + band * 2.5;
      return [k, k * 0.95, k * 0.82];
    },
  });
  // the eyes: two enormous anterior medians, two laterals, four on the carapace
  b.set(BodyPart.eye, 0, neck);
  const eyeCol: RGB = [0.015, 0.015, 0.02];
  for (const sd of [-1, 1]) {
    sphere(b, [sd * 0.068, 0.062, 0.435], 0.062, eyeCol, lod, 0.75);
    if (lod < 2) {
      sphere(b, [sd * 0.16, 0.085, 0.405], 0.036, eyeCol, lod, 0.8);
      sphere(b, [sd * 0.165, 0.145, 0.27], 0.016, eyeCol, lod);
      sphere(b, [sd * 0.15, 0.15, 0.14], 0.027, eyeCol, lod);
    }
  }
  // chelicerae — iridescent green fangs
  for (const sd of [-1, 1]) {
    const base: V3 = [sd * 0.05, -0.045, 0.43];
    b.set(BodyPart.mandible, sd > 0 ? 1 : 0, base);
    b.limb({ pts: [base, [sd * 0.055, -0.12, 0.47], [sd * 0.03, -0.19, 0.46]], r: [0.04, 0.034, 0.006], w: [0, 0.6, 1], radial: LRAD[lod] + 1, col: [[0.5, 3.2, 2.0], [0.4, 3.6, 2.4], [0.2, 0.2, 0.2]], smooth: lod === 0 ? 2 : 0 });
    // pedipalps — fluffy white, constantly waving (antenna part)
    const pb: V3 = [sd * 0.105, -0.02, 0.4];
    b.set(BodyPart.antenna, sd > 0 ? 1 : 0, pb);
    b.limb({ pts: [pb, [sd * 0.13, 0.0, 0.5], [sd * 0.09, -0.07, 0.555]], r: [0.022, 0.028, 0.02], radial: LRAD[lod], col: [[2, 1.9, 1.7], [6, 6, 5.5], [7, 7, 6.5]], smooth: lod === 0 ? 2 : 0 });
  }
  const dark: RGB = [0.8, 0.75, 0.7];
  const lite: RGB = [2.4, 2.2, 1.9];
  addLegs(
    b,
    lod,
    [
      { hip: [0.15, -0.03, 0.34], foot: [0.34, FOOT, 0.7], knee: 0.13, r: 0.042 },
      { hip: [0.17, -0.03, 0.25], foot: [0.5, FOOT, 0.4], knee: 0.12, r: 0.032 },
      { hip: [0.17, -0.03, 0.15], foot: [0.5, FOOT, -0.06], knee: 0.12, r: 0.03 },
      { hip: [0.15, -0.03, 0.06], foot: [0.38, FOOT, -0.38], knee: 0.14, r: 0.034 },
    ],
    dark,
    lite,
  );
  return b.build({ neck, waist, legs: 8, stride: 0.5, duty: 0.62, lift: 0.07, marker: [0.2, -0.25, 0, 0], mouth: [0, -0.2, 0.5] });
}

// ---------------------------------------------------------------------------------------------
function antlion(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = RAD[lod];
  const K = RNG[lod];
  const waist: V3 = [0, -0.06, 0.08];
  const neck: V3 = [0, -0.05, 0.24];
  b.set(BodyPart.gaster, 0, waist);
  b.blob({
    a: [0, -0.06, 0.12],
    b: [0, -0.08, -0.5],
    rings: K + 4,
    radial: R,
    rx: (t) => 0.27 * prof(t, 0.45, 0.5, 0.7) * (1 + 0.05 * Math.cos(t * 50)),
    ry: (t) => 0.15 * prof(t, 0.4, 0.5, 0.7) * (1 + 0.05 * Math.cos(t * 50)),
    shape: (th, t) => (Math.sin(th) < 0 ? 0.6 : 1) + 0.06 * vnoise(th * 3, t * 12, 1),
    w: (t) => t,
    col: (t, th) => {
      const k = 0.8 + 0.5 * vnoise(th * 4, t * 16, 3);
      return [k, k, k];
    },
  });
  b.set(BodyPart.thorax);
  b.blob({ a: [0, -0.06, 0.05], b: [0, -0.05, 0.28], rings: K, radial: R, rx: (t) => 0.14 * prof(t, 0.4), ry: (t) => 0.09 * prof(t, 0.4) });
  b.set(BodyPart.head, 0, neck);
  b.blob({ a: [0, -0.05, 0.22], b: [0, -0.06, 0.4], rings: K, radial: R, rx: (t) => 0.105 * prof(t, 0.55, 0.4, 0.25), ry: (t) => 0.05 * prof(t, 0.5, 0.4, 0.3), col: [0.75, 0.6, 0.45] });
  // sickle jaws with teeth
  for (const sd of [-1, 1]) {
    const base: V3 = [sd * 0.07, -0.06, 0.39];
    b.set(BodyPart.mandible, sd > 0 ? 1 : 0, base);
    const pts: V3[] = [base, [sd * 0.14, -0.05, 0.52], [sd * 0.15, -0.04, 0.66], [sd * 0.06, -0.03, 0.78]];
    b.limb({ pts, r: [0.03, 0.026, 0.018, 0.003], w: [0, 0.4, 0.75, 1], radial: LRAD[lod] + 1, flat: 0.6, smooth: lod === 0 ? 3 : lod === 1 ? 1 : 0, col: [0.5, 0.25, 0.12] });
    if (lod < 2) {
      for (let i = 0; i < 3; i++) {
        const p = pts[1 + Math.min(1, i)];
        const q: V3 = [lerp(p[0], pts[2][0], i * 0.4), p[1], lerp(p[2], pts[2][2], i * 0.45)];
        b.limb({ pts: [q, add(q, [-sd * 0.045, 0, 0.015])], r: [0.01, 0.001], w: [0.5, 0.5], radial: 3, col: [0.3, 0.14, 0.08] });
      }
    }
  }
  addLegs(
    b,
    lod,
    [
      { hip: [0.1, -0.08, 0.24], foot: [0.26, FOOT, 0.38], knee: -0.02, r: 0.018 },
      { hip: [0.12, -0.08, 0.14], foot: [0.34, FOOT, 0.12], knee: -0.02, r: 0.018 },
      { hip: [0.12, -0.08, 0.05], foot: [0.3, FOOT, -0.16], knee: -0.02, r: 0.02 },
    ],
    [0.9, 0.8, 0.65],
  );
  return b.build({ neck, waist, legs: 6, stride: 0.3, duty: 0.65, lift: 0.04, marker: [0.15, -0.2, 0, 0], mouth: [0, -0.04, 0.7] });
}

// ---------------------------------------------------------------------------------------------
function groundBeetle(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = RAD[lod] + (lod === 0 ? 8 : 0);
  const K = RNG[lod];
  const waist: V3 = [0, 0, 0.06];
  const neck: V3 = [0, -0.01, 0.3];
  // elytra: domed, grooved wing cases with a centre seam
  b.set(BodyPart.thorax);
  b.blob({
    a: [0, -0.02, -0.5],
    b: [0, -0.02, 0.1],
    rings: K + 2,
    radial: R,
    rx: (t) => 0.235 * prof(t, 0.6, 0.62, 0.4),
    ry: (t) => 0.15 * prof(t, 0.6, 0.6, 0.4),
    shape: (th) => {
      const top = Math.sin(th);
      if (top < 0) return 0.55 + 0.45 * (1 + top);
      return 1 - (lod === 0 ? 0.022 * (0.5 + 0.5 * Math.cos(Math.cos(th) * 26)) : 0) - 0.05 * gauss(Math.cos(th), 0.035);
    },
  });
  // pronotum shield with flared margins
  b.blob({
    a: [0, -0.02, 0.06],
    b: [0, -0.02, 0.31],
    rings: K,
    radial: R,
    rx: (t) => 0.18 * prof(t, 0.45, 0.35, 0.3),
    ry: (t) => 0.1 * prof(t, 0.45, 0.4, 0.35),
    shape: (th) => (Math.sin(th) < 0 ? 0.65 : 1) + 0.12 * Math.pow(Math.abs(Math.cos(th)), 8),
  });
  b.set(BodyPart.head, 0, neck);
  b.blob({ a: [0, -0.02, 0.27], b: [0, -0.04, 0.43], rings: K, radial: RAD[lod], rx: (t) => 0.095 * prof(t, 0.45, 0.4, 0.4), ry: (t) => 0.06 * prof(t, 0.45, 0.4, 0.4) });
  b.set(BodyPart.eye, 0, neck);
  if (lod < 2) for (const sd of [-1, 1]) sphere(b, [sd * 0.088, -0.015, 0.355], 0.026, [0.02, 0.02, 0.02], lod);
  for (const sd of [-1, 1]) {
    const base: V3 = [sd * 0.045, -0.045, 0.42];
    b.set(BodyPart.mandible, sd > 0 ? 1 : 0, base);
    b.limb({ pts: [base, [sd * 0.07, -0.05, 0.48], [sd * 0.015, -0.05, 0.53]], r: [0.024, 0.02, 0.003], w: [0, 0.5, 1], radial: LRAD[lod], flat: 0.6, smooth: lod === 0 ? 2 : 0, col: [0.5, 0.2, 0.1] });
    const ab: V3 = [sd * 0.07, 0.0, 0.4];
    b.set(BodyPart.antenna, sd > 0 ? 1 : 0, ab);
    const n = lod === 0 ? 10 : lod === 1 ? 4 : 2;
    const pts: V3[] = [];
    const rr: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(add(ab, [sd * (0.1 * t + 0.14 * t * t), 0.05 * Math.sin(t * 2.5), 0.3 * t - 0.08 * t * t]));
      rr.push(0.011 * (lod === 0 && i % 2 === 1 ? 1.2 : 0.85) * (1 - 0.3 * t));
    }
    b.limb({ pts, r: rr, radial: LRAD[lod], col: [0.9, 0.5, 0.3] });
  }
  const lc: RGB = [0.9, 0.45, 0.25];
  addLegs(
    b,
    lod,
    [
      { hip: [0.1, -0.09, 0.2], foot: [0.3, FOOT, 0.42], knee: -0.02, r: 0.024 },
      { hip: [0.12, -0.1, 0.06], foot: [0.4, FOOT, 0.02], knee: 0.0, r: 0.026 },
      { hip: [0.12, -0.1, -0.06], foot: [0.36, FOOT, -0.42], knee: 0.0, r: 0.028 },
    ],
    lc,
  );
  return b.build({ neck, waist, legs: 6, stride: 0.5, duty: 0.62, lift: 0.05, marker: [0.18, -0.2, 0, 0], mouth: [0, -0.05, 0.56] });
}

// ---------------------------------------------------------------------------------------------
function wasp(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = RAD[lod];
  const K = RNG[lod];
  const waist: V3 = [0, 0.0, -0.06];
  const neck: V3 = [0, 0.03, 0.3];
  b.set(BodyPart.thorax);
  b.blob({ a: [0, 0.01, -0.04], b: [0, 0.02, 0.32], rings: K + 2, radial: R, rx: (t) => 0.1 * prof(t, 0.55, 0.45, 0.45), ry: (t) => 0.11 * prof(t, 0.55, 0.45, 0.45), col: (t) => (t > 0.8 ? [6, 3.2, 0.6] : [1, 1, 1]) });
  b.set(BodyPart.petiole);
  if (lod < 2) b.limb({ pts: [[0, 0, -0.02], [0, -0.015, -0.1], [0, -0.01, -0.16]], r: [0.022, 0.014, 0.022], radial: 6, col: [4, 2, 0.4] });
  b.set(BodyPart.gaster, 0, waist);
  const stripes = (t: number): RGB => (((t * 5) % 1) < 0.42 ? [7, 3.6, 0.5] : [1, 1, 1]);
  b.blob({ a: [0, -0.01, -0.14], b: [0, -0.07, -0.5], rings: K + 4, radial: R, rx: (t) => 0.085 * prof(t, 0.38, 0.6, 0.9), ry: (t) => 0.085 * prof(t, 0.38, 0.6, 0.9), w: (t) => t, col: stripes, even: true });
  // ovipositor
  b.limb({ pts: [[0, -0.07, -0.49], [0, -0.1, -0.62], [0, -0.16, -0.74]], r: [0.008, 0.005, 0.001], w: [1, 1, 1], radial: 3, col: [0.3, 0.2, 0.1] });
  b.set(BodyPart.head, 0, neck);
  b.blob({ a: [0, 0.05, 0.3], b: [0, -0.04, 0.44], rings: K, radial: R, rx: (t) => 0.095 * prof(t, 0.4, 0.5, 0.6), ry: (t) => 0.07 * prof(t, 0.4, 0.5, 0.6), col: [1, 1, 1] });
  b.set(BodyPart.eye, 0, neck);
  if (lod < 2)
    for (const sd of [-1, 1])
      b.blob({ a: [sd * 0.075, 0.055, 0.33], b: [sd * 0.06, -0.01, 0.41], rings: 6, radial: 8, rx: (t) => 0.028 * prof(t), ry: (t) => 0.04 * prof(t), col: [0.03, 0.02, 0.02], ao: () => 1 });
  for (const sd of [-1, 1]) {
    const mb: V3 = [sd * 0.035, -0.04, 0.43];
    b.set(BodyPart.mandible, sd > 0 ? 1 : 0, mb);
    b.limb({ pts: [mb, [sd * 0.01, -0.07, 0.47]], r: [0.015, 0.003], radial: 3, col: [5, 2.5, 0.5] });
    const ab: V3 = [sd * 0.03, 0.04, 0.42];
    b.set(BodyPart.antenna, sd > 0 ? 1 : 0, ab);
    const n = lod === 0 ? 8 : 3;
    const pts: V3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(add(ab, [sd * (0.12 * t + 0.1 * t * t), 0.1 * Math.sin(t * 2.2), 0.34 * t]));
    }
    b.limb({ pts, r: 0.008, radial: LRAD[lod], col: [1.5, 1.2, 1] });
  }
  const lc: RGB = [6, 3, 0.6];
  addLegs(
    b,
    lod,
    [
      { hip: [0.05, -0.07, 0.24], foot: [0.22, FOOT, 0.4], knee: 0.02, r: 0.012 },
      { hip: [0.06, -0.08, 0.13], foot: [0.3, FOOT, 0.1], knee: 0.04, r: 0.012 },
      { hip: [0.06, -0.08, 0.02], foot: [0.27, FOOT, -0.3], knee: 0.06, r: 0.013 },
    ],
    lc,
  );
  b.beginBlend();
  for (const sd of [-1, 1]) {
    // wings: fore + hind, folded back; the material spreads and flaps them when flying
    for (let wi = 0; wi < (lod === 2 ? 1 : 2); wi++) {
      const root: V3 = [sd * 0.07, 0.11, wi === 0 ? 0.18 : 0.08];
      b.set(BodyPart.wing, sd > 0 ? 1 : 0, root);
      const span = wi === 0 ? 0.78 : 0.55;
      const chord = wi === 0 ? 0.2 : 0.15;
      b.sheet(
        lod === 0 ? 10 : lod === 1 ? 5 : 2,
        lod === 0 ? 5 : lod === 1 ? 3 : 1,
        (u, v) => {
          const width = chord * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + u * 0.92)), 0.6) * (0.3 + 0.7 * sstep(0, 0.35, u));
          return add(root, [sd * (u * span * (0.18 + wi * 0.1) + (v - 0.3) * width), u * 0.03 + 0.012 * (1 - wi), -u * span]);
        },
        (u) => u,
        (u, v) => Math.max(v < 0.12 ? 1 : 0, Math.abs(((v * 2.5 + u * 0.5) % 1) - 0.5) < 0.1 ? 0.8 : 0.12),
        [1.2, 1.0, 0.7],
      );
    }
  }
  return b.build({ neck, waist, legs: 6, stride: 0.5, duty: 0.6, lift: 0.06, marker: [0.15, -0.3, 0, 0], mouth: [0, -0.08, 0.48] });
}

// ---------------------------------------------------------------------------------------------
function mantis(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = RAD[lod];
  const K = RNG[lod];
  const waist: V3 = [0, -0.02, -0.08];
  const neck: V3 = [0, 0.2, 0.3];
  // abdomen
  b.set(BodyPart.gaster, 0, waist);
  b.blob({ a: [0, -0.02, -0.06], b: [0, -0.05, -0.5], rings: K + 4, radial: R, rx: (t) => 0.065 * prof(t, 0.5, 0.5, 0.7) * (1 + 0.04 * Math.cos(t * 44)), ry: (t) => 0.05 * prof(t, 0.5, 0.5, 0.7), w: (t) => t, col: [1.15, 1.1, 0.8] });
  // folded wings lying over the abdomen like a leaf
  if (lod < 2) {
    b.set(BodyPart.other);
    for (const sd of [-1, 1])
      b.sheet(
        lod === 0 ? 8 : 4,
        2,
        (u, v) => [sd * (0.005 + v * 0.06 * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.85))), 0.045 - v * 0.03 - u * 0.025, -0.04 - u * 0.5],
        () => 0,
        () => 0.95,
        (u, v) => [0.9 + 0.3 * v, 1.0 + 0.2 * v, 0.7],
      );
  }
  // mesothorax + long raised prothorax
  b.set(BodyPart.thorax);
  b.blob({ a: [0, -0.02, -0.1], b: [0, 0.0, 0.06], rings: K, radial: R, rx: (t) => 0.05 * prof(t), ry: (t) => 0.05 * prof(t) });
  b.limb({ pts: [[0, -0.01, 0.02], [0, 0.07, 0.12], [0, 0.16, 0.24], [0, 0.2, 0.31]], r: [0.036, 0.028, 0.03, 0.022], radial: LRAD[lod] + 2, smooth: lod === 0 ? 2 : 0, flat: 0.8, w: [0, 0, 0, 0] });
  // triangular head
  b.set(BodyPart.head, 0, neck);
  b.blob({ a: [0, 0.285, 0.3], b: [0, 0.16, 0.385], rings: K, radial: R, rx: (t) => 0.082 * prof(t, 0.25, 0.4, 1.0), ry: (t) => 0.04 * prof(t, 0.3, 0.5, 0.8) });
  b.set(BodyPart.eye, 0, neck);
  for (const sd of [-1, 1]) {
    if (lod < 2) b.blob({ a: [sd * 0.062, 0.275, 0.305], b: [sd * 0.072, 0.235, 0.355], rings: 6, radial: 8, rx: (t) => 0.03 * prof(t), ry: (t) => 0.034 * prof(t), col: [0.25, 0.6, 0.1], ao: () => 1 });
    const ab: V3 = [sd * 0.02, 0.27, 0.34];
    b.set(BodyPart.antenna, sd > 0 ? 1 : 0, ab);
    b.limb({ pts: [ab, [sd * 0.06, 0.4, 0.4], [sd * 0.12, 0.46, 0.52], [sd * 0.16, 0.44, 0.66]], r: [0.005, 0.004, 0.003, 0.002], radial: 3, smooth: lod === 0 ? 2 : 0 });
    const mb: V3 = [sd * 0.015, 0.165, 0.385];
    b.set(BodyPart.mandible, sd > 0 ? 1 : 0, mb);
    b.limb({ pts: [mb, [sd * 0.004, 0.145, 0.4]], r: [0.01, 0.002], radial: 3, col: [0.5, 0.3, 0.1] });
    // raptorial arm: coxa down-forward, spined femur folded up, tibia hooked back down
    const sh: V3 = [sd * 0.035, 0.165, 0.27];
    b.set(BodyPart.arm, sd > 0 ? 1 : 0, sh);
    const e1: V3 = [sd * 0.06, 0.03, 0.4];
    const e2: V3 = [sd * 0.065, 0.2, 0.47];
    const tip: V3 = [sd * 0.058, 0.07, 0.5];
    b.limb({ pts: [sh, e1], r: [0.018, 0.02], w: [0, 0.35], radial: LRAD[lod] });
    b.limb({ pts: [e1, add(mul(e1, 0.5), mul(e2, 0.5)), e2], r: [0.022, 0.032, 0.02], w: [0.35, 0.55, 0.75], radial: LRAD[lod] + 1, flat: 1.4 });
    b.limb({ pts: [e2, add(mul(e2, 0.5), mul(tip, 0.5)), tip, add(tip, [0, -0.04, -0.03])], r: [0.016, 0.013, 0.008, 0.001], w: [0.75, 0.9, 1, 1], radial: LRAD[lod], col: [1.2, 0.9, 0.5] });
    if (lod === 0)
      for (let i = 1; i < 6; i++) {
        const q: V3 = [lerp(e1[0], e2[0], i / 6), lerp(e1[1], e2[1], i / 6), lerp(e1[2], e2[2], i / 6) + 0.025];
        b.limb({ pts: [q, add(q, [0, -0.012, 0.03])], r: [0.005, 0.0005], w: [0.6, 0.6], radial: 3, col: [0.4, 0.25, 0.1] });
      }
  }
  addLegs(
    b,
    lod,
    [
      { hip: [0.035, -0.03, 0.03], foot: [0.32, FOOT, 0.16], knee: 0.14, r: 0.011 },
      { hip: [0.035, -0.04, -0.07], foot: [0.3, FOOT, -0.34], knee: 0.16, r: 0.012 },
    ],
    [1, 1, 0.8],
  );
  return b.build({ neck, waist, legs: 4, stride: 0.4, duty: 0.7, lift: 0.06, marker: [0, -0.25, 0, 0], mouth: [0, 0.13, 0.42] });
}

// ---------------------------------------------------------------------------------------------
function aphid(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = RAD[lod];
  const K = RNG[lod];
  const waist: V3 = [0, 0.02, 0.15];
  const neck: V3 = [0, 0.0, 0.3];
  b.set(BodyPart.gaster, 0, waist);
  b.blob({ a: [0, 0.0, 0.34], b: [0, 0.02, -0.5], rings: K + 2, radial: R, rx: (t) => 0.3 * prof(t, 0.62, 0.6, 0.5), ry: (t) => 0.27 * prof(t, 0.62, 0.6, 0.5), off: (t) => [0, 0.05 * Math.sin(Math.PI * t)], w: (t) => t * 0.4, shape: (th) => (Math.sin(th) < 0 ? 0.75 : 1) });
  b.set(BodyPart.head, 0, neck);
  b.blob({ a: [0, -0.02, 0.26], b: [0, -0.06, 0.5], rings: K, radial: R, rx: (t) => 0.13 * prof(t, 0.4), ry: (t) => 0.1 * prof(t, 0.4), col: [0.9, 1, 0.8] });
  b.set(BodyPart.eye, 0, neck);
  for (const sd of [-1, 1]) {
    if (lod < 2) sphere(b, [sd * 0.105, 0.0, 0.4], 0.032, [0.5, 0.02, 0.02], lod);
    const ab: V3 = [sd * 0.05, 0.03, 0.45];
    b.set(BodyPart.antenna, sd > 0 ? 1 : 0, ab);
    b.limb({ pts: [ab, [sd * 0.2, 0.2, 0.36], [sd * 0.3, 0.3, 0.05], [sd * 0.34, 0.3, -0.3]], r: [0.014, 0.011, 0.008, 0.004], radial: 3, smooth: lod === 0 ? 2 : 0, col: [0.6, 0.7, 0.4] });
    // cornicles ("tail pipes") where the honeydew comes from
    if (lod < 2) {
      b.set(BodyPart.other);
      b.limb({ pts: [[sd * 0.13, 0.2, -0.28], [sd * 0.17, 0.3, -0.42]], r: [0.022, 0.012], w: [0, 0], radial: 4, col: [0.4, 0.5, 0.25] });
    }
  }
  addLegs(
    b,
    lod,
    [
      { hip: [0.12, -0.12, 0.3], foot: [0.36, FOOT, 0.44], knee: -0.02, r: 0.016 },
      { hip: [0.16, -0.14, 0.14], foot: [0.46, FOOT, 0.1], knee: 0.0, r: 0.016 },
      { hip: [0.16, -0.14, -0.04], foot: [0.42, FOOT, -0.3], knee: 0.02, r: 0.016 },
    ],
    [0.55, 0.65, 0.35],
  );
  return b.build({ neck, waist, legs: 6, stride: 0.35, duty: 0.7, lift: 0.04, marker: [0.1, -0.15, 0, 0], mouth: [0, -0.1, 0.52] });
}

// ---------------------------------------------------------------------------------------------
function caterpillar(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = RAD[lod];
  const segs = 12;
  const r0 = 0.085;
  const neck: V3 = [0, -0.11, 0.42];
  b.set(BodyPart.thorax);
  b.blob({
    a: [0, -0.115, -0.5],
    b: [0, -0.115, 0.45],
    rings: lod === 0 ? segs * 4 : lod === 1 ? segs * 2 : 6,
    radial: R,
    even: true,
    rx: (t) => r0 * prof(t, 0.5, 0.22, 0.22) * (1 + (lod < 2 ? 0.09 * Math.cos(t * segs * Math.PI * 2) : 0)),
    w: (t) => t,
    shape: (th) => (Math.sin(th) < -0.6 ? 0.88 : 1),
    col: (t, th) => {
      const s = Math.sin(th);
      const stripe = gauss(s + 0.15, 0.1); // pale lateral line
      const dots = Math.cos(t * segs * Math.PI * 2) > 0.7 && s > 0.2 && Math.abs(Math.cos(th)) > 0.45 && Math.abs(Math.cos(th)) < 0.8 ? 1 : 0;
      return [1 + stripe * 2.2 + dots * 2.5, 1 + stripe * 1.2 - dots * 0.5, 1 + stripe * 0.5 - dots * 0.8];
    },
  });
  b.set(BodyPart.head, 0, neck);
  b.blob({ a: [0, -0.115, 0.4], b: [0, -0.125, 0.52], rings: RNG[lod], radial: R, rx: (t) => 0.07 * prof(t, 0.45, 0.45, 0.4), col: [0.35, 0.22, 0.08] });
  for (const sd of [-1, 1]) {
    const mb: V3 = [sd * 0.025, -0.15, 0.51];
    b.set(BodyPart.mandible, sd > 0 ? 1 : 0, mb);
    b.limb({ pts: [mb, [sd * 0.005, -0.16, 0.535]], r: [0.012, 0.002], radial: 3, col: [0.15, 0.08, 0.04] });
  }
  // true legs (3 pairs) and prolegs (5 pairs) — tiny stubs that ride the body wave
  if (lod < 2) {
    b.set(BodyPart.other);
    const zs = [0.36, 0.3, 0.24, 0.02, -0.06, -0.14, -0.22, -0.44];
    zs.forEach((z, i) => {
      for (const sd of [-1, 1]) {
        const top: V3 = [sd * 0.045, -0.17, z];
        b.limb({ pts: [top, [sd * 0.055, FOOT + 0.005, z]], r: i < 3 ? [0.012, 0.004] : [0.022, 0.018], w: [(z + 0.5) / 0.95, (z + 0.5) / 0.95], radial: 4, col: i < 3 ? [0.4, 0.3, 0.1] : [0.9, 1.1, 0.7] });
      }
    });
  }
  return b.build({ neck, waist: [0, -0.11, -0.1], legs: 0, stride: 0.5, duty: 0.6, lift: 0, crawl: 0.035, marker: [0, -0.2, 0, 0], mouth: [0, -0.15, 0.55] });
}

function worm(lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const r0 = 0.036;
  b.set(BodyPart.thorax);
  b.blob({
    a: [0, FOOT + r0, -0.5],
    b: [0, FOOT + r0, 0.5],
    rings: lod === 0 ? 96 : lod === 1 ? 32 : 8,
    radial: lod === 0 ? 14 : lod === 1 ? 8 : 5,
    even: true,
    rx: (t) => r0 * prof(t, 0.5, 0.16, 0.3) * (1 + 0.25 * gauss(t - 0.68, 0.05)) * (1 + (lod === 0 ? 0.05 * Math.cos(t * 60 * Math.PI * 2) : 0)),
    off: (t) => [0.07 * Math.sin(t * 7.5) * (lod < 2 ? 1 : 0.6), 0],
    w: (t) => t,
    col: (t) => {
      const cl = gauss(t - 0.68, 0.05);
      return [1 + cl * 0.6, 1 + cl * 0.35, 1 + cl * 0.3];
    },
  });
  return b.build({ neck: [0, FOOT + r0, 0.4], waist: [0, FOOT + r0, 0], legs: 0, stride: 0.4, duty: 0.6, lift: 0, crawl: 0.02, marker: [0, 0, 0, 0], mouth: [0, FOOT + r0, 0.52] });
}

export function buildCreature(id: CreatureId, lod: GeometryLod): THREE.BufferGeometry {
  switch (id) {
    case 'jumpingSpider':
      return jumpingSpider(lod);
    case 'antlion':
      return antlion(lod);
    case 'groundBeetle':
      return groundBeetle(lod);
    case 'wasp':
      return wasp(lod);
    case 'mantis':
      return mantis(lod);
    case 'aphid':
      return aphid(lod);
    case 'caterpillar':
      return caterpillar(lod);
    case 'worm':
      return worm(lod);
  }
}

const L: CreatureLook = {
  color: [0.1, 0.08, 0.06],
  roughness: 0.5,
  clearcoat: 0.4,
  iridescence: 0,
  translucency: 0,
  translucencyColor: [1, 0.5, 0.2],
  translucencyAll: false,
  wax: 0,
  sheen: 0.3,
  bands: 0,
  sting: 0,
};

export const CREATURE_LOOKS: Record<CreatureId, CreatureLook> = {
  jumpingSpider: { ...L, color: [0.075, 0.055, 0.04], roughness: 0.8, clearcoat: 0.1, sheen: 1 },
  antlion: { ...L, color: [0.3, 0.24, 0.17], roughness: 0.85, clearcoat: 0.05, sheen: 0.6 },
  groundBeetle: { ...L, color: [0.03, 0.035, 0.05], roughness: 0.22, clearcoat: 1, iridescence: 1, sheen: 0 },
  wasp: { ...L, color: [0.03, 0.025, 0.02], roughness: 0.3, clearcoat: 0.8, iridescence: 0.3, bands: 5, sting: 1 },
  mantis: { ...L, color: [0.16, 0.36, 0.06], roughness: 0.55, clearcoat: 0.3, translucency: 0.35, translucencyColor: [0.6, 1, 0.2], translucencyAll: true, wax: 0.4, bands: 8 },
  aphid: { ...L, color: [0.3, 0.5, 0.1], roughness: 0.45, clearcoat: 0.5, translucency: 0.7, translucencyColor: [0.7, 1, 0.3], translucencyAll: true, wax: 0.8 },
  caterpillar: { ...L, color: [0.2, 0.4, 0.06], roughness: 0.6, clearcoat: 0.15, translucency: 0.4, translucencyColor: [0.7, 1, 0.3], translucencyAll: true, wax: 0.7, sheen: 0.6 },
  worm: { ...L, color: [0.45, 0.2, 0.16], roughness: 0.25, clearcoat: 0.9, translucency: 0.5, translucencyColor: [1, 0.4, 0.3], translucencyAll: true, wax: 0.8, sheen: 0 },
};
