import type { Behavior } from '../../core';
import { beaconBehavior } from './beacon';
import { buildBehavior } from './build';
import { carryBroodBehavior } from './carryBrood';
import { digBehavior } from './dig';
import { eatBehavior } from './eat';
import { fightBehavior } from './fight';
import { fleeBehavior } from './flee';
import { floodEscapeBehavior } from './floodEscape';
import { forageBehavior } from './forage';
import { guardBehavior } from './guard';
import { harvestLeavesBehavior } from './harvestLeaves';
import { haulFoodBehavior } from './haulFood';
import { herdAphidsBehavior } from './herdAphids';
import { hygieneBehavior } from './hygiene';
import { idleBehavior } from './idle';
import { infectedBehavior } from './infected';
import { necrophoresisBehavior } from './necrophoresis';
import { nuptialBehavior } from './nuptial';
import { nurseBehavior } from './nurse';
import { patrolBehavior } from './patrol';
import { playerOrderBehavior } from './playerOrder';
import { queenBehavior } from './queen';
import { raftBehavior } from './raft';
import { raidBehavior } from './raid';
import { seekShadeBehavior } from './seekShade';
import { tendGardenBehavior } from './tendGarden';
import { tendQueenBehavior } from './tendQueen';
import { wanderBehavior } from './wander';

/**
 * Behavior registry (§5.1, §5.2). Pre-populated by M0; wave agents fill in the behavior files
 * and never edit this list. Selection is by band then score (see systems/brain.ts) — list order
 * only breaks exact score ties (first wins).
 *
 * Ownership: A2b — beacon, playerOrder, queen, eat, nurse, tendQueen, carryBrood, forage,
 * haulFood, dig, necrophoresis, idle, wander(fixture) · B1 — fight, flee, guard, patrol, raid ·
 * B2 — infected, floodEscape, hygiene · B3 — seekShade, build, tendGarden, harvestLeaves,
 * herdAphids, raft, nuptial.
 */
export const BEHAVIORS: readonly Behavior[] = [
  // forced
  infectedBehavior,
  // player
  playerOrderBehavior,
  beaconBehavior,
  // survival
  fleeBehavior,
  fightBehavior,
  floodEscapeBehavior,
  seekShadeBehavior,
  // duty
  queenBehavior,
  eatBehavior,
  nurseBehavior,
  tendQueenBehavior,
  carryBroodBehavior,
  forageBehavior,
  haulFoodBehavior,
  digBehavior,
  necrophoresisBehavior,
  hygieneBehavior,
  guardBehavior,
  patrolBehavior,
  raidBehavior,
  buildBehavior,
  tendGardenBehavior,
  harvestLeavesBehavior,
  herdAphidsBehavior,
  raftBehavior,
  nuptialBehavior,
  // idle
  wanderBehavior,
  idleBehavior,
];
