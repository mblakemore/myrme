import * as THREE from 'three';
import type {
  CutPlane,
  LookSettings,
  MapGenResult,
  QualityPreset,
  QualitySettings,
  RenderModule,
  SimView,
  UrlParams,
  ViewState,
} from '../core';
import { CUT_ENTITY_MARGIN } from '../world/cut';

/**
 * Render-side shared definitions (orchestrator-owned, like Renderer.ts). Render modules import
 * from here; they never reach into the Renderer.
 */

/** Shared shader uniforms (§5.3). One object per uniform — reference these in materials. */
export interface SharedUniforms {
  uTime: THREE.IUniform<number>;
  /** xy = wind direction × strength in the xz plane, z = gust phase. */
  uWind: THREE.IUniform<THREE.Vector3>;
  uWetness: THREE.IUniform<number>;
  /** Unit vector towards the sun. */
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  /** (n, d): discard fragments with dot(n, worldPos) + d > 0. Disabled = (0,0,0,-1). */
  uCutPlane: THREE.IUniform<THREE.Vector4>;
  /**
   * Entity cut slack (see `applyCutPlane(…, { entity: true })`): x = 1/world.sx, y = 1/world.sz,
   * z = slack distance past the plane (`CUT_ENTITY_MARGIN`), w = 1 when `uCutGround` holds the
   * ground height field (outdoor maps: slack only for entities below ground), 0 = slack everywhere.
   */
  uCutEntity: THREE.IUniform<THREE.Vector4>;
  /** Ground height field (R = top-of-ground y per xz column), set by the environment state. */
  uCutGround: THREE.IUniform<THREE.Texture | null>;
  uPheroVision: THREE.IUniform<number>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector3(0.4, 0.2, 0) },
    uWetness: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uCutPlane: { value: new THREE.Vector4(0, 0, 0, -1) },
    uCutEntity: { value: new THREE.Vector4(1, 1, CUT_ENTITY_MARGIN, 0) },
    uCutGround: { value: null },
    uPheroVision: { value: 0 },
  };
}

/** Writes a CutPlane into the uCutPlane vec4 convention. */
export function cutPlaneToVec4(cut: CutPlane, out: THREE.Vector4): THREE.Vector4 {
  if (!cut.enabled) return out.set(0, 0, 0, -1);
  return out.set(cut.axis === 'x' ? cut.sign : 0, cut.axis === 'y' ? cut.sign : 0, cut.axis === 'z' ? cut.sign : 0, -cut.sign * cut.pos);
}

/** Render layers. Everything is on DEFAULT unless a module has a reason. */
export const LAYERS = {
  DEFAULT: 0,
  /** Rendered in the main pass but excluded from the shadow pass by `castShadow=false` users. */
  FX: 1,
} as const;

/**
 * What every render module receives (§5.3). Mutable members (`look`, `quality`, `stats`) are
 * shared objects: `look` may be written by modules (A3 `postlook`), the rest is read-only for
 * modules.
 */
export interface RenderContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Key light. The Renderer fits its shadow camera every frame; modules set colour/intensity. */
  readonly sun: THREE.DirectionalLight;
  /** Sun disc mesh used as the god-ray source (modules may restyle it). */
  readonly sunMesh: THREE.Mesh;
  readonly uniforms: SharedUniforms;
  readonly look: LookSettings;
  readonly quality: QualitySettings;
  readonly sim: SimView;
  readonly view: ViewState;
  readonly map: MapGenResult;
  readonly params: UrlParams;
  /**
   * True during blocking renders (initial load, debug `step`/`renderNow`, screenshots): modules
   * must finish all deferred work this frame (e.g. the terrain ignores its remesh budget).
   */
  sync: boolean;
  /** Module-reported counters surfaced in RenderStats. */
  readonly stats: { pendingChunks: number };
}

export interface Module extends RenderModule<RenderContext> {
  /**
   * Optional shader pre-warm hook (Renderer, once, behind the loading screen): create / show
   * whatever is normally built on first use; return a cleanup that hides it again.
   */
  prewarm?(ctx: RenderContext): (() => void) | void;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualitySettings> = {
  low: {
    preset: 'low',
    maxPixelRatio: 1,
    minResolutionScale: 0.6,
    dynamicResolution: true,
    shadows: false,
    shadowMapSize: 1024,
    ssao: false,
    bloom: false,
    dof: false,
    godRays: false,
    smaa: false,
    lens: false,
    remeshBudgetMs: 4,
    decoration: 0.25,
    antLodCount: 300,
  },
  medium: {
    preset: 'medium',
    maxPixelRatio: 1.25,
    minResolutionScale: 0.7,
    dynamicResolution: true,
    shadows: true,
    shadowMapSize: 2048,
    ssao: false,
    bloom: true,
    dof: false,
    godRays: false,
    smaa: true,
    lens: true,
    remeshBudgetMs: 4,
    decoration: 0.6,
    antLodCount: 600,
  },
  high: {
    preset: 'high',
    maxPixelRatio: 1.5,
    minResolutionScale: 0.75,
    dynamicResolution: true,
    shadows: true,
    shadowMapSize: 2048,
    ssao: true,
    bloom: true,
    dof: true,
    godRays: true,
    smaa: true,
    lens: true,
    remeshBudgetMs: 4,
    decoration: 1,
    antLodCount: 1000,
  },
  ultra: {
    preset: 'ultra',
    maxPixelRatio: 2,
    minResolutionScale: 1,
    dynamicResolution: false,
    shadows: true,
    shadowMapSize: 4096,
    ssao: true,
    bloom: true,
    dof: true,
    godRays: true,
    smaa: true,
    lens: true,
    remeshBudgetMs: 6,
    decoration: 1.5,
    antLodCount: 2000,
  },
};

/** Conservative default look; A3 tunes through the `postlook` module. */
export function createDefaultLook(): LookSettings {
  return {
    exposure: 1.0,
    ssao: { intensity: 1.6, radius: 0.06, bias: 0.03 },
    bloom: { intensity: 0.35, threshold: 0.85, smoothing: 0.2, radius: 0.7 },
    dof: { strength: 0, autoFocus: true, focusDistance: 10, focusRange: 6, bokehScale: 2.0 },
    godRays: { intensity: 0.35, decay: 0.92, density: 0.9, weight: 0.3 },
    grade: { saturation: 0.08, contrast: 0.06, brightness: 0.0, hue: 0 },
    vignette: { offset: 0.35, darkness: 0.45 },
    chromaticAberration: 0.0004,
    grain: 0.035,
  };
}

/**
 * Adds `uCutPlane` discard (D9) to any built-in three material (works with instancing).
 * Call once per material before first use. Chains with an existing onBeforeCompile.
 *
 * `entity: true` (creatures, brood, items): the cutaway slices a tunnel or chamber roughly in
 * half, and whatever lives in the removed half must stay visible or the nest looks empty. Such
 * instances are kept whole up to `CUT_ENTITY_MARGIN` past the plane when they are below ground
 * (instance origin under the ground height field); on the open surface they are still cut at the
 * plane, so nothing floats over the removed terrain. Mirrors `cutEntityHidden` in `world/cut.ts`.
 */
export function applyCutPlane(material: THREE.Material, uniforms: SharedUniforms, opts: { entity?: boolean } = {}): void {
  const entity = opts.entity === true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.uniforms.uCutPlane = uniforms.uCutPlane;
    if (entity) {
      shader.uniforms.uCutEntity = uniforms.uCutEntity;
      shader.uniforms.uCutGround = uniforms.uCutGround;
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCutWorld;${entity ? '\nvarying float vCutSlack;\nuniform vec4 uCutEntity;\nuniform sampler2D uCutGround;' : ''}`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 cutWp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            cutWp = instanceMatrix * cutWp;
          #endif
          vCutWorld = (modelMatrix * cutWp).xyz;
          ${
            entity
              ? `vec4 cutO = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_INSTANCING
            cutO = instanceMatrix * cutO;
          #endif
          cutO = modelMatrix * cutO;
          float cutUnder = 1.0;
          if (uCutEntity.w > 0.5) cutUnder = step(1.0, textureLod(uCutGround, cutO.xz * uCutEntity.xy, 0.0).r - cutO.y);
          vCutSlack = uCutEntity.z * cutUnder;`
              : ''
          }
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec4 uCutPlane;\nvarying vec3 vCutWorld;${entity ? '\nvarying float vCutSlack;' : ''}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\nif (dot(uCutPlane.xyz, vCutWorld) + uCutPlane.w > ${entity ? 'vCutSlack * dot(uCutPlane.xyz, uCutPlane.xyz)' : '0.0'}) discard;`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => key() + (entity ? '|cutE' : '|cut');
}
