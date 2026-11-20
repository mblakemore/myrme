import { expect, test } from '@playwright/test';
import type { Command } from '../../src/core';
import { boot, frames, type A5View } from './a5-helpers';

test('picking respects terrain occlusion and the cutaway', async ({ page }) => {
  const errors = await boot(page);
  // an ant that is underground: something solid above it
  const under = await page.evaluate(() => {
    const m = window.__myrme!;
    const w = m.sim.world;
    const a = m.sim.ants.find((x) => x.colony === m.sim.playerColony && x.pos.x > 20 && x.pos.x < w.sx - 20 && x.pos.z > 20 && x.pos.z < w.sz - 20 && (w.raycast({ x: x.pos.x, y: x.pos.y + 0.4, z: x.pos.z }, { x: 0, y: 1, z: 0 }, 80)?.dist ?? 0) > 3);
    if (!a) return null;
    // look straight down at the ground above it
    m.setCamera({ pos: [a.pos.x, a.pos.y + 30, a.pos.z + 6], target: [a.pos.x, a.pos.y, a.pos.z], cut: null });
    return a.id;
  });
  test.skip(under === null, 'no underground ant in this fixture');
  const vp = page.viewportSize()!;
  const boxAll = async () => {
    await page.mouse.move(vp.width * 0.2, vp.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(vp.width * 0.8, vp.height * 0.75, { steps: 4 });
    await page.mouse.up();
    return page.evaluate(() => window.__myrme!.view.selection.slice());
  };
  expect(await boxAll()).not.toContain(under);
  // a click right on top of it does not reach it either
  await page.mouse.click(vp.width / 2, vp.height / 2);
  expect(await page.evaluate(() => window.__myrme!.view.selection.slice())).not.toContain(under);

  // the authored nest pose has a cutaway: ants exposed by the cut are pickable, hidden ones are not
  const sel = await page.evaluate(() => {
    const m = window.__myrme!;
    m.setCamera('nest');
    return m.view.cut.enabled;
  });
  expect(sel).toBe(true);
  const ids = await boxAll();
  const check = await page.evaluate((ids) => {
    const m = window.__myrme!;
    const c = m.view.cut;
    const past = (p: { x: number; y: number; z: number }) => c.sign * ((c.axis === 'x' ? p.x : c.axis === 'y' ? p.y : p.z) - c.pos);
    const w = m.sim.world;
    const covered = (p: { x: number; y: number; z: number }) => w.raycast({ x: p.x, y: p.y + 0.4, z: p.z }, { x: 0, y: 1, z: 0 }, 80) !== null;
    const buried = (p: { x: number; y: number; z: number }) => (w.raycast({ x: p.x, y: p.y + 0.4, z: p.z }, { x: 0, y: 1, z: 0 }, 80)?.dist ?? 0) > 2;
    // Terrain is cut exactly at the plane; entities below ground stay visible (and pickable) up to
    // CUT_ENTITY_MARGIN = 3.5 past it, so the half of a sliced chamber nearer the viewer is not
    // empty (world/cut.ts). On the open surface the plane is strict.
    const hidden = (p: { x: number; y: number; z: number }) => past(p) > 3.5 || (past(p) > 0 && !covered(p));
    const picked = ids.map((id) => m.sim.getAnt(id)!);
    return { n: ids.length, anyHidden: picked.some((a) => hidden(a.pos)), underground: picked.filter((a) => buried(a.pos)).length };
  }, ids);
  expect(check.anyHidden).toBe(false);
  expect(check.underground).toBeGreaterThan(0); // the cross-section makes nest ants selectable
  expect(errors).toEqual([]);
});

test('slab camera on the gel farm: pan / zoom facing the pane, flip to the other pane, pick and paint through the glass', async ({ page }) => {
  const errors = await boot(page, 'gelFarm');
  const vp = page.viewportSize()!;
  const cam = () => page.evaluate(() => ({ mode: window.__myrme!.view.mode, pos: { ...window.__myrme!.view.camera.pos }, focus: { ...window.__myrme!.view.camera.focus }, fwd: { ...window.__myrme!.view.camera.forward }, dist: window.__myrme!.view.camera.focusDist, sz: window.__myrme!.sim.world.sz, side: (window.__myrme!.view as A5View).a5!.slabSide }));
  const c0 = await cam();
  expect(c0.mode).toBe('slab');
  expect(c0.side).toBe(1);
  expect(Math.abs(c0.fwd.z)).toBeGreaterThan(0.9); // square-on to the pane

  await page.mouse.move(vp.width * 0.5, vp.height * 0.5);
  await page.mouse.wheel(0, -500);
  await page.keyboard.down('d');
  await page.waitForTimeout(350);
  await page.keyboard.up('d');
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  await page.waitForTimeout(600);
  const c1 = await cam();
  expect(c1.dist).toBeLessThan(c0.dist * 0.75);
  expect(c1.focus.x).toBeGreaterThan(c0.focus.x + 1);
  expect(c1.focus.y).toBeGreaterThan(c0.focus.y + 0.5);
  expect(c1.focus.z).toBeCloseTo(c0.sz / 2, 3); // the focus stays mid-slab

  // RMB-drag gives only a slight parallax orbit
  await page.mouse.move(vp.width * 0.5, vp.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(vp.width * 0.5 + 400, vp.height * 0.5, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(500);
  const c2 = await cam();
  expect(Math.abs(c2.fwd.z)).toBeGreaterThan(0.75);
  expect(Math.abs(c2.fwd.x)).toBeGreaterThan(0.1);

  // flip: the camera swings to the other pane
  await page.keyboard.press('g');
  await page.waitForTimeout(1600);
  const c3 = await cam();
  expect(c3.side).toBe(-1);
  expect(Math.sign(c3.pos.z - c0.sz / 2)).toBe(-Math.sign(c0.pos.z - c0.sz / 2));
  expect(c3.fwd.z * c0.fwd.z).toBeLessThan(0);
  await page.keyboard.press('g');
  await page.waitForTimeout(1600);

  // pick an ant in a tunnel through the pane
  const target = await page.evaluate(() => {
    const m = window.__myrme!;
    m.setCamera('chamber');
    const cam = m.view.camera;
    const w = innerWidth;
    const h = innerHeight;
    const t = Math.tan((cam.fov * Math.PI) / 360);
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const f = [cam.forward.x, cam.forward.y, cam.forward.z];
    const r = cross(f, [cam.up.x, cam.up.y, cam.up.z]);
    const u = cross(r, f);
    const out: { id: number; x: number; y: number }[] = [];
    for (const a of m.sim.ants) {
      const d = [a.pos.x - cam.pos.x, a.pos.y - cam.pos.y, a.pos.z - cam.pos.z];
      const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      const x = (((d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * t * (w / h))) * 0.5 + 0.5) * w;
      const y = (0.5 - ((d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * t)) * 0.5) * h;
      if (z > 0 && x > w * 0.25 && x < w * 0.75 && y > h * 0.25 && y < h * 0.7) out.push({ id: a.id, x, y });
    }
    // the most isolated one
    out.sort((p, q) => Math.min(...out.filter((o) => o !== q).map((o) => Math.hypot(o.x - q.x, o.y - q.y))) - Math.min(...out.filter((o) => o !== p).map((o) => Math.hypot(o.x - p.x, o.y - p.y))));
    return out[0] ?? null;
  });
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);
  expect(await page.evaluate(() => window.__myrme!.view.selection.slice())).toEqual([target!.id]);

  // dig-paint on the pane: stamps are centred mid-slab so the tunnel touches both panes
  await page.evaluate(() => {
    window.__myrme!.setCamera('front');
    window.__cmds!.length = 0;
  });
  await page.keyboard.press('b');
  await page.mouse.move(vp.width * 0.3, vp.height * 0.62);
  await frames(page, 4);
  await page.mouse.down();
  await page.mouse.move(vp.width * 0.45, vp.height * 0.66, { steps: 5 });
  await page.mouse.up();
  const stamps = await page.evaluate(() => ({ cmds: window.__cmds!.filter((c) => c.type === 'designate') as Extract<Command, { type: 'designate' }>[], mid: window.__myrme!.sim.world.sz / 2 }));
  expect(stamps.cmds.length).toBeGreaterThan(0);
  for (const s of stamps.cmds) expect(s.center.z).toBeCloseTo(stamps.mid, 5);
  expect(errors).toEqual([]);
});
