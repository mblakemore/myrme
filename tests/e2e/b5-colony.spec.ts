import { expect, test, type Page } from '@playwright/test';
import type { Command, DebugApiB5 } from '../../src/core';
import { frames } from './a5-helpers';

/** Boots a real colony (no fixture) at quality=low, frozen, and records every command sent to the sim. */
async function boot(page: Page, map = 'meadow', extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?map=${map}&quality=low&seed=3${extra}`);
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const m = window.__myrme!;
    m.freezeTime(true);
    m.step(90);
    const sim = m.sim as unknown as { command(c: Command): void };
    const orig = sim.command.bind(sim);
    window.__cmds = [];
    sim.command = (c: Command) => {
      window.__cmds!.push(JSON.parse(JSON.stringify(c)) as Command);
      orig(c);
    };
  });
  await frames(page, 3);
  return errors;
}

test('colony panel: L toggles it with the quick panel, tabs, job priority slider, chamber jump, Esc', async ({ page }) => {
  const errors = await boot(page);
  const panel = page.getByTestId('colony-panel');
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('priority-forage')).toBeHidden(); // quick panel folded at 960×540

  await page.keyboard.press('l');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('priority-forage')).toBeVisible();
  await expect(page.getByTestId('colony-page-overview')).toBeVisible();
  const pop = await page.evaluate(() => {
    const m = window.__myrme!;
    return m.sim.getColony(m.sim.playerColony)!.population.total;
  });
  expect(pop).toBeGreaterThan(0);
  await expect(page.getByTestId('colony-pop')).toHaveText(String(pop));
  await expect(page.getByTestId('colony-store-food')).not.toHaveText('');

  // the panel stays inside the band between the goal tracker and the minimap, clear of the centre
  const pb = (await panel.boundingBox())!;
  const gb = (await page.getByTestId('goal').boundingBox())!;
  const mb = (await page.getByTestId('minimap').boundingBox())!;
  expect(pb.y).toBeGreaterThanOrEqual(gb.y + gb.height - 1);
  expect(pb.y + pb.height).toBeLessThanOrEqual(mb.y + 1);
  expect(pb.x + pb.width).toBeLessThan(480 - 40);
  expect(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName)).toBe('CANVAS');

  // tabs
  await page.getByTestId('colony-tab-jobs').click();
  await expect(page.getByTestId('colony-page-jobs')).toBeVisible();
  await expect(page.getByTestId('colony-page-overview')).toBeHidden();
  await expect(page.getByTestId('colony-activity')).not.toBeEmpty();

  // a per-job slider sends setPriority for exactly that job
  await page.evaluate(() => (window.__cmds!.length = 0));
  await page.getByTestId('job-prio-dig').evaluate((el: HTMLInputElement) => {
    el.value = '1.5';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const sent = await page.evaluate(() => {
    const m = window.__myrme!;
    m.step(2);
    return { cmds: window.__cmds!.filter((c) => c.type === 'setPriority'), dig: m.sim.getColony(m.sim.playerColony)!.priorities.dig };
  });
  expect(sent.cmds.some((c) => c.type === 'setPriority' && c.job === 'dig' && c.value === 1.5)).toBe(true);
  expect(sent.cmds.every((c) => c.type === 'setPriority' && c.job === 'dig')).toBe(true);
  expect(sent.dig).toBe(1.5);

  // nest tab: clicking a chamber moves the camera to it
  await page.getByTestId('colony-tab-nest').click();
  await expect(page.getByTestId('chamber-0')).toBeVisible();
  const before = await page.evaluate(() => ({ ...window.__myrme!.view.camera.focus }));
  await page.evaluate(() => {
    const m = window.__myrme!;
    const n = m.sim.getColony(m.sim.playerColony)!.nestPos;
    m.setCamera({ pos: [n.x + 60, n.y + 50, n.z + 60], target: [n.x + 45, n.y, n.z + 45] });
  });
  await page.getByTestId('chamber-0').click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => {
    const m = window.__myrme!;
    const c = m.sim.getColony(m.sim.playerColony)!;
    const p = c.chambers[0]?.pos ?? c.nestPos;
    const f = m.view.camera.focus;
    return { d: Math.hypot(f.x - p.x, f.z - p.z), f: { ...f } };
  });
  expect(after.d).toBeLessThan(6);
  expect(after.f).not.toEqual(before);

  // log tab renders; lifetime stats exist
  await page.getByTestId('colony-tab-log').click();
  await expect(page.getByTestId('colony-causes')).toBeVisible();
  // keeper tab is not offered on an outdoor goal map
  await expect(page.getByTestId('colony-tab-keeper')).toBeHidden();

  // Esc closes the panel (and only the panel), L reopens, the close button closes
  await page.evaluate(() => window.__myrme!.select(window.__myrme!.sim.ants.slice(0, 3).map((a) => a.id)));
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('priority-forage')).toBeHidden();
  expect(await page.evaluate(() => window.__myrme!.view.selection.length)).toBe(3);
  await page.getByTestId('tool-x-colony').click();
  await expect(panel).toBeVisible();
  await page.getByTestId('colony-close').click();
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test('keeper controls on a farm map in sandbox send keeper commands', async ({ page }) => {
  const errors = await boot(page, 'gelFarm', '&mode=sandbox');
  await page.keyboard.press('l');
  await page.getByTestId('colony-tab-keeper').click();
  await expect(page.getByTestId('colony-page-keeper')).toBeVisible();
  await page.evaluate(() => (window.__cmds!.length = 0));
  for (const id of ['dropFood', 'dropWater', 'lamp', 'tapGlass']) await page.getByTestId(`keeper-${id}`).click();
  const cmds = await page.evaluate(() => window.__cmds!.filter((c) => c.type === 'keeper') as Extract<Command, { type: 'keeper' }>[]);
  expect(cmds.map((c) => c.action)).toEqual(['dropFood', 'dropWater', 'lamp', 'tapGlass']);
  expect(cmds[0].pos).toBeTruthy();
  await page.evaluate(() => window.__myrme!.step(3));
  expect(errors).toEqual([]);
});

test('goal tracker shows the map goal and follows goalProgress events and sim.goal', async ({ page }) => {
  const errors = await boot(page, 'sandFarm');
  const goal = page.getByTestId('goal');
  await expect(goal).toHaveCount(1);
  await expect(goal).toBeVisible();
  const def = await page.evaluate(() => window.__myrme!.sim.goal.def);
  expect(def.kind).toBe('population');
  await expect(page.getByTestId('goal-title')).toHaveText(def.label);
  await expect(page.getByTestId('goal-num-population')).toContainText(`/ ${def.target}`);

  // fabricated progress event (D19 path)
  await page.evaluate((id) => (window.__myrme as DebugApiB5).emit({ type: 'goalProgress', tick: 0, goal: id, progress: 37, target: 60 }), def.id);
  await expect(page.getByTestId('goal-num-population')).toHaveText('37 / 60');
  const scale = await page.getByTestId('goal-bar-population').locator('i').evaluate((el) => (el as HTMLElement).style.transform);
  expect(scale).toBe('scaleX(0.617)');

  // the sim's own goal state takes over as soon as it moves
  await page.evaluate(() => ((window.__myrme!.sim.goal as { progress: number }).progress = 52));
  // (the event above carried a made-up target; the sim's own state restores the map's — 120 since M3)
  await expect(page.getByTestId('goal-num-population')).toHaveText(`52 / ${def.target}`);

  // objectives fold out on click
  await expect(page.getByTestId('goal-subs')).toBeHidden();
  await page.getByTestId('goal-title').click();
  await expect(page.getByTestId('goal-sub-grow')).toBeVisible();

  // won
  await page.evaluate(() => {
    const g = window.__myrme!.sim.goal as { progress: number; status: string };
    g.progress = 60;
    g.status = 'won';
  });
  await expect(page.getByTestId('goal-status')).toHaveText('Complete');
  await expect(goal).toHaveClass(/mg-won/);
  expect(errors).toEqual([]);
});

test('field guide opens from the toolbar and deep-links; pheromone legend follows P', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.getByTestId('codex')).toHaveCount(0);
  await page.getByTestId('tool-x-codex').click();
  const codex = page.getByTestId('codex');
  await expect(codex).toBeVisible();
  await expect(page.getByTestId('codex-title')).toContainText('Black garden ant'); // opens on the player's faction
  await page.getByTestId('codex-link-creature.mantis').click();
  await expect(page.getByTestId('codex-title')).toHaveText('Mantis');
  await expect(page.getByTestId('codex-detail')).toContainText('Boss');
  // fits the viewport
  const b = (await codex.boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(540.5);
  await page.keyboard.press('Escape');
  await expect(codex).toHaveCount(0);

  // legend
  const legend = page.getByTestId('phero-legend');
  await expect(legend).toBeHidden();
  await page.keyboard.press('p');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('Alarm');
  const colour = await page.getByTestId('phero-legend-alarm').locator('.mx-sw').evaluate((el) => (el as HTMLElement).style.color);
  expect(colour).toBe('rgb(255, 71, 26)');
  // a legend row deep-links into the guide
  await page.getByTestId('phero-legend-alarm').click();
  await expect(page.getByTestId('codex-title')).toHaveText('Alarm');
  await page.getByTestId('codex-close').click();
  await expect(page.getByTestId('codex')).toHaveCount(0);
  await page.keyboard.press('p');
  await expect(legend).toBeHidden();
  expect(errors).toEqual([]);
});
