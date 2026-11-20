import {
  ISO,
  MATERIALS,
  Mat,
  Phero,
  asSimEvent,
  b3StateOf,
  getMapExtras,
  hash01,
  v3,
  v3clone,
  v3rotateAbout,
  type Colony,
  type FoodKind,
  type KeeperAction,
  type KeeperActionEx,
  type KeeperCommandOptions,
  type KeeperFoodKind,
  type KeeperState,
  type MapSite,
  type MapSiteKind,
  type MaterialId,
  type Mover,
  type NavEx,
  type Rng,
  type SimState,
  type SimSystem,
  type Vec3,
} from '../../core';
import { BALANCE } from '../data/balance';
import { getSpecies } from '../data/species';
import { getExt } from './colonyState';
import { keeperHooks } from './keeperHooks';
import { setSpeedScale } from './movement';

/**
 * The keeper (PLAN §2): the unseen human who owns the ant farm. On farm maps
 * (`flags.keeperEvents`) a seeded schedule plays keeper events; on every map the same events can
 * be invoked by `keeper` commands (sandbox: the player is the keeper — see `keeperCommand` in
 * core/contracts/b3.ts for the extended actions and the food kind).
 *
 *   dropFood          something edible falls through the lid onto the drop zone / feeding dish:
 *                     seeds, a sugar-water drop, a fruit chunk or a dead cricket (a corpse item
 *                     that has to be butchered). Leafcutters get leaves, wood-eaters a chunk of
 *                     wood (real Wood voxels). The amount follows the colony's size and what is
 *                     already lying about, so a farm colony is kept alive but not flooded in food.
 *   dropWater         the dropper: water added at the surface (D17 `water.addWater`) — a local flood
 *   lamp              desk lamp on/off: `weather.lamp` (heat source; sun for sun-sensitive species)
 *   tapGlass / shake  alarm pheromone burst, ants stumble (slowed, headings jolted, climbers on
 *                     panes and ceilings lose their grip); a shake is a much harder tap
 *   openTube          the tube port opens (`keeper.tubeOpen/tubePos` — B1's director may route an
 *                     invasion through it); the neighbour's foraging jar shows up as a food source
 *   topUp             fresh gel / sand poured onto the top of the fill
 *   contaminatedFood  a food drop that carries fungus spores
 *
 * Every event emits the frozen `keeper` event (nearest base action) and a detailed `keeperEvent`.
 * The schedule uses its own forked RNG stream, so keeper events never disturb other randomness.
 */

interface KeeperCtx {
  rng: Rng;
  nextDrop: number;
  nextWater: number;
  nextLamp: number;
  lampOff: number;
  nextTap: number;
  tubeAt: number;
  nextTopUp: number;
  drops: number;
}

const ctxs = new WeakMap<SimState, KeeperCtx>();
const _p = v3();
const _near: Mover[] = [];

const BASE_ACTION: Record<KeeperActionEx, KeeperAction> = {
  dropFood: 'dropFood',
  dropWater: 'dropWater',
  lamp: 'lamp',
  tapGlass: 'tapGlass',
  openTube: 'openTube',
  shake: 'tapGlass',
  topUp: 'dropFood',
  contaminatedFood: 'dropFood',
};

function ctxOf(sim: SimState): KeeperCtx {
  let c = ctxs.get(sim);
  if (!c) {
    const K = BALANCE.b3.keeper;
    const rng = sim.rng.fork('keeper');
    const t = (s: number): number => Math.round(s * 30);
    c = {
      rng,
      nextDrop: t(K.firstDrop),
      nextWater: t(rng.range(K.waterEvery[0], K.waterEvery[1])),
      nextLamp: t(rng.range(K.lampEvery[0], K.lampEvery[1]) * 0.6),
      lampOff: 0,
      nextTap: t(rng.range(K.tapEvery[0], K.tapEvery[1])),
      tubeAt: t(K.tubeAt),
      nextTopUp: t(rng.range(K.topUpEvery[0], K.topUpEvery[1])),
      drops: 0,
    };
    ctxs.set(sim, c);
  }
  return c;
}

function siteOf(sim: SimState, ...kinds: MapSiteKind[]): MapSite | null {
  const sites = getMapExtras(sim.map)?.sites ?? [];
  for (const k of kinds) for (const s of sites) if (s.kind === k) return s;
  return null;
}

/** Top-of-fill position under a point: the lowest cell of the column with open sky above. */
function surfaceAt(sim: SimState, x: number, z: number, out: Vec3): Vec3 {
  const w = sim.world;
  const cx = Math.max(1, Math.min(w.sx - 2, Math.floor(x)));
  const cz = Math.max(0, Math.min(w.sz - 1, Math.floor(z)));
  out.x = cx + 0.5;
  out.z = cz + 0.5;
  out.y = Math.min(w.sy - 1, (sim.nav as NavEx).skyHeight(cx, cz)) + 0.5;
  return out;
}

/** Where things dropped through the lid land: the dish / drop zone, else above the player's entrance. */
function dropPoint(sim: SimState, rng: Rng, out: Vec3): Vec3 {
  const s = siteOf(sim, 'feedingDish', 'dropZone');
  const w = sim.world;
  if (s) {
    const r = s.radius * (s.kind === 'feedingDish' ? 0.6 : 0.85);
    let x = s.pos.x;
    let z = s.pos.z;
    if (sim.map.flags.slab && s.kind !== 'feedingDish') {
      if (sim.map.flags.slabAxis === 'z') x += rng.range(-r, r);
      else z += rng.range(-r, r);
    } else {
      x += rng.range(-r, r);
      z += rng.range(-r, r);
    }
    return surfaceAt(sim, Math.max(2, Math.min(w.sx - 2, x)), Math.max(0.5, Math.min(w.sz - 0.5, z)), out);
  }
  const colony = sim.getColony(sim.playerColony);
  const e = colony && colony.entrances[0] !== undefined && colony.entrances[0] >= 0 ? w.cellCenter(colony.entrances[0], _p) : (colony?.nestPos ?? v3(w.sx / 2, 0, w.sz / 2));
  const a = rng.range(0, 6.2832);
  const d = rng.range(5, 10);
  return surfaceAt(sim, Math.max(3, Math.min(w.sx - 3, e.x + Math.cos(a) * d)), Math.max(1, Math.min(w.sz - 1, e.z + (sim.map.flags.slab ? 0 : Math.sin(a) * d))), out);
}

function emitKeeper(sim: SimState, st: KeeperState, action: KeeperActionEx, by: 'keeper' | 'player', pos: Vec3 | null, on: boolean, amount: number, food: KeeperFoodKind | ''): void {
  st.counts[action]++;
  st.last = { action, tick: sim.tick, pos: pos ? v3clone(pos) : null, food };
  sim.emit({ type: 'keeper', tick: sim.tick, action: BASE_ACTION[action], pos: pos ? v3clone(pos) : null, on });
  sim.emit(asSimEvent({ type: 'keeperEvent', tick: sim.tick, action, by, pos: pos ? v3clone(pos) : null, on, amount, food }));
}

/** Food within the colony's reach right now: stores plus loose sources that are not the ground itself. */
function foodAround(sim: SimState, colony: Colony): number {
  let f = colony.stores.food + colony.stores.wood * BALANCE.b3.termites.foodPerWood + colony.stores.leaves;
  for (const s of sim.foodSources) if (s.alive && s.foodKind !== 'gel' && s.foodKind !== 'honeydew') f += s.amount;
  for (const it of sim.items) if (it.alive && it.itemKind !== 'corpse' && it.itemKind !== 'debris') f += it.amount;
  return f;
}

function fillChunk(sim: SimState, pos: Vec3, radius: number, material: MaterialId): number {
  const w = sim.world;
  const near = sim.spatial.queryMovers(pos.x, pos.y, pos.z, radius + 1.5, _near);
  const res = w.fill(pos, radius, material, {
    isOccupied: (cell) => {
      for (let k = 0; k < near.length; k++) if (w.cellAt(near[k].pos.x, near[k].pos.y, near[k].pos.z) === cell) return true;
      return false;
    },
  });
  if (res.addedCells > 0) sim.emit({ type: 'build', tick: sim.tick, by: 0, pos: v3clone(pos), radius, material });
  return res.addedCells;
}

const FOOD_OF: Record<Exclude<KeeperFoodKind, 'cricket'>, FoodKind> = { seeds: 'seeds', sugar: 'sugar', fruit: 'fruit', leaves: 'leaves', wood: 'seeds' };

function pickFood(sim: SimState, ctx: KeeperCtx): KeeperFoodKind {
  const colony = sim.getColony(sim.playerColony);
  const caps = colony ? getSpecies(colony.species).caps : null;
  if (caps?.farmsFungus) return 'leaves';
  if (caps?.eatsWood) return 'wood';
  // a varied diet: seeds, sugar water and fruit, with a cricket (protein) every fourth drop
  const k = ctx.drops % 4;
  return k === 3 ? 'cricket' : k === 0 ? 'seeds' : k === 1 ? 'sugar' : 'fruit';
}

function dropFood(sim: SimState, st: KeeperState, ctx: KeeperCtx, by: 'keeper' | 'player', opts: KeeperCommandOptions, contaminated: boolean): void {
  const K = BALANCE.b3.keeper;
  const colony = sim.getColony(sim.playerColony);
  const pos = opts.pos ? surfaceAt(sim, opts.pos.x, opts.pos.z, v3()) : dropPoint(sim, ctx.rng, v3());
  const food = opts.food ?? pickFood(sim, ctx);
  ctx.drops++;
  let amount = opts.amount ?? 0;
  if (!(amount > 0)) {
    const pop = colony ? colony.population.total : 10;
    amount = K.dropBase + K.dropPerAnt * pop;
    if (colony && by === 'keeper') {
      // a watchful keeper: generous when the farm is bare, stingy when food is piling up
      const have = foodAround(sim, colony) / Math.max(1, K.dropSkipFoodPerAnt * pop);
      amount *= Math.max(0.25, Math.min(1.5, 1.5 - have));
    }
  }
  amount = Math.round(amount);
  if (food === 'wood') {
    _p.x = pos.x;
    _p.y = pos.y + 0.4;
    _p.z = pos.z;
    fillChunk(sim, _p, K.woodBrush, Mat.Wood);
  } else if (food === 'cricket') {
    const it = sim.spawnItem('corpse', amount, pos, 0);
    it.infected = contaminated;
  } else sim.spawnFood(FOOD_OF[food], amount, pos);
  if (contaminated) {
    // spores puff off the food as it lands (B2 `exposeToSpores`), and a spore-laden crumb stays
    // behind (contract `Item.infected`: B2's fungus tracks it — whoever handles it is exposed,
    // and left lying it fruits) until the colony carries it to the midden
    keeperHooks.exposeToSpores?.(sim, pos, 4, 0.6);
    if (food !== 'cricket') {
      const it = sim.spawnItem('corpse', 1, pos, 0);
      it.infected = true;
    }
  }
  emitKeeper(sim, st, contaminated ? 'contaminatedFood' : 'dropFood', by, pos, true, amount, food);
}

function dropWater(sim: SimState, st: KeeperState, ctx: KeeperCtx, by: 'keeper' | 'player', opts: KeeperCommandOptions): void {
  const pos = opts.pos ? surfaceAt(sim, opts.pos.x, opts.pos.z, v3()) : dropPoint(sim, ctx.rng, v3());
  const amount = opts.amount ?? BALANCE.b3.keeper.waterAmount;
  const w = sim.world;
  if (!keeperHooks.addWater?.(sim, pos, amount)) {
    // D17 API: pour into the surface cell and its open neighbours
    let left = amount;
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);
    for (let r = 0; r <= 3 && left > 0; r++)
      for (let dz = -r; dz <= r && left > 0; dz++)
        for (let dx = -r; dx <= r && left > 0; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = cx + dx;
          const z = cz + dz;
          if (!w.inBounds(x, cy, z)) continue;
          const cell = w.index(x, cy, z);
          if (w.density[cell] >= ISO) continue;
          const add = Math.min(1, left);
          sim.water.addWater(cell, add);
          left -= add;
        }
  }
  emitKeeper(sim, st, 'dropWater', by, pos, true, amount, '');
}

function setLamp(sim: SimState, st: KeeperState, by: 'keeper' | 'player', opts: KeeperCommandOptions): void {
  const on = opts.on ?? !st.lampOn;
  const w = sim.world;
  let pos: Vec3 | null = null;
  if (on) {
    if (opts.pos) pos = v3clone(opts.pos);
    else {
      // over one end of the farm, just above the fill, so there is a gradient to walk along
      const top = getMapExtras(sim.map)?.surfaceY ?? w.sy * 0.6;
      pos = v3(w.sx * 0.8, Math.min(w.sy + 4, top + 8), w.sz * 0.5);
    }
  }
  st.lampOn = on;
  st.lampPos = pos;
  sim.weather.lamp = pos ? v3clone(pos) : null;
  keeperHooks.setHeatSource?.(sim, 'keeper.lamp', pos, 12);
  emitKeeper(sim, st, 'lamp', by, pos ?? st.last?.pos ?? null, on, on ? 1 : 0, '');
}

function tap(sim: SimState, st: KeeperState, hard: boolean, by: 'keeper' | 'player', opts: KeeperCommandOptions): void {
  const K = BALANCE.b3.keeper;
  const mul = hard ? K.shakeMul : 1;
  const colony = sim.getColony(sim.playerColony);
  const pos = opts.pos ? v3clone(opts.pos) : v3clone(colony?.nestPos ?? v3(sim.world.sx / 2, sim.world.sy / 2, sim.world.sz / 2));
  const radius = hard ? Infinity : K.tapRadius * (opts.amount && opts.amount > 0 ? opts.amount : 1);
  st.panic = Math.max(st.panic, Math.round(K.panicTime * mul * 30));
  setSpeedScale(sim, 'keeper.panic', K.panicSpeed);
  for (const a of sim.ants) {
    if (!a.alive || a.cell < 0) continue;
    const d = Math.hypot(a.pos.x - pos.x, a.pos.y - pos.y, a.pos.z - pos.z);
    if (d > radius) continue;
    const k = hard ? 1 : 1 - 0.6 * (d / radius);
    if (hash01(a.id, sim.tick, 31) < 0.5 * mul) sim.pheromones.deposit(a.colony, Phero.alarm, a.cell, K.alarmDeposit * k);
    // stumble: heading jolted; climbers on panes / ceilings may lose their grip (D12 fall, no damage)
    v3rotateAbout(a.forward, a.forward, a.up, (hash01(a.id, sim.tick, 32) - 0.5) * 3 * k);
    if (!a.possessed) a.thinkAt = sim.tick;
    if (a.locomotion === 'surface' && !a.falling && a.up.y < 0.25 && hash01(a.id, sim.tick, 33) < (hard ? 0.9 : 0.3) * k) {
      a.falling = true;
      a.path.status = 'none';
      sim.emit({ type: 'fell', tick: sim.tick, id: a.id, pos: v3clone(a.pos) });
    }
  }
  if (colony) sim.emit({ type: 'pheromoneBurst', tick: sim.tick, colony: colony.id, channel: Phero.alarm, pos: v3clone(pos) });
  emitKeeper(sim, st, hard ? 'shake' : 'tapGlass', by, pos, true, mul, '');
}

function openTube(sim: SimState, st: KeeperState, by: 'keeper' | 'player', opts: KeeperCommandOptions): void {
  const on = opts.on ?? true;
  const s = siteOf(sim, 'tubePort');
  const pos = opts.pos ? v3clone(opts.pos) : s ? v3clone(s.pos) : null;
  const was = st.tubeOpen;
  st.tubeOpen = on;
  st.tubePos = pos;
  if (on && !was && pos) {
    // the neighbour's foraging jar: something worth walking to at the far end of the tube
    const cell = sim.nav.nearestWalkable(pos.x, pos.y, pos.z, 8);
    if (cell >= 0) sim.spawnFood('fruit', BALANCE.b3.keeper.tubeReward, sim.world.cellCenter(cell, _p));
  }
  emitKeeper(sim, st, 'openTube', by, pos, on, on ? 1 : 0, '');
}

function topUp(sim: SimState, st: KeeperState, ctx: KeeperCtx, by: 'keeper' | 'player', opts: KeeperCommandOptions): void {
  const K = BALANCE.b3.keeper;
  const w = sim.world;
  const first = opts.pos ? surfaceAt(sim, opts.pos.x, opts.pos.z, v3()) : dropPoint(sim, ctx.rng, v3());
  const along = sim.map.flags.slab && sim.map.flags.slabAxis === 'x' ? 'z' : 'x';
  let added = 0;
  for (let i = 0; i < K.topUpStamps; i++) {
    const off = (i - (K.topUpStamps - 1) / 2) * K.topUpBrush * 1.3;
    const p = surfaceAt(sim, first.x + (along === 'x' ? off : 0), first.z + (along === 'z' ? off : 0), v3());
    // never bury a nest entrance
    let nearEntrance = false;
    for (const c of sim.colonies)
      for (const e of c.entrances) {
        if (e < 0) continue;
        w.cellCenter(e, _p);
        if (Math.hypot(_p.x - p.x, _p.z - p.z) < K.topUpBrush + 3.5) nearEntrance = true;
      }
    if (nearEntrance) continue;
    // same stuff as the fill below (gel on the gel farm, sand on the sand farm)
    let material: MaterialId = Mat.Sand;
    for (let y = Math.floor(p.y) - 1; y >= Math.max(0, Math.floor(p.y) - 6); y--) {
      const c = w.index(Math.floor(p.x), y, Math.floor(p.z));
      if (w.density[c] >= ISO && Number.isFinite(MATERIALS[w.material[c]].digCost)) {
        material = w.material[c] as MaterialId;
        break;
      }
    }
    p.y += 0.3;
    if (p.y + K.topUpBrush > w.sy - 2) continue; // the farm is full to the lid
    added += fillChunk(sim, p, K.topUpBrush, material);
  }
  emitKeeper(sim, st, 'topUp', by, first, true, added, '');
}

function invoke(sim: SimState, action: KeeperActionEx, by: 'keeper' | 'player', opts: KeeperCommandOptions): void {
  const st = b3StateOf(sim).keeper;
  const ctx = ctxOf(sim);
  switch (action) {
    case 'dropFood':
      return dropFood(sim, st, ctx, by, opts, false);
    case 'contaminatedFood':
      return dropFood(sim, st, ctx, by, opts, true);
    case 'dropWater':
      return dropWater(sim, st, ctx, by, opts);
    case 'lamp':
      return setLamp(sim, st, by, opts);
    case 'tapGlass':
      return tap(sim, st, false, by, opts);
    case 'shake':
      return tap(sim, st, true, by, opts);
    case 'openTube':
      return openTube(sim, st, by, opts);
    case 'topUp':
      return topUp(sim, st, ctx, by, opts);
  }
}

/** Run a keeper event right now (tests, other systems). */
export function keeperInvoke(sim: SimState, action: KeeperActionEx, opts: KeeperCommandOptions = {}, by: 'keeper' | 'player' = 'player'): void {
  invoke(sim, action, by, opts);
}

function schedule(sim: SimState, st: KeeperState, ctx: KeeperCtx): void {
  const K = BALANCE.b3.keeper;
  const t = sim.tick;
  const rng = ctx.rng;
  const next = (range: readonly [number, number]): number => t + Math.round(rng.range(range[0], range[1]) * 30);
  if (t >= ctx.nextDrop) {
    ctx.nextDrop = next(K.dropEvery);
    const bad = sim.time > K.contaminatedAfter && rng.chance(K.contaminatedChance);
    // M3: a colony whose STORES already hold `dropSkipFoodPerAnt` per head gets nothing this round
    // (the amount was only ever scaled down to a quarter, which still out-fed a capped colony and
    // piled up hundreds of food). Small colonies always get their drops — the first ones are the
    // farm's opening event.
    const colony = sim.getColony(sim.playerColony);
    const full = !!colony && colony.stores.food >= K.dropSkipFoodPerAnt * Math.max(20, colony.population.total);
    if (!full) invoke(sim, bad ? 'contaminatedFood' : 'dropFood', 'keeper', {});
  }
  if (t >= ctx.nextWater) {
    ctx.nextWater = next(K.waterEvery);
    invoke(sim, 'dropWater', 'keeper', {});
  }
  if (ctx.lampOff > 0 && t >= ctx.lampOff) {
    ctx.lampOff = 0;
    if (st.lampOn) invoke(sim, 'lamp', 'keeper', { on: false });
  }
  if (t >= ctx.nextLamp) {
    ctx.nextLamp = next(K.lampEvery);
    if (!st.lampOn) {
      invoke(sim, 'lamp', 'keeper', { on: true });
      ctx.lampOff = t + Math.round(K.lampDuration * 30);
    }
  }
  if (t >= ctx.nextTap) {
    ctx.nextTap = next(K.tapEvery);
    invoke(sim, 'tapGlass', 'keeper', {});
  }
  if (ctx.tubeAt > 0 && t >= ctx.tubeAt) {
    ctx.tubeAt = 0;
    if (!st.tubeOpen && siteOf(sim, 'tubePort')) invoke(sim, 'openTube', 'keeper', { on: true });
  }
  if (t >= ctx.nextTopUp) {
    ctx.nextTopUp = next(K.topUpEvery);
    // only worth it once the colony has made a dent in the fill
    if (b3StateOf(sim).goals.excavatedPercent > 4) invoke(sim, 'topUp', 'keeper', {});
  }
  // what the HUD may announce next
  let nt = ctx.nextDrop;
  let na: KeeperActionEx = 'dropFood';
  const cand: [number, KeeperActionEx][] = [
    [ctx.nextWater, 'dropWater'],
    [ctx.nextTap, 'tapGlass'],
    [ctx.nextLamp, 'lamp'],
  ];
  for (const [ct, ca] of cand)
    if (ct < nt) {
      nt = ct;
      na = ca;
    }
  st.nextTick = nt;
  st.nextAction = na;
}

export const keeperSystem: SimSystem = {
  id: 'keeper',
  commands: ['keeper'],
  init(sim) {
    const st = b3StateOf(sim).keeper;
    st.enabled = sim.map.flags.keeperEvents && sim.options.fixture !== 'wander';
    const s = siteOf(sim, 'tubePort');
    st.tubePos = s ? v3clone(s.pos) : null;
    if (st.enabled) {
      const ctx = ctxOf(sim);
      st.nextTick = ctx.nextDrop;
    }
  },
  onCommand(sim, cmd) {
    if (cmd.type !== 'keeper') return;
    const ex = cmd as unknown as { action: KeeperActionEx } & KeeperCommandOptions;
    invoke(sim, ex.action, 'player', { pos: ex.pos, on: ex.on, amount: ex.amount, food: ex.food });
  },
  update(sim) {
    const st = b3StateOf(sim).keeper;
    if (st.panic > 0 && --st.panic === 0) setSpeedScale(sim, 'keeper.panic', 1);
    if (!st.enabled || sim.tick % 30 !== 0) return;
    if (!getExt(sim, sim.playerColony).active) return;
    schedule(sim, st, ctxOf(sim));
  },
};
