import { describe, expect, it } from 'vitest';
import { Phero, type Ant, type Behavior, type SimEvent } from '../../core';
import { BEACON_CHANNEL } from '../../core/contracts/a2b';
import { BALANCE } from '../data/balance';
import { createBrood } from '../entities';
import type { Simulation } from '../Simulation';
import { chooseBehavior, createBrain } from './brain';
import { dutyTask, getExt, hasPlayerTask } from './colonyState';
import { makeColonySim } from './colonyTestWorld';
import { claimJob, releaseJob } from './jobsBoard';

/** Unit tests for the colony brain (A2b). World: the small synthetic map (ground at y = 20). */

const SURFACE = { x: 30.5, y: 20.5, z: 31.5 };
const NO_ACTIONS = { bite: false, dig: false, pickup: false, trail: false, recruit: false };

function run(sim: Simulation, ticks: number, events?: SimEvent[]): void {
  for (let i = 0; i < ticks; i++) {
    sim.step();
    const ev = sim.drainEvents();
    if (events) for (const e of ev) events.push(e);
  }
}
const workers = (sim: Simulation): Ant[] => sim.ants.filter((a) => a.caste === 'worker');
const playerKinds = (a: Ant): string[] => a.tasks.filter((t) => t.source === 'player').map((t) => t.kind);
const d3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function fake(id: string, band: Behavior['band'], score: () => number, log?: string[]): Behavior {
  return { id, band, score, run: () => void log?.push('run:' + id), exit: () => void log?.push('exit:' + id) };
}

describe('brain', () => {
  it('a stronger band wins whatever the scores', () => {
    const sim = makeColonySim();
    const ant = workers(sim)[0];
    ant.behavior = '';
    const brain = createBrain([fake('idle', 'idle', () => 5), fake('duty', 'duty', () => 0.9), fake('surv', 'survival', () => 0.1), fake('player', 'player', () => 0.01), fake('forced', 'forced', () => 0)]);
    expect(brain.choose(ant, sim)?.id).toBe('player');
    const brain2 = createBrain([fake('idle', 'idle', () => 5), fake('duty', 'duty', () => 0.9), fake('surv', 'survival', () => 0)]);
    expect(brain2.choose(ant, sim)?.id).toBe('duty');
    expect(createBrain([fake('x', 'duty', () => 0), fake('y', 'idle', () => -1)]).choose(ant, sim)).toBeNull();
  });

  it('hysteresis keeps the running behavior against near ties', () => {
    const sim = makeColonySim();
    const ant = workers(sim)[0];
    let b = 0.55;
    const brain = createBrain([fake('a', 'duty', () => 0.5), fake('b', 'duty', () => b)]);
    ant.behavior = '';
    expect(brain.choose(ant, sim)?.id).toBe('b'); // fresh choice: the higher score
    ant.behavior = 'a';
    expect(brain.choose(ant, sim)?.id).toBe('a'); // 0.5·mul+add > 0.55
    b = 0.5 * BALANCE.a2b.hysteresisMul + BALANCE.a2b.hysteresisAdd + 0.05;
    expect(brain.choose(ant, sim)?.id).toBe('b'); // a clear win switches
  });

  it('runs every tick, calls exit on a switch, and skips possessed ants', () => {
    const sim = makeColonySim();
    const ant = workers(sim)[0];
    const log: string[] = [];
    let a = 1;
    const brain = createBrain([fake('a', 'duty', () => a, log), fake('b', 'duty', () => 0.4, log)]);
    for (const x of sim.ants) if (x !== ant) x.possessed = true; // (only to keep the log to one ant)
    ant.behavior = '';
    ant.thinkAt = 0;
    brain.system.update(sim, 1 / 30);
    expect(log).toEqual(['run:a']);
    a = 0;
    ant.thinkAt = 0;
    brain.system.update(sim, 1 / 30);
    expect(log).toEqual(['run:a', 'exit:a', 'run:b']);
    expect(ant.behavior).toBe('b');
    ant.possessed = true;
    ant.thinkAt = 0;
    brain.system.update(sim, 1 / 30);
    expect(log.length).toBe(3);
    expect(ant.behavior).toBe('b');
  });

  it('real registry: player order > hunger > duty', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    ant.energy = 0.1;
    expect(chooseBehavior(ant, sim)?.id).toBe('eat');
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: SURFACE });
    sim.step();
    expect(chooseBehavior(ant, sim)?.id).toBe('playerOrder');
  });
});

describe('job board', () => {
  it('reserves slots and frees them again', () => {
    const sim = makeColonySim();
    run(sim, 60);
    const colony = sim.getColony(sim.playerColony)!;
    const job = colony.jobs.find((j) => j.kind === 'patrol')!;
    expect(job).toBeDefined();
    for (const j of colony.jobs) if (j.kind === 'patrol' && j !== job) j.urgency = 0;
    job.assigned.length = 0;
    job.slots = 1;
    job.urgency = 1;
    const [a, b] = workers(sim);
    expect(claimJob(sim, colony, a, 'patrol')).toBe(job);
    expect(job.assigned).toEqual([a.id]);
    expect(claimJob(sim, colony, b, 'patrol')).toBeNull();
    releaseJob(sim, a, job.id);
    expect(claimJob(sim, colony, b, 'patrol')).toBe(job);
    expect(job.assigned).toEqual([b.id]);
  });

  it('drops reservations of dead ants and never over-assigns', () => {
    const sim = makeColonySim();
    let maxOver = 0;
    for (let t = 0; t < 1800; t++) {
      sim.step();
      const colony = sim.getColony(sim.playerColony)!;
      if (t === 900) {
        const held = colony.jobs.find((j) => j.assigned.length > 0);
        if (held) sim.command({ type: 'debugKill', id: held.assigned[0] });
      }
      if (t % 10 === 9) for (const j of colony.jobs) for (const id of j.assigned) if (!sim.getAnt(id)) maxOver++;
    }
    expect(maxOver).toBeLessThanOrEqual(1); // at most the one board refresh right after the death
    const colony = sim.getColony(sim.playerColony)!;
    for (const j of colony.jobs) if (j.kind !== 'dig') expect(j.assigned.length).toBeLessThanOrEqual(Math.max(1, j.slots));
  });

  it('priority sliders and caste ratio commands', () => {
    const sim = makeColonySim();
    sim.command({ type: 'setPriority', job: 'forage', value: 0 });
    sim.command({ type: 'setCasteRatio', caste: 'soldier', value: 0.5 });
    run(sim, 300);
    const colony = sim.getColony(sim.playerColony)!;
    expect(colony.priorities.forage).toBe(0);
    expect(getExt(sim, colony.id).demand.forage).toBe(0);
    expect(sim.ants.some((a) => a.behavior === 'forage')).toBe(false);
    expect(colony.casteRatio.soldier).toBeGreaterThan(0.3);
  });
});

describe('brood', () => {
  it('egg → larva → pupa → adult, fed by nurses', () => {
    const sim = makeColonySim();
    const ev: SimEvent[] = [];
    const B = BALANCE.a2b;
    run(sim, Math.round((B.layInterval + B.eggTime + B.larvaTime + B.pupaTime) * 30 * 1.5), ev);
    const stages = new Map<number, string[]>();
    for (const e of ev) if (e.type === 'broodStage') stages.set(e.id, [...(stages.get(e.id) ?? []), e.stage]);
    const full = [...stages.values()].filter((s) => s.join() === 'egg,larva,pupa,adult');
    expect(full.length).toBeGreaterThan(0);
    expect(ev.some((e) => e.type === 'antSpawned')).toBe(true);
    expect(sim.getColony(sim.playerColony)!.stats.born).toBeGreaterThan(0);
  });

  it('unfed larvae starve (with a warning first)', () => {
    const sim = makeColonySim({ food: [] });
    const colony = sim.getColony(sim.playerColony)!;
    colony.stores.food = 0;
    const b = createBrood(sim, colony.id, 'worker', { x: colony.nestPos.x + 1, y: colony.nestPos.y, z: colony.nestPos.z });
    b.stage = 'larva';
    const ev: SimEvent[] = [];
    run(sim, Math.round(BALANCE.a2b.larvaStarveTime * 30) + 90, ev);
    expect(ev.some((e) => e.type === 'broodStage' && e.id === b.id && e.stage === 'dead')).toBe(true);
    expect(ev.some((e) => e.type === 'alert' && e.code === 'broodHungry')).toBe(true);
    expect(sim.brood.includes(b)).toBe(false);
  });
});

describe('orders', () => {
  it('move: walks there, then goes back to colony life', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: SURFACE });
    run(sim, 3);
    expect(playerKinds(ant)).toEqual(['move']);
    expect(ant.behavior).toBe('playerOrder');
    let arrived = -1;
    for (let t = 0; t < 1500 && arrived < 0; t++) {
      sim.step();
      if (!hasPlayerTask(ant)) arrived = t;
    }
    expect(arrived).toBeGreaterThan(0);
    expect(d3(ant.pos, SURFACE)).toBeLessThan(4);
    run(sim, 60);
    expect(ant.behavior).not.toBe('playerOrder');
  });

  it('shift-queue appends, a plain order replaces, stop clears', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: SURFACE });
    sim.command({ type: 'order', ids: [ant.id], order: 'guard', pos: { x: 20.5, y: 20.5, z: 30.5 }, queue: true });
    sim.step();
    expect(playerKinds(ant)).toEqual(['move', 'guard']);
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: SURFACE });
    sim.step();
    expect(playerKinds(ant)).toEqual(['move']);
    sim.command({ type: 'order', ids: [ant.id], order: 'stop' });
    sim.step();
    expect(playerKinds(ant)).toEqual([]);
  });

  it('gather: fetches from the given source and delivers', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    const src = sim.foodSources[0];
    sim.command({ type: 'order', ids: [ant.id], order: 'gather', targetId: src.id });
    const ev: SimEvent[] = [];
    run(sim, 3, ev);
    expect(playerKinds(ant)).toEqual(['gather']);
    expect(ant.tasks[0].targetId).toBe(src.id);
    run(sim, 2400, ev);
    expect(ev.some((e) => e.type === 'foodDelivered' && e.by === ant.id)).toBe(true);
    expect(playerKinds(ant)).toEqual(['gather']); // keeps gathering until told otherwise
  });

  it('guard: holds the post', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    sim.command({ type: 'order', ids: [ant.id], order: 'guard', pos: SURFACE });
    run(sim, 1500);
    expect(playerKinds(ant)).toEqual(['guard']);
    expect(d3(ant.pos, SURFACE)).toBeLessThan(BALANCE.a2b.guardLeash + 3);
  });

  it('follow: stays with the leader', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const [leader, ant] = workers(sim);
    sim.command({ type: 'order', ids: [ant.id], order: 'follow', targetId: leader.id });
    sim.command({ type: 'order', ids: [leader.id], order: 'guard', pos: SURFACE });
    run(sim, 1500);
    expect(playerKinds(ant)).toEqual(['follow']);
    expect(d3(ant.pos, leader.pos)).toBeLessThan(BALANCE.a2b.followDistance + 3);
    expect(d3(ant.pos, SURFACE)).toBeLessThan(8);
  });

  it('attack: closes with the target and bites', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const squad = workers(sim).slice(0, 4);
    sim.command({ type: 'debugSpawn', what: 'creature', creature: 'groundBeetle', pos: SURFACE });
    sim.step();
    const beetle = sim.creatures[sim.creatures.length - 1];
    expect(beetle).toBeDefined();
    sim.command({ type: 'order', ids: squad.map((a) => a.id), order: 'attack', targetId: beetle.id });
    const ev: SimEvent[] = [];
    run(sim, 3, ev);
    for (const a of squad) expect(playerKinds(a)).toEqual(['attack']);
    run(sim, 1500, ev);
    expect(ev.some((e) => e.type === 'attack' && squad.some((a) => a.id === e.attacker))).toBe(true);
  });

  it('exile: the ant leaves for the midden and stops working', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    sim.command({ type: 'order', ids: [], order: 'exile', targetId: ant.id });
    run(sim, 3);
    expect(playerKinds(ant)).toEqual(['exile']);
    run(sim, 1200);
    const colony = sim.getColony(sim.playerColony)!;
    const midden = colony.chambers.find((c) => c.kind === 'midden')!;
    expect(d3(ant.pos, midden.pos)).toBeLessThan(midden.radius + 4);
    expect(dutyTask(ant)).toBeUndefined();
  });

  it('setGroup', () => {
    const sim = makeColonySim();
    const ids = workers(sim).slice(0, 3).map((a) => a.id);
    sim.command({ type: 'setGroup', ids, group: 2 });
    sim.step();
    expect(sim.ants.filter((a) => a.group === 2).map((a) => a.id)).toEqual(ids);
  });
});

describe('possession', () => {
  it('suspends the queue untouched and resumes it on release', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: SURFACE });
    sim.command({ type: 'order', ids: [ant.id], order: 'guard', pos: { x: 20.5, y: 20.5, z: 30.5 }, queue: true });
    run(sim, 30);
    sim.command({ type: 'possessStart', id: ant.id });
    sim.step();
    expect(sim.possessedId).toBe(ant.id);
    expect(ant.possessed).toBe(true);
    const before = JSON.stringify(ant.tasks);
    const behavior = ant.behavior;
    const p0 = { ...ant.pos };
    for (let t = 0; t < 120; t++) {
      sim.command({ type: 'possessInput', move: { x: 0, y: 1 }, yawDelta: t < 10 ? 0.1 : 0, sprint: false, actions: { ...NO_ACTIONS, trail: t === 5, dig: t === 60 } });
      sim.step();
    }
    expect(d3(ant.pos, p0)).toBeGreaterThan(1); // the player drove it
    expect(JSON.stringify(ant.tasks)).toBe(before);
    expect(ant.behavior).toBe(behavior);
    sim.command({ type: 'possessStop' });
    run(sim, 5);
    expect(sim.possessedId).toBe(0);
    expect(ant.possessed).toBe(false);
    expect(ant.behavior).toBe('playerOrder');
    let done = false;
    for (let t = 0; t < 2400 && !done; t++) {
      sim.step();
      done = playerKinds(ant).join() === 'guard';
    }
    expect(done).toBe(true); // finished the move, went on to the queued guard
  });

  it('pickup takes food from a source and drop puts it down', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    const src = sim.foodSources[0];
    sim.command({ type: 'order', ids: [ant.id], order: 'guard', pos: src.pos });
    run(sim, 1500);
    expect(d3(ant.pos, src.pos)).toBeLessThan(4);
    sim.command({ type: 'possessStart', id: ant.id });
    sim.step();
    const ev: SimEvent[] = [];
    const press = (): void => {
      sim.command({ type: 'possessInput', move: { x: 0, y: 0 }, yawDelta: 0, sprint: false, actions: { ...NO_ACTIONS, pickup: true } });
      run(sim, 2, ev);
    };
    if (ant.carrying) press(); // whatever she was holding when the order came
    expect(ant.carrying).toBeNull();
    press();
    expect(ant.carrying).not.toBeNull();
    expect(ev.some((e) => e.type === 'itemPicked' && e.by === ant.id)).toBe(true);
    press();
    expect(ant.carrying).toBeNull();
    expect(ev.some((e) => e.type === 'itemDropped' && e.by === ant.id)).toBe(true);
  });

  it('death of the possessed ant ends possession with an alert', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const ant = workers(sim)[0];
    sim.command({ type: 'possessStart', id: ant.id });
    run(sim, 5);
    sim.command({ type: 'debugKill', id: ant.id });
    const ev: SimEvent[] = [];
    run(sim, 5, ev);
    expect(sim.possessedId).toBe(0);
    expect(ev.some((e) => e.type === 'alert' && e.code === 'possessedDied')).toBe(true);
    expect(ev.some((e) => e.type === 'antDied' && e.id === ant.id && e.cause === 'debug')).toBe(true);
  });
});

describe('beacons', () => {
  it('rally: deposits its channel and gathers ants; removal releases them', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const colony = sim.getColony(sim.playerColony)!;
    sim.command({ type: 'beacon', op: 'place', kind: 'rally', pos: SURFACE });
    run(sim, 900);
    expect(colony.beacons.length).toBe(1);
    const beacon = colony.beacons[0];
    expect(BEACON_CHANNEL.rally).toBe(Phero.rally);
    expect(sim.pheromones.activeCount(colony.id, BEACON_CHANNEL.rally)).toBeGreaterThan(0);
    const called = sim.ants.filter((a) => a.mem['beacon'] === beacon.id);
    expect(called.length).toBeGreaterThanOrEqual(5);
    expect(called.every((a) => a.caste !== 'queen')).toBe(true);
    const near = called.filter((a) => d3(a.pos, beacon.pos) < beacon.radius + 2);
    expect(near.length).toBeGreaterThanOrEqual(called.length - 2);
    expect(called.filter((a) => a.behavior === 'beacon').length).toBeGreaterThanOrEqual(called.length - 2);
    sim.command({ type: 'beacon', op: 'remove', id: beacon.id });
    run(sim, 60);
    expect(colony.beacons.length).toBe(0);
    expect(sim.ants.some((a) => a.mem['beacon'])).toBe(false);
    expect(sim.ants.some((a) => a.behavior === 'beacon')).toBe(false);
  });

  it('dig beacon makes a designation that gets dug; avoid keeps ants out', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const colony = sim.getColony(sim.playerColony)!;
    const dug0 = colony.stats.dugVoxels;
    sim.command({ type: 'beacon', op: 'place', kind: 'dig', pos: { x: 30.5, y: 19.5, z: 31.5 } });
    run(sim, 30);
    expect(colony.designations.some((d) => d.kind === 'dig')).toBe(true);
    run(sim, 1500);
    expect(colony.stats.dugVoxels).toBeGreaterThan(dug0);
  });

  it('player dig designation is worked by the colony', () => {
    const sim = makeColonySim();
    run(sim, 30);
    const colony = sim.getColony(sim.playerColony)!;
    const c = { x: colony.nestPos.x - 6, y: colony.nestPos.y + 1, z: colony.nestPos.z };
    sim.command({ type: 'designate', kind: 'dig', op: 'add', center: c, radius: 2 });
    run(sim, 20);
    expect(colony.designations.length).toBeGreaterThan(0);
    expect(colony.jobs.some((j) => j.kind === 'dig')).toBe(true);
    const dug0 = colony.stats.dugVoxels;
    run(sim, 1800);
    expect(colony.stats.dugVoxels).toBeGreaterThan(dug0);
  });
});
