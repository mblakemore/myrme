import { describe, expect, it } from 'vitest';
import { hurt } from './combatCore';
import { makeArena, type ArenaOptions } from './combatTestUtil';
import { requestRivalRaid, rivalColonies, sendScout, spawnInvaders } from './rivals';
import { raidInfos, raidOf } from './rivalsRaid';

const TWO: ArenaOptions = { size: 96, nests: [{ x: 18, z: 48 }, { x: 78, z: 48 }], rivals: true };

describe('rival colonies', () => {
  it('are founded only when asked for (option or director) on maps that allow them', () => {
    expect(rivalColonies(makeArena({ ...TWO }).sim).length).toBe(0);
    expect(rivalColonies(makeArena({ ...TWO, rivals: false, foundRivals: true }).sim).length).toBe(0);
    const a = makeArena({ ...TWO, foundRivals: true });
    const rivals = rivalColonies(a.sim);
    expect(rivals.length).toBe(1);
    expect(rivals[0].controller).toBe('ai');
    expect(a.sim.getAnt(rivals[0].queenId)?.alive).toBe(true);
    // the same machinery: after a while it has jobs, a nursery and foragers of its own
    a.run(600);
    expect(a.sim.ants.filter((x) => x.colony === rivals[0].id).length).toBeGreaterThan(5);
    expect(rivals[0].alive).toBe(true);
  });

  it('is eliminated when its queen dies: colonyDied event and an alert', () => {
    const a = makeArena({ ...TWO, foundRivals: true });
    const rival = rivalColonies(a.sim)[0];
    a.run(30);
    const queen = a.sim.getAnt(rival.queenId)!;
    hurt(a.sim, queen, 10_000, a.player.id);
    a.run(120);
    expect(rival.alive).toBe(false);
    const died = a.events.filter((e) => e.type === 'colonyDied');
    expect(died.length).toBe(1);
    expect(died[0].type === 'colonyDied' && died[0].colony).toBe(rival.id);
    expect(a.events.some((e) => e.type === 'alert' && e.colony === a.player.id && e.code === 'info')).toBe(true);
    expect(rivalColonies(a.sim).length).toBe(0);
    expect(a.player.alive).toBe(true);
  });

  it('sends a scout that reaches the player nest area and goes home', () => {
    const a = makeArena({ ...TWO, foundRivals: true });
    const rival = rivalColonies(a.sim)[0];
    a.run(60);
    const raid = sendScout(a.sim, rival)!;
    expect(raid).toBeTruthy();
    const scout = a.sim.getAnt(raid.members[0])!;
    expect(raidOf(a.sim, scout)).toBe(raid);
    const mouth = a.sim.world.cellCenter(a.player.entrances[0], { x: 0, y: 0, z: 0 });
    let nearest = Infinity;
    for (let i = 0; i < 4500 && scout.alive && raidInfos(a.sim).length > 0; i++) {
      a.run(1);
      nearest = Math.min(nearest, Math.hypot(scout.pos.x - mouth.x, scout.pos.z - mouth.z));
    }
    expect(nearest).toBeLessThan(16);
  });

  it('raids on request: a party musters, marches, fights and the player is warned', () => {
    const a = makeArena({ ...TWO, foundRivals: true, seed: 2 });
    const rival = rivalColonies(a.sim)[0];
    for (let i = 0; i < 10; i++) a.sim.spawnAnt(rival.id, i < 3 ? 'soldier' : 'worker', { x: 78, y: a.G - 11, z: 48 });
    a.run(60);
    const threat = requestRivalRaid(a.sim, 8);
    expect(threat).toBeGreaterThan(0);
    const info = raidInfos(a.sim).find((r) => r.kind === 'raid')!;
    expect(info.phase).toBe('muster');
    a.run(1);
    expect(a.events.some((e) => e.type === 'alert' && e.code === 'raidIncoming' && e.colony === a.player.id)).toBe(true);
    const phases = new Set<string>();
    for (let i = 0; i < 9000; i++) {
      a.run(1);
      const r = raidInfos(a.sim).find((x) => x.kind === 'raid');
      if (!r) break;
      phases.add(r.phase);
    }
    expect(phases.has('advance')).toBe(true);
    expect(phases.has('assault')).toBe(true);
    // blood was spilt on both sides or the raid was beaten off at the door
    expect(a.events.some((e) => e.type === 'attack')).toBe(true);
    expect(a.player.stats.deaths + rival.stats.deaths).toBeGreaterThan(0);
  });

  it('tube invaders come in as a nomad party and leave or die', () => {
    const a = makeArena({ tubePort: { x: 10, z: 10 } });
    const raid = spawnInvaders(a.sim, a.at(10, 10), 6)!;
    expect(raid.members.length).toBe(6);
    const colony = a.sim.getAnt(raid.members[0])!.colony;
    expect(colony).not.toBe(a.player.id);
    a.run(9000);
    expect(a.sim.ants.filter((x) => x.colony === colony).length).toBe(0);
    expect(a.events.some((e) => e.type === 'attack')).toBe(true);
    // nomads are not a colony the player can "eliminate"
    expect(a.events.some((e) => e.type === 'colonyDied' && e.colony === a.player.id)).toBe(false);
  });

  // ---- final round: home guard, surplus raids, war parties that weigh the odds -------------------
  it('raids only with its surplus: a small rival does not raid, a big one keeps a home guard', () => {
    const a = makeArena({ ...TWO, foundRivals: true, seed: 2 });
    const rival = rivalColonies(a.sim)[0];
    a.run(30);
    // founding workers only: too few fighters to spare a party
    expect(requestRivalRaid(a.sim, 20)).toBe(0);
    for (let i = 0; i < 30; i++) a.sim.spawnAnt(rival.id, i < 6 ? 'soldier' : 'worker', { x: 78, y: a.G - 11, z: 48 });
    a.run(30);
    const fighters = a.sim.ants.filter((x) => x.colony === rival.id && x.caste !== 'queen').length;
    expect(requestRivalRaid(a.sim, 200)).toBeGreaterThan(0);
    const raid = raidInfos(a.sim).find((r) => r.kind === 'raid')!;
    // at intensity 1 half of the fighters stay home however much the director offers
    expect(raid.members.length).toBeLessThanOrEqual(Math.ceil(fighters * 0.5));
    expect(raid.members.length).toBeGreaterThanOrEqual(3);
  });

  it('a raid that is losing goes home, and its members stop picking fights on the way', () => {
    const a = makeArena({ ...TWO, foundRivals: true, seed: 2 });
    const rival = rivalColonies(a.sim)[0];
    for (let i = 0; i < 24; i++) a.sim.spawnAnt(rival.id, 'worker', { x: 78, y: a.G - 11, z: 48 });
    a.run(60);
    expect(requestRivalRaid(a.sim, 12)).toBeGreaterThan(0);
    const info = raidInfos(a.sim).find((r) => r.kind === 'raid')!;
    const size0 = info.members.length;
    // kill more than half of the party on the march
    for (let i = 0; i < 9000 && raidInfos(a.sim).find((r) => r.id === info.id)?.phase === 'muster'; i++) a.run(1);
    const members = info.members.map((id) => a.sim.getAnt(id)!).filter(Boolean);
    for (let i = 0; i < Math.ceil(size0 * 0.6); i++) a.sim.killAnt(members[i], 'combat');
    a.run(20);
    const now = raidInfos(a.sim).find((r) => r.id === info.id);
    expect(!now || now.phase === 'return').toBe(true);
    for (const m of members) if (m.alive && m.mem['raid']) expect(m.mem['raid.ret']).toBe(1);
  });

  it('a player war beacon on a rival nest: no march at hopeless odds (alert), a march when strong, recall when the beacon goes', () => {
    const a = makeArena({ ...TWO, foundRivals: true, seed: 2 });
    const rival = rivalColonies(a.sim)[0];
    for (let i = 0; i < 40; i++) a.sim.spawnAnt(rival.id, i < 8 ? 'soldier' : 'worker', { x: 78, y: a.G - 11, z: 48 });
    a.run(60);
    a.sim.command({ type: 'beacon', op: 'place', kind: 'attack', pos: { ...rival.nestPos }, radius: 8 });
    a.run(120);
    const myRaid = () => raidInfos(a.sim).find((r) => r.colony === a.player.id);
    expect(myRaid()).toBeUndefined();
    expect(a.events.some((e) => e.type === 'alert' && /will not march/.test(e.text))).toBe(true);
  });

  it('a player war beacon with good odds: the party marches, and pulling the beacon recalls it', () => {
    const a = makeArena({ ...TWO, foundRivals: true, seed: 2 });
    const rival = rivalColonies(a.sim)[0];
    for (let i = 0; i < 20; i++) a.sim.spawnAnt(rival.id, i < 4 ? 'soldier' : 'worker', { x: 78, y: a.G - 11, z: 48 });
    for (let i = 0; i < 60; i++) a.sim.spawnAnt(a.player.id, i < 30 ? 'soldier' : 'worker', { x: 18, y: a.G - 11, z: 48 });
    a.run(60);
    a.sim.command({ type: 'beacon', op: 'place', kind: 'attack', pos: { ...rival.nestPos }, radius: 8 });
    const myRaid = () => raidInfos(a.sim).find((r) => r.colony === a.player.id);
    for (let i = 0; i < 20 * 30 && !myRaid(); i++) a.run(1);
    a.run(30);
    const raid = myRaid();
    expect(raid).toBeTruthy();
    expect(raid!.members.length).toBeGreaterThanOrEqual(10);
    // the player pulls the beacon: the party turns for home and disengages
    for (const b of a.player.beacons.slice()) a.sim.command({ type: 'beacon', op: 'remove', id: b.id });
    a.run(40);
    const after = myRaid();
    expect(!after || after.phase === 'return').toBe(true);
    for (const id of raid!.members) {
      const m = a.sim.getAnt(id);
      if (m && m.mem['raid']) expect(m.mem['raid.ret']).toBe(1);
    }
    a.run(150 * 30);
    expect(myRaid()).toBeUndefined();
  });
});
