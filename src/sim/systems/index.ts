import type { SimSystem } from '../../core';
import { aphidsSystem } from './aphids';
import { brainSystem } from './brain';
import { broodSystem } from './brood';
import { colonySystem } from './colony';
import { combatSystem } from './combat';
import { creaturesSystem } from './creatures';
import { digSystem } from './dig';
import { directorSystem } from './director';
import { fallingSystem } from './falling';
import { foodSystem } from './food';
import { fungusSystem } from './fungus';
import { fungusGardenSystem } from './fungusGarden';
import { goalsSystem } from './goals';
import { jobsSystem } from './jobs';
import { keeperSystem } from './keeper';
import { movementSystem } from './movement';
import { ordersSystem } from './orders';
import { pathsSystem } from './paths';
import { pheromoneSystem } from './pheromone';
import { possessionSystem } from './possession';
import { raftSystem } from './raft';
import { rivalsSystem } from './rivals';
import { temperatureSystem } from './temperature';
import { termiteBuildSystem } from './termiteBuild';
import { waterSystem } from './water';
import { weatherSystem } from './weather';

/**
 * System registry (§5.1) — FINAL EXECUTION ORDER. Pre-populated by M0; wave agents fill in the
 * system files and never edit this list.
 *
 * Order rationale (one tick, after commands were applied and the spatial hash rebuilt):
 *   1. Environment & external pressure   weather → temperature → water → keeper → director
 *      (so everything below sees this tick's weather, flood state and spawned threats)
 *   2. Colony economy & job board        colony → jobs → brood → food → fungusGarden → aphids
 *      (needs and jobs exist before anyone decides what to do)
 *   3. Decisions → movement intents      orders → possession → brain → creatures → rivals
 *      (player input first; the brain skips possessed ants; creature/rival AI last)
 *   4. Path queue                        paths (budgeted A*, home-field rebuilds)
 *   5. Motion                            movement → falling → raft
 *   6. World edits                       dig → termiteBuild
 *      (after motion so workers act where they are now; edits invalidate nav for next tick)
 *   7. Harm                              combat → fungus
 *   8. Scent                             pheromone (deposits by position, evaporation at 2 Hz)
 *   9. Outcome                           goals (win/lose evaluated on the final state of the tick)
 * Tombstoned entities are swept by the Simulation after the last system.
 *
 * Command ownership (each command type is consumed by exactly one system's `onCommand`):
 *   order, setGroup → orders · beacon, designate → jobs · setPriority, setCasteRatio → colony ·
 *   possessStart, possessStop, possessInput → possession · keeper → keeper ·
 *   setDirector → director · debugWeather → weather · debugInfect → fungus ·
 *   setSpeed, pause, debugSpawn, debugKill → Simulation core.
 */
export const SYSTEMS: readonly SimSystem[] = [
  weatherSystem,
  temperatureSystem,
  waterSystem,
  keeperSystem,
  directorSystem,
  colonySystem,
  jobsSystem,
  broodSystem,
  foodSystem,
  fungusGardenSystem,
  aphidsSystem,
  ordersSystem,
  possessionSystem,
  brainSystem,
  creaturesSystem,
  rivalsSystem,
  pathsSystem,
  movementSystem,
  fallingSystem,
  raftSystem,
  digSystem,
  termiteBuildSystem,
  combatSystem,
  fungusSystem,
  pheromoneSystem,
  goalsSystem,
];
