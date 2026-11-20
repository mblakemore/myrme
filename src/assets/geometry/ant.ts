import type * as THREE from 'three';
import { BodyPart, RIDE_PER_LENGTH, type CasteId, type CreatureLook, type GeometryLod, type SpeciesId } from '../../core';
import { GeoBuilder, add, gauss, lerp, mul, norm, prof, sstep, type RGB, type V3 } from './builder';

/**
 * Parametric ant / termite builder (A4). All lengths are in body lengths; the builder
 * normalises head + mesosoma + waist + gaster to a total length of 1 (−0.5 … +0.5 along Z).
 */
export interface AntGeoParams {
  headLen: number;
  headW: number;
  headH: number;
  headShape: 'oval' | 'heart' | 'box' | 'nasute' | 'round';
  /** Downward tilt of the head axis in radians (ants carry the face angled down). */
  headTilt: number;
  /** Compound eye radius (0 = blind). */
  eye: number;
  mandLen: number;
  mandW: number;
  /** Inward hook of the mandible tips (fraction of length). */
  mandCurve: number;
  scape: number;
  funic: number;
  antThick: number;
  /** 1 = elbowed ant antenna, 0 = straight beaded termite antenna. */
  elbow: number;
  thLen: number;
  thW: number;
  thH: number;
  /** Pronotum hump height. */
  hump: number;
  /** Mesonotal constriction depth 0..1. */
  constrict: number;
  /** Dorsal spine pairs (leafcutters). */
  spines: number;
  nodes: 0 | 1 | 2;
  nodeH: number;
  gaLen: number;
  gaW: number;
  gaH: number;
  gaSegs: number;
  /** Tip sharpness exponent (0.5 round … 1.2 pointed). */
  gaPoint: number;
  stinger: number;
  legLen: number;
  legThick: number;
  /** How far the body hangs below the pose origin (low-slung between tall knees). */
  drop: number;
  wings: boolean;
  wingScars: boolean;
  /** Vertex colour multipliers (albedo = instance colour × these). */
  cHead: RGB;
  cThorax: RGB;
  cGaster: RGB;
  cLegs: RGB;
  cMand: RGB;
  cAnt: RGB;
}

const BASE: AntGeoParams = {
  headLen: 0.21,
  headW: 0.17,
  headH: 0.13,
  headShape: 'oval',
  headTilt: 0.45,
  eye: 0.024,
  mandLen: 0.08,
  mandW: 0.03,
  mandCurve: 0.35,
  scape: 0.15,
  funic: 0.2,
  antThick: 0.0068,
  elbow: 1,
  thLen: 0.33,
  thW: 0.12,
  thH: 0.125,
  hump: 0.25,
  constrict: 0.3,
  spines: 0,
  nodes: 1,
  nodeH: 0.085,
  gaLen: 0.36,
  gaW: 0.23,
  gaH: 0.2,
  gaSegs: 5,
  gaPoint: 0.62,
  stinger: 0,
  legLen: 1,
  legThick: 1,
  drop: 0.07,
  wings: false,
  wingScars: false,
  cHead: [1, 1, 1],
  cThorax: [1, 1, 1],
  cGaster: [1, 1, 1],
  cLegs: [1.5, 1.2, 1.0],
  cMand: [1.3, 0.8, 0.55],
  cAnt: [1.5, 1.25, 1.05],
};

type P = Partial<AntGeoParams>;

const SPECIES_BASE: Record<SpeciesId, P> = {
  gardenAnt: {},
  fireAnt: {
    nodes: 2,
    nodeH: 0.07,
    stinger: 0.05,
    headW: 0.18,
    headLen: 0.21,
    headShape: 'box',
    thW: 0.105,
    thH: 0.11,
    constrict: 0.45,
    gaLen: 0.33,
    gaW: 0.2,
    gaH: 0.18,
    gaPoint: 0.8,
    cGaster: [0.45, 0.32, 0.3],
    cLegs: [1.15, 1.05, 0.95],
    cMand: [0.9, 0.6, 0.45],
    cAnt: [1.1, 1.0, 0.9],
  },
  leafcutter: {
    nodes: 2,
    nodeH: 0.065,
    spines: 3,
    headShape: 'heart',
    headW: 0.2,
    headLen: 0.2,
    headH: 0.16,
    thW: 0.11,
    hump: 0.35,
    constrict: 0.35,
    gaLen: 0.3,
    gaW: 0.2,
    gaH: 0.18,
    legLen: 1.18,
    cLegs: [1.1, 1.0, 0.9],
    cMand: [0.8, 0.55, 0.4],
    cAnt: [1.1, 1.0, 0.9],
    cGaster: [0.85, 0.8, 0.78],
  },
  termite: {
    nodes: 0,
    elbow: 0,
    eye: 0,
    headShape: 'round',
    headLen: 0.22,
    headW: 0.2,
    headH: 0.17,
    headTilt: 0.2,
    scape: 0.03,
    funic: 0.22,
    antThick: 0.01,
    thLen: 0.22,
    thW: 0.17,
    thH: 0.13,
    hump: 0.05,
    constrict: 0,
    gaLen: 0.52,
    gaW: 0.25,
    gaH: 0.2,
    gaSegs: 8,
    gaPoint: 0.45,
    legLen: 0.78,
    legThick: 1.1,
    drop: 0.1,
    mandLen: 0.05,
    cHead: [1.0, 0.72, 0.36],
    cThorax: [1.0, 0.95, 0.85],
    cGaster: [1.0, 0.97, 0.92],
    cLegs: [1.0, 0.95, 0.82],
    cMand: [0.4, 0.2, 0.1],
    cAnt: [1.0, 0.88, 0.7],
  },
};

const CASTE_MOD: Record<SpeciesId, Partial<Record<CasteId, P>>> = {
  gardenAnt: {
    soldier: { headLen: 0.26, headW: 0.26, headH: 0.2, headShape: 'heart', mandLen: 0.13, mandW: 0.03, mandCurve: 0.5, thW: 0.14, gaLen: 0.32, legThick: 1.2 },
    queen: { headLen: 0.14, headW: 0.13, headH: 0.11, thLen: 0.3, thW: 0.17, thH: 0.19, hump: 0.1, constrict: 0, gaLen: 0.56, gaW: 0.3, gaH: 0.27, gaSegs: 6, gaPoint: 0.5, wingScars: true, legLen: 0.82, legThick: 1.25, eye: 0.022, scape: 0.1, funic: 0.14 },
    alate: { headLen: 0.15, headW: 0.14, headH: 0.12, thLen: 0.34, thW: 0.16, thH: 0.19, hump: 0.1, constrict: 0, gaLen: 0.42, gaW: 0.2, gaH: 0.19, wings: true, legLen: 0.9, eye: 0.03 },
  },
  fireAnt: {
    soldier: { headLen: 0.27, headW: 0.27, headH: 0.2, mandLen: 0.11, mandW: 0.03, legThick: 1.15 },
    queen: { headLen: 0.15, headW: 0.15, headH: 0.12, thLen: 0.3, thW: 0.17, thH: 0.18, hump: 0.1, constrict: 0, gaLen: 0.5, gaW: 0.28, gaH: 0.25, gaPoint: 0.55, wingScars: true, legLen: 0.85, legThick: 1.2 },
    alate: { headLen: 0.15, headW: 0.14, headH: 0.12, thLen: 0.34, thW: 0.16, thH: 0.18, hump: 0.1, constrict: 0, gaLen: 0.4, wings: true, legLen: 0.9 },
  },
  leafcutter: {
    // minim: tiny gardener, small head, short legs
    worker: { headLen: 0.19, headW: 0.17, headH: 0.14, spines: 2, legLen: 0.95, mandLen: 0.05 },
    // media: the forager with long legs and serrated cutting mandibles
    major: { headLen: 0.23, headW: 0.25, headH: 0.19, mandLen: 0.1, mandW: 0.032, legLen: 1.25 },
    // major (soldier): absurdly big heart-shaped head
    soldier: { headLen: 0.31, headW: 0.36, headH: 0.26, mandLen: 0.13, mandW: 0.04, mandCurve: 0.45, thW: 0.14, gaLen: 0.26, gaW: 0.19, legThick: 1.3, legLen: 1.1 },
    queen: { headLen: 0.17, headW: 0.19, headH: 0.14, thLen: 0.32, thW: 0.2, thH: 0.2, hump: 0.1, constrict: 0, spines: 1, gaLen: 0.5, gaW: 0.3, gaH: 0.26, wingScars: true, legLen: 0.9, legThick: 1.3 },
    alate: { headLen: 0.16, headW: 0.17, headH: 0.13, thLen: 0.34, thW: 0.17, thH: 0.19, hump: 0.1, constrict: 0, spines: 1, gaLen: 0.4, wings: true, legLen: 0.95 },
  },
  termite: {
    soldier: { headLen: 0.4, headW: 0.24, headH: 0.19, headShape: 'box', mandLen: 0.2, mandW: 0.032, mandCurve: 0.3, gaLen: 0.4, cHead: [1.0, 0.55, 0.2], cMand: [0.18, 0.08, 0.05] },
    nasute: { headLen: 0.4, headW: 0.26, headH: 0.24, headShape: 'nasute', mandLen: 0.012, gaLen: 0.42, cHead: [0.85, 0.42, 0.16] },
    queen: { headLen: 0.085, headW: 0.085, headH: 0.07, thLen: 0.1, thW: 0.085, thH: 0.07, gaLen: 0.86, gaW: 0.34, gaH: 0.32, gaSegs: 9, gaPoint: 0.42, legLen: 0.32, legThick: 0.5, antThick: 0.004, funic: 0.08, eye: 0.008, cHead: [0.75, 0.45, 0.22], cThorax: [0.75, 0.5, 0.3], cLegs: [0.8, 0.6, 0.4] },
    king: { eye: 0.02, headLen: 0.18, headW: 0.17, thLen: 0.24, wingScars: true, gaLen: 0.5, cHead: [0.55, 0.32, 0.16], cThorax: [0.6, 0.38, 0.2], cGaster: [0.62, 0.42, 0.24], cLegs: [0.9, 0.7, 0.45] },
    alate: { eye: 0.026, headLen: 0.16, headW: 0.16, thLen: 0.26, thH: 0.15, gaLen: 0.5, gaW: 0.2, gaH: 0.17, wings: true, cHead: [0.4, 0.24, 0.13], cThorax: [0.45, 0.28, 0.15], cGaster: [0.5, 0.33, 0.2], cLegs: [0.9, 0.7, 0.45] },
  },
};

export function antParams(species: SpeciesId, caste: CasteId): AntGeoParams {
  const mods = CASTE_MOD[species];
  return { ...BASE, ...SPECIES_BASE[species], ...(mods[caste] ?? mods.worker ?? {}) };
}

const LOOK_BASE: CreatureLook = {
  color: [0.042, 0.033, 0.029],
  roughness: 0.36,
  clearcoat: 0.75,
  iridescence: 0,
  translucency: 0.5,
  translucencyColor: [1.0, 0.42, 0.08],
  translucencyAll: false,
  wax: 0,
  sheen: 0.35,
  bands: 5,
  sting: 0,
};

export function antLook(species: SpeciesId, caste: CasteId): CreatureLook {
  switch (species) {
    case 'gardenAnt':
      return { ...LOOK_BASE, iridescence: caste === 'queen' ? 0.25 : 0.12, bands: caste === 'queen' ? 6 : 5, translucency: caste === 'queen' ? 0.7 : 0.5 };
    case 'fireAnt':
      return { ...LOOK_BASE, color: [0.33, 0.075, 0.022], roughness: 0.3, clearcoat: 0.85, translucency: 0.75, translucencyColor: [1.0, 0.3, 0.05], translucencyAll: true, sheen: 0.2, sting: 1 };
    case 'leafcutter':
      return { ...LOOK_BASE, color: [0.2, 0.075, 0.03], roughness: 0.62, clearcoat: 0.25, translucency: 0.35, translucencyColor: [1.0, 0.36, 0.08], translucencyAll: true, sheen: 0.6 };
    case 'termite':
      return {
        ...LOOK_BASE,
        color: caste === 'queen' ? [0.86, 0.74, 0.55] : [0.82, 0.7, 0.5],
        roughness: 0.42,
        clearcoat: 0.35,
        translucency: 0.55,
        translucencyColor: [1.0, 0.72, 0.42],
        translucencyAll: true,
        wax: 1,
        sheen: 0.5,
        bands: caste === 'queen' ? 9 : 8,
      };
  }
}

/** Ring/segment counts per LOD: [high, medium, low]. */
const BODY_RADIAL = [22, 11, 5];
const BODY_RINGS = [18, 9, 4];
const LIMB_RADIAL = [7, 4, 3];

export function buildAnt(p: AntGeoParams, lod: GeometryLod): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const R = BODY_RADIAL[lod];
  const K = BODY_RINGS[lod];
  const LR = LIMB_RADIAL[lod];
  const hi = lod === 0;
  const low = lod === 2;

  // ---- layout along Z --------------------------------------------------------------------
  const nodeLen = 0.075;
  const headZ = p.headLen * Math.cos(p.headTilt) * 0.92;
  const total = headZ + p.thLen + p.nodes * nodeLen + p.gaLen - 0.03;
  const s = 1 / total;
  const zHeadFront = 0.5;
  const zNeck = zHeadFront - headZ * s;
  const zThBack = zNeck + 0.015 - p.thLen * s;
  const zWaistEnd = zThBack - p.nodes * nodeLen * s + (p.nodes === 0 ? 0.03 : 0.012);
  const zTip = -0.5;
  const thH = p.thH * s;
  const thW = p.thW * s;
  const yTh = -p.drop; // thorax axis height
  const foot = -RIDE_PER_LENGTH;

  // ---- mesosoma ----------------------------------------------------------------------------
  const thOff = (t: number): number => thH * p.hump * (sstep(0.25, 0.8, t) - 0.45) - thH * 0.1 * p.constrict * gauss(t - 0.42, 0.1);
  const thR = (t: number): number => prof(t, 0.68, 0.42, 0.5) * (1 - 0.3 * p.constrict * gauss(t - 0.42, 0.1)) * (0.82 + 0.18 * sstep(0.3, 0.7, t));
  b.set(BodyPart.thorax);
  b.blob({
    a: [0, yTh, zThBack],
    b: [0, yTh, zNeck + 0.02],
    rings: K + (hi ? 4 : 0),
    radial: R,
    rx: (t) => (thW / 2) * thR(t),
    ry: (t) => (thH / 2) * thR(t) * (0.9 + 0.1 * sstep(0.4, 0.8, t)),
    off: (t) => [0, thOff(t)],
    // flatter belly, slightly keeled back
    shape: (th) => (Math.sin(th) < 0 ? 1 - 0.12 * Math.pow(-Math.sin(th), 2) : 1),
    col: p.cThorax,
  });
  const thTop = (t: number): number => yTh + thOff(t) + (thH / 2) * thR(t);
  const thZ = (t: number): number => lerp(zThBack, zNeck + 0.02, t);

  // dorsal spines (leafcutter) / wing scars
  if (p.spines > 0 && !low) {
    b.set(BodyPart.other);
    const ts = [0.78, 0.5, 0.2];
    for (let i = 0; i < Math.min(3, p.spines); i++) {
      for (const sd of [-1, 1]) {
        const t = ts[i];
        const base: V3 = [sd * thW * 0.22, thTop(t) - thH * 0.12, thZ(t)];
        const tip: V3 = add(base, [sd * 0.035 * s, 0.07 * s * (i === 0 ? 1.15 : 1), -0.02 * s * i]);
        b.limb({ pts: [base, add(mul(base, 0.5), mul(tip, 0.5)), tip], r: [0.014 * s, 0.008 * s, 0.0015 * s], radial: hi ? 5 : 3, col: p.cThorax });
      }
    }
  }
  if (p.wingScars && !low) {
    b.set(BodyPart.other);
    for (const sd of [-1, 1]) {
      for (const t of [0.62, 0.46]) {
        const c: V3 = [sd * thW * 0.3, thTop(t) - thH * 0.16, thZ(t)];
        b.blob({ a: add(c, [0, 0, -0.018]), b: add(c, [0, 0, 0.018]), rings: 3, radial: 5, rx: (u) => 0.012 * prof(u), col: [0.7, 0.6, 0.5] });
      }
    }
  }

  // ---- petiole node(s) -----------------------------------------------------------------------
  if (p.nodes > 0 && !low) {
    b.set(BodyPart.petiole);
    for (let i = 0; i < p.nodes; i++) {
      const z1 = zThBack + 0.012 - i * nodeLen * s;
      const z0 = z1 - nodeLen * s - 0.012;
      const h = p.nodeH * s * (i === 0 ? 1 : 0.82);
      b.blob({
        a: [0, yTh - thH * 0.18, z0],
        b: [0, yTh - thH * 0.18, z1],
        rings: hi ? 8 : 4,
        radial: hi ? 12 : 6,
        rx: (t) => 0.026 * s * (0.55 + 0.9 * prof(t, 0.5, 0.8, 0.8)),
        ry: (t) => 0.016 * s + h * 0.5 * Math.pow(prof(t, 0.5, 0.5, 0.5), 2.2),
        off: (t) => [0, h * 0.42 * Math.pow(prof(t, 0.5, 0.5, 0.5), 2.2)],
        col: p.cThorax,
        ao: () => 0.7,
      });
    }
  }

  // ---- gaster ----------------------------------------------------------------------------------
  const gaW = p.gaW * s;
  const gaH = p.gaH * s;
  const yWaist = yTh - thH * 0.12;
  const waist: V3 = [0, yWaist, zWaistEnd];
  const gaAxisB: V3 = [0, yWaist - gaH * 0.16, zTip];
  const segs = p.gaSegs;
  const ridge = (t: number): number => (hi ? 1 + 0.035 * (((t * segs) % 1) - 0.5) * sstep(0.08, 0.2, t) * sstep(1, 0.85, t) : 1);
  const gaPeak = p.nodes === 0 ? 0.5 : 0.4;
  b.set(BodyPart.gaster, 0, waist);
  b.blob({
    a: waist,
    b: gaAxisB,
    rings: hi ? Math.max(22, segs * 4) : K + 1,
    radial: R,
    even: hi,
    rx: (t) => (gaW / 2) * prof(t, gaPeak, p.nodes === 0 ? 0.42 : 0.55, p.gaPoint) * ridge(t),
    ry: (t) => (gaH / 2) * prof(t, gaPeak, p.nodes === 0 ? 0.42 : 0.55, p.gaPoint) * ridge(t),
    off: (t) => [0, gaH * 0.1 * Math.sin(Math.PI * t)],
    w: (t) => t,
    ao: (t) => 0.7 + 0.3 * sstep(0, 0.25, t),
    col: p.cGaster,
  });
  if (p.stinger > 0 && !low) {
    const tip: V3 = [0, gaAxisB[1], zTip + 0.01];
    b.limb({ pts: [tip, add(tip, [0, -p.stinger * 0.35, -p.stinger * 0.9])], r: [0.008, 0.001], w: [1, 1], radial: 4, col: [0.25, 0.1, 0.05] });
  }

  // ---- head --------------------------------------------------------------------------------------
  const hl = p.headLen * s;
  const hw = p.headW * s;
  const hh = p.headH * s;
  const hdir: V3 = [0, -Math.sin(p.headTilt), Math.cos(p.headTilt)];
  const neck: V3 = [0, yTh + thOff(1) + thH * 0.05, zNeck];
  const hA: V3 = add(neck, mul(hdir, -hl * 0.06));
  const hB: V3 = add(hA, mul(hdir, hl));
  const hup: V3 = [0, Math.cos(p.headTilt), Math.sin(p.headTilt)];
  let peak = 0.45;
  let ea = 0.5;
  let eb = 0.5;
  if (p.headShape === 'heart') {
    peak = 0.3;
    ea = 0.32;
    eb = 0.62;
  } else if (p.headShape === 'box') {
    peak = 0.4;
    ea = 0.3;
    eb = 0.36;
  } else if (p.headShape === 'round') {
    peak = 0.48;
    ea = 0.45;
    eb = 0.45;
  } else if (p.headShape === 'nasute') {
    peak = 0.3;
    ea = 0.45;
    eb = 0.5;
  }
  const nas = p.headShape === 'nasute';
  // nasute: bulbous capsule drawn out into a conical nozzle (the "glue gun")
  const headR = (t: number): number => (nas ? Math.max(prof(Math.min(1, t / 0.66), 0.45, 0.45, 0.5), 0.2 * sstep(0.3, 0.6, t) * (1 - sstep(0.6, 1, t) * 0.75) * (t < 1 ? 1 : 0)) : prof(t, peak, ea, eb));
  b.set(BodyPart.head, 0, neck);
  b.blob({
    a: hA,
    b: hB,
    up: hup,
    rings: K + (hi ? 2 : 0),
    radial: R,
    rx: (t) => (hw / 2) * headR(t),
    ry: (t) => (hh / 2) * headR(t) * (nas ? 1 : 0.92 + 0.08 * sstep(0.7, 0.2, t)),
    off: (t) => [0, nas ? -hh * 0.12 * sstep(0.5, 1, t) : 0],
    shape: (th, t) => {
      let k = 1;
      // occipital cleft of heart-shaped heads
      if (p.headShape === 'heart') k *= 1 - 0.22 * sstep(0.45, 0.05, t) * Math.pow(Math.max(0, Math.sin(th)), 6) + 0.1 * sstep(0.5, 0.1, t) * Math.pow(Math.abs(Math.cos(th)), 3);
      // flattened face
      if (!nas) k *= Math.sin(th) < 0 ? 1 - 0.1 * Math.pow(-Math.sin(th), 2) : 1;
      return k;
    },
    col: nas ? (t) => [p.cHead[0] * (1 - 0.55 * sstep(0.7, 1, t)), p.cHead[1] * (1 - 0.6 * sstep(0.7, 1, t)), p.cHead[2] * (1 - 0.6 * sstep(0.7, 1, t))] : p.cHead,
    ao: (t) => 0.78 + 0.22 * sstep(0, 0.3, t),
  });
  const headAt = (t: number, side: number, lat: number, upK: number): V3 => {
    const c = add(hA, mul(hdir, hl * t));
    const r = headR(t);
    return add(add(c, [side * (hw / 2) * r * lat, 0, 0]), mul(hup, (hh / 2) * r * upK));
  };

  // eyes
  if (p.eye > 0 && !low) {
    b.set(BodyPart.eye, 0, neck);
    for (const sd of [-1, 1]) {
      const c = headAt(0.42, sd, 0.86, 0.3);
      const er = p.eye * s;
      b.blob({
        a: add(c, mul(hdir, -er * 1.25)),
        b: add(c, mul(hdir, er * 1.25)),
        up: hup,
        rings: hi ? 7 : 4,
        radial: hi ? 10 : 6,
        rx: (t) => er * 0.75 * prof(t),
        ry: (t) => er * 1.0 * prof(t),
        col: [0.02, 0.02, 0.025],
        ao: () => 1,
      });
    }
  }

  // mandibles
  const ml = p.mandLen * s;
  if (ml > 0.02) {
    for (const sd of [-1, 1]) {
      const base = headAt(0.9, sd, 0.75, -0.25);
      const fwd: V3 = norm([0, hdir[1] * 0.3, hdir[2]]);
      const mid = add(add(base, mul(fwd, ml * 0.55)), [sd * ml * 0.1, 0, 0]);
      const tip = add(add(base, mul(fwd, ml)), [-sd * ml * p.mandCurve, -ml * 0.05, 0]);
      b.set(BodyPart.mandible, sd > 0 ? 1 : 0, base);
      const mw = p.mandW * s;
      b.limb({
        pts: low ? [base, tip] : [base, mid, add(mul(mid, 0.4), mul(tip, 0.6)), tip],
        r: low ? [mw, mw * 0.2] : [mw, mw * 0.85, mw * 0.5, mw * 0.1],
        w: low ? [0, 1] : [0, 0.5, 0.8, 1],
        radial: hi ? 6 : 3,
        flat: 0.38,
        up: [0, 1, 0],
        smooth: hi ? 2 : 0,
        col: p.cMand,
        ao: low ? [0.8, 1] : [0.75, 0.9, 1, 1],
      });
    }
  }

  // antennae
  for (const sd of [-1, 1]) {
    const base = headAt(p.elbow > 0.5 ? 0.72 : 0.8, sd, 0.42, 0.75);
    const at = p.antThick * s;
    b.set(BodyPart.antenna, sd > 0 ? 1 : 0, base);
    if (p.elbow > 0.5) {
      const sc = p.scape * s;
      const fu = p.funic * s;
      const elbow = add(base, mul(norm([sd * 0.72, 0.55, -0.12]), sc));
      const f1 = add(elbow, mul(norm([sd * 0.35, 0.05, 1]), fu * 0.4));
      const f2 = add(elbow, mul(norm([sd * 0.22, -0.18, 1]), fu * 0.75));
      const f3 = add(elbow, mul(norm([sd * 0.1, -0.36, 1]), fu));
      if (low) b.limb({ pts: [base, elbow, f3], r: [at * 1.3, at * 1.2, at], w: [0, 0.45, 1], radial: LR, col: p.cAnt, ao: [0.9, 1, 1] });
      else {
        // scape: one long rigid segment; funiculus: a curved chain of short segments ending in a club
        b.limb({ pts: [base, add(mul(base, 0.5), mul(elbow, 0.5)), elbow], r: [at * 0.8, at * 1.1, at * 0.95], w: [0, 0.2, 0.42], radial: LR, col: p.cAnt, ao: [0.85, 1, 1] });
        const n = hi ? 9 : 3;
        const pts: V3[] = [];
        const rr: number[] = [];
        const ww: number[] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const q = (1 - t) * (1 - t);
          const r2 = 2 * t * (1 - t);
          pts.push([elbow[0] * q + f1[0] * r2 * 0.5 + f2[0] * r2 * 0.5 + f3[0] * t * t, elbow[1] * q + f1[1] * r2 * 0.5 + f2[1] * r2 * 0.5 + f3[1] * t * t, elbow[2] * q + f1[2] * r2 * 0.5 + f2[2] * r2 * 0.5 + f3[2] * t * t]);
          rr.push(at * (0.8 + 0.5 * t) * (hi && i % 2 === 1 ? 1.12 : 0.9));
          ww.push(0.42 + 0.58 * t);
        }
        b.limb({ pts, r: rr, w: ww, radial: LR, col: p.cAnt, ao: pts.map(() => 1) });
      }
    } else {
      // straight, beaded (moniliform) termite antenna arcing forward and out
      const fu = (p.scape + p.funic) * s;
      const n = low ? 2 : hi ? 12 : 4;
      const pts: V3[] = [];
      const rr: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(add(base, [sd * fu * (0.25 * t + 0.35 * t * t), fu * (0.25 * Math.sin(t * 2.4) - 0.2 * t * t), fu * (0.95 * t)]));
        rr.push(at * (hi ? (i % 2 === 0 ? 0.6 : 1.15) : 0.95) * (1 - 0.2 * t));
      }
      b.limb({ pts, r: rr, radial: LR, col: p.cAnt, smooth: 0 });
    }
  }

  // ---- legs ------------------------------------------------------------------------------------------
  const L = p.legLen;
  const hipT = [0.84, 0.56, 0.24];
  const footDX = [0.24, 0.32, 0.27];
  const footDZ = [0.24, -0.02, -0.4];
  const thick = [0.9, 1.0, 1.05];
  for (let pair = 0; pair < 3; pair++) {
    for (const sd of [-1, 1]) {
      const t = hipT[pair];
      const hipZ = thZ(t);
      const hip: V3 = [sd * thW * 0.3 * thR(t), yTh + thOff(t) - (thH / 2) * thR(t) * 0.7, hipZ];
      const ft: V3 = [sd * (thW * 0.2 + footDX[pair] * L * 0.92), foot, zThBack + (hipZ - zThBack) * 0.6 + 0.07 + footDZ[pair] * L * 0.85];
      const coxa: V3 = add(hip, [sd * 0.034, -0.014, (ft[2] - hip[2]) * 0.06]);
      const kneeY = Math.min(yTh + thH * 0.5 + 0.05 * L, hip[1] + 0.13 * L);
      const knee: V3 = [lerp(coxa[0], ft[0], 0.5), kneeY, lerp(coxa[2], ft[2], 0.42)];
      const ankle: V3 = [lerp(coxa[0], ft[0], 0.9), foot + 0.03, lerp(coxa[2], ft[2], 0.9)];
      const k = p.legThick * thick[pair];
      b.set(BodyPart.leg, pair * 2 + (sd > 0 ? 1 : 0), hip);
      const cJoint: RGB = [p.cLegs[0] * 0.75, p.cLegs[1] * 0.72, p.cLegs[2] * 0.7];
      const cTar: RGB = [p.cLegs[0] * 1.25, p.cLegs[1] * 1.2, p.cLegs[2] * 1.1];
      if (low) {
        b.limb({ pts: [hip, knee, ft], r: [0.017 * k, 0.014 * k, 0.007 * k], w: [0, 0.5, 1], radial: 3, col: p.cLegs, ao: [0.6, 0.9, 1] });
      } else if (!hi) {
        b.limb({ pts: [hip, coxa, knee, ankle, ft], r: [0.02 * k, 0.017 * k, 0.012 * k, 0.008 * k, 0.005 * k], w: [0, 0.08, 0.5, 1, 1], radial: LR, col: p.cLegs, ao: [0.55, 0.7, 0.95, 1, 1] });
      } else {
        const fm: V3 = add(mul(coxa, 0.5), mul(knee, 0.5));
        const tm: V3 = add(add(mul(knee, 0.5), mul(ankle, 0.5)), [sd * 0.008, 0.006, 0]);
        const t1: V3 = [lerp(ankle[0], ft[0], 0.5), foot + 0.012, lerp(ankle[2], ft[2], 0.5)];
        // tiny up-turned claw at the tip
        const claw: V3 = add(ft, [sd * 0.012, 0.004, 0.01]);
        b.limb({
          pts: [hip, coxa, fm, knee, tm, ankle, t1, ft, claw],
          r: [0.021 * k, 0.018 * k, 0.0155 * k, 0.0115 * k, 0.0105 * k, 0.008 * k, 0.0058 * k, 0.0048 * k, 0.002 * k],
          w: [0, 0.08, 0.28, 0.5, 0.75, 1, 1, 1, 1],
          radial: LR,
          col: [cJoint, p.cLegs, p.cLegs, cJoint, p.cLegs, cJoint, cTar, cTar, cTar],
          ao: [0.5, 0.62, 0.85, 0.95, 1, 1, 1, 1, 1],
        });
      }
    }
  }

  // ---- wings ---------------------------------------------------------------------------------------------
  if (p.wings) {
    b.beginBlend();
    for (const sd of [-1, 1]) {
      for (let wi = 0; wi < (low ? 1 : 2); wi++) {
        const t = wi === 0 ? 0.62 : 0.46;
        const root: V3 = [sd * thW * 0.28, thTop(t) - thH * 0.08, thZ(t)];
        const span = (wi === 0 ? 1.05 : 0.78) * (zHeadFront - zTip);
        const chord = wi === 0 ? 0.2 : 0.16;
        b.set(BodyPart.wing, sd > 0 ? 1 : 0, root);
        const nu = low ? 2 : hi ? 10 : 5;
        const nv = low ? 1 : hi ? 5 : 3;
        b.sheet(
          nu,
          nv,
          (u, v) => {
            // folded back over the gaster, fanned slightly outward, with a gentle camber
            const width = chord * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + u * 0.95)), 0.6) * (0.35 + 0.65 * sstep(0, 0.35, u));
            const x = sd * (0.01 + u * span * (0.1 + wi * 0.12) + (v - 0.35) * width);
            const y = 0.012 * (1 - wi) + u * 0.03 + 0.02 * Math.sin(Math.PI * v) * sstep(0, 0.3, u) + gaH * 0.42 * sstep(0.1, 0.5, u);
            return add(root, [x, y, -u * span]);
          },
          (u) => u,
          // veins: leading edge + a few radial struts
          (u, v) => Math.max(v < 0.12 ? 1 : 0, Math.abs(((v * (nv > 2 ? 2.5 : 1) + u * 0.5) % 1) - 0.5) < 0.1 ? 0.8 : 0.15),
          [0.9, 0.85, 0.7],
        );
      }
    }
  }

  return b.build({
    neck,
    waist,
    legs: 6,
    stride: 0.62,
    duty: 0.6,
    lift: 0.075,
    crawl: 0,
    marker: [thZ(0.62), lerp(zWaistEnd, zTip, 0.38), 0.034 + 0.012 * (p.gaW / 0.23), 0],
    mouth: [0, hB[1] - ml * 0.2, hB[2] + ml * 0.75],
  });
}

/**
 * First-person rig (§5.3): what a possessed ant sees of itself — its own antennae sweeping in
 * front of the eyes and the mandibles at the bottom of the view. Purpose-built rather than cut
 * from the body mesh so it frames well at a 78° FOV. Model space: eye at the origin looking
 * down +Z, +Y up; scaled by the caste length. Parts use the normal ids (antenna / mandible), so
 * the shared shader animates them (sweep, tap, groom, bite).
 */
export function buildFirstPersonRig(p: AntGeoParams): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const big = p.mandLen / 0.08; // soldiers get visibly heavier jaws
  for (const sd of [-1, 1]) {
    // ---- antenna: scape out to the elbow, then a long beaded funiculus arcing forward ----
    const base: V3 = [sd * 0.075, -0.07, 0.13];
    b.set(BodyPart.antenna, sd > 0 ? 1 : 0, base);
    const at = 0.003 * (p.antThick / 0.0068);
    if (p.elbow > 0.5) {
      const elbow: V3 = [sd * 0.2, 0.005, 0.25];
      b.limb({ pts: [base, add(mul(base, 0.5), mul(elbow, 0.5)), elbow], r: [at * 1.2, at * 1.5, at * 1.3], w: [0, 0.2, 0.4], radial: 8, col: p.cAnt, ao: [0.7, 1, 1] });
      const tip: V3 = [sd * 0.09, -0.085, 0.56];
      const ctrl: V3 = [sd * 0.22, 0.02, 0.45];
      const n = 14;
      const pts: V3[] = [];
      const rr: number[] = [];
      const ww: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const q = (1 - t) * (1 - t);
        const r2 = 2 * t * (1 - t);
        pts.push([elbow[0] * q + ctrl[0] * r2 + tip[0] * t * t, elbow[1] * q + ctrl[1] * r2 + tip[1] * t * t, elbow[2] * q + ctrl[2] * r2 + tip[2] * t * t]);
        rr.push(at * (0.95 + 0.55 * t) * (i % 2 === 1 ? 1.16 : 0.86));
        ww.push(0.4 + 0.6 * t);
      }
      b.limb({ pts, r: rr, w: ww, radial: 8, col: p.cAnt, ao: pts.map(() => 1) });
    } else {
      // termite: straight string of beads
      const n = 16;
      const pts: V3[] = [];
      const rr: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push([sd * (0.075 + 0.1 * t + 0.04 * t * t), -0.07 + 0.07 * Math.sin(t * 2.6) - 0.06 * t * t, 0.13 + 0.42 * t]);
        rr.push(at * 1.5 * (i % 2 === 0 ? 0.6 : 1.2) * (1 - 0.25 * t));
      }
      b.limb({ pts, r: rr, radial: 8, col: p.cAnt });
    }
    // ---- mandible: a broad curved blade with a toothed inner edge ---------------------------
    if (p.mandLen > 0.02) {
      const mb: V3 = [sd * 0.08, -0.15, 0.14];
      b.set(BodyPart.mandible, sd > 0 ? 1 : 0, mb);
      const L = 0.2 * Math.min(1.7, 0.75 + 0.25 * big);
      const mid: V3 = add(mb, [sd * 0.012, 0.004, L * 0.55]);
      const tip: V3 = add(mb, [-sd * 0.062, 0.0, L]);
      const wdt = 0.021 * Math.min(1.6, 0.8 + 0.2 * big);
      b.limb({ pts: [mb, mid, add(mul(mid, 0.35), mul(tip, 0.65)), tip], r: [wdt * 1.1, wdt, wdt * 0.6, wdt * 0.06], w: [0, 0.5, 0.8, 1], radial: 10, flat: 0.32, up: [0, 1, 0], smooth: 3, col: [p.cMand, p.cMand, [p.cMand[0] * 0.55, p.cMand[1] * 0.5, p.cMand[2] * 0.5], [p.cMand[0] * 0.4, p.cMand[1] * 0.35, p.cMand[2] * 0.35]], ao: [0.7, 0.95, 1, 1] });
      for (let i = 0; i < 5; i++) {
        const t = 0.3 + i * 0.14;
        const c: V3 = [mb[0] + (t < 0.55 ? (sd * 0.012 * t) / 0.55 : sd * 0.012 - sd * 0.074 * ((t - 0.55) / 0.45)) - sd * wdt * (0.85 - 0.5 * t), mb[1], mb[2] + L * t];
        b.limb({ pts: [c, add(c, [-sd * 0.014 * (1.2 - t), 0, 0.006])], r: [0.0065 * (1.3 - t), 0.0006], w: [t, t], radial: 5, col: [p.cMand[0] * 0.4, p.cMand[1] * 0.35, p.cMand[2] * 0.35] });
      }
    }
  }
  return b.build({ neck: [0, -0.1, -0.1], waist: [0, 0, -1], legs: 0, crawl: 0, marker: [0, 0, 0, 0], mouth: [0, -0.13, 0.3] });
}
