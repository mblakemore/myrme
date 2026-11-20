import { describe, expect, it } from 'vitest';
import { COMBAT_MEM, CREATURE_MEM, Phero, creatureAnim, type Ant } from '../../core';
import { BALANCE } from '../data/balance';
import { attack } from './combatCore';
import { dist, makeArena } from './combatTestUtil';
import { isAsleep, spawnCreatureAt, wakeCreature } from './creatures';

const T = BALANCE.b1.creatures;

describe('jumping spider', () => {
  it('stalks, pounces, kills a lone worker and carries it to its lair', () => {
    const a = makeArena();
    a.clearWorkers();
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(12, 52));
    const w = a.ant(a.player, 'worker', 21, 52);
    w.intent.mode = 'none';
    const states = new Set<string>();
    const anims = new Set<string>();
    for (let i = 0; i < 900; i++) {
      a.run(1);
      states.add(spider.state);
      anims.add(creatureAnim(spider, a.sim.tick));
      if (spider.state === 'idle' && !w.alive) break;
    }
    expect(w.alive).toBe(false);
    expect(states.has('stalk')).toBe(true);
    expect(states.has('attack')).toBe(true);
    expect(states.has('flee')).toBe(true); // the retreat with its catch
    expect(anims.has('pounce')).toBe(true);
    expect(anims.has('carry')).toBe(true);
    // carried off: no corpse left behind, and the spider is back home eating
    expect(a.sim.items.filter((i) => i.itemKind === 'corpse').length).toBe(0);
    expect(dist(spider.pos, spider.home)).toBeLessThan(4);
    expect(spider.state).toBe('idle');
    expect(creatureAnim(spider, a.sim.tick)).toBe('eat');
    expect(a.events.some((e) => e.type === 'antDied' && e.cause === 'combat')).toBe(true);
  });

  it('retreats to its lair when mobbed', () => {
    const a = makeArena();
    a.clearWorkers();
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(12, 52));
    spider.mem['s.pcd'] = 1e9; // no pounce: straight to the melee
    spider.state = 'attack';
    const ants: Ant[] = [];
    for (let i = 0; i < T.jumpingSpider.mobLimit; i++) ants.push(a.ant(a.player, 'soldier', 24 + (i % 3), 51 + Math.floor(i / 3)));
    spider.pos.x = 25.5;
    spider.pos.z = 54.5;
    a.run(2);
    for (const x of ants) attack(a.sim, x, spider, { ignoreReach: true });
    a.run(2);
    expect(spider.mem[COMBAT_MEM.latchers]).toBe(T.jumpingSpider.mobLimit);
    expect(spider.state).toBe('flee');
  });

  it('sleeps in its lair until woken, and wakes when attacked', () => {
    const a = makeArena();
    a.clearWorkers();
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(12, 52), { asleep: true });
    const w = a.ant(a.player, 'worker', 16, 52);
    a.run(150);
    expect(isAsleep(a.sim, spider)).toBe(true);
    expect(w.alive).toBe(true);
    expect(creatureAnim(spider, a.sim.tick)).toBe('hidden');
    expect(wakeCreature(a.sim, spider)).toBe(true);
    a.run(5);
    expect(spider.state).not.toBe('idle');
  });
});

describe('antlion', () => {
  it('drags an ant on the slope into the pit and grabs it; the colony learns to avoid the pit', () => {
    const a = makeArena({ pit: { x: 20, z: 48, r: 5 } });
    a.clearWorkers();
    const lion = a.sim.creatures.find((c) => c.def === 'antlion')!;
    expect(lion.state).toBe('ambush');
    expect(lion.mem[CREATURE_MEM.hidden]).toBe(1);
    const w = a.ant(a.player, 'worker', 23.5, 48);
    const outside = a.ant(a.player, 'worker', 28.5, 48);
    outside.intent.mode = 'none';
    const r0 = Math.hypot(w.pos.x - 20, w.pos.z - 48);
    let slowed = false;
    for (let i = 0; i < 900 && w.alive; i++) {
      a.run(1);
      if (w.alive && w.mem['pit'] === a.sim.tick) slowed = true;
      if (i === 150) expect(Math.hypot(w.pos.x - 20, w.pos.z - 48)).toBeLessThan(r0); // sliding in
    }
    expect(slowed).toBe(true);
    expect(w.alive).toBe(false);
    expect(a.events.some((e) => e.type === 'attack' && e.attacker === lion.id)).toBe(true);
    expect(a.sim.items.filter((i) => i.itemKind === 'corpse').length).toBe(0); // eaten
    expect(creatureAnim(lion, a.sim.tick)).toBe('attack');
    // the ant that stayed out of the pit was never pulled
    expect(outside.mem['pit']).toBeUndefined();
    a.run(160);
    expect(a.sim.pheromones.activeCount(a.player.id, Phero.avoid)).toBeGreaterThan(0);
  });
});

describe('parasitic wasp', () => {
  it('swoops on an exposed worker, snatches it and leaves; airborne it cannot be bitten', () => {
    const a = makeArena();
    a.clearWorkers();
    const w = a.ant(a.player, 'worker', 20, 50);
    const wasp = spawnCreatureAt(a.sim, 'wasp', { x: 6, y: 30, z: 40 });
    const states = new Set<string>();
    for (let i = 0; i < 1500 && wasp.alive; i++) {
      a.run(1);
      states.add(wasp.state);
      // keep the victim in the open so the test is about the wasp
      if (w.alive && w.pos.y < a.G - 1) break;
    }
    expect(states.has('stalk')).toBe(true);
    expect(states.has('attack')).toBe(true);
    expect(w.alive).toBe(false);
    expect(a.events.some((e) => e.type === 'attack' && e.kind === 'sting')).toBe(true);
    expect(a.sim.items.filter((i) => i.itemKind === 'corpse').length).toBe(0); // carried off
    expect(wasp.alive).toBe(false); // gone over the edge with its catch
    expect(a.events.some((e) => e.type === 'creatureDied')).toBe(false);
  });

  it('will not dive on a worker with soldiers around it', () => {
    const a = makeArena();
    a.clearWorkers();
    const w = a.ant(a.player, 'worker', 20, 50);
    w.intent.mode = 'none';
    for (let i = 0; i < 3; i++) a.ant(a.player, 'soldier', 19 + i, 51);
    const wasp = spawnCreatureAt(a.sim, 'wasp', { x: 10, y: 29, z: 44 });
    let attacked = false;
    for (let i = 0; i < 240; i++) {
      // hold the group together (they would otherwise wander off to their duties)
      for (const x of a.sim.ants) if (x.caste !== 'queen') x.thinkAt = a.sim.tick + 1000;
      a.run(1);
      if (wasp.state === 'attack') attacked = true;
    }
    expect(attacked).toBe(false);
    expect(w.alive).toBe(true);
  });
});

describe('ground beetle', () => {
  it('walks to the nest entrance, eats food there and goes home', () => {
    const a = makeArena({ food: [{ kind: 'seeds', pos: { x: 46, y: 20.5, z: 36 }, amount: 100, regen: 0 }] });
    a.clearWorkers();
    const beetle = spawnCreatureAt(a.sim, 'groundBeetle', a.at(12, 12));
    const src = a.sim.foodSources[0];
    const mouth = a.sim.world.cellCenter(a.player.entrances[0], { x: 0, y: 0, z: 0 });
    const states: string[] = [];
    let nearest = Infinity;
    for (let i = 0; i < 4500; i++) {
      a.run(1);
      if (states[states.length - 1] !== beetle.state) states.push(beetle.state);
      nearest = Math.min(nearest, dist(beetle.pos, mouth));
      if (beetle.state === 'idle' && states.includes('flee')) break;
    }
    expect(states.slice(0, 4)).toEqual(['roam', 'attack', 'flee', 'idle']);
    expect(nearest).toBeLessThan(10);
    expect(src.amount).toBeLessThan(100);
    expect(beetle.mem['b.ate']).toBeGreaterThan(0);
    expect(dist(beetle.pos, beetle.home)).toBeLessThan(5);
    // too big for the tunnel: it never got underground
    expect(beetle.pos.y).toBeGreaterThan(a.G - 0.5);
  });

  it('its armour shrugs off most of a worker bite', () => {
    const a = makeArena();
    a.clearWorkers();
    const beetle = spawnCreatureAt(a.sim, 'groundBeetle', a.at(12, 12), { asleep: true });
    const w = a.ant(a.player, 'worker', 14, 12);
    beetle.forward.x = -1;
    beetle.forward.z = 0; // the worker stands behind it
    const d = attack(a.sim, w, beetle, { ignoreReach: true });
    expect(d).toBeCloseTo(1 * BALANCE.b1.combat.rearMul * (1 - T.groundBeetle.armour), 5);
  });
});

describe('prey', () => {
  it('a caterpillar thrashes when bitten: attackers are thrown off and hurt', () => {
    const a = makeArena();
    a.clearWorkers();
    const cat = spawnCreatureAt(a.sim, 'caterpillar', a.at(20, 50));
    const w = a.ant(a.player, 'worker', 21.5, 50);
    a.run(1);
    attack(a.sim, w, cat, { ignoreReach: true });
    expect(w.mem[COMBAT_MEM.latchId]).toBe(cat.id);
    a.run(2);
    expect(creatureAnim(cat, a.sim.tick)).toBe('attack');
    expect(w.mem[COMBAT_MEM.latchId]).toBe(0);
    expect(w.health).toBeLessThan(w.maxHealth);
    a.run(30);
    expect(cat.state).toBe('flee');
  });

  it('a lone worker cannot bring a caterpillar down, a hunting party can', () => {
    const lone = makeArena({ seed: 3 });
    lone.clearWorkers();
    const cat = spawnCreatureAt(lone.sim, 'caterpillar', lone.at(20, 50));
    const w = lone.ant(lone.player, 'worker', 22, 50);
    w.age = Math.round(w.lifespan * 0.5);
    lone.run(1500);
    expect(cat.alive).toBe(true);

    const mob = makeArena({ seed: 3 });
    mob.clearWorkers();
    const cat2 = spawnCreatureAt(mob.sim, 'caterpillar', mob.at(20, 50));
    for (let i = 0; i < 10; i++) {
      const x = mob.ant(mob.player, 'worker', 22 + (i % 5), 49 + Math.floor(i / 5));
      x.age = Math.round(x.lifespan * 0.5);
    }
    mob.run(1500);
    expect(cat2.alive).toBe(false);
    expect(mob.events.some((e) => e.type === 'creatureDied' && e.killerColony === mob.player.id)).toBe(true);
  });
});

describe('mantis', () => {
  it('turns slowly and strikes only what is in front of it', () => {
    const a = makeArena();
    a.clearWorkers();
    const mantis = spawnCreatureAt(a.sim, 'mantis', a.at(30, 50));
    mantis.forward.x = 1;
    mantis.forward.z = 0;
    const behind = a.ant(a.player, 'worker', 27, 50);
    behind.intent.mode = 'none';
    // frozen in place behind it: the mantis needs time to come about before it can strike
    let struck = -1;
    let facing = -1;
    for (let i = 0; i < 400 && struck < 0; i++) {
      behind.thinkAt = a.sim.tick + 1000;
      behind.intent.mode = 'none';
      const dx = behind.pos.x - mantis.pos.x;
      const dz = behind.pos.z - mantis.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      a.run(1);
      if (!behind.alive) struck = i;
      else facing = (mantis.forward.x * dx + mantis.forward.z * dz) / l;
    }
    expect(struck).toBeGreaterThan(10); // it had to come about first
    expect(facing).toBeGreaterThan(T.mantis.strikeCone - 0.15);
    expect(behind.alive).toBe(false);
    expect(creatureAnim(mantis, a.sim.tick)).toBe('attack');
  });
});
