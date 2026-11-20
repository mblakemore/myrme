import { describe, expect, it } from 'vitest';
import { Mat, NO_DROWN_KEY, b3StateOf, envOf, v3, type Ant, type NavEx, type RaftState } from '../../core';
import { syncPrev } from '../entities';
import type { Simulation } from '../Simulation';
import { GROUND, makeB3Sim } from './goalsTestKit';
import { snapToSurface } from './movementCrawl';
import { makeFullGame } from '../fullGameKit';
import { waterSurfaceAt } from './raft';

const POND = v3(18, GROUND - 4, 18);

/** A clay world with a steep pond basin; the queen, some workers and brood are put on its floor. */
function pondSim(faction: 'fireAnt' | 'gardenAnt'): { sim: Simulation; crew: Ant[]; queen: Ant; brood: number[] } {
  const sim = makeB3Sim({
    faction,
    seed: 9,
    size: 64,
    material: Mat.Clay,
    prepare: (map) => {
      for (let y = GROUND + 1; y >= GROUND - 4; y -= 1) map.world.dig(v3(POND.x, y, POND.z), 5.5);
    },
  });
  const nav = sim.nav as NavEx;
  sim.nav.updateFields(sim.tick);
  const queen = sim.ants.find((a) => a.caste === 'queen')!;
  const crew = sim.ants.filter((a) => a.caste === 'worker').slice(0, 8);
  let i = 0;
  for (const a of [queen, ...crew]) {
    const ang = i * 2.4;
    a.pos.x = POND.x + Math.cos(ang) * 1.5 * Math.sqrt(i);
    a.pos.y = GROUND - 7;
    a.pos.z = POND.z + Math.sin(ang) * 1.5 * Math.sqrt(i);
    if (!snapToSurface(sim.world, nav, a, 6)) throw new Error('no floor in the pond');
    syncPrev(a);
    i++;
  }
  const brood: number[] = [];
  for (let k = 0; k < 4; k++) {
    const b = sim.spawnBrood(1, 'worker', v3(queen.pos.x + (k - 1.5) * 0.4, queen.pos.y, queen.pos.z + 0.5));
    b.cell = queen.cell;
    brood.push(b.id);
  }
  return { sim, crew, queen, brood };
}

/** Fill the pond to just below its rim (and keep it topped up against seepage). */
function pour(sim: Simulation): void {
  const level = waterSurfaceAt(sim, POND.x + 1, GROUND - 4, POND.z + 1);
  if (level < GROUND - 1.3) sim.water.addWater(sim.world.cellAt(POND.x, GROUND - 6, POND.z), 4);
}

describe('fire-ant rafts', () => {
  it('link into a raft when flooded, float up with the water carrying queen and brood, and land on dry ground', () => {
    const { sim, crew, queen, brood } = pondSim('fireAnt');
    const nav = sim.nav as NavEx;
    const rafts = b3StateOf(sim).rafts;
    const ops: string[] = [];
    const drowned: number[] = [];
    let raft: RaftState | null = null;
    let y0 = 0;
    let yMax = -1;
    let ridersSeen: number[] = [];
    let landedAt = -1;
    let lastMembers: number[] = [];
    let bad = '';
    for (let t = 0; t < 150 * 30 && landedAt < 0; t++) {
      pour(sim);
      // keep the crew where the flood is until they have linked up
      if (!raft) for (const a of [queen, ...crew]) a.thinkAt = sim.tick + 60;
      sim.step();
      for (const e of sim.drainEvents()) {
        const ev = e as { type: string; op?: string };
        if (ev.type === 'raft') {
          ops.push(ev.op!);
          if (ev.op === 'landed') landedAt = t;
        }
        if (e.type === 'antDied') drowned.push(e.id);
      }
      if (!raft && rafts.length > 0) {
        raft = rafts[0];
        y0 = raft.pos.y;
        ridersSeen = [...raft.riders];
      }
      if (raft && rafts.includes(raft)) {
        yMax = Math.max(yMax, raft.pos.y);
        lastMembers = [...raft.members];
        for (const id of raft.members) {
          const a = sim.getEntity(id) as Ant;
          if ((a.anim !== 'raft' || (a.behavior !== 'raft' && crew.includes(a))) && sim.tick - raft.formedTick >= 5 && !bad) bad = `${a.anim}/${a.behavior} +${sim.tick - raft.formedTick}`;
          // seated on the surface, not under it
          expect(Math.abs(a.pos.y - raft.pos.y)).toBeLessThan(0.6);
          expect(a.mem[NO_DROWN_KEY]).toBe(1);
        }
      }
    }
    expect(ops[0]).toBe('formed');
    expect(raft).not.toBeNull();
    expect(raft!.members.length).toBeGreaterThanOrEqual(4);
    expect(ridersSeen).toContain(queen.id);
    for (const id of brood) expect(ridersSeen).toContain(id);
    expect(bad).toBe('');
    // it rose with the water…
    expect(yMax).toBeGreaterThan(y0 + 2);
    // …and dissolved on the shore
    expect(ops).toContain('landed');
    expect(rafts.length).toBe(0);
    expect(drowned).toEqual([]);
    expect(queen.alive).toBe(true);
    sim.step();
    expect(lastMembers.length).toBeGreaterThanOrEqual(4);
    for (const id of [queen.id, ...lastMembers]) {
      const a = sim.getEntity(id) as Ant;
      expect(a.alive).toBe(true);
      expect(a.mem['raft'] ?? 0).toBe(0);
      expect(a.anim).not.toBe('raft');
      expect(a.cell >= 0 && sim.water.depthAt(a.cell) < 0.5).toBe(true);
      expect(nav.isWalkable(nav.nearestWalkable(a.pos.x, a.pos.y, a.pos.z, 2))).toBe(true);
    }
    for (const id of brood) {
      const b = sim.getEntity(id)!;
      expect(b.alive).toBe(true);
      expect(sim.water.depthAt(b.cell)).toBeLessThan(0.5);
    }
    expect(waterSurfaceAt(sim, POND.x, GROUND - 1, POND.z)).toBeGreaterThan(GROUND - 3);
  });

  it('species without the flag do not raft: they are left swimming (and drowning) in the same flood', () => {
    const { sim, crew, queen } = pondSim('gardenAnt');
    let swum = 0;
    for (let t = 0; t < 30 * 30; t++) {
      pour(sim);
      sim.step();
      sim.drainEvents();
      for (const a of [queen, ...crew]) swum = Math.max(swum, a.submerged);
      expect(b3StateOf(sim).rafts.length).toBe(0);
    }
    expect(swum).toBeGreaterThan(20);
    expect(sim.ants.some((a) => a.anim === 'raft')).toBe(false);
  });
  it(
    'final round: a flooded fire-ant nest in a real game makes one big raft — queen and brood ride, the workers around join, nobody drowns',
    () => {
      const sim = makeFullGame('meadow', { seed: 1, faction: 'fireAnt', difficulty: 'peaceful' });
      for (let t = 0; t < 1800 * 5; t++) sim.step();
      sim.drainEvents();
      const col = sim.getColony(sim.playerColony)!;
      const env = envOf(sim)!;
      const workers = sim.ants.filter((a) => a.colony === col.id && a.caste !== 'queen').length;
      expect(workers).toBeGreaterThanOrEqual(20);
      let maxMembers = 0;
      let queenRode = false;
      let broodRode = 0;
      let formed = 0;
      let drowned = 0;
      for (let t = 0; t < 30 * 150; t++) {
        // a pipe bursts into the queen's chamber for a minute and a half
        if (t < 30 * 90 && t % 10 === 0) env.addWater(col.nestPos, 3);
        sim.step();
        for (const e of sim.drainEvents()) {
          const ev = e as { type: string; op?: string; cause?: string };
          if (ev.type === 'raft' && ev.op === 'formed') formed++;
          if (ev.type === 'antDied' && ev.cause === 'drowning') drowned++;
        }
        for (const r of b3StateOf(sim).rafts) {
          if (r.members.length > maxMembers) maxMembers = r.members.length;
          if (r.riders.includes(col.queenId)) queenRode = true;
          const n = r.riders.filter((id) => sim.getEntity(id)?.kind === 'brood').length;
          if (n > broodRode) broodRode = n;
        }
      }
      console.log(`[raft] real nest flood: ${workers} workers, rafts formed ${formed}, max members ${maxMembers}, brood aboard ${broodRode}, queen aboard ${queenRode}, drowned ${drowned}`);
      expect(formed).toBeGreaterThan(0);
      expect(maxMembers).toBeGreaterThanOrEqual(10);
      expect(queenRode).toBe(true);
      expect(broodRode).toBeGreaterThanOrEqual(4);
      expect(drowned).toBe(0);
      expect(sim.getAnt(col.queenId)).toBeTruthy();
    },
    120_000,
  );
});
