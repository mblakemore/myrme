import { Mat, b3StateOf, v3, type FoodSpawn, type MapGenResult, type MaterialId, type SpeciesId, type Vec3 } from '../../core';
import { Simulation } from '../Simulation';
import { makeTestMap, type TestWorldOptions } from './colonyTestWorld';

/**
 * Test kit shared by the B3 unit tests and soaks: the A2b synthetic world (flat soil, starter
 * chamber, bent entrance tunnel at +x) with optional B3 furniture — a log of Wood lying on the
 * ground, a water-holding basin — plus a compact per-minute timeline printer.
 */
export interface B3WorldOptions extends TestWorldOptions {
  seed?: number;
  faction?: SpeciesId;
  /** Lay a log of Wood on the ground from a to b (xz), radius r. */
  log?: { ax: number; az: number; bx: number; bz: number; r: number; material?: MaterialId } | null;
  food?: FoodSpawn[];
  /** true: the sun is fixed at noon; false: fixed at midnight; omitted: the test world's default (permanent mild sun). */
  noon?: boolean;
  /** Mutate the generated map before the simulation is built. */
  prepare?: (map: MapGenResult) => void;
}

export const GROUND = 20;

export function makeB3Sim(opts: B3WorldOptions = {}): Simulation {
  const map = makeTestMap({ ...opts, food: opts.food ?? [] });
  const w = map.world;
  if (opts.log) {
    const L = opts.log;
    const len = Math.hypot(L.bx - L.ax, L.bz - L.az);
    for (let s = 0; s <= len; s += 1) {
      const t = len > 0 ? s / len : 0;
      w.fill(v3(L.ax + (L.bx - L.ax) * t, GROUND + L.r * 0.7, L.az + (L.bz - L.az) * t), L.r, L.material ?? Mat.Wood);
    }
  }
  if (opts.noon !== undefined) map.flags.dayNight = true;
  opts.prepare?.(map);
  const sim = new Simulation('meadow', map, { seed: opts.seed ?? 1, faction: opts.faction ?? 'gardenAnt', fixture: 'none' });
  if (opts.noon !== undefined) sim.weather.timeOfDay = opts.noon ? 0.5 : 0;
  return sim;
}

export function centreOf(sim: Simulation): Vec3 {
  return v3(sim.world.sx / 2, GROUND, sim.world.sz / 2);
}

export interface TimelineRow {
  min: number;
  pop: number;
  food: number;
  brood: number;
}

/**
 * Run `minutes` sim-minutes, printing one row per minute:
 *   min | pop (castes) | food / leaves / wood / mud | brood e/l/p | dug | <extra>
 */
export function runTimeline(name: string, sim: Simulation, minutes: number, extra?: (sim: Simulation) => string, each?: (sim: Simulation, tick: number) => void): { rows: TimelineRow[]; deaths: Record<string, number>; wall: number; bad: number; alerts: string[] } {
  const colony = sim.getColony(sim.playerColony)!;
  const rows: TimelineRow[] = [];
  const lines: string[] = [];
  const deaths: Record<string, number> = {};
  const alerts = new Set<string>();
  let bad = 0;
  const t0 = performance.now();
  for (let t = 1; t <= minutes * 1800; t++) {
    each?.(sim, t);
    sim.step();
    for (const e of sim.drainEvents()) {
      if (e.type === 'antDied' && e.colony === colony.id) deaths[e.cause] = (deaths[e.cause] ?? 0) + 1;
      else if (e.type === 'alert') alerts.add(e.text);
    }
    if (t % 300 === 0) for (const a of sim.ants) if (!Number.isFinite(a.pos.x + a.pos.y + a.pos.z + a.health + a.energy)) bad++;
    if (t % 1800 === 0) {
      const p = colony.population;
      const s = colony.stores;
      if (!Number.isFinite(s.food + s.leaves + s.wood + s.mud)) bad++;
      rows.push({ min: t / 1800, pop: p.total, food: s.food, brood: p.eggs + p.larvae + p.pupae });
      const castes = Object.entries(p.byCaste)
        .filter(([k]) => k !== 'queen' && k !== 'king')
        .map(([k, v]) => `${k[0]}${v}`)
        .join('/');
      lines.push(
        `${String(t / 1800).padStart(3)} | pop ${String(p.total).padStart(3)} (${castes}) | food ${s.food.toFixed(0).padStart(4)} leaf ${s.leaves.toFixed(0).padStart(3)} wood ${s.wood.toFixed(0).padStart(3)} mud ${s.mud.toFixed(0).padStart(3)} | brood ${p.eggs}/${p.larvae}/${p.pupae} | dug ${String(colony.stats.dugVoxels).padStart(5)}${extra ? ' | ' + extra(sim) : ''}`,
      );
    }
  }
  const wall = (performance.now() - t0) / 1000;
  const beh = sim.ants.reduce((m: Record<string, number>, a) => ((m[a.behavior] = (m[a.behavior] ?? 0) + 1), m), {});
  console.log(`[b3 soak] ${name}: ${wall.toFixed(1)} s wall, ${((wall * 1000) / (minutes * 1800)).toFixed(2)} ms/tick\n${lines.join('\n')}\n    deaths ${JSON.stringify(deaths)}, behaviors ${JSON.stringify(beh)}, goal ${sim.goal.def.kind} ${sim.goal.progress.toFixed(1)}/${sim.goal.def.target} ${b3StateOf(sim).goals.phase}\n    alerts ${JSON.stringify([...alerts])}`);
  return { rows, deaths, wall, bad, alerts: [...alerts] };
}
