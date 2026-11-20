import { describe, expect, it } from 'vitest';
import { ISO, Mat, Phero, b3StateOf, getMapExtras, keeperCommand, v3, type B3SimEvent, type SimEvent } from '../../core';
import type { Simulation } from '../Simulation';
import { makeSim } from '../testUtil';
import { keeperInvoke } from './keeper';

type Ev = SimEvent | B3SimEvent;

function run(sim: Simulation, ticks: number, out: Ev[] = []): Ev[] {
  for (let t = 0; t < ticks; t++) {
    sim.step();
    for (const e of sim.drainEvents() as Ev[]) out.push(e);
  }
  return out;
}
const keeperEvents = (evs: Ev[]) => evs.filter((e) => e.type === 'keeperEvent') as Extract<B3SimEvent, { type: 'keeperEvent' }>[];
const frozen = (evs: Ev[]) => evs.filter((e) => e.type === 'keeper') as Extract<SimEvent, { type: 'keeper' }>[];

function countMat(sim: Simulation, mat: number): number {
  const w = sim.world;
  let n = 0;
  for (let i = 0; i < w.density.length; i++) if (w.density[i] >= ISO && w.material[i] === mat) n++;
  return n;
}

describe('keeper', () => {
  it('is scheduled on farm maps only; player keeper commands work everywhere', () => {
    const farm = makeSim('sandFarm', { seed: 3, fixture: 'none' });
    expect(b3StateOf(farm).keeper.enabled).toBe(true);
    const meadow = makeSim('meadow', { seed: 3, fixture: 'none', small: true });
    expect(b3StateOf(meadow).keeper.enabled).toBe(false);
    meadow.command(keeperCommand('dropFood', { food: 'sugar', amount: 12 }));
    const evs = run(meadow, 2);
    expect(keeperEvents(evs).map((e) => [e.action, e.by, e.food, e.amount])).toEqual([['dropFood', 'player', 'sugar', 12]]);
  });

  it('food drops: seeds / sugar / fruit become food sources at the drop zone, a cricket is a carcass item', () => {
    const sim = makeSim('sandFarm', { seed: 3, fixture: 'none' });
    const zone = getMapExtras(sim.map)!.sites.find((s) => s.kind === 'dropZone' || s.kind === 'feedingDish')!;
    expect(zone).toBeDefined();
    for (const food of ['seeds', 'sugar', 'fruit'] as const) {
      const before = sim.foodSources.length;
      sim.command(keeperCommand('dropFood', { food, amount: 20 }));
      const evs = run(sim, 2);
      expect(sim.foodSources.length).toBe(before + 1);
      const f = sim.foodSources[sim.foodSources.length - 1];
      expect(f.foodKind).toBe(food);
      expect(f.amount).toBe(20);
      expect(Math.hypot(f.pos.x - zone.pos.x, f.pos.z - zone.pos.z)).toBeLessThan(zone.radius + 14);
      expect(frozen(evs)[0].action).toBe('dropFood');
      expect(keeperEvents(evs)[0].food).toBe(food);
    }
    const items = sim.items.length;
    sim.command(keeperCommand('dropFood', { food: 'cricket', amount: 15 }));
    run(sim, 2);
    expect(sim.items.length).toBe(items + 1);
    expect(sim.items[sim.items.length - 1].itemKind).toBe('corpse');
    expect(b3StateOf(sim).keeper.counts.dropFood).toBe(4);
    expect(b3StateOf(sim).keeper.last?.food).toBe('cricket');
  });

  it('feeds each faction what it can use: leaves for fungus farmers, a chunk of wood for termites', () => {
    const leaf = makeSim('sandFarm', { seed: 3, fixture: 'none', faction: 'leafcutter' });
    keeperInvoke(leaf, 'dropFood', {}, 'keeper');
    expect(leaf.foodSources.some((f) => f.foodKind === 'leaves')).toBe(true);
    const termite = makeSim('gelFarm', { seed: 3, fixture: 'none', faction: 'termite' });
    const wood0 = countMat(termite, Mat.Wood);
    keeperInvoke(termite, 'dropFood', {}, 'keeper');
    expect(countMat(termite, Mat.Wood)).toBeGreaterThan(wood0 + 5);
    expect(keeperEvents(run(termite, 1))[0].food).toBe('wood');
  });

  it('the scheduled keeper keeps a farm colony supplied', () => {
    const sim = makeSim('sandFarm', { seed: 3, fixture: 'none' });
    const evs = run(sim, 200 * 30);
    const drops = keeperEvents(evs).filter((e) => e.action === 'dropFood' && e.by === 'keeper');
    expect(drops.length).toBeGreaterThanOrEqual(2);
    expect(b3StateOf(sim).keeper.nextTick).toBeGreaterThan(0);
    expect(sim.getColony(1)!.stats.foodDelivered).toBeGreaterThan(0);
  });

  it('water dropper: water appears on the surface', () => {
    const sim = makeSim('sandFarm', { seed: 3, fixture: 'none' });
    expect(sim.water.floodedCount).toBe(0);
    sim.command(keeperCommand('dropWater', { amount: 30 }));
    const evs = run(sim, 3);
    let wet = 0;
    sim.water.forEachFlooded(() => wet++);
    expect(wet).toBeGreaterThan(0);
    expect(keeperEvents(evs)[0].action).toBe('dropWater');
    expect(frozen(evs)[0].action).toBe('dropWater');
  });

  it('desk lamp: toggles `weather.lamp` (a heat and light source) and reports on/off', () => {
    const sim = makeSim('gelFarm', { seed: 3, fixture: 'none' });
    sim.command(keeperCommand('lamp', { on: true }));
    let evs = run(sim, 2);
    const st = b3StateOf(sim).keeper;
    expect(st.lampOn).toBe(true);
    expect(sim.weather.lamp).not.toBeNull();
    expect(keeperEvents(evs)[0].on).toBe(true);
    sim.command(keeperCommand('lamp'));
    evs = run(sim, 2);
    expect(st.lampOn).toBe(false);
    expect(sim.weather.lamp).toBeNull();
    expect(keeperEvents(evs)[0].on).toBe(false);
  });

  it('glass tap: panic (alarm pheromone, slowed, re-thinking); a shake is stronger and knocks climbers off', () => {
    const sim = makeSim('sandFarm', { seed: 3, fixture: 'none' });
    run(sim, 60);
    const colony = sim.getColony(1)!;
    const alarm0 = sim.pheromones.activeCount(colony.id, Phero.alarm);
    sim.command(keeperCommand('tapGlass'));
    let evs = run(sim, 2);
    const st = b3StateOf(sim).keeper;
    expect(st.panic).toBeGreaterThan(0);
    const tapPanic = st.panic;
    expect(sim.pheromones.activeCount(colony.id, Phero.alarm)).toBeGreaterThan(alarm0);
    expect(evs.some((e) => e.type === 'pheromoneBurst')).toBe(true);
    expect(keeperEvents(evs)[0].action).toBe('tapGlass');
    expect(frozen(evs)[0].action).toBe('tapGlass');
    // put two ants on the glass (up vector horizontal) and shake
    const climbers = sim.ants.filter((a) => a.caste === 'worker').slice(0, 6);
    for (const a of climbers) {
      a.up.x = 0;
      a.up.y = 0;
      a.up.z = 1;
    }
    sim.command(keeperCommand('shake'));
    sim.step();
    evs = sim.drainEvents() as Ev[];
    expect(keeperEvents(evs)[0].action).toBe('shake');
    expect(st.panic).toBeGreaterThan(tapPanic);
    expect(evs.filter((e) => e.type === 'fell').length).toBeGreaterThan(0);
    // the panic passes
    run(sim, st.panic + 2);
    expect(st.panic).toBe(0);
  });

  it('tube connection: opening the port emits the event and puts a reward at the far end', () => {
    const sim = makeSim('sandFarm', { seed: 3, fixture: 'none' });
    const port = getMapExtras(sim.map)!.sites.find((s) => s.kind === 'tubePort')!;
    expect(port).toBeDefined();
    const before = sim.foodSources.length;
    sim.command(keeperCommand('openTube', { on: true }));
    const evs = run(sim, 2);
    const st = b3StateOf(sim).keeper;
    expect(st.tubeOpen).toBe(true);
    expect(st.tubePos).not.toBeNull();
    expect(sim.foodSources.length).toBe(before + 1);
    const ke = keeperEvents(evs)[0];
    expect(ke.action).toBe('openTube');
    expect(Math.hypot(ke.pos!.x - port.pos.x, ke.pos!.y - port.pos.y)).toBeLessThan(1);
    expect(frozen(evs)[0].on).toBe(true);
  });

  it('top-up: adds a layer of the farm\'s own material (gel on the gel farm, sand on the sand farm)', () => {
    for (const [map, mat] of [
      ['gelFarm', Mat.Gel],
      ['sandFarm', Mat.Sand],
    ] as const) {
      const sim = makeSim(map, { seed: 3, fixture: 'none' });
      const n0 = countMat(sim, mat);
      sim.command(keeperCommand('topUp', { pos: v3(sim.world.sx * 0.25, 0, sim.world.sz / 2) }));
      const evs = run(sim, 2);
      expect(countMat(sim, mat)).toBeGreaterThan(n0 + 10);
      const ke = keeperEvents(evs)[0];
      expect(ke.action).toBe('topUp');
      expect(ke.amount).toBeGreaterThan(10);
      expect(evs.some((e) => e.type === 'build')).toBe(true);
    }
  });

  it('contaminated food: looks like a drop, carries fungus spores', () => {
    const sim = makeSim('sandFarm', { seed: 3, fixture: 'none' });
    run(sim, 30);
    const colony = sim.getColony(1)!;
    const before = sim.foodSources.length;
    // right in the nest, so somebody is certainly near it
    const exposed0 = sim.ants.filter((a) => a.infection.stage !== 'none').length;
    sim.command(keeperCommand('contaminatedFood', { food: 'fruit', amount: 10, pos: v3(colony.nestPos.x, 0, colony.nestPos.z) }));
    const evs = run(sim, 2);
    expect(sim.foodSources.length).toBe(before + 1);
    const ke = keeperEvents(evs)[0];
    expect(ke.action).toBe('contaminatedFood');
    expect(frozen(evs)[0].action).toBe('dropFood'); // the frozen event cannot tell (neither can the player)
    expect(b3StateOf(sim).keeper.counts.contaminatedFood).toBe(1);
    // spores: either ants near the drop were dosed (B2 fungus) or an infected crumb lies there
    const dosed = sim.ants.filter((a) => a.infection.stage !== 'none' || a.infection.load > 0).length;
    const crumb = sim.items.some((i) => i.infected);
    expect(dosed > exposed0 || crumb).toBe(true);
  });
});
