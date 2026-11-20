/**
 * Contract extensions owned by stream A4 (PLAN §10.2, D22) — creature rendering & FX base.
 * Additive only — never redefine or widen a type from `core/contracts.ts`.
 *
 * Three things are shared from here:
 *  1. the creature geometry registry vocabulary (kinds, LODs, vertex attribute layout),
 *  2. the particle emit API (implemented by `render/modules/particles.ts`, used by B4),
 *  3. optional view/selection fields A4 reads if another stream provides them.
 */
import type { CasteId, ColonyId, CreatureId, EntityId, SpeciesId, Vec3 } from '../contracts';

// =====================================================================================
// 1. Geometry registry
// =====================================================================================

/** 0 = high (possession / macro), 1 = medium, 2 = low (≈150–300 triangles). */
export type GeometryLod = 0 | 1 | 2;

export type AntGeometryKind = `${SpeciesId}:${CasteId}`;
/** First-person rig of an ant (own antennae + mandibles, eye at the origin looking down +Z). LOD is ignored. */
export type FirstPersonGeometryKind = `fp:${SpeciesId}:${CasteId}`;
export type BroodGeometryKind = 'egg' | 'larva' | 'pupa';
export type ItemGeometryKind = 'crumb' | 'seed' | 'leaf' | 'pellet' | 'woodChip' | 'honeydew' | 'fungusTuft' | 'fruit' | 'sugar' | 'corpse';

/**
 * Everything `getCreatureGeometry(kind, lod)` (in `assets/geometry`) can build.
 * Ant kinds are `"<species>:<caste>"`; an unknown caste falls back to that species' worker.
 */
export type CreatureGeometryKind = AntGeometryKind | FirstPersonGeometryKind | CreatureId | BroodGeometryKind | ItemGeometryKind;

/**
 * Vertex attribute `aBody.x` — which anatomical part a vertex belongs to. The shared chitin
 * shader (`render/modules/antsMaterial.ts`) animates and shades per part.
 */
export const BodyPart = {
  head: 0,
  thorax: 1,
  petiole: 2,
  gaster: 3,
  leg: 4,
  antenna: 5,
  mandible: 6,
  eye: 7,
  wing: 8,
  /** Rigid extras that follow the thorax (spines, cornicles, prolegs). */
  other: 9,
  /** Raptorial arm (mantis) — strikes on bite. */
  arm: 10,
} as const;
export type BodyPartId = (typeof BodyPart)[keyof typeof BodyPart];

/**
 * Model-space convention of every creature geometry:
 *   +Z forward, +Y up, body length 1 (instances scale by `CasteDef.length` / `CreatureDef.length`),
 *   origin at the body centre, feet at y = -RIDE_PER_LENGTH.
 *
 * Vertex attributes (besides `position`, `normal`, `color`):
 *   aBody  vec4  (part id, limb index, weight along limb / gaster 0..1, baked ambient occlusion)
 *                limb index for legs = pair*2 + side (pair 0 = front), for antennae/mandibles = side
 *   aPivot vec3  joint the part rotates about (hip, antenna socket, mandible hinge, wing root)
 *
 * Rig constants a material needs are in `geometry.userData.rig` (see `CreatureRig`).
 */
export interface CreatureRig {
  /** Neck joint (head group rotates about it). */
  neck: readonly [number, number, number];
  /** Waist joint (gaster/abdomen rotates about it). */
  waist: readonly [number, number, number];
  /** Number of walking legs (6 ants, 8 spider, 0 crawlers). */
  legs: number;
  /** Body lengths travelled per full gait cycle. */
  stride: number;
  /** Fraction of the cycle a foot is planted. */
  duty: number;
  /** Foot lift height in model units. */
  lift: number;
  /** Peristaltic body wave amplitude (caterpillar / worm / larva), 0 for walkers. */
  crawl: number;
  /** Paint-dot marker positions (z on thorax, z on gaster/abdomen, dot radius, top y). */
  marker: readonly [number, number, number, number];
  /** Where carried things sit (mandible tips) in model units. */
  mouth: readonly [number, number, number];
  /** Triangle count (perf accounting). */
  triangles: number;
}

/** Surface look of a creature kind; consumed by the chitin material. Colours are linear rgb 0..1. */
export interface CreatureLook {
  color: readonly [number, number, number];
  roughness: number;
  clearcoat: number;
  /** 0..1 thin-film iridescence. */
  iridescence: number;
  /** Backlit translucency strength and tint; `translucencyAll` extends it from the gaster to the whole body. */
  translucency: number;
  translucencyColor: readonly [number, number, number];
  translucencyAll: boolean;
  /** 0..1 pale waxy soft-body look (termites, larvae). */
  wax: number;
  /** Fine pubescence sheen 0..1. */
  sheen: number;
  /** Gaster/abdomen segment count for the banding pattern (0 = none). */
  bands: number;
  /** How far the gaster curls under on a bite (stinging species ≈ 1). */
  sting: number;
  /** 1 = shade as a leaf blade (procedural midrib / side veins / reticulation, thin backlit lamina, bruised cut edge). */
  leaf?: number;
}

// =====================================================================================
// 2. Particle emit API (D19 events → FX). Implemented by `render/modules/particles.ts`:
//
//      import { particles } from '../modules/particles';
//      particles.emit('spark', pos, normal, { count: 12, color: [1, 0.8, 0.3] });
//
// One pooled, GPU-instanced, stateless-simulated sprite system (a ring buffer; the oldest
// particles are recycled first). Safe to call from any render module's `update`; calls made
// before the particles module is initialised are dropped. No allocation per emit.
// =====================================================================================

export type ParticleKind =
  /** Soil chunks thrown from a dig site (tumbling, falls with gravity). */
  | 'digDebris'
  /** Soft dust puff, slow, rises slightly. */
  | 'dust'
  /** Tiny dust puff under a foot (close range only). */
  | 'footDust'
  /** Food crumbs. */
  | 'crumb'
  /** Bright additive bite sparks. */
  | 'spark'
  /** Soft glowing pheromone puff (additive, drifts up). */
  | 'pheroPuff'
  /** Slow floating mote (pollen / dust in light). */
  | 'mote'
  /** Liquid droplets (acid / water / glue — set colour), falls with gravity. */
  | 'droplet'
  /** Slow glowing spore, drifts with the wind. */
  | 'spore';

export interface ParticleParams {
  /** Number of particles (default depends on kind). */
  count?: number;
  /** Linear rgb 0..1 tint (default depends on kind). */
  color?: readonly [number, number, number];
  /** Multiplier on the kind's sprite size. */
  size?: number;
  /** Multiplier on the kind's launch speed. */
  speed?: number;
  /** Multiplier on the kind's lifetime. */
  life?: number;
  /** Spawn radius around `pos` in world units. */
  radius?: number;
  /** Cone half-angle factor 0..1 around `normal` (0 = straight along it, 1 = full hemisphere+). */
  spread?: number;
}

export interface ParticlePreset {
  count: number;
  color: readonly [number, number, number];
  /** Sprite size in world units and its random variation 0..1. */
  size: number;
  sizeVar: number;
  /** Launch speed (units/s) and variation 0..1. */
  speed: number;
  speedVar: number;
  life: number;
  lifeVar: number;
  /** Units/s² along −y (negative = buoyant). */
  gravity: number;
  /** Velocity damping per second. */
  drag: number;
  spread: number;
  radius: number;
  /** 0 = alpha-blended, 1 = additive glow. */
  additive: number;
  /** 0 = soft round puff, 1 = hard chunk, 2 = streak along velocity, 3 = twinkle. */
  shape: 0 | 1 | 2 | 3;
  /** Size multiplier at end of life (puffs grow, chunks stay). */
  grow: number;
  /** Peak opacity. */
  opacity: number;
  /** 0..1 how much the particle is lit by the sun colour (dust) vs self-coloured (glow). */
  lit: number;
}

export interface ParticleEmitter {
  /** Emit a burst. `normal` is the surface normal / main direction (need not be unit; null = up). */
  emit(kind: ParticleKind, pos: Readonly<Vec3>, normal?: Readonly<Vec3> | null, params?: ParticleParams): void;
  /** Add or override a kind (B4: rain splash, glue, acid…). Custom names are accepted by `emit`. */
  registerKind(name: string, preset: Partial<ParticlePreset>): void;
  /** Same as `emit` with a custom kind name. */
  emitCustom(name: string, pos: Readonly<Vec3>, normal?: Readonly<Vec3> | null, params?: ParticleParams): void;
  /** Live particle estimate (debug/perf). */
  readonly capacity: number;
}

// =====================================================================================
// 3. Optional presentation fields (nobody is required to provide these)
// =====================================================================================

/**
 * Optional extras the selection/feedback module looks for on the shared `ViewState` object
 * (duck-typed: `(view as ViewState & A4ViewExt)`). A5 may set any of them; all default to
 * sensible behaviour when absent.
 */
export interface A4ViewExt {
  /** Brush radius of the active dig/build paint tool (default 1.5 = MIN_BRUSH_RADIUS). */
  toolRadius?: number;
  /** Beacon kind being placed (ghost preview at `cursorWorld`). */
  beaconPreview?: 'gather' | 'dig' | 'rally' | 'attack' | 'avoid' | null;
  /** Context order the cursor would issue on right-click (colours the hover ring). */
  hoverOrder?: 'move' | 'gather' | 'attack' | 'guard' | 'follow' | null;
}

/**
 * Per-instance highlight values understood by the chitin material (`aInstC.w`):
 * 0 none · (0..1] white hover rim · negative = red hurt flash of that magnitude.
 */
export type HighlightValue = number;

/** Colony display info resolved by the ants module (exported for B4's creature module). */
export interface ColonyTint {
  colony: ColonyId;
  /** True when more than one colony is alive — markers are only painted then. */
  marked: boolean;
  color: readonly [number, number, number];
}

/** Ids A4 modules treat specially each frame (exposed for debugging / B4). */
export interface A4FrameFocus {
  possessedId: EntityId;
  hoverId: EntityId;
}
