import { expect, test } from '@playwright/test';
import type { Command } from '../../src/core';
import { boot, frameOpenGround, frames, type A5View } from './a5-helpers';

test('box-select → RMB issues a move Command and the ants travel there', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page);
  expect(fr.ants.length).toBeGreaterThan(0);

  // drag a box over the central area (clear of the HUD panels)
  await page.mouse.move(innerW(page) * 0.2, innerH(page) * 0.22);
  await page.mouse.down();
  await page.mouse.move(innerW(page) * 0.5, innerH(page) * 0.5, { steps: 3 });
  const dragging = await page.evaluate(() => window.__myrme!.view.dragBox !== null);
  expect(dragging).toBe(true);
  await page.mouse.move(innerW(page) * 0.8, innerH(page) * 0.74, { steps: 3 });
  await page.mouse.up();
  const sel = await page.evaluate(() => ({ ids: window.__myrme!.view.selection.slice(), box: window.__myrme!.view.dragBox }));
  expect(sel.box).toBeNull();
  for (const a of fr.ants) expect(sel.ids).toContain(a.id);

  // RMB on bare ground → exactly one order command, kind move, for the whole selection
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.mouse.click(fr.ground.x, fr.ground.y, { button: 'right' });
  const res = await page.evaluate(() => {
    const m = window.__myrme!;
    const cmds = window.__cmds!.filter((c) => c.type === 'order') as Extract<Command, { type: 'order' }>[];
    const ids = m.view.selection.slice();
    const target = cmds[0]?.pos ?? { x: 0, y: 0, z: 0 };
    const dist = () => ids.map((id) => m.sim.getAnt(id)).filter((a) => !!a).map((a) => Math.hypot(a!.pos.x - target.x, a!.pos.y - target.y, a!.pos.z - target.z));
    const before = dist();
    m.step(2);
    const tasked = ids.filter((id) => m.sim.getAnt(id)?.tasks[0]?.source === 'player' && m.sim.getAnt(id)?.tasks[0]?.kind === 'move').length;
    const pings = (m.view as A5View).a5!.orderPings.length;
    // arrived ants go back to wandering, so score the closest approach of each ant
    const after = before.slice();
    for (let i = 0; i < 12; i++) {
      m.step(30);
      dist().forEach((d, k) => (after[k] = Math.min(after[k], d)));
    }
    return { cmds, n: ids.length, before, after, tasked, pings };
  });
  expect(res.cmds.length).toBe(1);
  expect(res.cmds[0].order).toBe('move');
  expect(res.cmds[0].ids.slice().sort()).toEqual(sel.ids.slice().sort());
  expect(res.cmds[0].pos).toBeTruthy();
  expect(res.cmds[0].queue).toBeFalsy();
  expect(res.pings).toBe(1); // feedback state for A4's order markers
  expect(res.tasked).toBe(res.n);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  expect(mean(res.after)).toBeLessThan(Math.max(3.5, mean(res.before) * 0.7));

  // Shift+RMB queues, Alt+RMB guards
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.keyboard.down('Shift');
  await page.mouse.click(fr.ground.x, fr.ground.y, { button: 'right' });
  await page.keyboard.up('Shift');
  await page.keyboard.down('Alt');
  await page.mouse.click(fr.ground.x, fr.ground.y, { button: 'right' });
  await page.keyboard.up('Alt');
  const mods = await page.evaluate(() => (window.__cmds!.filter((c) => c.type === 'order') as Extract<Command, { type: 'order' }>[]).map((c) => `${c.order}${c.queue ? '+queue' : ''}`));
  expect(mods).toEqual(['move+queue', 'guard']);
  expect(errors).toEqual([]);
});

test('click, shift-add, ctrl-toggle, Esc; control group assign / recall / double-tap focus', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page, 16, 6);
  expect(fr.ants.length).toBeGreaterThanOrEqual(2);
  // two ants that are well apart on screen so each click is unambiguous
  let a = fr.ants[0];
  let b = fr.ants[1];
  let far = 0;
  for (const p of fr.ants) for (const q of fr.ants) if (Math.hypot(p.x - q.x, p.y - q.y) > far) (far = Math.hypot(p.x - q.x, p.y - q.y)), (a = p), (b = q);
  const selection = () => page.evaluate(() => window.__myrme!.view.selection.slice());

  await page.mouse.click(a.x, a.y);
  const one = await selection();
  expect(one.length).toBe(1);
  expect(await page.evaluate(() => (window.__myrme!.view as A5View).a5!.primaryId)).toBe(one[0]);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  const two = await selection();
  expect(two.length).toBe(2);
  expect(two[0]).toBe(one[0]);
  await page.keyboard.down('Control');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.up('Control');
  expect(await selection()).toEqual([two[1]]);
  await page.keyboard.press('Escape');
  expect(await selection()).toEqual([]);

  // groups
  const ids = await page.evaluate(() => {
    const m = window.__myrme!;
    const own = m.sim.ants.filter((x) => x.colony === m.sim.playerColony).map((x) => x.id);
    m.select(own.slice(0, 4));
    return { g1: own.slice(0, 4), g2: own.slice(4, 6) };
  });
  await page.keyboard.press('Control+1');
  await page.evaluate((g2) => window.__myrme!.select(g2), ids.g2);
  await page.keyboard.press('Control+2');
  await page.keyboard.press('1');
  expect(await selection()).toEqual(ids.g1);
  await page.keyboard.press('2');
  expect(await selection()).toEqual(ids.g2);
  const groups = await page.evaluate((g) => {
    const m = window.__myrme!;
    m.step(2);
    return { a: g.g1.map((id) => m.sim.getAnt(id)!.group), b: g.g2.map((id) => m.sim.getAnt(id)!.group) };
  }, ids);
  expect(groups.a).toEqual([1, 1, 1, 1]);
  expect(groups.b).toEqual([2, 2]);

  // double-tap: recall + camera travels to the group
  await page.keyboard.press('1');
  await page.keyboard.press('1');
  await page.waitForTimeout(900);
  const focus = await page.evaluate((g1) => {
    const m = window.__myrme!;
    const c = { x: 0, y: 0, z: 0 };
    for (const id of g1) {
      const p = m.sim.getAnt(id)!.pos;
      c.x += p.x / g1.length;
      c.z += p.z / g1.length;
    }
    const f = m.view.camera.focus;
    return Math.hypot(f.x - c.x, f.z - c.z);
  }, ids.g1);
  expect(focus).toBeLessThan(2.5);
  expect(errors).toEqual([]);
});

test('possess → WASD drives the ant → V toggles view → release restores RTS and the queue', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page);
  // give the ant a queued player task first, so we can see it survive the possession
  const before = await page.evaluate((id) => {
    const m = window.__myrme!;
    const me = m.sim.getAnt(id)!.pos;
    // a reachable spot well away: another ant on the surface 15–40 units off
    const other = m.sim.ants.find((a) => a.up.y > 0.85 && Math.abs(a.pos.y - me.y) < 3 && Math.hypot(a.pos.x - me.x, a.pos.z - me.z) > 15 && Math.hypot(a.pos.x - me.x, a.pos.z - me.z) < 40);
    const far = (other ?? m.sim.ants[m.sim.ants.length - 1]).pos;
    m.select([id]);
    m.command({ type: 'order', ids: [id], order: 'move', pos: { x: far.x, y: far.y, z: far.z } });
    m.step(2);
    return m.sim.getAnt(id)!.tasks.map((t) => t.id);
  }, fr.id);
  expect(before.length).toBeGreaterThan(0);

  await page.keyboard.press('f');
  const st = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    return { id: m.sim.possessedId, mode: m.view.mode, tool: m.view.tool, near: m.view.camera.near };
  });
  expect(st.id).toBe(fr.id);
  expect(st.mode).toBe('possess');
  expect(st.near).toBeCloseTo(0.02, 5);

  // hold W: a tick-stamped possessInput goes out and the ant crawls
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.keyboard.down('w');
  await frames(page, 3);
  const drive = await page.evaluate((id) => {
    const m = window.__myrme!;
    const ant = m.sim.getAnt(id)!;
    const p0 = { ...ant.pos };
    m.step(30);
    const inputs = window.__cmds!.filter((c) => c.type === 'possessInput') as Extract<Command, { type: 'possessInput' }>[];
    return { moved: Math.hypot(ant.pos.x - p0.x, ant.pos.y - p0.y, ant.pos.z - p0.z), inputs, tasks: ant.tasks.map((t) => t.id) };
  }, fr.id);
  expect(drive.inputs.length).toBeGreaterThan(0);
  expect(drive.inputs[0].move).toEqual({ x: 0, y: 1 });
  expect(typeof drive.inputs[0].tick).toBe('number');
  expect(drive.moved).toBeGreaterThan(0.5);
  expect(drive.tasks).toEqual(before); // queue untouched while possessed
  await page.keyboard.up('w');
  await frames(page, 3);
  const stop = await page.evaluate((id) => {
    const m = window.__myrme!;
    m.step(3);
    const ant = m.sim.getAnt(id)!;
    const p0 = { ...ant.pos };
    m.step(15);
    return Math.hypot(ant.pos.x - p0.x, ant.pos.y - p0.y, ant.pos.z - p0.z);
  }, fr.id);
  expect(stop).toBeLessThan(0.05);

  // action keys are edge-triggered flags on the next possessInput
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.keyboard.press('e');
  await page.keyboard.press('q');
  await frames(page, 3);
  const acts = await page.evaluate(() => (window.__cmds!.filter((c) => c.type === 'possessInput') as Extract<Command, { type: 'possessInput' }>[]).map((c) => c.actions));
  expect(acts.some((a) => a.pickup)).toBe(true);
  expect(acts.some((a) => a.recruit)).toBe(true);

  await page.keyboard.press('v');
  expect(await page.evaluate(() => window.__myrme!.view.firstPerson)).toBe(true);
  await page.keyboard.press('v');
  expect(await page.evaluate(() => window.__myrme!.view.firstPerson)).toBe(false);

  await page.keyboard.press('f');
  const out = await page.evaluate((id) => {
    const m = window.__myrme!;
    m.step(1);
    const ant = m.sim.getAnt(id)!;
    const cam = m.view.camera;
    return {
      possessed: m.sim.possessedId,
      mode: m.view.mode,
      tasks: ant.tasks.map((t) => t.id),
      flag: ant.possessed,
      selection: m.view.selection.slice(),
      camDist: Math.hypot(cam.pos.x - ant.pos.x, cam.pos.y - ant.pos.y, cam.pos.z - ant.pos.z),
      lookingDown: cam.forward.y < -0.3,
      level: Math.abs(cam.up.y) > 0.3,
    };
  }, fr.id);
  expect(out.possessed).toBe(0);
  expect(out.mode).toBe('rts');
  expect(out.flag).toBe(false);
  expect(out.tasks).toEqual(before);
  expect(out.selection).toEqual([fr.id]);
  expect(out.camDist).toBeLessThan(25);
  expect(out.lookingDown).toBe(true);

  // possess again, hop to a nestmate and back
  await page.keyboard.press('f');
  await page.evaluate(() => window.__myrme!.step(2));
  await page.keyboard.press('Tab');
  const hopped = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    return { id: m.sim.possessedId, mode: m.view.mode };
  });
  expect(hopped.mode).toBe('possess');
  expect(hopped.id).not.toBe(fr.id);
  expect(hopped.id).toBeGreaterThan(0);
  await page.keyboard.press(',');
  expect(await page.evaluate(() => (window.__myrme!.step(2), window.__myrme!.sim.possessedId))).toBe(fr.id);

  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window.__myrme!.step(2), window.__myrme!.view.mode))).toBe('rts');
  expect(errors).toEqual([]);
});

test('possession camera stays upright relative to the ant on walls and ceilings (gel farm)', async ({ page }) => {
  const errors = await boot(page, 'gelFarm');
  const res = await page.evaluate(() => {
    const m = window.__myrme!;
    const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x * b.x + a.y * b.y + a.z * b.z;
    const out: { upDot: number; orth: number; near: number; kind: string }[] = [];
    const own = m.sim.ants.filter((a) => a.colony === m.sim.playerColony);
    const picks = [own.find((a) => a.up.y < -0.6), own.find((a) => Math.abs(a.up.y) < 0.3), own.find((a) => a.up.y > 0.8)];
    for (const a of picks) {
      if (!a) continue;
      m.possess(a.id);
      m.step(3);
      const cam = m.view.camera;
      out.push({ upDot: dot(cam.up, a.up), orth: Math.abs(dot(cam.up, cam.forward)), near: cam.near, kind: a.up.y < -0.6 ? 'ceiling' : Math.abs(a.up.y) < 0.3 ? 'wall' : 'floor' });
      m.release();
      m.step(2);
    }
    return out;
  });
  expect(res.length).toBeGreaterThan(0);
  for (const r of res) {
    expect(r.upDot, r.kind).toBeGreaterThan(0.75); // camera up follows the ant's local up: no roll, no flip
    expect(r.orth, r.kind).toBeLessThan(1e-3);
    expect(r.near).toBeCloseTo(0.02, 5);
  }
  expect(errors).toEqual([]);
});

test('dig-paint creates designations (also on the cutaway face); beacons place and remove; Esc cancels', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page);
  await page.keyboard.press('b');
  expect(await page.evaluate(() => ({ tool: window.__myrme!.view.tool, active: (window.__myrme!.view as A5View).a5!.activeTool }))).toEqual({ tool: 'dig', active: 'dig' });
  // preview brush follows the cursor
  await page.mouse.move(fr.ground.x, fr.ground.y);
  await frames(page, 4);
  const brush = await page.evaluate(() => (window.__myrme!.view as A5View).a5!.brush);
  expect(brush).not.toBeNull();
  expect(brush!.kind).toBe('dig');
  expect(brush!.radius).toBeGreaterThanOrEqual(1.5);
  // drag a stroke
  await page.mouse.down();
  await page.mouse.move(fr.ground.x + 90, fr.ground.y + 10, { steps: 6 });
  await page.mouse.up();
  const painted = await page.evaluate(() => {
    const m = window.__myrme!;
    const sel = m.view.selection.length;
    m.step(2);
    const col = m.sim.getColony(m.sim.playerColony)!;
    return { n: col.designations.filter((d) => d.kind === 'dig').length, cmds: window.__cmds!.filter((c) => c.type === 'designate').length, sel };
  });
  expect(painted.cmds).toBeGreaterThan(1); // a drag leaves several overlapping stamps
  expect(painted.n).toBe(painted.cmds);
  expect(painted.sel).toBe(0); // painting never box-selects

  // erase mode removes them again
  await page.keyboard.press('r');
  await page.mouse.move(fr.ground.x, fr.ground.y);
  await page.mouse.down();
  await page.mouse.move(fr.ground.x + 90, fr.ground.y + 10, { steps: 6 });
  await page.mouse.up();
  const erased = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    return m.sim.getColony(m.sim.playerColony)!.designations.length;
  });
  expect(erased).toBeLessThan(painted.n);
  await page.keyboard.press('r');

  // cutaway: paint on the cross-section → the stamp is centred on the cut plane
  await page.keyboard.press('c');
  await page.mouse.move(innerW(page) * 0.5, innerH(page) * 0.66);
  await frames(page, 4);
  const face = await page.evaluate(() => ({ brush: (window.__myrme!.view as A5View).a5!.brush, cut: { ...window.__myrme!.view.cut } }));
  expect(face.cut.enabled).toBe(true);
  expect(face.brush).not.toBeNull();
  expect(face.brush!.onCutFace).toBe(true);
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.mouse.down();
  await page.mouse.up();
  const stamp = await page.evaluate(() => window.__cmds!.find((c) => c.type === 'designate') as Extract<Command, { type: 'designate' }> | undefined);
  expect(stamp).toBeTruthy();
  expect(stamp!.center[face.cut.axis]).toBeCloseTo(face.cut.pos, 5);
  await page.keyboard.press('c');

  // Esc leaves the tool
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window.__myrme!.view as A5View).a5!.activeTool)).toBeNull();

  // beacon: hotkey → click places, tool drops; click on it with the tool again removes
  await page.keyboard.press('u');
  expect(await page.evaluate(() => (window.__myrme!.view as A5View).a5!.activeTool)).toBe('beacon:gather');
  await page.mouse.click(fr.ground.x, fr.ground.y);
  const placed = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    m.renderNow();
    return { beacons: m.sim.getColony(m.sim.playerColony)!.beacons.map((b) => b.kind), tool: (m.view as A5View).a5!.activeTool };
  });
  expect(placed.beacons).toEqual(['gather']);
  expect(placed.tool).toBeNull();
  await page.keyboard.press('k');
  await page.mouse.click(fr.ground.x, fr.ground.y);
  const removed = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    return m.sim.getColony(m.sim.playerColony)!.beacons.length;
  });
  expect(removed).toBe(0);
  expect(errors).toEqual([]);
});

test('camera: wheel zooms towards the cursor, WASD pans, H jumps to the nest, cutaway keys', async ({ page }) => {
  const errors = await boot(page);
  await frameOpenGround(page, 30);
  const cam = () => page.evaluate(() => ({ pos: { ...window.__myrme!.view.camera.pos }, focus: { ...window.__myrme!.view.camera.focus }, dist: window.__myrme!.view.camera.focusDist, cursor: window.__myrme!.view.cursorWorld }));
  await page.mouse.move(innerW(page) * 0.7, innerH(page) * 0.6);
  await frames(page, 5);
  const c0 = await cam();
  expect(c0.cursor).not.toBeNull();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(700);
  const c1 = await cam();
  expect(c1.dist).toBeLessThan(c0.dist * 0.7);
  // the focus slid towards the point that was under the cursor
  const d0 = Math.hypot(c0.focus.x - c0.cursor!.x, c0.focus.z - c0.cursor!.z);
  const d1 = Math.hypot(c1.focus.x - c0.cursor!.x, c1.focus.z - c0.cursor!.z);
  expect(d1).toBeLessThan(d0 * 0.8);
  // the eye is never inside terrain
  const inside = await page.evaluate(() => {
    const m = window.__myrme!;
    const p = m.view.camera.pos;
    return m.sim.world.sampleVisual(p.x, p.y, p.z);
  });
  expect(inside).toBeLessThan(0);

  await page.keyboard.down('d');
  await page.waitForTimeout(400);
  await page.keyboard.up('d');
  await page.waitForTimeout(400);
  const c2 = await cam();
  expect(c2.focus.x).toBeGreaterThan(c1.focus.x + 0.5);

  await page.keyboard.press('h');
  await page.waitForTimeout(1000);
  const nest = await page.evaluate(() => {
    const m = window.__myrme!;
    const n = m.sim.getColony(m.sim.playerColony)!.nestPos;
    const f = m.view.camera.focus;
    return Math.hypot(f.x - n.x, f.z - n.z);
  });
  expect(nest).toBeLessThan(2);

  // snap-cut to the nest: plane on, nest stays visible, focus sits on the plane
  await page.keyboard.press('\\');
  await page.waitForTimeout(700);
  const cut = await page.evaluate(() => {
    const m = window.__myrme!;
    const c = m.view.cut;
    const n = m.sim.getColony(m.sim.playerColony)!.nestPos;
    const coord = c.axis === 'x' ? n.x : c.axis === 'y' ? n.y : n.z;
    const f = m.view.camera.focus;
    const fc = c.axis === 'x' ? f.x : c.axis === 'y' ? f.y : f.z;
    return { ...c, nestHidden: c.sign * (coord - c.pos) > 0, focusOff: Math.abs(fc - c.pos) };
  });
  expect(cut.enabled).toBe(true);
  expect(cut.nestHidden).toBe(false);
  expect(cut.focusOff).toBeLessThan(0.6);
  await page.keyboard.press(']');
  const moved = await page.evaluate(() => window.__myrme!.view.cut.pos);
  expect(moved).not.toBe(cut.pos);
  await page.keyboard.press('p');
  expect(await page.evaluate(() => window.__myrme!.view.pheroVision)).toBe(true);
  expect(errors).toEqual([]);
});

function innerW(page: import('@playwright/test').Page): number {
  return page.viewportSize()!.width;
}
function innerH(page: import('@playwright/test').Page): number {
  return page.viewportSize()!.height;
}

test('contextual RMB: food → gather, hostile creature → attack, friendly ant → follow', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page, 13, 3);
  // drop a food source and a beetle on free ground near the anchor and find them on screen
  const spots = await page.evaluate((id) => {
    const m = window.__myrme!;
    const sim = m.sim;
    const me = sim.getAnt(id)!;
    const ground = (ox: number, oz: number) => sim.world.raycast({ x: me.pos.x + ox, y: me.pos.y + 3, z: me.pos.z + oz }, { x: 0, y: -1, z: 0 }, 8)?.pos ?? null;
    const gf = ground(-4, 1.5);
    const gc = ground(4, -1.5);
    if (!gf || !gc) return null;
    m.command({ type: 'debugSpawn', what: 'food', pos: { x: gf.x, y: gf.y + 0.2, z: gf.z } });
    m.command({ type: 'debugSpawn', what: 'creature', creature: 'groundBeetle', pos: { x: gc.x, y: gc.y + 0.3, z: gc.z } });
    m.step(2);
    m.renderNow();
    const cam = m.view.camera;
    const w = innerWidth;
    const h = innerHeight;
    const t = Math.tan((cam.fov * Math.PI) / 360);
    const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const f = [cam.forward.x, cam.forward.y, cam.forward.z];
    const r = cross(f, [cam.up.x, cam.up.y, cam.up.z]);
    const u = cross(r, f);
    const project = (p: { x: number; y: number; z: number }) => {
      const d = [p.x - cam.pos.x, p.y - cam.pos.y, p.z - cam.pos.z];
      const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      return { x: (((d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * t * (w / h))) * 0.5 + 0.5) * w, y: (0.5 - ((d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * t)) * 0.5) * h };
    };
    const food = sim.foodSources[sim.foodSources.length - 1];
    const beetle = sim.creatures[sim.creatures.length - 1];
    const friend = sim.ants.filter((a) => a.id !== id && a.colony === sim.playerColony).sort((a, b) => Math.hypot(a.pos.x - me.pos.x, a.pos.z - me.pos.z) - Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z))[0];
    m.select([id]);
    return { food: { id: food.id, ...project(food.pos) }, beetle: { id: beetle.id, ...project(beetle.pos) }, friend: { id: friend.id, ...project(friend.pos) } };
  }, fr.id);
  expect(spots).not.toBeNull();
  const rmb = async (p: { x: number; y: number }) => {
    await page.evaluate(() => (window.__cmds!.length = 0));
    await page.mouse.move(p.x, p.y);
    await frames(page, 4);
    const hover = await page.evaluate(() => ({ id: window.__myrme!.view.hoverId, kind: (window.__myrme!.view as A5View).a5!.hoverKind, hostile: (window.__myrme!.view as A5View).a5!.hoverHostile }));
    await page.mouse.click(p.x, p.y, { button: 'right' });
    const cmd = await page.evaluate(() => window.__cmds!.find((c) => c.type === 'order') as Extract<Command, { type: 'order' }> | undefined);
    return { hover, cmd };
  };
  const g = await rmb(spots!.food);
  expect(g.hover).toEqual({ id: spots!.food.id, kind: 'food', hostile: false });
  expect(g.cmd).toMatchObject({ order: 'gather', targetId: spots!.food.id, ids: [fr.id] });
  const a = await rmb(spots!.beetle);
  expect(a.hover).toEqual({ id: spots!.beetle.id, kind: 'creature', hostile: true });
  expect(a.cmd).toMatchObject({ order: 'attack', targetId: spots!.beetle.id });
  const f = await rmb(spots!.friend);
  expect(f.hover.kind).toBe('ant');
  expect(f.cmd).toMatchObject({ order: 'follow', targetId: spots!.friend.id });
  expect(errors).toEqual([]);
});
