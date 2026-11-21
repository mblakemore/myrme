import { describe, expect, it } from 'vitest';
import type { Ant, Vec3 } from '../core';
import { BALANCE } from './data/balance';
import { makeFullGame } from './fullGameKit';
import type { Simulation } from './Simulation';
import { noteDanger } from './systems/colonyState';
import { spawnCreatureAt } from './systems/creatures';

/**
 * Regressions for three player reports: ants spinning on the spot at sharp edges (the nest
 * entrance lip), "zombie" ants that stop responding, and attack orders / attack beacons that
 * never let go of the ants.
 */
function run(sim: Simulation, ticks: number, each?: (t: number) => void): void {
  for (let t = 0; t < ticks; t++) {
    each?.(t);
    sim.step();
    sim.drainEvents();
  }
}
const mine = (sim: Simulation): Ant[] => sim.ants.filter((a) => a.alive && a.colony === sim.playerColony && a.caste !== 'queen' && a.caste !== 'king');
const workers = (sim: Simulation): Ant[] => mine(sim).filter((a) => a.caste === 'worker' && a.locomotion === 'surface' && !a.possessed && a.infection.stage === 'none');
const d3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const B = BALANCE.a2b;

/** Ants that rotate a lot over 3 s windows while barely moving (and are trying to go somewhere). */
function countSpinners(sim: Simulation, ticks: number): { ants: number; windows: number; total: number } {
  const st = new Map<number, { x: Vec3; f: Vec3; rot: number; n: number }>();
  const spinners = new Set<number>();
  let windows = 0;
  let total = 0;
  run(sim, ticks, () => {
    for (const a of sim.ants) {
      if (!a.alive || a.possessed || a.locomotion !== 'surface') continue;
      const s = st.get(a.id);
      if (!s) {
        st.set(a.id, { x: { ...a.pos }, f: { ...a.forward }, rot: 0, n: 0 });
        continue;
      }
      s.rot += Math.acos(Math.max(-1, Math.min(1, s.f.x * a.forward.x + s.f.y * a.forward.y + s.f.z * a.forward.z)));
      s.f = { ...a.forward };
      if (++s.n < 90) continue;
      total++;
      const trying = a.intent.mode === 'goto' || (a.intent.mode === 'dir' && a.intent.speedMul > 0.5);
      if (trying && d3(a.pos, s.x) < 0.3 && s.rot > 6) {
        windows++;
        spinners.add(a.id);
      }
      s.x = { ...a.pos };
      s.rot = 0;
      s.n = 0;
    }
  });
  return { ants: spinners.size, windows, total };
}

describe('ants do not spin at the nest-entrance lip', () => {
  it('meadow seed 1 (whose lip used to trap homing foragers): next to no spinning ants over 5 minutes', () => {
    // before the homing fix: ~12 ants / 200+ spin windows here, all at the entrance rim
    const sim = makeFullGame('meadow', { seed: 1, faction: 'gardenAnt', difficulty: 'normal' });
    const r = countSpinners(sim, 5 * 60 * 30);
    expect(r.total).toBeGreaterThan(1000);
    expect(r.windows, JSON.stringify(r)).toBeLessThanOrEqual(6);
  });
});

describe('orders reach ants mid-game', () => {
  it('move / gather / attack given to random mid-game workers take effect', () => {
    const sim = makeFullGame('meadow', { seed: 2, faction: 'gardenAnt', difficulty: 'normal' });
    run(sim, 3 * 60 * 30);
    const colony = sim.getColony(sim.playerColony)!;
    const entr = sim.world.cellCenter(colony.entrances[0], { x: 0, y: 0, z: 0 });
    const pool = workers(sim);
    expect(pool.length).toBeGreaterThan(8);
    // deterministic "random" picks spread over the whole population
    const pick = (k: number, off: number): Ant[] => Array.from({ length: k }, (_, i) => pool[(i * 7 + off) % pool.length]).filter((a, i, l) => l.indexOf(a) === i);

    // move: to a walkable spot near the entrance
    const movers = pick(4, 0);
    const goalCell = sim.nav.nearestWalkable(entr.x + 6, entr.y, entr.z + 4, 6, 0.5);
    expect(goalCell).toBeGreaterThanOrEqual(0);
    const goal = sim.world.cellCenter(goalCell, { x: 0, y: 0, z: 0 });
    sim.command({ type: 'order', ids: movers.map((a) => a.id), order: 'move', pos: goal, cell: goalCell });
    // gather: a food source near the nest, inside a fresh danger zone (a player order overrides it)
    const food = [...sim.foodSources].filter((f) => f.amount > 3).sort((a, b) => d3(a.pos, entr) - d3(b.pos, entr))[0];
    expect(food).toBeTruthy();
    const gatherers = pick(4, 3).filter((a) => !movers.includes(a));
    sim.command({ type: 'order', ids: gatherers.map((a) => a.id), order: 'gather', targetId: food.id, pos: { ...food.pos } });
    noteDanger(sim, sim.playerColony, food.pos);
    // attack: a spider near the entrance
    const spider = spawnCreatureAt(sim, 'jumpingSpider', { x: entr.x - 5, y: entr.y + 1, z: entr.z - 5 });
    const attackers = pick(5, 5).filter((a) => !movers.includes(a) && !gatherers.includes(a));
    sim.command({ type: 'order', ids: attackers.map((a) => a.id), order: 'attack', targetId: spider.id });

    let moved = 0;
    const touchedFood = new Set<number>();
    const engaged = new Set<number>();
    run(sim, 60 * 30, () => {
      for (const a of movers) if (a.alive && d3(a.pos, goal) < 2.5) a.mem['t.arr'] = 1;
      for (const a of gatherers) if (a.alive && (d3(a.pos, food.pos) < food.radius + 2.5 || a.carrying?.kind === 'item')) touchedFood.add(a.id);
      for (const a of attackers) if (a.alive && (!spider.alive || d3(a.pos, spider.pos) < B.attackRange + 1.5)) engaged.add(a.id);
    });
    moved = movers.filter((a) => a.mem['t.arr'] === 1 || !a.alive).length;
    expect(moved, 'move orders').toBe(movers.length);
    expect(touchedFood.size, 'gather orders (inside a danger zone)').toBeGreaterThanOrEqual(gatherers.length - 1);
    expect(engaged.size, 'attack orders').toBeGreaterThanOrEqual(attackers.length - 1);
  });

  it('a gather order is not dropped because the food lies in a danger zone', () => {
    const sim = makeFullGame('meadow', { seed: 2, faction: 'gardenAnt', difficulty: 'normal' });
    run(sim, 60 * 30);
    const colony = sim.getColony(sim.playerColony)!;
    const entr = sim.world.cellCenter(colony.entrances[0], { x: 0, y: 0, z: 0 });
    const food = [...sim.foodSources].filter((f) => f.amount > 3).sort((a, b) => d3(a.pos, entr) - d3(b.pos, entr))[0];
    noteDanger(sim, sim.playerColony, food.pos);
    const ws = workers(sim).slice(0, 3);
    sim.command({ type: 'order', ids: ws.map((a) => a.id), order: 'gather', targetId: food.id, pos: { ...food.pos } });
    run(sim, 30);
    for (const a of ws) expect(a.tasks.some((t) => t.source === 'player' && t.kind === 'gather'), `ant ${a.id} kept its gather order`).toBe(true);
  });
});

describe('attack orders and attack beacons let go', () => {
  const setup = () => {
    const sim = makeFullGame('meadow', { seed: 2, faction: 'gardenAnt', difficulty: 'normal' });
    run(sim, 60 * 30);
    const colony = sim.getColony(sim.playerColony)!;
    const entr = sim.world.cellCenter(colony.entrances[0], { x: 0, y: 0, z: 0 });
    const at = { x: entr.x - 5, y: entr.y + 1, z: entr.z - 5 };
    return { sim, colony, entr, at, ws: workers(sim).slice(0, 4) };
  };
  const hasAttack = (a: Ant) => a.tasks.some((t) => t.source === 'player' && t.kind === 'attack');

  it('ends when the target dies', () => {
    const { sim, at, ws } = setup();
    const spider = spawnCreatureAt(sim, 'jumpingSpider', at);
    sim.command({ type: 'order', ids: ws.map((a) => a.id), order: 'attack', targetId: spider.id });
    run(sim, 10);
    expect(ws.every(hasAttack)).toBe(true);
    sim.killCreature(spider);
    run(sim, 30);
    expect(ws.some(hasAttack)).toBe(false);
    expect(ws.every((a) => a.targetId !== spider.id)).toBe(true);
  });

  it('ends when the target runs beyond the leash, or stays out of reach too long', () => {
    const { sim, at, ws } = setup();
    const spider = spawnCreatureAt(sim, 'jumpingSpider', at);
    sim.command({ type: 'order', ids: [ws[0].id, ws[1].id], order: 'attack', targetId: spider.id });
    run(sim, 10);
    // leash: the target is carried far off
    const far = sim.world.cellCenter(sim.nav.nearestWalkable(at.x + B.attackLeash + 15, at.y, at.z, 12, 0.5), { x: 0, y: 0, z: 0 });
    spider.pos.x = far.x;
    spider.pos.y = far.y;
    spider.pos.z = far.z;
    run(sim, 20);
    expect(hasAttack(ws[0]) || hasAttack(ws[1])).toBe(false);

    // give-up: a target the ant has not been within reach of for attackGiveUp seconds (it cannot
    // get there, or cannot catch it) — the order is dropped
    const spider2 = spawnCreatureAt(sim, 'jumpingSpider', at);
    const ant = ws[2];
    sim.command({ type: 'order', ids: [ant.id], order: 'attack', targetId: spider2.id });
    run(sim, 2);
    expect(hasAttack(ant)).toBe(true);
    if (d3(ant.pos, spider2.pos) > B.attackRange + 1.5) {
      ant.mem['po.near'] = sim.tick - B.attackGiveUp * 30 + 15;
      run(sim, 10);
      expect(hasAttack(ant), 'still trying just before the give-up time').toBe(true);
      run(sim, 20);
      expect(hasAttack(ant), 'given up').toBe(false);
    }
  });

  it('a new order overrides an attack order immediately, and frees the ant from beacons', () => {
    const { sim, entr, at, ws } = setup();
    const spider = spawnCreatureAt(sim, 'jumpingSpider', at);
    sim.command({ type: 'order', ids: [ws[0].id], order: 'attack', targetId: spider.id });
    run(sim, 5);
    ws[0].mem['beacon'] = 99;
    const goalCell = sim.nav.nearestWalkable(entr.x + 6, entr.y, entr.z + 4, 6, 0.5);
    sim.command({ type: 'order', ids: [ws[0].id], order: 'move', pos: sim.world.cellCenter(goalCell, { x: 0, y: 0, z: 0 }), cell: goalCell });
    run(sim, 2);
    expect(hasAttack(ws[0])).toBe(false);
    expect(ws[0].tasks[0]?.kind).toBe('move');
    expect(ws[0].mem['beacon'] ?? 0).toBe(0);
    expect(ws[0].mem['bc.no'] ?? 0).toBeGreaterThan(sim.tick);
  });

  it('an attack beacon with nothing hostile near it expires and its ants go back to work', () => {
    const { sim, colony, entr } = setup();
    const pos = { x: entr.x + 4, y: entr.y, z: entr.z + 4 };
    sim.command({ type: 'beacon', op: 'place', kind: 'attack', pos });
    run(sim, 5);
    expect(colony.beacons.some((b) => b.kind === 'attack')).toBe(true);
    let drafted = 0;
    run(sim, 15 * 30, () => {
      drafted = Math.max(drafted, mine(sim).filter((a) => (a.mem['beacon'] ?? 0) > 0).length);
    });
    expect(drafted).toBeGreaterThan(0);
    run(sim, (B.attackBeaconIdle + 15) * 30);
    expect(colony.beacons.some((b) => b.kind === 'attack'), 'beacon expired').toBe(false);
    run(sim, 10 * 30);
    expect(mine(sim).filter((a) => (a.mem['beacon'] ?? 0) > 0).length, 'ants released').toBe(0);
  });

  it('an attack beacon expires after its life even if something keeps it busy', () => {
    const { sim, colony, at } = setup();
    sim.command({ type: 'beacon', op: 'place', kind: 'attack', pos: at });
    run(sim, 5);
    const b = colony.beacons.find((x) => x.kind === 'attack')!;
    expect(b).toBeTruthy();
    b.createdTick = sim.tick - B.attackBeaconLife * 30 - 1;
    run(sim, 30);
    expect(colony.beacons.includes(b)).toBe(false);
  });
});

describe('brain watchdog', () => {
  it('an ant wedged on the way somewhere re-plans, then drops the task, and gets on with life', () => {
    const sim = makeFullGame('meadow', { seed: 2, faction: 'gardenAnt', difficulty: 'normal' });
    run(sim, 60 * 30);
    const colony = sim.getColony(sim.playerColony)!;
    const entr = sim.world.cellCenter(colony.entrances[0], { x: 0, y: 0, z: 0 });
    const ant = workers(sim)[3];
    const goalCell = sim.nav.nearestWalkable(entr.x + 12, entr.y, entr.z + 8, 8, 0.5);
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: sim.world.cellCenter(goalCell, { x: 0, y: 0, z: 0 }), cell: goalCell });
    run(sim, 2);
    expect(ant.tasks[0]?.kind).toBe('move');
    const pin = { ...ant.pos };
    const c0 = ant.mem['wd.c'] ?? 0;
    let dropped = -1;
    run(sim, (B.watchdogSeconds * 2 + 5) * 30, (t) => {
      ant.pos.x = pin.x;
      ant.pos.y = pin.y;
      ant.pos.z = pin.z;
      if (dropped < 0 && !ant.tasks.some((x) => x.kind === 'move')) dropped = t;
    });
    expect((ant.mem['wd.c'] ?? 0) - c0).toBeGreaterThanOrEqual(2);
    expect(dropped).toBeGreaterThan(B.watchdogSeconds * 30);
    expect(ant.alive).toBe(true);
  });
});
