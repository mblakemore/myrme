import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { b3StateOf, envOf, type Ant, type CasteId, type Chamber, type CreatureGeometryKind, type FrameInfo, type FungusGardenState, type Vec3, type VoxelWorld } from '../../core';
import { getCreatureRig, SPECIES_CASTES } from '../../assets/geometry';
import { applyCutPlane, type Module, type RenderContext } from '../shared';
import { antsRuntime, writeAntBodyMatrix } from './ants';
import { fx, fxDemo, fxKnob } from './fxShared';
import { particles } from './particles';
import { getEnv } from './skyEnv';

/**
 * Zombie fungus + fungus gardens (§5.3 FX, §7 adversities; B4).
 *
 *  - fruiting stalks: one instanced, procedurally built stroma (wiry stalk + swelling perithecial
 *    capsule) growing out of the back of the head of every ant whose `infection.stage` is
 *    `gripped` (a nub), `fruiting` (grows over `infection.timer`) or `burst` (ripe, pulsing), and
 *    out of infected corpse items (`item.infected`, grows with the corpse's age).
 *  - spores: `sporeBurst` events throw a cloud of luminous motes that sink in a widening cone and
 *    drift with the wind; ripe stalks trickle spores continuously; each burst leaves a spore
 *    zone — a lingering haze + soft glow for ~16 s. Glow is carried by one additive sprite batch
 *    (always) and two pooled point lights (medium+), scaled up at night and in pheromone vision.
 *  - fungus gardens (leafcutters): every `colony.chambers[]` entry of kind `fungusGarden` gets a
 *    pale, fluffy, bulbous mass piled on the chamber floor (instanced lumps snapped to the voxel
 *    floor), with twinkling gongylidia; `chamber.health` drives size and the sick state
 *    (grey-green mould blotches, sagging lumps, dark spore dust).
 *
 * Sim inputs: `Ant.infection.{stage,timer}`, `Item.{itemKind,infected,bornTick,up}`, events
 * `sporeBurst{pos,radius}` / `infectionStage{stage:'burst'}`, `Colony.chambers[].{kind,pos,radius,
 * health}`, B3 `b3StateOf(sim).gardens[].{chamberId,fill,mould,status}` (comb size / mould cover),
 * B2 `envOf(sim).stalks[].{id,growth,stage}` and `.sporeClouds[]` (fallbacks: infection timers and
 * `sporeBurst` events when the B2 environment is absent).
 *
 * Demos (`?fxdemo=` / `__myrmeFx.demo`): `garden` — a garden in the player's nest chamber
 * (`__myrmeFx.gardenHealth` / `gardenFill` 0..1, default 1); `spores` — a permanent spore zone at the camera focus.
 */

const MAX_STALKS = 96;
const MAX_GLOWS = 384;
const MAX_BULBS = 320;
const BULBS_PER_GARDEN = 72;
const MAX_ZONES = 8;
/** Ticks for a stalk to reach full height in `fruiting` (re-tuned if B2 exposes its balance). */
const FRUIT_TICKS = 1650;
const GRIP_TICKS = 540;

/** Extra bloom requested by the fungus glow this frame (summed into `fx.bloom` by keeperFx). */
export const fungusLook = { bloom: 0 };

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
function hash(id: number, k: number): number {
  const s = Math.sin(id * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------------------------
// geometry builders
// ---------------------------------------------------------------------------------------------

/** Unit-height stalk along +Y with a gentle S-curve; `aCap` = capsule swell offset (applied × grow). */
function buildStalkGeometry(): THREE.BufferGeometry {
  const rings = 18;
  const radial = 7;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const cap: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const cx = 0.07 * Math.sin(t * 2.6) * t;
    const cz = 0.05 * Math.sin(t * 4.1 + 1) * t;
    const tip = 1 - smooth((t - 0.93) / 0.07);
    const r = (0.03 - 0.014 * t) * (0.25 + 0.75 * tip) + 0.012 * Math.exp(-t * 14);
    const bulge = Math.exp(-((t - 0.78) * (t - 0.78)) / 0.011) * 0.062;
    const capK = Math.exp(-((t - 0.78) * (t - 0.78)) / 0.016);
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      pos.push(cx + nx * r, t, cz + nz * r);
      nrm.push(nx, 0.15, nz);
      cap.push(nx * bulge, 0, nz * bulge, capK);
      // wiry violet-brown stalk, pale at the base where it breaks through the cuticle
      const base = Math.exp(-t * 9);
      col.push(0.2 + 0.5 * base, 0.13 + 0.5 * base, 0.16 + 0.42 * base);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = a + radial;
      const d = b + radial;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aCap', new THREE.Float32BufferAttribute(cap, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/** A lumpy unit blob with a flattened underside (fungus-garden lobe). */
function buildBulbGeometry(detail: number): THREE.BufferGeometry {
  const raw = new THREE.IcosahedronGeometry(1, detail);
  raw.deleteAttribute('uv');
  raw.deleteAttribute('normal');
  const g = mergeVertices(raw, 1e-4);
  raw.dispose();
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i);
    let y = p.getY(i);
    let z = p.getZ(i);
    const n = 1 + 0.16 * Math.sin(x * 4.3 + 1.2) * Math.sin(y * 3.7 + 0.4) * Math.sin(z * 4.9 + 2.1) + 0.08 * Math.sin(x * 9.1 + y * 7.3) * Math.sin(z * 8.3 + y * 5.1);
    x *= n;
    y *= n;
    z *= n;
    if (y < 0) y *= 0.45;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ---------------------------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
float fgHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float fgNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(fgHash(i), fgHash(i + vec3(1,0,0)), f.x), mix(fgHash(i + vec3(0,1,0)), fgHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(fgHash(i + vec3(0,0,1)), fgHash(i + vec3(1,0,1)), f.x), mix(fgHash(i + vec3(0,1,1)), fgHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

function stalkMaterial(ctx: RenderContext, uGlow: THREE.IUniform<number>): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0 });
  mat.name = 'fungus-stalk';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFgClock = fx.uClock;
    shader.uniforms.uFgGlow = uGlow;
    shader.uniforms.uPheroVision = ctx.uniforms.uPheroVision;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFgClock;\nattribute vec4 aCap;\nattribute vec4 aStalk;\nvarying vec4 vStalk;\nvarying float vCapK;\nvarying vec3 vFgObj;')
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = position + aCap.xyz * aStalk.x * (1.0 + 0.1 * aStalk.w * sin(uFgClock * 5.0 + aStalk.z * 40.0));
        vStalk = aStalk; vCapK = aCap.w * aStalk.x; vFgObj = position;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uFgClock;\nuniform float uFgGlow;\nuniform float uPheroVision;\nvarying vec4 vStalk;\nvarying float vCapK;\nvarying vec3 vFgObj;\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fgPores = smoothstep(0.55, 0.8, fgNoise(vFgObj * vec3(150.0, 38.0, 150.0) + vStalk.z * 7.0));
        // ripening capsule: rusty orange with darker ostioles
        vec3 capCol = mix(vec3(0.7, 0.3, 0.07), vec3(0.22, 0.07, 0.03), fgPores * 0.85);
        diffuseColor.rgb = mix(diffuseColor.rgb, capCol, smoothstep(0.25, 0.7, vCapK));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float pulse = 0.75 + 0.25 * sin(uFgClock * 2.3 + vStalk.z * 30.0);
          vec3 glowC = mix(vec3(0.25, 1.0, 0.5), vec3(0.6, 0.3, 1.0), fgPores);
          float g = vStalk.y * (0.12 + 0.88 * smoothstep(0.2, 0.8, vCapK)) * (0.35 + 0.65 * fgPores) * pulse;
          totalEmissiveRadiance += glowC * g * (0.03 + uFgGlow * 1.8 + uPheroVision * 2.5);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'fungus-stalk-v1';
  applyCutPlane(mat, ctx.uniforms, { entity: true });
  return mat;
}

function bulbMaterial(ctx: RenderContext): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  mat.name = 'fungus-garden';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFgClock = fx.uClock;
    shader.uniforms.uPheroVision = ctx.uniforms.uPheroVision;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFgClock;\nattribute vec4 aBulb;\nvarying vec4 vBulb;\nvarying vec3 vFgObj;')
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = position;
        // breathing: the mycelium mat swells very slightly; sick lobes sag
        transformed *= 1.0 + 0.02 * sin(uFgClock * 0.9 + aBulb.y * 40.0) * (1.0 - aBulb.x);
        transformed.y *= 1.0 - 0.4 * aBulb.x * step(0.0, position.y);
        vBulb = aBulb; vFgObj = position;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uFgClock;\nuniform float uPheroVision;\nvarying vec4 vBulb;\nvarying vec3 vFgObj;\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float fgSeed = vBulb.y * 17.0;
        float fgN1 = fgNoise(vFgObj * 5.0 + fgSeed);
        float fgN2 = fgNoise(vFgObj * 19.0 + fgSeed * 3.0);
        float fgN3 = fgNoise(vFgObj * 55.0 + fgSeed);
        // sponge: pale cream mycelium with darker cells (the comb the ants build from leaf pulp)
        float fgCell = smoothstep(0.42, 0.7, fgN2);
        vec3 fgCol = mix(vec3(0.8, 0.75, 0.62), vec3(0.42, 0.37, 0.24), fgCell * 0.75);
        fgCol *= 0.8 + 0.4 * fgN1;
        fgCol = mix(fgCol, vec3(0.42, 0.5, 0.2), smoothstep(0.55, 0.9, fgN1) * 0.3 * vBulb.z); // fresh leaf mulch on young lobes
        fgCol *= 0.86 + 0.28 * fgN3;
        // mould: grey-green blotches spreading from patches, black sporulating centres
        float fgSick = smoothstep(1.05 - vBulb.x * 1.25, 1.3 - vBulb.x * 1.25, fgN1 * 0.75 + fgN2 * 0.35);
        vec3 mould = mix(vec3(0.34, 0.36, 0.2), vec3(0.05, 0.07, 0.05), smoothstep(0.5, 0.85, fgN2) * fgSick);
        fgCol = mix(fgCol, mould, fgSick * 0.92);
        fgCol *= 1.0 - 0.3 * vBulb.x;
        diffuseColor.rgb = fgCol;
        float fgAo = smoothstep(-0.45, 0.6, vFgObj.y);`,
      )
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= 0.25 + 0.75 * fgAo; reflectedLight.directDiffuse *= 0.45 + 0.55 * fgAo;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 Vf = normalize(vViewPosition);
          float fz = pow(1.0 - saturate(dot(normalize(vNormal), Vf)), 2.2);
          // fluffy hyphal halo: the silhouette glows softly, as if backlit through fuzz
          totalEmissiveRadiance += vec3(1.0, 0.94, 0.8) * (fz * 0.16 + 0.02) * (1.0 - fgSick) * (0.4 + 0.6 * fgAo);
          // gongylidia: tiny swollen hyphal tips catching the light, twinkling
          float gg = smoothstep(0.87, 0.93, fgNoise(vFgObj * 34.0 + fgSeed)) * (0.5 + 0.5 * sin(uFgClock * 2.6 + fgN3 * 40.0 + fgSeed));
          totalEmissiveRadiance += vec3(1.0, 0.95, 0.75) * gg * 0.85 * (1.0 - fgSick) * fgAo;
          totalEmissiveRadiance += vec3(0.5, 0.9, 0.6) * uPheroVision * 0.25 * (1.0 - fgSick);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'fungus-garden-v1';
  applyCutPlane(mat, ctx.uniforms, { entity: true });
  return mat;
}

const GLOW_VERT = /* glsl */ `
attribute vec4 aGlowP; // xyz, size
attribute vec4 aGlowC; // rgb, intensity
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vWorld;
void main() {
  vUv = position.xy;
  vCol = aGlowC;
  vWorld = aGlowP.xyz;
  vec4 mv = viewMatrix * vec4(aGlowP.xyz, 1.0);
  mv.xy += position.xy * aGlowP.w;
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FRAG = /* glsl */ `
uniform vec4 uCutPlane;
uniform float uPheroVision;
uniform float uCutSlack;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vWorld;
void main() {
  if (dot(uCutPlane.xyz, vWorld) + uCutPlane.w > uCutSlack * dot(uCutPlane.xyz, uCutPlane.xyz)) discard;
  float r2 = dot(vUv, vUv);
  float a = exp(-r2 * 4.5) - 0.011;
  if (a <= 0.0) discard;
  gl_FragColor = vec4(vCol.rgb * vCol.a * a * (1.0 + 2.2 * uPheroVision), 0.0);
}`;

// ---------------------------------------------------------------------------------------------

interface Zone {
  x: number;
  y: number;
  z: number;
  radius: number;
  born: number;
  life: number;
  acc: number;
}

interface GardenLayout {
  version: number;
  n: number;
  /** x, y, z, size, seed per lobe. */
  data: Float32Array;
}

function instAttr(g: THREE.BufferGeometry, name: string, n: number, size: number): Float32Array<ArrayBuffer> {
  const arr = new Float32Array(n * size);
  const a = new THREE.InstancedBufferAttribute(arr, size);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
  return arr;
}

export function createFungusFxModule(): Module {
  let stalks: THREE.InstancedMesh | null = null;
  let stalkA: Float32Array = new Float32Array(0);
  let bulbs: THREE.InstancedMesh | null = null;
  let bulbA: Float32Array = new Float32Array(0);
  let glows: THREE.Mesh | null = null;
  let glowP: Float32Array = new Float32Array(0);
  let glowC: Float32Array = new Float32Array(0);
  let nGlow = 0;
  const uGlow: THREE.IUniform<number> = { value: 0 };
  const lights: THREE.PointLight[] = [];
  const lightScore = [0, 0];
  const zones: Zone[] = [];
  const layouts = new Map<number, GardenLayout>();
  const rigs = new Map<string, readonly [number, number, number]>();
  /** B2 stalk growth by host / item id (rebuilt every frame from `envOf(sim).stalks`). */
  const stalkGrowth = new Map<number, number>();
  const body = new Float32Array(16);
  const p: Vec3 = { x: 0, y: 0, z: 0 };
  const dn: Vec3 = { x: 0, y: -1, z: 0 };
  const upv: Vec3 = { x: 0, y: 1, z: 0 };
  const sporeGreen: [number, number, number] = [0.22, 1, 0.45];
  const sporeViolet: [number, number, number] = [0.6, 0.25, 1];
  const hazeCol: [number, number, number] = [0.3, 0.75, 0.5];
  let trickle = 0;
  let zoneAcc = 0;
  let registered = false;
  const disposables: { dispose(): void }[] = [];

  function neckOf(a: Readonly<Ant>): readonly [number, number, number] {
    const key = a.species + ':' + a.caste;
    let n = rigs.get(key);
    if (!n) {
      const modelled: CasteId = SPECIES_CASTES[a.species].includes(a.caste) ? a.caste : 'worker';
      n = getCreatureRig(`${a.species}:${modelled}` as CreatureGeometryKind, 2).neck;
      rigs.set(key, n);
    }
    return n;
  }

  function glow(x: number, y: number, z: number, size: number, r: number, g: number, b: number, k: number): void {
    if (nGlow >= MAX_GLOWS || k <= 0.002) return;
    const i = nGlow++ * 4;
    glowP[i] = x;
    glowP[i + 1] = y;
    glowP[i + 2] = z;
    glowP[i + 3] = size;
    glowC[i] = r;
    glowC[i + 1] = g;
    glowC[i + 2] = b;
    glowC[i + 3] = k;
  }

  /** Offers a light source to the two pooled point lights (nearest / strongest wins). */
  function offerLight(x: number, y: number, z: number, power: number, camDist: number, violet: number): void {
    if (lights.length === 0) return;
    const score = power / (1 + camDist * 0.05);
    const slot = lightScore[0] <= lightScore[1] ? 0 : 1;
    if (score <= lightScore[slot]) return;
    lightScore[slot] = score;
    const L = lights[slot];
    L.position.set(x, y, z);
    L.intensity = power;
    L.color.setRGB(0.3 + 0.35 * violet, 1.0 - 0.55 * violet, 0.5 + 0.5 * violet);
  }

  function addZone(pos: Readonly<Vec3>, radius: number, life: number): void {
    let z = zones.length < MAX_ZONES ? null : zones[0];
    if (!z) {
      z = { x: 0, y: 0, z: 0, radius: 1, born: 0, life: 0, acc: 0 };
      zones.push(z);
    } else for (const o of zones) if (o.born < z.born) z = o;
    z.x = pos.x;
    z.y = pos.y;
    z.z = pos.z;
    z.radius = Math.max(1.5, radius);
    z.born = fx.clock;
    z.life = life;
    z.acc = 0;
  }

  function layoutFor(world: VoxelWorld, ch: Readonly<Chamber>): GardenLayout {
    let L = layouts.get(ch.id);
    if (L && L.version === world.version) return L;
    if (!L) {
      L = { version: -1, n: 0, data: new Float32Array(BULBS_PER_GARDEN * 5) };
      layouts.set(ch.id, L);
    }
    L.version = world.version;
    let n = 0;
    const R = Math.max(1.5, ch.radius);
    for (let i = 0; i < BULBS_PER_GARDEN * 2 && n < BULBS_PER_GARDEN; i++) {
      const h = hash(ch.id * 13 + i, 1);
      const rr = R * 0.92 * Math.sqrt((i + 0.5) / (BULBS_PER_GARDEN * 1.4));
      const ang = i * 2.39996 + h * 0.6;
      const x = ch.pos.x + Math.cos(ang) * rr;
      const z = ch.pos.z + Math.sin(ang) * rr;
      // find the chamber floor under this point (start in the air of the chamber)
      let y = ch.pos.y + 0.4;
      let sd = world.sample(x, y, z);
      if (sd > -0.05) {
        y = ch.pos.y + R * 0.4;
        sd = world.sample(x, y, z);
        if (sd > -0.05) continue;
      }
      let found = false;
      for (let s = 0; s < 40; s++) {
        y -= Math.max(0.08, -sd * 0.7);
        sd = world.sample(x, y, z);
        if (sd > -0.06) {
          found = true;
          break;
        }
      }
      if (!found || ch.pos.y - y > R * 1.6 + 1.5) continue;
      // centre lobes are big and piled, the rim is a scatter of small young ones
      const c = 1 - rr / (R * 0.92);
      const size = (0.3 + 0.62 * c * c + 0.22 * h) * Math.min(1.25, R / 3.2);
      const k = n * 5;
      L.data[k] = x;
      L.data[k + 1] = y + size * (0.12 + 0.9 * c * c * hash(ch.id + i, 3));
      L.data[k + 2] = z;
      L.data[k + 3] = size;
      L.data[k + 4] = h;
      n++;
    }
    L.n = n;
    return L;
  }

  return {
    id: 'fungusFx',
    init(ctx) {
      const low = ctx.quality.preset === 'low';
      zones.length = 0;
      layouts.clear();
      rigs.clear();
      trickle = 0;
      fungusLook.bloom = 0;
      if (!registered) {
        registered = true;
        // luminous spores: sink slowly, drift with the wind (gravity ≤ 0.5 → wind applies)
        particles.registerKind('fungusSpore', { count: 80, color: [0.22, 1.0, 0.45], size: 0.065, sizeVar: 0.6, speed: 3.0, speedVar: 0.9, life: 9, lifeVar: 0.5, gravity: 0.13, drag: 1.5, spread: 0.85, radius: 0.25, additive: 1, shape: 3, grow: 0.8, opacity: 0.8, lit: 0 });
        particles.registerKind('fungusSporeFall', { count: 2, color: [0.25, 1.0, 0.5], size: 0.05, sizeVar: 0.5, speed: 0.22, speedVar: 0.8, life: 7, lifeVar: 0.4, gravity: 0.1, drag: 1.2, spread: 1.6, radius: 0.12, additive: 1, shape: 3, grow: 0.8, opacity: 1, lit: 0 });
        particles.registerKind('fungusHaze', { count: 2, color: [0.3, 0.75, 0.5], size: 1.5, sizeVar: 0.4, speed: 0.12, speedVar: 0.6, life: 7, lifeVar: 0.3, gravity: 0.01, drag: 0.6, spread: 2, radius: 1, additive: 1, shape: 0, grow: 1.7, opacity: 0.05, lit: 0 });
        particles.registerKind('fungusMould', { count: 2, color: [0.08, 0.11, 0.07], size: 0.07, sizeVar: 0.6, speed: 0.25, speedVar: 0.6, life: 3.5, lifeVar: 0.4, gravity: -0.03, drag: 1.5, spread: 1.2, radius: 0.5, additive: 0, shape: 0, grow: 2.2, opacity: 0.5, lit: 0.6 });
      }

      const sg = buildStalkGeometry();
      stalkA = instAttr(sg, 'aStalk', MAX_STALKS, 4);
      const sm = stalkMaterial(ctx, uGlow);
      stalks = new THREE.InstancedMesh(sg, sm, MAX_STALKS);
      stalks.name = 'fungus:stalks';
      stalks.frustumCulled = false;
      stalks.castShadow = false;
      stalks.receiveShadow = true;
      stalks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      stalks.count = 0;
      stalks.visible = false;
      ctx.scene.add(stalks);

      const bg = buildBulbGeometry(low ? 1 : 2);
      bulbA = instAttr(bg, 'aBulb', MAX_BULBS, 4);
      const bm = bulbMaterial(ctx);
      bulbs = new THREE.InstancedMesh(bg, bm, MAX_BULBS);
      bulbs.name = 'fungus:garden';
      bulbs.frustumCulled = false;
      bulbs.castShadow = !low;
      bulbs.receiveShadow = true;
      bulbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      bulbs.count = 0;
      bulbs.visible = false;
      ctx.scene.add(bulbs);

      const gg = new THREE.InstancedBufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
      gg.setIndex([0, 1, 2, 0, 2, 3]);
      glowP = instAttr(gg, 'aGlowP', MAX_GLOWS, 4);
      glowC = instAttr(gg, 'aGlowC', MAX_GLOWS, 4);
      gg.instanceCount = 0;
      gg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const gm = new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        uniforms: { uCutPlane: ctx.uniforms.uCutPlane, uPheroVision: ctx.uniforms.uPheroVision, uCutSlack: { value: ctx.uniforms.uCutEntity.value.z } },
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
      });
      glows = new THREE.Mesh(gg, gm);
      glows.name = 'fungus:glow';
      glows.frustumCulled = false;
      glows.renderOrder = 7;
      glows.visible = false;
      ctx.scene.add(glows);
      disposables.push(sg, sm, bg, bm, gg, gm);

      if (!low) {
        for (let i = 0; i < 2; i++) {
          const L = new THREE.PointLight(new THREE.Color(0.35, 1, 0.55), 0, 14, 1.6);
          L.name = 'fungus-glow-' + i;
          ctx.scene.add(L);
          lights.push(L);
        }
      }
    },

    update(ctx: RenderContext, frame: FrameInfo) {
      if (!stalks || !bulbs || !glows) return;
      const sim = ctx.sim;
      const view = ctx.view;
      const culler = antsRuntime.culler;
      const env = getEnv(ctx);
      const clock = fx.clock;
      const dt = fx.dAnim;
      const phero = ctx.uniforms.uPheroVision.value;
      // glow strength: faint by day, eerie at dusk / night and underground-dark rooms
      const dark = env.room ? 0.35 + 0.5 * env.night : Math.max(env.night, 0.55 * env.golden);
      // the night grade lifts exposure ~4×: keep self-lit things from clipping
      const comp = env.room ? 1 : 1 / (1 + 2.6 * env.night);
      const glowK = (0.12 + 0.88 * dark) * comp;
      const lightK = dark * comp * comp;
      uGlow.value = glowK;
      nGlow = 0;
      lightScore[0] = lightScore[1] = 0;
      for (let i = 0; i < lights.length; i++) lights[i].intensity = 0;
      let bloom = 0;

      // ---- events ---------------------------------------------------------------------------
      const tintK = 0.45 + 0.55 * comp;
      const events = frame.events;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === 'sporeBurst') {
          if (!envOf(sim)) addZone(e.pos, e.radius, 16);
          const sp = 0.7 + 0.25 * Math.min(4, e.radius);
          sporeGreen[0] = 0.22 * tintK;
          sporeGreen[1] = tintK;
          sporeGreen[2] = 0.45 * tintK;
          sporeViolet[0] = 0.6 * tintK;
          sporeViolet[1] = 0.25 * tintK;
          sporeViolet[2] = tintK;
          hazeCol[0] = 0.3 * comp;
          hazeCol[1] = 0.75 * comp;
          hazeCol[2] = 0.5 * comp;
          particles.emitCustom('fungusSpore', e.pos, upv, { radius: 0.2, speed: sp, color: sporeGreen });
          particles.emitCustom('fungusSpore', e.pos, upv, { count: 40, color: sporeViolet, size: 0.8, speed: sp * 0.8, life: 1.2 });
          particles.emitCustom('fungusHaze', e.pos, upv, { count: 6, radius: e.radius * 0.35, color: hazeCol });
        }
      }
      if (fxDemo('spores')) {
        const f = view.camera.focus;
        if (zones.length === 0 || clock - zones[0].born > 10) addZone(f, 4, 16);
      }

      // ---- fruiting stalks ------------------------------------------------------------------
      let ns = 0;
      const ants = sim.ants;
      const mtx = stalks.instanceMatrix.array as Float32Array;
      trickle += dt;
      const doTrickle = trickle > 0.12;
      if (doTrickle) trickle = 0;

      const put = (hx: number, hy: number, hz: number, ux: number, uy: number, uz: number, len: number, grow: number, cap: number, ripe: number, seed: number): void => {
        // stalk axis: mostly skyward, leaning with the host's own up and a little at random
        const a = seed * 6.283;
        let dx = ux * 0.45 + Math.cos(a) * 0.16;
        let dy = uy * 0.45 + 0.8;
        let dz = uz * 0.45 + Math.sin(a) * 0.16;
        let l = Math.hypot(dx, dy, dz) || 1;
        dx /= l;
        dy /= l;
        dz /= l;
        // any perpendicular, spun by the seed
        let tx = Math.abs(dy) < 0.9 ? dz : 0;
        let ty = Math.abs(dy) < 0.9 ? 0 : -dz;
        let tz = Math.abs(dy) < 0.9 ? -dx : dy;
        l = Math.hypot(tx, ty, tz) || 1;
        tx /= l;
        ty /= l;
        tz /= l;
        const bx = dy * tz - dz * ty;
        const by = dz * tx - dx * tz;
        const bz = dx * ty - dy * tx;
        const h = len * grow;
        const w = len * (0.7 + 0.5 * grow);
        const o = ns * 16;
        mtx[o] = tx * w;
        mtx[o + 1] = ty * w;
        mtx[o + 2] = tz * w;
        mtx[o + 3] = 0;
        mtx[o + 4] = dx * h;
        mtx[o + 5] = dy * h;
        mtx[o + 6] = dz * h;
        mtx[o + 7] = 0;
        mtx[o + 8] = bx * w;
        mtx[o + 9] = by * w;
        mtx[o + 10] = bz * w;
        mtx[o + 11] = 0;
        mtx[o + 12] = hx;
        mtx[o + 13] = hy;
        mtx[o + 14] = hz;
        mtx[o + 15] = 1;
        const k = ns * 4;
        const glowAmt = cap * (0.5 + 0.5 * ripe);
        stalkA[k] = cap;
        stalkA[k + 1] = glowAmt;
        stalkA[k + 2] = seed;
        stalkA[k + 3] = ripe;
        ns++;
        if (cap > 0.05) {
          // capsule position (78% up the stalk, ignoring the S-curve)
          const cx = hx + dx * h * 0.8;
          const cy = hy + dy * h * 0.8;
          const cz = hz + dz * h * 0.8;
          const pulse = 0.8 + 0.2 * Math.sin(clock * 2.3 + seed * 30);
          const violet = 0.5 + 0.5 * Math.sin(seed * 50);
          glow(cx, cy, cz, len * (0.35 + 0.55 * glowAmt), 0.25 + 0.3 * violet, 1 - 0.5 * violet, 0.5 + 0.4 * violet, glowAmt * pulse * (0.05 + 0.3 * glowK));
          const cd = culler.dist(cx, cy, cz);
          offerLight(cx + dx * 0.2, cy + dy * 0.2, cz + dz * 0.2, glowAmt * pulse * lightK * 5, cd, violet);
          bloom = Math.max(bloom, glowAmt * dark * 0.25 * Math.max(0, 1 - cd / 60));
          if (ripe > 0.5 && doTrickle && cd < 70) {
            p.x = cx;
            p.y = cy;
            p.z = cz;
            particles.emitCustom('fungusSporeFall', p, dn, violet > 0.75 ? { color: [0.65, 0.45, 1.0] } : undefined);
          }
        }
      };

      // B2's authoritative stalk list (growth 0..1 per host / corpse); absent → derive from timers
      const b2 = envOf(sim);
      stalkGrowth.clear();
      if (b2) for (let i = 0; i < b2.stalks.length; i++) stalkGrowth.set(b2.stalks[i].id, b2.stalks[i].stage === 'burst' ? 2 : b2.stalks[i].growth);

      for (let i = 0; i < ants.length && ns < MAX_STALKS; i++) {
        const a = ants[i];
        const st = a.infection.stage;
        if (!a.alive || (st !== 'gripped' && st !== 'fruiting' && st !== 'burst')) continue;
        if (a.id === view.possessedId && view.firstPerson && view.mode === 'possess') continue;
        if (culler.depthIfVisible(a.pos.x, a.pos.y, a.pos.z, 3) < 0) continue;
        let grow: number;
        if (st === 'gripped') grow = 0.13 * smooth(a.infection.timer / GRIP_TICKS);
        else if (st === 'fruiting') {
          const g = stalkGrowth.get(a.id);
          grow = 0.13 + 0.87 * smooth(g !== undefined ? Math.min(1, g) : (a.infection.timer + frame.alpha) / FRUIT_TICKS);
        }
        else grow = 1;
        if (grow < 0.01) continue;
        const len = writeAntBodyMatrix(a, frame.alpha, view, body, 0);
        const nk = neckOf(a);
        // back of the head: just behind / above the neck joint (the head hangs in the death grip)
        const lx = nk[0];
        const ly = nk[1] + 0.07;
        const lz = nk[2] + 0.05;
        const hx = body[0] * lx + body[4] * ly + body[8] * lz + body[12];
        const hy = body[1] * lx + body[5] * ly + body[9] * lz + body[13];
        const hz = body[2] * lx + body[6] * ly + body[10] * lz + body[14];
        put(hx, hy, hz, body[4] / len, body[5] / len, body[6] / len, len * 1.55, grow, smooth((grow - 0.5) / 0.5), st === 'burst' ? 1 : 0, a.phase);
      }
      const items = sim.items;
      for (let i = 0; i < items.length && ns < MAX_STALKS; i++) {
        const it = items[i];
        if (!it.alive || !it.infected || it.itemKind !== 'corpse' || it.carriedBy) continue;
        if (culler.depthIfVisible(it.pos.x, it.pos.y, it.pos.z, 3) < 0) continue;
        const g = stalkGrowth.get(it.id);
        if (b2 && g === undefined) continue; // not sprouting yet
        const grow = g !== undefined ? 0.1 + 0.9 * smooth(Math.min(1, g)) : 0.1 + 0.9 * smooth((sim.tick - it.bornTick) / (FRUIT_TICKS * 1.3));
        const seed = hash(it.id, 4);
        put(it.pos.x + (seed - 0.5) * 0.2, it.pos.y - 0.05, it.pos.z + (hash(it.id, 5) - 0.5) * 0.2, it.up.x, it.up.y, it.up.z, 1.0, grow, smooth((grow - 0.5) / 0.5), (g !== undefined ? g > 1.5 : grow > 0.97) ? 1 : 0, seed);
      }
      stalks.count = ns;
      stalks.visible = ns > 0;
      if (ns > 0) {
        stalks.instanceMatrix.clearUpdateRanges();
        stalks.instanceMatrix.addUpdateRange(0, ns * 16);
        stalks.instanceMatrix.needsUpdate = true;
        const at = stalks.geometry.attributes.aStalk as THREE.BufferAttribute;
        at.clearUpdateRanges();
        at.addUpdateRange(0, ns * 4);
        at.needsUpdate = true;
      }

      // ---- spore zones: haze, glow, drifting motes ----------------------------------------------
      zoneAcc += dt;
      const zoneEmit = zoneAcc > 0.3;
      if (zoneEmit) zoneAcc = 0;
      const drawZone = (zx: number, zy: number, zz: number, radius: number, age: number, life: number): void => {
        if (age < 0 || age > life) return;
        const k = smooth(age / 0.6) * (1 - smooth((age - life * 0.55) / (life * 0.45)));
        const cd = culler.dist(zx, zy, zz);
        // the cloud sinks and spreads
        const cy = zy + 0.4 - Math.min(1.2, age * 0.12);
        const R = radius * (0.8 + 0.5 * smooth(age / 5));
        glow(zx, cy, zz, R * 2.3, 0.12, 0.7, 0.35, k * (0.015 + 0.085 * glowK + 0.05 * phero));
        glow(zx + R * 0.3, cy + 0.5, zz - R * 0.2, R * 1.3, 0.5, 0.15, 1.0, k * (0.012 + 0.07 * glowK + 0.05 * phero));
        offerLight(zx, zy + 0.8, zz, k * lightK * 9, cd, 0.45);
        bloom = Math.max(bloom, k * dark * 0.35 * Math.max(0, 1 - cd / 80));
        if (zoneEmit && cd < 90) {
          p.x = zx;
          p.y = cy + 0.3;
          p.z = zz;
          hazeCol[0] = 0.3 * comp;
          hazeCol[1] = 0.75 * comp;
          hazeCol[2] = 0.5 * comp;
          particles.emitCustom('fungusHaze', p, upv, { count: 1, radius: R * 0.6, color: hazeCol });
          particles.emitCustom('fungusSporeFall', p, dn, { count: 3, radius: R * 0.7, life: 0.8 });
        }
      };
      if (b2) {
        // B2's lingering spore clouds are the truth (ants inside keep getting dosed)
        const clouds = b2.sporeClouds;
        const now = sim.tick + frame.alpha;
        for (let i = 0; i < clouds.length && i < 24; i++) {
          const c = clouds[i];
          drawZone(c.pos.x, c.pos.y, c.pos.z, Math.max(1.5, c.radius), (now - c.bornTick) / 30, Math.max(1, (c.untilTick - c.bornTick) / 30));
        }
      }
      for (let i = 0; i < zones.length; i++) {
        const z = zones[i];
        drawZone(z.x, z.y, z.z, z.radius, clock - z.born, z.life);
      }

      // ---- fungus gardens ---------------------------------------------------------------------
      let nb = 0;
      const world = sim.world;
      const bm = bulbs.instanceMatrix.array as Float32Array;
      const colonies = sim.colonies;
      const demo = fxDemo('garden');
      const gardens = b3StateOf(sim).gardens;
      for (let c = 0; c < colonies.length; c++) {
        const col = colonies[c];
        if (!col.alive) continue;
        const chambers = col.chambers;
        const nCh = chambers.length + (demo && col.id === sim.playerColony ? 1 : 0);
        for (let j = 0; j < nCh; j++) {
          let ch: Readonly<Chamber>;
          if (j < chambers.length) {
            ch = chambers[j];
            if (ch.kind !== 'fungusGarden') continue;
          } else {
            demoChamber.pos = col.nestPos;
            demoChamber.cell = col.nestCell;
            demoChamber.health = fxKnob('gardenHealth', 1);
            ch = demoChamber;
          }
          if (culler.depthIfVisible(ch.pos.x, ch.pos.y, ch.pos.z, ch.radius + 3) < 0) continue;
          const L = layoutFor(world, ch);
          const health = Math.min(1, Math.max(0, ch.health));
          // B3's garden record (fill = biomass / capacity, mould cover) when the garden system runs
          let gs: FungusGardenState | null = null;
          for (let g = 0; g < gardens.length; g++) if (gardens[g].chamberId === ch.id && gardens[g].colony === col.id) gs = gardens[g];
          const mass = j >= chambers.length ? fxKnob('gardenFill', 1) : gs ? (gs.status === 'collapsed' ? 0.12 : Math.min(1, Math.max(0.08, gs.fill))) : 0.45 + 0.55 * health;
          const sickAll = Math.max(1 - smooth(health / 0.7), gs ? Math.max(smooth(gs.mould / 0.65), gs.status === 'collapsed' ? 1 : 0) : 0);
          const n = Math.min(L.n, Math.max(6, Math.round(L.n * (0.3 + 0.7 * mass))));
          const sizeK = (0.7 + 0.3 * mass) * (1 - 0.18 * sickAll);
          for (let b = 0; b < n && nb < MAX_BULBS; b++) {
            const d = b * 5;
            const seed = L.data[d + 4];
            const s = L.data[d + 3] * sizeK;
            const o = nb * 16;
            const yaw = seed * 6.283;
            const cs = Math.cos(yaw) * s;
            const sn = Math.sin(yaw) * s;
            bm[o] = cs;
            bm[o + 1] = 0;
            bm[o + 2] = -sn;
            bm[o + 3] = 0;
            bm[o + 4] = 0;
            bm[o + 5] = s * (0.8 + 0.3 * seed);
            bm[o + 6] = 0;
            bm[o + 7] = 0;
            bm[o + 8] = sn;
            bm[o + 9] = 0;
            bm[o + 10] = cs;
            bm[o + 11] = 0;
            bm[o + 12] = L.data[d];
            bm[o + 13] = L.data[d + 1] + s * 0.25;
            bm[o + 14] = L.data[d + 2];
            bm[o + 15] = 1;
            const k = nb * 4;
            // sickness creeps in lobe by lobe: the unluckiest go first
            bulbA[k] = Math.min(1, Math.max(0, sickAll * 1.7 - seed * 0.7));
            bulbA[k + 1] = seed;
            bulbA[k + 2] = b / n; // young (outer) lobes carry fresh mulch
            bulbA[k + 3] = 0;
            nb++;
          }
          if (sickAll > 0.25 && doTrickle && hash(Math.floor(clock * 8), ch.id) < sickAll * 0.5) {
            p.x = ch.pos.x;
            p.y = ch.pos.y - ch.radius * 0.2;
            p.z = ch.pos.z;
            particles.emitCustom('fungusMould', p, upv, { radius: ch.radius * 0.6 });
          }
          if (phero > 0.05) glow(ch.pos.x, ch.pos.y, ch.pos.z, ch.radius * 1.6, 0.5, 1.0, 0.6, phero * 0.08 * (1 - sickAll));
        }
      }
      bulbs.count = nb;
      bulbs.visible = nb > 0;
      if (nb > 0) {
        bulbs.instanceMatrix.clearUpdateRanges();
        bulbs.instanceMatrix.addUpdateRange(0, nb * 16);
        bulbs.instanceMatrix.needsUpdate = true;
        const at = bulbs.geometry.attributes.aBulb as THREE.BufferAttribute;
        at.clearUpdateRanges();
        at.addUpdateRange(0, nb * 4);
        at.needsUpdate = true;
      }

      // ---- commit glows ----------------------------------------------------------------------------
      const gg = glows.geometry as THREE.InstancedBufferGeometry;
      gg.instanceCount = nGlow;
      glows.visible = nGlow > 0;
      if (nGlow > 0) {
        const a1 = gg.attributes.aGlowP as THREE.BufferAttribute;
        const a2 = gg.attributes.aGlowC as THREE.BufferAttribute;
        a1.clearUpdateRanges();
        a1.addUpdateRange(0, nGlow * 4);
        a1.needsUpdate = true;
        a2.clearUpdateRanges();
        a2.addUpdateRange(0, nGlow * 4);
        a2.needsUpdate = true;
      }
      fungusLook.bloom = bloom;
    },

    dispose() {
      stalks?.removeFromParent();
      bulbs?.removeFromParent();
      glows?.removeFromParent();
      stalks?.dispose();
      bulbs?.dispose();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      for (const L of lights) {
        L.removeFromParent();
        L.dispose();
      }
      lights.length = 0;
      stalks = bulbs = null;
      glows = null;
      zones.length = 0;
      layouts.clear();
      fungusLook.bloom = 0;
    },
  };
}

const demoChamber: Chamber = { id: 999983, kind: 'fungusGarden', cell: -1, pos: { x: 0, y: 0, z: 0 }, radius: 3.4, health: 1 };

export const fungusFxModule: Module = createFungusFxModule();
