import { describe, expect, it } from 'vitest';
import { HOME_UNREACHABLE, Mat } from '../core';
import { createWorld } from './VoxelWorld';
import { getMap } from './maps';
import { createNav } from './nav';

function ground(h = 10) {
  const w = createWorld(48, 32, 48, 'open');
  for (let y = 0; y < 32; y++) for (let z = 0; z < 48; z++) for (let x = 0; x < 48; x++) w.setCell(x, y, z, h - (y + 0.5), Mat.Soil);
  w.markAllDirty();
  return w;
}

describe('nav', () => {
  it('walkable cells form one layer above a flat floor; open sides are not walkable', () => {
    const w = ground();
    const nav = createNav(w);
    expect(nav.isWalkable(w.index(10, 10, 10))).toBe(true);
    expect(nav.isWalkable(w.index(10, 9, 10))).toBe(false); // solid
    expect(nav.isWalkable(w.index(10, 12, 10))).toBe(false); // open air
    expect(nav.isWalkable(w.index(0, 20, 10))).toBe(false); // invisible side wall
    expect(nav.isWalkable(-1)).toBe(false);
  });

  it('nearestWalkable finds the floor from above and from inside solid', () => {
    const w = ground();
    const nav = createNav(w);
    const a = nav.nearestWalkable(20.5, 14.5, 20.5, 8);
    expect(w.cellCoords(a, { x: 0, y: 0, z: 0 })).toEqual({ x: 20, y: 10, z: 20 });
    const b = nav.nearestWalkable(20.5, 7.5, 20.5, 8);
    expect(w.cellCoords(b, { x: 0, y: 0, z: 0 }).y).toBe(10);
    expect(nav.nearestWalkable(20.5, 28.5, 20.5, 3)).toBe(-1);
  });

  it('A* finds a path across the floor and around a wall', () => {
    const w = ground();
    // a wall across the middle with a gap at one end
    for (let i = 0; i < 9; i++) w.fill({ x: 24, y: 12, z: 4 + i * 4 }, 3, Mat.Rock);
    const nav = createNav(w);
    const from = nav.nearestWalkable(8.5, 10.5, 20.5, 4);
    const to = nav.nearestWalkable(40.5, 10.5, 20.5, 4);
    const r = nav.findPath(from, to);
    expect(r.status).toBe('found');
    expect(r.cells[r.cells.length - 1]).toBe(to);
    // contiguous (26-neighbourhood) and walkable throughout
    let prev = from;
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    for (const c of r.cells) {
      expect(nav.isWalkable(c)).toBe(true);
      w.cellCoords(prev, a);
      w.cellCoords(c, b);
      expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z))).toBe(1);
      prev = c;
    }
    // straight-line distance is 32; climbing over or walking around is longer
    expect(r.cells.length).toBeGreaterThan(32);
  });

  it('returns failed for unreachable goals and partial under an expansion cap', () => {
    const w = ground();
    w.dig({ x: 24, y: 4, z: 24 }, 2.5); // sealed pocket underground
    const nav = createNav(w);
    const from = nav.nearestWalkable(8.5, 10.5, 8.5, 4);
    const pocket = nav.nearestWalkable(24.5, 4.5, 24.5, 4);
    expect(pocket).toBeGreaterThanOrEqual(0);
    expect(nav.findPath(from, pocket, 0, 200000).status).not.toBe('found');
    const far = nav.nearestWalkable(40.5, 10.5, 40.5, 4);
    const capped = nav.findPath(from, far, 0, 20);
    expect(capped.status).toBe('partial');
    expect(capped.cells.length).toBeGreaterThan(0);
  });

  it('budgeted queue: FIFO, resumable, never exceeds the per-call node budget', () => {
    const w = ground();
    for (let i = 0; i < 9; i++) w.fill({ x: 24, y: 12, z: 4 + i * 4 }, 3, Mat.Rock);
    const nav = createNav(w);
    const a = nav.nearestWalkable(8.5, 10.5, 8.5, 4);
    const b = nav.nearestWalkable(40.5, 10.5, 30.5, 4);
    const t1 = nav.requestPath(a, b);
    const t2 = nav.requestPath(b, a);
    expect(nav.pendingCount).toBe(2);
    expect(nav.takePath(t1)).toBeNull();
    nav.process(1); // one expansion is not enough: the search is paused, not finished
    expect(nav.takePath(t1)).toBeNull();
    expect(nav.stats().expansions).toBe(1);
    let calls = 0;
    let r1 = null;
    let r2 = null;
    while (calls < 10000 && !(r1 && r2)) {
      const before = nav.stats().expansions;
      nav.process(40);
      // the budget is in node expansions and is respected on every call
      expect(nav.stats().expansions - before).toBeLessThanOrEqual(40);
      calls++;
      r1 ??= nav.takePath(t1);
      const got2 = nav.takePath(t2);
      if (got2) {
        expect(r1).not.toBeNull(); // FIFO: t2 never completes before t1
        r2 = got2;
      }
    }
    expect(calls).toBeGreaterThan(2);
    expect(r1!.status).toBe('found');
    expect(r2!.status).toBe('found');
    expect(nav.pendingCount).toBe(0);
    expect(nav.takePath(t2)).toBeNull(); // consumed
  });

  it('queue is deterministic: results do not depend on how the budget is sliced', () => {
    const run = (budget: number) => {
      const w = ground();
      for (let i = 0; i < 9; i++) w.fill({ x: 24, y: 12, z: 4 + i * 4 }, 3, Mat.Rock);
      w.dig({ x: 12, y: 8, z: 12 }, 2.5);
      const nav = createNav(w);
      const cells: number[] = [];
      for (let c = 0; c < w.sx * w.sy * w.sz; c += 7) if (nav.isWalkable(c)) cells.push(c);
      const tickets: number[] = [];
      for (let i = 0; i < 40; i++) tickets.push(nav.requestPath(cells[(i * 131) % cells.length], cells[(i * 977 + 13) % cells.length]));
      nav.cancelPath(tickets[5]);
      const out: string[] = [];
      const order: number[] = [];
      for (let k = 0; k < 100000 && nav.pendingCount > 0; k++) {
        nav.process(budget);
        if (k === 3) nav.findPath(cells[1], cells[cells.length - 2]); // a sync search in between must not disturb the queue
        for (const t of tickets) {
          const r = nav.takePath(t);
          if (r) {
            order.push(t);
            out[t] = r.status + ':' + Array.from(r.cells).join(',');
          }
        }
      }
      expect(out[tickets[5]]).toBeUndefined(); // cancelled
      return { out, order };
    };
    const coarse = run(100000);
    const fine = run(23);
    expect(fine.out).toEqual(coarse.out);
    expect(fine.order).toEqual(coarse.order);
    expect(run(23).out).toEqual(fine.out);
  });

  it('string-pulling keeps a walkable subsequence and shortens straight runs', () => {
    const w = ground();
    const nav = createNav(w);
    const from = nav.nearestWalkable(6.5, 10.5, 6.5, 4);
    const to = nav.nearestWalkable(40.5, 10.5, 21.5, 4);
    const raw = nav.findPath(from, to);
    expect(raw.status).toBe('found');
    const pulled = nav.smoothPath(from, raw.cells);
    expect(pulled.length).toBeLessThan(raw.cells.length / 3);
    expect(pulled[pulled.length - 1]).toBe(to);
    // subsequence of the raw path, each leg a straight crawl
    let k = 0;
    let prev = from;
    for (const c of pulled) {
      while (k < raw.cells.length && raw.cells[k] !== c) k++;
      expect(k).toBeLessThan(raw.cells.length);
      expect(nav.lineWalkable(prev, c)).toBe(true);
      prev = c;
    }
    // no pulling across a wall: floor cell → cell on top of a rock blob
    w.fill({ x: 24, y: 11, z: 24 }, 4, Mat.Rock);
    const onTop = nav.nearestWalkable(24.5, 15.5, 24.5, 3);
    const beside = nav.nearestWalkable(16.5, 10.5, 24.5, 3);
    expect(nav.lineWalkable(beside, onTop)).toBe(false);
    // queue results are pulled by default, raw on request
    const t1 = nav.requestPath(from, to);
    const t2 = nav.requestPath(from, to, 0, false);
    nav.process(1e6);
    expect(nav.takePath(t1)!.cells.length).toBeLessThan(raw.cells.length);
    expect(Array.from(nav.takePath(t2)!.cells)).toEqual(Array.from(nav.findPath(from, to).cells));
  });

  it('pathBroken: only edits that cut the remaining path invalidate it', () => {
    const w = ground();
    const nav = createNav(w);
    const from = nav.nearestWalkable(6.5, 10.5, 24.5, 4);
    const to = nav.nearestWalkable(42.5, 10.5, 24.5, 4);
    const path = nav.smoothPath(from, nav.findPath(from, to).cells);
    const seq = nav.editSeq;
    expect(nav.pathBroken(path, 0, from, seq)).toBe(false);
    w.dig({ x: 10, y: 9, z: 6 }, 2); // far from the path
    expect(nav.editSeq).toBe(seq + 1);
    expect(nav.pathBroken(path, 0, from, seq)).toBe(false);
    w.fill({ x: 24, y: 11, z: 24 }, 3.5, Mat.Rock); // a boulder on the path
    expect(nav.pathBroken(path, 0, from, seq)).toBe(true);
    // …but not for a mover that is already past it
    const raw = nav.findPath(nav.nearestWalkable(34.5, 10.5, 24.5, 3), to).cells;
    expect(nav.pathBroken(raw, 0, nav.nearestWalkable(34.5, 10.5, 24.5, 3), seq)).toBe(false);
    // and a fresh path goes around / over it
    const again = nav.findPath(from, to);
    expect(again.status).toBe('found');
    expect(nav.pathBroken(again.cells, 0, from, nav.editSeq)).toBe(false);
  });

  it('nearestWalkable honours its radius cap and returns the closest cell', () => {
    const w = ground();
    const nav = createNav(w);
    expect(nav.nearestWalkable(20.5, 16.5, 20.5, 5)).toBe(-1); // floor is 6 below
    const c = nav.nearestWalkable(20.5, 16.5, 20.5, 7);
    expect(w.cellCoords(c, { x: 0, y: 0, z: 0 })).toEqual({ x: 20, y: 10, z: 20 });
    expect(nav.nearestWalkable(NaN, 1, 1)).toBe(-1);
    // a huge radius is capped (and still answers)
    expect(nav.nearestWalkable(20.5, 12.5, 20.5, 1e9)).toBe(w.index(20, 10, 20));
  });

  it('reachable: decided by distance fields when possible, bounded A* otherwise', () => {
    const w = ground();
    w.dig({ x: 24, y: 4, z: 24 }, 2.5); // sealed pocket
    const nav = createNav(w);
    const a = nav.nearestWalkable(8.5, 10.5, 8.5, 4);
    const b = nav.nearestWalkable(40.5, 10.5, 40.5, 4);
    const pocket = nav.nearestWalkable(24.5, 4.5, 24.5, 4);
    expect(nav.reachable(a, b)).toBe(true);
    expect(nav.reachable(a, pocket)).toBe(false);
    expect(nav.reachable(a, -1)).toBe(false);
    // with a home field the answers come without any search
    nav.setHome(1, [a]);
    nav.updateFields(0);
    const before = nav.stats().searches;
    expect(nav.reachable(a, b)).toBe(true);
    expect(nav.reachable(b, pocket)).toBe(false);
    expect(nav.stats().searches).toBe(before);
    // and unreachable path requests are rejected for one expansion
    const exp = nav.stats().expansions;
    expect(nav.findPath(b, pocket).status).toBe('failed');
    expect(nav.stats().expansions - exp).toBeLessThan(5);
  });

  it('home field: distances grow away from the nest, homeStep descends, edits trigger a throttled rebuild', () => {
    const map = getMap('meadow').generate(5, { faction: 'gardenAnt', small: true });
    const w = map.world;
    const nav = createNav(w);
    const spawn = map.spawns[0];
    const nest = nav.nearestWalkable(spawn.pos.x, spawn.pos.y, spawn.pos.z, 8);
    nav.setHome(1, [nest]);
    nav.updateFields(0);
    expect(nav.homeDistance(1, nest)).toBe(0);
    const ent = nav.nearestWalkable(spawn.entrance!.x, spawn.entrance!.y, spawn.entrance!.z, 6);
    const d = nav.homeDistance(1, ent);
    expect(d).toBeGreaterThan(8);
    expect(d).toBeLessThan(HOME_UNREACHABLE);
    // walking homeStep from the entrance reaches the nest in exactly d steps
    let c = ent;
    let steps = 0;
    while (c !== nest && steps < 1000) {
      const n = nav.homeStep(1, c);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(nav.homeDistance(1, n)).toBeLessThan(nav.homeDistance(1, c));
      c = n;
      steps++;
    }
    expect(steps).toBe(d);
    // A* agrees that the surface is connected to the nest
    expect(nav.findPath(ent, nest).status).toBe('found');
    // block the tunnel: field updates only after notifyEdit + throttle
    w.fill({ x: (spawn.pos.x + spawn.entrance!.x) / 2 + 2, y: spawn.pos.y + 5, z: spawn.pos.z + 1 }, 4, Mat.Rock);
    nav.notifyEdit([]);
    nav.updateFields(1); // throttled (last rebuild at tick 0)
    expect(nav.homeDistance(1, ent)).toBe(d);
    nav.updateFields(1000);
    expect(nav.homeDistance(1, ent)).not.toBe(d);
  });

  it('gel farm: cells against the panes are walkable and the chamber connects to the surface', () => {
    const map = getMap('gelFarm').generate(5, { faction: 'gardenAnt' });
    const w = map.world;
    const nav = createNav(w);
    expect(nav.isWalkable(w.index(10, 55, 0))).toBe(true); // air above the gel, on the pane
    expect(nav.isWalkable(w.index(10, 55, 1))).toBe(false); // mid-air between panes
    const s = map.spawns[0];
    const nest = nav.nearestWalkable(s.pos.x, s.pos.y, s.pos.z, 8);
    const top = nav.nearestWalkable(s.entrance!.x, s.entrance!.y + 2, s.entrance!.z, 8);
    expect(nav.findPath(nest, top).status).toBe('found');
  });

  it('no corner step through a diagonal pinch (one air face neighbour, no air staircase)', () => {
    // solid rock with two straight tunnels whose ends only touch corner to corner; the one air
    // cell beside the first tunnel's end is a dead end (its own way on to the second tunnel is
    // pinched between two solid cells). Paths used to squeeze through and movers circled there.
    const w = createWorld(32, 24, 24, 'open');
    for (let y = 0; y < 24; y++) for (let z = 0; z < 24; z++) for (let x = 0; x < 32; x++) w.setCell(x, y, z, 0.4, Mat.Rock);
    // 1-voxel tunnels over a denser floor (so the density gradient is well formed)
    const tunnel = (x: number, y: number, z: number) => {
      w.setCell(x, y, z, -0.3, Mat.Air);
      w.setCell(x, y - 1, z, 1.5, Mat.Rock);
    };
    for (let x = 2; x <= 10; x++) tunnel(x, 10, 10);
    tunnel(11, 10, 10); // the dead-end air face neighbour
    for (let x = 11; x <= 20; x++) tunnel(x, 11, 11);
    w.markAllDirty();
    const nav = createNav(w);
    const from = w.index(3, 10, 10);
    const to = w.index(19, 11, 11);
    expect(nav.isWalkable(from) && nav.isWalkable(to)).toBe(true);
    expect(nav.findPath(from, to, 0, 200000).status).not.toBe('found');
    // open the staircase (one more air cell) and the corner step is fine
    w.setCell(11, 11, 10, -0.3, Mat.Air);
    w.markAllDirty();
    const nav2 = createNav(w);
    expect(nav2.findPath(from, to, 0, 200000).status).toBe('found');
  });

  it('large clearance cannot enter a 3-voxel tunnel (D11)', () => {
    const w = ground(20);
    for (let i = 0; i < 12; i++) w.dig({ x: 10 + i * 2, y: 10, z: 24 }, 1.6);
    const nav = createNav(w);
    const inTunnel = nav.nearestWalkable(20.5, 9.5, 24.5, 3);
    expect(inTunnel).toBeGreaterThanOrEqual(0);
    expect(nav.isWalkable(inTunnel, 0.5)).toBe(true);
    expect(nav.isWalkable(inTunnel, 2)).toBe(false);
    const onTop = nav.nearestWalkable(20.5, 20.5, 24.5, 3);
    expect(nav.isWalkable(onTop, 2)).toBe(true);
  });
});

/** Brute-force reference BFS with the same step rule as nav (26-neighbourhood, no squeezing through solid corners). */
function bruteField(w: ReturnType<typeof ground>, nav: ReturnType<typeof createNav>, sources: number[]): Uint16Array {
  const n = w.sx * w.sy * w.sz;
  const dist = new Uint16Array(n).fill(HOME_UNREACHABLE);
  let frontier = sources.filter((s) => nav.isWalkable(s));
  for (const s of frontier) dist[s] = 0;
  const c = { x: 0, y: 0, z: 0 };
  for (let d = 1; frontier.length; d++) {
    const next: number[] = [];
    for (const cur of frontier) {
      w.cellCoords(cur, c);
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy && !dz) continue;
            const x = c.x + dx;
            const y = c.y + dy;
            const z = c.z + dz;
            if (!w.inBounds(x, y, z)) continue;
            const nc = w.index(x, y, z);
            if (dist[nc] !== HOME_UNREACHABLE || !nav.isWalkable(nc)) continue;
            const axes = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
            if (axes === 2) {
              const ok = (dx !== 0 && !w.isSolid(c.x + dx, c.y, c.z)) || (dy !== 0 && !w.isSolid(c.x, c.y + dy, c.z)) || (dz !== 0 && !w.isSolid(c.x, c.y, c.z + dz));
              if (!ok) continue;
            } else if (axes === 3) {
              // corner: an air staircase of axis steps
              const air = (x: number, y: number, z: number) => !w.isSolid(c.x + x, c.y + y, c.z + z);
              const ok = (air(dx, 0, 0) && (air(dx, dy, 0) || air(dx, 0, dz))) || (air(0, dy, 0) && (air(dx, dy, 0) || air(0, dy, dz))) || (air(0, 0, dz) && (air(dx, 0, dz) || air(0, dy, dz)));
              if (!ok) continue;
            }
            dist[nc] = d;
            next.push(nc);
          }
    }
    frontier = next;
  }
  return dist;
}

/** Ground block with a nest chamber and a winding tunnel up to the surface. */
function nestWorld() {
  const w = ground(22);
  const dig = (x: number, y: number, z: number, r = 1.7) => w.dig({ x, y, z }, r);
  dig(12, 8, 12, 3.5); // chamber
  for (let i = 0; i <= 20; i++) dig(12 + i, 8, 12); // gallery east
  for (let i = 0; i <= 16; i++) dig(32, 8 + i, 12 + i * 0.5); // ramp up to the surface
  return w;
}

describe('distance fields', () => {
  it('home field equals a brute-force BFS (multi-source), and descend walks it down', () => {
    const w = nestWorld();
    const nav = createNav(w);
    const nest = nav.nearestWalkable(12.5, 6.5, 12.5, 4);
    const second = nav.nearestWalkable(40.5, 22.5, 40.5, 4); // a second source out on the surface
    nav.setHome(1, [nest, second]);
    nav.updateFields(0);
    const ref = bruteField(w, nav, [nest, second]);
    let reachable = 0;
    for (let c = 0; c < ref.length; c++) {
      if (nav.homeDistance(1, c) !== ref[c]) throw new Error(`cell ${c}: field ${nav.homeDistance(1, c)} vs brute force ${ref[c]}`);
      if (ref[c] !== HOME_UNREACHABLE) reachable++;
    }
    expect(reachable).toBeGreaterThan(2000);
    // descend from far away reaches a source in exactly `distance` steps
    const far = nav.nearestWalkable(4.5, 22.5, 44.5, 4);
    const field = nav.homeField(1)!;
    let c = far;
    let steps = 0;
    while (field.distance(c) > 0 && steps < 500) {
      const nx = field.descend(c);
      expect(nx).toBeGreaterThanOrEqual(0);
      expect(field.distance(nx)).toBeLessThan(field.distance(c));
      c = nx;
      steps++;
    }
    expect(steps).toBe(ref[far]);
    expect(field.descend(c)).toBe(-1); // at a source
    expect(nav.homeStep(1, far)).toBe(field.descend(far));
  });

  it('rebuilds incrementally after digging a new tunnel; readers keep a complete field meanwhile', () => {
    const w = nestWorld();
    const nav = createNav(w);
    const nest = nav.nearestWalkable(12.5, 6.5, 12.5, 4);
    nav.setHome(1, [nest]);
    nav.updateFields(0);
    const field = nav.homeField(1)!;
    expect(field.ready).toBe(true);
    expect(field.stale).toBe(false);
    const above = w.index(16, 22, 12); // surface next to where the shaft will open
    expect(nav.isWalkable(above)).toBe(true);
    const before = field.distance(above);
    expect(before).toBeGreaterThan(40); // the long way round through the gallery and ramp
    // dig a vertical shaft straight up from the chamber
    for (let y = 9; y <= 23; y++) w.dig({ x: 12, y, z: 12 }, 1.7);
    expect(field.stale).toBe(true);
    const v0 = field.version;
    nav.updateFields(1, 500); // throttled: nothing happens yet
    expect(field.version).toBe(v0);
    expect(field.distance(above)).toBe(before);
    let calls = 0;
    for (let tick = 100; field.stale || field.version === v0; tick++) {
      nav.updateFields(tick, 500);
      calls++;
      if (field.version === v0) expect(field.distance(above)).toBe(before); // old field stays intact until the swap
      if (calls > 5000) throw new Error('field rebuild did not finish');
    }
    expect(calls).toBeGreaterThan(3); // really was spread over several calls
    const ref = bruteField(w, nav, [nest]);
    for (let c = 0; c < ref.length; c++) if (nav.homeDistance(1, c) !== ref[c]) throw new Error(`cell ${c}: field ${nav.homeDistance(1, c)} vs brute force ${ref[c]}`);
    expect(field.distance(above)).toBeLessThan(before - 15);
  });

  it('generic fields and the sky field: nearest-exit distances and sky exposure', () => {
    const w = nestWorld();
    const nav = createNav(w);
    const nest = nav.nearestWalkable(12.5, 6.5, 12.5, 4);
    const surface = nav.nearestWalkable(20.5, 22.5, 30.5, 3);
    expect(nav.isExposed(surface)).toBe(true);
    expect(nav.isExposed(nest)).toBe(false);
    expect(nav.skyHeight(20, 30)).toBe(22);
    const sky = nav.skyField();
    expect(sky.ready).toBe(false);
    nav.updateFields(0);
    expect(sky.ready).toBe(true);
    expect(sky.distance(surface)).toBe(0);
    const out = sky.distance(nest);
    expect(out).toBeGreaterThan(20);
    expect(out).toBeLessThan(HOME_UNREACHABLE);
    // walking the field up leads from the nest to open sky
    let c = nest;
    for (let i = 0; i < 500 && sky.distance(c) > 0; i++) c = sky.descend(c);
    expect(nav.isExposed(c)).toBe(true);
    // a custom field: "distance to the gallery end"
    const depot = nav.nearestWalkable(30.5, 7.5, 12.5, 3);
    const f = nav.field('depot');
    f.setSources([depot]);
    nav.updateFields(1);
    expect(f.distance(depot)).toBe(0);
    expect(f.distance(nest)).toBeGreaterThan(10);
    expect(nav.field('depot')).toBe(f);
    // exposure follows edits: roof over a spot, then open it again
    w.fill({ x: 20, y: 27, z: 30 }, 2.5, Mat.Rock);
    expect(nav.isExposed(surface)).toBe(false);
    w.dig({ x: 20, y: 27, z: 30 }, 4, { canDig: () => true });
    expect(nav.isExposed(nav.nearestWalkable(20.5, 22.5, 30.5, 3))).toBe(true);
    nav.removeField('depot');
    expect(nav.stats().fields).toBe(1);
  });
});
