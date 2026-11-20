import * as THREE from 'three';
import { ISO, Mat, getMapExtras, type FrameInfo, type LookDebug, type LookExtras, type MapExtras, type VoxelWorld } from '../../core';
import type { RenderContext } from '../shared';

/**
 * A3 shared environment state: one object per RenderContext holding everything the environment
 * modules (sky, lighting, terrain, vegetation, habitat, cutawayLight, postlook) and the Renderer's
 * effect chain agree on — time of day, sun/moon, sky and fog colours, the reflection cube, the
 * ground height field and the `LookExtras` post parameters.
 *
 * The sky module (first in the registry) calls `updateEnv` once per frame; everyone else reads.
 */
export interface EnvState {
  /** Farm maps: the backdrop is a room, there is no sun path. */
  room: boolean;
  timeOfDay: number;
  /** Unit vectors towards the true sun and the moon. */
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** Direction of the active key light (sun by day, moon by night, fixed lamp/window in a room). */
  keyDir: THREE.Vector3;
  keyColor: THREE.Color;
  keyIntensity: number;
  /** 0..1 factors. */
  day: number;
  night: number;
  /** 0..1 exposure-side night term: ramps in as soon as the sun is down (no dusk/dawn dip). */
  lowLight: number;
  golden: number;
  /** Morning dew factor (dawn only). */
  dew: number;
  cloudiness: number;
  wetness: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  /** Horizon colour towards the sun azimuth (sunset glow). */
  horizonSun: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  ambient: number;
  fogColor: THREE.Color;
  /** Reflection cube (plain cube map with mips) for custom shaders; `scene.environment` gets the PMREM. */
  envCube: THREE.Texture | null;
  /** Bumped whenever the reflection cube / PMREM is regenerated. */
  envVersion: number;
  /** Shared uniform objects for A3 shaders. */
  uniforms: {
    uEnvCube: THREE.IUniform<THREE.Texture | null>;
    uDay: THREE.IUniform<number>;
    uNight: THREE.IUniform<number>;
    uKeyColor: THREE.IUniform<THREE.Color>;
    uAmbientColor: THREE.IUniform<THREE.Color>;
    uGroundTex: THREE.IUniform<THREE.Texture | null>;
    uWorldSize: THREE.IUniform<THREE.Vector3>;
    /** Camera focus point (RTS: point of interest; possession: the ant). */
    uFocus: THREE.IUniform<THREE.Vector3>;
  };
  extras: LookExtras;
  debug: LookDebug;
  ground: GroundField;
  mapExtras: MapExtras | null;
}

/** Top of the ground (plants, wood and fungus excluded) per xz column, as a CPU field + texture. */
export interface GroundField {
  sx: number;
  sz: number;
  heights: Float32Array;
  /** Material id of the top ground cell. */
  material: Uint8Array;
  tex: THREE.DataTexture;
  /** Bilinear ground height at a world xz position. */
  heightAt(x: number, z: number): number;
  /** Recompute columns in [x0,x1]×[z0,z1] (cell indices, clamped). */
  refresh(world: VoxelWorld, x0: number, z0: number, x1: number, z1: number): void;
}

const GROUND_MATS: boolean[] = [];
for (const m of [Mat.Soil, Mat.Sand, Mat.Clay, Mat.Rock, Mat.Gel, Mat.LeafLitter, Mat.Mud]) GROUND_MATS[m] = true;

function createGroundField(world: VoxelWorld): GroundField {
  const { sx, sz, sy } = world;
  const heights = new Float32Array(sx * sz);
  const material = new Uint8Array(sx * sz);
  const half = new Uint16Array(sx * sz);
  const tex = new THREE.DataTexture(half, sx, sz, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  const field: GroundField = {
    sx,
    sz,
    heights,
    material,
    tex,
    heightAt(x, z) {
      const fx = Math.min(sx - 1, Math.max(0, x - 0.5));
      const fz = Math.min(sz - 1, Math.max(0, z - 0.5));
      const x0 = Math.floor(fx);
      const z0 = Math.floor(fz);
      const x1 = Math.min(sx - 1, x0 + 1);
      const z1 = Math.min(sz - 1, z0 + 1);
      const tx = fx - x0;
      const tz = fz - z0;
      const a = heights[x0 + z0 * sx];
      const b = heights[x1 + z0 * sx];
      const c = heights[x0 + z1 * sx];
      const d = heights[x1 + z1 * sx];
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    },
    refresh(w, x0, z0, x1, z1) {
      x0 = Math.max(0, x0);
      z0 = Math.max(0, z0);
      x1 = Math.min(sx - 1, x1);
      z1 = Math.min(sz - 1, z1);
      const dens = w.density;
      const mats = w.material;
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          let h = 0;
          let m = 0;
          const col = x + sx * z;
          for (let y = sy - 1; y >= 0; y--) {
            const i = col + sx * sz * y;
            const d = dens[i];
            if (d >= ISO && GROUND_MATS[mats[i]]) {
              const above = y + 1 < sy ? dens[i + sx * sz] : 0;
              const dAir = above >= ISO ? 255 - d : above; // plant sitting on the ground: mirror
              const t = d === dAir ? 0.5 : Math.min(1, Math.max(0, (d - (ISO - 0.5)) / (d - dAir)));
              h = y + 0.5 + t;
              m = mats[i];
              break;
            }
          }
          heights[x + z * sx] = h;
          material[x + z * sx] = m;
          half[x + z * sx] = THREE.DataUtils.toHalfFloat(h);
        }
      tex.needsUpdate = true;
    },
  };
  field.refresh(world, 0, 0, sx - 1, sz - 1);
  return field;
}

const states = new WeakMap<RenderContext, EnvState>();

function readDebug(): LookDebug {
  const g = globalThis as { __myrmeLook?: LookDebug; location?: { search?: string } };
  if (!g.__myrmeLook) {
    const d: LookDebug = {};
    try {
      const q = new URLSearchParams(g.location?.search ?? '');
      const num = (k: string): number | null => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
      d.timeOfDay = num('tod');
      d.wetness = num('wet');
      d.cloudiness = num('clouds');
    } catch {
      /* no URL (tests) */
    }
    g.__myrmeLook = d;
  }
  return g.__myrmeLook;
}

export function defaultLookExtras(): LookExtras {
  return {
    fogDensity: 0,
    fogHeight: 30,
    fogBase: 0,
    fogColor: [0.7, 0.8, 0.9],
    fogSunColor: [0, 0, 0],
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    temperature: 0,
    lift: 0,
    aoFade: 160,
  };
}

/** The A3 environment state of a render context (created on first use). */
export function getEnv(ctx: RenderContext): EnvState {
  let s = states.get(ctx);
  if (s) return s;
  const env = ctx.map.environment;
  const world = ctx.sim.world;
  const ground = createGroundField(world);
  s = {
    room: env.backdrop === 'room',
    timeOfDay: -1,
    sunDir: new THREE.Vector3(env.sunDir.x, env.sunDir.y, env.sunDir.z).normalize(),
    moonDir: new THREE.Vector3(-0.3, 0.6, -0.4).normalize(),
    keyDir: new THREE.Vector3(env.sunDir.x, env.sunDir.y, env.sunDir.z).normalize(),
    keyColor: new THREE.Color(...env.sunColor),
    keyIntensity: env.sunIntensity,
    day: 1,
    night: 0,
    lowLight: 0,
    golden: 0,
    dew: 0,
    cloudiness: 0.3,
    wetness: 0,
    zenith: new THREE.Color(...env.skyTop),
    horizon: new THREE.Color(...env.skyHorizon),
    horizonSun: new THREE.Color(...env.skyHorizon),
    hemiSky: new THREE.Color(...env.skyHorizon),
    hemiGround: new THREE.Color(...env.groundColor),
    ambient: env.ambientIntensity,
    fogColor: new THREE.Color(...env.fogColor),
    envCube: null,
    envVersion: 0,
    uniforms: {
      uEnvCube: { value: null },
      uDay: { value: 1 },
      uNight: { value: 0 },
      uKeyColor: { value: new THREE.Color(1, 1, 1) },
      uAmbientColor: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uGroundTex: { value: ground.tex },
      uWorldSize: { value: new THREE.Vector3(world.sx, world.sy, world.sz) },
      uFocus: { value: new THREE.Vector3() },
    },
    extras: defaultLookExtras(),
    debug: readDebug(),
    ground,
    mapExtras: getMapExtras(ctx.map),
  };
  states.set(ctx, s);
  // entity cutaway slack (render/shared `applyCutPlane`): underground test against the height field
  ctx.uniforms.uCutGround.value = ground.tex;
  ctx.uniforms.uCutEntity.value.set(1 / world.sx, 1 / world.sz, ctx.uniforms.uCutEntity.value.z, s.room || ctx.map.boundary === 'glass' || ctx.map.flags.slab ? 0 : 1);
  updateEnv(ctx, null);
  return s;
}

export function disposeEnv(ctx: RenderContext): void {
  const s = states.get(ctx);
  if (!s) return;
  s.ground.tex.dispose();
  states.delete(ctx);
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const NIGHT_ZENITH = new THREE.Color(0.004, 0.009, 0.028);
const NIGHT_HORIZON = new THREE.Color(0.012, 0.022, 0.05);
const GOLD_ZENITH = new THREE.Color(0.1, 0.17, 0.4);
const GOLD_HORIZON = new THREE.Color(0.62, 0.42, 0.34);
const GOLD_SUNSIDE = new THREE.Color(1.25, 0.5, 0.13);
const SUNSET_KEY = new THREE.Color(1.0, 0.4, 0.13);
const MOON_KEY = new THREE.Color(0.5, 0.64, 1.0);
const GREY = new THREE.Color(0.55, 0.58, 0.62);
const _a = new THREE.Color();
const _b = new THREE.Color();
const _east = new THREE.Vector3();
const _noon = new THREE.Vector3();

/** Recomputes the time-of-day dependent state. Called by the sky module every frame. */
export function updateEnv(ctx: RenderContext, _frame: FrameInfo | null): void {
  const s = states.get(ctx);
  if (!s) return;
  const env = ctx.map.environment;
  const weather = ctx.sim.weather;
  const dbg = s.debug;
  const tod = (((dbg.timeOfDay ?? (ctx.map.flags.dayNight || !s.room ? weather.timeOfDay : 0.45)) % 1) + 1) % 1;
  const wk = weather.kind;
  const cloudTarget = dbg.cloudiness ?? (wk === 'storm' ? 0.95 : wk === 'rain' ? 0.8 : wk === 'cloudy' ? 0.45 + 0.35 * weather.intensity : wk === 'heat' ? 0.05 : 0.28);
  s.cloudiness = cloudTarget;
  s.wetness = Math.min(1, Math.max(0, dbg.wetness ?? weather.wetness));
  s.uniforms.uFocus.value.set(ctx.view.camera.focus.x, ctx.view.camera.focus.y, ctx.view.camera.focus.z);
  if (tod === s.timeOfDay && _frame !== null) {
    // cheap path: only weather-driven scalars above can change between frames
    return;
  }
  s.timeOfDay = tod;
  _noon.set(env.sunDir.x, env.sunDir.y, env.sunDir.z).normalize();

  if (s.room) {
    // Room: the "sun" is the window / desk-lamp key light and stays put. Time of day only blends
    // between a daylight room and a lamp-lit evening.
    const day = smoothstep(0.2, 0.3, tod) * (1 - smoothstep(0.72, 0.82, tod));
    s.day = day;
    s.night = 1 - day;
    s.lowLight = s.night;
    s.golden = 0;
    s.dew = 0;
    s.sunDir.copy(_noon);
    s.keyDir.copy(_noon);
    s.keyColor.setRGB(env.sunColor[0], env.sunColor[1], env.sunColor[2]).lerp(_a.setRGB(1.0, 0.62, 0.32), 1 - day);
    s.keyIntensity = env.sunIntensity * (0.3 + 0.7 * day);
    s.zenith.setRGB(env.skyTop[0], env.skyTop[1], env.skyTop[2]);
    s.horizon.setRGB(env.skyHorizon[0], env.skyHorizon[1], env.skyHorizon[2]);
    s.horizonSun.copy(s.horizon);
    s.hemiSky.setRGB(0.62, 0.6, 0.58).lerp(_a.setRGB(0.36, 0.24, 0.16), 1 - day);
    s.hemiGround.setRGB(0.2, 0.16, 0.13).lerp(_a.setRGB(0.05, 0.08, 0.14), 1 - day);
    s.ambient = env.ambientIntensity * (0.3 + 0.7 * day);
    s.fogColor.setRGB(env.fogColor[0], env.fogColor[1], env.fogColor[2]);
  } else {
    // Great circle through east → noon direction (map sunDir) → west.
    _east.set(_noon.z, 0, -_noon.x);
    if (_east.lengthSq() < 1e-6) _east.set(1, 0, 0);
    _east.normalize();
    const th = (tod - 0.25) * Math.PI * 2;
    s.sunDir.copy(_east).multiplyScalar(Math.cos(th)).addScaledVector(_noon, Math.sin(th)).normalize();
    s.moonDir.copy(s.sunDir).multiplyScalar(-1).addScaledVector(_east, 0.35).add(_a2.set(0, 0.3, 0)).normalize();
    const e = s.sunDir.y;
    const day = smoothstep(-0.1, 0.12, e);
    const night = 1 - smoothstep(-0.3, -0.05, e);
    const golden = smoothstep(-0.14, 0.02, e) * (1 - smoothstep(0.1, 0.45, e));
    const c = s.cloudiness;
    s.day = day;
    s.night = night;
    // the handover: sun key fades out by e = -0.03, the moon key rises from the horizon (grazing,
    // little light on the ground) and the slow `night` grade lags — exposure follows this instead
    s.lowLight = 1 - smoothstep(-0.13, 0.03, e);
    s.golden = golden;
    s.dew = golden * (tod < 0.5 ? 1 : 0) * smoothstep(-0.05, 0.05, e);

    if (e > -0.03) {
      s.keyDir.copy(s.sunDir);
      // keep the key light from going perfectly horizontal (endless shadows)
      if (s.keyDir.y < 0.07) {
        s.keyDir.y = 0.07;
        s.keyDir.normalize();
      }
      s.keyColor.copy(SUNSET_KEY).lerp(_a.setRGB(env.sunColor[0], env.sunColor[1], env.sunColor[2]), smoothstep(0.02, 0.4, e));
      s.keyIntensity = env.sunIntensity * smoothstep(-0.03, 0.14, e) * (1 - 0.75 * smoothstep(0.55, 0.95, c));
    } else {
      s.keyDir.copy(s.moonDir);
      // a moon just over the horizon lights nothing: hold the key well up during the handover
      if (s.keyDir.y < 0.42) {
        s.keyDir.y = 0.42;
        s.keyDir.normalize();
      }
      s.keyColor.copy(MOON_KEY);
      // a real moonlit key (integration item c): silhouettes and shadows read without cranking exposure
      s.keyIntensity = 1.3 * smoothstep(-0.03, -0.09, e) * (1 - 0.6 * c);
    }

    const dayZ = _a.setRGB(env.skyTop[0], env.skyTop[1], env.skyTop[2]).lerp(GOLD_ZENITH, golden);
    s.zenith.copy(NIGHT_ZENITH).lerp(dayZ, day);
    const dayH = _a.setRGB(env.skyHorizon[0], env.skyHorizon[1], env.skyHorizon[2]).lerp(GOLD_HORIZON, golden);
    s.horizon.copy(NIGHT_HORIZON).lerp(dayH, day);
    const glow = smoothstep(-0.22, 0.0, e);
    s.horizonSun.copy(s.horizon).lerp(GOLD_SUNSIDE, golden * glow);
    // overcast: desaturate towards grey, scaled by the daylight level
    const lum = 0.08 + 0.92 * day;
    _b.copy(GREY).multiplyScalar(lum);
    s.zenith.lerp(_b, c * c * 0.85);
    s.horizon.lerp(_b.multiplyScalar(1.2), c * c * 0.7);

    s.hemiSky.copy(s.zenith).lerp(s.horizon, 0.55);
    s.hemiSky.lerp(s.horizonSun, 0.18 * golden);
    // night: lift the ambient a little towards moonlit blue so the world stays readable
    // (`nightL` — the lighting's night term — ramps in as soon as the sun is down: with the slower
    // `night` the blue hour was a black hole, darker than midnight, until the moon key caught up)
    const nightL = 1 - smoothstep(-0.14, 0.0, e);
    s.hemiSky.lerp(_a.setRGB(0.1, 0.16, 0.32), nightL * 0.85);
    s.hemiGround.setRGB(env.groundColor[0], env.groundColor[1], env.groundColor[2]).multiplyScalar(0.12 + 0.88 * day);
    s.hemiGround.lerp(_a.setRGB(0.035, 0.05, 0.09), nightL * 0.8);
    s.hemiGround.lerp(_a.setRGB(0.3, 0.16, 0.08), 0.35 * golden);
    // twilight: neither key is up (sun gone, moon not yet in) — carry the scene on a violet sky fill
    const tw = smoothstep(-0.34, -0.08, e) * (1 - smoothstep(-0.05, 0.1, e));
    s.hemiSky.lerp(_a.setRGB(0.26, 0.24, 0.42), tw * 0.6);
    s.hemiGround.lerp(_a.setRGB(0.1, 0.08, 0.12), tw * 0.5);
    s.ambient = env.ambientIntensity * (0.5 + 0.5 * day) * (1 + 1.1 * nightL + 0.5 * golden + 2.4 * tw);
    s.fogColor.copy(s.horizon).lerp(s.zenith, 0.25);
  }
  s.uniforms.uDay.value = s.day;
  s.uniforms.uNight.value = s.night;
  s.uniforms.uKeyColor.value.copy(s.keyColor).multiplyScalar(s.keyIntensity);
  s.uniforms.uAmbientColor.value.copy(s.hemiSky).multiplyScalar(s.ambient);
}

const _a2 = new THREE.Vector3();
