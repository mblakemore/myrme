/** Balance section owned by stream A2a (locomotion, paths, pheromones, dig, falling). */
export const a2aBalance = {
  // ---- paths (D15, §12) ----------------------------------------------------------------
  /** A* node expansions the path queue may spend per tick. Node counts, never wall-clock. */
  pathBudgetPerTick: 2500,
  /** BFS nodes per tick spent on rebuilding distance fields after edits. */
  fieldBudgetPerTick: 6000,
  /** Ticks to wait before re-requesting a failed path. */
  pathRetryTicks: 45,
  /** Ticks without progress before a path is abandoned and re-requested. */
  stuckTicks: 60,
  /** Ticks without progress before a follower starts side-stepping. */
  sidestepTicks: 10,
  /** Ticks without progress before a follower may step straight across a gap to a close waypoint. */
  bridgeTicks: 24,
  /** Re-plans without reaching a single waypoint before the last-resort snap. */
  maxReplans: 3,
  /** M3: after `maxReplans` failures on one waypoint closer than this, the mover scrambles onto its cell. */
  hopReach: 3.5,
  /** Consecutive partial paths towards one goal before it counts as failed. */
  maxPartials: 4,

  // ---- crawl (D11) ---------------------------------------------------------------------
  /** Body radius used for ant–ant separation, as a multiple of ride height. */
  sepRadiusPerRide: 1.9,
  /** Max separation push speed as a fraction of the mover's own speed. */
  sepPush: 0.55,
  /** Sideways "keep right" bias when meeting oncoming traffic (fraction of speed). */
  sepLane: 0.5,
  /** Push speed applied to resting movers that overlap (fraction of speed). */
  sepRestPush: 0.25,
  /** Speed multiplier per MaterialId of the surface walked on (index = MaterialId). */
  terrainSpeed: [1, 1, 0.85, 1, 1, 0.9, 1, 0.8, 1, 0.6, 0.9],
  /** Speed lost at a full load (carry amount = caste capacity). 0 = off: behaviors already slow carriers through `intent.speedMul`. */
  carrySlow: 0,

  // ---- flyers (D11) --------------------------------------------------------------------
  /** Velocity blend per tick towards the wished velocity. */
  flyAccel: 0.12,
  /** Look-ahead distance (voxels) for obstacle avoidance, per unit of speed. */
  flyLookPerSpeed: 0.6,
  /** Distance flyers keep from surfaces while cruising. */
  flyClearance: 1.4,
  /** Preferred hover height above the ground when idle. */
  flyHoverHeight: 4,

  // ---- falling (D12) -------------------------------------------------------------------
  /** D12 fall speed, units per second. */
  fallSpeed: 9,

  // ---- pheromones (D16) ----------------------------------------------------------------
  /** Pheromone evaporation period in ticks (2 Hz). */
  evaporateEveryTicks: 15,
  /** Keep factor per evaporation step, index = PheroChannel (food, alarm, death, dig, rally, attack, avoid, trail). */
  pheroKeep: [0.985, 0.9, 0.995, 0.97, 0.95, 0.93, 0.97, 0.99],
  /** Saturation cap per channel. */
  pheroMax: [10, 10, 10, 10, 10, 10, 10, 10],
  /** Entries below this value are freed. */
  pheroFloor: 0.02,
  /** Max live cells per (colony, channel). */
  pheroMaxEntries: 65536,
  /** Strength of another colony's pheromone relative to one's own. */
  pheroForeignFactor: 0.5,
  /** Extra decay on sky-exposed cells per unit of wind speed. */
  pheroWindDecay: 0.25,
  /** Extra decay on sky-exposed cells at full rain intensity (trail washout). */
  pheroRainDecay: 6,

  // ---- digging & building (D4) ---------------------------------------------------------
  /** Smallest brush radius of a dig/build stamp (D4 minimum); also the possession-dig brush. */
  digBrush: 1.5,
  /** Designations up to this radius are ONE stamp of the designation's own radius. */
  digBrushMax: 2.4,
  /** Brush radius of the lattice stamps of bigger designations. */
  digLatticeBrush: 2.0,
  /** Spacing of lattice stamp centres (≤ brush so neighbouring stamps join with a wide neck). */
  digSpacing: 1.5,
  /** How far (centre to centre) an ant can be from a `digBrush` stamp and still work on it; bigger stamps add their extra radius. */
  digReach: 3.4,
  /** Multiplier on (voxels × material digCost) → work units per stamp. */
  digCostScale: 0.12,
  /** Lower bound of work units per stamp. */
  digMinCost: 0.6,
  /** Work units to place one build stamp, and mud units it consumes. */
  buildCost: 1.2,
  buildMudPerStamp: 1,
  /** Ticks after which an unused site reservation expires. */
  siteReserveTicks: 900,
  /** Food credited per voxel of edible material dug, times the material's nutrition. */
  digFoodYield: 0.25,
  /** Radius of the spoil-mound brush and how deep its centre sits below the dropping ant. */
  spoilBrush: 1.5,
  spoilSink: 0.75,
  /** Spoil ring around the entrance: inner radius, and growth per sqrt(pellet). */
  spoilRingMin: 4.5,
  spoilRingGrow: 0.55,
  spoilRingMax: 14,
  /** Head-room (voxels of air above) required before a pellet becomes mound instead of vanishing. */
  spoilHeadroom: 4,
};
