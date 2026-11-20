/**
 * Balance section owned by stream A2b (colony brain, economy, jobs, orders, possession).
 * Times are sim seconds unless the name ends in `Ticks`; food is in "food units".
 */
export const a2bBalance = {
  // ---- brain -------------------------------------------------------------------------
  /** Hysteresis: the running behavior's score is multiplied by this and gets `hysteresisAdd`. */
  hysteresisMul: 1.25,
  hysteresisAdd: 0.05,
  /** Score of a duty behavior that owns the ant's current duty task (commitment). */
  commitScore: 1.2,
  /** Seconds a behavior stays unavailable to an ant after it found no claimable job. */
  noJobCooldown: 2.5,
  /** Responses below this count as "no" (any duty outranks idling). */
  minResponse: 0.15,

  // ---- energy / food -----------------------------------------------------------------
  /** Seconds for an adult's energy to go 1 → 0. */
  energyDuration: 260,
  /** Queens burn energy faster (egg production). */
  queenEnergyMul: 1.4,
  /** Food units that restore a full energy bar. */
  foodPerEnergy: 0.7,
  /** Below this an ant interrupts its duty to eat (if the stores have food). */
  hungryEnergy: 0.3,
  /** Below this an idle ant tops up. */
  peckishEnergy: 0.55,
  /** Health lost per second at energy 0. */
  starveDamage: 0.25,
  /** Trophallaxis: donors above / receivers below these energies; amount moved per exchange. */
  trophDonor: 0.6,
  trophReceiver: 0.3,
  trophAmount: 0.25,
  trophRadius: 1.6,
  /** Seconds to eat at the pantry. */
  eatTime: 1.2,
  /** "Food low" alert when stores < this × population. */
  foodLowPerAnt: 0.35,
  /** Seconds between repeated alerts of one code. */
  alertCooldown: 45,

  // ---- foraging ----------------------------------------------------------------------
  /** Distance at which an ant smells a food source / loose food item. */
  foodSenseRadius: 6,
  /** Final round: extra smell range of a large source (amount / 60, capped at this). */
  foodSenseBig: 5,
  /** Seconds to cut a load: [default, carcass]. Carcasses are butchered on site. */
  harvestTime: 1.0,
  butcherTime: 2.6,
  /** `food` pheromone laid per cell on the way home, times source quality (0.3..1). */
  trailDeposit: 2.2,
  /** Source amount at which trail quality saturates. */
  trailQualityAmount: 60,
  /** Minimum pheromone a sensor reacts to. */
  trailSenseMin: 0.04,
  /** Sensor geometry: distance ahead and half-angle (radians). */
  sensorDist: 2.2,
  sensorAngle: 0.7,
  /** Seconds a scout searches before heading home empty. */
  scoutTime: 75,
  /** Scouts stay within base + grow × seconds of the entrance; they fan out for `scoutFanTime` s. */
  scoutLeashBase: 16,
  scoutLeashGrow: 0.8,
  scoutFanTime: 12,
  /** Chance a new forager is told about a food source the colony already knows. */
  recruitKnownChance: 0.6,
  /** Seconds a recruit keeps looking after losing a trail before it scouts. */
  trailLostTime: 5,
  /** Coarse cell size of the colony's explored-area memory and its decay per 5 s. */
  exploreCell: 6,
  exploreDecay: 0.93,
  /** Explored-memory penalty added around a depleted source. */
  lowYieldPenalty: 4,
  /** Speed multiplier while hauling. */
  carrySpeed: 0.85,
  /** Colony wants this much stored food per ant (forage demand hits its floor above it). */
  foodTargetPerAnt: 4,
  foodTargetBase: 30,
  forageDemandMin: 0.25,
  /** Fraction of workers that may forage at need 0 / 1. */
  foragerFracMin: 0.3,
  foragerFracMax: 0.75,

  // ---- brood -------------------------------------------------------------------------
  /** Queen lay interval at full food factor. */
  layInterval: 6,
  /** Stored food at which the lay rate saturates: base + perAnt × population. */
  layFoodBase: 10,
  layFoodPerAnt: 0.3,
  /** Minimum stored food and queen energy to lay at all. */
  layMinFood: 3,
  /** Stored food per adult the queen leaves untouched when deciding to lay. */
  layReservePerAnt: 0.3,
  layMinEnergy: 0.15,
  /** Food taken from the stores per egg. */
  eggCost: 0.5,
  /** Brood the nursery can hold: base + per worker. */
  broodCapBase: 8,
  broodCapPerWorker: 1.1,
  eggTime: 35,
  larvaTime: 60,
  pupaTime: 45,
  /** Food per feeding. A larva needs `foodCost` of its caste in total. */
  feedPortion: 1.5,
  /** Larva asks for food after this long unfed; dies after `larvaStarveTime`. */
  larvaHungryTime: 8,
  larvaStarveTime: 110,
  feedTime: 0.8,
  /** Radius of each per-stage brood pile and their distance from the nursery centre. */
  broodPileRadius: 1.5,
  broodPileOffset: 1.3,

  // ---- lifecycle / nest --------------------------------------------------------------
  /** Starting workers get ages spread over 0..this fraction of their lifespan. */
  startAgeSpread: 0.72,
  /** Air voxels of nest per ant (population cap = nest volume / this). */
  voxelsPerAnt: 10,
  /** Request an expansion when ants + brood exceed this fraction of the cap. */
  crowdedFraction: 0.5,
  /** A nursery holds this much brood, a granary this much food, before the colony wants another. */
  nurseryBrood: 12,
  granaryFood: 70,
  /** Seconds between autonomous expansion plans. */
  expandCooldown: 25,
  /** Autonomous tunnel: stamp radius, length; chamber: radius. */
  tunnelRadius: 1.8,
  tunnelLength: 6,
  chamberRadius: 2.7,
  /** Seconds a corpse lies before it emits the death signal and gets a haul job. */
  corpseDelay: 15,
  /** `death` pheromone deposited per job-board update around an untended corpse. */
  deathDeposit: 0.6,
  /** Seconds corpses rest in the midden before they decay away. */
  middenDecay: 400,
  middenRadius: 3.2,
  middenDistance: 7,

  // ---- jobs --------------------------------------------------------------------------
  jobsEveryTicks: 10,
  /** Urgency of the colony's own dig projects, and the share of workers they may occupy. */
  autoDigUrgency: 0.38,
  autoDigShare: 0.3,
  /** Ticks a designation's job stays closed after a digger found nothing workable in reach. */
  digRetryTicks: 150,
  /** Age-polyethism multiplier range on thresholds (favoured .. disfavoured). */
  ageThresholdLo: 0.6,
  ageThresholdHi: 1.9,
  patrolRadius: 8,
  patrolPoints: 5,

  // ---- player control ------------------------------------------------------------------
  beaconRadius: 6,
  /** Per second at the beacon centre (falls off towards the rim). */
  beaconDeposit: 0.3,
  /** Ants a beacon may hold at once: gather, dig, rally, attack. */
  beaconQuota: { gather: 6, dig: 4, rally: 24, attack: 24, avoid: 0 },
  /** Recruit range (multiples of the beacon radius) for rally / attack / gather / dig. */
  beaconCallRange: 5,
  followDistance: 2.2,
  guardLeash: 1.6,
  attackRange: 1.3,
  /** Possession. */
  possessBiteRange: 1.5,
  possessDigCooldown: 0.35,
  possessPickupRange: 1.8,
  recruitRadius: 7,
  recruitMax: 8,
  trailLayDeposit: 1.5,
  /**
   * Black garden ant caste numbers (the species def in `data/species/gardenAnt.ts` only wires
   * these in). Thresholds are response thresholds per job: lower = keener.
   */
  gardenAnt: {
    queen: { length: 1.3, clearance: 0.9, speed: 1.0, maxHealth: 60, attack: 1, foodCost: 40 },
    worker: {
      speed: 2.4,
      maxHealth: 10,
      attack: 1,
      carryCapacity: 3,
      digRate: 1,
      lifespan: 1500,
      foodCost: 3,
      thresholds: { forage: 0.3, haulFood: 0.3, dig: 0.38, feedLarva: 0.35, feedQueen: 0.35, carryBrood: 0.45, carryCorpse: 0.55, patrol: 1.6, herdAphids: 0.6 },
    },
    soldier: {
      length: 0.95,
      clearance: 0.7,
      speed: 2.1,
      maxHealth: 24,
      attack: 3,
      attackCooldown: 0.7,
      carryCapacity: 2,
      digRate: 0.5,
      lifespan: 1700,
      foodCost: 6,
      thresholds: { guard: 0.2, patrol: 0.3, carryCorpse: 0.7, haulFood: 0.9, dig: 1.2 },
    },
    alate: { length: 1.0, clearance: 0.7, speed: 2.0, maxHealth: 12, lifespan: 2400, foodCost: 12 },
    casteRatio: { worker: 0.88, soldier: 0.12 },
    startingWorkers: 10,
    startingFood: 40,
  },
} as const;
