import { v3, v3clone, type CellIndex, type SimState, type Vec3 } from '../core';
import { distToSegment } from '../world/generators/shared';
import { BALANCE } from './data/balance';
import { getSpecies } from './data/species';

/**
 * Initial population (runs once from the Simulation constructor, before systems' init).
 *
 *  - fixture 'wander' (permanent test/render fixture, `?fixture=wander`): one player colony and
 *    N wandering workers spread over the nest, the climbable props and the rest of the map.
 *  - fixture 'none': the real start — player colony with a queen and the species' starting
 *    workers at the map's colony spawn, plus the map's food sources. Rival colonies are spawned
 *    by the `rivals` system (B1), not here.
 */
export function setupSimulation(sim: SimState): void {
  const spawn = sim.map.spawns.find((s) => s.kind === 'colony');
  const nestPos: Vec3 = spawn ? spawn.pos : v3(sim.world.sx / 2, sim.world.sy / 2, sim.world.sz / 2);
  const colony = sim.createColony(sim.options.faction, 'player', nestPos);
  if (spawn?.entrance) {
    const e = sim.nav.nearestWalkable(spawn.entrance.x, spawn.entrance.y, spawn.entrance.z, 6);
    if (e >= 0) colony.entrances.push(e);
  }
  for (const f of sim.map.foodSources) sim.spawnFood(f.kind, f.amount, f.pos, f.regen);

  if (sim.options.fixture === 'wander') {
    spawnWanderFixture(sim, colony.id, nestPos, sim.options.fixtureAnts ?? BALANCE.core.fixtureAnts);
    return;
  }

  const species = getSpecies(sim.options.faction);
  const queen = sim.spawnAnt(colony.id, 'queen', nestPos);
  colony.queenId = queen.id;
  if (species.castes.king) colony.kingId = sim.spawnAnt(colony.id, 'king', jitter(sim, nestPos, 1.5)).id;
  for (let i = 0; i < species.startingWorkers; i++) sim.spawnAnt(colony.id, 'worker', jitter(sim, nestPos, 3));
}

function jitter(sim: SimState, p: Vec3, r: number): Vec3 {
  return v3(p.x + sim.rng.range(-r, r), p.y + sim.rng.range(-r * 0.3, r * 0.3), p.z + sim.rng.range(-r, r));
}

function spawnWanderFixture(sim: SimState, colony: number, nestPos: Vec3, count: number): void {
  const w = sim.world;
  const all: CellIndex[] = [];
  const nest: CellIndex[] = [];
  const climb: CellIndex[] = [];
  const stems = sim.map.props.filter((p) => p.climbable).slice(0, 3);
  const c = v3();
  const n = w.sx * w.sy * w.sz;
  for (let cell = 0; cell < n; cell++) {
    if (!sim.nav.isWalkable(cell)) continue;
    all.push(cell);
    w.cellCenter(cell, c);
    const dn = Math.hypot(c.x - nestPos.x, c.y - nestPos.y, c.z - nestPos.z);
    if (dn < 9) nest.push(cell);
    for (const s of stems) {
      if (distToSegment(c.x, c.y, c.z, s.pos, s.end) < s.radius + 1.4 && c.y > s.pos.y + 1.5) {
        climb.push(cell);
        break;
      }
    }
  }
  if (all.length === 0) return;
  const rng = sim.rng.fork('fixture');
  const pick = (list: CellIndex[]): CellIndex => (list.length ? list[rng.int(list.length)] : all[rng.int(all.length)]);
  for (let i = 0; i < count; i++) {
    const k = i % 3;
    const cell = k === 0 ? pick(nest) : k === 1 ? pick(climb.length ? climb : nest) : pick(all);
    w.cellCenter(cell, c);
    sim.spawnAnt(colony, i % 10 === 9 ? 'soldier' : 'worker', v3clone(c));
  }
}
