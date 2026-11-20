import { DIFFICULTY_INTENSITY, ISO, SANDBOX_GOAL, b3StateOf, type Command, type Difficulty, type MapGenResult, type MapId, type SimEvent, type SimOptionsB1, type SpeciesId } from '../core';
import { getMap } from '../world/maps';
import { Simulation } from './Simulation';

/**
 * M3 integration kit: builds the simulation exactly the way `game/Game.ts` does for a menu-started
 * game (director + rivals from the difficulty, optional sandbox goal, map size) and runs it with a
 * compact per-minute timeline that shows the WHOLE game — every colony, creatures, weather,
 * director, goal — plus the invariants the soaks assert on.
 */
export interface FullGameOptions {
  seed?: number;
  faction?: SpeciesId;
  difficulty?: Difficulty;
  sandbox?: boolean;
  small?: boolean;
  /** Mutate the generated map before the sim is built. */
  prepare?: (map: MapGenResult) => void;
}

export function makeFullGame(mapId: MapId, o: FullGameOptions = {}): Simulation {
  const seed = o.seed ?? 1;
  const faction = o.faction ?? 'gardenAnt';
  const difficulty = o.difficulty ?? 'normal';
  const map = getMap(mapId).generate(seed, { faction, small: o.small ? true : undefined });
  if (o.sandbox) map.goal = { ...SANDBOX_GOAL };
  o.prepare?.(map);
  const on = difficulty !== 'peaceful';
  const options: SimOptionsB1 = { seed, faction, fixture: 'none', director: { enabled: on, intensity: DIFFICULTY_INTENSITY[difficulty] }, rivals: on || map.goal.kind === 'eliminateRival' };
  return new Simulation(mapId, map, options);
}

export interface FullRow {
  min: number;
  pop: number;
  food: number;
  brood: number;
  rivals: number;
  creatures: number;
}

export interface FullResult {
  sim: Simulation;
  rows: FullRow[];
  /** Player-colony deaths by cause. */
  deaths: Record<string, number>;
  /** AI-colony deaths by cause. */
  rivalDeaths: Record<string, number>;
  /** Non-finite pose / stat samples. */
  bad: number;
  /** Worst penetration into solid seen (density above ISO, in voxels) on a sampled non-carried ant. */
  maxInside: number;
  wall: number;
  msPerTick: number;
  peakAnts: number;
  waves: number;
  creaturesSpawned: Record<string, number>;
  creaturesKilled: Record<string, number>;
  weatherSeen: string[];
  alerts: string[];
  /** Alert events whose colony is not the player's (must stay 0: the HUD shows every alert). */
  foreignAlerts: number;
  events: Record<string, number>;
  queenAlive: boolean;
  status: string;
  endTick: number;
  hash: string;
  text: string;
}

export interface RunOptions {
  /** Called before each step (tick about to run); may issue commands. */
  each?: (sim: Simulation, tick: number) => void;
  /** Called for every drained event. */
  onEvent?: (e: SimEvent, sim: Simulation) => void;
  /** Stop when the goal is decided (default true). */
  stopOnEnd?: boolean;
  /** Extra column per minute. */
  extra?: (sim: Simulation) => string;
  quiet?: boolean;
}

const TPM = 1800;

function castes(byCaste: Readonly<Record<string, number | undefined>>): string {
  return Object.entries(byCaste)
    .filter(([k, v]) => k !== 'queen' && k !== 'king' && (v ?? 0) > 0)
    .map(([k, v]) => `${k[0]}${v}`)
    .join('/');
}

/** Run `minutes` sim-minutes of the full game. */
export function runFullGame(name: string, sim: Simulation, minutes: number, ro: RunOptions = {}): FullResult {
  const player = sim.getColony(sim.playerColony)!;
  const rows: FullRow[] = [];
  const lines: string[] = [];
  const deaths: Record<string, number> = {};
  const rivalDeaths: Record<string, number> = {};
  const creaturesSpawned: Record<string, number> = {};
  const creaturesKilled: Record<string, number> = {};
  const events: Record<string, number> = {};
  const alerts = new Set<string>();
  const weatherSeen = new Set<string>([sim.weather.kind]);
  const w = sim.world;
  let bad = 0;
  let maxInside = 0;
  let peakAnts = 0;
  let waves = 0;
  let foreignAlerts = 0;
  let minuteDeaths: Record<string, number> = {};
  let minuteNotes: string[] = [];
  let endTick = 0;
  const t0 = performance.now();
  const total = minutes * TPM;
  for (let t = 1; t <= total; t++) {
    ro.each?.(sim, t);
    sim.step();
    for (const e of sim.drainEvents()) {
      events[e.type] = (events[e.type] ?? 0) + 1;
      ro.onEvent?.(e, sim);
      switch (e.type) {
        case 'antDied':
          if (e.colony === player.id) {
            deaths[e.cause] = (deaths[e.cause] ?? 0) + 1;
            minuteDeaths[e.cause] = (minuteDeaths[e.cause] ?? 0) + 1;
          } else rivalDeaths[e.cause] = (rivalDeaths[e.cause] ?? 0) + 1;
          break;
        case 'creatureSpawned':
          creaturesSpawned[e.def] = (creaturesSpawned[e.def] ?? 0) + 1;
          break;
        case 'creatureDied':
          creaturesKilled[e.def] = (creaturesKilled[e.def] ?? 0) + 1;
          break;
        case 'directorWave':
          waves++;
          minuteNotes.push(`wave s${e.stage} t${e.threat.toFixed(0)}`);
          break;
        case 'weatherChanged':
          weatherSeen.add(e.to);
          break;
        case 'alert':
          alerts.add(`${e.code}:${e.text}`);
          if (e.colony !== player.id && e.colony !== 0) foreignAlerts++;
          break;
        case 'colonyDied':
          minuteNotes.push(`colony ${e.colony} died`);
          break;
        case 'nuptialFlight':
          minuteNotes.push(`flight ${e.phase}`);
          break;
        case 'win':
        case 'lose':
          minuteNotes.push(`${e.type.toUpperCase()} ${e.reason}`);
          break;
        default:
      }
    }
    if (sim.ants.length > peakAnts) peakAnts = sim.ants.length;
    if (t % 150 === 0) {
      for (const a of sim.ants) {
        if (!Number.isFinite(a.pos.x + a.pos.y + a.pos.z + a.up.x + a.up.y + a.up.z + a.forward.x + a.forward.y + a.forward.z + a.health + a.energy + a.hydration)) bad++;
        else if (a.alive && w.inBounds(Math.floor(a.pos.x), Math.floor(a.pos.y), Math.floor(a.pos.z))) {
          const inside = (w.sample(a.pos.x, a.pos.y, a.pos.z) - ISO) / 64;
          if (inside > maxInside) maxInside = inside;
        }
      }
      for (const c of sim.creatures) if (!Number.isFinite(c.pos.x + c.pos.y + c.pos.z + c.health)) bad++;
      for (const c of sim.colonies) if (!Number.isFinite(c.stores.food + c.stores.leaves + c.stores.wood + c.stores.mud)) bad++;
    }
    const ended = sim.goal.status !== 'active';
    if (ended && endTick === 0) endTick = t;
    if (t % TPM === 0 || (ended && ro.stopOnEnd !== false) || t === total) {
      const p = player.population;
      const riv = sim.colonies.filter((c) => c.id !== player.id);
      const rivPop = riv.reduce((n, c) => n + (c.alive ? c.population.total : 0), 0);
      const hostile = sim.creatures.filter((c) => c.alive && c.def !== 'aphid' && c.def !== 'caterpillar' && c.def !== 'worm').map((c) => c.def[0] + c.def[1]);
      const d = Object.entries(minuteDeaths)
        .map(([k, v]) => `${k.slice(0, 4)}${v}`)
        .join(' ');
      rows.push({ min: t / TPM, pop: p.total, food: player.stores.food, brood: p.eggs + p.larvae + p.pupae, rivals: rivPop, creatures: sim.creatures.length });
      lines.push(
        `${(t / TPM).toFixed(t % TPM ? 1 : 0).padStart(4)} | pop ${String(p.total).padStart(3)} (${castes(p.byCaste)}) food ${player.stores.food.toFixed(0).padStart(4)} brood ${p.eggs}/${p.larvae}/${p.pupae} dug ${String(player.stats.dugVoxels).padStart(5)} | ` +
          `${sim.weather.kind}@${sim.weather.timeOfDay.toFixed(2)} ${sim.weather.temperature.toFixed(0)}C | dir s${sim.director.stage} b${sim.director.budget.toFixed(0)} | ` +
          `riv ${riv.map((c) => (c.alive ? `${c.population.total}/${c.stores.food.toFixed(0)}` : 'dead')).join(',') || '-'} | cr ${sim.creatures.length}${hostile.length ? '[' + hostile.join(',') + ']' : ''} | ` +
          `goal ${sim.goal.progress.toFixed(0)}/${sim.goal.def.target}` +
          (d ? ` | died ${d}` : '') +
          (minuteNotes.length ? ` | ${minuteNotes.join('; ')}` : '') +
          (ro.extra ? ` | ${ro.extra(sim)}` : ''),
      );
      minuteDeaths = {};
      minuteNotes = [];
    }
    if (ended && ro.stopOnEnd !== false) break;
  }
  const ticks = sim.tick;
  const wall = (performance.now() - t0) / 1000;
  const msPerTick = (wall * 1000) / Math.max(1, Math.min(total, ticks));
  const beh: Record<string, number> = {};
  for (const a of sim.ants) if (a.colony === player.id) beh[a.behavior] = (beh[a.behavior] ?? 0) + 1;
  const b3 = b3StateOf(sim);
  const text =
    `[full game] ${name}: ${wall.toFixed(1)} s wall, ${msPerTick.toFixed(2)} ms/tick, peak ants ${peakAnts}, status ${sim.goal.status}${sim.goal.reason ? ' (' + sim.goal.reason + ')' : ''}\n` +
    lines.join('\n') +
    `\n    deaths ${JSON.stringify(deaths)} rivalDeaths ${JSON.stringify(rivalDeaths)}` +
    `\n    creatures spawned ${JSON.stringify(creaturesSpawned)} killed ${JSON.stringify(creaturesKilled)} waves ${waves}, weather ${[...weatherSeen].join(',')}` +
    `\n    behaviors ${JSON.stringify(beh)}` +
    `\n    goal ${sim.goal.def.kind} ${sim.goal.progress.toFixed(1)}/${sim.goal.def.target} phase ${b3.goals.phase}, delivered ${player.stats.foodDelivered.toFixed(0)}, bad ${bad}, maxInside ${maxInside.toFixed(2)}, foreignAlerts ${foreignAlerts}` +
    `\n    alerts ${JSON.stringify([...alerts].map((a) => a.slice(0, 60)))}`;
  if (!ro.quiet) console.log(text);
  return {
    sim,
    rows,
    deaths,
    rivalDeaths,
    bad,
    maxInside,
    wall,
    msPerTick,
    peakAnts,
    waves,
    creaturesSpawned,
    creaturesKilled,
    weatherSeen: [...weatherSeen],
    alerts: [...alerts],
    foreignAlerts,
    events,
    queenAlive: !!sim.getAnt(player.queenId),
    status: sim.goal.status,
    endTick,
    hash: sim.stateHash(),
    text,
  };
}

/** Issue a command list at given ticks (helper for scripted scenarios). */
export function at(schedule: Record<number, Command[] | ((sim: Simulation) => void)>): (sim: Simulation, tick: number) => void {
  return (sim, tick) => {
    const s = schedule[tick];
    if (!s) return;
    if (typeof s === 'function') s(sim);
    else for (const c of s) sim.command(c);
  };
}
