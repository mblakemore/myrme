import { expect, test } from '@playwright/test';
import type { DebugApi } from '../../src/core';

declare global {
  interface Window {
    __myrme?: DebugApi;
  }
}

/**
 * The REAL game (`fixture=none`: queen + founding workers, colony brain, job board) on every map
 * — the other specs drive the M0 wander fixture. One sim-minute is enough for foragers to leave
 * the nest and for the first brood to be laid; the 10-minute growth checks live in the headless
 * colony soak (`src/sim/systems/colony.soak.test.ts`).
 */
for (const map of ['meadow', 'forest', 'desert', 'gelFarm', 'sandFarm', 'formicarium']) {
  test(`${map}: real colony boots, forages and renders without console errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`/?map=${map}&quality=low&fixture=none&seed=1`);
    await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });

    const r = await page.evaluate(() => {
      const m = window.__myrme!;
      m.freezeTime(true);
      const sim = m.sim;
      const colony = sim.getColony(sim.playerColony)!;
      // the player's own founders: forest also has a neutral fungus-host ant on its native stalk (B2)
      const mine = (): number => sim.ants.filter((a) => a.colony === sim.playerColony).length;
      const start = mine();
      const tod0 = sim.weather.timeOfDay;
      m.step(1800);
      const s = m.stats();
      // the nest view: cutaway on outdoor maps, the pane on farms
      const poses = sim.map.shotPoses;
      m.setCamera(poses.queen ?? poses.chamber ?? poses.overview);
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
      return {
        start,
        ants: mine(),
        queen: !!sim.getAnt(colony.queenId),
        foragers: sim.ants.filter((a) => a.tasks[0]?.kind === 'gather').length,
        brood: sim.brood.length,
        nestWalkable: sim.nav.isWalkable(colony.nestCell),
        failedPaths: sim.ants.filter((a) => a.path?.status === 'failed').length,
        dayNight: sim.map.flags.dayNight,
        todAdvanced: sim.weather.timeOfDay !== tod0,
        draws: s.drawCalls,
        variety: seen.size,
      };
    });
    expect(r.start).toBe(11);
    expect(r.ants).toBeGreaterThanOrEqual(9);
    expect(r.queen).toBe(true);
    expect(r.foragers).toBeGreaterThan(0);
    expect(r.brood).toBeGreaterThan(0);
    expect(r.nestWalkable).toBe(true);
    expect(r.failedPaths).toBeLessThanOrEqual(2);
    expect(r.todAdvanced).toBe(r.dayNight); // the day/night clock runs exactly where the map has one
    expect(r.draws).toBeGreaterThan(1);
    expect(r.draws).toBeLessThanOrEqual(250);
    expect(r.variety).toBeGreaterThan(12);
    expect(errors).toEqual([]);
  });
}
