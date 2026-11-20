import { expect, test, type Page } from '@playwright/test';
import type { DebugApi } from '../../src/core';
import { frameOpenGround } from './a5-helpers';

declare global {
  interface Window {
    __myrme?: DebugApi;
  }
}

/** Boots a map at quality=low with the wander fixture and collects console errors. */
async function boot(page: Page, map: string, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?map=${map}&quality=low&fixture=wander&ants=120&seed=3${extra}`);
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  return errors;
}

/** Fraction of distinct colours in a coarse sample of the canvas — a blank canvas gives 1 colour. */
async function canvasVariety(page: Page): Promise<number> {
  return page.evaluate(() => {
    const m = window.__myrme!;
    m.renderNow();
    const src = document.querySelector('canvas')!;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    const g = c.getContext('2d')!;
    g.drawImage(src, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) | ((d[i + 1] >> 3) << 5) | ((d[i + 2] >> 3) << 10));
    return seen.size;
  });
}

for (const map of ['meadow', 'gelFarm']) {
  test(`${map}: boots, renders, select → order → possess → release`, async ({ page }) => {
    const errors = await boot(page, map);

    const info = await page.evaluate(() => {
      const m = window.__myrme!;
      m.freezeTime(true);
      const tick = m.step(30);
      const s = m.stats();
      return { tick, ants: s.ants, draws: s.drawCalls, tris: s.triangles, hash: m.stateHash(), gpu: s.gpu };
    });
    expect(info.tick).toBeGreaterThanOrEqual(30);
    expect(info.ants).toBe(120);
    expect(info.draws).toBeGreaterThan(1);
    expect(info.tris).toBeGreaterThan(1000);
    expect(info.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(await canvasVariety(page)).toBeGreaterThan(12);

    // select → move order
    const order = await page.evaluate(() => {
      const m = window.__myrme!;
      const ants = m.sim.ants.slice(0, 5);
      const ids = ants.map((a) => a.id);
      m.select(ids);
      // a reachable spot a short walk away: where another ant stands, ~10–20 units from the group
      // (ants spread over stems, panes and tunnels, so "the last ant" can be minutes of walking away)
      const d3 = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      const others = m.sim.ants.filter((a) => !ids.includes(a.id) && d3(a.pos, ants[0].pos) > 10).sort((p, q) => d3(p.pos, ants[0].pos) - d3(q.pos, ants[0].pos));
      const far = others[0] ?? m.sim.ants[m.sim.ants.length - 1];
      const target = { x: far.pos.x, y: far.pos.y, z: far.pos.z };
      const dist = () => ants.map((a) => d3(a.pos, target));
      const before = dist();
      m.command({ type: 'order', ids, order: 'move', pos: target });
      m.step(2);
      const tasked = ants.filter((a) => a.tasks.length > 0 && a.tasks[0].source === 'player').length;
      // ants return to their duties once the order completes: score the closest approach, and
      // give paths through tunnels / around the pane time to finish
      const after = before.slice();
      let done = 0;
      for (let i = 0; i < 60 && done < ants.length; i++) {
        m.step(30);
        dist().forEach((d, k) => (after[k] = Math.min(after[k], d)));
        done = ants.filter((a) => !a.tasks.some((t) => t.source === 'player')).length;
      }
      return { selected: m.view.selection.length, tasked, before, after, done };
    });
    expect(order.selected).toBe(5);
    expect(order.tasked).toBe(5);
    // most of the ordered ants reached the target and finished the order
    const closer = order.after.filter((d) => d < 3).length;
    expect(closer).toBeGreaterThanOrEqual(3);
    expect(order.done).toBeGreaterThanOrEqual(3);

    // possess → drive → release
    const pos = await page.evaluate(() => {
      const m = window.__myrme!;
      const ant = m.sim.ants[10];
      const p0 = { ...ant.pos };
      m.possess(ant.id);
      m.step(2);
      const possessed = m.sim.possessedId === ant.id && m.view.mode === 'possess';
      for (let i = 0; i < 30; i++) {
        m.command({ type: 'possessInput', move: { x: 0, y: 1 }, yawDelta: 0.01, sprint: false, actions: { bite: false, dig: false, pickup: false, trail: false, recruit: false } });
        m.step(1);
      }
      const moved = Math.hypot(ant.pos.x - p0.x, ant.pos.y - p0.y, ant.pos.z - p0.z);
      m.view.firstPerson = true;
      m.renderNow();
      const near = m.view.camera.near;
      m.view.firstPerson = false;
      m.release();
      m.step(2);
      return { possessed, moved, near, released: m.sim.possessedId === 0 && m.view.mode !== 'possess', stillThere: !!m.sim.getAnt(ant.id) };
    });
    expect(pos.possessed).toBe(true);
    expect(pos.moved).toBeGreaterThan(0.5);
    expect(pos.near).toBeCloseTo(0.02, 5);
    expect(pos.released).toBe(true);
    expect(pos.stillThere).toBe(true);

    expect(await canvasVariety(page)).toBeGreaterThan(12);
    expect(errors).toEqual([]);
  });
}

test('meadow: real mouse and keyboard input — click select, RMB move, F possess, V view, C cutaway', async ({ page }) => {
  const errors = await boot(page, 'meadow');
  // frame a patch of open ground with ants on it (the authored poses do not guarantee one) and
  // click the ant nearest the screen centre
  await page.evaluate(() => {
    const m = window.__myrme!;
    m.freezeTime(true);
    m.step(60);
  });
  const fr = await frameOpenGround(page, 13, 6); // + a few extra workers so the box has a crowd
  const cx = page.viewportSize()!.width / 2;
  const cy = page.viewportSize()!.height / 2;
  const target = fr.ants.slice().sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0] ?? null;
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);
  const sel = await page.evaluate(() => window.__myrme!.view.selection.slice());
  expect(sel).toEqual([target!.id]);

  // RMB click on bare ground → move order
  await page.mouse.click(fr.ground.x, fr.ground.y, { button: 'right' });
  const tasks = await page.evaluate((id) => {
    const m = window.__myrme!;
    m.step(2);
    return m.sim.getAnt(id)!.tasks.map((t) => `${t.source}:${t.kind}`);
  }, target!.id);
  expect(tasks).toEqual(['player:move']);

  // drag box over the central view selects several ants
  await page.mouse.move(960 * 0.2, 540 * 0.22); // clear of the HUD panels
  await page.mouse.down();
  await page.mouse.move(960 * 0.8, 540 * 0.74, { steps: 4 });
  await page.mouse.up();
  const boxed = await page.evaluate(() => window.__myrme!.view.selection.length);
  expect(boxed).toBeGreaterThan(1);

  // F possesses the first selected ant; V toggles first person; F releases
  await page.keyboard.press('f');
  const st1 = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    return { id: m.sim.possessedId, mode: m.view.mode, fp: m.view.firstPerson };
  });
  expect(st1.id).toBeGreaterThan(0);
  expect(st1.mode).toBe('possess');
  await page.keyboard.press('v');
  expect(await page.evaluate(() => window.__myrme!.view.firstPerson)).toBe(true);
  await page.keyboard.press('f');
  const st2 = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    return { id: m.sim.possessedId, mode: m.view.mode };
  });
  expect(st2).toEqual({ id: 0, mode: 'rts' });

  // C toggles the cutaway, ] moves the plane
  await page.keyboard.press('c');
  const cut1 = await page.evaluate(() => ({ ...window.__myrme!.view.cut }));
  expect(cut1.enabled).toBe(true);
  await page.keyboard.press(']');
  const cut2 = await page.evaluate(() => {
    const m = window.__myrme!;
    m.renderNow();
    return { ...m.view.cut, pending: m.stats().pendingChunks };
  });
  expect(cut2.pos).not.toBe(cut1.pos);
  expect(cut2.pending).toBe(0);
  await page.keyboard.press('c');
  expect(await page.evaluate(() => window.__myrme!.view.cut.enabled)).toBe(false);
  expect(errors).toEqual([]);
});
