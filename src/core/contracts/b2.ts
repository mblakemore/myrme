/**
 * Contract extensions owned by stream B2 (PLAN §10.2, D22) — environment simulation:
 * weather, water / flooding, temperature, zombie fungus.
 * Additive only — never redefines or widens a type from `core/contracts.ts`.
 *
 * HOW TO REACH EVERYTHING (render / ui / audio never import `sim/`, so the whole B2 surface hangs
 * off objects that are already on the `SimView`):
 *
 *   const wx  = weatherEx(sim.weather);   // WeatherStateEx — same object as `sim.weather`
 *   const env = envOf(sim);               // B2Env | null (null only before the weather system's init)
 *   const h2o = waterEx(sim.water);       // WaterFieldEx — `sim.water` IS one at runtime
 *
 * Sim-side streams may also import the same functions directly:
 *   import { envState } from '../systems/weatherEnv';   // the B2Env implementation (never null)
 *
 * ── B4 (VFX) renders from ───────────────────────────────────────────────────────────────────
 *   rain / clouds / fog / wind   wx.rain, wx.cloudiness, wx.fog, wx.wind, wx.wetness, wx.kind
 *   drop impacts, lightning      events `rainImpact {pos, radius}`, `lightning {pos}`
 *   water                        h2o.forEachFlooded((cell, depth)) for every wet cell,
 *                                h2o.forEachSurface((cell, level)) for free-surface cells only,
 *                                h2o.version (wet-cell SET changed) / h2o.revision (any depth changed);
 *                                event `flood {pos, cell, rising}` when a nest starts / stops flooding
 *   infected ants                `ant.infection.stage` (+ `ant.mem[FZ_CONVULSE]` = 1 while convulsing,
 *                                `ant.anim === 'grip'` once clamped on), event `infectionStage`
 *   fruiting stalks              env.stalks  (FungusStalk: pos, up, growth 0..1, stage, hostId / itemId)
 *   spores                       event `sporeBurst {pos, radius}`; env.sporeClouds (lingering zones)
 *
 * ── B3 hooks ────────────────────────────────────────────────────────────────────────────────
 *   env.addWater(cellOrPos, volume)            keeper dropper; returns the volume accepted
 *   env.addHeatSource(pos, radius, delta) → id / env.removeHeatSource(id)   (the keeper lamp may
 *       instead just set `sim.weather.lamp`; that position is treated as a heat source too)
 *   env.exposeToSpores(pos, radius, dose)      contaminated food drop; returns ants dosed
 *   env.temperatureAt(pos) / temperatureAtCell(cell) / sunExposure(cell)
 *   sim.water.isFlooded(cell) / depthAt(cell)  flood queries (rafts)
 *   `ant.mem[NO_DROWN_KEY] = 1`                the water system will not drown this ant (rafting);
 *                                              ants with `anim === 'raft'` are skipped as well
 *
 * ── B5 readouts ─────────────────────────────────────────────────────────────────────────────
 *   clock      sim.weather.timeOfDay (0..1, 0 = midnight), sim.weather.day, `clockLabel(timeOfDay)`
 *   weather    `weatherLabel(sim.weather)`, sim.weather.temperature (°C at the open surface)
 *   forecast   wx.forecast (next phase: kind, intensity, inTicks) — show it when `inTicks` is small;
 *              the sim also emits an `alert` (code 'info', "Rain is coming") a little ahead
 *   colony     env.colonyState(colonyId): shelter reason, flooded flag, known infected ants
 *
 * ── Brain conventions added by B2 (documentation; no A2b file was edited) ───────────────────
 *   WEATHER SHELTER: `env.colonyState(c).shelter` is 'rain' | 'heat' | 'cold' | 'none'. While it is
 *   not 'none' the survival-band behavior `seekShade` claims every exposed ant of the colony and
 *   every forager (ant holding a `gather` duty task and not carrying a load) and walks it home /
 *   under cover, so A2b's forage duty yields by band priority; when the flag clears the forager
 *   resumes the task it still holds. Player orders (band `player`) are NOT overridden.
 *   HYGIENE: the duty behavior `hygiene` owns non-player tasks of kind `exile` (source 'self');
 *   its stimulus is `colony.priorities.exile` (0 switches social immunity off).
 *   FORCED: `infected` (band `forced`) runs ants in stage erratic / summit / gripped / fruiting /
 *   burst, ants being dragged out by a nestmate, and infected ants under an exile.
 */
import type { CellIndex, ColonyId, EntityId, Vec3, WaterField, WeatherKind, WeatherState } from '../contracts';

// =====================================================================================
// Weather
// =====================================================================================

/** Internal phase of the weather state machine (finer than `WeatherKind`). */
export type WeatherPhase = 'clear' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'storm' | 'cloudburst' | 'clearing' | 'heat' | 'cold' | 'wind' | 'room';

export interface WeatherForecast {
  /** Kind the weather will change to next. */
  kind: WeatherKind;
  phase: WeatherPhase;
  intensity: number;
  /** Ticks until the change. */
  inTicks: number;
}

/** `sim.weather` at runtime (the weather system adds these fields to the same object). */
export interface WeatherStateEx extends WeatherState {
  phase: WeatherPhase;
  /** Smoothed sky cover 0..1. */
  cloudiness: number;
  /** Smoothed precipitation rate 0..1 (0 when dry). Drives rain streaks, impacts, inflow. */
  rain: number;
  /** Smoothed ground fog 0..1. */
  fog: number;
  /** Wind gust factor 0..1 (already folded into `wind`). */
  gust: number;
  /** The next phase, already rolled (so the hint is truthful); null on maps without weather. */
  forecast: WeatherForecast | null;
  /** True while a `debugWeather` command / `forceWeather` call holds the weather. */
  forced: boolean;
  /** Tick of the last lightning strike (0 = never) — flash timing for renderers that missed the event. */
  lastLightningTick: number;
  env: B2Env;
}

export type ShelterReason = 'none' | 'rain' | 'heat' | 'cold';

/** Per-colony environment state (weather shelter signal, flood response, social immunity). */
export interface ColonyEnvState {
  shelter: ShelterReason;
  /** Water is standing inside the nest. */
  flooded: boolean;
  /** Wet cells inside the nest chambers. */
  nestWater: number;
  /** y of the highest water surface inside the nest (−1 when dry). */
  waterTop: number;
  /** Where brood and queen are evacuated to (highest dry chamber), −1 when not flooded. */
  refugeCell: CellIndex;
  /** Brood currently threatened by water. */
  threatenedBrood: EntityId[];
  /** Infected nestmates the colony has discovered (smelled / seen acting strangely). */
  knownInfected: EntityId[];
  /** Where dragged-out / exiled infected ants are taken (far from the nest), −1 if none found. */
  exileCell: CellIndex;
}

export interface HeatSource {
  id: number;
  pos: Vec3;
  radius: number;
  /** °C added at the centre, falling off to 0 at `radius`. Negative = cold source. */
  delta: number;
}

// =====================================================================================
// Fungus
// =====================================================================================

/**
 * A fruiting body. Either a death-gripped ant (`hostId` ≠ 0: the ant entity stays alive-in-the-sim
 * as a static, attackable mover with `infection.stage` gripped → fruiting → burst) or an infected
 * corpse item that was left lying (`itemId` ≠ 0; destroyed by hauling it to the midden).
 */
export interface FungusStalk {
  /** Stable id (== hostId or itemId). */
  id: number;
  hostId: EntityId;
  itemId: EntityId;
  /** Colony of the host (0 = wild / map-native). */
  colony: ColonyId;
  /** Base of the stalk (head of the host) and the direction it grows in. */
  pos: Vec3;
  up: Vec3;
  stage: 'gripped' | 'fruiting' | 'burst';
  /** Stalk length 0..1 (0 while gripped, grows during fruiting, 1 while sporulating). */
  growth: number;
  /** Spore bursts released so far, and the tick of the next one (0 = not sporulating yet). */
  bursts: number;
  nextBurstTick: number;
  /** Radius of the spore rain on the ground below. */
  radius: number;
  /** Map-native stalk (sporulates until destroyed). */
  native: boolean;
}

/** Spores hanging in the air after a burst: ants walking through keep getting dosed. */
export interface SporeCloud {
  pos: Vec3;
  radius: number;
  bornTick: number;
  untilTick: number;
}

export interface FungusStats {
  /** Ants that ever reached `incubating`. */
  infections: number;
  cures: number;
  exiles: number;
  grips: number;
  bursts: number;
  /** Fruiting bodies destroyed (chewed down or hauled away). */
  destroyed: number;
  deaths: number;
}

// =====================================================================================
// The B2 environment API (implemented by sim/systems/weatherEnv.ts)
// =====================================================================================

export interface B2Env {
  /** Local temperature in °C (time of day, weather, sun / shade, depth, heat sources). */
  temperatureAt(pos: Vec3): number;
  temperatureAtCell(cell: CellIndex): number;
  /** 0..1: how hard the sun beats on this cell right now (0 at night, under cover, under cloud). */
  sunExposure(cell: CellIndex): number;
  /** Speed / metabolism multiplier for a temperature (cold = sluggish). */
  activityAt(tempC: number): number;

  /** Inject water (voxels) at a cell or position; flows downhill from there. Returns volume accepted. */
  addWater(at: CellIndex | Vec3, volume: number): number;

  addHeatSource(pos: Vec3, radius: number, delta: number): number;
  removeHeatSource(id: number): void;
  readonly heatSources: readonly HeatSource[];

  /**
   * Dust every ant within `radius` of `pos` with spores (`dose` = infection load added at the
   * centre, 1 = certain infection). `sheltered` = false also reaches ants under cover (a
   * contaminated food item inside the nest). Returns the number of ants dosed.
   */
  exposeToSpores(pos: Vec3, radius: number, dose: number, sheltered?: boolean): number;
  readonly stalks: readonly FungusStalk[];
  readonly sporeClouds: readonly SporeCloud[];
  readonly fungusStats: Readonly<FungusStats>;
  /** Has the ant's colony discovered that it is infected? (HUD: hide infection until true.) */
  infectionKnown(id: EntityId): boolean;
  /** 0..1 loss of control of an infected ant (possession wobble, twitch amplitude). */
  controlNoise(id: EntityId): number;

  colonyState(colony: ColonyId): ColonyEnvState;

  /** Hold the weather at `kind` for `seconds` (default: balance `debugHoldSeconds`). Same as the `debugWeather` command. */
  forceWeather(kind: WeatherKind, intensity?: number, seconds?: number): void;
  clearForcedWeather(): void;
}

/** `sim.weather` with the B2 fields. Safe before init: missing fields read as calm defaults. */
export function weatherEx(w: Readonly<WeatherState>): Readonly<WeatherStateEx> {
  return w as WeatherStateEx;
}

/** The B2 environment API of a sim (hangs off `sim.weather`), or null before the weather system ran `init`. */
export function envOf(sim: { readonly weather: Readonly<WeatherState> }): B2Env | null {
  return (sim.weather as Partial<WeatherStateEx>).env ?? null;
}

// =====================================================================================
// Water
// =====================================================================================

/** Everything `world/water.ts` offers beyond `WaterField`. `sim.water` implements this. */
export interface WaterFieldEx extends WaterField {
  /** Like `addWater` but returns the volume actually accepted (a sealed, full pocket refuses). */
  inject(cell: CellIndex, amount: number): number;
  /** Sum of all depths (voxels of water in the world). */
  totalVolume(): number;
  /** Lifetime accounting: totalVolume() === totalAdded − totalDrained (conservation). */
  readonly totalAdded: number;
  readonly totalDrained: number;
  /** Bumped whenever any depth changed (version only tracks the wet-cell set). */
  readonly revision: number;
  /** Cells still flowing (0 = the field is at rest). */
  readonly activeCount: number;
  /** Depth above which a cell counts as flooded (`isFlooded`). */
  readonly floodDepth: number;
  /** Free-surface cells only (nothing wet above): `level` = world y of the water surface. */
  forEachSurface(fn: (cell: CellIndex, level: number) => void): void;
  /** World y of the water surface in the column above `cell` (−1 if the cell is dry). */
  surfaceAbove(cell: CellIndex): number;
  /** Evaporation from free surfaces, voxels of depth per second (set by the water system). */
  setEvaporation(rate: number): void;
  /** Remove up to `amount` from a cell (drinking). Returns the amount removed. */
  take(cell: CellIndex, amount: number): number;
}

export function waterEx(w: WaterField): WaterFieldEx {
  return w as WaterFieldEx;
}

// =====================================================================================
// `Ant.mem` keys written by B2 (readable by anyone; all numeric)
// =====================================================================================

/** Set to 1 by another stream to make the water system skip drowning for this ant (rafts). */
export const NO_DROWN_KEY = 'b2.nodrown';
/** Tick until which the ant is stunned (raindrop / lightning); it cannot move meanwhile. */
export const STUN_KEY = 'b2.stun';
/** 1 while an erratic ant is convulsing on the spot. */
export const FZ_CONVULSE = 'fz.conv';
/** Id of the nestmate dragging this infected ant out of the nest (0 / undefined = none). */
export const FZ_DRAG = 'fz.drag';
/** 1 once an infected ant was dragged out and banished by its nestmates (hygiene exile). */
export const FZ_EXILE = 'fz.exile';
/** Current loss-of-control 0..1 of an infected ant (same as `env.controlNoise(id)`). */
export const FZ_NOISE = 'fz.noise';

// =====================================================================================
// HUD helpers (pure)
// =====================================================================================

/** "07:00"-style clock label for a `timeOfDay` in 0..1. */
export function clockLabel(timeOfDay: number): string {
  const total = Math.floor((((timeOfDay % 1) + 1) % 1) * 1440 + 1e-6) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
}

const PHASE_LABEL: Readonly<Record<WeatherPhase, string>> = {
  clear: 'Clear',
  cloudy: 'Cloudy',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  storm: 'Thunderstorm',
  cloudburst: 'Cloudburst',
  clearing: 'Clearing up',
  heat: 'Heat wave',
  cold: 'Cold snap',
  wind: 'Windy',
  room: 'Indoors',
};

/** One-word-ish weather readout for the HUD. */
export function weatherLabel(w: Readonly<WeatherState>): string {
  const phase = (w as Partial<WeatherStateEx>).phase;
  if (phase) return PHASE_LABEL[phase];
  return w.kind.charAt(0).toUpperCase() + w.kind.slice(1);
}

/** Forecast hint for the HUD ("Rain in 0:40"), or '' when nothing notable is coming within `withinSeconds`. */
export function forecastLabel(w: Readonly<WeatherState>, withinSeconds = 90): string {
  const f = (w as Partial<WeatherStateEx>).forecast;
  if (!f) return '';
  const s = Math.max(0, Math.round(f.inTicks / 30));
  if (s > withinSeconds) return '';
  if (f.phase === 'clear' || f.phase === 'room' || f.phase === 'cloudy' || f.phase === 'clearing') return '';
  return `${PHASE_LABEL[f.phase]} in ${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
}
