/**
 * Balance section owned by stream B2 (weather, water / flooding, temperature, zombie fungus).
 * Times are sim seconds unless the name ends in `Ticks`; water volumes are voxels.
 */
export const b2Balance = {
  // ---- clock ---------------------------------------------------------------------------
  /** Sim seconds per day on maps with a day/night cycle (overrides the map's `dayLength`). */
  dayLength: 720,
  /** Time of day at game start (0..1; 7/24 = 07:00). */
  startTimeOfDay: 7 / 24,

  // ---- weather state machine -----------------------------------------------------------
  /** Phase durations [min, max]. */
  phaseTime: {
    clear: [150, 330],
    cloudy: [60, 120],
    fog: [60, 100],
    drizzle: [60, 120],
    rain: [80, 150],
    storm: [50, 90],
    cloudburst: [30, 50],
    clearing: [40, 70],
    heat: [120, 200],
    cold: [90, 150],
    wind: [60, 110],
    room: [600, 600],
  },
  /** The first phase is always clear and lasts at least this long (grace period). */
  graceSeconds: 400,
  /** "Rain is coming" alert this long before rain / storm starts. */
  forecastLead: 45,
  /** Seconds for rain / cloud / fog / wind to ease towards the phase's targets. */
  rainEase: 7,
  cloudEase: 14,
  fogEase: 20,
  windEase: 10,
  /** Wind speed (units/s) per phase family. */
  windCalm: 0.35,
  windRain: 1.2,
  windStorm: 2.6,
  windGale: 2.2,
  /** Surface wetness gained per second at rain 1, and lost per second when dry (× heat / wind factors). */
  wetGain: 0.035,
  wetDry: 0.0045,
  /** Seconds a `debugWeather` command holds the weather. */
  debugHoldSeconds: 600,
  /** Seconds between lightning strikes in a storm [min, max]; stun radius / seconds around a strike. */
  lightningEvery: [6, 16],
  lightningStunRadius: 3,
  lightningStun: 2.5,

  // ---- raindrops -----------------------------------------------------------------------
  /** Drop impacts per second over the whole map at rain 1 (ambient, uniformly random). */
  dropsAmbient: 5,
  /** Extra impacts per second at rain 1 that land near exposed ants (scaled down when few are out). */
  dropsNearAnts: 4,
  /** Exposed-ant count at which the near-ant drop rate saturates. */
  dropsAntsFull: 6,
  /** Scatter radius of a near-ant drop around its ant, and the splash radius of an impact. */
  dropScatter: 5,
  dropRadius: 1.15,
  /** Fraction of the splash radius that is a direct hit. */
  dropCore: 0.5,
  /** Damage of a direct hit, stun seconds for direct / near hits. */
  dropDamage: 2.5,
  dropStunDirect: 1.8,
  dropStunNear: 0.6,
  /** Surfaces steeper than this `up.y` cannot be held under a hit: the ant is knocked off (stems, walls). */
  dropKnockUpY: 0.6,
  /** Rain rate below which no impact events are generated (drizzle is harmless). */
  dropMinRain: 0.3,

  // ---- shelter signal --------------------------------------------------------------------
  /** Rain rate at which the colony calls its foragers home, and at which it lets them out again. */
  shelterRainOn: 0.45,
  shelterRainOff: 0.25,
  /** Final round: with less stored food than this per adult, foragers work through rain (never through a storm). */
  rainForageFood: 0.8,
  /** Final round: the queen's untouched reserve is multiplied by this while a shelter signal holds the foragers in. */
  layReserveShelterMul: 4,
  /** Sun-exposed surface temperature (°C) above which foragers stay in (and resume below `heatOff`). */
  shelterHeatOn: 51,
  shelterHeatOff: 47,
  /** Surface temperature below which foragers stay in. */
  shelterColdOn: 7,
  shelterColdOff: 9,
  /** Speed multiplier on rain-wet exposed ground at wetness 1. */
  wetSlow: 0.25,

  // ---- water field (D17) -----------------------------------------------------------------
  /** Depth above which a cell counts as flooded (ants swim, nav hazards). */
  floodDepth: 0.5,
  /** Cell updates the flow simulation may spend per tick, and pressure searches per tick. */
  flowBudget: 1800,
  pressureBudget: 6,
  /** Cells a pressure search (communicating vessels) may visit. */
  pressureNodes: 400,
  /** Fraction of a depth difference moved sideways per update. */
  flowShare: 0.4,
  /** Water thinner than this does not creep onto dry cells; below `filmDry` a cell dries out. */
  filmMin: 0.05,
  filmDry: 0.012,
  /** Absorption per second per touching face, index = MaterialId (air, soil, sand, clay, rock, gel, wood, litter, plant, mud, fungus). */
  absorb: [0, 0.006, 0.016, 0.0012, 0, 0, 0.001, 0.01, 0, 0.002, 0.002],
  /** The floor face counts this many times. */
  absorbFloorMul: 2,
  /** Ticks between drain passes. */
  drainEveryTicks: 15,
  /** Evaporation from free surfaces per second at 25 °C, and extra per °C above. */
  evapBase: 0.0012,
  evapPerDegree: 0.00025,
  /** Saturated ground soaks slower: drain × (1 − this × wetness) in the rain, × `drainWetAfter` of that once it stopped. */
  drainWetDamp: 0.9,
  drainWetAfter: 0.6,

  // ---- rain inflow -----------------------------------------------------------------------
  /** Voxels per second running into a nest entrance at rain 1 with a fully open catchment. */
  entranceInflow: 1.3,
  /** A direction counts as blocked (mound / raised rim) when the ground rises this much towards the entrance. */
  moundHeight: 0.75,
  /** Inflow never drops below this fraction (rain falls straight into the hole). */
  entranceMinCatch: 0.12,
  /** Voxels per second per unit of puddle-site radius² at rain 1. */
  puddleInflow: 0.05,
  /** Voxels per second into each natural depression at rain 1. */
  depressionInflow: 0.3,
  /** Coarse block size for the natural-depression scan, and how much lower than its rim a hollow must be. */
  depressionBlock: 12,
  depressionDepth: 1.5,
  maxDepressions: 24,

  // ---- drowning & flood response ------------------------------------------------------------
  /** Seconds an adult can swim before it starts to drown; health lost per second after that. */
  swimSeconds: 12,
  drownDamage: 2.5,
  /** Submersion counter recovery (ticks per tick out of the water). */
  swimRecover: 3,
  /** Seconds a piece of brood survives under water. */
  broodDrownSeconds: 7,
  /** Speed multiplier while swimming / wading. */
  swimSpeed: 0.45,
  wadeSpeed: 0.75,
  /** Ants turn back / climb out at this depth. */
  escapeDepth: 0.2,
  /** Seconds an ant keeps climbing after leaving the water. */
  escapeLinger: 2.5,
  /** Wet nest cells (depth > 0.3) at which the nest counts as flooded. */
  floodCells: 5,
  /** Brood within this height of the water surface is evacuated. */
  broodMargin: 1.2,
  /** Seconds after the nest dried before the emergency nursery is closed. */
  refugeHold: 45,
  /** Carry speed of rescuers. */
  rescueSpeed: 0.9,

  // ---- temperature -------------------------------------------------------------------------
  /** Day/night swing (°C, ± around the map's base temperature) per environment. */
  swing: { meadow: 9, forest: 6.5, desert: 13, farm: 0 },
  /** Time of day of the daily maximum. */
  hottestTime: 0.6,
  /** Clear nights lose this much extra. */
  clearNightDrop: 3,
  /** Cloud damps the swing by this fraction at full cover; rain cools by this much at rain 1. */
  cloudDamp: 0.5,
  rainCool: 3.5,
  /** Heat-wave / cold-snap offset at intensity 1. */
  heatWave: 8,
  coldSnap: 10,
  /** Extra °C on a fully sun-exposed surface at noon per environment. */
  sunHeat: { meadow: 5, forest: 3, desert: 8, farm: 0 },
  /** Shade (cover overhead, near the surface) is this much cooler than the air per unit of sun. */
  shadeCool: 3,
  /** Depth below the local surface at which the ground temperature is stable. */
  stableDepth: 7,
  /** Deep-ground temperature = base + this (per environment). */
  deepOffset: { meadow: -1, forest: 0, desert: -7, farm: 0 },
  /** Seconds for the ambient temperature to ease towards its target. */
  tempEase: 25,
  /** Keeper lamp (`weather.lamp`): radius and °C at its centre. */
  lampRadius: 22,
  lampDelta: 14,
  /** Activity curve: [°C, speed multiplier] knots (linear in between). */
  activity: [
    [2, 0.35],
    [10, 0.55],
    [18, 0.9],
    [24, 1],
    [32, 1.08],
    [40, 1],
    [50, 0.8],
  ],
  /** Desiccation: hydration lost per second per °C above `dryTemp`; regained per second in the cool; near water. */
  dryTemp: 44,
  dryRate: 0.0026,
  rehydrate: 0.02,
  drinkRate: 0.25,
  /** Health lost per second at hydration 0. */
  dryDamage: 0.6,
  /** Ants look for shade below this hydration. */
  thirsty: 0.45,
  /** Brood development: ×(1 + perDegree × (T − ideal)), clamped. */
  broodIdeal: 24,
  broodPerDegree: 0.045,
  broodDevMin: 0.6,
  broodDevMax: 1.5,
  /** Drought: exposed perishable food loses this fraction per second above `dryTemp` at the surface. */
  foodDryRate: 0.0012,
  /** Sun-sensitive species (termites) seek cover above this sun exposure. */
  sunSensitiveExposure: 0.35,

  // ---- zombie fungus -------------------------------------------------------------------------
  /** Spore load lost per second (self-grooming); × this when nestmates are close (allogrooming). */
  loadDecay: 0.004,
  loadDecaySocial: 3,
  /** Incubation [min, max] — no symptoms; detectable by smell in the last `lateIncubation` fraction. */
  incubation: [85, 140],
  lateIncubation: 0.45,
  /** Erratic stage [min, max]; then the summit compulsion for at most `summitMax`. */
  erratic: [40, 65],
  summitMax: 80,
  /** Seconds clamped on before the stalk starts; stalk growth time; sporulation time; burst interval. */
  gripTime: 18,
  fruitTime: 55,
  sporulateTime: 300,
  burstEvery: 24,
  /** Spore rain radius of a stalk at height (grows with drop height), and of a ground corpse. */
  burstRadius: 6,
  burstSpread: 0.2,
  groundBurstRadius: 3.2,
  /** Infection load added at the centre of a burst, and per second inside a lingering cloud. */
  burstDose: 0.55,
  cloudDose: 0.06,
  cloudLinger: 10,
  /** Health of a fruiting body (bites to chew it down). */
  stalkHealth: 14,
  /** Grip height window above the base of a stem, as [min units, fraction of stem length]. */
  gripHeight: 3.5,
  gripFraction: 0.7,
  /** An exiled ant only summits when a grip point is within this many steps. */
  exileSummitSteps: 14,
  /** Seconds an infected corpse lies before it fruits (× `middenSlow` in the midden); ground stalk burst interval. */
  corpseFruit: 110,
  middenSlow: 0.3,
  /** Map-native stalks: burst interval, and how many summit sites carry one at the start (forest). */
  nativeBurstEvery: 38,
  nativeStalks: 1,
  /** Seasonal spore drift: chance per minute for an outdoor forager from day `seasonDay`, growth per day, humidity boost. */
  seasonChance: 0.05,
  seasonDay: 1,
  seasonPerDay: 0.35,
  seasonHumid: 1.5,
  seasonMaxActive: 2,
  // social immunity
  /** Smell radius and chance per nestmate per check (2 Hz) for late incubation; × this for erratic ants. */
  smellRadius: 2.2,
  smellChance: 0.035,
  smellErraticMul: 4,
  /** Grooming: seconds, cure chance while incubating, chance the groomer is dusted. */
  groomTime: 4,
  groomCure: 0.6,
  groomRisk: 0.05,
  /** Exile: how far from the entrance the victim is dragged; drag speed. */
  exileDistance: 26,
  dragSpeed: 0.75,
  /** Hygiene duty score at priority 1. */
  hygieneScore: 0.85,
  /** Load a corpse carrier picks up from an infected corpse. */
  corpseDose: 0.08,
  /** `avoid` pheromone laid under a known stalk per burst. */
  avoidDeposit: 2.5,
  /** Distance at which a colony notices a fruiting body. */
  stalkSight: 9,
  /** Seconds between repeated alerts of the same kind. */
  alertCooldown: 40,
} as const;
