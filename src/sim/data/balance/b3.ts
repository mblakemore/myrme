/**
 * Balance section owned by stream B3 (factions, keeper events, goals).
 * Times are sim seconds unless the name ends in `Ticks`; food is in "food units".
 */
export const b3Balance = {
  // ---- species (wired in by data/species/{fireAnt,leafcutter,termite}.ts) -----------------
  fireAnt: {
    queen: { length: 1.2, clearance: 0.9, speed: 1.2, maxHealth: 45, attack: 2, foodCost: 40 },
    worker: {
      length: 0.6,
      speed: 3.0,
      maxHealth: 7,
      attack: 1.2,
      attackCooldown: 0.6,
      carryCapacity: 2.5,
      digRate: 1.1,
      lifespan: 1200,
      foodCost: 2.5,
      // keen on everything, and workers answer alarms too (guard / patrol)
      thresholds: { forage: 0.26, haulFood: 0.28, dig: 0.4, feedLarva: 0.35, feedQueen: 0.35, carryBrood: 0.4, carryCorpse: 0.55, guard: 0.8, patrol: 1.2 },
    },
    soldier: {
      length: 0.8,
      clearance: 0.6,
      speed: 2.8,
      maxHealth: 14,
      attack: 2.6,
      attackCooldown: 0.6,
      carryCapacity: 2,
      digRate: 0.5,
      lifespan: 1300,
      // cheap soldiers
      foodCost: 3.5,
      thresholds: { guard: 0.15, patrol: 0.25, carryCorpse: 0.7, haulFood: 0.9 },
    },
    alate: { length: 0.95, clearance: 0.7, speed: 2.2, maxHealth: 10, lifespan: 2400, foodCost: 9 },
    casteRatio: { worker: 0.72, soldier: 0.28 },
    startingWorkers: 12,
    startingFood: 40,
  },
  leafcutter: {
    queen: { length: 1.5, clearance: 1.0, speed: 0.9, maxHealth: 70, attack: 2, foodCost: 40 },
    /** Minim: gardener and nurse; never leaves the nest. */
    worker: {
      length: 0.5,
      speed: 2.0,
      maxHealth: 6,
      attack: 0.5,
      carryCapacity: 1.5,
      digRate: 0.7,
      lifespan: 1500,
      foodCost: 2,
      thresholds: { tendGarden: 0.15, feedLarva: 0.3, feedQueen: 0.3, carryBrood: 0.4, carryCorpse: 0.7, dig: 0.7 },
    },
    /** Media: cutter and carrier, digs the nest. */
    major: {
      length: 0.85,
      clearance: 0.6,
      speed: 2.5,
      maxHealth: 14,
      attack: 2,
      carryCapacity: 4,
      digRate: 1.1,
      lifespan: 1500,
      foodCost: 3.5,
      thresholds: { harvestLeaves: 0.15, dig: 0.4, carryCorpse: 0.55, tendGarden: 1.4, patrol: 1.6 },
    },
    /** Major: soldier with a huge head and a slicing bite. */
    soldier: {
      length: 1.25,
      clearance: 0.9,
      speed: 1.9,
      maxHealth: 40,
      attack: 5,
      attackCooldown: 1.0,
      carryCapacity: 3,
      digRate: 0.6,
      lifespan: 1800,
      foodCost: 9,
      thresholds: { guard: 0.2, patrol: 0.3, carryCorpse: 0.8 },
    },
    alate: { length: 1.1, clearance: 0.8, speed: 2.0, maxHealth: 12, lifespan: 2400, foodCost: 12 },
    casteRatio: { worker: 0.42, major: 0.5, soldier: 0.08 },
    startingWorkers: 12,
    startingFood: 40,
    /** Fraction of the founding workers that start as media (cutters). */
    startMediaFraction: 0.5,
  },
  termite: {
    /** Physogastric queen: huge, practically immobile egg factory. */
    queen: { length: 2.4, clearance: 1.2, speed: 0.12, maxHealth: 90, attack: 0, foodCost: 40 },
    king: { length: 0.9, clearance: 0.7, speed: 1.4, maxHealth: 30, attack: 1, foodCost: 30 },
    worker: {
      length: 0.6,
      speed: 2.0,
      maxHealth: 8,
      attack: 0.6,
      carryCapacity: 2,
      digRate: 1.5,
      lifespan: 1800,
      foodCost: 2.5,
      thresholds: { dig: 0.22, build: 0.3, feedLarva: 0.35, feedQueen: 0.3, carryBrood: 0.45, carryCorpse: 0.6 },
    },
    /** Mandibulate soldier: slow, tough, plugs tunnels with its head. */
    soldier: {
      length: 0.85,
      clearance: 0.6,
      speed: 1.6,
      maxHealth: 26,
      attack: 3.5,
      attackCooldown: 1.0,
      carryCapacity: 0,
      digRate: 0,
      lifespan: 2000,
      foodCost: 6,
      thresholds: { guard: 0.15, patrol: 0.6 },
    },
    /** Nasute: ranged glue spray, weak bite. */
    nasute: {
      length: 0.7,
      speed: 1.9,
      maxHealth: 11,
      attack: 0.8,
      attackCooldown: 1.6,
      carryCapacity: 0,
      digRate: 0,
      lifespan: 1800,
      foodCost: 5,
      thresholds: { guard: 0.2, patrol: 0.35 },
    },
    alate: { length: 0.9, clearance: 0.7, speed: 1.8, maxHealth: 8, lifespan: 2400, foodCost: 8 },
    casteRatio: { worker: 0.76, soldier: 0.09, nasute: 0.15 },
    startingWorkers: 14,
    startingFood: 45,
  },

  /**
   * Special attacks (data for B1's status-effect mechanism; keyed `${species}:${caste}`).
   * `dps`/`duration`: damage over time; `slow`: speed multiplier while it lasts; `stun`: seconds
   * the target is held; `range`: reach in world units (melee ≈ 1.3).
   */
  specialAttacks: {
    'fireAnt:worker': { effect: 'venom', dps: 0.5, duration: 6, slow: 0.9, stun: 0, range: 1.3, chance: 1 },
    'fireAnt:soldier': { effect: 'venom', dps: 0.9, duration: 8, slow: 0.85, stun: 0, range: 1.3, chance: 1 },
    'fireAnt:queen': { effect: 'venom', dps: 0.9, duration: 8, slow: 0.85, stun: 0, range: 1.3, chance: 1 },
    'termite:nasute': { effect: 'glue', dps: 0, duration: 7, slow: 0.3, stun: 1.2, range: 5.5, chance: 1 },
    'leafcutter:soldier': { effect: 'bleed', dps: 1.2, duration: 5, slow: 0.8, stun: 0, range: 1.5, chance: 0.6 },
  },

  // ---- termites ---------------------------------------------------------------------------
  termites: {
    /** Starting mud, and mud gained per voxel of anything a termite digs (soil → mud, wood → carton). */
    startMud: 14,
    mudPerVoxel: 0.16,
    /** Swallowed spoil beyond this is simply excreted (no endless stockpile). */
    mudMax: 180,
    /** Wood pulp digested into food per second per worker, and food per unit of wood. */
    // final round: 0.035 → 0.009. Digestion, not digging, is now the faucet: pulp is banked as
    // `stores.wood` (which stops new faces once the larder is full) instead of 700 food by
    // minute 10 that was laid straight into a 220-termite colony the log could not carry.
    digestPerWorker: 0.009,
    /** Final round: workers beyond this add no digestion (income levels off: a colony of ~150 is what the land carries). */
    digestWorkersMax: 42,
    /** Final round: a wood face needs at least this many edible voxels inside its brush. */
    faceMinCells: 7,
    // M3: 1.3 → 1.9 (wood only comes in at night / in dry weather through at most 18 faces)
    foodPerWood: 1.9,
    /** Keep at most this much wood face designated per worker (min 1, max `woodFacesMax`). */
    woodFacesPerWorker: 0.35,
    // M3: 12 → 18 (a 150-termite colony could not feed itself through 12 one-termite faces)
    woodFacesMax: 18,
    woodBrush: 2.2,
    /**
     * Stop designating new wood while stored pulp + food exceeds this per head.
     * M3: 3 → 9. Termites only reach the wood at night and in dry weather; with a 3-per-head
     * larder the colony boomed to 160 by minute 20 and then starved down to 70 through the first
     * sunny day + storm. They now bank enough at night to last the day.
     */
    woodEnoughPerAnt: 6,
    /** Sun damage per second to an exposed termite in full daylight; alates and royals are exempt. */
    sunDamage: 0.45,
    /** Hydration lost per second in the sun (and regained under cover). */
    sunDry: 0.03,
    /** Daylight window (timeOfDay) in which the sun burns. */
    sunFrom: 0.27,
    /** A job a termite was driven off by the sun is left alone this long (or until the sun stops burning). */
    sunBarSeconds: 240,
    sunTo: 0.73,
    /** Health fraction below which a scorched termite drops everything and runs for cover. */
    shadeHealth: 0.7,
    /** Shelter tube: ridge radius, bore radius, spacing of segments along the path, mud per segment. */
    tubeRidge: 2.6,
    tubeWall: 1.5,
    tubeWallOffset: 2.5,
    tubeRoof: 1.75,
    tubeRoofHeight: 3.1,
    tubeSpacing: 1.6,
    tubeMudPerSegment: 1.2,
    tubeWork: 1.6,
    /** Longest tube the colony will start (path cells). */
    tubeMaxLength: 90,
    /** Final round: tubes a colony keeps (the oldest plans simply stay as built). */
    tubesMax: 8,
    /** Mound: stamp radius, mud per stamp, mud kept in reserve for tubes/repairs, max height. */
    moundBrush: 1.9,
    moundMudPerStamp: 1.6,
    moundReserve: 8,
    moundMaxHeight: 14,
    moundEvery: 5,
    /** Final round: stamps the mound is owed = base + perAnt × population (capped). */
    moundStampsBase: 6,
    moundStampsPerAnt: 0.45,
    moundStampsMax: 140,
    /** Breach repair: plug radius and mud. */
    plugBrush: 2.0,
    plugMud: 1.0,
    /** Autonomous build job: urgency and worker slots. */
    buildUrgency: 0.62,
    buildSlots: 3,
    /** Royal chamber carved at the deadwood: radius, depth below the surface, max distance from the map spawn. */
    royalRadius: 4.2,
    royalDepth: 7,
    /**
     * Final round — windfall: every `windfallEvery` s (faster for big colonies, × pop/90 clamped
     * 0.6–1.6) up to `windfallPieces` twigs / litter heaps drop `windfallMin`–`windfallMax`
     * voxels from the nest, starting `windfallAfter` s into the game.
     */
    windfallAfter: 100,
    windfallEvery: 45,
    /** Share of pieces that land by the head of a finished shelter tube; sheeting radius there. */
    windfallAtTube: 0.5,
    sheetRadius: 7,
    windfallPieces: 3,
    windfallMin: 10,
    windfallMax: 36,
    windfallTwigChance: 0.4,
  },

  // ---- leafcutters --------------------------------------------------------------------------
  leafcutters: {
    /** Leaf patches seeded on climbable plants: amount, regrowth per second, how many at most. */
    // M3: 70 / 0.05 / 14 → 90 / 0.1 / 18. Fourteen patches regrowing 3 leaves a minute fed at most
    // ~42 food/min: leafcutters stalled at 60–100 ants with leaves at 0 and could never fly (150).
    patchAmount: 90,
    patchRegen: 0.1,
    patchMax: 18,
    /** M3: patches cut at once (was a fixed 3), and the amount below which a patch is left to regrow. */
    patchesWorked: 4,
    patchWorthwhile: 18,
    /** Colony knows leaf sources within base + grow × minutes of the nest. */
    knownRadiusBase: 45,
    knownRadiusGrow: 12,
    cutTime: 2.2,
    /** `food` trail laid by loaded cutters on the way home (the parade). */
    trailDeposit: 1.6,
    /** Stop cutting when this much leaf matter per garden is waiting. */
    leafStockPerGarden: 30,
    /** Non-leaf forage delivered by order becomes this fraction of substrate. */
    forageAsSubstrate: 0.5,
    // garden
    gardenStartBiomass: 8,
    gardenCapacity: 60,
    /** Each extra granary-class chamber converted adds a garden; need this fill to want one. */
    gardenExpandFill: 0.75,
    /**
     * M3: a throughput-limited colony also splits its comb — every garden saturated with substrate,
     * at least `splitLeafStock` leaves waiting and less than `splitFoodPerAnt` food per head — at
     * most once per `splitCooldown` seconds, up to `gardensMax` gardens.
     */
    gardensMax: 5,
    splitLeafStock: 12,
    splitFoodPerAnt: 1.5,
    splitCooldown: 120,
    /** Leaf matter bedded per tend action; substrate above `overload` rots (mould). */
    bedPerTend: 3,
    substrateOverload: 26,
    /** Substrate digested per second at full vigour, and fungus grown per unit of leaf. */
    // M3: 0.22 → 0.28 (one garden ≈ 23 food/min)
    digestRate: 0.28,
    fungusPerLeaf: 1.35,
    /** Fungus harvested into the food stores per tend action; biomass kept as seed stock. */
    harvestPerTend: 2.6,
    harvestReserve: 5,
    /** Seconds without a gardener before mould starts; growth per second; weeded per tend. */
    neglectTime: 50,
    mouldGrow: 0.006,
    mouldOverloadGrow: 0.01,
    mouldSpread: 0.004,
    weedPerTend: 0.12,
    mouldSick: 0.35,
    /** Biomass lost per second at full mould. */
    mouldDamage: 0.12,
    /** Comfortable temperature band (°C); outside it growth slows and mould creeps. */
    tempMin: 16,
    tempMax: 32,
    tendTime: 2.0,
    /** Tend actions per shift before the gardener re-decides. */
    tendsPerShift: 5,
    /** Seconds before a collapsed garden can be re-seeded. */
    reseedTime: 40,
  },

  // ---- aphids -------------------------------------------------------------------------------
  aphids: {
    startHerd: 4,
    capacity: 12,
    /** Seconds per new aphid at half capacity: wild / tended. */
    breedTime: 150,
    breedTimeTended: 55,
    /** Honeydew per aphid per second: wild / tended; source cap per aphid. */
    honeydew: 0.012,
    honeydewTended: 0.03,
    capPerAphid: 5,
    /** Ants within this distance of the herd discover it / count as tending. */
    discoverRadius: 7,
    /** Final round: an ant this far (or less) straight below a herd, within `discoverRadius` sideways, discovers it too. */
    discoverBelow: 16,
    tendRadius: 4,
    /** Seconds a herd stays "tended" after the last visit. */
    tendedFor: 40,
    /** Shepherd shift length, and tenders wanted per herd. */
    shift: 45,
    slots: 2,
    /** Final round: one more crew slot per `aphidsPerSlot` aphids, up to `slotsMax`. */
    aphidsPerSlot: 5,
    slotsMax: 4,
    /** Final round: seconds without a visit from its owner after which another colony's ants may adopt the herd. */
    abandonAfter: 75,
    urgency: 0.55,
    /** Extra honeydew stroked out per milking (taken from the source, carried home). */
    milkTime: 2.0,
  },

  // ---- rafts --------------------------------------------------------------------------------
  rafts: {
    /** Ants in flooded cells needed to start a raft, within `joinRadius` of each other. */
    minMembers: 4,
    joinRadius: 7,
    /**
     * Final round: when the NEST is flooding, every nestmate within `musterRadius` of the spot
     * links up at once (not only those already in the water); afterwards nestmates within
     * `callRadius` walk to the raft and climb aboard (workers bring brood they pass), the queen
     * first of all. `maxMembers` caps the body of the raft.
     */
    musterRadius: 8,
    callRadius: 18,
    maxMembers: 60,
    /** Late joiners within this distance of an existing raft's rim climb aboard. */
    boardRadius: 3.5,
    /** Disc spacing between member ants (world units). */
    spacing: 0.42,
    /** Drift speed (units/s) and how strongly wind pushes. */
    drift: 0.5,
    windFactor: 0.25,
    /** Minimum seconds afloat before it may land; cooldown before the colony rafts again. */
    minAfloat: 18,
    cooldown: 20,
    /** Water depth (0..1 in the ant's cell) that counts as "flooded". */
    floodDepth: 0.5,
  },

  // ---- keeper -------------------------------------------------------------------------------
  keeper: {
    firstDrop: 45,
    /** Seconds between food drops (min..max); amount = base + perAnt × population. */
    dropEvery: [70, 120],
    dropBase: 30,
    // M3: 0.8 → 0.55 (with the skip rule a farm colony now hovers around 2–4 food per head)
    dropPerAnt: 0.55,
    /** Don't drop while this much food per ant is still lying around / stored. */
    dropSkipFoodPerAnt: 3,
    waterEvery: [420, 700],
    waterAmount: 10,
    lampEvery: [360, 600],
    lampDuration: 150,
    tapEvery: [260, 520],
    tubeAt: 540,
    topUpEvery: [600, 900],
    /** Chance a scheduled food drop is contaminated (only after `contaminatedAfter` s). */
    contaminatedChance: 0.08,
    contaminatedAfter: 600,
    /** Tap: panic seconds, alarm deposit, radius; shake multiplies. */
    panicTime: 6,
    panicSpeed: 0.65,
    alarmDeposit: 3,
    tapRadius: 16,
    shakeMul: 2.5,
    topUpBrush: 2.4,
    topUpStamps: 3,
    /** Wood chunk dropped for wood-eaters: brush radius. */
    woodBrush: 2.2,
    tubeReward: 90,
  },

  // ---- goals / nuptial flight -----------------------------------------------------------------
  goals: {
    /** Seconds after a royal dies before the colony is lost (if no succession is possible). */
    grace: 12,
    /** Nominal day length on maps without a day/night cycle (survive goals, summary). */
    defaultDay: 600,
    /** Alates reared for the flight: base + per 50 population (capped). */
    alatesBase: 6,
    alatesPer50: 2,
    alatesMax: 14,
    /** Caste-ratio weight given to alates while rearing. */
    alateWeight: 0.6,
    /** Flight conditions. */
    minTemperature: 15,
    dayFrom: 0.3,
    dayTo: 0.78,
    /** Give up waiting for perfect weather after this long. */
    maxWait: 150,
    /** Gather: seconds allowed, fraction that must have arrived. */
    gatherTime: 40,
    gatherFraction: 0.7,
    /** Take-off: stagger between alates, climb speed multiplier, seconds until gone. */
    takeoffStagger: 0.35,
    flySpeed: 1.6,
    flightTime: 9,
    /** Fraction of the wanted alates that must get away for the win. */
    winFraction: 0.5,
  },
} as const;
