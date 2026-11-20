import * as THREE from 'three';
import { RIDE_PER_LENGTH, type CameraPose, type CreatureGeometryKind, type GeometryLod } from '../../core';
import { BROOD_KINDS, CREATURE_IDS, ITEM_KINDS, SPECIES_CASTES } from '../../assets/geometry';
import { getCaste } from '../../sim/data/species';
import { antsRuntime } from './ants';
import { createInstancedCreature, getChitinMaterials, type InstancedCreature } from './antsMaterial';
import { writeSurfaceMatrix } from './antsShared';

/**
 * Specimen gallery (A4): lays creature geometry out on a neutral turntable high above the map
 * and returns a camera pose for it. Used to iterate on shapes and as a visual regression set:
 *
 *   npm run shots -- --port 5205 --map meadow --name gallery-ants --eval \
 *     "const g = await import('/src/render/modules/antsGallery.ts'); __myrme.setCamera(g.showGallery('ants'))"
 *
 * Sections: 'ants' | 'termites' | 'creatures' | 'props' | 'lods' | 'states' | 'macro' | 'off'.
 * Options: { lod, yaw, kind } — `kind` picks the specimen for 'macro' / 'states' / 'lods'.
 */
export type GallerySection = 'ants' | 'termites' | 'creatures' | 'props' | 'lods' | 'states' | 'macro' | 'off';

export interface GalleryOptions {
  lod?: GeometryLod;
  yaw?: number;
  kind?: CreatureGeometryKind;
  /** Camera azimuth offset (radians) and elevation factor for alternative angles. */
  orbit?: number;
  elevation?: number;
}

interface Specimen {
  kind: CreatureGeometryKind;
  lod: GeometryLod;
  x: number;
  z: number;
  scale: number;
  yaw?: number;
  /** [phase, speed, seed, sun] */
  a?: [number, number, number, number];
  /** [bite, carry, curl/fly, infection] */
  b?: [number, number, number, number];
  /** [marker rgb, highlight] */
  c?: [number, number, number, number];
  /** Rest directly on the turntable (items) instead of standing at ride height. */
  rest?: number;
  marked?: boolean;
}

let group: THREE.Group | null = null;
let live: InstancedCreature[] = [];

function clear(): void {
  for (const m of live) m.dispose();
  live = [];
  if (group) {
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    });
    group.removeFromParent();
    group = null;
  }
}

export function showGallery(section: GallerySection = 'ants', opts: GalleryOptions = {}): CameraPose | null {
  const ctx = antsRuntime.ctx;
  if (!ctx) throw new Error('ants module not initialised');
  clear();
  antsRuntime.forceMarked = section === 'states';
  if (section === 'off') return null;
  const w = ctx.sim.world;
  const cx = w.sx / 2;
  const cy = w.sy + 60;
  const cz = w.sz / 2;
  const lod = opts.lod ?? 0;
  const yaw = opts.yaw ?? 0.75;
  const specs: Specimen[] = [];
  let width = 6;
  let depth = 2;

  const row = (kinds: CreatureGeometryKind[], z: number, scaleOf: (k: CreatureGeometryKind) => number, gap = 0.5): void => {
    let total = 0;
    for (const k of kinds) total += scaleOf(k) + gap;
    let x = -total / 2;
    for (const k of kinds) {
      const s = scaleOf(k);
      specs.push({ kind: k, lod, x: x + (s + gap) / 2, z, scale: s });
      x += s + gap;
    }
    width = Math.max(width, total);
  };
  const antScale = (k: CreatureGeometryKind): number => {
    const [sp, caste] = k.split(':') as [keyof typeof SPECIES_CASTES, never];
    return getCaste(sp, caste).length * 1.6;
  };

  if (section === 'ants') {
    row(SPECIES_CASTES.gardenAnt.map((c) => `gardenAnt:${c}` as CreatureGeometryKind), -2.6, antScale);
    row(SPECIES_CASTES.fireAnt.map((c) => `fireAnt:${c}` as CreatureGeometryKind), 0, antScale);
    row(SPECIES_CASTES.leafcutter.map((c) => `leafcutter:${c}` as CreatureGeometryKind), 2.6, antScale);
    depth = 7.5;
  } else if (section === 'termites') {
    row(SPECIES_CASTES.termite.map((c) => `termite:${c}` as CreatureGeometryKind), 0, antScale, 0.7);
    depth = 3;
  } else if (section === 'creatures') {
    row(['jumpingSpider', 'groundBeetle', 'mantis', 'wasp'], -1.8, (k) => (k === 'mantis' ? 4.2 : 2.6), 1.0);
    row(['antlion', 'caterpillar', 'worm', 'aphid'], 2.2, (k) => (k === 'aphid' ? 1.0 : 2.4), 1.0);
    depth = 7.5;
  } else if (section === 'props') {
    const sizes: Partial<Record<CreatureGeometryKind, number>> = { egg: 0.7, larva: 1.0, pupa: 1.0, fruit: 1.3, corpse: 1.1 };
    row([...BROOD_KINDS], -1.2, (k) => sizes[k] ?? 0.8, 0.5);
    row([...ITEM_KINDS], 1.2, (k) => sizes[k] ?? 0.8, 0.45);
    for (const s of specs) {
      s.rest = s.kind === 'corpse' ? 0.2 : s.kind === 'leaf' ? 0.5 : 0.36;
      if (s.kind === 'corpse') s.b = [0, 0, 1, 0];
    }
    depth = 4.5;
  } else if (section === 'lods') {
    const k = opts.kind ?? 'gardenAnt:worker';
    for (let l = 0; l < 3; l++) specs.push({ kind: k, lod: l as GeometryLod, x: (l - 1) * 2.2, z: 0, scale: 1.8 });
    width = 7;
    depth = 3;
  } else if (section === 'macro') {
    const k = opts.kind ?? 'gardenAnt:worker';
    specs.push({ kind: k, lod, x: 0, z: 0, scale: 1.6, a: [0.18, 0.6, 0.37, 1] });
    width = 2.1;
    depth = 1.4;
  } else if (section === 'states') {
    const k = opts.kind ?? 'gardenAnt:worker';
    const variants: Partial<Specimen>[] = [
      { a: [0.0, 1, 0.1, 1] },
      { a: [0.25, 1, 0.3, 1] },
      { a: [0.5, 1, 0.5, 1] },
      { a: [0.75, 1, 0.7, 1] },
      { a: [0.1, 0, 0.2, 1], b: [0, 1, 0, 0] },
      { a: [0.1, 0, 0.4, 1], b: [1, 0, 0, 0] },
      { a: [0.1, 0, 0.6, 1], b: [0, 0, 1, 0] },
      { a: [0.1, 0, 0.8, 1], b: [0, 0, 0, 0.5] },
      { a: [0.1, 0, 0.9, 1], b: [0, 0, 0, 1] },
      { a: [0.1, 0, 0.15, 1], c: [0.25, 0.75, 1.0, 0], marked: true },
      { a: [0.1, 0, 0.55, 1], c: [1.0, 0.35, 0.25, 0], marked: true },
      { a: [0.1, 0, 0.35, 1], c: [0, 0, 0, 0.85] },
    ];
    variants.forEach((v, i) => specs.push({ kind: k, lod, x: ((i % 6) - 2.5) * 1.7, z: i < 6 ? -1.3 : 1.3, scale: 1.3, ...v }));
    width = 11;
    depth = 5;
  }

  group = new THREE.Group();
  group.name = 'a4-gallery';
  const radius = Math.max(width, depth) * 0.75 + 2;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.97, 0.4, 96), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.19, 0.18), roughness: 0.92 }));
  disc.position.set(cx, cy - 0.2, cz);
  disc.receiveShadow = true;
  group.add(disc);
  ctx.scene.add(group);

  const tint = new THREE.Color();
  for (const s of specs) {
    const inst = createInstancedCreature(s.kind, s.lod, 1, ctx.uniforms);
    const y = cy + (s.rest !== undefined ? s.rest * s.scale : RIDE_PER_LENGTH * s.scale);
    writeSurfaceMatrix(cx + s.x, y, cz + s.z, 0, 1, 0, s.yaw ?? yaw, s.scale, s.scale, s.scale, 0, inst.matrix, 0);
    tint.setRGB(inst.look.color[0], inst.look.color[1], inst.look.color[2]);
    inst.color[0] = tint.r;
    inst.color[1] = tint.g;
    inst.color[2] = tint.b;
    inst.a.set(s.a ?? [0.18, 0.4, 0.37, 1]);
    inst.b.set(s.b ?? [0, 0, 0, 0]);
    inst.c.set(s.c ?? [0, 0, 0, 0]);
    inst.commit(1);
    if (s.marked) getChitinMaterials(s.kind, ctx.uniforms).uniforms.uMark.value.w = 1;
    group.add(inst.mesh);
    live.push(inst);
  }

  const fov = 30;
  const dist = (Math.max(width / 1.7, depth * 0.8) * 0.5) / Math.tan((fov * Math.PI) / 360) + depth * 0.2;
  const az = opts.orbit ?? 0;
  const el = opts.elevation ?? 0.42;
  return {
    pos: [cx + Math.sin(az) * dist * Math.cos(el), cy + dist * Math.sin(el) + 0.2, cz + Math.cos(az) * dist * Math.cos(el)],
    target: [cx, cy + 0.25, cz],
    fov,
    cut: null,
  };
}
