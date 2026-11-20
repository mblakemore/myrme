import * as THREE from 'three';
import { hash01 } from '../../core';

/**
 * Procedural geometry for render-only vegetation and scatter (D18). All shapes are unit-sized in
 * local space with the root at the origin and +y up; instances scale them.
 *
 * Attributes: position, normal, aCol (linear rgb), aParam = (sway weight 0..1, how much the
 * per-instance tint applies 0..1, translucency 0..1), aUv = (-1..1 across a leaf strip, 0..1 along
 * it; 9 for non-leaf shapes).
 */

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  par: number[] = [];
  uvs: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, c: readonly number[], sway: number, mix: number, trans: number, u = 9, v = 9): number {
    this.pos.push(x, y, z);
    this.uvs.push(u, v);
    this.nrm.push(0, 0, 0);
    this.col.push(c[0], c[1], c[2]);
    this.par.push(sway, mix, trans);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aParam', new THREE.Float32BufferAttribute(this.par, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

const lin = (r: number, g: number, b: number): number[] => [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
const WHITE = [1, 1, 1];

/**
 * A strip leaf: `width(t)` half-width profile, arching forward (+z) by `arch`, with a V fold
 * along the midrib. `shade(t)` darkens the vertex colour (base of a blade sits in shadow).
 */
function strip(
  b: Builder,
  segs: number,
  width: (t: number) => number,
  arch: number,
  fold: number,
  o: { x?: number; y?: number; z?: number; yaw?: number; pitch?: number; len?: number; col?: readonly number[]; mix?: number; trans?: number; sway0?: number; sway1?: number; shade?: (t: number) => number } = {},
): void {
  const yaw = o.yaw ?? 0;
  const pitch = o.pitch ?? 0;
  const len = o.len ?? 1;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const place = (x: number, y: number, z: number): [number, number, number] => {
    // pitch about x (tilt forward), then yaw about y
    const y1 = y * cp - z * sp;
    const z1 = y * sp + z * cp;
    return [(o.x ?? 0) + x * cy + z1 * sy, (o.y ?? 0) + y1, (o.z ?? 0) - x * sy + z1 * cy];
  };
  const rows: number[][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const w = width(t) * len;
    const y = (t - 0.18 * arch * t * t) * len;
    const z = arch * t * t * len;
    const sh = o.shade ? o.shade(t) : 1;
    const c = (o.col ?? WHITE).map((v) => v * sh);
    const sway = (o.sway0 ?? 0) + ((o.sway1 ?? 1) - (o.sway0 ?? 0)) * t * t;
    const mix = o.mix ?? 1;
    const tr = o.trans ?? 1;
    const f = fold * w;
    rows.push([b.vert(...place(-w, y, z + f), c, sway, mix, tr, -1, t), b.vert(...place(0, y, z), c, sway, mix, tr, 0, t), b.vert(...place(w, y, z + f), c, sway, mix, tr, 1, t)]);
  }
  for (let i = 0; i < segs; i++) {
    const a = rows[i];
    const c = rows[i + 1];
    b.quad(a[0], a[1], c[1], c[0]);
    b.quad(a[1], a[2], c[2], c[1]);
  }
}

/** Grass blade: tapered, arching, folded. Height 1. */
export function grassBladeGeometry(segs = 6): THREE.BufferGeometry {
  const b = new Builder();
  strip(b, segs, (t) => 0.5 * Math.pow(1 - Math.pow(t, 2.4), 0.9) * (0.75 + 0.25 * Math.min(1, t * 6)), 0.38, 0.35, { shade: (t) => 0.42 + 0.58 * Math.min(1, t * 1.6) });
  return b.build();
}

/** Broad lanceolate leaf (stem leaves, fallen leaves, rosettes). Length 1, lying along +z when pitched. */
export function broadLeafGeometry(segs = 7): THREE.BufferGeometry {
  const b = new Builder();
  strip(b, segs, (t) => 0.02 + 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.85) * (1 - 0.15 * t), 0.5, 0.3, { shade: (t) => 0.6 + 0.4 * Math.min(1, t * 2) });
  return b.build();
}

/** Clover: thin stalk with three notched leaflets. Height 1, leaf span ≈ 0.9. */
export function cloverGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const stalk = lin(0.5, 0.62, 0.3);
  // stalk: two crossed thin strips
  for (let k = 0; k < 2; k++) strip(b, 3, () => 0.02, 0.06, 0, { yaw: (k * Math.PI) / 2, col: stalk, mix: 0.4, trans: 0.3, sway1: 0.8 });
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI * 2) / 3;
    // heart-ish leaflet radiating from the stalk tip, slightly cupped
    strip(b, 5, (t) => 0.3 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.93 + 0.04)), 0.6) * (0.55 + 0.6 * t), -0.25, -0.25, {
      y: 0.98,
      z: 0,
      yaw: a,
      pitch: Math.PI / 2 - 0.25,
      len: 0.46,
      sway0: 0.8,
      sway1: 1,
      shade: (t) => 0.75 + 0.25 * t,
    });
  }
  return b.build();
}

/** Daisy-like flower: stalk, ring of petals (instance-tinted), domed yellow centre. Height 1. */
export function flowerGeometry(petals = 11): THREE.BufferGeometry {
  const b = new Builder();
  const stalk = lin(0.42, 0.58, 0.25);
  for (let k = 0; k < 2; k++) strip(b, 3, () => 0.018, 0.1, 0, { yaw: (k * Math.PI) / 2, col: stalk, mix: 0, trans: 0.3, sway1: 0.85 });
  const top = 0.98;
  const zc = 0.1; // the stalk arches forward by ~0.1
  for (let k = 0; k < petals; k++) {
    const a = (k / petals) * Math.PI * 2;
    strip(b, 3, (t) => 0.03 + 0.2 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.08)), 0.25, 0.25, {
      x: Math.sin(a) * 0.035,
      y: top,
      z: zc + Math.cos(a) * 0.035,
      yaw: a,
      pitch: Math.PI / 2 - 0.3 - 0.12 * hash01(k, 3),
      len: 0.2,
      sway0: 0.85,
      sway1: 1,
      mix: 1,
      trans: 0.9,
    });
  }
  // centre dome
  const yellow = lin(0.98, 0.78, 0.12);
  const c0 = b.vert(0, top + 0.035, zc, yellow, 0.9, 0, 0.2);
  const ring: number[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    ring.push(b.vert(Math.sin(a) * 0.05, top + 0.006, zc + Math.cos(a) * 0.05, yellow.map((v) => v * 0.7), 0.9, 0, 0.2));
  }
  for (let k = 0; k < 8; k++) b.tri(c0, ring[k], ring[(k + 1) % 8]);
  return b.build();
}

/** Single petal / ray floret for voxel flower heads (dandelions). Length 1 along the strip. */
export function petalGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  strip(b, 4, (t) => 0.1 + 0.07 * Math.sin(Math.PI * t) - 0.06 * t, 0.3, 0.3, { sway0: 0.2, sway1: 0.6, shade: (t) => 0.7 + 0.3 * t });
  return b.build();
}

/** Squashed, lumpy pebble. Radius ≈ 0.5. */
export function pebbleGeometry(seed = 1): THREE.BufferGeometry {
  const src = new THREE.IcosahedronGeometry(0.5, 1);
  const p = src.getAttribute('position');
  const b = new Builder();
  // weld by position so the lumps are continuous, then deform
  const map = new Map<string, number>();
  const ids: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    let id = map.get(key);
    if (id === undefined) {
      const n = map.size;
      const k = 0.78 + 0.4 * hash01(n, seed, 5);
      const x = p.getX(i) * k * 1.15;
      const y = p.getY(i) * k * 0.62 + 0.16;
      const z = p.getZ(i) * k * 0.9;
      const tone = 0.75 + 0.35 * hash01(n, seed, 9);
      id = b.vert(x, y, z, [tone, tone, tone], 0, 1, 0);
      map.set(key, id);
    }
    ids.push(id);
  }
  for (let i = 0; i < ids.length; i += 3) b.tri(ids[i], ids[i + 1], ids[i + 2]);
  src.dispose();
  return b.build();
}

/** A forked dead twig lying along +x. Length 1. */
export function twigGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const tube = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, r0: number, r1: number): void => {
    const sides = 5;
    const rows: number[][] = [];
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      const cx = ax + (bx - ax) * t;
      const cy = ay + (by - ay) * t + 0.03 * Math.sin(t * Math.PI);
      const cz = az + (bz - az) * t;
      const r = r0 + (r1 - r0) * t;
      const row: number[] = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        const tone = 0.7 + 0.5 * hash01(i, s, 77);
        row.push(b.vert(cx, cy + Math.cos(a) * r, cz + Math.sin(a) * r, [tone, tone, tone], 0, 1, 0));
      }
      rows.push(row);
    }
    for (let i = 0; i < 3; i++) for (let s = 0; s < sides; s++) b.quad(rows[i][s], rows[i + 1][s], rows[i + 1][(s + 1) % sides], rows[i][(s + 1) % sides]);
  };
  tube(0, 0.03, 0, 1, 0.05, 0.04, 0.03, 0.014);
  tube(0.55, 0.04, 0.02, 0.85, 0.1, -0.22, 0.016, 0.008);
  return b.build();
}

/** Tiny mushroom: stalk + domed cap with a paler underside. Height 1. */
export function mushroomGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const profile: [number, number, number][] = [
    // radius, height, tone (1 = cap colour via instance tint, <0 = stalk)
    [0.07, 0, -1],
    [0.055, 0.35, -1],
    [0.05, 0.62, -1],
    [0.12, 0.63, -0.8],
    [0.4, 0.6, -0.7],
    [0.44, 0.66, 1],
    [0.36, 0.84, 1],
    [0.2, 0.96, 1],
    [0.0, 1.0, 1],
  ];
  const sides = 10;
  const stalk = lin(0.9, 0.86, 0.74);
  const rows: number[][] = [];
  for (const [r, y, tone] of profile) {
    const row: number[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const cap = tone > 0;
      row.push(b.vert(Math.cos(a) * r, y, Math.sin(a) * r, cap ? WHITE : stalk.map((v) => v * -tone), 0.15 * y, cap ? 1 : 0, 0.25));
    }
    rows.push(row);
  }
  for (let i = 0; i + 1 < rows.length; i++) for (let s = 0; s < sides; s++) b.quad(rows[i][s], rows[i][(s + 1) % sides], rows[i + 1][(s + 1) % sides], rows[i + 1][s]);
  return b.build();
}

export function dewGeometry(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(0.5, 12, 8);
}
