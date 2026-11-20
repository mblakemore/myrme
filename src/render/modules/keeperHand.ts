import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural keeper props (B4 keeperFx): a giant human hand in a pinch pose, a tapping finger,
 * tweezers, a pipette and a desk-lamp head. All geometry is built from swept, rounded tubes with
 * vertex colours; units are world units (1 voxel ≈ 7 mm at ant scale → a hand is ~27 units long).
 *
 * Hand space: the pinch point (where the tool is held) is the origin, the tool hangs along −Y,
 * the forearm leaves towards +Y (and a little towards +Z / +X).
 */

type V3 = readonly [number, number, number];
type RGB = readonly [number, number, number];

const SKIN: RGB = [0.86, 0.6, 0.47];
const SKIN_DARK: RGB = [0.74, 0.46, 0.36];
const NAIL: RGB = [0.93, 0.76, 0.7];

/** Swept tube through `pts` (Catmull-Rom smoothed) with rounded ends. `squash` flattens along local z. */
function tube(pts: V3[], radii: number[], col: RGB, radial = 12, sub = 5, squash = 1, colEnd?: RGB): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(
    pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    false,
    'centripetal',
  );
  const n = (pts.length - 1) * sub;
  const pos: number[] = [];
  const colr: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3();
  const Tn = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const ref = new THREE.Vector3(0, 0, 1);
  const rings: { c: THREE.Vector3; t: THREE.Vector3; r: number; k: number }[] = [];
  const radiusAt = (u: number): number => {
    const f = u * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(f));
    return radii[i] + (radii[i + 1] - radii[i]) * (f - i);
  };
  const CAP = 4;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    rings.push({ c: curve.getPoint(u).clone(), t: curve.getTangent(u).clone(), r: radiusAt(u), k: u });
  }
  // hemispherical caps
  const first = rings[0];
  const last = rings[rings.length - 1];
  for (let j = 1; j <= CAP; j++) {
    const a = (j / CAP) * Math.PI * 0.5;
    rings.unshift({ c: first.c.clone().addScaledVector(first.t, -Math.sin(a) * first.r), t: first.t, r: Math.max(1e-3, first.r * Math.cos(a)), k: 0 });
    rings.push({ c: last.c.clone().addScaledVector(last.t, Math.sin(a) * last.r), t: last.t, r: Math.max(1e-3, last.r * Math.cos(a)), k: 1 });
  }
  for (let i = 0; i < rings.length; i++) {
    const rg = rings[i];
    P.copy(rg.c);
    Tn.copy(rg.t).normalize();
    N.crossVectors(Tn, ref);
    if (N.lengthSq() < 1e-4) N.set(1, 0, 0);
    N.normalize();
    B.crossVectors(Tn, N).normalize();
    const c = colEnd ? [col[0] + (colEnd[0] - col[0]) * rg.k, col[1] + (colEnd[1] - col[1]) * rg.k, col[2] + (colEnd[2] - col[2]) * rg.k] : col;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cx = Math.cos(a) * rg.r;
      const cy = Math.sin(a) * rg.r * squash;
      pos.push(P.x + N.x * cx + B.x * cy, P.y + N.y * cx + B.y * cy, P.z + N.z * cx + B.z * cy);
      colr.push(c[0], c[1], c[2]);
    }
  }
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      idx.push(a, b, a + radial, b, b + radial, a + radial);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx);
  return g;
}

function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Right hand pinching a tool at the origin; fingers come down from a palm above. */
export function buildHandGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // forearm + wrist + palm (flattened)
  parts.push(tube([[7, 62, 16], [4.5, 40, 8], [2.2, 27, 1.5], [1.4, 21, -0.6]], [5.6, 4.9, 4.0, 4.3], SKIN_DARK, 14, 6, 0.72, SKIN));
  parts.push(tube([[1.6, 23.5, -0.8], [1.0, 17.5, -1.0], [0.6, 12.6, -1.2]], [4.3, 4.9, 4.4], SKIN, 14, 5, 0.52));
  // thenar pad
  parts.push(tube([[3.0, 21, 0.8], [4.0, 16.5, 1.8]], [2.5, 2.2], SKIN, 10, 4, 0.9));
  // index, middle: reach down to the pinch
  parts.push(tube([[-1.6, 12.6, 1.4], [-3.4, 7.0, 2.3], [-2.7, 2.6, 1.4], [-1.0, -0.5, 0.4]], [1.4, 1.25, 1.08, 0.9], SKIN, 10, 5));
  parts.push(tube([[-0.5, 12.3, -0.6], [-3.3, 7.4, -0.8], [-3.0, 3.0, -0.7], [-1.3, -0.1, -0.5]], [1.45, 1.3, 1.1, 0.92], SKIN, 10, 5));
  // ring, little: curled into the palm
  parts.push(tube([[0.9, 12.2, -2.4], [-1.7, 7.8, -3.3], [-1.2, 4.6, -2.8], [0.5, 5.6, -1.9]], [1.35, 1.2, 1.02, 0.86], SKIN, 10, 5));
  parts.push(tube([[2.1, 12.6, -3.7], [0.1, 8.8, -4.7], [0.8, 6.4, -4.1], [2.0, 7.2, -3.3]], [1.15, 1.0, 0.88, 0.75], SKIN, 10, 5));
  // thumb
  parts.push(tube([[3.4, 17.4, 1.6], [4.9, 10.8, 2.6], [3.5, 4.8, 1.8], [1.1, 0.1, 0.5]], [1.9, 1.6, 1.3, 1.02], SKIN, 10, 5));
  // nails (flat pads on the fingertips facing outwards)
  parts.push(tube([[-1.9, 1.2, 1.6], [-1.2, -0.5, 1.0]], [0.62, 0.55], NAIL, 8, 2, 0.35));
  parts.push(tube([[2.5, 2.2, 2.2], [1.5, 0.3, 1.2]], [0.75, 0.65], NAIL, 8, 2, 0.35));
  return finish(parts);
}

/** One extended finger for the glass tap: tip at the origin, finger leaves along +X (bent up slightly). */
export function buildFingerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tube([[0.6, 0.2, 0.9], [4.2, 0.9, 1.5], [9.5, 2.4, 2.3], [16, 4.8, 3.6]], [0.98, 1.15, 1.32, 1.5], SKIN, 12, 6));
  // knuckle / back of the hand hint
  parts.push(tube([[15, 4.4, 3.4], [24, 8.5, 6.5], [44, 17, 14]], [3.2, 4.8, 5.4], SKIN, 14, 5, 0.7, SKIN_DARK));
  parts.push(tube([[1.6, 1.05, 0.9], [-0.1, 0.72, 0.6]], [0.72, 0.6], NAIL, 8, 2, 0.35));
  return finish(parts);
}

/** One tweezers blade, hinge at the origin (mount at hand-space (0, 13, 0)), tip 30 below, bowed out along +X. Mirror for the other. */
export function buildTweezerBlade(): THREE.BufferGeometry {
  const steel: RGB = [0.72, 0.74, 0.78];
  const RAD = 8;
  const g = tube([[0.05, 13, 0], [0.75, 6, 0], [0.9, 0.5, 0], [0.5, -9, 0], [0.07, -17, 0]], [0.5, 0.62, 0.62, 0.45, 0.14], steel, RAD, 6);
  // flat spring-steel blade: thin across x (the blades face each other), wide along z, pointed tip
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let r = 0; r < p.count / RAD; r++) {
    let mx = 0;
    for (let j = 0; j < RAD; j++) mx += p.getX(r * RAD + j);
    mx /= RAD;
    for (let j = 0; j < RAD; j++) {
      const i = r * RAD + j;
      const y = p.getY(i);
      const w = 2.0 * Math.min(1, Math.max(0.15, (y + 17.5) / 12));
      p.setX(i, mx + (p.getX(i) - mx) * 0.24);
      p.setZ(i, p.getZ(i) * w);
    }
  }
  g.translate(0, -13, 0); // hinge at the origin
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Pipette: glass barrel hanging to (0, −17, 0), rubber bulb between the fingers at the origin. */
export function buildPipetteGeometry(): THREE.BufferGeometry {
  const glass: RGB = [0.78, 0.9, 0.96];
  const water: RGB = [0.42, 0.68, 0.92];
  const rubber: RGB = [0.5, 0.08, 0.06];
  const parts: THREE.BufferGeometry[] = [];
  parts.push(tube([[0, -1.5, 0], [0, -9, 0], [0, -14, 0], [0, -17, 0]], [0.95, 0.9, 0.5, 0.2], glass, 10, 4, 1, water));
  parts.push(tube([[0, 5.2, 0], [0, 2.4, 0], [0, 0, 0], [0, -1.8, 0]], [1.5, 2.3, 2.0, 1.1], rubber, 12, 5));
  return finish(parts);
}

/** Desk-lamp head: open conical shade with its apex at the origin, opening along −Y; plus a neck/arm stub. */
export function buildLampShade(): THREE.BufferGeometry {
  const shade = new THREE.CylinderGeometry(2.6, 9.5, 11, 28, 1, true);
  shade.translate(0, -5.5, 0);
  const cap = new THREE.SphereGeometry(2.7, 20, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const col = (g: THREE.BufferGeometry, c: RGB): void => {
    const n = g.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
  };
  const body: RGB = [0.05, 0.19, 0.16];
  col(shade, body);
  col(cap, body);
  const arm = tube([[0, 2.2, 0], [5, 9, -3], [22, 34, -12], [26, 80, -14]], [1.0, 0.9, 0.9, 0.9], [0.5, 0.5, 0.52], 8, 4);
  arm.computeVertexNormals();
  const parts = [shade.toNonIndexed(), cap.toNonIndexed(), arm.toNonIndexed()];
  for (const p of parts) p.computeVertexNormals();
  shade.dispose();
  cap.dispose();
  arm.dispose();
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}
