import { describe, expect, it } from 'vitest';
import { b3Command, b3StateOf, v3, type B3SimEvent, type GoalKind, type SimEvent } from '../../core';
import type { Simulation } from '../Simulation';
import { nuptialOf } from './goals';
import { GROUND, makeB3Sim, type B3WorldOptions } from './goalsTestKit';
import { foundColony } from './rivals';

function goalSim(kind: GoalKind, target: number, opts: B3WorldOptions = {}): Simulation {
  const sim = makeB3Sim({ seed: 11, size: 64, ...opts });
  sim.goal.def = { id: 'test', kind, target, label: 'test goal' };
  return sim;
}

interface Log {
  events: (SimEvent | B3SimEvent)[];
  types: string[];
}

function run(sim: Simulation, ticks: number, log: Log, until?: () => boolean): void {
  for (let t = 0; t < ticks; t++) {
    sim.step();
    for (const e of sim.drainEvents() as (SimEvent | B3SimEvent)[]) {
      log.events.push(e);
      log.types.push(e.type);
    }
    if (until?.()) break;
  }
}
const newLog = (): Log => ({ events: [], types: [] });
const last = <T extends string>(log: Log, type: T) => [...log.events].reverse().find((e) => e.type === type) as Extract<SimEvent | B3SimEvent, { type: T }> | undefined;

describe('goals', () => {
  it('population: progress events, then win with a summary; continuing afterwards never ends the game again', () => {
    const sim = goalSim('population', 18);
    const colony = sim.getColony(1)!;
    const log = newLog();
    run(sim, 60, log);
    const p0 = last(log, 'goalProgress')!;
    expect(p0.progress).toBe(colony.population.total);
    expect(p0.target).toBe(18);
    expect(sim.goal.status).toBe('active');
    for (let i = 0; i < 8; i++) sim.spawnAnt(1, 'worker', v3(colony.nestPos.x + i * 0.3, colony.nestPos.y, colony.nestPos.z));
    run(sim, 60, log);
    expect(sim.goal.status).toBe('won');
    expect(sim.goal.reason).toBe('population');
    expect(log.types).toContain('win');
    const end = last(log, 'gameEnd')!;
    expect(end.result).toBe('won');
    expect(end.summary.population).toBeGreaterThanOrEqual(18);
    expect(end.summary.peakPopulation).toBeGreaterThanOrEqual(18);
    expect(end.summary.seconds).toBeGreaterThan(0);
    expect(b3StateOf(sim).goals.phase).toBe('won');
    // continue
    sim.command(b3Command({ type: 'goal', op: 'continue' }));
    const log2 = newLog();
    run(sim, 30, log2);
    expect(b3StateOf(sim).goals.phase).toBe('continued');
    expect(log2.types).toContain('gameContinue');
    // even the queen's death does not produce a second end
    sim.command({ type: 'debugKill', id: colony.queenId });
    run(sim, 30 * 20, log2);
    expect(log2.types).not.toContain('lose');
    expect(log2.types).not.toContain('gameEnd');
  });

  it('excavate: percent of the solid volume dug', () => {
    const sim = goalSim('excavate', 0.02);
    const log = newLog();
    run(sim, 30, log);
    expect(sim.goal.status).toBe('active');
    run(sim, 240 * 30, log, () => sim.goal.status !== 'active');
    expect(sim.goal.status).toBe('won');
    expect(sim.goal.reason).toBe('excavate');
    expect(b3StateOf(sim).goals.excavatedPercent).toBeGreaterThanOrEqual(0.02);
    expect(log.types).toContain('goalProgress');
  });

  it('survive N days', () => {
    const sim = goalSim('survive', 0.02); // 0.02 of the nominal 600 s day = 12 s
    const log = newLog();
    run(sim, 6 * 30, log);
    expect(sim.goal.status).toBe('active');
    run(sim, 10 * 30, log);
    expect(sim.goal.status).toBe('won');
    expect(sim.goal.reason).toBe('survive');
    expect(last(log, 'gameEnd')!.summary.days).toBeGreaterThanOrEqual(0.02);
  });

  it('eliminateRival: won when the rival colony has lost its queen', () => {
    const sim = goalSim('eliminateRival', 1);
    const rival = foundColony(sim, 'fireAnt', v3(14, GROUND + 1, 14), null, 4);
    const log = newLog();
    run(sim, 90, log);
    expect(sim.goal.status).toBe('active');
    expect(b3StateOf(sim).goals.rivalsAlive).toBe(1);
    sim.command({ type: 'debugKill', id: rival.queenId });
    run(sim, 30 * 30, log, () => sim.goal.status !== 'active');
    expect(sim.goal.status).toBe('won');
    expect(sim.goal.reason).toBe('eliminateRival');
    expect(b3StateOf(sim).goals.rivalsEliminated).toBe(1);
  });

  it('sandbox never ends on its own, but can be conceded', () => {
    const sim = goalSim('sandbox', 0);
    const log = newLog();
    run(sim, 20 * 30, log);
    expect(sim.goal.status).toBe('active');
    sim.command(b3Command({ type: 'goal', op: 'concede' }));
    run(sim, 30, log);
    expect(sim.goal.status).toBe('lost');
    expect(sim.goal.reason).toBe('conceded');
  });

  it('lose: queen dead and no queen-destined brood → succession grace, then lost', () => {
    const sim = goalSim('population', 500);
    const colony = sim.getColony(1)!;
    const log = newLog();
    run(sim, 30, log);
    sim.command({ type: 'debugKill', id: colony.queenId });
    run(sim, 45, log);
    const g = b3StateOf(sim).goals;
    expect(g.phase).toBe('succession');
    expect(sim.goal.status).toBe('active');
    run(sim, 30 * 20, log, () => sim.goal.status !== 'active');
    expect(sim.goal.status).toBe('lost');
    expect(sim.goal.reason).toBe('queenDead');
    expect(log.types).toContain('lose');
    const end = last(log, 'gameEnd')!;
    expect(end.result).toBe('lost');
    expect(end.summary.deaths).toBeGreaterThan(0);
  });

  it('succession: royal brood holds the loss off, and an adult alate takes the throne', () => {
    const sim = goalSim('population', 500);
    const colony = sim.getColony(1)!;
    const log = newLog();
    run(sim, 30, log);
    const b = sim.spawnBrood(1, 'alate', v3(colony.nestPos.x, colony.nestPos.y, colony.nestPos.z));
    sim.command({ type: 'debugKill', id: colony.queenId });
    run(sim, 30 * 25, log);
    expect(sim.goal.status).toBe('active'); // well past the grace period
    expect(b3StateOf(sim).goals.phase).toBe('succession');
    expect(b.alive).toBe(true);
    // the princess ecloses
    const alate = sim.spawnAnt(1, 'alate', v3(colony.nestPos.x, colony.nestPos.y, colony.nestPos.z));
    run(sim, 45, log);
    expect(alate.caste).toBe('queen');
    expect(colony.queenId).toBe(alate.id);
    expect(b3StateOf(sim).goals.phase).toBe('playing');
    expect(sim.goal.status).toBe('active');
  });

  it("termites need BOTH royals: the king's death alone loses the colony", () => {
    const sim = goalSim('population', 500, { faction: 'termite', noon: false });
    const colony = sim.getColony(1)!;
    const log = newLog();
    run(sim, 30, log);
    const king = sim.ants.find((a) => a.caste === 'king')!;
    expect(king).toBeDefined();
    expect(sim.getAnt(colony.queenId)).toBeDefined();
    sim.command({ type: 'debugKill', id: king.id });
    run(sim, 30 * 20, log, () => sim.goal.status !== 'active');
    expect(sim.goal.status).toBe('lost');
    expect(sim.goal.reason).toBe('kingDead');
    expect(sim.getAnt(colony.queenId)?.alive).toBe(true);
  });

  it('lose when the whole colony is dead', () => {
    const sim = goalSim('sandbox', 0);
    const log = newLog();
    run(sim, 30, log);
    for (const a of sim.ants) sim.command({ type: 'debugKill', id: a.id });
    run(sim, 60, log);
    expect(sim.goal.status).toBe('lost');
    expect(sim.goal.reason).toBe('colonyDead');
  });

  it('nuptial flight: reaching the population rears alates, they gather outside, take off flying and leave → win', () => {
    const sim = goalSim('nuptialFlight', 16, { noon: true });
    const colony = sim.getColony(1)!;
    colony.stores.food = 400;
    const log = newLog();
    run(sim, 30, log);
    expect(nuptialOf(sim, 1)?.phase ?? 'none').toBe('none');
    for (let i = 0; i < 8; i++) sim.spawnAnt(1, 'worker', v3(colony.nestPos.x + i * 0.3, colony.nestPos.y, colony.nestPos.z));
    run(sim, 60, log);
    const n = nuptialOf(sim, 1)!;
    expect(n.phase).toBe('rearing');
    expect(n.wanted).toBeGreaterThan(0);
    expect(colony.casteRatio.alate ?? 0).toBeGreaterThan(0);
    expect(sim.goal.status).toBe('active');
    // the brood system would take minutes to raise them; hatch the princes and princesses now
    for (let i = 0; i < n.wanted; i++) sim.spawnAnt(1, 'alate', v3(colony.nestPos.x + (i % 4) * 0.4, colony.nestPos.y, colony.nestPos.z + Math.floor(i / 4) * 0.4));
    const phases: string[] = [];
    let flew = 0;
    let maxY = 0;
    run(sim, 240 * 30, log, () => {
      if (phases[phases.length - 1] !== n.phase) phases.push(n.phase);
      for (const a of sim.ants) {
        if (a.caste !== 'alate') continue;
        if (a.locomotion === 'fly') {
          flew++;
          expect(a.behavior).toBe('nuptial');
          maxY = Math.max(maxY, a.pos.y);
        }
      }
      return sim.goal.status !== 'active';
    });
    expect(phases).toEqual(expect.arrayContaining(['gather', 'takeoff', 'done']));
    expect(phases.indexOf('gather')).toBeLessThan(phases.indexOf('takeoff'));
    const flight = log.events.filter((e) => e.type === 'nuptialFlight') as Extract<SimEvent, { type: 'nuptialFlight' }>[];
    expect(flight.map((e) => e.phase)).toEqual(expect.arrayContaining(['gather', 'takeoff']));
    expect(log.types).toContain('alateTakeoff');
    expect(flew).toBeGreaterThan(0);
    expect(maxY).toBeGreaterThan(GROUND + 4);
    expect(n.launched).toBeGreaterThanOrEqual(Math.ceil(n.wanted / 2));
    expect(sim.goal.status).toBe('won');
    expect(sim.goal.reason).toBe('nuptialFlight');
    expect(last(log, 'gameEnd')!.summary.alatesLaunched).toBe(n.launched);
    // the departed are gone from the colony
    expect(sim.ants.filter((a) => a.alive && a.caste === 'alate' && a.locomotion === 'fly').length).toBe(0);
  });

  it('nuptial flight waits for weather: no take-off at night', () => {
    const sim = goalSim('nuptialFlight', 16, { noon: false });
    const colony = sim.getColony(1)!;
    colony.stores.food = 400;
    const log = newLog();
    for (let i = 0; i < 8; i++) sim.spawnAnt(1, 'worker', v3(colony.nestPos.x + i * 0.3, colony.nestPos.y, colony.nestPos.z));
    run(sim, 60, log);
    const n = nuptialOf(sim, 1)!;
    for (let i = 0; i < n.wanted; i++) sim.spawnAnt(1, 'alate', v3(colony.nestPos.x + (i % 4) * 0.4, colony.nestPos.y, colony.nestPos.z));
    run(sim, 60 * 30, log);
    expect(n.phase).toBe('waiting');
    expect(n.hold).not.toBe('');
    expect(log.types).not.toContain('alateTakeoff');
  });
});
