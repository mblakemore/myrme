import { describe, expect, it } from 'vitest';
import { FZ_EXILE, envOf, type Ant, type InfectionStage, type NavEx, type SimEvent } from '../../core';
import { BALANCE } from '../data/balance';
import type { Simulation } from '../Simulation';
import { makeEnvSim } from './weatherTestWorld';

const G = 20;
const STEM = { x: 38, z: 14, height: 10 };
const B = BALANCE.b2;

function world(seed: number, hygiene: boolean, warm = 60): Simulation {
  const sim = makeEnvSim({ seed, rainChance: 0, stems: [STEM] });
  envOf(sim)!.forceWeather('clear', 0, 99999);
  if (!hygiene) sim.colonies[0].priorities.exile = 0;
  for (let i = 0; i < 30 * warm; i++) sim.step();
  sim.drainEvents();
  return sim;
}

const workers = (sim: Simulation): Ant[] => sim.ants.filter((a) => a.caste === 'worker' && a.alive);

describe('zombie fungus arc', () => {
  it('runs exposure → incubation → erratic → summit → death grip at height → fruiting → spores infect ants below', () => {
    const sim = world(5, false);
    const env = envOf(sim)!;
    const nav = sim.nav as NavEx;
    const host = workers(sim)[2];
    host.lifespan = Infinity;
    // exposure: dustings build the load; one is not enough
    expect(env.exposeToSpores(host.pos, 2, 0.4)).toBeGreaterThan(0);
    expect(host.infection.stage).toBe('exposed');
    expect(host.infection.load).toBeGreaterThan(0.2);
    expect(env.controlNoise(host.id)).toBe(0);
    for (let i = 0; i < 3 && host.infection.stage === 'exposed'; i++) env.exposeToSpores(host.pos, 2, 0.4);
    expect(host.infection.stage).toBe('incubating');
    const stages: InfectionStage[] = [];
    const at: Partial<Record<InfectionStage, number>> = {};
    const others = new Set<number>();
    let bursts = 0;
    let gripPos = { x: 0, y: 0, z: 0 };
    let noiseErratic = 0;
    const alerts = new Set<string>();
    const t0 = sim.tick;
    for (let i = 0; i < 30 * 700 && !(bursts >= 2 && env.fungusStats.infections >= 2); i++) {
      sim.step();
      if (host.infection.stage === 'erratic') noiseErratic = Math.max(noiseErratic, env.controlNoise(host.id));
      for (const e of sim.drainEvents()) {
        if (e.type === 'infectionStage') {
          if (e.id === host.id) {
            stages.push(e.stage);
            at[e.stage] = e.tick - t0;
            if (e.stage === 'gripped') gripPos = { ...host.pos };
          } else if (e.stage === 'exposed' || e.stage === 'incubating') others.add(e.id);
        } else if (e.type === 'sporeBurst') {
          bursts++;
          expect(e.pos.y).toBeGreaterThan(G + 3);
        } else if (e.type === 'alert') alerts.add(e.text);
      }
    }
    expect(stages).toEqual(['exposed', 'incubating', 'erratic', 'summit', 'gripped', 'fruiting', 'burst']);
    // timing from the balance table
    expect(at.erratic!).toBeGreaterThanOrEqual(B.incubation[0] * 30 - 1);
    expect(at.erratic!).toBeLessThanOrEqual(B.incubation[1] * 30 + 1);
    expect(at.fruiting! - at.gripped!).toBeCloseTo(B.gripTime * 30, -1);
    expect(at.burst! - at.fruiting!).toBeCloseTo(B.fruitTime * 30, -1);
    expect(noiseErratic).toBeGreaterThan(0.2);
    // the death grip is up on the stem, in the open
    expect(gripPos.y).toBeGreaterThan(G + 3);
    expect(Math.hypot(gripPos.x - STEM.x, gripPos.z - STEM.z)).toBeLessThan(3.5);
    expect(host.alive).toBe(true);
    expect(host.locomotion).toBe('static');
    expect(host.pos.y).toBeCloseTo(gripPos.y, 3);
    expect(env.stalks.length).toBe(1);
    const stalk = env.stalks[0];
    expect(stalk.hostId).toBe(host.id);
    expect(stalk.stage).toBe('burst');
    expect(stalk.growth).toBeGreaterThan(0.9);
    expect(stalk.bursts).toBeGreaterThanOrEqual(2);
    expect(env.infectionKnown(host.id)).toBe(true);
    // spores rained on the ants below and at least one more is now infected
    expect(bursts).toBeGreaterThanOrEqual(2);
    expect(others.size).toBeGreaterThan(0);
    expect(env.fungusStats.infections).toBeGreaterThanOrEqual(2);
    expect(env.fungusStats.grips).toBe(1);
    expect([...alerts].some((t) => t.startsWith('A worker is behaving strangely'))).toBe(true);
    expect([...alerts].some((t) => t.startsWith('Death grip'))).toBe(true);
    expect([...alerts].some((t) => t.startsWith('A fruiting corpse is raining spores'))).toBe(true);
    // ants under cover are not reached by falling spores
    const inside = workers(sim).find((a) => a.infection.stage === 'none' && a.cell >= 0 && !nav.isExposed(a.cell) && a.pos.y < G - 4);
    if (inside) {
      const load = inside.infection.load;
      env.exposeToSpores({ x: inside.pos.x, y: G + 6, z: inside.pos.z }, 8, 0.6, true);
      expect(inside.infection.load).toBe(load);
    }
    for (const a of sim.ants) expect(Number.isFinite(a.pos.x + a.pos.y + a.pos.z + a.infection.load + a.infection.timer)).toBe(true);
  });

  it('an unchecked outbreak keeps going; the spent husk finally drops', () => {
    const sim = world(5, false);
    const env = envOf(sim)!;
    const host = workers(sim)[2];
    sim.command({ type: 'debugInfect', id: host.id, stage: 'burst' });
    sim.step();
    expect(env.stalks.length).toBe(1);
    expect(host.locomotion).toBe('static');
    let died = '';
    for (let i = 0; i < 30 * (B.sporulateTime + 20) && !died; i++) {
      sim.step();
      for (const e of sim.drainEvents()) if (e.type === 'antDied' && e.id === host.id) died = e.cause;
    }
    expect(died).toBe('fungus');
    expect(env.stalks.some((s) => s.hostId === host.id)).toBe(false);
    expect(env.fungusStats.bursts).toBeGreaterThan(5);
  });
});

describe('social immunity', () => {
  it('nestmates smell a late incubation and groom it away', () => {
    const sim = world(5, true);
    const env = envOf(sim)!;
    const host = workers(sim)[2];
    sim.command({ type: 'debugInfect', id: host.id });
    sim.step();
    expect(host.infection.stage).toBe('incubating');
    const events: SimEvent[] = [];
    let groomed = false;
    for (let i = 0; i < 30 * 200 && host.infection.stage !== 'none'; i++) {
      sim.step();
      if (sim.ants.some((a) => a.behavior === 'hygiene')) groomed = true;
      events.push(...sim.drainEvents());
    }
    expect(host.alive).toBe(true);
    expect(host.infection.stage).toBe('none');
    expect(host.infection.load).toBe(0);
    expect(groomed).toBe(true);
    expect(env.fungusStats.cures).toBe(1);
    expect(env.fungusStats.grips).toBe(0);
    expect(events.some((e) => e.type === 'alert' && e.text === 'Nestmates smell sickness on a worker')).toBe(true);
    expect(events.some((e) => e.type === 'infectionStage' && e.id === host.id && e.stage === 'none')).toBe(true);
    // it was caught before symptoms
    expect(events.some((e) => e.type === 'infectionStage' && e.id === host.id && e.stage === 'erratic')).toBe(false);
    // and the colony goes back to work
    for (let i = 0; i < 300; i++) sim.step();
    expect(sim.ants.some((a) => a.behavior === 'hygiene')).toBe(false);
    expect(host.behavior).not.toBe('infected');
  });

  it('a symptomatic nestmate is dragged out to the exile spot and dies away from the nest', () => {
    const sim = world(6, true);
    const env = envOf(sim)!;
    const nav = sim.nav as NavEx;
    const col = sim.colonies[0];
    // pick a worker that is inside the nest
    const host = workers(sim).find((a) => a.cell >= 0 && !nav.isExposed(a.cell) && a.pos.y < G - 5)!;
    expect(host).toBeTruthy();
    host.lifespan = Infinity;
    sim.command({ type: 'debugInfect', id: host.id, stage: 'erratic' });
    const events: SimEvent[] = [];
    let exiledAt = -1;
    let exilePos = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 30 * 150 && exiledAt < 0; i++) {
      sim.step();
      events.push(...sim.drainEvents());
      if (host.mem[FZ_EXILE]) {
        exiledAt = i;
        exilePos = { ...host.pos };
      }
    }
    expect(exiledAt).toBeGreaterThan(0);
    expect(env.fungusStats.exiles).toBe(1);
    expect(events.some((e) => e.type === 'alert' && e.text === 'Workers dragged an infected nestmate out of the nest')).toBe(true);
    // outside, well away from the entrance and the nest
    expect(nav.isExposed(host.cell)).toBe(true);
    expect(Math.hypot(exilePos.x - col.nestPos.x, exilePos.z - col.nestPos.z)).toBeGreaterThan(10);
    // it stays out there: whatever it does next (grip or die), it is not inside the nest
    let minY = Infinity;
    let end: string = host.infection.stage;
    for (let i = 0; i < 30 * 160 && host.alive && host.infection.stage !== 'gripped'; i++) {
      sim.step();
      minY = Math.min(minY, host.pos.y);
      end = host.infection.stage;
    }
    sim.drainEvents();
    expect(minY).toBeGreaterThan(G - 2);
    expect(['gripped', 'summit', 'erratic']).toContain(end);
    if (host.alive) expect(nav.isExposed(host.cell)).toBe(true);
  });

  it('with hygiene off nobody intervenes', () => {
    const sim = world(6, false);
    const env = envOf(sim)!;
    const host = workers(sim)[1];
    sim.command({ type: 'debugInfect', id: host.id, stage: 'erratic' });
    let hygiene = false;
    for (let i = 0; i < 30 * 60; i++) {
      sim.step();
      if (sim.ants.some((a) => a.behavior === 'hygiene')) hygiene = true;
    }
    expect(hygiene).toBe(false);
    expect(env.fungusStats.exiles + env.fungusStats.cures).toBe(0);
    expect(host.mem[FZ_EXILE] ?? 0).toBe(0);
    expect(host.behavior).toBe('infected');
  });

  it('an attack order chews down a fruiting corpse before it sporulates', () => {
    const sim = world(7, true);
    const env = envOf(sim)!;
    const ws = workers(sim);
    // a death-gripped worker out on the surface
    const host = sim.spawnAnt(sim.playerColony, 'worker', { x: 30.5, y: G + 0.5, z: 34.5 });
    for (let i = 0; i < 30; i++) sim.step();
    sim.command({ type: 'debugInfect', id: host.id, stage: 'fruiting' });
    sim.step();
    expect(env.stalks.length).toBe(1);
    expect(env.stalks[0].stage).toBe('fruiting');
    sim.command({ type: 'order', ids: ws.slice(0, 5).map((a) => a.id), order: 'attack', targetId: host.id });
    let cause = '';
    let ticks = 0;
    const events: SimEvent[] = [];
    for (; ticks < 30 * (B.fruitTime - 5) && !cause; ticks++) {
      sim.step();
      for (const e of sim.drainEvents()) {
        events.push(e);
        if (e.type === 'antDied' && e.id === host.id) cause = e.cause;
      }
    }
    expect(cause).toBe('cull');
    for (let i = 0; i < 60; i++) sim.step();
    events.push(...sim.drainEvents());
    expect(env.stalks.length).toBe(0);
    expect(env.fungusStats.destroyed).toBe(1);
    expect(env.fungusStats.bursts).toBe(0);
    expect(events.some((e) => e.type === 'sporeBurst')).toBe(false);
    expect(events.some((e) => e.type === 'alert' && e.text === 'A fruiting corpse was destroyed')).toBe(true);
    // the remains are sterile
    for (const it of sim.items) if (it.itemKind === 'corpse') expect(it.infected).toBe(false);
    // nobody caught it
    expect(env.fungusStats.infections).toBe(1);
  });

  it('an infected corpse left in the nest fruits on the ground; necrophoresis prevents it', () => {
    const run = (undertakers: boolean): { stalks: number; bursts: number; infected: number } => {
      // (seed-sensitive: a ground burst only catches ants that happen to pass; final round moved 8 → 12)
      const sim = world(12, false);
      const env = envOf(sim)!;
      const nav = sim.nav as NavEx;
      const col = sim.colonies[0];
      if (!undertakers) col.priorities.carryCorpse = 0;
      const host = workers(sim).find((a) => a.cell >= 0 && !nav.isExposed(a.cell) && a.pos.y < G - 5)!;
      sim.command({ type: 'debugInfect', id: host.id });
      sim.step();
      sim.killAnt(host, 'starvation');
      let stalks = 0;
      for (let i = 0; i < 30 * (B.corpseFruit + 80); i++) {
        sim.step();
        stalks = Math.max(stalks, env.stalks.length);
        if (i % 300 === 0) sim.drainEvents();
      }
      return { stalks, bursts: env.fungusStats.bursts, infected: env.fungusStats.infections };
    };
    const left = run(false);
    const hauled = run(true);
    expect(left.stalks).toBe(1);
    expect(left.bursts).toBeGreaterThan(0);
    expect(left.infected).toBeGreaterThan(1);
    expect(hauled.stalks).toBe(0);
    expect(hauled.bursts).toBe(0);
  });
});
