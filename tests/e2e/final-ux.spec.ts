import { expect, test, type Page } from '@playwright/test';
import type { DebugApi, SimEvent } from '../../src/core';

declare global {
  interface Window {
    __myrme?: DebugApi;
  }
}
type Api = DebugApi & { emit(e: SimEvent | SimEvent[]): void };

/** Final-round UX: automatic cutaway, opening camera move, alert de-duplication, HUD scale. */
async function boot(page: Page, extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?map=meadow&quality=low&fixture=none&seed=1${extra}`);
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  return errors;
}

const nestState = (page: Page) =>
  page.evaluate(() => {
    const m = window.__myrme!;
    const c = m.view.cut;
    const n = m.sim.getColony(m.sim.playerColony)!.nestPos;
    const f = m.view.camera.focus;
    const coord = c.axis === 'x' ? n.x : c.axis === 'y' ? n.y : n.z;
    return { enabled: c.enabled, nestHidden: c.enabled && c.sign * (coord - c.pos) > 0, dist: Math.hypot(f.x - n.x, f.y - n.y, f.z - n.z) };
  });

test('jumping to the underground nest opens the cutaway with a hint; switching it off is respected; double-tap H brings it back', async ({ page }) => {
  const errors = await boot(page);
  expect((await nestState(page)).enabled).toBe(false);

  // one tap: camera goes to the nest, whose chamber is underground → cutaway comes on by itself
  await page.keyboard.press('h');
  await expect.poll(async () => (await nestState(page)).enabled, { timeout: 5000 }).toBe(true);
  await page.waitForTimeout(600);
  const s1 = await nestState(page);
  expect(s1.nestHidden).toBe(false);
  expect(s1.dist).toBeLessThan(4);
  const toast = page.getByTestId('alerts').locator('.mh-alert', { hasText: 'Cutaway on' });
  await expect(toast).toHaveCount(1);
  await expect(toast.locator('.mh-kbd').first()).toHaveText('C');

  // the player switches it off: a plain jump home no longer forces it back on
  await page.keyboard.press('c');
  expect((await nestState(page)).enabled).toBe(false);
  await page.keyboard.press('h');
  await page.waitForTimeout(1200);
  expect((await nestState(page)).enabled).toBe(false);

  // …but a double tap asks for it explicitly
  await page.keyboard.press('h');
  await page.keyboard.press('h');
  await expect.poll(async () => (await nestState(page)).enabled, { timeout: 3000 }).toBe(true);
  await expect(toast).toHaveCount(1); // refreshed, not duplicated
  expect(errors).toEqual([]);
});

test('opening camera move (?intro=1): entrance → cutaway → queen chamber, then a hint; a plain boot has none', async ({ page }) => {
  const errors = await boot(page, '&intro=1');
  await expect.poll(async () => (await nestState(page)).enabled, { timeout: 8000 }).toBe(true);
  const hint = page.getByTestId('alerts').locator('.mh-alert', { hasText: 'Your nest is down here' });
  await expect(hint).toHaveCount(1, { timeout: 10_000 });
  const end = await page.evaluate(() => {
    const m = window.__myrme!;
    const col = m.sim.getColony(m.sim.playerColony)!;
    const q = m.sim.getAnt(col.queenId)!;
    const f = m.view.camera.focus;
    return { dxz: Math.hypot(f.x - q.pos.x, f.z - q.pos.z), dy: Math.abs(f.y - q.pos.y), dist: m.view.camera.focusDist };
  });
  expect(end.dxz).toBeLessThan(4);
  expect(end.dy).toBeLessThan(4);
  expect(end.dist).toBeLessThan(16);
  expect(errors).toEqual([]);

  // automated / direct boots without the flag stay on the authored start pose
  await boot(page);
  await page.waitForTimeout(2500);
  expect((await nestState(page)).enabled).toBe(false);
  await expect(page.getByTestId('alerts').locator('.mh-alert')).toHaveCount(0);
});

test('opening camera move is skippable with any key', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?map=meadow&quality=low&fixture=none&seed=1&intro=1');
  // press the key in the same turn the game reports ready (a loaded machine can take seconds to
  // poll, and the whole move lasts 4.5 s)
  await page.waitForFunction(
    () => {
      if (window.__myrme?.ready !== true) return false;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape', bubbles: true }));
      return true;
    },
    null,
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('alerts').locator('.mh-alert', { hasText: 'Your nest is underground' })).toHaveCount(1);
  await page.waitForTimeout(2000);
  expect((await nestState(page)).enabled).toBe(false);
  expect(errors).toEqual([]);
});

test('a repeated alert that is still on screen stays one line (1920×1080), and the HUD is larger there', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors = await boot(page);
  const emit = () =>
    page.evaluate(() => {
      const m = window.__myrme as Api;
      m.emit({ type: 'alert', tick: m.sim.tick, code: 'info', colony: m.sim.playerColony, pos: null, id: 0, text: 'Too hot outside — foragers wait for the evening' } as SimEvent);
    });
  await emit();
  await page.waitForTimeout(6000); // past the burst-merge window, well inside the 12 s on screen
  await emit();
  await page.waitForTimeout(400);
  const lines = page.getByTestId('alerts').locator('.mh-alert', { hasText: 'Too hot outside' });
  await expect(lines).toHaveCount(1);
  await expect(lines.locator('.mh-count')).toHaveCount(0);
  const px = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.myrme-hud')!).fontSize));
  expect(px).toBe(17.5);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.myrme-hud')!).fontSize))).toBe(13);
  expect(errors).toEqual([]);
});
