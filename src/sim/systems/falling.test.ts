import { describe, expect, it } from 'vitest';
import { Mat, v3, type SimEvent } from '../../core';
import { a2aSim, flatWorld, spawnWorker } from './movementTestUtil';

/** D12: loss of support for movers and loose things. */

function shelfWorld() {
  // ground at y = 6 and a soil shelf (y 14..18) hanging over it
  const w = flatWorld(32, 28, 32, 6);
  for (let y = 10; y <= 22; y++)
    for (let z = 8; z < 24; z++)
      for (let x = 8; x < 24; x++) {
        const edge = Math.min(x + 0.5 - 8, 24 - (x + 0.5), z + 0.5 - 8, 24 - (z + 0.5));
        w.setCell(x, y, z, Math.max(6 - (y + 0.5), Math.min(18 - (y + 0.5), y + 0.5 - 14, edge)), Mat.Soil);
      }
  w.markAllDirty();
  return w;
}

describe('falling (D12)', () => {
  it('an ant whose ground is dug away falls, lands, re-attaches and walks on', () => {
    const w = shelfWorld();
    const sim = a2aSim(w, v3(4, 6.5, 4));
    const ant = spawnWorker(sim, v3(16.5, 18.5, 16.5));
    for (let t = 0; t < 10; t++) sim.step();
    expect(ant.pos.y).toBeGreaterThan(17.5);
    expect(ant.falling).toBe(false);
    for (let i = 0; i < 4; i++) w.dig({ x: 16.5, y: 16, z: 16.5 }, 4.5);
    const events: SimEvent[] = [];
    let fellTicks = 0;
    let maxDrop = 0;
    for (let t = 0; t < 200; t++) {
      const y0 = ant.pos.y;
      sim.step();
      maxDrop = Math.max(maxDrop, y0 - ant.pos.y);
      if (ant.falling) fellTicks++;
      events.push(...sim.drainEvents());
    }
    expect(events.filter((e) => e.type === 'fell' && e.id === ant.id).length).toBe(1);
    expect(fellTicks).toBeGreaterThan(10); // it took a while: a fall, not a teleport
    expect(maxDrop).toBeLessThan(0.8); // 0.3 per tick of fall plus the touch-down settle
    expect(ant.falling).toBe(false);
    expect(ant.alive).toBe(true);
    expect(ant.health).toBe(ant.maxHealth); // no fall damage
    expect(ant.pos.y).toBeLessThan(7);
    expect(ant.up.y).toBeGreaterThan(0.9);
    expect(sim.nav.isWalkable(ant.cell)).toBe(true);
    // and it can walk again
    ant.intent.mode = 'dir';
    ant.intent.dir.x = 1;
    ant.intent.dir.z = 0;
    const x0 = ant.pos.x;
    for (let t = 0; t < 60; t++) sim.step();
    expect(ant.pos.x).toBeGreaterThan(x0 + 3);
  });

  it('items, corpses and brood fall when undermined and come to rest on the ground', () => {
    const w = shelfWorld();
    const sim = a2aSim(w, v3(4, 6.5, 4));
    const food = sim.spawnItem('food', 1, v3(15.5, 18.1, 16.5));
    const corpse = sim.spawnItem('corpse', 1, v3(17.5, 18.1, 15.5));
    const egg = sim.spawnBrood(sim.playerColony, 'worker', v3(16.5, 18.1, 17.5));
    const safe = sim.spawnItem('food', 1, v3(4.5, 6.1, 20.5));
    for (let t = 0; t < 40; t++) sim.step();
    for (const e of [food, corpse, egg]) expect(e.pos.y).toBeGreaterThan(17.5);
    for (let i = 0; i < 4; i++) w.dig({ x: 16.5, y: 16, z: 16.5 }, 4.5);
    sim.step();
    expect(food.falling).toBe(true); // noticed on the very next tick, not at the next periodic check
    const safeY = safe.pos.y;
    for (let t = 0; t < 200; t++) sim.step();
    for (const e of [food, corpse, egg]) {
      expect(e.alive).toBe(true);
      expect(e.pos.y).toBeLessThan(7);
      expect(e.pos.y).toBeGreaterThan(5.9);
      expect(sim.nav.isWalkable(e.cell)).toBe(true);
      expect(w.sample(e.pos.x, e.pos.y, e.pos.z)).toBeLessThan(0.05);
    }
    expect(food.falling).toBe(false);
    expect(corpse.falling).toBe(false);
    expect(safe.pos.y).toBe(safeY); // things with solid ground under them do not move
    expect(safe.falling).toBe(false);
  });

  it('carried things do not fall; things buried by a fill are lifted out', () => {
    const w = shelfWorld();
    const sim = a2aSim(w, v3(4, 6.5, 4));
    const ant = spawnWorker(sim, v3(4.5, 6.5, 4.5));
    const carried = sim.spawnItem('food', 1, v3(16.5, 22, 16.5)); // "in the air", but carried
    carried.carriedBy = ant.id;
    const y = carried.pos.y;
    const buried = sim.spawnItem('food', 1, v3(10.5, 6.1, 26.5));
    for (let t = 0; t < 40; t++) sim.step();
    expect(carried.pos.y).toBe(y);
    expect(carried.falling).toBe(false);
    w.fill({ x: 10.5, y: 7, z: 26.5 }, 3, Mat.Soil);
    expect(w.sample(buried.pos.x, buried.pos.y, buried.pos.z)).toBeGreaterThan(0.5);
    for (let t = 0; t < 3; t++) sim.step();
    expect(w.sample(buried.pos.x, buried.pos.y, buried.pos.z)).toBeLessThan(0.05);
    expect(sim.nav.isWalkable(buried.cell)).toBe(true);
  });
});
