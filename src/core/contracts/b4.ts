/**
 * Contract extensions owned by stream B4 (PLAN §10.2, D22) — VFX, creature rendering, polish.
 * Additive only — never redefine or widen a type from `core/contracts.ts`.
 *
 * Everything here is render-side presentation vocabulary; nothing in `sim/` depends on it.
 */
import type { MeshOptions } from '../contracts';

/**
 * Mesher option added by B4 (`world/mesher.ts#meshChunk` accepts it through `MeshOptions`):
 * with `cut` set, `shell` > 0 meshes ONLY the slab of cells up to `shell` units past the cutaway
 * plane — the "slack zone" in which underground entities stay visible (`CUT_ENTITY_MARGIN` in
 * `world/cut.ts`). The terrain module keeps its up-facing triangles as a ghosted floor apron so
 * ants standing in the removed half of a chamber have visible ground under their feet.
 */
export interface MeshOptionsB4 extends MeshOptions {
  shell?: number;
}

/**
 * Screen-space feedback channel shared by the FX modules (`render/modules/fxShared.ts#fx`).
 * FX modules write, `postlook` + the Renderer's `FxScreenEffect` consume once per frame.
 *
 * Pulses (`kick`, `hurt`, `desat`) are raised through `fxKick/fxHurt/fxDesat` and decay centrally.
 * Levels (`flash` … `exposure`) are owned by one module each, which rewrites them every frame.
 */
export interface FxScreenState {
  /** Bite / impact camera kick 0..1 and its screen direction (possession feedback). */
  kick: number;
  kickX: number;
  kickY: number;
  /** Damage-taken vignette pulse 0..1. */
  hurt: number;
  /** Desaturation pulse 0..1 (queen death / lose). */
  desat: number;
  /** Lightning flash 0..1 (weatherFx). Brightens sky, key light and exposure. */
  flash: number;
  /** Heat-shimmer distortion 0..1 over hot ground (weatherFx) and the ground height it hugs. */
  shimmer: number;
  shimmerY: number;
  /** Extra depth-fog factor ≥ 0 (weatherFx: rain haze, fog banks): density ×(1 + fog). */
  fog: number;
  /** Storm / overcast light loss 0..1 (weatherFx): dims key light and exposure. */
  dim: number;
  /** Keeper lamp warmth 0..1 (keeperFx): warms the grade. */
  warm: number;
  /** Additive bloom intensity (spore glow at night, nuptial sun shafts). */
  bloom: number;
  /** Exposure multiplier (keeperFx: lid open / room day-night). 1 = neutral. */
  exposure: number;
}

/**
 * Preview / tooling switches for the FX modules, on `globalThis.__myrmeFx` (created lazily by
 * `fxShared`). URL equivalent read once at start-up: `?fxdemo=rain,hand` → `demo`.
 * Each FX module documents the demo names it understands in its file header; a demo fabricates
 * render-side state only (never touches the sim), so every effect can be shot before / without
 * the sim stream that drives it.
 */
export interface FxDebug {
  /** Comma-separated demo names, e.g. `"rain,lightning"`. */
  demo?: string | null;
  /** Free-form numeric knobs for demos (documented per module). */
  [key: string]: unknown;
}

/**
 * Creature animation channels the creatures module derives per instance (documented here so B1
 * can see what `Creature.state` / `mem` values the render side reads — see the header of
 * `render/modules/creatures.ts` for the exact mapping).
 */
export interface CreaturePose {
  /** 0..1 crouch (spider before a pounce) / buried amount (antlion in its pit). */
  crouch: number;
  /** 0..1 strike / lunge envelope after an `attack` event by this creature. */
  strike: number;
  /** Head yaw towards the target, radians (mantis head tracking). */
  headYaw: number;
  /** 0..1 thrash (caterpillar / worm under attack), 0..1 stunned / glued. */
  thrash: number;
}
