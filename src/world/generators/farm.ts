import { type FoodSpawn, type MapSizePreset, type MaterialId, type Rgb, type Rng, type SpawnPoint, type StrataBand, type Vec3, type VoxelWorld } from '../../core';
import { Reach, settleFood, type SdfCanvas, type Shape } from './shared';

/** D7: interior thickness of farm slabs, in voxels. Tunnels (radius ≥ 2) span it pane to pane. */
export const FARM_THICKNESS = 4;
/** Dig radius used for starter tunnels on farm maps (touches both panes). */
export const FARM_TUNNEL_RADIUS = 2.2;

/** Slab width per size preset (height is always FARM_HEIGHT). */
export const FARM_WIDTH: Record<MapSizePreset, number> = { small: 64, medium: 112, large: 144 };
export const FARM_HEIGHT = 64;

/** A disc in the x-y plane extruded through the whole slab (pebbles, bubbles: 2.5D features). */
export function discZ(cx: number, cy: number, r: number, sz: number): Shape {
  return {
    box: { x0: cx - r - 2, x1: cx + r + 2, y0: cy - r - 2, y1: cy + r + 2, z0: 0, z1: sz },
    d: (x, y) => r - Math.hypot(x - cx, y - cy),
  };
}

export interface BandSpec {
  thickness: number;
  material: MaterialId;
  tint: Rgb;
}

/** Stack band specs bottom-to-top into wavy strata. The last band is open-ended upwards. */
export function stackBands(specs: BandSpec[], rng: Rng, maxAmp = 1.8): StrataBand[] {
  const bands: StrataBand[] = [];
  let y = 0;
  specs.forEach((s, i) => {
    const last = i === specs.length - 1;
    const next = last ? 6 : specs[i + 1].thickness;
    // keep neighbouring boundaries from crossing: amplitude well below the thinner band
    const amp = last ? 0 : Math.min(maxAmp, s.thickness * 0.3, next * 0.3) * rng.range(0.5, 1);
    bands.push({ y0: y, y1: last ? 1e4 : y + s.thickness, material: s.material, tint: s.tint, waveAmp: amp, waveFreq: rng.range(0.035, 0.11), wavePhase: rng.range(0, Math.PI * 2) });
    y += s.thickness;
  });
  return bands;
}

/** Index of the band containing (x, y) — the same rule the `StrataBand` contract documents. */
export function bandAt(bands: StrataBand[], x: number, y: number): number {
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (y < b.y1 + b.waveAmp * Math.sin(x * b.waveFreq + b.wavePhase)) return i;
  }
  return bands.length - 1;
}

/** Commit a farm canvas and keep only food that the colony can reach. */
export function finishFarm(canvas: SdfCanvas, world: VoxelWorld, colony: SpawnPoint, foods: FoodSpawn[], fallback: MaterialId): { solidCells: number; foodSources: FoodSpawn[]; reach: Reach } {
  const solidCells = canvas.commit(world, fallback);
  const reach = new Reach(world, colony.pos);
  if (colony.entrance) reach.snap(colony.entrance, 5);
  return { solidCells, foodSources: settleFood(reach, foods, 8), reach };
}

export function at(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}
