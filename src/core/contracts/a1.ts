/**
 * Contract extensions owned by stream A1 (PLAN §10.2, D22).
 * Add types here when `core/contracts.ts` lacks something you need to share; report additions.
 * Additive only — never redefine or widen a type from `core/contracts.ts`.
 */
import type { ChamberKind, MapGenOptions, MapGenResult, MaterialId, Vec3 } from '../contracts';

/** World size preset. `MapGenOptions.small === true` is the same as `size: 'small'`. */
export type MapSizePreset = 'small' | 'medium' | 'large';

/** Generator options understood by every A1 generator (a superset of `MapGenOptions`). */
export interface MapGenOptionsA1 extends MapGenOptions {
  size?: MapSizePreset;
}

export type Rgb = readonly [number, number, number];

/**
 * One horizontal colour band of a slab map (Sand Farm strata, Gel Farm nutrient layers).
 * The voxel materials already follow the bands; `tint` is the linear-RGB colour the renderer
 * should use instead of the material's default colour inside the band.
 * Band limits at column x are `y0 + wave(x) .. y1 + wave(x)` with
 * `wave(x) = waveAmp * sin(x * waveFreq + wavePhase)` (the wave belongs to the band's TOP edge
 * and the next band's bottom edge shares it, so bands tile without gaps).
 */
export interface StrataBand {
  y0: number;
  y1: number;
  material: MaterialId;
  tint: Rgb;
  waveAmp: number;
  waveFreq: number;
  wavePhase: number;
}

export type MapSiteKind =
  /** Basin that holds water after rain / keeper dropper. `level` = suggested water surface y. */
  | 'puddle'
  /** Conical sand pit; an `antlion` creature spawn sits at the bottom. */
  | 'antlionPit'
  /** Sheltered hollow / overhang where a hunter (spider, beetle) lives. */
  | 'lair'
  /** Climbable stem with a honeydew spot: aphid herds go here. `end` = stem tip. */
  | 'aphidStem'
  /** High climbable point (fungus summit climb, alate take-off). */
  | 'summit'
  /** Termite forage: a mass of Wood / LeafLitter voxels. */
  | 'deadwood'
  /** Farm: where keeper food drops land (top surface). */
  | 'dropZone'
  /** Formicarium: water-tower chamber (humidity source). `end` = top of the column. */
  | 'waterTower'
  /** Formicarium: feeding dish in the outworld. */
  | 'feedingDish'
  /** Formicarium: the outworld tray volume. `pos` = min corner, `end` = max corner. */
  | 'outworld'
  /** Farm: port in the frame where a neighbouring-farm tube attaches (rival invasion). */
  | 'tubePort'
  /** Gel farm: sealed air bubble. */
  | 'bubble';

/** Named point of interest for sim systems (B1/B2/B3) and render modules. */
export interface MapSite {
  kind: MapSiteKind;
  pos: Vec3;
  radius: number;
  /** Second point for elongated / box-like sites; equals `pos` otherwise. */
  end: Vec3;
  /** Water level (puddle, waterTower); 0 when not applicable. */
  level: number;
}

/** A chamber the generator pre-carved. `pos` is the centre, `radii` the ellipsoid semi-axes. */
export interface MapChamber {
  kind: ChamberKind;
  owner: 'colony' | 'rival' | 'neutral';
  pos: Vec3;
  radii: Vec3;
}

/** A pre-carved tunnel / tube segment. */
export interface MapTunnel {
  a: Vec3;
  b: Vec3;
  radius: number;
}

/** Everything A1 generators report beyond `MapGenResult`. Read with `getMapExtras(result)`. */
export interface MapExtras {
  size: MapSizePreset;
  /** Per-map recolouring of materials (index = MaterialId): e.g. plaster-white Clay in the formicarium. */
  materialTints: Partial<Record<MaterialId, Rgb>>;
  /** Bottom-to-top colour bands on slab maps ([] elsewhere). */
  strata: StrataBand[];
  sites: MapSite[];
  chambers: MapChamber[];
  tunnels: MapTunnel[];
  /**
   * Slab maps: thickness (voxels, along `flags.slabAxis`) of the diggable layer behind the FRONT
   * pane (the pane at max z). Equals `world.sz` for gel/sand farms; the formicarium has an
   * undiggable back wall behind it. 0 on outdoor maps.
   */
  slabThickness: number;
  /** Nominal ground level (outdoor) / top of the fill (farms), for cameras and spawners. */
  surfaceY: number;
  /** Solid cell count at generation time (denominator for `excavate` goals). */
  solidCells: number;
}

export interface MapGenResultA1 extends MapGenResult {
  extras: MapExtras;
}

/** Extras of a map result, or null for results not produced by an A1 generator. */
export function getMapExtras(result: MapGenResult): MapExtras | null {
  return (result as Partial<MapGenResultA1>).extras ?? null;
}
