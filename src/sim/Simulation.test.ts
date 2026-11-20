import { describe, expect, it } from 'vitest';
import { v3clone, type Command } from '../core';
import { BEHAVIORS } from './behaviors';
import { SYSTEMS } from './systems';
import { makeSim } from './testUtil';

describe('determinism', () => {
  it('same seed + same commands ⇒ identical stateHash after 600 ticks', () => {
    const run = (seed: number) => {
      const sim = makeSim('meadow', { seed, ants: 60, small: true });
      const ids = sim.ants.slice(0, 10).map((a) => a.id);
      const target = v3clone(sim.map.spawns[0].entrance!);
      const hashes: string[] = [];
      for (let t = 0; t < 600; t++) {
        if (t === 50) sim.command({ type: 'order', ids, order: 'move', pos: target });
        if (t === 200) sim.command({ type: 'possessStart', id: ids[0] });
        if (t >= 200 && t < 300) sim.command({ type: 'possessInput', move: { x: 0.2, y: 1 }, yawDelta: 0.02, sprint: t > 250, actions: { bite: false, dig: false, pickup: false, trail: false, recruit: false } });
        if (t === 300) sim.command({ type: 'possessStop' });
        if (t === 400) sim.world.dig(v3clone(sim.ants[5].pos), 2.5);
        sim.step();
        if (t % 100 === 99) hashes.push(sim.stateHash());
      }
      return hashes;
    };
    const a = run(42);
    const b = run(42);
    const c = run(43);
    expect(a).toEqual(b);
    expect(a[a.length - 1]).not.toBe(c[c.length - 1]);
  });
});

describe('registries', () => {
  it('system and behavior ids are unique and every command type has at most one owner', () => {
    expect(new Set(SYSTEMS.map((s) => s.id)).size).toBe(SYSTEMS.length);
    expect(new Set(BEHAVIORS.map((b) => b.id)).size).toBe(BEHAVIORS.length);
    const owners = new Map<string, string>();
    for (const s of SYSTEMS) for (const c of s.commands ?? []) {
      expect(owners.has(c), `${c} owned twice`).toBe(false);
      owners.set(c, s.id);
    }
  });
});

describe('simulation basics', () => {
  it('non-fixture start spawns a queen and workers in the nest', () => {
    const sim = makeSim('meadow', { fixture: 'none', small: true });
    const colony = sim.getColony(sim.playerColony)!;
    expect(sim.getAnt(colony.queenId)?.caste).toBe('queen');
    expect(sim.ants.length).toBe(11);
    for (let t = 0; t < 120; t++) sim.step();
    for (const a of sim.ants) expect(Math.hypot(a.pos.x - colony.nestPos.x, a.pos.y - colony.nestPos.y, a.pos.z - colony.nestPos.z)).toBeLessThan(14);
    expect(sim.foodSources.length).toBe(sim.map.foodSources.length);
  });

  it('events are buffered across ticks and drained once (D19)', () => {
    const sim = makeSim('gelFarm', { ants: 5, small: true });
    sim.drainEvents();
    sim.command({ type: 'debugSpawn', what: 'ant', pos: v3clone(sim.ants[0].pos), count: 3 });
    for (let t = 0; t < 5; t++) sim.step();
    const ev = sim.drainEvents();
    expect(ev.filter((e) => e.type === 'antSpawned').length).toBe(3);
    expect(sim.drainEvents().length).toBe(0);
    expect(sim.ants.length).toBe(8);
  });

  it('tombstones are swept at end of tick and ids are never reused', () => {
    const sim = makeSim('gelFarm', { ants: 5, small: true });
    const victim = sim.ants[2];
    const maxId = Math.max(...sim.ants.map((a) => a.id));
    sim.command({ type: 'debugKill', id: victim.id });
    sim.step();
    expect(sim.ants.length).toBe(4);
    expect(sim.getAnt(victim.id)).toBeUndefined();
    expect(sim.items.some((i) => i.itemKind === 'corpse')).toBe(true);
    sim.command({ type: 'debugSpawn', what: 'ant', pos: v3clone(sim.ants[0].pos) });
    sim.step();
    expect(sim.ants[sim.ants.length - 1].id).toBeGreaterThan(maxId);
  });

  it('pause and speed are host controls applied immediately', () => {
    const sim = makeSim('gelFarm', { ants: 1, small: true });
    sim.command({ type: 'setSpeed', speed: 4 });
    expect(sim.speed).toBe(4);
    sim.command({ type: 'pause', paused: true });
    expect(sim.paused).toBe(true);
  });
});

describe('orders and possession', () => {
  const noAct = { bite: false, dig: false, pickup: false, trail: false, recruit: false };

  it('a move order paths ants from the nest to the surface entrance', () => {
    const sim = makeSim('meadow', { fixture: 'none', small: true });
    const workers = sim.ants.filter((a) => a.caste === 'worker').slice(0, 4);
    const target = sim.map.spawns[0].entrance!;
    sim.command({ type: 'order', ids: workers.map((w) => w.id), order: 'move', pos: v3clone(target) });
    sim.step();
    expect(workers.every((w) => w.tasks.length === 1 && w.tasks[0].source === 'player')).toBe(true);
    // Ants return to colony duty as soon as the order completes (A2b), so track the player task
    // itself and record where each ant stood on the tick it was popped.
    const orders = new Map(workers.map((w) => [w.id, w.tasks[0]]));
    const doneAt = new Map<number, { x: number; y: number; z: number }>();
    for (let t = 0; t < 900 && doneAt.size < workers.length; t++) {
      sim.step();
      for (const w of workers) {
        if (!doneAt.has(w.id) && !w.tasks.includes(orders.get(w.id)!)) doneAt.set(w.id, v3clone(w.pos));
      }
    }
    for (const w of workers) {
      const p = doneAt.get(w.id);
      expect(p, `ant ${w.id} never completed its move order`).toBeDefined();
      expect(w.tasks.some((k) => k.source === 'player')).toBe(false);
      expect(Math.hypot(p!.x - target.x, p!.y - target.y, p!.z - target.z)).toBeLessThan(5);
    }
  });

  it('possession suspends the task queue, drives the ant by input, and release resumes it', () => {
    const sim = makeSim('meadow', { fixture: 'none', small: true });
    const ant = sim.ants.find((a) => a.caste === 'worker')!;
    const target = sim.map.spawns[0].entrance!;
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: v3clone(target) });
    sim.step();
    sim.command({ type: 'possessStart', id: ant.id } as Command);
    sim.step();
    expect(sim.possessedId).toBe(ant.id);
    expect(ant.possessed).toBe(true);
    const queued = ant.tasks.map((t) => t.id);

    // no input → stands still
    const p0 = v3clone(ant.pos);
    for (let t = 0; t < 20; t++) sim.step();
    expect(Math.hypot(ant.pos.x - p0.x, ant.pos.y - p0.y, ant.pos.z - p0.z)).toBeLessThan(0.05);

    // forward input → moves along its heading; yaw input turns it
    const f0 = v3clone(ant.forward);
    for (let t = 0; t < 20; t++) {
      sim.command({ type: 'possessInput', move: { x: 0, y: 1 }, yawDelta: 0, sprint: false, actions: noAct });
      sim.step();
    }
    expect(Math.hypot(ant.pos.x - p0.x, ant.pos.y - p0.y, ant.pos.z - p0.z)).toBeGreaterThan(0.8);
    sim.command({ type: 'possessInput', move: { x: 0, y: 0 }, yawDelta: Math.PI / 2, sprint: false, actions: noAct });
    sim.step();
    void f0;
    const turn = ant.forward.x * ant.prevForward.x + ant.forward.y * ant.prevForward.y + ant.forward.z * ant.prevForward.z;
    expect(Math.abs(turn)).toBeLessThan(0.2); // ~90° about local up
    expect(Math.abs(ant.forward.x * ant.up.x + ant.forward.y * ant.up.y + ant.forward.z * ant.up.z)).toBeLessThan(1e-3);

    // queue untouched while possessed
    expect(ant.tasks.map((t) => t.id)).toEqual(queued);

    sim.command({ type: 'possessStop' });
    sim.step();
    expect(sim.possessedId).toBe(0);
    expect(ant.possessed).toBe(false);
    for (let t = 0; t < 900 && ant.tasks.length > 0; t++) sim.step();
    expect(ant.tasks.length).toBe(0); // resumed and completed the order
    expect(Math.hypot(ant.pos.x - target.x, ant.pos.y - target.y, ant.pos.z - target.z)).toBeLessThan(5);
  });

  it('possession ends with an alert when the possessed ant dies', () => {
    const sim = makeSim('gelFarm', { ants: 3, small: true });
    const ant = sim.ants[0];
    sim.command({ type: 'possessStart', id: ant.id });
    sim.step();
    sim.drainEvents();
    sim.command({ type: 'debugKill', id: ant.id });
    sim.step();
    sim.step();
    const ev = sim.drainEvents();
    expect(sim.possessedId).toBe(0);
    expect(ev.some((e) => e.type === 'possession' && e.op === 'stop' && e.reason === 'died')).toBe(true);
    expect(ev.some((e) => e.type === 'alert' && e.code === 'possessedDied')).toBe(true);
  });

  it('digging the floor away makes ants fall and re-attach (D12)', () => {
    const sim = makeSim('meadow', { fixture: 'none', small: true });
    const ant = sim.ants.find((a) => a.caste === 'worker')!;
    for (let t = 0; t < 30; t++) sim.step();
    // open a shaft under the nest floor
    const p = v3clone(ant.pos);
    for (let i = 0; i < 4; i++) sim.world.dig({ x: p.x, y: p.y - 1 - i * 2, z: p.z }, 3.2);
    let fell = false;
    for (let t = 0; t < 200; t++) {
      sim.step();
      if (sim.drainEvents().some((e) => e.type === 'fell')) fell = true;
    }
    expect(fell).toBe(true);
    for (const a of sim.ants) {
      expect(a.falling).toBe(false);
      const s = sim.world.sample(a.pos.x, a.pos.y, a.pos.z);
      expect(s).toBeLessThan(0.1);
      expect(s).toBeGreaterThan(-1);
    }
  });
});
