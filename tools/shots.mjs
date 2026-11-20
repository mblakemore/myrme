#!/usr/bin/env node
// Deterministic screenshots (PLAN §11). Serialised across agents by an exclusive file lock.
//
//   npm run shots -- --port 5200                       the standard M0 set → shots/*.png
//   npm run shots -- --port 5204 --map meadow --pose stem --name my-stem
//   npm run shots -- --port 5205 --map gelFarm --pose '{"pos":[48,26,30],"target":[48,25,2]}' \
//                    --ticks 600 --eval "__myrme.view.pheroVision = true"
//
// Options
//   --port <n>        dev server port (started if nothing listens there; default $MYRME_PORT or 5199)
//   --map <id>        meadow | forest | desert | gelFarm | sandFarm | formicarium
//   --faction <id>    gardenAnt | fireAnt | leafcutter | termite
//   --quality <q>     low | medium | high | ultra            (default high)
//   --ticks <n>       sim ticks to run before capture         (default 300)
//   --pose <p>        named pose from map.shotPoses, or a JSON CameraPose
//   --size WxH        viewport                                (default 960x540)
//   --out <dir>       output directory                        (default shots)
//   --name <file>     output name without extension           (default <map>-<pose>)
//   --eval "<js>"     run in the page after stepping, before capture (may be async / use await)
//   --fixture <f>     wander | none                           (default wander)
//   --url "<k=v&…>"   extra URL parameters (e.g. "difficulty=normal")
//   --ants <n>, --seed <n>, --hud (keep the HUD visible), --set <name> (named set, default m0)
//
// Each shot: load the game with URL params → wait for window.__myrme.ready → freezeTime(true) →
// step(ticks) → eval → setCamera(pose) → renderNow() → PNG. Console errors fail the run.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = '/tmp/myrme-browser.lock';

// ---- take the browser lock by re-executing under flock --------------------------------------
if (process.env.MYRME_LOCKED !== '1') {
  const r = spawnSync('flock', [LOCK, process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, MYRME_LOCKED: '1' },
  });
  if (!r.error) process.exit(r.status ?? 1);
  console.error(`[shots] flock unavailable (${r.error.message}); continuing without a lock`);
}

// ---- args --------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[key] = true;
  else {
    opt[key] = next;
    i++;
  }
}
const port = Number(opt.port ?? process.env.MYRME_PORT ?? 5199);
const outDir = path.resolve(root, String(opt.out ?? 'shots'));
const [W, H] = String(opt.size ?? '960x540').split('x').map(Number);
const base = `http://127.0.0.1:${port}`;

// Finds an own-colony ant near a named pose target / the nest and possesses it (page-side helper).
const POSSESS = (where, firstPerson) => `
  const m = window.__myrme;
  const pose = m.sim.map.shotPoses[${JSON.stringify(where)}];
  const t = pose.target;
  let best = null, bd = 1e9;
  for (const a of m.sim.ants) {
    const d = Math.hypot(a.pos.x - t[0], a.pos.y - t[1], a.pos.z - t[2]);
    if (d < bd) { bd = d; best = a; }
  }
  m.possess(best.id);
  m.step(2);
  m.view.firstPerson = ${firstPerson};
  for (let i = 0; i < 24; i++) {
    m.command({ type: 'possessInput', move: { x: 0, y: 1 }, yawDelta: 0, sprint: false, actions: { bite: false, dig: false, pickup: false, trail: false, recruit: false } });
    m.step(1);
  }
  m.command({ type: 'possessInput', move: { x: 0, y: 0 }, yawDelta: 0, sprint: false, actions: { bite: false, dig: false, pickup: false, trail: false, recruit: false } });
  m.step(1);
`;

const SETS = {
  // The M0 exit-criteria set.
  m0: [
    { name: 'meadow-overview', map: 'meadow', pose: 'overview' },
    { name: 'meadow-stem', map: 'meadow', pose: 'stem' },
    { name: 'meadow-nest-cutaway', map: 'meadow', pose: 'nest' },
    { name: 'gelFarm-overview', map: 'gelFarm', pose: 'overview' },
    { name: 'gelFarm-front', map: 'gelFarm', pose: 'front' },
    { name: 'gelFarm-chamber', map: 'gelFarm', pose: 'chamber' },
    { name: 'meadow-possess-3rd', map: 'meadow', eval: POSSESS('stem', false) },
    { name: 'meadow-possess-1st', map: 'meadow', eval: POSSESS('stem', true) },
    { name: 'gelFarm-possess-3rd', map: 'gelFarm', eval: POSSESS('chamber', false) },
  ],
};

let shots;
if (opt.pose !== undefined || opt.name !== undefined || opt.eval !== undefined || (opt.map !== undefined && opt.set === undefined)) {
  const map = String(opt.map ?? 'meadow');
  let pose = opt.pose === undefined || opt.pose === true ? undefined : String(opt.pose);
  if (pose && pose.trim().startsWith('{')) pose = JSON.parse(pose);
  const poseName = typeof pose === 'string' ? pose : pose ? 'custom' : 'view';
  shots = [{ name: String(opt.name ?? `${map}-${poseName}`), map, pose, eval: typeof opt.eval === 'string' ? opt.eval : undefined }];
} else {
  const set = String(opt.set ?? 'm0');
  shots = SETS[set];
  if (!shots) {
    console.error(`[shots] unknown set "${set}" (have: ${Object.keys(SETS).join(', ')})`);
    process.exit(2);
  }
}

// ---- dev server: reuse or start -------------------------------------------------------------------
async function up() {
  try {
    const r = await fetch(base + '/', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}
let server = null;
if (!(await up())) {
  console.log(`[shots] starting vite on :${port}`);
  server = spawn(path.join(root, 'node_modules', '.bin', 'vite'), ['--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  while (!(await up())) {
    if (server.exitCode !== null || Date.now() - t0 > 60000) {
      console.error(`[shots] vite did not start on :${port}\n${log}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
} else console.log(`[shots] reusing dev server on :${port}`);

const { chromium } = await import('@playwright/test');
const { launchWithGL } = await import('./browser.mjs');

let failed = false;
let browser;
try {
  const launched = await launchWithGL(chromium, { log: (m) => console.log(m) });
  browser = launched.browser;
  fs.mkdirSync(outDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  for (const shot of shots) {
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err.stack ?? err)));
    const q = new URLSearchParams({
      map: shot.map,
      faction: String(opt.faction ?? 'gardenAnt'),
      seed: String(opt.seed ?? 1),
      quality: String(opt.quality ?? 'high'),
      fixture: String(opt.fixture ?? 'wander'),
      ants: String(opt.ants ?? 200),
      autostart: '1',
      frozen: '1', // deterministic: no real-time ticks before the scripted ones
      shot: opt.hud ? '0' : '1',
    });
    // extra URL params, e.g. --url "difficulty=normal&mode=sandbox"
    if (typeof opt.url === 'string') for (const [k, v] of new URLSearchParams(opt.url)) q.set(k, v);
    const t0 = Date.now();
    try {
      await page.goto(`${base}/?${q}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__myrme && window.__myrme.ready === true, null, { timeout: 60000 });
      const ticks = Number(shot.ticks ?? opt.ticks ?? 300);
      const stats = await page.evaluate(
        async ({ ticks, pose, code }) => {
          const m = window.__myrme;
          m.freezeTime(true);
          m.step(ticks);
          if (code) await new (Object.getPrototypeOf(async function () {}).constructor)(code)();
          if (pose) m.setCamera(pose);
          m.renderNow();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          m.renderNow();
          return m.stats();
        },
        { ticks, pose: shot.pose ?? null, code: shot.eval ?? null },
      );
      const file = path.join(outDir, `${shot.name}.png`);
      // A frame can come back all black without any error (the GPU process dropped the canvas
      // between renderNow and the capture — seen with --hud at high quality). Detect it on the
      // captured PNG itself, re-render and retry; a shot that stays black FAILS instead of being
      // written as if it were fine.
      let png = null;
      let look = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        png = await page.screenshot();
        look = await page.evaluate(async (b64) => {
          const img = new Image();
          img.src = 'data:image/png;base64,' + b64;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = 96;
          c.height = 54;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, c.width, c.height);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let max = 0;
          let lit = 0;
          const seen = new Set();
          for (let i = 0; i < d.length; i += 4) {
            const l = Math.max(d[i], d[i + 1], d[i + 2]);
            if (l > max) max = l;
            if (l > 16) lit++;
            seen.add((d[i] >> 4) | ((d[i + 1] >> 4) << 4) | ((d[i + 2] >> 4) << 8));
          }
          return { max, lit: lit / (d.length / 4), colours: seen.size };
        }, png.toString('base64'));
        // black = nothing brighter than near-black, or under 0.5 % lit pixels in a flat frame
        const black = look.max <= 16 || (look.lit < 0.005 && look.colours <= 3);
        if (!black) break;
        if (attempt === 4) {
          errors.push(`black frame after ${attempt} attempts (max ${look.max}, lit ${(look.lit * 100).toFixed(2)} %, ${look.colours} colours)`);
          break;
        }
        console.warn(`[shots] ${shot.name}: black frame (attempt ${attempt}), re-rendering`);
        await page.evaluate(async (n) => {
          const m = window.__myrme;
          for (let i = 0; i < 2 + n; i++) {
            m.renderNow();
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          }
          m.renderNow();
        }, attempt);
        await page.waitForTimeout(150 * attempt);
      }
      fs.writeFileSync(file, png);
      console.log(
        `[shots] ${path.relative(root, file)}  tick ${stats.tick}  ants ${stats.ants}  draws ${stats.drawCalls}  tris ${stats.triangles}  sim ${stats.msPerTick.toFixed(2)} ms/tick  ${Date.now() - t0} ms`,
      );
    } catch (e) {
      errors.push(`shot failed: ${String(e).split('\n')[0]}`);
    }
    if (errors.length) {
      failed = true;
      console.error(`[shots] ${shot.name}: ${errors.length} error(s)`);
      for (const e of errors.slice(0, 12)) console.error('   ' + e.split('\n').slice(0, 6).join('\n   '));
    }
    await page.close();
  }
} catch (e) {
  failed = true;
  console.error('[shots] ' + (e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(failed ? '[shots] FAILED' : `[shots] ok → ${path.relative(root, outDir)}/`);
process.exit(failed ? 1 : 0);
