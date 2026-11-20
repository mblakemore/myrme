import { expect, test, type Page } from '@playwright/test';
import type { AudioStats, DebugApiB5, SimEvent } from '../../src/core';

/**
 * B5 audio: the procedural WebAudio engine, asserted through `__myrme.audio.stats()` and the
 * `__myrmeAudio` debug hook (no listening). Direct URL boot; the context is unlocked by a real
 * click (own gesture listeners).
 */
interface AudioHook {
  weather?: Record<string, unknown> | null;
  underground?: boolean | number | null;
  renderOffline(id: string, seconds?: number): Promise<{ peak: number; rms: number; nan: number; length: number }>;
  ids(): string[];
}
type W = Window & { __myrmeAudio?: AudioHook };

const api = (): DebugApiB5 => window.__myrme as unknown as DebugApiB5;
void api;

async function boot(page: Page, map = 'meadow'): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?map=${map}&quality=low&fixture=wander&ants=60&seed=3`);
  await page.waitForFunction(() => (window as unknown as { __myrme?: { ready: boolean } }).__myrme?.ready === true, null, { timeout: 60_000 });
  return errors;
}

const stats = (page: Page): Promise<AudioStats> => page.evaluate(() => (window.__myrme as unknown as DebugApiB5).audio.stats());

/** Real user gesture → context running, all beds built, node count settled. */
async function unlock(page: Page): Promise<void> {
  expect((await stats(page)).state).toBe('none'); // nothing is created before a gesture
  await page.mouse.click(480, 200);
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().state === 'running', null, { timeout: 15_000 });
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().voicesByBus.ambience > 0, null, { timeout: 15_000 });
  await page.waitForTimeout(700);
}

async function emitAtFocus(page: Page, make: string, count: number): Promise<void> {
  await page.evaluate(
    ({ make, count }) => {
      const m = window.__myrme as unknown as DebugApiB5;
      const f = m.view.camera.focus;
      const fn = new Function('pos', 'i', `return (${make});`) as (pos: { x: number; y: number; z: number }, i: number) => SimEvent;
      const list: SimEvent[] = [];
      for (let i = 0; i < count; i++) list.push(fn({ x: f.x + (i % 5) * 0.3, y: f.y, z: f.z }, i));
      m.emit(list);
    },
    { make, count },
  );
}

test('audio starts on a gesture, mixes ambience from state, and stays within its budgets', async ({ page }) => {
  const errors = await boot(page);
  await unlock(page);

  let s = await stats(page);
  expect(s.unlocked).toBe(true);
  expect(s.scene).toBe('game');
  expect(s.time).toBeGreaterThan(0);
  expect(Object.keys(s.ambience).length).toBe(16);
  expect(s.ambience.breeze).toBeGreaterThan(0.1); // meadow by day
  expect(s.ambience.roomTone).toBe(0);
  expect(s.rain).toBe(0);
  expect(s.muffle).toBe(0);
  expect(s.nodes).toBeGreaterThan(40);
  expect(s.music.enabled).toBe(true);
  expect(['calm', 'night']).toContain(s.music.mood);

  // music is being scheduled
  const notes0 = s.music.notes;
  await page.waitForFunction((n) => (window.__myrme as unknown as DebugApiB5).audio.stats().music.notes > n, notes0, { timeout: 20_000 });

  // ---- rain ----
  await page.evaluate(() => ((window as W).__myrmeAudio!.weather = { kind: 'rain', intensity: 1 }));
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().rain > 0.5);
  s = await stats(page);
  expect(s.ambience.rain).toBeGreaterThan(0.3);
  expect(s.ambience.birds).toBeLessThan(0.05);
  await page.evaluate(() => ((window as W).__myrmeAudio!.weather = { kind: 'rain', intensity: 0.25 }));
  await page.waitForFunction((heavy) => (window.__myrme as unknown as DebugApiB5).audio.stats().ambience.rain < heavy * 0.6, s.ambience.rain);
  // night
  await page.evaluate(() => ((window as W).__myrmeAudio!.weather = { kind: 'clear', intensity: 0, timeOfDay: 0.02 }));
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().ambience.crickets > 0.3);
  expect((await stats(page)).music.mood).toBe('night');
  await page.evaluate(() => ((window as W).__myrmeAudio!.weather = null));

  // ---- possession: closer; underground: muffled ----
  const open = await stats(page);
  await page.evaluate(() => {
    const m = window.__myrme as unknown as DebugApiB5;
    m.possess(m.sim.ants.find((a) => a.colony === m.sim.playerColony)!.id);
  });
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().closeness >= 0.8);
  await page.waitForFunction(() => ((window.__myrme as unknown as DebugApiB5).audio.stats().played.possessIn ?? 0) >= 1);
  await page.evaluate(() => ((window as W).__myrmeAudio!.underground = true));
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().muffle > 0.86);
  s = await stats(page);
  expect(s.ambience.underground).toBeGreaterThan(0.4);
  expect(s.ambience.breeze).toBeLessThan(open.ambience.breeze * 0.5);
  await page.evaluate(() => {
    (window as W).__myrmeAudio!.underground = null;
    (window.__myrme as unknown as DebugApiB5).release();
  });
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().muffle < 0.05);
  await page.waitForFunction(() => ((window.__myrme as unknown as DebugApiB5).audio.stats().played.possessOut ?? 0) >= 1);

  // ---- fabricated sim events → sfx ----
  const before = await stats(page);
  await emitAtFocus(page, `{ type: 'dig', tick: 0, by: 1, pos, radius: 2, material: 1 }`, 1);
  await page.waitForFunction((n) => ((window.__myrme as unknown as DebugApiB5).audio.stats().played.dig ?? 0) > n, before.played.dig ?? 0);
  await emitAtFocus(page, `{ type: 'sporeBurst', tick: 0, pos, radius: 3 }`, 1);
  await emitAtFocus(page, `{ type: 'keeper', tick: 0, action: 'tapGlass', pos: null, on: true }`, 1);
  await emitAtFocus(page, `{ type: 'lightning', tick: 0, pos }`, 1);
  await emitAtFocus(page, `{ type: 'alert', tick: 0, code: 'starving', colony: 0, pos: null, id: 0, text: 'x' }`, 1);
  await page.waitForFunction(() => {
    const p = (window.__myrme as unknown as DebugApiB5).audio.stats().played;
    return p.sporeBurst >= 1 && p.glassTap >= 1 && p.thunder >= 1 && p['ui.alertWarn'] >= 1;
  });
  // infection colours the score
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().music.mood === 'infection');

  // far-away events are culled, not played
  const culled0 = (await stats(page)).culled;
  await page.evaluate(() => {
    const m = window.__myrme as unknown as DebugApiB5;
    const f = m.view.camera.focus;
    m.emit({ type: 'creatureDied', tick: 0, id: 1, def: 'groundBeetle', pos: { x: f.x + 5000, y: f.y, z: f.z }, killerColony: 0 } as SimEvent);
  });
  await page.waitForFunction((n) => (window.__myrme as unknown as DebugApiB5).audio.stats().culled > n, culled0);

  // ---- event flood: voice cap + rate limits hold ----
  let peakVoices = 0;
  for (let round = 0; round < 6; round++) {
    await emitAtFocus(page, `[{ type: 'dig', tick: 0, by: 1, pos, radius: 2, material: 1 }, { type: 'damage', tick: 0, target: 1, amount: 3, pos }, { type: 'itemPicked', tick: 0, by: 1, item: 2, pos }, { type: 'foodDelivered', tick: 0, colony: 1, by: 1, amount: 1, pos }, { type: 'broodStage', tick: 0, id: 1, colony: 1, stage: 'adult', pos }, { type: 'creatureDied', tick: 0, id: 1, def: 'wasp', pos, killerColony: 1 }, { type: 'flood', tick: 0, pos, cell: 0, rising: true }, { type: 'build', tick: 0, by: 1, pos, radius: 2, material: 9 }][i % 8]`, 400);
    await page.waitForTimeout(60);
    const v = await stats(page);
    peakVoices = Math.max(peakVoices, v.voicesByBus.sfx);
    expect(v.voicesByBus.sfx).toBeLessThanOrEqual(24);
    expect(v.voicesByBus.ui).toBeLessThanOrEqual(6);
  }
  expect(peakVoices).toBeGreaterThan(3);
  // win → victory stinger latches the mood
  await page.evaluate(() => (window.__myrme as unknown as DebugApiB5).emit({ type: 'win', tick: 0, reason: 'test' }));
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().music.mood === 'victory');

  // settings hooks
  await page.evaluate(() => {
    const a = (window.__myrme as unknown as DebugApiB5).audio;
    a.setVolumes({ master: 0.3, music: 0 });
    a.setMuted(true);
    a.ui('click');
  });
  s = await stats(page);
  expect(s.volumes.master).toBeCloseTo(0.3);
  expect(s.muted).toBe(true);
  expect(errors).toEqual([]);
});

test('offline renders of every generator are non-silent, non-clipping and NaN-free', async ({ page }) => {
  const errors = await boot(page);
  const results = await page.evaluate(async () => {
    const hook = (window as W).__myrmeAudio!;
    const out: Record<string, { peak: number; rms: number; nan: number }> = {};
    for (const id of hook.ids()) {
      const long = id.startsWith('music:') || id.startsWith('stinger:') || id === 'thunder' || id === 'sporeBurst';
      out[id] = await hook.renderOffline(id, long ? 4 : 1.5);
    }
    return out;
  });
  const ids = Object.keys(results);
  expect(ids.length).toBeGreaterThan(60);
  for (const id of ids) {
    const r = results[id];
    expect(r.nan, id).toBe(0);
    expect(r.peak, id).toBeLessThan(0.99);
    expect(r.peak, id).toBeGreaterThan(0.002);
    expect(r.rms, id).toBeGreaterThan(0.0001);
  }
  // the context is still untouched: offline rendering needs no gesture
  expect((await stats(page)).state).toBe('none');
  expect(errors).toEqual([]);
});

test('voices and nodes are released: idle baseline after a burst, after dispose, and on destroy', async ({ page }) => {
  const errors = await boot(page, 'gelFarm');
  await unlock(page);
  let s = await stats(page);
  expect(s.ambience.roomTone).toBeGreaterThan(0.2); // farm room tone
  expect(s.ambience.breeze).toBe(0);

  // quiesce: no music notes, no voices → baseline
  await page.evaluate(() => (window.__myrme as unknown as DebugApiB5).audio.setMusicEnabled(false));
  await page.waitForFunction(() => {
    const st = (window.__myrme as unknown as DebugApiB5).audio.stats();
    return st.voices === 0 && st.voicesByBus.music === 0;
  }, null, { timeout: 30_000 });
  const baseline = (await stats(page)).nodes;
  expect((await stats(page)).music.mood).toBe('off');

  await emitAtFocus(page, `[{ type: 'dig', tick: 0, by: 1, pos, radius: 2, material: 1 }, { type: 'keeper', tick: 0, action: 'dropFood', pos, on: true }, { type: 'sporeBurst', tick: 0, pos, radius: 3 }, { type: 'damage', tick: 0, target: 1, amount: 3, pos }][i % 4]`, 40);
  await page.waitForFunction((n) => (window.__myrme as unknown as DebugApiB5).audio.stats().nodes > n, baseline);
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().voices === 0, null, { timeout: 20_000 });
  expect((await stats(page)).nodes).toBe(baseline);

  // unbind mid-sound: world voices are freed at once, beds go quiet, the context survives
  await emitAtFocus(page, `{ type: 'sporeBurst', tick: 0, pos, radius: 3 }`, 1);
  await page.waitForFunction(() => (window.__myrme as unknown as DebugApiB5).audio.stats().voicesByBus.sfx > 0);
  await page.evaluate(() => (window.__myrme as unknown as DebugApiB5).audio.dispose());
  s = await stats(page);
  expect(s.voicesByBus.sfx).toBe(0);
  expect(s.nodes).toBe(baseline);
  expect(s.state).toBe('running');
  expect(Object.values(s.ambience).every((v) => v === 0)).toBe(true);

  await page.evaluate(() => (window.__myrme as unknown as DebugApiB5).audio.destroy());
  s = await stats(page);
  expect(s.nodes).toBe(0);
  expect(s.state).toBe('none');
  expect(errors).toEqual([]);
});
