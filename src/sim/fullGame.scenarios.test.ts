import { describe, expect, it } from 'vitest';
import { COMBAT_MEM, type Ant, type CasteId, type NavEx, type SpeciesId } from '../core';
import { makeFullGame, runFullGame } from './fullGameKit';
import type { Simulation } from './Simulation';

/**
 * M3 cross-stream scenarios on the real maps with everything on: things no single stream's unit
 * test covers because they need two or more systems to meet (possession × factions × infection,
 * player orders × weather shelter, fungus × population counts, beacons × rival colonies × goals).
 */
function run(sim: Simulation, ticks: number, each?: (t: number) => void): void {
  for (let t = 0; t < ticks; t++) {
    each?.(t);
    sim.step();
    sim.drainEvents();
  }
}

const mine = (sim: Simulation, caste?: CasteId): Ant[] => sim.ants.filter((a) => a.alive && a.colony === sim.playerColony && (!caste || a.caste === caste));
const finite = (a: Ant): boolean => Number.isFinite(a.pos.x + a.pos.y + a.pos.z + a.up.x + a.up.y + a.up.z + a.forward.x + a.forward.y + a.forward.z + a.health);

describe('possession works for every faction and caste', () => {
  for (const faction of ['gardenAnt', 'fireAnt', 'leafcutter', 'termite'] as SpeciesId[]) {
    it(`${faction}: queen, fighters, alate and an infected ant can be driven; every action button is safe`, () => {
      const sim = makeFullGame('meadow', { seed: 3, faction, difficulty: 'peaceful' });
      run(sim, 90);
      const colony = sim.getColony(sim.playerColony)!;
      // one of each extra caste next to the nest, plus an enemy to bite / glue
      const at = { ...mine(sim).find((a) => a.caste !== 'queen' && a.caste !== 'king')!.pos };
      const extra: CasteId[] = faction === 'termite' ? ['soldier', 'nasute', 'alate'] : faction === 'leafcutter' ? ['soldier', 'major', 'alate'] : ['soldier', 'alate'];
      for (const caste of extra) sim.command({ type: 'debugSpawn', what: 'ant', caste, pos: at });
      run(sim, 5);
      const subjects: Ant[] = [sim.getAnt(colony.queenId)!, mine(sim, 'worker')[0]];
      for (const caste of extra) subjects.push(mine(sim, caste)[0]);
      const sick = mine(sim, 'worker')[1];
      sim.command({ type: 'debugInfect', id: sick.id, stage: 'erratic' });
      subjects.push(sick);
      let started = 0;
      for (const ant of subjects) {
        expect(ant, `${faction} subject`).toBeTruthy();
        const p0 = { ...ant.pos };
        sim.command({ type: 'possessStart', id: ant.id });
        run(sim, 2);
        const ok = sim.ants.some((a) => a.possessed && a.id === ant.id);
        if (ok) started++;
        // walk forward, turn, press every button in turn (pickup twice = pick up then drop)
        run(sim, 150, (t) => {
          const k = Math.floor(t / 15) % 6;
          sim.command({ type: 'possessInput', move: { x: 0, y: 1 }, yawDelta: t % 40 === 0 ? 0.4 : 0, sprint: t > 75, actions: { bite: k === 0, dig: k === 1, pickup: (k === 2 || k === 3) && t % 15 === 0, trail: k === 4, recruit: k === 5 && t % 15 === 0 } });
        });
        const now = sim.getAnt(ant.id);
        if (now) {
          expect(finite(now), `${faction}:${ant.caste} pose`).toBe(true);
          if (ok && now.caste !== 'queen' && now.caste !== 'king' && now.infection.stage === 'none') expect(Math.hypot(now.pos.x - p0.x, now.pos.y - p0.y, now.pos.z - p0.z), `${faction}:${ant.caste} moved`).toBeGreaterThan(0.5);
        }
        sim.command({ type: 'possessStop' });
        run(sim, 2);
        expect(sim.ants.some((a) => a.possessed)).toBe(false);
      }
      // healthy castes must all be possessable (an infected ant may legitimately be refused)
      expect(started).toBeGreaterThanOrEqual(subjects.length - 1);
      for (const a of sim.ants) expect(finite(a)).toBe(true);
    });
  }

  it('a possessed nasute glues its target at range with the bite button', () => {
    const sim = makeFullGame('meadow', { seed: 3, faction: 'termite', difficulty: 'peaceful' });
    run(sim, 60);
    const w = mine(sim, 'worker')[0];
    sim.command({ type: 'debugSpawn', what: 'ant', caste: 'nasute', pos: { ...w.pos } });
    run(sim, 5);
    const nasute = mine(sim, 'nasute')[0];
    // an enemy three voxels ahead of it
    const foePos = { x: nasute.pos.x + nasute.forward.x * 3, y: nasute.pos.y + nasute.forward.y * 3, z: nasute.pos.z + nasute.forward.z * 3 };
    sim.command({ type: 'debugSpawn', what: 'ant', caste: 'worker', colony: 99, pos: foePos });
    sim.command({ type: 'possessStart', id: nasute.id });
    let glued = false;
    let attacks = 0;
    for (let t = 0; t < 240 && !glued; t++) {
      sim.command({ type: 'possessInput', move: { x: 0, y: 0 }, yawDelta: 0, sprint: false, actions: { bite: t % 10 === 0, dig: false, pickup: false, trail: false, recruit: false } });
      sim.step();
      for (const e of sim.drainEvents()) if (e.type === 'attack' && e.attacker === nasute.id) attacks++;
      for (const a of sim.ants) if (a.colony !== sim.playerColony && (a.mem[COMBAT_MEM.glued] ?? 0) > sim.tick) glued = true;
    }
    expect(attacks).toBeGreaterThan(0);
    expect(glued).toBe(true);
  });
});

describe('orders, weather and fungus meet', () => {
  it('a player move order outranks the rain shelter signal', () => {
    const sim = makeFullGame('meadow', { seed: 2, difficulty: 'peaceful' });
    run(sim, 300);
    sim.command({ type: 'debugWeather', kind: 'rain', intensity: 1 });
    run(sim, 600);
    const colony = sim.getColony(sim.playerColony)!;
    const nav = sim.nav as NavEx;
    const ant = mine(sim, 'worker')[0];
    // a walkable, exposed spot some way from the nest
    let goal = -1;
    for (let r = 14; r <= 26 && goal < 0; r += 4) {
      const c = nav.nearestWalkable(colony.nestPos.x + r, colony.nestPos.y + 12, colony.nestPos.z + r * 0.5, 14);
      if (c >= 0 && nav.isExposed(c) && nav.homeDistance(colony.id, c) < 1e6) goal = c;
    }
    expect(goal).toBeGreaterThanOrEqual(0);
    const gp = sim.world.cellCenter(goal, { x: 0, y: 0, z: 0 });
    const d0 = Math.hypot(ant.pos.x - gp.x, ant.pos.y - gp.y, ant.pos.z - gp.z);
    sim.command({ type: 'order', ids: [ant.id], order: 'move', pos: gp, cell: goal });
    let best = d0;
    let sheltering = 0;
    run(sim, 900, () => {
      const a = sim.getAnt(ant.id);
      if (!a) return;
      best = Math.min(best, Math.hypot(a.pos.x - gp.x, a.pos.y - gp.y, a.pos.z - gp.z));
      if (a.behavior === 'seekShade' && best > 3) sheltering++;
    });
    expect(sim.weather.kind === 'rain' || sim.weather.kind === 'storm').toBe(true);
    expect(best).toBeLessThan(3);
    expect(sheltering).toBeLessThanOrEqual(2); // (the order lands on the tick after it is issued)
  });

  it('a death-gripped fungus host no longer counts as population', () => {
    const sim = makeFullGame('meadow', { seed: 2, difficulty: 'peaceful' });
    run(sim, 60);
    const colony = sim.getColony(sim.playerColony)!;
    const before = colony.population.total;
    const victim = mine(sim, 'worker')[0];
    sim.command({ type: 'debugInfect', id: victim.id, stage: 'gripped' });
    run(sim, 45);
    expect(sim.getAnt(victim.id)?.infection.stage).toBe('gripped');
    expect(colony.population.total).toBe(before - 1);
    expect(sim.goal.status).toBe('active');
  });

  it('the queen dies in a live game: succession grace, then the game is lost — rivals fight on without breaking', () => {
    const sim = makeFullGame('meadow', { seed: 1 });
    run(sim, 1800);
    const colony = sim.getColony(sim.playerColony)!;
    // no heirs: remove royal brood so the grace period is the only thing between her and the loss
    sim.command({ type: 'debugKill', id: colony.queenId });
    let lost = 0;
    for (let t = 0; t < 30 * 240 && !lost; t++) {
      sim.step();
      for (const e of sim.drainEvents()) if (e.type === 'lose') lost = sim.tick;
    }
    expect(lost).toBeGreaterThan(0);
    expect(sim.goal.status).toBe('lost');
    expect(sim.goal.reason).toBe('queenDead');
    run(sim, 600); // the world keeps running after the end screen
    for (const a of sim.ants) expect(finite(a)).toBe(true);
  });

  it('a non-finite debugSpawn position is ignored instead of poisoning the spatial hash', () => {
    const sim = makeFullGame('meadow', { seed: 1, difficulty: 'peaceful' });
    const n = sim.ants.length;
    sim.command({ type: 'debugSpawn', what: 'ant', pos: { x: NaN, y: 1, z: 1 } });
    sim.command({ type: 'debugSpawn', what: 'creature', creature: 'wasp', pos: { x: 1, y: Infinity, z: 1 } });
    run(sim, 10);
    expect(sim.ants.length).toBe(n);
  });
});

describe('goals are reachable by play', () => {
  it(
    'forest (eliminateRival): build up, then an Attack beacon on the rival nest musters a war party that kills their queen → win',
    () => {
      const sim = makeFullGame('forest', { seed: 1 });
      const r = runFullGame('forest: war beacon at minute 24', sim, 36, {
        quiet: true,
        each: (s, t) => {
          if (t !== 24 * 1800) return;
          const rival = s.colonies.find((c) => c.id !== s.playerColony && c.alive)!;
          s.command({ type: 'beacon', op: 'place', kind: 'attack', pos: { ...rival.nestPos }, radius: 8 });
        },
      });
      console.log(r.text.split('\n').filter((l) => /^ *(2[2-9]|3\d|\d+\.\d) \|/.test(l)).join('\n'));
      expect(r.status).toBe('won');
      expect(r.sim.goal.reason).toBe('eliminateRival');
      expect(r.queenAlive).toBe(true);
    },
    150_000,
  );
});

// ---- final round: possession details, exile, keeper, leafcutter food rules --------------------------
describe('final round: possession and order details', () => {
  const input = (sim: Simulation, a: Partial<{ bite: boolean; dig: boolean; pickup: boolean }>, move = 0): void =>
    sim.command({ type: 'possessInput', move: { x: 0, y: move }, yawDelta: 0, sprint: false, actions: { bite: !!a.bite, dig: !!a.dig, pickup: !!a.pickup, trail: false, recruit: false } });

  it('a possessed ant that digs gets a pellet, and dropping it packs it back into the ground — outdoors and inside the nest', () => {
    const sim = makeFullGame('meadow', { seed: 3, difficulty: 'peaceful' });
    run(sim, 120);
    const nav = sim.nav as NavEx;
    for (const where of ['inside', 'outside'] as const) {
      const ant = mine(sim, 'worker').find((a) => a.cell >= 0 && !a.carrying && nav.isExposed(a.cell) === (where === 'outside')) ?? mine(sim, 'worker').find((a) => !a.carrying)!;
      sim.command({ type: 'possessStart', id: ant.id });
      run(sim, 2);
      expect(ant.possessed).toBe(true);
      // dig until a pellet is in the mandibles
      for (let i = 0; i < 200 && !ant.carrying; i++) {
        input(sim, { dig: i % 10 === 0 });
        sim.step();
        sim.drainEvents();
      }
      expect(ant.carrying, `${where}: pellet after digging`).toBeTruthy();
      expect(ant.carrying!.kind === 'bulk' && ant.carrying!.itemKind).toBe('debris');
      // step back from the hole, then drop
      run(sim, 20, () => input(sim, {}, -1));
      const before = sim.world.version;
      let built = 0;
      input(sim, { pickup: true });
      for (let i = 0; i < 5; i++) {
        sim.step();
        for (const e of sim.drainEvents()) if (e.type === 'build' && e.by === ant.id) built++;
        input(sim, {});
      }
      expect(ant.carrying, `${where}: pellet dropped`).toBeNull();
      expect(built, `${where}: the pellet filled ground (build event)`).toBe(1);
      expect(sim.world.version).toBeGreaterThan(before);
      expect(finite(ant)).toBe(true);
      sim.command({ type: 'possessStop' });
      run(sim, 2);
    }
  });

  it('exile end-to-end: the ordered ant walks to the midden, gives up its duties and stays; `stop` lifts the exile', () => {
    const sim = makeFullGame('meadow', { seed: 2, difficulty: 'peaceful' });
    run(sim, 300);
    const colony = sim.getColony(sim.playerColony)!;
    const ant = mine(sim, 'worker')[2];
    const queen = sim.getAnt(colony.queenId)!;
    sim.command({ type: 'order', ids: [ant.id, queen.id], order: 'exile' });
    run(sim, 30 * 60);
    const midden = colony.chambers.find((c) => c.kind === 'midden')!;
    expect(ant.alive).toBe(true);
    expect(ant.mem['exiled']).toBe(1);
    expect(queen.mem['exiled'] ?? 0).toBe(0); // nobody exiles the queen
    expect(ant.tasks[0]?.kind).toBe('exile');
    expect(ant.tasks.length).toBe(1);
    expect(Math.hypot(ant.pos.x - midden.pos.x, ant.pos.y - midden.pos.y, ant.pos.z - midden.pos.z)).toBeLessThan(5);
    // still there a minute later, doing no colony work
    run(sim, 30 * 60);
    expect(Math.hypot(ant.pos.x - midden.pos.x, ant.pos.y - midden.pos.y, ant.pos.z - midden.pos.z)).toBeLessThan(5);
    expect(ant.behavior).toBe('playerOrder');
    sim.command({ type: 'order', ids: [ant.id], order: 'stop' });
    run(sim, 30 * 20);
    expect(ant.mem['exiled'] ?? 0).toBe(0);
    expect(ant.tasks.some((t) => t.kind === 'exile')).toBe(false);
  });

  it('keeper commands in a running gel-farm game: every action answers with a keeperEvent and nothing breaks', () => {
    const sim = makeFullGame('gelFarm', { seed: 1 });
    const seen = new Set<string>();
    const r = runFullGame('gelFarm with a busy keeper', sim, 6, {
      quiet: true,
      stopOnEnd: false,
      each: (s, t) => {
        if (t < 1800 || t % 450 !== 0) return;
        const actions = ['dropFood', 'dropWater', 'lamp', 'tapGlass', 'openTube'] as const;
        const k = (t / 450) % actions.length;
        s.command({ type: 'keeper', action: actions[k], on: Math.floor(t / 2250) % 2 === 0 });
      },
      onEvent: (e) => {
        const ev = e as unknown as { type: string; action?: string; by?: string };
        if (ev.type === 'keeperEvent' && ev.by === 'player') seen.add(ev.action!);
      },
    });
    expect([...seen].sort()).toEqual(['dropFood', 'dropWater', 'lamp', 'openTube', 'tapGlass']);
    expect(r.bad).toBe(0);
    expect(r.queenAlive).toBe(true);
    expect(r.status).not.toBe('lost');
    expect(r.maxInside).toBeLessThan(0.75);
  });

  it('leafcutters get no direct food: not from a possessed pick-up at a source, not from digging edible gel, not by eating at the source', () => {
    const sim = makeFullGame('gelFarm', { seed: 1, faction: 'leafcutter', difficulty: 'peaceful' });
    run(sim, 60);
    const colony = sim.getColony(sim.playerColony)!;
    const ant = mine(sim).find((a) => a.caste !== 'queen' && !a.carrying)!;
    // a food source right under her feet, and a granary to "deliver" to
    sim.command({ type: 'debugSpawn', what: 'food', pos: { ...ant.pos } });
    run(sim, 2);
    sim.command({ type: 'possessStart', id: ant.id });
    run(sim, 2);
    const delivered0 = colony.stats.foodDelivered;
    const food0 = colony.stores.food;
    input(sim, { pickup: true });
    run(sim, 3);
    expect(ant.carrying).toBeTruthy();
    // a starving nestmate holding forage does not eat it either (no stores to fall back on)
    const other = mine(sim).find((a) => a.caste !== 'queen' && a !== ant && !a.carrying)!;
    const keep = colony.stores.food;
    colony.stores.food = 0;
    other.carrying = { kind: 'bulk', id: 0, itemKind: 'food', amount: 1, material: 0 };
    other.energy = 0.1;
    other.thinkAt = sim.tick;
    run(sim, 20, () => input(sim, {}));
    // (nestmates may feed her by trophallaxis; the load itself stays whole or goes to the garden)
    if (other.carrying && other.carrying.kind === 'bulk') expect(other.carrying.amount).toBe(1);
    expect(other.behavior).not.toBe('eat');
    colony.stores.food = keep;
    // walk the load into the pantry by hand and put it down there
    const granary = colony.chambers.find((c) => c.kind === 'granary') ?? colony.chambers[0];
    ant.pos.x = granary.pos.x;
    ant.pos.y = granary.pos.y;
    ant.pos.z = granary.pos.z;
    run(sim, 3);
    const leaves0 = colony.stores.leaves;
    input(sim, { pickup: true });
    run(sim, 3);
    expect(colony.stats.foodDelivered).toBe(delivered0);
    // digging the edible gel: substrate at most, never food
    for (let i = 0; i < 120; i++) {
      input(sim, { dig: i % 10 === 0 });
      sim.step();
      sim.drainEvents();
    }
    sim.command({ type: 'possessStop' });
    run(sim, 2);
    // the only way `food` may have moved in these few seconds is DOWN (ants eating from the stores)
    // or up through the garden's own harvest — which a 4-second-old game does not have yet
    expect(colony.stores.food).toBeLessThanOrEqual(food0 + 0.01);
    expect(colony.stores.leaves).toBeGreaterThanOrEqual(leaves0);
  });
});

