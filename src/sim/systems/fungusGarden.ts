import { HOME_UNREACHABLE, asSimEvent, b3StateOf, v3, v3clone, type Ant, type CellIndex, type Colony, type FoodSource, type FungusGardenState, type Job, type NavEx, type SimState, type SimSystem } from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { addChamber, alertOnce, getExt } from './colonyState';
import { bumpDemand, closeJob, countWorkers, postJob, recaste, temperatureAt } from './keeperEnv';

/**
 * LEAFCUTTER ECONOMY (`farmsFungus`, PLAN §2) — leaves are not food. The chain is
 *
 *   leaf source ──harvestLeaves (media)──▶ stores.leaves ──tendGarden (minims)──▶ garden substrate
 *        ──fungus digests──▶ garden biomass ──tendGarden harvest──▶ stores.food
 *
 * - Leaf sources: every `leaves` FoodSource. On maps with plants the system seeds leaf patches on
 *   climbable stems / leaves / flowers when a fungus-farming colony is present. The colony
 *   "knows" sources within a radius that grows with time, posts a `harvestLeaves` job on the
 *   nearest reachable ones (behaviors/harvestLeaves.ts) until enough leaf matter is waiting.
 * - Gardens: a `fungusGarden` chamber in the pantry (a second one in each later granary once the
 *   first is full). Each second substrate is digested into biomass (logistic towards capacity,
 *   slowed outside the comfortable temperature band).
 * - Mould (Escovopsis): creeps in when nobody has tended the garden for `neglectTime`, when
 *   more substrate is bedded than the fungus can digest (overload), or when it is too hot/cold;
 *   it spreads by itself once established and eats biomass. Gardeners weed it first of all.
 *   Above `mouldSick` the garden is 'sick' (alert `gardenSick`); at zero biomass it COLLAPSES
 *   (famine alert `starving`) and is re-seeded from fresh leaves after `reseedTime`.
 * - `tendGardenAction` is the gardener's unit of work: weed → bed leaves → harvest fungus.
 * - Founders: half of the starting workers are media so cutting starts at once.
 *
 * Anything a fungus farmer delivers as "food" (player gather orders on fruit etc.) is credited as
 * leaf substrate by behaviors/util.ts `deliverFood` — they cannot eat forage directly.
 *
 * State for render/UI: `b3StateOf(sim).gardens[]`; events `garden`, `leafCut`.
 */

interface GardenCtx {
  state: FungusGardenState;
  slot: { job: Job | null };
  collapsedTick: number;
  lastEvent: number;
}

interface ColonyCtx {
  gardens: GardenCtx[];
  leafSlots: Map<number, { job: Job | null }>;
  founded: boolean;
  /** M3: earliest tick of the next demand-driven garden split. */
  nextSplitTick: number;
}

interface Ctx {
  colonies: Map<number, ColonyCtx>;
  seeded: boolean;
}

const ctxs = new WeakMap<SimState, Ctx>();
const _p = v3();

function ctxOf(sim: SimState): Ctx {
  let c = ctxs.get(sim);
  if (!c) ctxs.set(sim, (c = { colonies: new Map(), seeded: false }));
  return c;
}

function colonyCtx(sim: SimState, id: number): ColonyCtx {
  const ctx = ctxOf(sim);
  let cc = ctx.colonies.get(id);
  if (!cc) ctx.colonies.set(id, (cc = { gardens: [], leafSlots: new Map(), founded: false, nextSplitTick: 0 }));
  return cc;
}

/** Garden state by id (behaviors/tendGarden.ts). */
export function gardenOf(sim: SimState, colonyId: number, gardenId: number): FungusGardenState | null {
  const cc = ctxOf(sim).colonies.get(colonyId);
  if (!cc) return null;
  for (const g of cc.gardens) if (g.state.id === gardenId) return g.state;
  return null;
}

function seedLeafPatches(sim: SimState): void {
  const L = BALANCE.b3.leafcutters;
  const nav = sim.nav as NavEx;
  let n = 0;
  for (const e of sim.foodSources) if (e.foodKind === 'leaves') n++;
  const nest = sim.colonies.find((c) => getSpecies(c.species).caps.farmsFungus)?.nestPos;
  if (!nest) return;
  const props = sim.map.props.filter((p) => p.climbable && (p.kind === 'stem' || p.kind === 'leaf' || p.kind === 'flower'));
  props.sort((a, b) => Math.hypot(a.pos.x - nest.x, a.pos.z - nest.z) - Math.hypot(b.pos.x - nest.x, b.pos.z - nest.z) || a.seed - b.seed);
  for (const p of props) {
    if (n >= L.patchMax) break;
    // on the plant, a little way up from its base where ants can reach it
    const t = p.kind === 'stem' ? 0.45 : 0.5;
    const cell = nav.nearestWalkable(p.pos.x + (p.end.x - p.pos.x) * t, p.pos.y + (p.end.y - p.pos.y) * t, p.pos.z + (p.end.z - p.pos.z) * t, 5);
    if (cell < 0) continue;
    sim.world.cellCenter(cell, _p);
    let clash = false;
    for (const e of sim.foodSources) if (Math.hypot(e.pos.x - _p.x, e.pos.y - _p.y, e.pos.z - _p.z) < 6) clash = true;
    if (clash) continue;
    sim.spawnFood('leaves', L.patchAmount, _p, L.patchRegen);
    n++;
  }
}

function foundGarden(sim: SimState, colony: Colony, cc: ColonyCtx, at: { pos: { x: number; y: number; z: number }; radius: number }, biomass: number): void {
  const L = BALANCE.b3.leafcutters;
  const ch = addChamber(sim, colony, 'fungusGarden', v3(at.pos.x, at.pos.y, at.pos.z), Math.max(2, at.radius));
  const state: FungusGardenState = { id: sim.nextId(), colony: colony.id, chamberId: ch.id, pos: v3clone(ch.pos), cell: ch.cell, radius: ch.radius, biomass, capacity: L.gardenCapacity, substrate: 0, health: 1, mould: 0, fill: biomass / L.gardenCapacity, tendedTick: sim.tick, tenders: 0, status: 'founding' };
  cc.gardens.push({ state, slot: { job: null }, collapsedTick: -1, lastEvent: 0 });
  b3StateOf(sim).gardens.push(state);
  sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'founded', garden: state.id, colony: colony.id, pos: v3clone(state.pos), amount: biomass }));
}

function gardenTick(sim: SimState, colony: Colony, gc: GardenCtx): void {
  const L = BALANCE.b3.leafcutters;
  const g = gc.state;
  if (g.status === 'collapsed') {
    if (sim.tick - gc.collapsedTick > L.reseedTime * 30 && colony.stores.leaves >= 3) {
      colony.stores.leaves -= 3;
      g.biomass = 2;
      g.mould = 0;
      g.substrate = 2;
      g.status = 'founding';
      g.tendedTick = sim.tick;
      sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'founded', garden: g.id, colony: colony.id, pos: v3clone(g.pos), amount: g.biomass }));
      alertOnce(sim, colony, 'info', 'Gardeners have re-seeded the fungus garden', g.pos, 0, 0);
    }
    return;
  }
  const temp = temperatureAt(sim, g.pos);
  const off = temp < L.tempMin ? (L.tempMin - temp) / 10 : temp > L.tempMax ? (temp - L.tempMax) / 10 : 0;
  const comfort = Math.max(0.2, 1 - off);
  // digestion
  const room = Math.max(0.05, 1 - g.biomass / g.capacity);
  const d = Math.min(g.substrate, L.digestRate * g.health * comfort);
  g.substrate -= d;
  g.biomass = Math.min(g.capacity, g.biomass + d * L.fungusPerLeaf * Math.min(1, room * 2));
  // mould
  const neglected = sim.tick - g.tendedTick > L.neglectTime * 30;
  let grow = 0;
  if (neglected) grow += L.mouldGrow;
  if (g.substrate > L.substrateOverload) grow += L.mouldOverloadGrow;
  if (off > 0) grow += L.mouldGrow * Math.min(1, off);
  if (g.mould > 0.2) grow += L.mouldSpread;
  g.mould = Math.min(1, g.mould + grow);
  if (g.mould > 0.1) g.biomass = Math.max(0, g.biomass - L.mouldDamage * g.mould);
  g.health = Math.max(0.1, 1 - g.mould);
  g.fill = g.biomass / g.capacity;
  if (g.status !== 'sick' && g.mould >= L.mouldSick) {
    g.status = 'sick';
    sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'mould', garden: g.id, colony: colony.id, pos: v3clone(g.pos), amount: g.mould }));
    alertOnce(sim, colony, 'gardenSick', 'Mould is spreading through the fungus garden', g.pos, 0, 30);
  } else if (g.status === 'sick' && g.mould < L.mouldSick * 0.5) {
    g.status = 'healthy';
    sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'recovered', garden: g.id, colony: colony.id, pos: v3clone(g.pos), amount: g.mould }));
  } else if (g.status === 'founding' && g.biomass > L.gardenStartBiomass * 1.5) g.status = 'healthy';
  if (g.biomass <= 0.05) {
    g.biomass = 0;
    g.fill = 0;
    g.substrate = 0;
    g.status = 'collapsed';
    gc.collapsedTick = sim.tick;
    sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'collapsed', garden: g.id, colony: colony.id, pos: v3clone(g.pos), amount: 0 }));
    alertOnce(sim, colony, 'starving', 'The fungus garden has collapsed — famine threatens', g.pos, 0, 0);
  }
}

/**
 * One unit of gardening by `ant` at garden `gardenId`: weed mould first, else bed waiting leaf
 * matter, else harvest ripe fungus into the food stores. Returns what was done.
 */
export function tendGardenAction(sim: SimState, ant: Ant, gardenId: number): 'weed' | 'bed' | 'harvest' | 'none' {
  const L = BALANCE.b3.leafcutters;
  const colony = sim.getColony(ant.colony);
  const cc = colony ? ctxOf(sim).colonies.get(colony.id) : undefined;
  const gc = cc?.gardens.find((x) => x.state.id === gardenId);
  if (!colony || !gc) return 'none';
  const g = gc.state;
  g.tendedTick = sim.tick;
  if (g.status === 'collapsed') return 'none';
  const quiet = sim.tick - gc.lastEvent > 90;
  if (g.mould > 0.03) {
    g.mould = Math.max(0, g.mould - L.weedPerTend);
    if (quiet) {
      gc.lastEvent = sim.tick;
      sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'weeded', garden: g.id, colony: colony.id, pos: v3clone(g.pos), amount: g.mould }));
    }
    return 'weed';
  }
  if (colony.stores.leaves > 0.01 && g.substrate < L.substrateOverload - L.bedPerTend) {
    const n = Math.min(L.bedPerTend, colony.stores.leaves);
    colony.stores.leaves -= n;
    g.substrate += n;
    if (quiet) {
      gc.lastEvent = sim.tick;
      sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'fed', garden: g.id, colony: colony.id, pos: v3clone(g.pos), amount: n }));
    }
    return 'bed';
  }
  // keep a standing crop unless the colony is short of food
  const hungry = colony.stores.food < Math.max(6, colony.population.total * 0.6);
  const keep = hungry ? L.harvestReserve : Math.max(L.harvestReserve, g.capacity * 0.3);
  if (g.biomass > keep + 0.5) {
    const n = Math.min(L.harvestPerTend, g.biomass - keep);
    g.biomass -= n;
    colony.stores.food += n;
    colony.stats.foodDelivered += n;
    sim.emit({ type: 'foodDelivered', tick: sim.tick, colony: colony.id, by: ant.id, amount: n, pos: v3clone(g.pos) });
    if (quiet) {
      gc.lastEvent = sim.tick;
      sim.emit(asSimEvent({ type: 'garden', tick: sim.tick, op: 'harvest', garden: g.id, colony: colony.id, pos: v3clone(g.pos), amount: n }));
    }
    return 'harvest';
  }
  return 'none';
}

function standAt(sim: SimState, colonyId: number, f: FoodSource): CellIndex {
  const nav = sim.nav as NavEx;
  const c = nav.nearestWalkable(f.pos.x, f.pos.y, f.pos.z, 4);
  if (c < 0 || nav.homeDistance(colonyId, c) === HOME_UNREACHABLE) return -1;
  return c;
}

function postLeafJobs(sim: SimState, colony: Colony, cc: ColonyCtx): void {
  const L = BALANCE.b3.leafcutters;
  const living = cc.gardens.filter((g) => g.state.status !== 'collapsed').length;
  const want = colony.stores.leaves < L.leafStockPerGarden * Math.max(1, living);
  const known = L.knownRadiusBase + (L.knownRadiusGrow * sim.tick) / 1800;
  const cands: { f: FoodSource; d: number; cell: CellIndex }[] = [];
  if (want)
    for (const e of sim.foodSources) {
      if (e.foodKind !== 'leaves' || e.amount < 2) continue;
      const d = Math.hypot(e.pos.x - colony.nestPos.x, e.pos.y - colony.nestPos.y, e.pos.z - colony.nestPos.z);
      if (d > known) continue;
      cands.push({ f: e, d, cell: -1 });
    }
  // M3: nearly stripped patches go last. Sorted by distance alone, the three nearest patches were
  // kept at a few leaves each (one cutter slot apiece) while a dozen full ones stood untouched
  // further out — 80 idle ants and an empty leaf store.
  const thin = (c: { f: FoodSource }): number => (c.f.amount < L.patchWorthwhile ? 1 : 0);
  cands.sort((a, b) => thin(a) - thin(b) || a.d - b.d || a.f.id - b.f.id);
  const live = new Set<number>();
  let posted = 0;
  for (const c of cands) {
    if (posted >= L.patchesWorked) break;
    c.cell = standAt(sim, colony.id, c.f);
    if (c.cell < 0) continue;
    let slot = cc.leafSlots.get(c.f.id);
    if (!slot) cc.leafSlots.set(c.f.id, (slot = { job: null }));
    const slots = Math.max(1, Math.min(6, Math.floor(c.f.amount / 6), Math.ceil(countWorkers(sim, colony) / 4)));
    postJob(sim, colony, slot, 'harvestLeaves', c.cell, c.f.pos, c.f.id, posted === 0 ? 0.75 : 0.55, slots, c.f.id);
    live.add(c.f.id);
    posted++;
  }
  for (const [id, slot] of cc.leafSlots)
    if (!live.has(id)) {
      closeJob(sim, colony, slot);
      cc.leafSlots.delete(id);
    }
  if (posted > 0) bumpDemand(sim, colony, 'harvestLeaves');
}

export const fungusGardenSystem: SimSystem = {
  id: 'fungusGarden',
  init(sim) {
    if (sim.options.fixture === 'wander') return;
    let any = false;
    for (const colony of sim.colonies) {
      if (!getSpecies(colony.species).caps.farmsFungus) continue;
      any = true;
      colonyCtx(sim, colony.id);
      // founders: every other worker is a media, so leaf cutting starts on day one
      const frac = BALANCE.b3.leafcutter.startMediaFraction;
      let i = 0;
      let made = 0;
      for (const a of sim.ants) {
        if (!a.alive || a.colony !== colony.id || a.caste !== 'worker') continue;
        i++;
        if (made < Math.round(i * frac)) {
          recaste(a, 'major');
          made++;
        }
      }
    }
    if (any && !sim.map.flags.slab) seedLeafPatches(sim);
  },
  update(sim) {
    if (sim.tick % 30 !== 11) return;
    const L = BALANCE.b3.leafcutters;
    for (const colony of sim.colonies) {
      if (!colony.alive || !getSpecies(colony.species).caps.farmsFungus) continue;
      if (!getExt(sim, colony.id).active) continue;
      const cc = colonyCtx(sim, colony.id);
      if (cc.gardens.length === 0) {
        const at = colony.chambers.find((c) => c.kind === 'granary' && c.cell >= 0);
        if (!at) continue;
        foundGarden(sim, colony, cc, at, L.gardenStartBiomass);
        cc.founded = true;
      } else if (
        cc.gardens.length < L.gardensMax &&
        (cc.gardens.every((g) => g.state.fill > L.gardenExpandFill) ||
          // M3: …or every comb is saturated with substrate while cut leaves pile up and the colony
          // is short of food. A hungry colony harvests its comb down to the reserve, so `fill`
          // never reached the split threshold: one garden (≈ 18 food/min) capped a leafcutter
          // colony at +2.5 ants/min with half its workers idle.
          (sim.tick >= cc.nextSplitTick &&
            colony.stores.leaves >= L.splitLeafStock &&
            colony.stores.food < colony.population.total * L.splitFoodPerAnt &&
            cc.gardens.every((g) => g.state.status !== 'collapsed' && g.state.status !== 'sick' && g.state.substrate >= L.substrateOverload - L.bedPerTend - 1)))
      ) {
        // a full comb is split into the next free granary
        const used = new Set(cc.gardens.map((g) => g.state.cell));
        const at = colony.chambers.find((c) => c.kind === 'granary' && c.cell >= 0 && !used.has(c.cell) && cc.gardens.every((g) => Math.hypot(g.state.pos.x - c.pos.x, g.state.pos.y - c.pos.y, g.state.pos.z - c.pos.z) > 4));
        if (at) {
          const donor = cc.gardens.reduce((a, g) => (g.state.biomass > a.biomass ? g.state : a), cc.gardens[0].state);
          const seed = Math.min(L.gardenStartBiomass, Math.max(2, donor.biomass * 0.5));
          donor.biomass -= seed;
          cc.nextSplitTick = sim.tick + Math.round(L.splitCooldown * 30);
          foundGarden(sim, colony, cc, at, seed);
          alertOnce(sim, colony, 'info', 'A new fungus garden has been planted', at.pos, 0, 0);
        }
      }
      for (const gc of cc.gardens) {
        const g = gc.state;
        gardenTick(sim, colony, gc);
        g.tenders = gc.slot.job ? gc.slot.job.assigned.length : 0;
        // how badly a gardener is wanted
        let urgency = 0.3;
        let slots = 1;
        if (g.status === 'collapsed') {
          closeJob(sim, colony, gc.slot);
          continue;
        }
        if (g.mould > 0.03) {
          urgency = g.mould > L.mouldSick * 0.6 ? 0.95 : 0.8;
          slots = g.mould > 0.2 ? 3 : 2;
        } else if (colony.stores.leaves > 1 && g.substrate < L.substrateOverload - L.bedPerTend) {
          urgency = 0.7;
          slots = 2;
        } else if (g.biomass > g.capacity * 0.3 + 1 || colony.stores.food < colony.population.total * 0.6) {
          urgency = 0.6;
          slots = 2;
        }
        postJob(sim, colony, gc.slot, 'tendGarden', g.cell, g.pos, 0, urgency, slots, g.id);
      }
      if (cc.gardens.length > 0) bumpDemand(sim, colony, 'tendGarden');
      postLeafJobs(sim, colony, cc);
    }
  },
};
