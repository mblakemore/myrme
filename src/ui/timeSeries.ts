/**
 * Time-series recorder: a ring buffer of colony metrics sampled at 1 Hz of SIM time from the
 * `SimView`, plus a death log fed from `antDied` events. Pure logic (no DOM) — feeds the colony
 * panel sparklines and the end-screen summary.
 */
import { b3StateOf, type CasteId, type DeathCause, type EndSummary, type SimEvent, type SimView, type Tick, type Vec3 } from '../core';

export type SeriesKey = 'population' | 'workers' | 'soldiers' | 'brood' | 'food' | 'wood' | 'leaves' | 'mud' | 'jobsOpen' | 'deaths' | 'threat';

export const SERIES_KEYS: readonly SeriesKey[] = ['population', 'workers', 'soldiers', 'brood', 'food', 'wood', 'leaves', 'mud', 'jobsOpen', 'deaths', 'threat'];

export interface DeathRecord {
  tick: Tick;
  caste: CasteId;
  cause: DeathCause;
  pos: Vec3;
}

/** Radius around the nest inside which enemies count towards the `threat` series. */
export const THREAT_RADIUS = 28;
const DEATH_LOG_MAX = 200;
const TICKS_PER_MINUTE = 30 * 60;

export class TimeSeriesRecorder {
  private readonly data = new Map<SeriesKey, Float32Array>();
  private readonly ticks: Float64Array;
  /** Index of the next write. */
  private head = 0;
  private count = 0;
  private total = 0;
  private lastTick = -Infinity;
  private readonly peaks = new Map<SeriesKey, number>();
  private readonly byCause: Partial<Record<DeathCause, number>> = {};
  private readonly log: DeathRecord[] = [];
  private deathCount = 0;

  constructor(
    readonly capacity = 600,
    readonly intervalTicks = 30,
  ) {
    for (const k of SERIES_KEYS) this.data.set(k, new Float32Array(capacity));
    this.ticks = new Float64Array(capacity);
  }

  /** Call once per frame: samples when `intervalTicks` sim ticks passed, and logs player-colony deaths. */
  observe(sim: SimView, events: readonly SimEvent[]): void {
    const pc = sim.playerColony;
    for (const e of events) {
      if (e.type !== 'antDied' || e.colony !== pc) continue;
      this.deathCount++;
      this.byCause[e.cause] = (this.byCause[e.cause] ?? 0) + 1;
      this.log.push({ tick: e.tick, caste: e.caste, cause: e.cause, pos: { x: e.pos.x, y: e.pos.y, z: e.pos.z } });
      if (this.log.length > DEATH_LOG_MAX) this.log.splice(0, this.log.length - DEATH_LOG_MAX);
    }
    // one sample per call at most: several ticks per frame (4×, debug step) never flood the ring
    if (sim.tick - this.lastTick < this.intervalTicks) return;
    this.lastTick = sim.tick;
    this.sample(sim);
  }

  private sample(sim: SimView): void {
    const pc = sim.playerColony;
    const colony = sim.getColony(pc);
    let population = colony?.population.total ?? 0;
    let workers = 0;
    let soldiers = 0;
    const by = colony?.population.byCaste;
    if (by && population > 0) {
      workers = (by.worker ?? 0) + (by.major ?? 0);
      soldiers = (by.soldier ?? 0) + (by.nasute ?? 0);
    } else {
      population = 0;
      for (const a of sim.ants) {
        if (!a.alive || a.colony !== pc) continue;
        population++;
        if (a.caste === 'worker' || a.caste === 'major') workers++;
        else if (a.caste === 'soldier' || a.caste === 'nasute') soldiers++;
      }
    }
    let jobsOpen = 0;
    if (colony) for (const j of colony.jobs) jobsOpen += Math.max(0, j.slots - j.assigned.length);
    let threat = 0;
    if (colony) {
      const n = colony.nestPos;
      const r2 = THREAT_RADIUS * THREAT_RADIUS;
      const near = (p: Vec3): boolean => (p.x - n.x) ** 2 + (p.y - n.y) ** 2 + (p.z - n.z) ** 2 < r2;
      for (const a of sim.ants) if (a.alive && a.colony !== pc && near(a.pos)) threat++;
      for (const c of sim.creatures) if (c.alive && (c.state === 'stalk' || c.state === 'attack') && near(c.pos)) threat++;
    }
    const pop = colony?.population;
    this.push({
      population,
      workers,
      soldiers,
      brood: pop ? pop.eggs + pop.larvae + pop.pupae : 0,
      food: colony?.stores.food ?? 0,
      wood: colony?.stores.wood ?? 0,
      leaves: colony?.stores.leaves ?? 0,
      mud: colony?.stores.mud ?? 0,
      jobsOpen,
      deaths: Math.max(colony?.stats.deaths ?? 0, this.deathCount),
      threat,
    });
    this.ticks[(this.head + this.capacity - 1) % this.capacity] = sim.tick;
  }

  private push(row: Record<SeriesKey, number>): void {
    for (const k of SERIES_KEYS) {
      const v = Number.isFinite(row[k]) ? row[k] : 0;
      this.data.get(k)![this.head] = v;
      if (v > (this.peaks.get(k) ?? -Infinity)) this.peaks.set(k, v);
    }
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.total++;
  }

  /** Samples of one series, oldest first (length ≤ capacity). */
  values(key: SeriesKey): number[] {
    const arr = this.data.get(key)!;
    const out = new Array<number>(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out[i] = arr[(start + i) % this.capacity];
    return out;
  }

  last(key: SeriesKey): number {
    if (!this.count) return 0;
    return this.data.get(key)![(this.head - 1 + this.capacity) % this.capacity];
  }

  /** All-time maximum (not just the window still in the ring). */
  peak(key: SeriesKey): number {
    return this.count ? (this.peaks.get(key) ?? 0) : 0;
  }

  /** Average change per sim minute over the last `windowSamples` samples (net income). */
  ratePerMinute(key: SeriesKey, windowSamples = 60): number {
    const n = Math.min(this.count, Math.max(2, windowSamples));
    if (n < 2) return 0;
    const arr = this.data.get(key)!;
    const iLast = (this.head - 1 + this.capacity) % this.capacity;
    const iFirst = (this.head - n + this.capacity) % this.capacity;
    const dt = this.ticks[iLast] - this.ticks[iFirst];
    if (!(dt > 0)) return 0;
    return ((arr[iLast] - arr[iFirst]) / dt) * TICKS_PER_MINUTE;
  }

  /** Number of samples taken so far (monotonic — a cheap "did anything change" key). */
  get samples(): number {
    return this.total;
  }

  deathsByCause(): Partial<Record<DeathCause, number>> {
    return { ...this.byCause };
  }

  /** Most recent deaths, newest first. */
  deathLog(max = 30): DeathRecord[] {
    return this.log.slice(-max).reverse();
  }

  /** End-screen statistics from the recorder + colony counters (B3's live summary wins where present). */
  summary(sim: SimView): EndSummary {
    const colony = sim.getColony(sim.playerColony);
    const b3 = b3StateOf(sim).goals.summary;
    const dayLength = sim.map?.environment?.dayLength ?? 0;
    const ownDays = dayLength > 0 ? sim.time / dayLength : (sim.weather?.day ?? 0);
    let population = colony?.population.total ?? 0;
    if (!population) for (const a of sim.ants) if (a.alive && a.colony === sim.playerColony) population++;
    const st = colony?.stats;
    return {
      result: b3.result !== 'playing' ? b3.result : sim.goal.status === 'won' ? 'won' : sim.goal.status === 'lost' ? 'lost' : 'playing',
      reason: b3.reason || sim.goal.reason || '',
      days: b3.days > 0 ? b3.days : ownDays,
      seconds: Math.max(b3.seconds, sim.time),
      population: b3.result !== 'playing' && b3.population > 0 ? b3.population : population,
      peakPopulation: Math.max(b3.peakPopulation, this.peak('population'), population),
      born: Math.max(b3.born, st?.born ?? 0),
      deaths: Math.max(b3.deaths, st?.deaths ?? 0, this.deathCount),
      kills: Math.max(b3.kills, st?.kills ?? 0),
      dugVoxels: Math.max(b3.dugVoxels, st?.dugVoxels ?? 0),
      foodGathered: Math.max(b3.foodGathered, st?.foodDelivered ?? 0),
      alatesLaunched: b3.alatesLaunched,
    };
  }
}
