/**
 * Contract extensions owned by stream A3 (PLAN §10.2, D22).
 * Add types here when `core/contracts.ts` lacks something you need to share; report additions.
 * Additive only — never redefine or widen a type from `core/contracts.ts`.
 */

/**
 * Debug / tooling overrides for the environment look. Lives on `globalThis.__myrmeLook`
 * (created lazily by the sky module; any field left `undefined`/`null` means "follow the sim").
 * Used by `tools/shots.mjs --eval "__myrmeLook.timeOfDay = 0.77"`, the debug GUI and photo mode.
 * URL equivalents read once at start-up: `tod`, `wet`, `clouds`.
 */
export interface LookDebug {
  /** 0..1, 0 = midnight, 0.5 = noon (same convention as `WeatherState.timeOfDay`). */
  timeOfDay?: number | null;
  /** 0..1 surface wetness (overrides `WeatherState.wetness`). */
  wetness?: number | null;
  /** 0..1 cloud cover (default derives from `WeatherState.kind`/`intensity`). */
  cloudiness?: number | null;
  /** Multiplies the DoF strength chosen by the policy (0 disables DoF, 1 = policy). */
  dofScale?: number | null;
  /** Multiplies the exposure chosen by the grade preset. */
  exposureScale?: number | null;
  /** Force the macro (possession-style) DoF in any view — photo poses. */
  macro?: boolean | null;
  /** Multiplies render-only vegetation density on the next vegetation rebuild (debug). */
  vegetation?: number | null;
}

/**
 * Extra post-processing parameters beyond the frozen `LookSettings` (driven by the A3 `postlook`
 * module, applied by the Renderer). Plain numbers / rgb triples in linear colour space.
 */
export interface LookExtras {
  /** Depth fog: base density (per world unit) and height falloff (density halves every `fogHeight` units above `fogBase`). */
  fogDensity: number;
  fogHeight: number;
  fogBase: number;
  fogColor: [number, number, number];
  /** Extra in-scatter colour added when looking towards the sun. */
  fogSunColor: [number, number, number];
  /** Colour grade: multiplicative tints for shadows / highlights and a white-balance shift (−1 cool … +1 warm). */
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  temperature: number;
  /** Filmic toe lift 0..0.1 (raises blacks slightly for a hazy macro look). */
  lift: number;
  /** AO: world-space distance beyond which ambient occlusion fades out. */
  aoFade: number;
}
