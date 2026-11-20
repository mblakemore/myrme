import { expect, test } from '@playwright/test';
import type { Command } from '../../src/core';
import { boot, frameOpenGround, frames, type A5View } from './a5-helpers';

const ownCount = () => {
  const m = window.__myrme!;
  return m.sim.ants.filter((a) => a.alive && a.colony === m.sim.playerColony).length;
};

test('HUD shows live counts; speed / pause buttons send commands and never leak clicks into the scene', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page);
  await expect(page.getByTestId('hud')).toBeVisible();
  await expect(page.getByTestId('topbar')).toBeVisible();
  await expect(page.getByTestId('toolbar')).toBeVisible();
  await expect(page.getByTestId('minimap')).toBeVisible();

  // population follows the sim
  const n0 = await page.evaluate(ownCount);
  await expect(page.getByTestId('pop-total')).toHaveText(String(n0));
  await page.evaluate((id) => {
    const m = window.__myrme!;
    const p = m.sim.getAnt(id)!.pos;
    m.command({ type: 'debugSpawn', what: 'ant', pos: { x: p.x, y: p.y, z: p.z }, count: 7 });
    m.step(30);
  }, fr.id);
  const n1 = await page.evaluate(ownCount);
  expect(n1).toBe(n0 + 7);
  await expect(page.getByTestId('pop-total')).toHaveText(String(n1));
  const food = await page.evaluate(() => Math.floor(window.__myrme!.sim.getColony(window.__myrme!.sim.playerColony)!.stores.food));
  await expect(page.getByTestId('food')).toHaveText(String(food));
  await expect(page.getByTestId('clock')).toContainText('Day');

  // speed buttons: commands go out, the HUD reflects sim state, the selection survives the clicks
  await page.evaluate((id) => window.__myrme!.select([id]), fr.id);
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.getByTestId('speed-2').click();
  expect(await page.evaluate(() => (window.__myrme!.step(1), window.__myrme!.sim.speed))).toBe(2);
  await expect(page.getByTestId('speed-2')).toHaveClass(/mh-on/);
  await page.getByTestId('speed-4').click();
  expect(await page.evaluate(() => (window.__myrme!.step(1), window.__myrme!.sim.speed))).toBe(4);
  await page.getByTestId('speed-pause').click();
  expect(await page.evaluate(() => (window.__myrme!.step(1), window.__myrme!.sim.paused))).toBe(true);
  await expect(page.getByTestId('speed-pause')).toHaveClass(/mh-on/);
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => (window.__myrme!.step(1), window.__myrme!.sim.paused))).toBe(false);
  await page.getByTestId('speed-1').click();
  expect(await page.evaluate(() => (window.__myrme!.step(1), window.__myrme!.sim.speed))).toBe(1);
  const after = await page.evaluate(() => ({ sel: window.__myrme!.view.selection.slice(), types: [...new Set(window.__cmds!.map((c) => c.type))].sort() }));
  expect(after.sel).toEqual([fr.id]);
  expect(after.types).toEqual(['pause', 'setSpeed']); // no orders, no selection change from UI clicks

  // toolbar buttons drive the same actions as the hotkeys
  await page.getByTestId('tool-dig').click();
  expect(await page.evaluate(() => window.__myrme!.view.tool)).toBe('dig');
  await expect(page.getByTestId('tool-dig')).toHaveClass(/mh-on/);
  await page.getByTestId('tool-dig').click();
  expect(await page.evaluate(() => window.__myrme!.view.tool)).toBeNull();
  await page.getByTestId('toggle-phero').click();
  expect(await page.evaluate(() => window.__myrme!.view.pheroVision)).toBe(true);
  await page.getByTestId('toggle-phero').click();
  await page.getByTestId('beacon-rally').click();
  expect(await page.evaluate(() => (window.__myrme!.view as A5View).a5!.activeTool)).toBe('beacon:rally');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('selection panel, colony sliders, tooltip, help overlay, minimap jump, debug overlay', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page, 13, 5);

  // selection panel appears with the ant's details and its buttons work
  await expect(page.getByTestId('selection-panel')).toBeHidden();
  const ant = fr.ants.find((a) => a.id === fr.id) ?? fr.ants[0];
  await page.mouse.click(ant.x, ant.y);
  await expect(page.getByTestId('selection-panel')).toBeVisible();
  await expect(page.getByTestId('selection-panel')).toContainText(/worker|soldier|queen/i);
  await page.evaluate(() => window.__myrme!.select(window.__myrme!.sim.ants.slice(0, 6).map((a) => a.id)));
  await expect(page.getByTestId('selection-panel')).toContainText('6 ants selected');

  // hovering an ant shows the tooltip
  await page.mouse.move(ant.x, ant.y);
  await expect(page.getByTestId('tooltip')).toBeVisible();
  await expect(page.getByTestId('tooltip')).toContainText(/worker|soldier|queen/i);
  expect(await page.evaluate(() => window.__myrme!.view.hoverId)).toBeGreaterThan(0);
  await page.mouse.move(fr.ground.x, fr.ground.y);
  await frames(page, 6);
  expect(await page.evaluate(() => window.__myrme!.view.hoverId)).toBe(0);

  // colony quick-panel: sliders send setPriority / setCasteRatio
  if (!(await page.getByTestId('priority-forage').isVisible())) await page.keyboard.press('l');
  await expect(page.getByTestId('priority-forage')).toBeVisible();
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.getByTestId('priority-forage').evaluate((el: HTMLInputElement) => {
    el.value = String(Number(el.max));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.getByTestId('caste-ratio').evaluate((el: HTMLInputElement) => {
    el.value = String(Number(el.max));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(350);
  const sent = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    const col = m.sim.getColony(m.sim.playerColony)!;
    return { cmds: window.__cmds!.filter((c) => c.type === 'setPriority' || c.type === 'setCasteRatio') as Command[], forage: col.priorities.forage, soldier: col.casteRatio.soldier };
  });
  expect(sent.cmds.some((c) => c.type === 'setPriority' && c.job === 'forage' && c.value === 2)).toBe(true);
  expect(sent.cmds.some((c) => c.type === 'setCasteRatio' && c.caste === 'soldier')).toBe(true);
  expect(sent.forage).toBe(2);
  expect(sent.soldier).toBeGreaterThan(0.3);

  // help overlay: F1 / ? opens, Esc closes without clearing the selection
  await page.keyboard.press('F1');
  await expect(page.getByTestId('help')).toBeVisible();
  await expect(page.getByTestId('help')).toContainText('Possess ant / release');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('help')).toHaveCount(0);
  expect(await page.evaluate(() => window.__myrme!.view.selection.length)).toBe(6);

  // debug overlay
  await page.keyboard.press('F9');
  await expect(page.getByTestId('debug')).toBeVisible();
  await expect(page.getByTestId('debug')).toContainText('fps');
  await page.keyboard.press('F9');
  await expect(page.getByTestId('debug')).toBeHidden();

  // minimap click moves the camera
  const f0 = await page.evaluate(() => ({ ...window.__myrme!.view.camera.focus }));
  const box = (await page.getByTestId('minimap-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.2);
  await page.waitForTimeout(900);
  const f1 = await page.evaluate(() => ({ ...window.__myrme!.view.camera.focus, sx: window.__myrme!.sim.world.sx, sz: window.__myrme!.sim.world.sz }));
  expect(Math.hypot(f1.x - f0.x, f1.z - f0.z)).toBeGreaterThan(5);
  expect(f1.x).toBeGreaterThan(f1.sx * 0.7);
  expect(f1.z).toBeLessThan(f1.sz * 0.35);
  expect(errors).toEqual([]);
});

test('possession HUD; a possessed ant dying falls back to the map view with an alert that jumps the camera', async ({ page }) => {
  const errors = await boot(page);
  const fr = await frameOpenGround(page);
  await page.evaluate((id) => {
    const m = window.__myrme!;
    m.possess(id);
    m.step(2);
  }, fr.id);
  await expect(page.getByTestId('possess-hud')).toBeVisible();
  await expect(page.getByTestId('possess-hud')).toContainText(/floor|wall|ceiling/);
  await expect(page.getByTestId('toolbar')).toBeHidden();
  await expect(page.getByTestId('selection-panel')).toBeHidden();

  const died = await page.evaluate((id) => {
    const m = window.__myrme!;
    const pos = { ...m.sim.getAnt(id)!.pos };
    m.command({ type: 'debugKill', id });
    m.step(3);
    const cam = m.view.camera;
    return { possessed: m.sim.possessedId, mode: m.view.mode, sel: m.view.selection.slice(), d: Math.hypot(cam.focus.x - pos.x, cam.focus.z - pos.z), pos };
  }, fr.id);
  expect(died.possessed).toBe(0);
  expect(died.mode).toBe('rts');
  expect(died.sel).toEqual([]);
  expect(died.d).toBeLessThan(3); // camera fell back onto the corpse
  await expect(page.getByTestId('possess-hud')).toBeHidden();
  await expect(page.getByTestId('toolbar')).toBeVisible();
  const alert = page.getByTestId('alerts').locator(':scope > *').first();
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/died/i);

  // move away, then click the alert: the camera comes back if the alert carries a position
  await page.keyboard.press('h');
  await page.waitForTimeout(600);
  await alert.click();
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.__myrme!.view.mode)).toBe('rts');
  expect(errors).toEqual([]);
});

for (const size of [{ width: 960, height: 540 }, { width: 1920, height: 1080 }]) {
  test(`HUD layout fits the viewport at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors = await boot(page);
    await page.evaluate(() => window.__myrme!.select(window.__myrme!.sim.ants.slice(0, 8).map((a) => a.id)));
    await frames(page, 3);
    for (const id of ['topbar', 'toolbar', 'minimap', 'selection-panel', 'quick-panel', 'goal']) {
      const b = await page.getByTestId(id).boundingBox();
      expect(b, id).not.toBeNull();
      expect(b!.x, id).toBeGreaterThanOrEqual(0);
      expect(b!.y, id).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width, id).toBeLessThanOrEqual(size.width + 0.5);
      expect(b!.y + b!.height, id).toBeLessThanOrEqual(size.height + 0.5);
    }
    // the bottom row does not collide
    const mm = (await page.getByTestId('minimap').boundingBox())!;
    const sp = (await page.getByTestId('selection-panel').boundingBox())!;
    const tb = (await page.getByTestId('toolbar').boundingBox())!;
    expect(sp.x).toBeGreaterThanOrEqual(mm.x + mm.width - 1);
    expect(tb.x).toBeGreaterThanOrEqual(sp.x + sp.width - 1);
    // the middle of the screen stays free for the 3D scene
    const centre = await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName);
    expect(centre).toBe('CANVAS');
    expect(errors).toEqual([]);
  });
}
