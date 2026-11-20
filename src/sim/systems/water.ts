import { NO_DROWN_KEY, getMapExtras, v3, v3clone, type Brood, type CellIndex, type Chamber, type Colony, type ColonyEnvState, type Item, type NavEx, type SimState, type SimSystem, type Vec3, type WeatherStateEx } from '../../core';
import type { Water } from '../../world/water';
import { BALANCE } from '../data/balance';
import { alertB2, envState, waterOver, type EnvState } from './weatherEnv';

/**
 * Water & flooding (D17). The field itself (flow, drain, conservation) is `world/water.ts`;
 * this system feeds it and applies the consequences.
 *
 * SOURCES while it rains (rate ∝ `weather.rain`):
 *   - every colony entrance: run-off from the ground around it pours down the hole. The
 *     catchment is measured in 16 directions — a direction whose ground rises towards the entrance
 *     (a spoil mound, a raised rim the player built) sheds its water away, so a crater mound really
 *     does keep the nest drier. Rain falling straight into the hole always gets in.
 *   - `puddle` sites of the map (basins) up to their water level, and natural hollows found by a
 *     coarse scan of the terrain at start.
 *   Keeper droppers etc. call `envOf(sim).addWater(...)`.
 *   Water then runs downhill by itself: down the entrance tunnel into the lowest connected air
 *   first — a sump dug below the galleries fills before the chambers do.
 *
 * CONSEQUENCES:
 *   - ants in flooded cells swim (slow) for `swimSeconds`, then drown; brood drowns faster
 *   - loose items and corpses float up to the water surface
 *   - per colony: `ColonyEnvState.flooded / nestWater / waterTop / threatenedBrood / refugeCell`
 *     (the `floodEscape` behavior evacuates brood and queen to the refuge), `flood` events and
 *     `flooding` alerts when water first runs in and when chambers flood
 *   - drinking: thirsty ants at a puddle rehydrate (temperature system) and sip a little away
 *
 * NAV: `world/nav.ts` has no blocked-cell channel, so flooded cells stay walkable for A*; they
 * are made slow through the speed hook and ants bail out through `floodEscape`.
 */

interface Basin {
  cell: CellIndex;
  /** Voxels per second at rain 1. */
  rate: number;
  /** Stop filling when the water surface reaches this y (Infinity = no cap). */
  level: number;
}

interface WaterCtx {
  /** Cells this system marked as a nav hazard → tick of the last sync that saw them deep. */
  hazards: Map<CellIndex, number>;
  basins: Basin[];
  /** Catchment fraction per colony entrance key (colony * 64 + index), refreshed every few seconds. */
  catch: Map<number, number>;
  /** Where the run-off of an entrance enters: the first cells under cover down the tunnel. */
  mouth: Map<number, CellIndex>;
  /** Ticks under water per brood id. */
  broodWet: Map<number, number>;
  /** Items currently afloat. */
  floating: Set<number>;
  /** Peak nest water per colony since the flood began (for `flood` events). */
  peak: number[];
  dryTicks: number[];
  /** Temporary nursery chamber id per colony (the refuge), 0 = none. */
  refugeChamber: number[];
  entered: boolean[];
}

const ctxs = new WeakMap<SimState, WaterCtx>();

/** Hazard value the water system writes (and the only value it clears again). */
const WATER_HAZARD = 60;
const _wet: CellIndex[] = [];

function syncWaterHazards(sim: SimState, water: Water, ctx: WaterCtx): void {
  const nav = sim.nav as NavEx;
  const deep = BALANCE.b2.floodDepth * 0.8;
  const gen = sim.tick;
  _wet.length = 0;
  water.forEachFlooded((cell, depth) => {
    if (depth > deep) _wet.push(cell);
  });
  for (const cell of _wet) {
    const h = nav.hazardAt(cell);
    if (h !== 0 && h !== WATER_HAZARD) continue; // somebody else's hazard (antlion slope)
    if (h === 0) nav.setHazard(cell, WATER_HAZARD);
    ctx.hazards.set(cell, gen);
  }
  for (const [cell, g] of ctx.hazards) {
    if (g === gen) continue;
    if (nav.hazardAt(cell) === WATER_HAZARD) nav.setHazard(cell, 0);
    ctx.hazards.delete(cell);
  }
}
const _c = v3();
const _q = v3();

function airCellNear(sim: SimState, p: Vec3): CellIndex {
  const w = sim.world;
  const x = Math.floor(p.x);
  const z = Math.floor(p.z);
  if (x < 0 || z < 0 || x >= w.sx || z >= w.sz) return -1;
  // the lowest open cell of the column at or above the site
  const nav = sim.nav as NavEx;
  const h = nav.skyHeight(x, z);
  const y = Math.max(0, Math.min(w.sy - 1, h));
  return w.index(x, y, z);
}

/** Natural hollows: per coarse block, the lowest column if it lies clearly below the block's rim. */
function findDepressions(sim: SimState, out: Basin[]): void {
  const B = BALANCE.b2;
  const w = sim.world;
  const nav = sim.nav as NavEx;
  const S = B.depressionBlock;
  const found: { cell: number; depth: number }[] = [];
  for (let bz = 0; bz + S <= w.sz; bz += S)
    for (let bx = 0; bx + S <= w.sx; bx += S) {
      let lo = Infinity;
      let lx = 0;
      let lz = 0;
      let rim = Infinity;
      for (let dz = 0; dz < S; dz++)
        for (let dx = 0; dx < S; dx++) {
          const h = nav.skyHeight(bx + dx, bz + dz);
          const edge = dx === 0 || dz === 0 || dx === S - 1 || dz === S - 1;
          if (edge) {
            if (h < rim) rim = h;
          } else if (h < lo) {
            lo = h;
            lx = bx + dx;
            lz = bz + dz;
          }
        }
      if (lo <= 0 || rim - lo < B.depressionDepth) continue;
      found.push({ cell: w.index(lx, lo, lz), depth: rim - lo });
    }
  found.sort((a, b) => b.depth - a.depth || a.cell - b.cell);
  for (const f of found.slice(0, B.maxDepressions)) {
    const y = Math.floor(f.cell / (w.sx * w.sz));
    out.push({ cell: f.cell, rate: B.depressionInflow, level: y + f.depth });
  }
}

/** Fraction 0..1 of the surroundings whose run-off reaches the entrance (see header). */
export function entranceCatchment(sim: SimState, entrance: CellIndex): number {
  const B = BALANCE.b2;
  const w = sim.world;
  const nav = sim.nav as NavEx;
  w.cellCenter(entrance, _c);
  if (!nav.isExposed(entrance)) {
    // the listed cell sits under an overhang: use the column's open top
    _c.y = nav.skyHeight(Math.floor(_c.x), Math.floor(_c.z)) + 0.5;
  }
  let open = 0;
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const fx = Math.floor(_c.x + dx * 9);
    const fz = Math.floor(_c.z + dz * 9);
    if (fx < 0 || fz < 0 || fx >= w.sx || fz >= w.sz) continue; // the map edge sheds nothing
    const far = nav.skyHeight(fx, fz);
    let ridge = -Infinity;
    for (let r = 3; r <= 7; r++) {
      const h = nav.skyHeight(Math.floor(_c.x + dx * r), Math.floor(_c.z + dz * r));
      if (h > ridge) ridge = h;
    }
    // water from this side must not have to climb: neither over a ridge nor up to a raised mouth
    if (ridge - far >= B.moundHeight + 0.25) continue;
    open++;
  }
  return Math.max(B.entranceMinCatch, open / N);
}

/** The throat of an entrance: a couple of steps down the way home, just under cover. */
function mouthCell(sim: SimState, colony: Colony, entrance: CellIndex): CellIndex {
  const nav = sim.nav as NavEx;
  let c = entrance;
  let under = 0;
  for (let i = 0; i < 12; i++) {
    const n = nav.homeStep(colony.id, c);
    if (n < 0) break;
    c = n;
    if (!nav.isExposed(c) && ++under >= 2) break;
  }
  return under > 0 ? c : entrance;
}

function chamberWet(sim: SimState, ch: Chamber, cell: CellIndex): boolean {
  sim.world.cellCenter(cell, _q);
  const dx = _q.x - ch.pos.x;
  const dy = _q.y - ch.pos.y;
  const dz = _q.z - ch.pos.z;
  const r = ch.radius + 1.5;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

const NEST_KINDS: Readonly<Record<string, 1>> = { queen: 1, nursery: 1, granary: 1, barracks: 1, fungusGarden: 1 };

/** Pick where to evacuate to: the highest dry chamber clearly above the water, else up the way out. */
function chooseRefuge(sim: SimState, colony: Colony, st: ColonyEnvState, ctx: WaterCtx): void {
  const water = sim.water;
  const B = BALANCE.b2;
  let best: Chamber | null = null;
  for (const ch of colony.chambers) {
    if (!NEST_KINDS[ch.kind] || ch.cell < 0 || ch.id === ctx.refugeChamber[colony.id]) continue;
    if (ch.pos.y < st.waterTop + B.broodMargin + 1 || water.depthAt(ch.cell) > 0.02) continue;
    if (!best || ch.pos.y > best.pos.y) best = ch;
  }
  let cell = best ? best.cell : -1;
  if (cell < 0) {
    // no dry chamber: a spot up the exit route, well above the water (even if that is outside)
    const sky = (sim.nav as NavEx).skyField();
    let c = colony.nestCell;
    const sxz = sim.world.sx * sim.world.sz;
    for (let i = 0; i < 80 && c >= 0; i++) {
      if (Math.floor(c / sxz) >= st.waterTop + B.broodMargin + 2 && water.depthAt(c) <= 0) {
        cell = c;
        break;
      }
      const n = sky.descend(c);
      if (n < 0) {
        if (sky.distance(c) === 0 && water.depthAt(c) <= 0) cell = c;
        break;
      }
      c = n;
    }
  }
  st.refugeCell = cell;
  if (cell < 0) return;
  // register it as an (emergency) nursery so A2b's brood jobs leave rescued brood where it is
  sim.world.cellCenter(cell, _q);
  const id = ctx.refugeChamber[colony.id];
  const existing = id ? colony.chambers.find((c) => c.id === id) : undefined;
  if (existing) {
    existing.cell = cell;
    existing.pos = v3clone(_q);
  } else if (!best || best.kind !== 'nursery') {
    const ch: Chamber = { id: sim.nextId(), kind: 'nursery', cell, pos: v3clone(_q), radius: 2.2, health: 1 };
    // not the LAST nursery: `activeChamber` (newest of a kind) keeps pointing at the real one
    const firstNursery = colony.chambers.findIndex((c) => c.kind === 'nursery');
    colony.chambers.splice(firstNursery >= 0 ? firstNursery : colony.chambers.length, 0, ch);
    ctx.refugeChamber[colony.id] = ch.id;
  }
}

function closeRefuge(colony: Colony, ctx: WaterCtx): void {
  const id = ctx.refugeChamber[colony.id];
  if (!id) return;
  const i = colony.chambers.findIndex((c) => c.id === id);
  if (i >= 0) colony.chambers.splice(i, 1);
  ctx.refugeChamber[colony.id] = 0;
}

function colonyFlood(sim: SimState, env: EnvState, ctx: WaterCtx, colony: Colony): void {
  const B = BALANCE.b2;
  const water = sim.water as Water;
  const st = env.colonyState(colony.id);
  const nav = sim.nav as NavEx;
  const sxz = sim.world.sx * sim.world.sz;
  let wet = 0;
  let top = -1;
  let firstCell = -1;
  let inside = 0;
  if (water.floodedCount > 0) {
    const chambers = colony.chambers;
    const refugeId = ctx.refugeChamber[colony.id];
    water.forEachFlooded((cell, d) => {
      if (d < 0.3 || nav.isExposed(cell)) return;
      let hit = false;
      for (let i = 0; i < chambers.length; i++) {
        const ch = chambers[i];
        if (!NEST_KINDS[ch.kind] || ch.id === refugeId) continue;
        if (chamberWet(sim, ch, cell)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        // water under cover near the nest but outside the chambers: the tunnels are running
        sim.world.cellCenter(cell, _q);
        if (Math.hypot(_q.x - colony.nestPos.x, _q.y - colony.nestPos.y, _q.z - colony.nestPos.z) < 24) inside++;
        return;
      }
      wet++;
      const lvl = Math.floor(cell / sxz) + d;
      if (lvl > top) top = lvl;
      if (firstCell < 0) firstCell = cell;
    });
  }
  st.nestWater = wet;
  st.waterTop = top;
  const player = colony.id === sim.playerColony;

  if (!ctx.entered[colony.id] && !st.flooded && (inside > 2 || wet > 0)) {
    ctx.entered[colony.id] = true;
    if (player) alertB2(sim, 'flood.in', 'flooding', colony.id, 'Water is running into the nest', colony.entrances.length ? sim.world.cellCenter(colony.entrances[0], v3()) : colony.nestPos, 0, 120);
  } else if (ctx.entered[colony.id] && inside === 0 && wet === 0) ctx.entered[colony.id] = false;

  const was = st.flooded;
  if (!was && wet >= B.floodCells) {
    st.flooded = true;
    ctx.peak[colony.id] = wet;
    ctx.dryTicks[colony.id] = 0;
    sim.world.cellCenter(firstCell, _q);
    sim.emit({ type: 'flood', tick: sim.tick, pos: v3clone(_q), cell: firstCell, rising: true });
    if (player) alertB2(sim, 'flood.nest', 'flooding', colony.id, 'The nest is flooding — move the brood up, dig a sump below the galleries or raise the entrance', _q, 0, 90);
  } else if (was) {
    if (wet > (ctx.peak[colony.id] ?? 0) * 1.3 + 2) {
      ctx.peak[colony.id] = wet;
      sim.world.cellCenter(firstCell, _q);
      sim.emit({ type: 'flood', tick: sim.tick, pos: v3clone(_q), cell: firstCell, rising: true });
    }
    if (wet < 2) {
      ctx.dryTicks[colony.id] = (ctx.dryTicks[colony.id] ?? 0) + 30;
      if (ctx.dryTicks[colony.id] === 30) {
        sim.emit({ type: 'flood', tick: sim.tick, pos: v3clone(colony.nestPos), cell: colony.nestCell, rising: false });
        if (player) alertB2(sim, 'flood.over', 'info', colony.id, 'The flood water is draining away', colony.nestPos, 0, 60);
      }
      if (ctx.dryTicks[colony.id] >= B.refugeHold * 30) {
        st.flooded = false;
        st.refugeCell = -1;
        closeRefuge(colony, ctx);
      }
    } else ctx.dryTicks[colony.id] = 0;
  }

  // brood in danger, and where to take it
  st.threatenedBrood.length = 0;
  if (st.flooded && wet >= 2) {
    for (const b of sim.brood) {
      if (!b.alive || b.colony !== colony.id || b.carriedBy) continue;
      const cell = broodCell(sim, b);
      if (water.depthAt(cell) > 0.05 || b.pos.y < top + B.broodMargin) {
        // already safe in the refuge?
        if (st.refugeCell >= 0) {
          sim.world.cellCenter(st.refugeCell, _q);
          if (Math.hypot(b.pos.x - _q.x, b.pos.y - _q.y, b.pos.z - _q.z) < 3) continue;
        }
        st.threatenedBrood.push(b.id);
      }
    }
    if (st.refugeCell < 0 || water.depthAt(st.refugeCell) > 0.02 || Math.floor(st.refugeCell / sxz) < top + B.broodMargin) chooseRefuge(sim, colony, st, ctx);
  }
}

function broodCell(sim: SimState, b: Brood): CellIndex {
  return b.cell >= 0 ? b.cell : sim.world.cellAt(b.pos.x, b.pos.y, b.pos.z);
}

function floatItem(sim: SimState, water: Water, it: Item, ctx: WaterCtx): void {
  const w = sim.world;
  const sxz = w.sx * w.sz;
  const cell = w.cellAt(it.pos.x, it.pos.y, it.pos.z);
  let c = cell >= 0 && water.depthAt(cell) > 0 ? cell : it.cell;
  if (c < 0 || water.depthAt(c) < 0.25) {
    // the water is gone: let D12 put it back on the ground
    if (ctx.floating.delete(it.id)) it.falling = true;
    return;
  }
  while (c + sxz < sxz * w.sy && water.depthAt(c + sxz) > 0.02) c += sxz;
  const level = Math.floor(c / sxz) + water.depthAt(c);
  if (!ctx.floating.has(it.id)) {
    if (!water.isFlooded(c) && level - it.pos.y < 0.35) return;
    ctx.floating.add(it.id);
  }
  // rise gently, bob on the surface
  const target = level - 0.12 + 0.04 * Math.sin(sim.tick * 0.12 + it.id);
  it.pos.y += Math.max(-0.08, Math.min(0.08, target - it.pos.y));
  it.falling = false;
  it.up.x = 0;
  it.up.y = 1;
  it.up.z = 0;
  // (`cell` stays on a walkable cell — the falling system re-seats loose things whose cell is not)
  const here = w.cellAt(it.pos.x, it.pos.y, it.pos.z);
  if (here >= 0 && sim.nav.isWalkable(here)) it.cell = here;
}

export const waterSystem: SimSystem = {
  id: 'water',
  init(sim) {
    const B = BALANCE.b2;
    envState(sim);
    (sim.water as Water).configure({
      floodDepth: B.floodDepth,
      flowBudget: B.flowBudget,
      pressureBudget: B.pressureBudget,
      pressureNodes: B.pressureNodes,
      flowShare: B.flowShare,
      filmMin: B.filmMin,
      filmDry: B.filmDry,
      absorb: B.absorb,
      absorbFloorMul: B.absorbFloorMul,
      drainEveryTicks: B.drainEveryTicks,
    });
    const ctx: WaterCtx = { hazards: new Map(), basins: [], catch: new Map(), mouth: new Map(), broodWet: new Map(), floating: new Set(), peak: [], dryTicks: [], refugeChamber: [], entered: [] };
    ctxs.set(sim, ctx);
    if (!sim.map.flags.weather) return;
    const extras = getMapExtras(sim.map);
    if (extras) {
      for (const s of extras.sites) {
        if (s.kind !== 'puddle') continue;
        const cell = airCellNear(sim, s.pos);
        if (cell >= 0) ctx.basins.push({ cell, rate: B.puddleInflow * s.radius * s.radius, level: s.level > 0 ? s.level : Infinity });
      }
    }
    findDepressions(sim, ctx.basins);
  },
  update(sim, dt) {
    const ctx = ctxs.get(sim);
    if (!ctx) return;
    const B = BALANCE.b2;
    const env = envState(sim);
    const water = sim.water as Water;
    const w = sim.weather as WeatherStateEx;
    const rain = w.rain;

    // ---- rain inflow (3 Hz) ----
    if (rain > 0.02 && sim.tick % 10 === 0) {
      const k = rain * dt * 10;
      for (const colony of sim.colonies) {
        if (!colony.alive) continue;
        for (let i = 0; i < colony.entrances.length; i++) {
          const e = colony.entrances[i];
          if (e < 0) continue;
          const key = colony.id * 64 + i;
          let f = ctx.catch.get(key);
          if (f === undefined || sim.tick % 150 === 0) {
            f = entranceCatchment(sim, e);
            ctx.catch.set(key, f);
            ctx.mouth.set(key, mouthCell(sim, colony, e));
          }
          water.inject(ctx.mouth.get(key) ?? e, B.entranceInflow * f * k);
        }
      }
      for (const b of ctx.basins) {
        if (b.level !== Infinity) {
          const s = water.surfaceAbove(b.cell);
          if (s >= b.level) continue;
        }
        water.inject(b.cell, b.rate * k);
      }
    }

    // ---- the field ----
    const surfaceT = env.air + env.sunHeat * env.sun;
    water.setEvaporation(rain > 0.05 ? 0 : B.evapBase + Math.max(0, surfaceT - 25) * B.evapPerDegree);
    water.step(dt, 1 - B.drainWetDamp * w.wetness * (rain > 0.05 ? 1 : B.drainWetAfter));

    const any = water.floodedCount > 0;

    // ---- deep water is a path cost (final round) ----
    // Flooded cells stay walkable (ants can swim) but A* now goes round them when a detour
    // exists: foragers used to path straight through puddles and flooded galleries and drown.
    if (sim.tick % 30 === 21 && (any || ctx.hazards.size > 0)) syncWaterHazards(sim, water, ctx);

    // ---- swimming & drowning ----
    if (any) {
      const swimTicks = B.swimSeconds * 30;
      const ants = sim.ants;
      for (let i = 0; i < ants.length; i++) {
        const a = ants[i];
        if (!a.alive) continue;
        if (a.cell >= 0 && waterOver(sim, a) > B.floodDepth && !a.mem[NO_DROWN_KEY] && a.anim !== 'raft') {
          const st = a.infection.stage;
          if (st === 'gripped' || st === 'fruiting' || st === 'burst') continue;
          a.submerged++;
          if (a.submerged > swimTicks) {
            const dmg = B.drownDamage * dt;
            a.health -= dmg;
            if (sim.tick % 15 === 0) sim.emit({ type: 'damage', tick: sim.tick, target: a.id, amount: dmg * 15, pos: v3clone(a.pos) });
            if (a.health <= 0) sim.killAnt(a, 'drowning');
          }
        } else if (a.submerged > 0) a.submerged = Math.max(0, a.submerged - B.swimRecover);
      }
    } else if (sim.tick % 30 === 0) {
      for (const a of sim.ants) if (a.submerged > 0) a.submerged = Math.max(0, a.submerged - B.swimRecover * 30);
    }

    // ---- floating items (every tick so they ride the surface smoothly) ----
    if (any || ctx.floating.size > 0) {
      if (sim.tick % 10 === 5) {
        for (const it of sim.items) {
          if (!it.alive || it.carriedBy || ctx.floating.has(it.id)) continue;
          const c = it.cell >= 0 ? it.cell : sim.world.cellAt(it.pos.x, it.pos.y, it.pos.z);
          if (c >= 0 && water.isFlooded(c)) floatItem(sim, water, it, ctx);
        }
      }
      for (const id of ctx.floating) {
        const it = sim.getEntity(id);
        if (!it || it.kind !== 'item' || it.carriedBy) ctx.floating.delete(id);
        else floatItem(sim, water, it, ctx);
      }
    }

    // ---- brood drowning (3 Hz) ----
    if (sim.tick % 10 === 6 && (any || ctx.broodWet.size > 0)) {
      const limit = B.broodDrownSeconds * 30;
      for (const b of sim.brood) {
        if (!b.alive) continue;
        const cell = b.carriedBy ? -1 : broodCell(sim, b);
        if (cell >= 0 && water.depthAt(cell) > B.floodDepth) {
          const t = (ctx.broodWet.get(b.id) ?? 0) + 10;
          if (t > limit) {
            ctx.broodWet.delete(b.id);
            sim.emit({ type: 'broodStage', tick: sim.tick, id: b.id, colony: b.colony, stage: 'dead', pos: v3clone(b.pos) });
            sim.remove(b);
          } else ctx.broodWet.set(b.id, t);
        } else if (ctx.broodWet.has(b.id)) ctx.broodWet.delete(b.id);
      }
      if (!any) ctx.broodWet.clear();
    }

    // ---- colony flood state (1 Hz) ----
    if (sim.tick % 30 === 13) {
      for (const colony of sim.colonies) {
        if (!colony.alive) continue;
        const st = env.colonyState(colony.id);
        if (any || st.flooded || ctx.entered[colony.id]) colonyFlood(sim, env, ctx, colony);
      }
    }
  },
};

/** Fraction of the surroundings draining into each entrance of a colony (debug / tests / HUD). */
export function catchmentOf(sim: SimState, colony: Colony): number[] {
  return colony.entrances.map((e) => (e >= 0 ? entranceCatchment(sim, e) : 0));
}
