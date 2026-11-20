import { describe, expect, it } from 'vitest';
import { ISO, Mat, v3, type Ant, type Designation, type MaterialId, type SimEvent, type VoxelWorld } from '../../core';
import {
  applyBuildWork,
  applyDigWork,
  claimWorkSite,
  designationProgress,
  digDirect,
  digStats,
  dropSpoil,
  findWorkSite,
  getWorkSite,
  hasSpoil,
  releaseWorkSite,
  runDigDuty,
  stopDigDuty,
} from './dig';
import { a2aSim, carveTunnel, flatWorld, goto, spawnWorker } from './movementTestUtil';
import { navOf } from './paths';

/** Dig / build execution on a synthetic nest: a chamber under flat ground with a ramp to the surface. */

const GROUND = 20;

function nestWorld(material: MaterialId = Mat.Soil): VoxelWorld {
  const w = flatWorld(56, 34, 40, GROUND, material);
  w.dig({ x: 14, y: 10, z: 20 }, 4); // chamber
  carveTunnel(w, [v3(14, 9, 20), v3(14, 9, 12), v3(24, 21, 8)], 1.7); // gallery + ramp to the surface
  return w;
}

function solidCells(w: VoxelWorld, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (w.density[w.index(x, y, z)] >= ISO) n++;
  return n;
}

let nextDesignation = 1;
function designate(sim: ReturnType<typeof a2aSim>, kind: 'dig' | 'build', x: number, y: number, z: number, radius: number, material: MaterialId = Mat.Air): Designation {
  const d: Designation = { id: nextDesignation++, kind, colony: sim.playerColony, center: v3(x, y, z), radius, material, done: false };
  sim.getColony(sim.playerColony)!.designations.push(d);
  return d;
}

describe('dig execution', () => {
  it('N ants dig a designated tunnel to completion, haul the pellets out and build a mound', () => {
    const w = nestWorld();
    const sim = a2aSim(w, v3(14, 7, 20), (s, dt) => {
      for (const a of s.ants) runDigDuty(s, a, dt);
    }, v3(24, 20.5, 8));
    const colony = sim.getColony(sim.playerColony)!;
    expect(colony.entrances.length).toBeGreaterThan(0);
    // a tunnel east from the chamber: five overlapping stamps
    const ds: Designation[] = [];
    for (let i = 0; i < 5; i++) ds.push(designate(sim, 'dig', 20 + i * 3, 9, 20, 2.2));
    // …ending in a chamber big enough to need a lattice of stamps
    ds.push(designate(sim, 'dig', 37, 10, 20, 4));
    expect(designationProgress(sim, ds[0].id)!.total).toBe(1);
    expect(designationProgress(sim, ds[5].id)!.total).toBeGreaterThan(8);
    const solidBefore = solidCells(w, 18, 7, 18, 33, 11, 22);
    const aboveBefore = solidCells(w, 0, GROUND, 0, w.sx - 1, w.sy - 1, w.sz - 1);
    expect(aboveBefore).toBe(0);
    const N = 8;
    for (let i = 0; i < N; i++) spawnWorker(sim, v3(13 + (i % 4), 7, 19 + Math.floor(i / 4)));
    const events: SimEvent[] = [];
    let ticks = 0;
    let carriedSeen = 0;
    let maxInside = -Infinity;
    for (; ticks < 30000; ticks++) {
      sim.step();
      if (ticks % 30 === 0) {
        events.push(...sim.drainEvents());
        for (const a of sim.ants) {
          if (hasSpoil(a)) carriedSeen++;
          if (!a.falling) maxInside = Math.max(maxInside, w.sample(a.pos.x, a.pos.y, a.pos.z));
        }
        if (ds.every((d) => d.done) && sim.ants.every((a) => !hasSpoil(a))) break;
      }
    }
    events.push(...sim.drainEvents());
    const st = digStats(sim);
    console.log('[dig]', JSON.stringify({ ticks, ...st, digEvents: events.filter((e) => e.type === 'dig').length }));
    expect(ds.every((d) => d.done)).toBe(true);
    expect(colony.designations.length).toBe(0);
    expect(events.filter((e) => e.type === 'designationChanged').length).toBeGreaterThanOrEqual(6);
    expect(events.some((e) => e.type === 'dig')).toBe(true);
    // the tunnel exists: the designated spheres are (almost entirely) air and walkable end to end
    for (const d of ds) expect(w.sample(d.center.x, d.center.y, d.center.z)).toBeLessThan(-0.5);
    expect(solidBefore - solidCells(w, 18, 7, 18, 33, 11, 22)).toBeGreaterThan(150);
    const nav = navOf(sim);
    // the chamber is open right out to its painted radius
    for (const [dx, dy, dz] of [[3, 0, 0], [0, 3, 0], [0, -3, 0], [0, 0, 3], [0, 0, -3], [1.8, 1.8, 1.8], [1.8, -1.8, -1.8]]) expect(w.sample(37 + dx, 10 + dy, 20 + dz)).toBeLessThan(0);
    expect(w.sample(37 + 5.5, 10, 20)).toBeGreaterThan(0); // and not beyond it
    const end = nav.nearestWalkable(39.5, 7, 20.5, 3);
    expect(end).toBeGreaterThanOrEqual(0);
    expect(nav.findPath(colony.nestCell, end).status).toBe('found');
    nav.updateFields(sim.tick + 1000);
    expect(nav.homeDistance(colony.id, end)).toBeLessThan(60); // home field picked the new tunnel up
    // pellets were carried out and piled up on the surface
    expect(carriedSeen).toBeGreaterThan(0);
    expect(st.dugVoxels).toBeGreaterThan(350);
    expect(st.pelletsDropped).toBeGreaterThan(10);
    expect(st.moundVoxels).toBeGreaterThan(15);
    expect(solidCells(w, 0, GROUND, 0, w.sx - 1, w.sy - 1, w.sz - 1)).toBeGreaterThan(15);
    // the mound did not plug the entrance: the nest still reaches the surface
    const outside = nav.nearestWalkable(44.5, 21, 30.5, 4);
    expect(nav.findPath(colony.nestCell, outside).status).toBe('found');
    // nobody ended up inside solid, everyone is alive and on a surface
    expect(maxInside).toBeLessThan(0.3);
    expect(sim.ants.length).toBe(N);
    expect(st.pendingSites).toBe(0);
    expect(st.reservedSites).toBe(0);
  }, 60000);

  it('work sites: reservation, reach, material cost, carrying and completion', () => {
    const w = nestWorld();
    const sim = a2aSim(w, v3(14, 7, 20));
    const d = designate(sim, 'dig', 21, 9, 20, 3.2);
    const a = spawnWorker(sim, v3(16.5, 7, 20));
    const b = spawnWorker(sim, v3(16.5, 7, 21));
    sim.step();
    const prog0 = designationProgress(sim, d.id)!;
    expect(prog0.left).toBe(prog0.total);
    expect(prog0.total).toBeGreaterThan(1);
    const peek = findWorkSite(sim, a)!;
    expect(peek.reservedBy).toBe(0);
    const sa = claimWorkSite(sim, a)!;
    expect(sa.reservedBy).toBe(a.id);
    expect(sa.kind).toBe('dig');
    expect(sa.designationId).toBe(d.id);
    expect(navOf(sim).isWalkable(sa.cell)).toBe(true);
    const sb = claimWorkSite(sim, b)!;
    expect(sb.id).not.toBe(sa.id); // b cannot take a's site
    expect(getWorkSite(sim, sa.id)!.reservedBy).toBe(a.id);
    releaseWorkSite(sim, b);
    expect(getWorkSite(sim, sb.id)!.reservedBy).toBe(0);
    // too far away → outOfReach; walk to the standing cell and it works
    const far = spawnWorker(sim, v3(14, 7, 23));
    expect(applyDigWork(sim, far, sa, 1 / 30)).not.toBe('working'); // not the holder / too far
    let res = applyDigWork(sim, a, sa, 1 / 30);
    let guard = 0;
    while (res === 'outOfReach' && guard++ < 600) {
      goto(a, getWorkSite(sim, sa.id)!.cell);
      sim.step();
      res = applyDigWork(sim, a, getWorkSite(sim, sa.id)!, 1 / 30);
    }
    expect(res).toBe('working');
    let workTicks = 1;
    while (res === 'working' && workTicks < 3000) {
      res = applyDigWork(sim, a, getWorkSite(sim, sa.id)!, 1 / 30);
      workTicks++;
    }
    expect(res).toBe('done');
    expect(workTicks).toBeGreaterThan(10); // digging takes time
    expect(hasSpoil(a)).toBe(true);
    expect(a.carrying!.material).toBe(Mat.Soil);
    expect(a.carrying!.amount).toBeGreaterThan(0);
    expect(designationProgress(sim, d.id)!.left).toBe(prog0.left - 1);
    expect(getWorkSite(sim, sa.id)).toBeNull(); // finished sites are gone
    // mandibles full: no more digging until the pellet is dropped
    const next = claimWorkSite(sim, a);
    if (next) expect(applyDigWork(sim, a, next, 1 / 30)).toBe('carrying');
    // underground the pellet just vanishes (no fill in the tunnel)
    const v = w.version;
    expect(dropSpoil(sim, a)).toBe(false);
    expect(hasSpoil(a)).toBe(false);
    expect(w.version).toBe(v);
    stopDigDuty(sim, a);
  });

  it('harder material takes longer; undiggable material is never offered', () => {
    const time = (material: MaterialId): number => {
      const w = nestWorld(material);
      const sim = a2aSim(w, v3(14, 7, 20), (s, dt) => {
        for (const a of s.ants) runDigDuty(s, a, dt);
      });
      const d = designate(sim, 'dig', 19.5, 9, 20, 1.6);
      spawnWorker(sim, v3(16.5, 7, 20));
      let t = 0;
      for (; t < 20000 && !d.done; t++) sim.step();
      return d.done ? t : Infinity;
    };
    const sand = time(Mat.Sand);
    const clay = time(Mat.Clay);
    expect(sand).toBeLessThan(Infinity);
    expect(clay).toBeLessThan(Infinity);
    expect(clay).toBeGreaterThan(sand * 1.2);
    // rock cannot be dug: the designation offers no site and digDirect removes nothing
    const w = nestWorld(Mat.Rock);
    const sim = a2aSim(w, v3(14, 7, 20));
    designate(sim, 'dig', 19.5, 9, 20, 1.6);
    const a = spawnWorker(sim, v3(16.5, 7, 20));
    sim.step();
    expect(claimWorkSite(sim, a)).toBeNull();
    const v = w.version;
    expect(digDirect(sim, a, v3(18.5, 8, 20))).toBe(0);
    expect(w.version).toBe(v);
  }, 60000);

  it('edible material yields food as it is dug (gel farm)', () => {
    const w = nestWorld(Mat.Gel);
    const sim = a2aSim(w, v3(14, 7, 20), (s, dt) => {
      for (const a of s.ants) runDigDuty(s, a, dt);
    });
    const colony = sim.getColony(sim.playerColony)!;
    const food0 = colony.stores.food;
    const d = designate(sim, 'dig', 19.5, 9, 20, 1.8);
    spawnWorker(sim, v3(16.5, 7, 20));
    for (let t = 0; t < 20000 && !d.done; t++) sim.step();
    expect(d.done).toBe(true);
    expect(colony.stores.food).toBeGreaterThan(food0);
  }, 60000);

  it('build designations are filled with the requested material, paid from the mud store', () => {
    const w = flatWorld(40, 28, 40, 12);
    const sim = a2aSim(w, v3(10, 12.5, 10), (s, dt) => {
      for (const a of s.ants) runDigDuty(s, a, dt, { kind: 'build' });
    });
    const colony = sim.getColony(sim.playerColony)!;
    // no mud: nothing gets built
    colony.stores.mud = 0;
    const d = designate(sim, 'build', 22, 13, 22, 2.4, Mat.Mud);
    const ants: Ant[] = [];
    for (let i = 0; i < 4; i++) ants.push(spawnWorker(sim, v3(16 + i, 12.5, 16)));
    for (let t = 0; t < 400; t++) sim.step();
    expect(d.done).toBe(false);
    expect(solidCells(w, 18, 12, 18, 26, 17, 26)).toBe(0);
    const site = claimWorkSite(sim, ants[0], 'build');
    if (site) expect(['noMaterial', 'outOfReach']).toContain(applyBuildWork(sim, ants[0], site, 1 / 30));
    releaseWorkSite(sim, ants[0]);
    // with mud the mound goes up
    colony.stores.mud = 500;
    let t = 0;
    for (; t < 20000 && !d.done; t++) sim.step();
    expect(d.done).toBe(true);
    const built = solidCells(w, 18, 12, 18, 26, 17, 26);
    expect(built).toBeGreaterThan(25);
    expect(colony.stores.mud).toBeLessThan(500);
    let mud = 0;
    for (let y = 12; y <= 17; y++) for (let z = 18; z <= 26; z++) for (let x = 18; x <= 26; x++) if (w.density[w.index(x, y, z)] >= ISO && w.material[w.index(x, y, z)] === Mat.Mud) mud++;
    expect(mud).toBe(built);
    expect(digStats(sim).filledVoxels).toBeGreaterThanOrEqual(built);
    // nobody was entombed by the build
    for (const a of sim.ants) expect(w.sample(a.pos.x, a.pos.y, a.pos.z)).toBeLessThan(0.3);
  }, 60000);
});
