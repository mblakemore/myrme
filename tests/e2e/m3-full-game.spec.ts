import { expect, test, type Page } from '@playwright/test';
import type { DebugApiB5, ShellDebug } from '../../src/core';

declare global {
  interface Window {
    __myrmeShell?: ShellDebug;
  }
}

/**
 * M3: the game as the menu starts it — director, rivals, weather, fungus all on (the direct
 * `?map=` boots of real-game.spec.ts run without a director). The long runs live in the headless
 * soak (`src/sim/fullGame.soak.test.ts`); this checks that every faction also RENDERS its first
 * two minutes cleanly.
 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

const waitPlaying = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => window.__myrme?.ready === true && window.__myrmeShell?.screen === 'playing', null, { timeout: 90_000 });
  await expect(page.getByTestId('loading')).toBeHidden({ timeout: 10_000 });
};

for (const faction of ['gardenAnt', 'fireAnt', 'leafcutter', 'termite'] as const) {
  test(`full game: ${faction} boots on meadow and runs two sim-minutes without console errors`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await page.goto('/?menu=1&attract=0&quality=low');
    await expect(page.getByTestId('menu')).toBeVisible();
    await page.evaluate((f) => void window.__myrmeShell!.startGame({ map: 'meadow', faction: f, seed: 1, difficulty: 'normal', mode: 'goal', size: 'standard' }), faction);
    await waitPlaying(page);
    const r = await page.evaluate(async () => {
      const m = window.__myrme as DebugApiB5;
      m.freezeTime(true);
      const sim = m.sim;
      const colony = sim.getColony(sim.playerColony)!;
      const mine = (): number => sim.ants.filter((a) => a.colony === sim.playerColony).length;
      const start = mine();
      // in slices, with a rendered frame between them (VFX/audio/HUD consume the event stream)
      for (let i = 0; i < 12; i++) {
        m.step(300);
        m.renderNow();
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      }
      const nest = colony.nestPos;
      const bad = sim.ants.filter((a) => !Number.isFinite(a.pos.x + a.pos.y + a.pos.z)).length;
      return {
        start,
        ants: mine(),
        species: colony.species,
        royal: !!sim.getAnt(colony.queenId),
        brood: sim.brood.filter((b) => b.colony === sim.playerColony).length,
        food: colony.stores.food,
        status: sim.goal.status,
        director: sim.director.enabled,
        rivals: sim.colonies.filter((c) => c.id !== sim.playerColony).length,
        nestWalkable: sim.nav.nearestWalkable(nest.x, nest.y, nest.z, 4) >= 0,
        bad,
        tick: sim.tick,
        draws: m.stats().drawCalls,
        options: m.options,
      };
    });
    expect(r.species).toBe(faction);
    expect(r.tick).toBeGreaterThanOrEqual(3600);
    expect(r.start).toBeGreaterThanOrEqual(8);
    expect(r.ants).toBeGreaterThanOrEqual(r.start - 3);
    expect(r.royal).toBe(true);
    expect(r.brood).toBeGreaterThan(0);
    expect(r.status).toBe('active');
    expect(r.director).toBe(true);
    expect(r.rivals).toBeGreaterThan(0);
    expect(r.nestWalkable).toBe(true);
    expect(r.bad).toBe(0);
    expect(r.draws).toBeGreaterThan(1);
    expect(r.options).toMatchObject({ mode: 'goal', difficulty: 'normal' });
    await expect(page.getByTestId('goal')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('menu → new game → play → pause → resume → pause → quit → menu → play again', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await page.goto('/?menu=1&attract=0&quality=low');
  await page.getByTestId('menu-new').click();
  await page.getByTestId('map-forest').click();
  await page.getByTestId('ng-next').click();
  await page.getByTestId('faction-gardenAnt').click();
  await page.getByTestId('ng-next').click();
  await page.getByTestId('ng-seed').fill('11');
  await page.getByTestId('ng-difficulty-brutal').click();
  await page.getByTestId('ng-start').click();
  await waitPlaying(page);

  // the menu's choices reached the sim: brutal director, the forest's rival, the rival goal
  const sim0 = await page.evaluate(() => {
    const s = window.__myrme!.sim;
    return { goal: s.goal.def.kind, intensity: s.director.intensity, enabled: s.director.enabled, rivals: s.colonies.length - 1, paused: s.paused };
  });
  expect(sim0).toMatchObject({ goal: 'eliminateRival', enabled: true, paused: false });
  expect(sim0.intensity).toBeGreaterThan(2);
  expect(sim0.rivals).toBeGreaterThan(0);

  // play: real time advances the sim
  const t0 = await page.evaluate(() => window.__myrme!.sim.tick);
  await page.waitForFunction((t) => window.__myrme!.sim.tick > t + 20, t0, { timeout: 30_000 });

  // pause stops it, resume starts it again
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  const t1 = await page.evaluate(() => window.__myrme!.sim.tick);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__myrme!.sim.tick)).toBe(t1);
  await page.getByTestId('pause-resume').click();
  await expect(page.getByTestId('pause-menu')).toBeHidden();
  await page.waitForFunction((t) => window.__myrme!.sim.tick > t + 10, t1, { timeout: 30_000 });

  // quit to the menu: the game is gone
  await page.keyboard.press('Escape');
  await page.getByTestId('pause-quit').click();
  await page.getByTestId('pause-quit').click(); // confirm
  await expect(page.getByTestId('menu')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => window.__myrme === undefined)).toBe(true);
  expect(await page.evaluate(() => window.__myrmeShell!.screen)).toBe('title');

  // and a second game starts cleanly from there
  await page.getByTestId('menu-quick').click();
  await waitPlaying(page);
  expect(await page.evaluate(() => window.__myrme!.sim.ants.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.querySelectorAll('#app > canvas').length)).toBe(1);
  expect(errors).toEqual([]);
});
