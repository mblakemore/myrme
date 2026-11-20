/**
 * Balance section owned by stream B1 (combat, creatures, rivals, director).
 * Times are sim seconds unless the name ends in `Ticks`; distances are world units (voxels).
 */
export const b1Balance = {
  // ---- melee -------------------------------------------------------------------------------
  combat: {
    /** Mandible reach beyond the two body radii. */
    biteReach: 0.7,
    /** Body radius = length × this (ants and creatures), capped at `bodyRadiusMax`. */
    bodyRadiusPerLength: 0.3,
    bodyRadiusMax: 2.8,
    /** Damage multipliers by where the attacker stands relative to the victim's heading. */
    flankMul: 1.2,
    rearMul: 1.5,
    /** Bonus against a fully pinned victim. */
    pinnedMul: 1.3,
    /** A possessed ant bites harder and more precisely (player skill matters). */
    possessedMul: 1.6,
    /** Armour never absorbs more than this share. */
    armourCap: 0.9,
    /** Share of direct damage absorbed, by caste (species may override via `registerArmour`). */
    armour: { queen: 0.3, king: 0.3, worker: 0, soldier: 0.25, major: 0.3, nasute: 0.15, alate: 0 },
    /** Grapple: weight an ant adds when latched on, and latched weight that immobilises it. */
    grappleWeight: { queen: 2, king: 1.5, worker: 1, soldier: 2, major: 2.5, nasute: 1.5, alate: 0.8 },
    grappleHold: { queen: 6, king: 4, worker: 2, soldier: 4, major: 5, nasute: 3, alate: 2 },
    /** A latch lasts this long after the latest landed bite. */
    latchTicks: 50,
    /** A latched ant further than this from its victim lets go. */
    latchBreakDist: 2.2,
    /** Speed never drops below this share from grappling until the victim is fully pinned. */
    grappleMinSpeed: 0.12,
    /** M3: a grappled ant's bite cooldown × (1 + this × latchers / hold), × (1 + this) when pinned. */
    grappleAttackSlow: 2,
    /** Health per second regained while resting inside the nest, and the quiet time needed first. */
    regenPerSec: 0.3,
    regenQuiet: 6,
    /** Home-field steps that count as "inside the nest" for regeneration. */
    regenHomeSteps: 26,
    /** Creatures out of combat heal this share of max health per second. */
    creatureRegen: 0.012,
    /** Relative fighting power per caste (odds estimates, raid sizing, director caps). */
    power: { queen: 2, king: 1, worker: 1, soldier: 3.5, major: 3.2, nasute: 3, alate: 0.6 },
    /** Default profiles per attack kind (B3 species data may override, see contracts/b1.ts). */
    sting: { range: 0, armourPierce: 0.3, damageMul: 1, poisonDps: 0.6, poisonTime: 4, poisonStacks: 3 },
    acid: { range: 1.6, armourPierce: 0.7, damageMul: 0.9, poisonDps: 0.4, poisonTime: 3, poisonStacks: 2 },
    glue: { range: 2.2, armourPierce: 0, damageMul: 0.3, gluedTime: 2.5, gluedChance: 0.6, slowMul: 0.45, slowTime: 6 },
    /** Seconds between `underAttack` alerts. */
    alertCooldown: 25,
    queenDangerRadius: 7,
  },

  // ---- alarm pheromone ---------------------------------------------------------------------
  alarm: {
    /** `alarm` pheromone laid at the cell of an ant that bites or is bitten. */
    deposit: 2.5,
    /** Seconds an alarm call stays live without being refreshed. */
    ttl: 7,
    /** Calls closer than this merge into one. */
    mergeDist: 6,
    maxCalls: 10,
    /** Soldiers answer from this far; workers join / flee within `workerRadius`. */
    soldierRadius: 26,
    workerRadius: 9,
    /** Ticks between `pheromoneBurst` events of one call (FX). */
    burstTicks: 45,
  },

  // ---- fight / flee / guard ------------------------------------------------------------------
  fight: {
    /** Distance at which a caste notices enemies by itself. */
    senseWorker: 4.5,
    senseSoldier: 9,
    /** Radius of the odds estimate around the ant. */
    oddsRadius: 6.5,
    /** Workers fight outside the nest when allies' power ≥ enemies' power × this. */
    oddsWorker: 1.0,
    /** Inside this many home-field steps everybody defends. */
    nestDefendSteps: 30,
    /** Disengage below this health share. */
    fleeHealthWorker: 0.35,
    fleeHealthSoldier: 0.12,
    /** Max distance from where the fight started. */
    leashWorker: 14,
    leashSoldier: 30,
    /** Commitment after the latest bite (prevents dithering). */
    commitTicks: 60,
    chaseSpeed: 1.2,
    /** Final round: ant-vs-ant fighters hold at (own + target body radius) × this (heads meet, bodies apart). */
    holdPerRadii: 1.7,
    /** Final round: ticks of being blocked on the approach before a fighter circles to a free side. */
    flankAfterTicks: 5,
    /** Final round: separation push / resting push / radius multipliers between ants in melee (movement.ts). */
    meleeSepPush: 1.3,
    meleeRestPush: 0.9,
    meleeSepRadius: 1.25,
    /** Final round: an enemy ant with this much latched weight on it is "taken": others pick another. */
    crowdedLatch: 4,
    crowdedPenalty: 2,
    /** Seconds a target that could not be reached is ignored. */
    ignoreTime: 6,
    /** Workers hunt prey creatures they find within this distance. */
    preySense: 4,
    /** Prey with more ants on it than this × its hold does not attract more hunters. */
    preyMobFactor: 3,
    /** Workers exposed to a flying predator within this distance run for cover. */
    flyerScare: 5,
    /**
     * M3 home muster: enemy ants within `homeRadius` of the nest are fought by every worker within
     * `homeMusterRadius` of the alarm call, whatever the odds (a raid meets the whole colony).
     */
    homeRadius: 24,
    homeMusterRadius: 30,
    /** M3: the muster stops recruiting once the defenders' power is this many times the raiders'. */
    homeMusterOdds: 3,
    /** Extra "distance" a queen / king gets as a target: defenders are fought first. */
    royalLast: 6,
  },
  flee: {
    panicTicks: 110,
    speed: 1.3,
    /** A fleeing carrier drops its load when the enemy is this close. */
    dropLoadDist: 3.5,
    /** Home-field steps at which a fleeing ant is "indoors". */
    safeSteps: 10,
  },
  guard: {
    /** Seconds of one guard shift. */
    shift: 80,
    /** Guards stand within this distance of the post. */
    postRadius: 2.5,
    /** Intruders this close to the post are intercepted. */
    interceptRadius: 14,
  },

  // ---- raids ---------------------------------------------------------------------------------
  raid: {
    /** Seconds a party waits at the rally point (or until `musterFrac` of it has gathered). */
    musterTime: 35,
    musterFrac: 0.7,
    /** Give up the whole raid after this long. */
    maxTime: 420,
    /** Seconds the party stays at the target once the fighting stops. */
    lingerScout: 20,
    lingerPicket: 70,
    lootTime: 45,
    /** Members return when fewer than this share of the party is left. */
    routFrac: 0.5,
    /** Final round: a player war party falls back when fewer than this share of it is left. */
    warRoutFrac: 0.45,
    /** Final round: a beacon war party marches only with at least this share of the defenders' power; re-checked every `warRecheck` s. */
    warMinOdds: 0.8,
    /** Final round: a blooded war party falls back when its power drops under this share of the defenders'. */
    warRetreatOdds: 0.4,
    warRecheck: 45,
    advanceSpeed: 0.95,
    /** M3: in parties of `cohesionMinSize`+, ants more than `cohesion` voxels ahead of the party's mean wait. */
    cohesion: 7,
    cohesionMinSize: 8,
    /** Food taken per looting ant from the victim's stores; food value of a stolen brood item. */
    lootPerAnt: 2,
    broodFood: 1.5,
    /** The player's Attack beacons farther than this from the nest get a mustered war party. */
    beaconMinDist: 28,
    beaconParty: 10,
    /** M3: share of the available ants a distant beacon musters (point target / rival nest), capped. */
    beaconFrac: 0.2,
    beaconWarFrac: 0.6,
    beaconPartyMax: 90,
    /** M3: a beacon this close to a rival's nest or entrance makes the party assault that colony. */
    beaconNestRadius: 14,
    /** M3: seconds before a beaten war party is replaced (a standing beacon must not bleed the colony dry). */
    beaconWarCooldown: 150,
  },

  // ---- rival colonies ------------------------------------------------------------------------
  rivals: {
    /** Seconds between strategic decisions of an AI colony. */
    thinkEvery: 3,
    /** First scout no earlier than this; then every `scoutEvery` (÷ intensity). */
    scoutAfter: 100,
    scoutEvery: 150,
    /** Pickets on contested food. */
    picketAfter: 420,
    picketEvery: 170,
    picketSize: 3,
    /** Share of the rival's available fighters a raid may take, and its hard caps. */
    raidFrac: 0.5,
    raidMin: 3,
    raidMax: 28,
    /** Each raid on the same victim is this much larger than the previous one. */
    raidEscalation: 1.3,
    /** Fighters kept home whatever happens. */
    homeGuard: 2,
    /**
     * Final round: share of its fighters a rival keeps home = guardFrac ÷ sqrt(intensity), clamped
     * (easy 0.65, normal 0.5, hard 0.41, brutal 0.34); below `raidMinFighters` it does not raid.
     */
    guardFrac: 0.5,
    guardFracMin: 0.25,
    guardFracMax: 0.65,
    raidMinFighters: 9,
    /** Final round: food pickets only from this intensity up (not on easy). */
    picketMinIntensity: 0.8,
    /** Final round: soldiers join pickets only from this intensity up. */
    picketSoldierIntensity: 1.4,
    /** Final round: AI population cap ∝ intensity^this (easy 37, normal 56, hard 77, brutal 105). */
    popCapPow: 0.8,
    /** Final round, above normal only: extra starting workers (× intensity^this) and a food income per second per (intensity − 1). */
    startPow: 1,
    subsidy: 0.3,
    /** Caste ratio an AI colony shifts to once it has scouted an enemy. */
    warSoldierRatio: 0.22,
    /** Seconds leaderless ants of a fallen colony live on. */
    routTime: 80,
    /** Starting workers of an AI colony = species default × this. */
    startScale: 1,
    /**
     * M3: an AI colony stops growing at `popCap × sqrt(intensity)` adults (easy 43, normal 56,
     * hard 69, brutal 83). Uncapped, a rival snowballed to 130+ by minute 30 — as fast as the
     * player — so it could neither be beaten (forest goal) nor held off late.
     */
    popCap: 56,
  },

  // ---- threat director -----------------------------------------------------------------------
  director: {
    /** Seconds between director decisions. */
    thinkEvery: 2,
    /** Budget per second: base + perAnt × population + perDay × days (all × intensity). */
    budgetBase: 0.012,
    budgetPerAnt: 0.0011,
    budgetPerDay: 0.012,
    budgetMax: 60,
    /** Day length used when the map has no day/night cycle. */
    defaultDay: 300,
    /** Quiet start (÷ sqrt(intensity)). */
    graceTime: 150,
    /** Seconds between waves (± jitter, ÷ intensity^0.6). */
    waveEvery: 95,
    waveJitter: 0.3,
    /** A wave's threat may not exceed this share of the colony's defence power (× intensity). */
    capShare: 0.32,
    /** Final round: cap ∝ intensity^capPow, plus `capFloor × (intensity − 1)` above normal. */
    capPow: 1.8,
    /** Final round: above normal the stage population thresholds are ÷ intensity^gatePow. */
    gatePow: 1.3,
    /** Final round: director predators' health and damage × (1 + this × (intensity − 1)). */
    toughPerIntensity: 0.6,
    /** Final round: from this intensity up spiders and beetles arrive in pairs; no rival raid before `raidMinTime` s. */
    pairIntensity: 2,
    raidMinTime: 400,
    capFloor: 12,
    /** Final round: budget ∝ intensity^budgetPow; wave spacing ÷ pace^wavePacePow. */
    budgetPow: 1.3,
    wavePacePow: 0.9,
    /** Threat already on the map counts against the cap. */
    /** Losses: quiet period when more than `lossShare` of the population died within `lossWindow`. */
    lossShare: 0.22,
    lossWindow: 60,
    quietTime: 110,
    /** Final round: at intensity ≤ 1 nothing new is sent while the colony is under `mercyPop` adults AND under `mercyShare` of its best. */
    mercyPop: 18,
    mercyShare: 0.8,
    /** Stage thresholds (seconds elapsed, population), ÷ sqrt(intensity) for time. */
    stageTime: [0, 210, 480, 1080, 1500],
    stagePop: [0, 16, 30, 60, 80],
    /** Events: cost, minimum stage, minimum seconds between two of the same kind. */
    events: {
      scout: { cost: 1, stage: 0, cooldown: 80 },
      prey: { cost: 0.5, stage: 0, cooldown: 240 },
      predator: { cost: 6, stage: 1, cooldown: 260 },
      beetleRaid: { cost: 9, stage: 2, cooldown: 300 },
      rivalRaid: { cost: 8, stage: 2, cooldown: 240 },
      tubeRaid: { cost: 5, stage: 1, cooldown: 200 },
      waspSeason: { cost: 10, stage: 2, cooldown: 360 },
      boss: { cost: 30, stage: 3, cooldown: 900 },
    },
    /** Wasps per season at intensity 1. */
    waspCount: 2,
    /** Size of a tube-port invasion = base + perAnt × population (× intensity), capped. */
    tubeBase: 2,
    tubePerAnt: 0.12,
    tubeMax: 16,
    /** Edge spawns keep at least this far from the player's entrance. */
    spawnMinDist: 34,
    /** Director-spawned predators leave after this long. */
    predatorStay: 240,
  },

  // ---- creatures -----------------------------------------------------------------------------
  /**
   * Per-creature tuning beyond `CreatureDef` (data/creatures.ts wires the def numbers too).
   *  armour: share of direct damage absorbed · hold: latched weight that immobilises it ·
   *  power: fighting power for odds · turn: turn rate (rad/s) while striking ·
   *  retreatHealth: share of health at which it disengages · territory: roam radius
   */
  creatures: {
    jumpingSpider: {
      def: { length: 3.2, clearance: 1.8, speed: 3.3, maxHealth: 170, attack: 6, attackCooldown: 1.2, senseRadius: 15, foodValue: 60, threat: 6 },
      armour: 0.3,
      hold: 8,
      power: 9,
      turn: 5,
      retreatHealth: 0.45,
      territory: 34,
      /** Pounce: launch distance, leap speed multiplier, leap time, damage, cooldown. */
      pounceRange: 6,
      pounceSpeed: 3.2,
      pounceTime: 0.7,
      pounceDamage: 13,
      pounceCooldown: 5,
      stalkSpeed: 0.45,
      /** Retreats when this many ants hang on it. */
      mobLimit: 5,
      /** Seconds: eating a catch, digesting in the lair before the next hunt. */
      eatTime: 12,
      digestTime: 70,
      restTime: 40,
    },
    antlion: {
      def: { length: 2.2, clearance: 1.4, speed: 0, maxHealth: 80, attack: 12, attackCooldown: 1.7, senseRadius: 5, foodValue: 40, threat: 4 },
      armour: 0.3,
      hold: 99,
      power: 5,
      turn: 9,
      /** Pit: default radius when the map gives none; slide speed at rim → centre; slope slow. */
      pitRadius: 5,
      pullRim: 0.9,
      pullCentre: 2.1,
      slopeSpeed: 0.55,
      grabRadius: 1.5,
      eatTime: 5,
      /** `avoid` scent laid around the pit for a colony that lost an ant there. */
      avoidDeposit: 6,
      /** M3: outside this share of the radius a wary ant backs out of the pit at `warySpeed`. */
      /** M3: extra A* cost (cell steps) of every cell on the slope. */
      pathCost: 40,
      waryRing: 0.5,
      warySpeed: 2.0,
    },
    groundBeetle: {
      def: { length: 3.6, clearance: 2.0, speed: 1.7, maxHealth: 240, attack: 5, attackCooldown: 1.3, senseRadius: 10, foodValue: 90, threat: 9 },
      armour: 0.6,
      hold: 16,
      power: 12,
      turn: 2.5,
      retreatHealth: 0.3,
      territory: 14,
      /** Seconds between raids of a resident beetle; time it stays at the entrance; bites of food it wants. */
      raidEvery: 260,
      raidTime: 70,
      appetite: 5,
      eatTime: 3,
      /** Food eaten from a source / item per bite. */
      bite: 4,
    },
    wasp: {
      def: { length: 2.4, clearance: 1.4, speed: 5.2, maxHealth: 40, attack: 7, attackCooldown: 2.2, senseRadius: 20, foodValue: 30, threat: 5 },
      armour: 0,
      hold: 3,
      power: 4,
      turn: 9,
      retreatHealth: 0.5,
      cruiseHeight: 9,
      swoopSpeed: 1.5,
      /** Aborts a swoop when this much soldier power stands near the victim. */
      guardPower: 5,
      guardRadius: 3.5,
      /** Passes before it gives up and leaves. */
      passes: 4,
      passCooldown: 7,
    },
    mantis: {
      def: { length: 9, clearance: 2.4, speed: 2.0, maxHealth: 700, attack: 26, attackCooldown: 2.4, senseRadius: 22, foodValue: 400, threat: 30 },
      armour: 0.4,
      hold: 40,
      power: 45,
      turn: 0.9,
      retreatHealth: 0,
      territory: 60,
      strikeReach: 3.6,
      /** Half-angle (cosine) of the strike cone in front of it. */
      strikeCone: 0.55,
      eatTime: 4,
    },
    aphid: {
      def: { length: 0.4, clearance: 0.4, speed: 0.3, maxHealth: 3, attack: 0, attackCooldown: 1, senseRadius: 2, foodValue: 2, threat: 0 },
      armour: 0,
      hold: 0.5,
      power: 0,
      turn: 3,
    },
    caterpillar: {
      def: { length: 3, clearance: 1.2, speed: 0.6, maxHealth: 46, attack: 2, attackCooldown: 1, senseRadius: 3, foodValue: 80, threat: 0 },
      armour: 0.1,
      hold: 6,
      power: 2,
      turn: 2,
      territory: 9,
      /** Thrash: seconds between thrashes while bitten, duration, radius, damage, flee speed. */
      thrashEvery: 2.6,
      thrashTime: 0.8,
      thrashRadius: 2.2,
      thrashDamage: 2.5,
      fleeSpeed: 2.2,
    },
    worm: {
      def: { length: 4, clearance: 1.0, speed: 0.45, maxHealth: 34, attack: 1.5, attackCooldown: 1, senseRadius: 2, foodValue: 60, threat: 0 },
      armour: 0,
      hold: 5,
      power: 1.5,
      turn: 2,
      territory: 7,
      thrashEvery: 3.2,
      thrashTime: 0.7,
      thrashRadius: 2.4,
      thrashDamage: 2,
      fleeSpeed: 1.8,
    },
  },
} as const;
