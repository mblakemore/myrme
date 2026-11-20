import { describe, expect, it } from 'vitest';
import { HOME_UNREACHABLE, ISO, MAP_IDS, Mat, getMapExtras, materialDef, type MapGenOptionsA1, type MapGenResult, type MapId, type MapSizePreset, type Vec3 } from '../../core';
import { getMap, MAPS } from '../maps';
import { createNav, type Nav } from '../nav';

const OUTDOOR: MapId[] = ['meadow', 'forest', 'desert'];
const FARMS: MapId[] = ['gelFarm', 'sandFarm', 'formicarium'];

const cache = new Map<string, { result: MapGenResult; ms: number }>();
function gen(id: MapId, seed = 1, size: MapSizePreset = 'small'): { result: MapGenResult; ms: number } {
  const key = `${id}/${seed}/${size}`;
  let e = cache.get(key);
  if (!e) {
    const opts: MapGenOptionsA1 = { faction: 'gardenAnt', size };
    const t0 = performance.now();
    const result = getMap(id).generate(seed, opts);
    e = { result, ms: performance.now() - t0 };
    cache.set(key, e);
  }
  return e;
}

/** FNV-1a over density + material. */
function worldHash(r: MapGenResult): number {
  let h = 0x811c9dc5;
  for (const arr of [r.world.density, r.world.material])
    for (let i = 0; i < arr.length; i++) {
      h ^= arr[i];
      h = Math.imul(h, 0x01000193);
    }
  return h >>> 0;
}

/** Home field from the colony spawn: `dist(cell)` is HOME_UNREACHABLE outside the connected region. */
function homeField(r: MapGenResult): { nav: Nav; start: number; reachable: (p: Vec3, radius?: number) => boolean } {
  const nav = createNav(r.world);
  const sp = r.spawns.find((s) => s.kind === 'colony')!;
  const start = nav.nearestWalkable(sp.pos.x, sp.pos.y, sp.pos.z, 4);
  nav.setHome(1, [start]);
  nav.updateFields(100000);
  return {
    nav,
    start,
    reachable: (p, radius = 3) => {
      const c = nav.nearestWalkable(p.x, p.y, p.z, radius);
      return c >= 0 && nav.homeDistance(1, c) !== HOME_UNREACHABLE;
    },
  };
}

describe('map registry', () => {
  it('lists the six maps in contract order, none of them a stub', () => {
    expect(MAPS.map((m) => m.id)).toEqual([...MAP_IDS]);
    const hashes = new Set(MAP_IDS.map((id) => worldHash(gen(id).result)));
    expect(hashes.size).toBe(6);
  });
});

describe.each(MAP_IDS.map((id) => [id]))('%s', (id) => {
  const outdoor = OUTDOOR.includes(id);

  it('generates the default size within the 5 s budget', () => {
    const { result, ms } = gen(id, 1, 'medium');
    const w = result.world;
    console.log(`[a1] ${id}: ${w.sx}x${w.sy}x${w.sz} in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
    if (outdoor) {
      expect(w.sx).toBeGreaterThanOrEqual(160);
      expect(w.sx).toBeLessThanOrEqual(192);
      expect(w.sy).toBeGreaterThanOrEqual(56);
      expect(w.sy).toBeLessThanOrEqual(64);
    }
  });

  it('is deterministic for a seed and differs between seeds', () => {
    const a = gen(id, 7).result;
    const b = getMap(id).generate(7, { faction: 'gardenAnt', small: true });
    expect(worldHash(b)).toBe(worldHash(a));
    expect(JSON.stringify(b.spawns)).toBe(JSON.stringify(a.spawns));
    expect(JSON.stringify(b.foodSources)).toBe(JSON.stringify(a.foodSources));
    expect(JSON.stringify(b.props)).toBe(JSON.stringify(a.props));
    expect(JSON.stringify(b.shotPoses)).toBe(JSON.stringify(a.shotPoses));
    expect(worldHash(gen(id, 8).result)).not.toBe(worldHash(a));
  });

  it('honours size presets (`small` flag == size small; larger presets are larger)', () => {
    const s = gen(id, 1, 'small').result.world;
    const m = gen(id, 1, 'medium').result.world;
    expect(s.sx).toBeLessThan(m.sx);
    expect(getMapExtras(gen(id, 1, 'small').result)!.size).toBe('small');
    const l = getMap(id).generate(1, { faction: 'gardenAnt', size: 'large' } as MapGenOptionsA1).world;
    expect(l.sx).toBeGreaterThan(m.sx);
  });

  it('stores a clamped distance field, not a binary one (D3)', () => {
    const { world } = gen(id).result;
    let solid = 0;
    let air = 0;
    let nearSolid = 0;
    let nearAir = 0;
    const levels = new Set<number>();
    for (let i = 0; i < world.density.length; i++) {
      const d = world.density[i];
      if (d >= ISO) solid++;
      else air++;
      if (d >= ISO && d < 250) nearSolid++;
      if (d < ISO && d > 5) nearAir++;
      levels.add(d);
    }
    expect(solid).toBeGreaterThan(1000);
    expect(air).toBeGreaterThan(1000);
    expect(nearSolid).toBeGreaterThan(500);
    expect(nearAir).toBeGreaterThan(500);
    expect(levels.size).toBeGreaterThan(120); // a smooth ramp of values around the surface
    // materials: solid cells have a material, air cells have none
    for (let i = 0; i < world.density.length; i += 7) expect(world.material[i] !== Mat.Air).toBe(world.density[i] >= ISO);
  });

  it.each([[1], [2], [3], [4]])('seed %i: spawn is walkable and connected to food' + (outdoor ? ', the entrance and the surface' : ''), (seed) => {
    const r = gen(id, seed).result;
    const w = r.world;
    const sp = r.spawns.find((s) => s.kind === 'colony')!;
    const f = homeField(r);
    expect(f.start).toBeGreaterThanOrEqual(0);
    const c = w.cellCenter(f.start, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(c.x - sp.pos.x, c.y - sp.pos.y, c.z - sp.pos.z)).toBeLessThan(2.5);

    expect(r.foodSources.length).toBeGreaterThanOrEqual(3);
    for (const food of r.foodSources) expect(f.reachable(food.pos, 2), `${food.kind} at ${JSON.stringify(food.pos)}`).toBe(true);
    expect(sp.entrance).not.toBeNull();
    expect(f.reachable(sp.entrance!, 3)).toBe(true);

    let reach = 0;
    let skyReach = 0;
    for (let cell = 0; cell < w.density.length; cell++) {
      if (f.nav.homeDistance(1, cell) === HOME_UNREACHABLE) continue;
      reach++;
      if (!outdoor) continue;
      // open sky above?
      const p = w.cellCoords(cell, { x: 0, y: 0, z: 0 });
      let open = true;
      for (let y = p.y + 1; y < w.sy && open; y++) if (w.isSolid(p.x, y, p.z)) open = false;
      if (open) skyReach++;
    }
    if (outdoor) {
      expect(skyReach).toBeGreaterThan(w.sx * w.sz * 0.6); // most of the map's surface is reachable from the nest
      for (const s of r.spawns) {
        if (s.kind === 'rival') expect(f.reachable(s.entrance!, 4)).toBe(true); // rivals can reach us
        if (s.kind === 'creature') expect(f.reachable(s.pos, 2)).toBe(true);
      }
    } else expect(reach).toBeGreaterThan(300);
  });

  it('populates everything the contract offers', () => {
    const r = gen(id).result;
    const ex = getMapExtras(r)!;
    expect(ex).not.toBeNull();
    expect(r.boundary).toBe(outdoor ? 'open' : 'glass');
    expect(r.world.boundary).toBe(r.boundary);
    expect(r.cameraMode).toBe(outdoor ? 'rts' : 'slab');
    expect(r.flags.slab).toBe(!outdoor);
    expect(r.shotPoses.overview).toBeDefined();
    expect(Object.keys(r.shotPoses).length).toBeGreaterThanOrEqual(4);
    for (const p of Object.values(r.shotPoses)) for (const v of [...p.pos, ...p.target]) expect(Number.isFinite(v)).toBe(true);
    expect(r.goal.target).toBeGreaterThan(0);
    expect(['nuptialFlight', 'eliminateRival', 'population'].includes(r.goal.kind) === outdoor || ['excavate', 'population'].includes(r.goal.kind)).toBe(true);
    expect(r.spawns.filter((s) => s.kind === 'colony').length).toBe(1);
    expect(ex.chambers.some((c) => c.kind === 'queen' && c.owner === 'colony')).toBe(true);
    expect(ex.tunnels.length).toBeGreaterThan(0);
    expect(ex.solidCells).toBeGreaterThan(0);
    expect(new Set(r.foodSources.map((f) => f.kind)).size).toBeGreaterThanOrEqual(outdoor ? 3 : 2);
    for (const f of r.foodSources) expect(f.amount).toBeGreaterThan(0);
    if (outdoor) {
      expect(r.spawns.some((s) => s.kind === 'rival' && s.entrance)).toBe(true);
      expect(r.spawns.filter((s) => s.kind === 'creature' && s.creature).length).toBeGreaterThanOrEqual(3);
      const colony = r.spawns.find((s) => s.kind === 'colony')!;
      const rival = r.spawns.find((s) => s.kind === 'rival')!;
      expect(Math.hypot(colony.pos.x - rival.pos.x, colony.pos.z - rival.pos.z)).toBeGreaterThan(r.world.sx * 0.3);
      expect(r.props.filter((p) => !p.climbable).length).toBeGreaterThan(10); // render-only scatter hints
      // fixtures rely on the first three props being climbable stems
      for (const p of r.props.slice(0, 3)) expect(p.kind === 'stem' && p.climbable).toBe(true);
    } else {
      expect(ex.slabThickness).toBeGreaterThanOrEqual(4);
      expect(ex.slabThickness).toBeLessThanOrEqual(5);
    }
  });
});

describe.each(OUTDOOR.map((id) => [id]))('%s (outdoor)', (id) => {
  it('has voxel climbables (D18) that ants can actually get onto', () => {
    const r = gen(id).result;
    const w = r.world;
    let plant = 0;
    let wood = 0;
    for (let i = 0; i < w.material.length; i++) {
      if (w.material[i] === Mat.Plant || w.material[i] === Mat.Fungus) plant++;
      else if (w.material[i] === Mat.Wood) wood++;
    }
    expect(plant).toBeGreaterThan(500);
    expect(wood).toBeGreaterThan(300);
    const f = homeField(r);
    const stems = r.props.filter((p) => p.kind === 'stem' && p.climbable);
    expect(stems.length).toBeGreaterThanOrEqual(3);
    // the upper part of every stem is reachable from the nest
    for (const s of stems) {
      const p = { x: s.pos.x + (s.end.x - s.pos.x) * 0.8, y: s.pos.y + (s.end.y - s.pos.y) * 0.8, z: s.pos.z + (s.end.z - s.pos.z) * 0.8 };
      expect(f.reachable(p, 4), `stem at ${JSON.stringify(s.pos)}`).toBe(true);
    }
  });

  it('leaves diggable ground around and below the starter nest', () => {
    const r = gen(id).result;
    const w = r.world;
    const sp = r.spawns.find((s) => s.kind === 'colony')!;
    for (let dy = 2; dy <= 9; dy++)
      for (const [dx, dz] of [
        [0, 0],
        [4, 0],
        [-4, 0],
        [0, 4],
        [0, -4],
      ]) {
        const m = w.materialAt(Math.floor(sp.pos.x + dx), Math.floor(sp.pos.y - dy), Math.floor(sp.pos.z + dz));
        if (m !== Mat.Air) expect(Number.isFinite(materialDef(m).digCost)).toBe(true);
      }
  });
});

describe.each(FARMS.map((id) => [id]))('%s (farm)', (id) => {
  it('obeys D6 (glass panes are solid for walking) and D7 (thin diggable slab on the front pane)', () => {
    const r = gen(id).result;
    const w = r.world;
    const ex = getMapExtras(r)!;
    expect(w.boundary).toBe('glass');
    expect(r.flags.slabAxis).toBe('z');
    // D6: just outside every face is solid
    expect(w.isSolid(-1, 10, 1)).toBe(true);
    expect(w.isSolid(10, 10, -1)).toBe(true);
    expect(w.isSolid(10, 10, w.sz)).toBe(true);
    expect(w.isSolid(10, w.sy, 1)).toBe(true);
    if (id !== 'formicarium') {
      expect(w.sz).toBeGreaterThanOrEqual(4);
      expect(w.sz).toBeLessThanOrEqual(5);
      expect(ex.slabThickness).toBe(w.sz);
      expect(ex.strata.length).toBeGreaterThanOrEqual(4);
      // an air gap above the fill
      let airTop = 0;
      for (let x = 0; x < w.sx; x++) if (!w.isSolid(x, w.sy - 4, 1)) airTop++;
      expect(airTop).toBe(w.sx);
      return;
    }
    // Formicarium: behind the front layer the nest block is undiggable and uncarved, so every
    // chamber and every tunnel the ants can ever dig touches the front pane.
    const tray = ex.sites.find((s) => s.kind === 'outworld')!;
    const front = w.sz - ex.slabThickness;
    let carved = 0;
    for (let y = 0; y < w.sy; y++)
      for (let x = 0; x < Math.floor(tray.pos.x) - 1; x++) {
        for (let z = 0; z < front; z++) {
          expect(w.isSolid(x, y, z)).toBe(true);
          expect(materialDef(w.materialAt(x, y, z)).digCost).toBe(Infinity);
        }
        if (!w.isSolid(x, y, w.sz - 1)) carved++;
      }
    expect(carved).toBeGreaterThan(300); // chambers open onto the front pane
    // the tray is open: air above the sand over its whole depth
    const tx = Math.floor((tray.pos.x + tray.end.x) / 2);
    for (let z = 0; z < w.sz; z++) expect(w.isSolid(tx, w.sy - 8, z)).toBe(false);
    expect(ex.sites.some((s) => s.kind === 'waterTower')).toBe(true);
    expect(ex.sites.some((s) => s.kind === 'feedingDish')).toBe(true);
  });

  it('every pre-carved tunnel spans the diggable layer (visible through the pane)', () => {
    const r = gen(id).result;
    const w = r.world;
    const ex = getMapExtras(r)!;
    for (const t of ex.tunnels) {
      const mx = Math.floor((t.a.x + t.b.x) / 2);
      const my = Math.floor((t.a.y + t.b.y) / 2);
      expect(w.isSolid(mx, my, w.sz - 1)).toBe(false);
    }
  });
});

describe('gel farm', () => {
  it('is made of edible gel with nutrient layers and sealed bubbles', () => {
    const r = gen('gelFarm').result;
    const w = r.world;
    const ex = getMapExtras(r)!;
    let gel = 0;
    let nutrient = 0;
    for (let i = 0; i < w.material.length; i++) {
      if (w.material[i] === Mat.Gel) gel++;
      else if (w.material[i] === Mat.Fungus) nutrient++;
    }
    expect(materialDef(Mat.Gel).edibleByAnts).toBe(true);
    expect(gel).toBeGreaterThan(nutrient * 4);
    expect(nutrient).toBeGreaterThan(200);
    const bubbles = ex.sites.filter((s) => s.kind === 'bubble');
    expect(bubbles.length).toBeGreaterThanOrEqual(3);
    const f = homeField(r);
    for (const b of bubbles) {
      expect(w.isSolid(Math.floor(b.pos.x), Math.floor(b.pos.y), 1)).toBe(false);
      expect(f.reachable(b.pos, 1)).toBe(false); // sealed until the ants dig into it
    }
  });
});
