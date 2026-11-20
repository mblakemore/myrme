import type { Page } from '@playwright/test';
import type { Command, DebugApi, ViewStateA5 } from '../../src/core';

declare global {
  interface Window {
    __myrme?: DebugApi;
    /** Commands captured by `spyCommands` (everything that reached `sim.command`). */
    __cmds?: Command[];
  }
}

export type A5View = ViewStateA5;

/** Boots a map at quality=low with the wander fixture, frozen, and collects console errors. */
export async function boot(page: Page, map = 'meadow', extra = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`/?map=${map}&quality=low&fixture=wander&ants=120&seed=3${extra}`);
  await page.waitForFunction(() => window.__myrme?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const m = window.__myrme!;
    m.freezeTime(true);
    m.step(40);
    // record every command that reaches the sim (the input layer goes through app.command → sim.command)
    const sim = m.sim as unknown as { command(c: Command): void };
    const orig = sim.command.bind(sim);
    window.__cmds = [];
    sim.command = (c: Command) => {
      window.__cmds!.push(JSON.parse(JSON.stringify(c)) as Command);
      orig(c);
    };
  });
  return errors;
}

export interface Framed {
  /** The ant the camera was centred on. */
  id: number;
  /** Own ants standing on open ground inside the central part of the screen (id + pixel position). */
  ants: { id: number; x: number; y: number }[];
  /** A pixel on open ground that is at least 45 px away from every projected ant. */
  ground: { x: number; y: number };
}

/**
 * Points the camera straight at a patch of open ground with several ants on it (looking down
 * from `height` above) and returns where those ants are on screen.
 */
export async function frameOpenGround(page: Page, height = 13, spawn = 0): Promise<Framed> {
  return page.evaluate(({ height, spawn }) => {
    const m = window.__myrme!;
    const sim = m.sim;
    const open = (a: { pos: { x: number; y: number; z: number }; up: { y: number } }) =>
      a.up.y > 0.85 && sim.world.raycast({ x: a.pos.x, y: a.pos.y + 0.4, z: a.pos.z }, { x: 0, y: 1, z: 0 }, 80) === null;
    const w0 = sim.world;
    const inland = (a: { pos: { x: number; z: number } }) => a.pos.x > 24 && a.pos.x < w0.sx - 24 && a.pos.z > 24 && a.pos.z < w0.sz - 24;
    let own = sim.ants.filter((a) => a.colony === sim.playerColony && open(a) && inland(a));
    // prefer ants on the ground proper (not on top of a plant): the lowest third by height
    const ys = own.map((a) => a.pos.y).sort((p, q) => p - q);
    const yMax = ys[Math.floor(ys.length / 2)] + 1.5;
    own = own.filter((a) => a.pos.y <= yMax);
    // the open-ground ant with the most open-ground neighbours inside the view
    let best = own[0];
    let bn = -1;
    for (const a of own) {
      const n = own.filter((b) => Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < height * 0.4 && Math.abs(a.pos.y - b.pos.y) < 2).length;
      if (n > bn) {
        bn = n;
        best = a;
      }
    }
    // optionally drop extra workers on the ground around the anchor so there is a crowd to pick from
    for (let k = 0; k < spawn; k++) {
      const ang = k * 2.39996;
      const rad = Math.min(height * 0.3, 2.2 + k * 0.55);
      const hit = sim.world.raycast({ x: best.pos.x + Math.cos(ang) * rad, y: best.pos.y + 3, z: best.pos.z + Math.sin(ang) * rad }, { x: 0, y: -1, z: 0 }, 8);
      if (hit && hit.normal.y > 0.8) m.command({ type: 'debugSpawn', what: 'ant', pos: { x: hit.pos.x, y: hit.pos.y + 0.15, z: hit.pos.z } });
    }
    if (spawn) m.step(3);
    m.setCamera({ pos: [best.pos.x, best.pos.y + height, best.pos.z + height * 0.7], target: [best.pos.x, best.pos.y, best.pos.z] });
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
      return { x: ((d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / (z * t * (w / h)) * 0.5 + 0.5) * w, y: (0.5 - ((d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / (z * t)) * 0.5) * h, z };
    };
    const all = sim.ants.map((a) => ({ id: a.id, own: a.colony === sim.playerColony && open(a), ...project(a.pos) })).filter((p) => p.z > 0);
    const ants = all.filter((p) => p.own && p.x > w * 0.22 && p.x < w * 0.78 && p.y > h * 0.22 && p.y < h * 0.74).map((p) => ({ id: p.id, x: p.x, y: p.y }));
    // a free ground pixel: a real terrain point near the centre, far from every projected ant
    let ground = { x: w / 2 + 120, y: h / 2 + 40 };
    let gd = -1;
    for (let ox = -6; ox <= 6; ox += 1.5) {
      for (let oz = -5; oz <= 5; oz += 1.5) {
        const hit = sim.world.raycast({ x: best.pos.x + ox, y: best.pos.y + 3, z: best.pos.z + oz }, { x: 0, y: -1, z: 0 }, 8);
        if (!hit || hit.normal.y < 0.8) continue;
        const g = project(hit.pos);
        if (g.x < w * 0.25 || g.x > w * 0.75 || g.y < h * 0.28 || g.y > h * 0.7) continue;
        let d = 1e9;
        for (const p of all) d = Math.min(d, Math.hypot(p.x - g.x, p.y - g.y));
        if (d > gd) {
          gd = d;
          ground = { x: g.x, y: g.y };
        }
      }
    }
    return { id: best.id, ants, ground };
  }, { height, spawn });
}

/** Lets the page run a couple of animation frames (input.update runs once per frame). */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  }, n);
}
