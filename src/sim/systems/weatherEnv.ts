import {
  clamp,
  v3clone,
  type B2Env,
  type CellIndex,
  type ColonyEnvState,
  type ColonyId,
  type EntityId,
  type FungusStalk,
  type FungusStats,
  type HeatSource,
  type NavEx,
  type SimState,
  type SporeCloud,
  type Vec3,
  type WaterFieldEx,
  type WeatherKind,
  type WeatherStateEx,
} from '../../core';
import { BALANCE } from '../data/balance';

/**
 * Shared B2 environment state of one simulation and the implementation of `B2Env`
 * (core/contracts/b2.ts). One object per sim, created on first use and hung on `sim.weather.env`
 * so render / ui reach it through the SimView. The weather, temperature, water and fungus systems
 * all keep their cross-system state here; pieces implemented by a particular system are plugged
 * in through `hooks` (so this file imports none of them and there are no import cycles).
 *
 * Everything in here is plain deterministic sim state derived from the seed and the commands.
 */

export type Biome = 'meadow' | 'forest' | 'desert' | 'farm';

export interface EnvHooks {
  forceWeather?: (kind: WeatherKind, intensity?: number, seconds?: number) => void;
  clearForcedWeather?: () => void;
  exposeToSpores?: (pos: Vec3, radius: number, dose: number, sheltered: boolean) => number;
  controlNoise?: (id: EntityId) => number;
}

function newColonyState(): ColonyEnvState {
  return { shelter: 'none', flooded: false, nestWater: 0, waterTop: -1, refugeCell: -1, threatenedBrood: [], knownInfected: [], exileCell: -1 };
}

export class EnvState implements B2Env {
  readonly biome: Biome;
  /** Ambient air temperature at the open surface (== sim.weather.temperature). */
  air: number;
  /** Deep-ground temperature. */
  deep: number;
  /** 0..1 strength of direct sun right now (sun elevation × clear sky). */
  sun = 0;
  /** Extra °C a fully sun-exposed surface gets at `sun` 1. */
  sunHeat: number;
  readonly heatSources: HeatSource[] = [];
  readonly stalks: FungusStalk[] = [];
  readonly sporeClouds: SporeCloud[] = [];
  readonly fungusStats: FungusStats = { infections: 0, cures: 0, exiles: 0, grips: 0, bursts: 0, destroyed: 0, deaths: 0 };
  /** Ants whose infection their colony has discovered. */
  readonly known = new Set<EntityId>();
  readonly hooks: EnvHooks = {};
  private readonly colonies: ColonyEnvState[] = [];
  private heatId = 1;
  private readonly sx: number;
  private readonly sxz: number;

  constructor(private readonly sim: SimState) {
    const id = sim.mapId;
    this.biome = !sim.map.flags.weather && sim.map.environment.backdrop === 'room' ? 'farm' : id === 'forest' ? 'forest' : id === 'desert' ? 'desert' : id === 'meadow' ? 'meadow' : sim.map.flags.slab ? 'farm' : 'meadow';
    const base = sim.map.environment.baseTemperature;
    this.air = base;
    this.deep = base + BALANCE.b2.deepOffset[this.biome];
    this.sunHeat = BALANCE.b2.sunHeat[this.biome];
    this.sx = sim.world.sx;
    this.sxz = sim.world.sx * sim.world.sz;
  }

  // ---- temperature -----------------------------------------------------------------------

  temperatureAtCell(cell: CellIndex): number {
    if (cell < 0) return this.air;
    const B = BALANCE.b2;
    const sxz = this.sxz;
    const y = Math.floor(cell / sxz);
    const r = cell - y * sxz;
    const z = Math.floor(r / this.sx);
    const x = r - z * this.sx;
    const h = (this.sim.nav as NavEx).skyHeight(x, z);
    let t: number;
    if (y >= h) t = this.air + this.sunHeat * this.sun;
    else {
      const k = clamp((h - y) / B.stableDepth, 0, 1);
      const shade = this.air - B.shadeCool * this.sun;
      t = shade + (this.deep - shade) * k;
    }
    const hs = this.heatSources;
    if (hs.length) for (let i = 0; i < hs.length; i++) t += heatAt(hs[i].pos, hs[i].radius, hs[i].delta, x + 0.5, y + 0.5, z + 0.5);
    const lamp = this.sim.weather.lamp;
    if (lamp) t += heatAt(lamp, B.lampRadius, B.lampDelta, x + 0.5, y + 0.5, z + 0.5);
    return t;
  }

  temperatureAt(pos: Vec3): number {
    return this.temperatureAtCell(this.sim.world.cellAt(pos.x, pos.y, pos.z));
  }

  sunExposure(cell: CellIndex): number {
    if (cell < 0 || this.sun <= 0) return 0;
    return (this.sim.nav as NavEx).isExposed(cell) ? this.sun : 0;
  }

  activityAt(tempC: number): number {
    const k = BALANCE.b2.activity;
    if (tempC <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (tempC <= k[i][0]) {
        const a = k[i - 1];
        const b = k[i];
        return a[1] + ((b[1] - a[1]) * (tempC - a[0])) / (b[0] - a[0]);
      }
    }
    return k[k.length - 1][1];
  }

  // ---- hooks for other streams -----------------------------------------------------------

  addWater(at: CellIndex | Vec3, volume: number): number {
    const cell = typeof at === 'number' ? at : this.sim.world.cellAt(at.x, at.y, at.z);
    return (this.sim.water as WaterFieldEx).inject(cell, volume);
  }

  addHeatSource(pos: Vec3, radius: number, delta: number): number {
    const id = this.heatId++;
    this.heatSources.push({ id, pos: v3clone(pos), radius: Math.max(0.5, radius), delta });
    return id;
  }

  removeHeatSource(id: number): void {
    const i = this.heatSources.findIndex((h) => h.id === id);
    if (i >= 0) this.heatSources.splice(i, 1);
  }

  exposeToSpores(pos: Vec3, radius: number, dose: number, sheltered = true): number {
    return this.hooks.exposeToSpores ? this.hooks.exposeToSpores(pos, radius, dose, sheltered) : 0;
  }

  infectionKnown(id: EntityId): boolean {
    return this.known.has(id);
  }

  controlNoise(id: EntityId): number {
    return this.hooks.controlNoise ? this.hooks.controlNoise(id) : 0;
  }

  colonyState(colony: ColonyId): ColonyEnvState {
    return (this.colonies[colony] ??= newColonyState());
  }

  forceWeather(kind: WeatherKind, intensity?: number, seconds?: number): void {
    this.hooks.forceWeather?.(kind, intensity, seconds);
  }

  clearForcedWeather(): void {
    this.hooks.clearForcedWeather?.();
  }
}

function heatAt(p: Vec3, radius: number, delta: number, x: number, y: number, z: number): number {
  const dx = x - p.x;
  const dy = y - p.y;
  const dz = z - p.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= radius * radius) return 0;
  const k = 1 - Math.sqrt(d2) / radius;
  return delta * k * k;
}

const states = new WeakMap<SimState, EnvState>();

/** The B2 environment state of a sim (created on first use; also reachable as `sim.weather.env`). */
export function envState(sim: SimState): EnvState {
  let e = states.get(sim);
  if (!e) {
    e = new EnvState(sim);
    states.set(sim, e);
    const w = sim.weather as WeatherStateEx;
    w.env = e;
    w.phase ??= sim.map.flags.weather ? 'clear' : 'room';
    w.cloudiness ??= 0.2;
    w.rain ??= 0;
    w.fog ??= 0;
    w.gust ??= 0;
    w.forecast ??= null;
    w.forced ??= false;
    w.lastLightningTick ??= 0;
  }
  return e;
}

/** `sim.weather` with the B2 fields (guaranteed initialised). */
export function wxOf(sim: SimState): WeatherStateEx {
  envState(sim);
  return sim.weather as WeatherStateEx;
}

/** `sim.water` with the B2 extensions. */
export function waterOf(sim: SimState): WaterFieldEx {
  return sim.water as WaterFieldEx;
}

/** Per-alert-key cooldown so B2 alerts do not spam (kept per sim). */
const alertTimes = new WeakMap<SimState, Map<string, number>>();

export function alertB2(sim: SimState, key: string, code: 'flooding' | 'infectionSpotted' | 'info', colony: ColonyId, text: string, pos: Vec3 | null = null, id: EntityId = 0, cooldown: number = BALANCE.b2.alertCooldown): boolean {
  let m = alertTimes.get(sim);
  if (!m) alertTimes.set(sim, (m = new Map()));
  const until = m.get(key);
  if (until !== undefined && sim.tick < until) return false;
  m.set(key, sim.tick + Math.round(cooldown * 30));
  sim.emit({ type: 'alert', tick: sim.tick, code, colony, pos: pos ? v3clone(pos) : null, id, text });
  return true;
}

/**
 * Final round: water standing ABOVE a mover's feet (0 = dry or standing clear of the surface).
 * `depthAt(cell)` alone is cell-relative: an ant on a bank or a stem whose cell holds 0.6 of water
 * at its bottom is not in the water — it used to "swim", fail to escape (it was already out) and
 * drown on dry ground beside a puddle.
 */
export function waterOver(sim: SimState, m: { cell: number; pos: Vec3 }): number {
  if (m.cell < 0) return 0;
  const d = sim.water.depthAt(m.cell);
  if (d <= 0) return 0;
  // underground (tunnels, chambers) the cell depth stands: a flooded gallery is a flooded gallery
  if (!(sim.nav as NavEx).isExposed(m.cell)) return d;
  const w = sim.world;
  const sxz = w.sx * w.sz;
  // water in the cell above as well: this one is full, the mover is under
  if (m.cell + sxz < sxz * w.sy && sim.water.depthAt(m.cell + sxz) > 0.02) return d;
  const over = Math.floor(m.cell / sxz) + d - (m.pos.y - 0.15);
  return over <= 0 ? 0 : over < d ? over : d;
}
