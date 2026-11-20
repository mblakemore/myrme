import { describe, expect, it } from 'vitest';
import { COMBAT_MEM, Phero, registerAttackProfile, type Ant, type Colony } from '../../core';
import { isFoodItem } from '../behaviors/util';
import { BALANCE } from '../data/balance';
import { chooseBehavior } from './brain';
import { getExt } from './colonyState';
import { combatStats } from './combat';
import { SPEED_MEM, applyStatus, armourOf, attack, getCombat, hurt, meleeReach } from './combatCore';
import { dist, face, makeArena, type Arena } from './combatTestUtil';
import { spawnCreatureAt } from './creatures';
import { biteCandidate, biteTarget, isHostile, nearestHostile } from './ordersCombat';

const C = BALANCE.b1.combat;

function enemyColony(a: Arena): Colony {
  return a.sim.createColony('gardenAnt', 'ai', a.at(8, 8));
}

/** Two ants facing each other `gap` apart on the open surface, far from everything else. */
function duel(a: Arena, casteA: 'worker' | 'soldier', casteB: 'worker' | 'soldier', gap = 1.2): { me: Ant; foe: Ant; foes: Colony } {
  const foes = enemyColony(a);
  const me = a.ant(a.player, casteA, 20, 50);
  const foe = a.ant(foes, casteB, 20 + gap, 50);
  face(me, foe.pos);
  face(foe, me.pos);
  return { me, foe, foes };
}

describe('melee resolution', () => {
  it('applies damage, facing bonus, armour and cooldown', () => {
    const a = makeArena();
    const { me, foe } = duel(a, 'worker', 'worker');
    // head-on: plain attack value
    const d0 = attack(a.sim, me, foe);
    expect(d0).toBeCloseTo(1, 5);
    expect(foe.health).toBeCloseTo(foe.maxHealth - 1, 5);
    // cooldown blocks the next bite
    expect(attack(a.sim, me, foe)).toBe(0);
    expect(me.attackReadyAt).toBeGreaterThan(a.sim.tick);
    // from behind: rear bonus
    foe.forward.x = 1;
    foe.forward.z = 0; // foe now faces away from `me` (me is at -x)
    expect(attack(a.sim, me, foe, { ignoreCooldown: true })).toBeCloseTo(C.rearMul, 5);
    // from the side: flank bonus
    foe.forward.x = 0;
    foe.forward.z = 1;
    expect(attack(a.sim, me, foe, { ignoreCooldown: true })).toBeCloseTo(C.flankMul, 5);
    // out of reach: nothing
    foe.pos.x = me.pos.x + 6;
    expect(attack(a.sim, me, foe, { ignoreCooldown: true })).toBe(0);
    const ev = a.sim.drainEvents();
    expect(ev.filter((e) => e.type === 'attack').length).toBe(3);
    expect(ev.filter((e) => e.type === 'damage').length).toBe(3);
  });

  it('armour absorbs a share of the damage; a possessed ant bites harder', () => {
    const a = makeArena();
    const { me, foe } = duel(a, 'worker', 'soldier');
    expect(armourOf(foe)).toBeCloseTo(C.armour.soldier, 5);
    const d = attack(a.sim, me, foe);
    expect(d).toBeCloseTo(1 * (1 - C.armour.soldier), 5);
    me.possessed = true;
    const d2 = attack(a.sim, me, foe, { ignoreCooldown: true });
    expect(d2).toBeCloseTo(C.possessedMul * (1 - C.armour.soldier), 5);
  });

  it('kills leave a corpse, credit the killer and raise the alarm for both colonies', () => {
    const a = makeArena();
    const { me, foe, foes } = duel(a, 'soldier', 'worker');
    let n = 0;
    while (foe.alive && n++ < 50) attack(a.sim, me, foe, { ignoreCooldown: true });
    expect(foe.alive).toBe(false);
    expect(a.player.stats.kills).toBe(1);
    expect(a.sim.items.some((i) => i.itemKind === 'corpse' && i.colony === foes.id)).toBe(true);
    const ev = a.sim.drainEvents();
    expect(ev.some((e) => e.type === 'antDied' && e.cause === 'combat')).toBe(true);
    const calls = getCombat(a.sim).calls;
    expect(calls.some((c) => c.colony === a.player.id && c.kind === 'threat')).toBe(true);
    expect(calls.some((c) => c.colony === foes.id && c.kind === 'threat')).toBe(true);
    // alarm pheromone was laid where the victim stood
    expect(a.sim.pheromones.activeCount(foes.id, Phero.alarm)).toBeGreaterThan(0);
    expect(ev.some((e) => e.type === 'pheromoneBurst' && e.channel === Phero.alarm)).toBe(true);
  });

  it('keeps the M1 order helpers working (isHostile / biteTarget / nearestHostile / biteCandidate)', () => {
    const a = makeArena();
    const { me, foe } = duel(a, 'worker', 'worker');
    a.sim.step();
    expect(isHostile(me, foe)).toBe(true);
    expect(isHostile(me, me)).toBe(false);
    expect(nearestHostile(a.sim, me, me.pos.x, me.pos.y, me.pos.z, 5)).toBe(foe);
    expect(biteCandidate(a.sim, me, BALANCE.a2b.possessBiteRange)).toBe(foe);
    expect(biteTarget(a.sim, me, foe)).toBe(true);
    expect(biteTarget(a.sim, me, foe)).toBe(false); // cooldown
    // a big creature is found and bitten from where an ant can actually stand
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(40, 50));
    const hunter = a.ant(a.player, 'soldier', 38.5, 50); // spawns snap to cell centres: 2 units from the spider
    face(hunter, spider.pos);
    a.sim.step();
    expect(dist(hunter.pos, spider.pos)).toBeLessThanOrEqual(meleeReach(hunter, spider) + 0.35);
    expect(biteCandidate(a.sim, hunter, BALANCE.a2b.possessBiteRange)).toBe(spider);
    expect(biteTarget(a.sim, hunter, spider)).toBe(true);
  });
});

describe('status effects', () => {
  it('poison ticks, slow and glue set the speed multiplier, everything expires', () => {
    const a = makeArena();
    a.clearWorkers();
    const w = a.ant(a.player, 'worker', 20, 50);
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(45, 12), { asleep: true });
    applyStatus(a.sim, w, { kind: 'poison', duration: 3, dps: 1 });
    const h0 = w.health;
    a.run(100);
    expect(w.health).toBeLessThan(h0 - 2);
    expect(w.health).toBeGreaterThan(h0 - 4);
    const h1 = w.health;
    a.run(60);
    expect(w.health).toBeGreaterThanOrEqual(h1); // expired (it may even have started to heal)

    applyStatus(a.sim, spider, { kind: 'slow', duration: 2, speedMul: 0.4 });
    a.run(2);
    expect(spider.mem[SPEED_MEM]).toBeCloseTo(0.4, 5);
    applyStatus(a.sim, spider, { kind: 'glued', duration: 1 });
    a.run(2);
    expect(spider.mem[SPEED_MEM]).toBe(0);
    expect(spider.stunned).toBeGreaterThan(0);
    a.run(40);
    expect(spider.mem[SPEED_MEM]).toBeCloseTo(0.4, 5); // glue gone, still slowed
    a.run(60);
    expect(spider.mem[SPEED_MEM]).toBeUndefined();
    expect(spider.stunned).toBe(0);
    expect(combatStats(a.sim).afflicted).toBe(0);
  });

  it('attack profiles supply the effects (the data shape B3 fills in)', () => {
    const a = makeArena();
    const { me, foe } = duel(a, 'worker', 'worker');
    registerAttackProfile('gardenAnt:worker', { damageMul: 0.5, armourPierce: 1, effects: [{ kind: 'glued', duration: 2 }, { kind: 'poison', duration: 4, dps: 0.5, maxStacks: 2 }] });
    try {
      expect(attack(a.sim, me, foe)).toBeCloseTo(0.5, 5);
      expect(foe.mem[COMBAT_MEM.glued]).toBeGreaterThan(a.sim.tick);
      expect(foe.mem[COMBAT_MEM.poisonDps]).toBeCloseTo(0.5, 5);
      attack(a.sim, me, foe, { ignoreCooldown: true });
      attack(a.sim, me, foe, { ignoreCooldown: true });
      expect(foe.mem[COMBAT_MEM.poisonDps]).toBeCloseTo(1, 5); // capped at two stacks
      // a glued ant strikes at half rate
      attack(a.sim, foe, me);
      expect(foe.attackReadyAt - a.sim.tick).toBe(Math.round(0.8 * 30 * 2));
    } finally {
      registerAttackProfile('gardenAnt:worker', {});
    }
  });

  it('default sting profile poisons (wasp)', () => {
    const a = makeArena();
    a.clearWorkers();
    const w = a.ant(a.player, 'soldier', 20, 50);
    const wasp = spawnCreatureAt(a.sim, 'wasp', a.at(21, 50));
    attack(a.sim, wasp, w, { ignoreReach: true });
    expect(w.mem[COMBAT_MEM.poison]).toBeGreaterThan(a.sim.tick);
  });
});

describe('grappling', () => {
  it('latched ants slow a big predator and enough of them pin it', () => {
    const a = makeArena();
    a.clearWorkers();
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(20, 50), { asleep: true });
    const hold = BALANCE.b1.creatures.jumpingSpider.hold;
    const ants: Ant[] = [];
    for (let i = 0; i < hold + 2; i++) {
      const ang = (i / (hold + 2)) * Math.PI * 2;
      ants.push(a.ant(a.player, 'worker', 20 + Math.cos(ang) * 1.9, 50 + Math.sin(ang) * 1.9));
    }
    a.sim.step();
    // three bite: slowed, not pinned
    for (let i = 0; i < 3; i++) expect(attack(a.sim, ants[i], spider, { ignoreReach: true })).toBeGreaterThan(0);
    a.sim.step();
    expect(spider.mem[COMBAT_MEM.latchers]).toBe(3);
    expect(spider.mem[COMBAT_MEM.pinned]).toBe(0);
    expect(spider.mem[SPEED_MEM]).toBeCloseTo(1 - 3 / hold, 5);
    // the rest pile on: pinned
    for (let i = 3; i < ants.length; i++) attack(a.sim, ants[i], spider, { ignoreReach: true });
    a.sim.step();
    expect(spider.mem[COMBAT_MEM.pinned]).toBe(1);
    expect(spider.mem[SPEED_MEM]).toBe(0);
    expect(spider.stunned).toBeGreaterThan(0);
    // pinned victims take extra damage
    const d = attack(a.sim, ants[0], spider, { ignoreReach: true, ignoreCooldown: true });
    expect(d).toBeGreaterThan(1 * (1 - BALANCE.b1.creatures.jumpingSpider.armour) * C.pinnedMul - 1e-6);
    // let go (latches time out when nobody bites): free again
    for (const x of ants) a.sim.remove(x);
    a.run(3);
    expect(spider.mem[COMBAT_MEM.pinned]).toBe(0);
    expect(spider.mem[SPEED_MEM]).toBeUndefined();
  });

  it('two workers immobilise an enemy worker', () => {
    const a = makeArena();
    const { me, foe } = duel(a, 'worker', 'worker');
    const me2 = a.ant(a.player, 'worker', foe.pos.x + 1.1, 50);
    a.sim.step();
    attack(a.sim, me, foe, { ignoreReach: true });
    attack(a.sim, me2, foe, { ignoreReach: true });
    a.sim.step();
    expect(foe.mem[COMBAT_MEM.pinned]).toBe(1);
    const x0 = foe.pos.x;
    foe.intent.mode = 'dir';
    foe.intent.dir.z = 1;
    a.sim.step();
    expect(Math.abs(foe.pos.x - x0)).toBeLessThan(0.05);
  });
});

describe('alarm and the survival behaviors', () => {
  it('an attack on a worker recruits a distant soldier', () => {
    const a = makeArena();
    a.clearWorkers();
    const foes = enemyColony(a);
    const victim = a.ant(a.player, 'worker', 20, 50);
    const foe = a.ant(foes, 'soldier', 21.2, 50);
    const soldier = a.ant(a.player, 'soldier', 38, 50); // far beyond its own senses
    a.run(2);
    expect(chooseBehavior(soldier, a.sim)?.id).not.toBe('fight');
    attack(a.sim, foe, victim, { ignoreReach: true });
    a.run(1);
    expect(chooseBehavior(soldier, a.sim)?.id).toBe('fight');
    const d0 = dist(soldier.pos, foe.pos);
    a.run(150);
    expect(dist(soldier.pos, victim.alive ? victim.pos : soldier.pos) < d0 || !foe.alive).toBe(true);
    a.run(450);
    // the soldier got there and fought
    const ev = a.events.filter((e) => e.type === 'attack' && e.attacker === soldier.id);
    expect(ev.length).toBeGreaterThan(0);
  });

  it('a lone worker facing a predator flees down the home field', () => {
    const a = makeArena();
    const spider = spawnCreatureAt(a.sim, 'jumpingSpider', a.at(46, 32));
    spider.mem['s.pcd'] = 1e9; // keep it from pouncing: this test is about the ant
    const mouth = a.sim.world.cellCenter(a.player.entrances[0], { x: 0, y: 0, z: 0 });
    const w = a.ant(a.player, 'worker', mouth.x + 5, mouth.z);
    w.age = Math.round(w.lifespan * 0.5);
    spider.pos.x = w.pos.x + 3;
    spider.pos.z = w.pos.z;
    a.run(3);
    expect(chooseBehavior(w, a.sim)?.id).toBe('flee');
    const h0 = a.sim.nav.homeDistance(w.colony, w.cell);
    a.run(120);
    expect(w.alive).toBe(true);
    expect(w.behavior === 'flee' || a.sim.nav.homeDistance(w.colony, w.cell) < h0).toBe(true);
    expect(a.sim.nav.homeDistance(w.colony, w.cell)).toBeLessThan(h0);
  });

  it('workers defend the nest; soldiers engage on sight; the queen stays out of it', () => {
    const a = makeArena();
    const foes = enemyColony(a);
    const queen = a.sim.getAnt(a.player.queenId)!;
    const worker = a.sim.ants.find((x) => x.colony === a.player.id && x.caste === 'worker')!;
    // an intruder inside the nest chamber, next to a worker
    const intruder = a.sim.spawnAnt(foes.id, 'worker', { x: worker.pos.x + 1.5, y: worker.pos.y, z: worker.pos.z });
    a.run(4);
    expect(chooseBehavior(worker, a.sim)?.id).toBe('fight');
    if (dist(queen.pos, intruder.pos) > 3) expect(chooseBehavior(queen, a.sim)?.id).not.toBe('fight');
    a.run(600);
    expect(intruder.alive).toBe(false);
    // the dead intruder is the defenders' hygiene problem (their midden), not food
    const corpse = a.sim.items.find((i) => i.itemKind === 'corpse');
    if (corpse) expect(corpse.colony).toBe(a.player.id);
  });

  it('ants resting in the nest regenerate', () => {
    const a = makeArena();
    const worker = a.sim.ants.find((x) => x.colony === a.player.id && x.caste === 'worker')!;
    worker.health = 4;
    a.run(Math.round((C.regenQuiet + 6) * 30));
    expect(worker.health).toBeGreaterThan(4.5);
  });
});

describe('corpses', () => {
  it('prey killed by the colony becomes food its haulers know about', () => {
    const a = makeArena();
    const cat = spawnCreatureAt(a.sim, 'caterpillar', a.at(48, 20));
    hurt(a.sim, cat, 10_000, a.player.id);
    expect(cat.alive).toBe(false);
    const item = a.sim.items.find((i) => i.itemKind === 'corpse')!;
    expect(item.amount).toBe(BALANCE.b1.creatures.caterpillar.def.foodValue);
    expect(isFoodItem(item, a.player.id)).toBe(true);
    expect(getExt(a.sim, a.player.id).knownSources.has(item.id)).toBe(true);
    const ev = a.sim.drainEvents();
    expect(ev.some((e) => e.type === 'creatureDied' && e.killerColony === a.player.id)).toBe(true);
    a.run(40);
    expect(a.player.jobs.some((j) => j.kind === 'haulFood' && j.targetId === item.id)).toBe(true);
    // …and it is actually butchered and carried home
    const food0 = a.player.stats.foodDelivered;
    a.run(2400);
    expect(a.player.stats.foodDelivered).toBeGreaterThan(food0);
  });
});

describe('final round: ant-vs-ant melee spreads out', () => {
  it('a 12 v 12 skirmish on open ground forms a line of grappling knots, not one pile', () => {
    const a = makeArena();
    const foes = enemyColony(a);
    const mine: Ant[] = [];
    const theirs: Ant[] = [];
    for (let i = 0; i < 12; i++) {
      mine.push(a.ant(a.player, i % 4 === 0 ? 'soldier' : 'worker', 24 + (i % 3) * 0.8, 46 + i * 0.7));
      theirs.push(a.ant(foes, i % 4 === 0 ? 'soldier' : 'worker', 30 + (i % 3) * 0.8, 46 + i * 0.7));
    }
    for (const x of [...mine, ...theirs]) x.maxHealth = x.health = 60; // long fight: we measure the formation
    let samples = 0;
    let crowded = 0;
    let minPair = Infinity;
    let fighting = 0;
    let spreadSum = 0;
    for (let t = 0; t < 600; t++) {
      a.sim.step();
      if (t < 150 || t % 10) continue;
      const all = [...mine, ...theirs].filter((x) => x.alive);
      const inMelee = all.filter((x) => x.behavior === 'fight');
      fighting = Math.max(fighting, inMelee.length);
      // bodies closer than 0.3 (well under half a body length) count as stacked
      for (let i = 0; i < all.length; i++) {
        let near = 0;
        for (let j = 0; j < all.length; j++) {
          if (i === j) continue;
          const d = dist(all[i].pos, all[j].pos);
          if (d < minPair) minPair = d;
          if (d < 0.3) near++;
        }
        samples++;
        if (near >= 1) crowded++;
      }
      // footprint of the brawl: RMS distance from the centroid
      let cx = 0;
      let cz = 0;
      for (const x of all) {
        cx += x.pos.x;
        cz += x.pos.z;
      }
      cx /= all.length;
      cz /= all.length;
      spreadSum += Math.sqrt(all.reduce((s, x) => s + (x.pos.x - cx) ** 2 + (x.pos.z - cz) ** 2, 0) / all.length);
    }
    const spread = spreadSum / 45;
    console.log(`[melee] fighting ${fighting}, stacked share ${(crowded / samples).toFixed(3)}, min pair ${minPair.toFixed(2)}, rms spread ${spread.toFixed(2)}`);
    expect(fighting).toBeGreaterThanOrEqual(16);
    expect(crowded / samples).toBeLessThan(0.08);
    expect(spread).toBeGreaterThan(1.4);
  });
});
