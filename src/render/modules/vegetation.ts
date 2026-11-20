import * as THREE from 'three';
import { ISO, Mat, SeededRng, hash01, type MapId, type PropDef } from '../../core';
import type { Module, RenderContext } from '../shared';
import { fx } from './fxShared';
import { getEnv, type EnvState } from './skyEnv';
import { waterShared } from './waterShared';
import { broadLeafGeometry, cloverGeometry, dewGeometry, flowerGeometry, grassBladeGeometry, mushroomGeometry, pebbleGeometry, petalGeometry, twigGeometry } from './vegetationGeometry';

/**
 * Render-only vegetation and ground scatter on top of the voxel plants (§5.3, D18).
 *
 * One InstancedMesh per shape (grass blade, broad leaf, clover, flower, petal, pebble, twig,
 * mushroom, dew drop) sharing one foliage material: MeshStandardMaterial + onBeforeCompile with
 * wind sway from the shared `uWind` / `uTime`, thin-leaf translucency (backlit blades glow),
 * `uCutPlane` discard, pheromone-vision desaturation and a dithered fade for tall growth that
 * sits between the RTS camera and its focus point, so decoration never hides the action.
 *
 * Placement is deterministic (map seed): A1's prop hints first (leaf blades around voxel stems,
 * ray florets around voxel flower heads, grass patches, loose leaves, pebbles), then a jittered
 * grid scatter over the ground height field — patchy by noise, by ground material, thinned around
 * nest entrances, food and puddles, never under overhangs. Density follows `quality.decoration`.
 * Instances rooted on ground that is later dug away collapse in the vertex shader.
 */

type Kind = 'blade' | 'leaf' | 'clover' | 'flower' | 'petal' | 'pebble' | 'twig' | 'mushroom';

interface Biome {
  grass: number; // tufts per accepted scatter cell (probability scale)
  grassH: [number, number];
  grassA: [number, number, number]; // sRGB tints
  grassB: [number, number, number];
  dry: number; // fraction of straw-coloured blades
  clover: number;
  flowers: number;
  pebbles: number;
  twigs: number;
  leaves: number;
  mushrooms: number;
}

const BIOMES: Partial<Record<MapId, Biome>> = {
  meadow: { grass: 1, grassH: [3.5, 15], grassA: [0.3, 0.52, 0.14], grassB: [0.5, 0.68, 0.2], dry: 0.08, clover: 0.5, flowers: 0.11, pebbles: 0.05, twigs: 0.012, leaves: 0.012, mushrooms: 0.004 },
  forest: { grass: 0.3, grassH: [2.5, 9], grassA: [0.16, 0.36, 0.12], grassB: [0.3, 0.5, 0.16], dry: 0.05, clover: 0.2, flowers: 0.02, pebbles: 0.04, twigs: 0.06, leaves: 0.16, mushrooms: 0.03 },
  desert: { grass: 0.14, grassH: [2, 7], grassA: [0.62, 0.55, 0.3], grassB: [0.75, 0.68, 0.4], dry: 0.7, clover: 0, flowers: 0, pebbles: 0.14, twigs: 0.02, leaves: 0, mushrooms: 0 },
};

const SWAY = /* glsl */ `
uniform vec3 uWind;
uniform vec4 uRain; // rain, storm, wetness, wind strength (waterShared)
vec3 vegSway(vec3 base, float phase, float amp) {
  float t = uWind.z;
  float gust = sin(t * 1.3 + phase) * 0.6 + sin(t * 2.9 + phase * 1.7) * 0.25 + 0.45 * sin(t * 0.4 + base.x * 0.03 + base.z * 0.02) + 0.35;
  vec2 w = uWind.xy * gust + vec2(-uWind.y, uWind.x) * 0.3 * sin(t * 2.1 + phase * 2.3);
  // gust fronts: bands of harder wind that roll across the field along the wind direction
  float wl = length(uWind.xy);
  if (wl > 0.4) {
    vec2 wd = uWind.xy / wl;
    float front = dot(base.xz, wd) * 0.055 - t * 1.6 + 0.6 * sin(dot(base.xz, vec2(-wd.y, wd.x)) * 0.04);
    float band = pow(0.5 + 0.5 * sin(front), 4.0);
    w += wd * band * (wl - 0.4) * 1.5 + vec2(-wd.y, wd.x) * band * 0.25 * wl * sin(t * 9.0 + phase * 3.0);
  }
  vec3 s = vec3(w.x, -dot(w, w) * 0.35, w.y) * amp;
  // rain patter: every so often a drop lands on the blade and it nods
  if (uRain.x > 0.01) {
    float hit = pow(max(sin(t * 3.7 + phase * 5.3), 0.0), 16.0) + 0.6 * pow(max(sin(t * 5.9 + phase * 2.1), 0.0), 24.0);
    s.y -= hit * uRain.x * amp * 0.5;
    s.xz += vec2(sin(phase * 7.0), cos(phase * 7.0)) * hit * uRain.x * amp * 0.25;
  }
  return s;
}`;

const VERT_PARS = /* glsl */ `
attribute vec3 aCol;
attribute vec3 aParam;
attribute vec2 aUv;
attribute vec4 iColor;
attribute vec4 iData;
uniform sampler2D uGroundTex;
uniform vec3 uWorldSize;
uniform vec3 uFocus;
uniform vec3 uFade; // amount, radius, instance height from which it applies
uniform float uUseGround;
varying vec3 vCol;
varying vec3 vVegW;
varying vec2 vVegP; // translucency, unused
varying vec2 vVegUv;
${SWAY}
`;

const VERT_MAIN = /* glsl */ `
{
  vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  // tall growth standing between the camera and its focus point ducks down, so decoration never
  // hides the action (RTS view only; smooth, no dithering)
  vec3 cf = uFocus - cameraPosition;
  float len = max(length(cf), 1e-3);
  vec3 cd = cf / len;
  float along = dot(base - cameraPosition, cd);
  float radial = length(base - cameraPosition - cd * along);
  float f = (1.0 - smoothstep(uFade.y * 0.4, uFade.y, radial)) * smoothstep(0.0, len * 0.2, along) * (1.0 - smoothstep(len * 1.0, len * 1.3, along));
  float hInst = length(instanceMatrix[1].xyz);
  f *= uFade.x * smoothstep(uFade.z, uFade.z * 2.5, hInst) * iData.x;
  transformed *= 1.0 - f * (1.0 - uFade.z / max(hInst, uFade.z));
  vec3 sway = vegSway(base, iData.y, aParam.x * iData.z * (1.0 - 0.7 * f));
  transformed += inverse(mat3(instanceMatrix)) * sway;
  // rooted in ground that has since been dug away (or buried): collapse
  if (iData.x > 0.5 && uUseGround > 0.5) {
    float gh = textureLod(uGroundTex, base.xz / uWorldSize.xz, 0.0).r;
    if (abs(gh + iData.w - base.y) > 1.3) transformed = vec3(0.0);
  }
  vVegW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vCol = aCol * mix(vec3(1.0), iColor.rgb, aParam.y);
  vVegP = vec2(aParam.z, 0.0);
  vVegUv = aUv;
}
`;

const FRAG_PARS = /* glsl */ `
uniform vec4 uCutPlane;
uniform vec3 uSunDirW;
uniform vec3 uKeyColor;
uniform vec3 uAmbientColor;
uniform float uPheroVision;
varying vec3 vCol;
varying vec3 vVegW;
varying vec2 vVegP;
varying vec2 vVegUv;
`;

function createFoliageMaterial(ctx: RenderContext, env: EnvState, fade: THREE.IUniform<THREE.Vector3>, depth: boolean): THREE.Material {
  const mat: THREE.Material = depth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.52, metalness: 0, side: THREE.DoubleSide });
  mat.name = depth ? 'foliage-depth' : 'foliage';
  mat.onBeforeCompile = (shader) => {
    const u = shader.uniforms;
    u.uWind = ctx.uniforms.uWind;
    u.uRain = waterShared.uRain;
    u.uGroundTex = env.uniforms.uGroundTex;
    u.uWorldSize = env.uniforms.uWorldSize;
    u.uFocus = env.uniforms.uFocus;
    u.uFade = fade;
    u.uUseGround = { value: 1 };
    u.uCutPlane = ctx.uniforms.uCutPlane;
    u.uSunDirW = ctx.uniforms.uSunDir;
    u.uKeyColor = env.uniforms.uKeyColor;
    u.uAmbientColor = env.uniforms.uAmbientColor;
    u.uPheroVision = ctx.uniforms.uPheroVision;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_MAIN}`);
    if (depth) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform vec4 uCutPlane; varying vec3 vVegW;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\nif (dot(uCutPlane.xyz, vVegW) + uCutPlane.w > 0.0) discard;`);
      return;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if (dot(uCutPlane.xyz, vVegW) + uCutPlane.w > 0.0) discard;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float vegRib = 0.0;
        {
          vec3 c = vCol;
          if (abs(vVegUv.x) < 1.5) {
            // leaf strips: parallel veins, pale midrib, blotchy tone along the length
            float u = vVegUv.x; float v = vVegUv.y;
            vegRib = 0.5 + 0.5 * cos(u * 3.14159 * 9.0);
            float mid = smoothstep(0.14, 0.0, abs(u)) * smoothstep(1.0, 0.6, v);
            c *= 0.9 + 0.13 * vegRib;
            c = mix(c, c * 1.3 + 0.012, mid * 0.55);
            c *= 0.95 + 0.08 * sin(v * 9.0 + vCol.g * 47.0) * sin(v * 3.3 + u * 1.5 + vCol.r * 31.0);
            c *= 0.82 + 0.18 * smoothstep(1.0, 0.75, abs(u)); // darker rolled edge
          }
          diffuseColor.rgb = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))) * 0.5, uPheroVision * 0.85);
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = 0.56 - 0.2 * vegRib;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (abs(vVegUv.x) < 1.5) {
          // corrugate the blade across its width so it catches light like a real leaf
          vec3 tx = normalize(dFdx(vVegW) * dFdy(vVegUv.y) - dFdy(vVegW) * dFdx(vVegUv.y));
          vec3 txV = normalize((viewMatrix * vec4(tx, 0.0)).xyz);
          normal = normalize(normal + txV * sin(vVegUv.x * 3.14159 * 9.0) * 0.12 * sign(dot(normal, vec3(0.0, 0.0, 1.0)) + 1e-4));
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // thin-leaf translucency: sun on the far side shines through; strongest looking into the light
          vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 vW = normalize(cameraPosition - vVegW);
          float back = max(dot(-nW, uSunDirW), 0.0);
          float through = pow(max(dot(vW, -uSunDirW), 0.0), 4.0);
          float fr = pow(1.0 - abs(dot(nW, vW)), 3.0);
          totalEmissiveRadiance += diffuseColor.rgb * vVegP.x * (uKeyColor * vec3(1.05, 1.15, 0.5) * (back * 0.3 + through * 0.4) + uAmbientColor * fr * 0.5) * (1.0 - 0.7 * uPheroVision);
        }`,
      );
  };
  return mat;
}

const DEW_VERT = /* glsl */ `
attribute vec4 iData; // threshold seed, sway phase, sway amp, roll distance
uniform float uDew;
uniform float uRoll;
uniform float uClock;
varying vec3 vN;
varying vec3 vW;
${SWAY}
void main() {
  vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float k = smoothstep(iData.x * 0.7, iData.x * 0.7 + 0.3, uDew);
  // while it rains (and for a while after) beads swell, let go, roll down and re-form
  float cyc = fract(uClock * (0.07 + 0.11 * iData.x) + iData.x * 7.3);
  float roll = smoothstep(0.55, 1.0, cyc);
  float swell = mix(1.0, (0.6 + 0.7 * smoothstep(0.0, 0.55, cyc)) * (1.0 - smoothstep(0.9, 1.0, cyc)), uRoll);
  vec3 lp = position * k * swell;
  // a rolling bead stretches into a teardrop
  lp.y *= 1.0 + 0.5 * roll * uRoll;
  vec4 w = modelMatrix * instanceMatrix * vec4(lp, 1.0);
  w.xyz += vegSway(base, iData.y, iData.z);
  w.y -= roll * roll * iData.w * uRoll;
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const DEW_FRAG = /* glsl */ `
uniform samplerCube uEnvCube;
uniform vec3 uSunDirW;
uniform vec3 uKeyColor;
uniform vec4 uCutPlane;
varying vec3 vN;
varying vec3 vW;
void main() {
  if (dot(uCutPlane.xyz, vW) + uCutPlane.w > 0.0) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndv = max(dot(N, V), 0.0);
  // a drop is a tiny fisheye lens: the world behind appears inverted, edges go dark, then bright
  vec3 Rr = refract(-V, N, 0.75);
  vec3 refr = textureCube(uEnvCube, vec3(-Rr.x, -Rr.y, Rr.z), 1.5).rgb;
  vec3 refl = textureCube(uEnvCube, reflect(-V, N), 0.5).rgb;
  float fres = 0.03 + 0.97 * pow(1.0 - ndv, 4.0);
  vec3 col = refr * mix(0.55, 1.05, ndv) + refl * fres * 1.4;
  vec3 H = normalize(V + uSunDirW);
  col += uKeyColor * (pow(max(dot(N, H), 0.0), 500.0) * 9.0 + pow(max(dot(N, H), 0.0), 40.0) * 0.12);
  // caustic hot spot on the far side from the sun
  col += uKeyColor * pow(max(dot(N, -uSunDirW), 0.0), 6.0) * 0.25 * vec3(0.9, 1.0, 0.8);
  gl_FragColor = vec4(col, 1.0);
}`;

const srgb = (c: readonly number[]): THREE.Color => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

/** Cheap deterministic 2D value noise for placement masks. */
function vnoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(x0, z0, seed);
  const b = hash01(x0 + 1, z0, seed);
  const c = hash01(x0, z0 + 1, seed);
  const d = hash01(x0 + 1, z0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

interface Batch {
  mats: number[];
  cols: number[];
  data: number[];
}

const MAX_TIPS = 1500;
/** Sampled grass-blade tip positions (xyz triplets) for the weather module's drips. Rebuilt with the vegetation. */
export const vegetationTips = { data: new Float32Array(MAX_TIPS * 3), count: 0 };

export function createVegetationModule(): Module {
  let group: THREE.Group | null = null;
  const disposables: { dispose(): void }[] = [];
  let dewMesh: THREE.InstancedMesh | null = null;
  let dewMat: THREE.ShaderMaterial | null = null;
  const fade: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3(0, 10, 1.5) };
  let fadeCur = 0;

  function build(ctx: RenderContext): void {
    const env = getEnv(ctx);
    const biome = BIOMES[ctx.sim.mapId];
    if (!biome || ctx.map.flags.slab) return;
    const world = ctx.sim.world;
    const ground = env.ground;
    const { sx, sz, sy } = world;
    const density = ctx.quality.decoration * (env.debug.vegetation ?? 1);
    if (density <= 0) return;
    const rng = new SeededRng(ctx.sim.options.seed).fork('a3-vegetation');
    const seed = ctx.sim.options.seed | 0;

    const batches: Record<Kind, Batch> = {
      blade: { mats: [], cols: [], data: [] },
      leaf: { mats: [], cols: [], data: [] },
      clover: { mats: [], cols: [], data: [] },
      flower: { mats: [], cols: [], data: [] },
      petal: { mats: [], cols: [], data: [] },
      pebble: { mats: [], cols: [], data: [] },
      twig: { mats: [], cols: [], data: [] },
      mushroom: { mats: [], cols: [], data: [] },
    };
    const dew: Batch = { mats: [], cols: [], data: [] };
    let tipCount = 0;
    const tipData = vegetationTips.data;

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const q2 = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const X = new THREE.Vector3(1, 0, 0);
    const col = new THREE.Color();
    const colB = new THREE.Color();

    /** yaw about y, then tilt forward (towards the yawed +z) by `pitch`, plus a sideways roll. */
    const orient = (yaw: number, pitch: number, roll = 0): void => {
      e.set(pitch, yaw, roll, 'YXZ');
      q.setFromEuler(e);
    };
    const put = (kind: Kind, c: THREE.Color, grounded: boolean, swayAmp: number, groundOffset = 0): void => {
      const b = batches[kind];
      m4.compose(p, q, s);
      for (let i = 0; i < 16; i++) b.mats.push(m4.elements[i]);
      b.cols.push(c.r, c.g, c.b, 1);
      const phase = p.x * 0.13 + p.z * 0.11 + rng.next() * 6.283;
      b.data.push(grounded ? 1 : 0, phase, swayAmp, groundOffset);
    };

    const surfaceTop = (x: number, z: number): { y: number; mat: number; off: number } | null => {
      // ground field height, raised over thin plant cover (moss patches); null under overhangs
      const gy = ground.heightAt(x, z);
      const ix = Math.min(sx - 1, Math.max(0, Math.floor(x)));
      const iz = Math.min(sz - 1, Math.max(0, Math.floor(z)));
      let y = gy;
      let mat = ground.material[ix + iz * sx];
      let iy = Math.floor(gy + 0.5);
      let cover = 0;
      while (iy < sy && world.density[ix + sx * (iz + sz * iy)] >= ISO) {
        const m = world.material[ix + sx * (iz + sz * iy)];
        if (m !== Mat.Plant || ++cover > 3) return null; // rock, log, stem...
        mat = Mat.Plant;
        y = iy + 1;
        iy++;
      }
      if (cover > 0) {
        const d0 = world.density[ix + sx * (iz + sz * (iy - 1))];
        const d1 = iy < sy ? world.density[ix + sx * (iz + sz * iy)] : 0;
        y = iy - 0.5 + Math.min(1, Math.max(0, (d0 - (ISO - 0.5)) / Math.max(1, d0 - d1)));
      }
      // clear air above?
      for (let k = 1; k <= 3; k++) {
        const ay = Math.floor(y + k * 1.2);
        if (ay < sy && world.density[ix + sx * (iz + sz * ay)] >= ISO) return null;
      }
      return { y, mat, off: y - gy };
    };

    const blade = (x: number, y: number, z: number, h: number, w: number, lean: number, yaw: number, c: THREE.Color, off: number, grounded = true): void => {
      p.set(x, y - 0.12, z);
      orient(yaw, lean, (rng.next() - 0.5) * 0.25);
      s.set(w, h, h * (0.7 + rng.next() * 0.9));
      put('blade', c, grounded, h * 0.3, off - 0.12);
      // dew bead somewhere along the upper half of some blades
      if (rng.next() < 0.22) {
        const t = 0.45 + rng.next() * 0.45;
        const arch = 0.38;
        tmp.set(0, (t - 0.18 * arch * t * t) * s.y, arch * t * t * s.z + 0.02).applyQuaternion(q).add(p);
        const r = 0.1 + rng.next() * rng.next() * 0.3;
        m4.compose(tmp, q2.identity(), s.set(r, r * 0.92, r));
        for (let i = 0; i < 16; i++) dew.mats.push(m4.elements[i]);
        dew.data.push(rng.next(), batches.blade.data[batches.blade.data.length - 3], h * 0.3 * t * t, 0.25 + 0.35 * t * h * 0.1);
      }
      // tip positions for the weather module (drips after rain)
      if (h > 3 && tipCount < MAX_TIPS && rng.next() < 0.35) {
        tmp.set(0, (1 - 0.18 * 0.38) * s.y, 0.38 * s.z).applyQuaternion(q).add(p);
        tipData[tipCount * 3] = tmp.x;
        tipData[tipCount * 3 + 1] = tmp.y;
        tipData[tipCount * 3 + 2] = tmp.z;
        tipCount++;
      }
    };
    const grassColor = (dryness: number): THREE.Color => {
      col.copy(srgb(biome.grassA)).lerp(colB.copy(srgb(biome.grassB)), rng.next());
      if (rng.next() < dryness) col.lerp(colB.copy(srgb([0.74, 0.66, 0.36])), 0.5 + 0.5 * rng.next());
      return col.multiplyScalar(0.8 + 0.4 * rng.next());
    };

    // ---- exclusion helpers ----
    const entrances = ctx.map.spawns.filter((sp) => sp.entrance).map((sp) => sp.entrance!);
    const foods = ctx.map.foodSources.map((f) => f.pos);
    const puddles = (env.mapExtras?.sites ?? []).filter((st) => st.kind === 'puddle' || st.kind === 'antlionPit');
    const clearance = (x: number, z: number): number => {
      let k = 1;
      for (const en of entrances) {
        const d = Math.hypot(x - en.x, z - en.z);
        if (d < 6.5) return 0;
        if (d < 17) k = Math.min(k, (d - 6.5) / 10.5);
      }
      for (const f of foods) if (Math.hypot(x - f.x, z - f.z) < 4.5) return 0;
      for (const pd of puddles) if (Math.hypot(x - pd.pos.x, z - pd.pos.z) < pd.radius + 0.5) return 0;
      return k;
    };

    // ---- A1 prop hints ----
    const props: PropDef[] = ctx.map.props;
    for (const pr of props) {
      const r = new SeededRng(pr.seed).fork('a3');
      const rn = (): number => r.next();
      if (pr.kind === 'stem' && pr.climbable) {
        const dx = pr.end.x - pr.pos.x;
        const dy = pr.end.y - pr.pos.y;
        const dz = pr.end.z - pr.pos.z;
        const h = Math.hypot(dx, dy, dz);
        if (dy < 6) continue;
        // rain beads clinging to the stem (they roll down it while it rains)
        if (ctx.quality.preset !== 'low') {
          const nb = 3 + Math.floor(rn() * 4);
          for (let i = 0; i < nb; i++) {
            const t = 0.12 + 0.8 * rn();
            const a = rn() * 6.283;
            const cx = pr.pos.x + dx * t;
            const cy = pr.pos.y + dy * t;
            const cz = pr.pos.z + dz * t;
            // walk out from the axis to the voxel surface
            let rr = -1;
            for (let d = 0.3; d < pr.radius + 2.5; d += 0.15) {
              if (world.sample(cx + Math.sin(a) * d, cy, cz + Math.cos(a) * d) < 0) {
                rr = d;
                break;
              }
            }
            if (rr < 0) continue;
            const r = 0.16 + rn() * rn() * 0.32;
            tmp.set(cx + Math.sin(a) * (rr + r * 0.45), cy, cz + Math.cos(a) * (rr + r * 0.45));
            m4.compose(tmp, q2.identity(), s.set(r, r * 1.08, r));
            for (let k = 0; k < 16; k++) dew.mats.push(m4.elements[k]);
            dew.data.push(0.25 + 0.75 * rn(), 0, 0, 0.8 + 1.6 * rn());
          }
        }
        // basal leaves arching away from the stem, then a couple of sheathing leaves higher up
        const n = 2 + Math.floor(rn() * 3);
        const a0 = rn() * 6.283;
        for (let i = 0; i < n; i++) {
          const basal = i < n;
          const a = a0 + (i / n) * 6.283 + (rn() - 0.5) * 0.9;
          const t = basal ? 0.02 : 0.25 + 0.4 * rn();
          const len = h * (basal ? 0.3 + 0.32 * rn() : 0.22 + 0.2 * rn());
          const rr = pr.radius * (basal ? 1.05 : 0.8);
          const bx = pr.pos.x + dx * t + Math.sin(a) * rr;
          const bz = pr.pos.z + dz * t + Math.cos(a) * rr;
          const by = pr.pos.y + dy * t - (basal ? 0.6 : 0);
          col.copy(srgb(biome.grassA)).lerp(colB.copy(srgb(biome.grassB)), rn()).multiplyScalar(0.85 + 0.3 * rn());
          p.set(bx, by, bz);
          orient(a, basal ? 0.2 + 0.35 * rn() : 0.55 + 0.4 * rn(), (rn() - 0.5) * 0.3);
          s.set(Math.min(3.2, 1.2 + len * 0.09 + rn() * 0.8), len, len * (0.9 + 0.8 * rn()));
          put('blade', col, basal, len * 0.16, basal ? by - ground.heightAt(bx, bz) : 0);
        }
      } else if (pr.kind === 'flower' && pr.climbable) {
        // ray florets around a voxel flower head (dandelion): two tiers
        const R = pr.radius;
        const tiers: [number, number, number, number][] = [
          [Math.round(46 * Math.min(1.4, Math.max(0.5, density))), 0.86, 1.22, 0.75],
          [Math.round(30 * Math.min(1.4, Math.max(0.5, density))), 0.62, 0.95, 0.5],
          [22, 0.42, 0.6, 0.36],
          [14, 0.24, 0.35, 0.3],
          [6, 0.08, 0.15, 0.26],
        ];
        for (const [count, rad, pitch, lenK] of tiers)
          for (let i = 0; i < count; i++) {
            const a = (i / count) * 6.283 + rn() * 0.12;
            const len = R * lenK * (0.8 + 0.4 * rn());
            p.set(pr.pos.x + Math.sin(a) * R * rad, pr.pos.y + 0.9 + (1 - rad) * 2.2, pr.pos.z + Math.cos(a) * R * rad);
            orient(a, pitch + (rn() - 0.5) * 0.25, (rn() - 0.5) * 0.3);
            s.set(len * 0.95, len, len);
            col.copy(srgb([0.99, 0.8 + 0.1 * rn(), 0.08])).multiplyScalar(0.9 + 0.2 * rn());
            put('petal', col, false, len * 0.08);
          }
      } else if (pr.kind === 'grassPatch') {
        const st = surfaceTop(pr.pos.x, pr.pos.z);
        if (!st || clearance(pr.pos.x, pr.pos.z) < 0.6) continue;
        const n = Math.round((7 + pr.radius * 2.5) * Math.min(1.5, density + 0.2));
        for (let i = 0; i < n; i++) {
          const a = rn() * 6.283;
          const d = Math.sqrt(rn()) * pr.radius * 0.8;
          const x = pr.pos.x + Math.sin(a) * d;
          const z = pr.pos.z + Math.cos(a) * d;
          const s2 = surfaceTop(x, z);
          if (!s2) continue;
          const h = biome.grassH[0] + (biome.grassH[1] - biome.grassH[0]) * (0.35 + 0.65 * rn()) * (1 - (d / (pr.radius + 0.1)) * 0.5);
          blade(x, s2.y, z, h, 0.55 + 0.5 * rn(), 0.1 + 0.35 * (d / (pr.radius + 0.1)) + 0.15 * rn(), a + (rn() - 0.5), grassColor(biome.dry), s2.off);
        }
      } else if (pr.kind === 'pebble' && !pr.climbable) {
        const st = surfaceTop(pr.pos.x, pr.pos.z);
        if (!st) continue;
        p.set(pr.pos.x, st.y - 0.05, pr.pos.z);
        orient(rn() * 6.283, (rn() - 0.5) * 0.4, (rn() - 0.5) * 0.4);
        const k = pr.radius * 1.9;
        s.set(k, k * (0.7 + 0.5 * rn()), k * (0.8 + 0.4 * rn()));
        const g = 0.32 + 0.3 * rn();
        put('pebble', col.setRGB(g * 1.05, g, g * 0.92, THREE.SRGBColorSpace), true, 0, st.off);
      } else if (pr.kind === 'leaf' && !pr.climbable) {
        const st = surfaceTop(pr.pos.x, pr.pos.z);
        if (!st) continue;
        p.set(pr.pos.x, st.y + 0.12, pr.pos.z);
        orient(rn() * 6.283, Math.PI / 2 - 0.12 - 0.2 * rn(), (rn() - 0.5) * 0.3);
        const k = pr.radius * 2.4;
        s.set(k, k, k);
        const palette = [
          [0.62, 0.42, 0.14],
          [0.5, 0.24, 0.1],
          [0.72, 0.56, 0.18],
          [0.4, 0.3, 0.14],
        ];
        put('leaf', col.copy(srgb(palette[Math.floor(rn() * palette.length)])).multiplyScalar(0.8 + 0.4 * rn()), true, 0, st.off + 0.12);
      }
    }

    // ---- scatter over the ground ----
    const cell = 2.0 / Math.sqrt(Math.min(1.6, Math.max(0.2, density)));
    const margin = 1.6;
    for (let gz = 0; gz * cell < sz; gz++)
      for (let gx = 0; gx * cell < sx; gx++) {
        const x = (gx + rng.next()) * cell;
        const z = (gz + rng.next()) * cell;
        const r1 = rng.next();
        const r2 = rng.next();
        const r3 = rng.next();
        if (x < margin || z < margin || x > sx - margin || z > sz - margin) continue;
        const clear = clearance(x, z);
        if (clear <= 0) continue;
        const st = surfaceTop(x, z);
        if (!st) continue;
        const slope = Math.max(Math.abs(ground.heightAt(x + 0.8, z) - ground.heightAt(x - 0.8, z)), Math.abs(ground.heightAt(x, z + 0.8) - ground.heightAt(x, z - 0.8)));
        if (slope > 1.9) continue;
        const patch = vnoise(x * 0.045, z * 0.045, seed + 11) * 0.65 + vnoise(x * 0.13, z * 0.13, seed + 12) * 0.35;
        const lush = st.mat === Mat.Plant;
        const m = st.mat;

        // grass
        let gk = 0;
        if (m === Mat.Soil || m === Mat.Mud) gk = Math.min(1, Math.max(0, (patch - 0.42) / 0.2));
        else if (lush) gk = 0.9;
        else if (m === Mat.Sand) gk = Math.min(1, Math.max(0, (patch - 0.6) / 0.2)) * 0.5;
        else if (m === Mat.LeafLitter) gk = 0.2;
        gk *= biome.grass * clear;
        if (r1 < gk) {
          const n = 1 + Math.floor(rng.next() * (lush ? 3 : 3.6));
          const tall = (0.25 + 0.75 * Math.min(1, Math.max(0, (patch - 0.4) / 0.4))) * clear;
          for (let i = 0; i < n; i++) {
            const a = rng.next() * 6.283;
            const d = rng.next() * 0.7;
            const h = (biome.grassH[0] + (biome.grassH[1] - biome.grassH[0]) * rng.next() * rng.next() * tall) * (lush ? 0.55 : 1) * (m === Mat.Sand ? 0.6 : 1);
            blade(x + Math.sin(a) * d, st.y, z + Math.cos(a) * d, h, 0.4 + 0.5 * rng.next() + h * 0.015, 0.05 + 0.4 * rng.next(), a + (rng.next() - 0.5), grassColor(m === Mat.Sand ? 0.8 : biome.dry), st.off);
          }
        }
        // clover carpets on plant cover and in the lusher soil patches
        const ck = biome.clover * clear * (lush ? 0.8 : m === Mat.Soil ? Math.max(0, vnoise(x * 0.08, z * 0.08, seed + 21) - 0.62) * 2.2 : 0);
        if (r2 < ck) {
          p.set(x, st.y - 0.05, z);
          orient(rng.next() * 6.283, (rng.next() - 0.5) * 0.3, (rng.next() - 0.5) * 0.3);
          const h = 1.3 + 2.4 * rng.next();
          const w = 1.6 + 1.4 * rng.next();
          s.set(w, h, w);
          col.copy(srgb([0.22, 0.48, 0.14])).lerp(colB.copy(srgb([0.36, 0.6, 0.2])), rng.next());
          put('clover', col, true, h * 0.12, st.off - 0.05);
        }
        // flowers
        if (r3 < biome.flowers * clear * (lush ? 1.4 : m === Mat.Soil ? (vnoise(x * 0.06, z * 0.06, seed + 31) > 0.55 ? 1 : 0.1) : 0)) {
          p.set(x, st.y - 0.05, z);
          orient(rng.next() * 6.283, (rng.next() - 0.5) * 0.35, (rng.next() - 0.5) * 0.35);
          const h = 2.6 + 4.2 * rng.next();
          const w = 3 + 2.5 * rng.next();
          s.set(w, h, w);
          const pal = [
            [0.98, 0.98, 0.95],
            [0.98, 0.98, 0.95],
            [0.98, 0.85, 0.2],
            [0.72, 0.56, 0.95],
            [0.98, 0.66, 0.78],
          ];
          put('flower', col.copy(srgb(pal[Math.floor(rng.next() * pal.length)])), true, h * 0.2, st.off - 0.05);
        }
        // loose stuff
        const r4 = rng.next();
        const r5 = rng.next();
        if (r4 < biome.pebbles * (m === Mat.Rock || m === Mat.Sand ? 1.6 : lush ? 0.2 : 1)) {
          p.set(x, st.y - 0.04, z);
          orient(rng.next() * 6.283, (rng.next() - 0.5) * 0.5, (rng.next() - 0.5) * 0.5);
          const k = 0.22 + 0.9 * rng.next() * rng.next();
          s.set(k, k * (0.6 + 0.5 * rng.next()), k * (0.7 + 0.5 * rng.next()));
          const g = 0.26 + 0.34 * rng.next();
          put('pebble', col.setRGB(g * (1 + 0.15 * rng.next()), g, g * (0.82 + 0.15 * rng.next()), THREE.SRGBColorSpace), true, 0, st.off - 0.04);
        } else if (r4 > 1 - biome.twigs * clear) {
          p.set(x, st.y + 0.02, z);
          orient(rng.next() * 6.283, (rng.next() - 0.5) * 0.15, (rng.next() - 0.5) * 0.15);
          const k = 2.2 + 4.5 * rng.next();
          s.set(k, k, k);
          const g = 0.2 + 0.2 * rng.next();
          put('twig', col.setRGB(g * 1.3, g, g * 0.7, THREE.SRGBColorSpace), true, 0, st.off + 0.02);
        }
        if (r5 < biome.leaves * (m === Mat.LeafLitter ? 2.5 : 1) * clear) {
          p.set(x, st.y + 0.1, z);
          orient(rng.next() * 6.283, Math.PI / 2 - 0.1 - 0.25 * rng.next(), (rng.next() - 0.5) * 0.4);
          const k = 1.8 + 3.2 * rng.next();
          s.set(k, k, k);
          const pal = [
            [0.62, 0.42, 0.14],
            [0.5, 0.24, 0.1],
            [0.72, 0.56, 0.18],
            [0.38, 0.28, 0.13],
            [0.66, 0.3, 0.1],
          ];
          put('leaf', col.copy(srgb(pal[Math.floor(rng.next() * pal.length)])).multiplyScalar(0.75 + 0.4 * rng.next()), true, 0, st.off + 0.1);
        } else if (r5 > 1 - biome.mushrooms * (m === Mat.LeafLitter || lush ? 2 : 1)) {
          const n = 1 + Math.floor(rng.next() * 3);
          for (let i = 0; i < n; i++) {
            const a = rng.next() * 6.283;
            p.set(x + Math.sin(a) * i * 0.5, st.y - 0.05, z + Math.cos(a) * i * 0.5);
            orient(rng.next() * 6.283, (rng.next() - 0.5) * 0.35, (rng.next() - 0.5) * 0.35);
            const h = 0.7 + 1.3 * rng.next();
            const w = h * (0.8 + 0.7 * rng.next());
            s.set(w, h, w);
            const pal = [
              [0.6, 0.3, 0.14],
              [0.78, 0.62, 0.4],
              [0.7, 0.16, 0.1],
              [0.86, 0.8, 0.66],
            ];
            put('mushroom', col.copy(srgb(pal[Math.floor(rng.next() * pal.length)])), true, 0, st.off - 0.05);
          }
        }
      }

    // ---- meshes ----
    group = new THREE.Group();
    group.name = 'vegetation';
    ctx.scene.add(group);
    const material = createFoliageMaterial(ctx, env, fade, false);
    const depthMaterial = createFoliageMaterial(ctx, env, fade, true);
    disposables.push(material, depthMaterial);
    const geos: Record<Kind, () => THREE.BufferGeometry> = {
      blade: () => grassBladeGeometry(ctx.quality.preset === 'low' ? 4 : 6),
      leaf: () => broadLeafGeometry(),
      clover: () => cloverGeometry(),
      flower: () => flowerGeometry(),
      petal: () => petalGeometry(),
      pebble: () => pebbleGeometry(),
      twig: () => twigGeometry(),
      mushroom: () => mushroomGeometry(),
    };
    for (const kind of Object.keys(batches) as Kind[]) {
      const b = batches[kind];
      const n = b.mats.length / 16;
      if (n === 0) continue;
      const geo = geos[kind]();
      geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(b.cols), 4));
      geo.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(b.data), 4));
      const mesh = new THREE.InstancedMesh(geo, material, n);
      mesh.instanceMatrix.array.set(b.mats);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = `veg-${kind}`;
      mesh.frustumCulled = false;
      mesh.castShadow = ctx.quality.shadows && kind !== 'petal';
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = depthMaterial;
      group.add(mesh);
      disposables.push(geo);
    }
    const nd = dew.mats.length / 16;
    if (nd > 0 && ctx.quality.preset !== 'low') {
      const geo = dewGeometry();
      geo.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(dew.data), 4));
      dewMat = new THREE.ShaderMaterial({
        uniforms: {
          uEnvCube: env.uniforms.uEnvCube,
          uSunDirW: ctx.uniforms.uSunDir,
          uKeyColor: env.uniforms.uKeyColor,
          uCutPlane: ctx.uniforms.uCutPlane,
          uWind: ctx.uniforms.uWind,
          uDew: { value: 0 },
          uRoll: { value: 0 },
          uClock: fx.uClock,
          uRain: waterShared.uRain,
        },
        vertexShader: DEW_VERT,
        fragmentShader: DEW_FRAG,
        toneMapped: false,
      });
      dewMesh = new THREE.InstancedMesh(geo, dewMat, nd);
      dewMesh.instanceMatrix.array.set(dew.mats);
      dewMesh.instanceMatrix.needsUpdate = true;
      dewMesh.name = 'veg-dew';
      dewMesh.frustumCulled = false;
      dewMesh.visible = false;
      group.add(dewMesh);
      disposables.push(geo, dewMat);
    }
    void X;
    vegetationTips.count = tipCount;
  }

  return {
    id: 'vegetation',
    init(ctx) {
      build(ctx);
    },
    update(ctx, frame) {
      if (!group) return;
      const env = getEnv(ctx);
      // fade only in the RTS view, scaled with zoom so the clearing matches the screen centre
      const fd = ctx.view.camera.focusDist;
      const target = ctx.view.mode === 'rts' && !env.debug.macro ? 1 : 0;
      fadeCur = ctx.sync || frame.frozen ? target : fadeCur + (target - fadeCur) * Math.min(1, frame.dt * 5);
      fade.value.set(fadeCur, Math.max(4, fd * 0.24), 2.2);
      if (dewMesh && dewMat) {
        const k = Math.max(env.dew, env.wetness * 0.9);
        dewMat.uniforms.uDew.value = k;
        dewMat.uniforms.uRoll.value = Math.min(1, waterShared.uRain.value.x * 1.6 + env.wetness * 0.45 * (1 - env.dew));
        dewMesh.visible = k > 0.02;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      group?.removeFromParent();
      group = null;
      dewMesh = null;
      dewMat = null;
      vegetationTips.count = 0;
    },
  };
}

export const vegetationModule: Module = createVegetationModule();
