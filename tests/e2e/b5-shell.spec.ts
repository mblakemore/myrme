import { expect, test, type Page } from '@playwright/test';
import type { DebugApiB5, ShellDebug } from '../../src/core';
import { boot, frameOpenGround, frames } from './a5-helpers';

declare global {
  interface Window {
    __myrmeShell?: ShellDebug;
  }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const screen = (page: Page): Promise<string | undefined> => page.evaluate(() => window.__myrmeShell?.screen);
const waitPlaying = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__myrme?.ready === true && window.__myrmeShell?.screen === 'playing', null, { timeout: 90_000 });
  await expect(page.getByTestId('loading')).toBeHidden({ timeout: 10_000 });
};
const canvases = (page: Page): Promise<number> => page.evaluate(() => document.querySelectorAll('#app > canvas').length);

test('boot without params shows the title menu over an attract scene', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('menu')).toBeVisible();
  await expect(page.getByTestId('menu-new')).toBeVisible();
  expect(await screen(page)).toBe('title');
  // attract game: one canvas behind the menu, no HUD, and not exposed as the playable game
  await page.waitForFunction(() => window.__myrmeShell!.gamesAlive === 1, null, { timeout: 60_000 });
  expect(await canvases(page)).toBe(1);
  expect(await page.evaluate(() => window.__myrme === undefined)).toBe(true);
  await expect(page.getByTestId('goal')).toHaveCount(0);
  await expect(page).toHaveTitle(/Myrme/);
  expect(errors).toEqual([]);
});

for (const combo of [
  { map: 'desert', faction: 'fireAnt', size: 'small', difficulty: 'peaceful', mode: 'sandbox', seed: '4242' },
  { map: 'sandFarm', faction: 'termite', size: 'standard', difficulty: 'hard', mode: 'goal', seed: '77' },
] as const) {
  test(`new game flow: ${combo.map} × ${combo.faction}`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/?menu=1&attract=0&quality=low');
    await page.getByTestId('menu-new').click();
    await expect(page.getByTestId('newgame')).toBeVisible();
    for (const id of ['meadow', 'forest', 'desert', 'gelFarm', 'sandFarm', 'formicarium']) await expect(page.getByTestId(`map-${id}`)).toBeVisible();
    await page.getByTestId(`map-${combo.map}`).click();
    await page.getByTestId('ng-next').click();
    for (const id of ['gardenAnt', 'fireAnt', 'leafcutter', 'termite']) await expect(page.getByTestId(`faction-${id}`)).toBeVisible();
    await page.getByTestId(`faction-${combo.faction}`).click();
    await page.getByTestId('ng-next').click();
    await page.getByTestId('ng-seed').fill(combo.seed);
    await page.getByTestId(`ng-size-${combo.size}`).click();
    await page.getByTestId(`ng-difficulty-${combo.difficulty}`).click();
    await page.getByTestId(`ng-mode-${combo.mode}`).click();
    // Esc steps back, the choices survive
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`faction-${combo.faction}`)).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('ng-next').click();
    await page.getByTestId('ng-start').click();
    await expect(page.getByTestId('loading')).toBeVisible();
    await expect(page.getByTestId('loading-tip')).not.toBeEmpty();
    await waitPlaying(page);
    const got = await page.evaluate(() => {
      const m = window.__myrme as DebugApiB5;
      const colony = m.sim.colonies.find((c) => c.id === m.sim.playerColony)!;
      return { map: m.sim.mapId, faction: colony.species, seed: m.params.seed, options: m.options, goal: m.sim.goal.def.kind, ants: m.sim.ants.length };
    });
    expect(got.map).toBe(combo.map);
    expect(got.faction).toBe(combo.faction);
    expect(got.seed).toBe(Number(combo.seed));
    expect(got.options).toMatchObject({ mode: combo.mode, difficulty: combo.difficulty, size: combo.size, attract: false });
    if (combo.mode === 'sandbox') expect(got.goal).toBe('sandbox');
    else expect(got.goal).not.toBe('sandbox');
    expect(got.ants).toBeGreaterThan(0);
    await expect(page.getByTestId('menu')).toBeHidden();
    await expect(page.getByTestId('goal')).toBeVisible();
    await expect(page.getByTestId('tutorial')).toBeVisible(); // first game: the tutorial starts
    expect(await canvases(page)).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('URL-param boot goes straight into the map: no menu, __myrme ready', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?map=forest&faction=leafcutter&seed=9&quality=low');
  // the debug API exists as soon as the entry module has run
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await expect(page.getByTestId('shell')).toHaveCount(0);
  await expect(page.getByTestId('menu')).toHaveCount(0);
  const got = await page.evaluate(() => {
    const m = window.__myrme as DebugApiB5;
    return { map: m.sim.mapId, seed: m.params.seed, screen: window.__myrmeShell!.screen, mode: m.options.mode, keys: ['sim', 'view', 'step', 'setCamera', 'freezeTime', 'command', 'stats'].filter((k) => !(k in m)) };
  });
  expect(got).toEqual({ map: 'forest', seed: 9, screen: 'playing', mode: 'goal', keys: [] });
  await expect(page.getByTestId('tutorial')).toBeHidden(); // direct boots do not start the tutorial
  // shot mode still hides every bit of UI
  await page.goto('/?map=meadow&quality=low&shot=1&autostart=1');
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await expect(page.locator('.myrme-hud:visible')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('pause menu → settings: changes apply and persist across a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/?map=meadow&seed=3');
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await frames(page, 3);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  expect(await page.evaluate(() => window.__myrme!.sim.paused)).toBe(true);
  expect(await screen(page)).toBe('paused');
  await page.getByTestId('pause-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(page.getByTestId('pause-menu')).toBeHidden();

  // graphics: quality preset (live) + bloom off
  await page.getByTestId('set-quality-low').click();
  await page.getByTestId('set-bloom').uncheck({ force: true });
  // audio: music volume + mute
  await page.getByTestId('settings-tab-audio').click();
  await page.getByTestId('set-vol-music').fill('0.25');
  await page.getByTestId('set-muted').check({ force: true });
  // controls
  await page.getByTestId('settings-tab-controls').click();
  await page.getByTestId('set-invert-y').check({ force: true });
  await frames(page, 3);
  const live = await page.evaluate(() => {
    const m = window.__myrme as DebugApiB5;
    return { quality: m.stats().quality, audio: m.audio.stats() };
  });
  expect(live.quality).toBe('low');
  expect(live.audio.muted).toBe(true);
  expect(live.audio.volumes.music).toBeCloseTo(0.25, 5);

  // Esc closes settings back to the pause menu, Esc again resumes
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toBeHidden();
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  expect(await page.evaluate(() => window.__myrme!.sim.paused)).toBe(false);

  await page.reload();
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  const after = await page.evaluate(() => {
    const s = window.__myrmeShell!.settings() as { graphics: { quality: string; bloom: boolean }; audio: { music: number; muted: boolean }; controls: { invertY: boolean } };
    const m = window.__myrme as DebugApiB5;
    return { s, quality: m.stats().quality, muted: m.audio.stats().muted };
  });
  expect(after.s.graphics).toMatchObject({ quality: 'low', bloom: false });
  expect(after.s.audio).toMatchObject({ music: 0.25, muted: true });
  expect(after.s.controls.invertY).toBe(true);
  expect(after.quality).toBe('low');
  expect(after.muted).toBe(true);
  await page.evaluate(() => window.__myrmeShell!.openSettings('graphics'));
  await expect(page.getByTestId('set-bloom')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('key rebinding: conflict detection, the new key works, the old one does not, survives reload', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(() => window.__myrmeShell!.openSettings('keys'));
  const slot = page.getByTestId('key-ui.colony-0');
  await expect(slot).toHaveText('L');

  // a key that is taken: asks before stealing
  await slot.click();
  await page.keyboard.press('b');
  await expect(page.getByTestId('key-conflict')).toBeVisible();
  await expect(page.getByTestId('key-conflict')).toContainText('Dig brush');
  await page.getByTestId('key-conflict-cancel').click();
  await expect(slot).toHaveText('L');

  // Esc cancels a capture without closing the dialog
  await slot.click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toBeVisible();
  await expect(slot).toHaveText('L');

  // a free key
  await slot.click();
  await page.keyboard.press('F8');
  await expect(slot).toHaveText('F8');
  await expect(page.getByTestId('key-conflict')).toBeHidden();
  await page.getByTestId('settings-done').click();
  await expect(page.getByTestId('settings')).toBeHidden();

  // toolbar caption follows; the new key toggles the colony panel, the old one no longer does
  await expect(page.getByTestId('tool-x-colony')).toContainText('F8');
  await page.keyboard.press('l');
  await frames(page, 3);
  await expect(page.getByTestId('colony-panel')).toBeHidden();
  await page.keyboard.press('F8');
  await expect(page.getByTestId('colony-panel')).toBeVisible();
  await page.keyboard.press('F8');
  await expect(page.getByTestId('colony-panel')).toBeHidden();

  await page.reload();
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await frames(page, 3);
  await page.keyboard.press('F8');
  await expect(page.getByTestId('colony-panel')).toBeVisible();
  // reset restores the default
  await page.evaluate(() => window.__myrmeShell!.openSettings('keys'));
  await page.getByTestId('key-reset-ui.colony').click();
  await expect(page.getByTestId('key-ui.colony-0')).toHaveText('L');
  expect(errors).toEqual([]);
});

test('menu ↔ game five times: no console errors, no leaked canvases, HUD roots or games', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await page.goto('/?menu=1&quality=low');
  await expect(page.getByTestId('menu')).toBeVisible();
  const maps = ['sandFarm', 'meadow', 'gelFarm', 'formicarium', 'desert'] as const;
  for (let i = 0; i < 5; i++) {
    if (i === 0) {
      // once through the real buttons
      await page.getByTestId('menu-quick').click();
    } else {
      await page.evaluate((map) => void window.__myrmeShell!.startGame({ map, size: 'small', seed: 5, difficulty: 'peaceful' }), maps[i]);
    }
    await waitPlaying(page);
    await page.evaluate(() => window.__myrme!.step(30));
    await frames(page, 4);
    expect(await canvases(page)).toBe(1);
    expect(await page.locator('.myrme-hud:not(.myrme-shell)').count()).toBe(1);
    if (i === 0) {
      await page.keyboard.press('Escape');
      await page.getByTestId('pause-quit').click();
      await page.getByTestId('pause-quit').click(); // confirm
    } else if (i === 1) {
      // restart from the pause menu re-creates the game in place
      const before = await page.evaluate(() => window.__myrmeShell!.gamesCreated);
      await page.keyboard.press('Escape');
      await page.getByTestId('pause-restart').click();
      await page.getByTestId('pause-restart').click();
      await page.waitForFunction((b) => window.__myrmeShell!.gamesCreated > b && window.__myrmeShell!.screen === 'playing' && window.__myrme?.ready === true, before, { timeout: 90_000 });
      expect(await canvases(page)).toBe(1);
      await page.evaluate(() => void window.__myrmeShell!.toMenu());
    } else {
      await page.evaluate(() => void window.__myrmeShell!.toMenu());
    }
    await expect(page.getByTestId('menu')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => window.__myrme === undefined)).toBe(true);
    await expect(page.locator('.myrme-hud:not(.myrme-shell)')).toHaveCount(0);
    expect(await canvases(page)).toBeLessThanOrEqual(1);
  }
  // the attract scene comes back behind the menu; exactly one game alive, one canvas
  await page.waitForFunction(() => window.__myrmeShell!.gamesAlive === 1, null, { timeout: 60_000 });
  expect(await canvases(page)).toBe(1);
  expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBeLessThan(12); // + menu thumbnails only
  expect(await page.evaluate(() => document.querySelectorAll('style[data-myrme], style').length)).toBeLessThan(12);
  expect(errors).toEqual([]);
});

test('end screens: fabricated win (summary, continue in sandbox) and lose (retry)', async ({ page }) => {
  const errors = await boot(page);
  const summary = { reason: 'population', days: 6.4, seconds: 5530, population: 163, peakPopulation: 171, born: 240, deaths: 77, kills: 31, dugVoxels: 9120, foodGathered: 1840, alatesLaunched: 0 };
  await page.evaluate((s) => (window.__myrme as DebugApiB5).emit({ type: 'gameEnd', result: 'won', reason: 'population', summary: { ...s, result: 'won' } }), summary);
  await expect(page.getByTestId('end-win')).toBeVisible();
  await expect(page.getByTestId('end-peak')).toContainText('171');
  await expect(page.getByTestId('end-food')).toContainText('1840');
  await expect(page.getByTestId('end-kills')).toContainText('31');
  await expect(page.getByTestId('end-deaths')).toContainText('77');
  await expect(page.getByTestId('end-days')).toContainText('6.4');
  expect(await screen(page)).toBe('won');
  // not dismissible by Esc
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('end-win')).toBeVisible();
  await page.getByTestId('end-continue').click();
  await expect(page.getByTestId('end-win')).toBeHidden();
  expect(await screen(page)).toBe('playing');
  const cont = await page.evaluate(() => window.__cmds!.filter((c) => (c as { type: string }).type === 'goal').length);
  expect(cont).toBeGreaterThanOrEqual(1);

  // plain core `lose` event (no B3 summary): the recorder fills the card
  await page.evaluate(() => (window.__myrme as DebugApiB5).emit({ type: 'lose', reason: 'queenDead' }));
  await expect(page.getByTestId('end-lose')).toBeVisible();
  await expect(page.getByTestId('end-title')).toContainText(/queen/i);
  await expect(page.getByTestId('end-continue')).toHaveCount(0);
  expect(await screen(page)).toBe('lost');
  const created = await page.evaluate(() => window.__myrmeShell!.gamesCreated);
  await page.getByTestId('end-retry').click();
  await page.waitForFunction((b) => window.__myrmeShell!.gamesCreated > b && window.__myrmeShell!.screen === 'playing' && window.__myrme?.ready === true, created, { timeout: 90_000 });
  await expect(page.getByTestId('end-lose')).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelectorAll('#app > canvas').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('tutorial: all six steps complete through real input, then stay done', async ({ page }) => {
  const errors = await boot(page, 'meadow', '&tutorial=1');
  const state = (): Promise<{ index: number; step: string | null; finished: boolean }> => page.evaluate(() => window.__myrmeShell!.tutorial('state') as { index: number; step: string | null; finished: boolean });
  const step = async (n: number): Promise<void> => {
    await page.evaluate((n) => window.__myrme!.step(n), n);
    await frames(page, 3);
  };
  const card = page.getByTestId('tutorial');
  await expect(card).toBeVisible();
  expect((await state()).step).toBe('camera');

  // 1. camera: hold a pan key (after the opening settle window)
  await page.waitForTimeout(900);
  await frames(page, 2);
  await page.keyboard.down('d');
  await page.waitForTimeout(900);
  await page.keyboard.up('d');
  await expect.poll(async () => (await state()).step).toBe('select');

  // 2. select: click an ant
  const fr = await frameOpenGround(page, 13, 6);
  await frames(page, 2);
  const ant = fr.ants[0];
  await page.mouse.click(ant.x, ant.y);
  await frames(page, 3);
  await expect.poll(async () => (await state()).step).toBe('order');

  // 3. order: right-click the ground
  await page.mouse.click(fr.ground.x, fr.ground.y, { button: 'right' });
  await step(3);
  await expect.poll(async () => (await state()).step).toBe('dig');
  await expect(page.getByTestId('tutorial-ring')).toBeVisible(); // coach mark on the dig tool

  // 4. dig: brush on the ground
  await page.keyboard.press('b');
  await page.mouse.move(fr.ground.x - 30, fr.ground.y);
  await page.mouse.down();
  await page.mouse.move(fr.ground.x + 30, fr.ground.y + 10, { steps: 4 });
  await page.mouse.up();
  await step(3);
  await expect.poll(async () => (await state()).step).toBe('possess');
  await page.keyboard.press('Escape'); // put the brush away

  // 5. possess and release
  await page.mouse.click(ant.x, ant.y);
  await frames(page, 2);
  if ((await page.evaluate(() => window.__myrme!.view.selection.length)) === 0) {
    const again = await frameOpenGround(page, 13, 0);
    await page.mouse.click(again.ants[0].x, again.ants[0].y);
    await frames(page, 2);
  }
  await page.keyboard.press('f');
  await step(3);
  expect(await page.evaluate(() => window.__myrme!.sim.possessedId)).not.toBeNull();
  expect((await state()).step).toBe('possess'); // two-part step: still needs the release
  await page.keyboard.press('f');
  await step(3);
  await expect.poll(async () => (await state()).step).toBe('colony');

  // 6. colony panel
  await page.keyboard.press('l');
  await frames(page, 3);
  await expect.poll(async () => (await state()).finished).toBe(true);
  expect(await page.evaluate(() => (window.__myrmeShell!.settings() as { tutorial: { done: string[] } }).tutorial.done.length)).toBe(6);

  // a later game does not show it again
  await page.reload();
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await frames(page, 3);
  expect((await state()).finished).toBe(true);
  await expect(page.getByTestId('tutorial')).toBeHidden();
  expect(errors).toEqual([]);
});

test('tutorial can be skipped; field guide and help open from the pause menu', async ({ page }) => {
  const errors = await boot(page, 'meadow', '&tutorial=1');
  await expect(page.getByTestId('tutorial')).toBeVisible();
  await page.getByTestId('tutorial-skip').click();
  await expect(page.getByTestId('tutorial')).toBeHidden();
  expect(await page.evaluate(() => (window.__myrmeShell!.settings() as { tutorial: { skipped: boolean } }).tutorial.skipped)).toBe(true);
  await page.evaluate(() => window.__myrmeShell!.openPause());
  await page.getByTestId('pause-codex').click();
  await expect(page.getByTestId('codex')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('codex')).toBeHidden();
  expect(errors).toEqual([]);
});

test('audio follows the game: rain and going underground change the mix; UI and world sounds are counted', async ({ page }) => {
  // a real colony (no fixture): the queen sits in her chamber under the mound
  const errors = watchErrors(page);
  await page.goto('/?map=meadow&quality=low&seed=3');
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => {
    window.__myrme!.freezeTime(true);
    window.__myrme!.step(60);
  });
  await page.mouse.click(480, 300); // gesture: unlocks the AudioContext
  await frames(page, 4);
  const stats = (): Promise<ReturnType<DebugApiB5['audio']['stats']>> => page.evaluate(() => (window.__myrme as DebugApiB5).audio.stats());
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.__myrme!.step(2));
      await frames(page, 4);
    }
  };
  await settle();
  const dry = await stats();
  expect(dry.unlocked).toBe(true);
  expect(dry.scene).toBe('game');
  expect(dry.rain).toBeLessThan(0.05);

  // real sim weather: rain
  await page.evaluate(() => window.__myrme!.command({ type: 'debugWeather', kind: 'rain', intensity: 0.9 }));
  await page.evaluate(() => window.__myrme!.step(240));
  await settle();
  const wet = await stats();
  expect(wet.rain).toBeGreaterThan(dry.rain + 0.1);
  expect(wet.ambience.rain).toBeGreaterThan(0.08);

  // real camera move + cutaway: down into the nest chamber, under a roof
  await page.evaluate(() => {
    const m = window.__myrme!;
    const c = m.sim.colonies.find((k) => k.id === m.sim.playerColony)!;
    const q = m.sim.getAnt(c.queenId ?? -1) ?? m.sim.ants.find((a) => a.colony === c.id && m.sim.world.raycast({ x: a.pos.x, y: a.pos.y + 0.5, z: a.pos.z }, { x: 0, y: 1, z: 0 }, 60) !== null)!;
    m.setCamera({ pos: [q.pos.x + 3, q.pos.y + 4, q.pos.z + 3], target: [q.pos.x, q.pos.y, q.pos.z] });
  });
  await page.keyboard.press('c');
  expect(await page.evaluate(() => window.__myrme!.view.cut.enabled)).toBe(true);
  await settle();
  await page.waitForTimeout(400);
  await settle();
  const under = await stats();
  expect(under.muffle).toBeGreaterThan(wet.muffle + 0.15);
  expect(under.rain).toBeLessThan(wet.rain);

  // sounds are triggered by sim events and by the UI
  const before = await stats();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.getByTestId('pause-resume').click();
  const after = await stats();
  const total = (s: typeof after): number => Object.values(s.played).reduce((a, b) => a + b, 0);
  expect(total(after)).toBeGreaterThan(total(before));
  expect(errors).toEqual([]);
});
