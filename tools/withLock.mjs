#!/usr/bin/env node
// Runs a command while holding the exclusive browser lock (D22), so concurrent agents never
// drive headless Chromium / the GPU at the same time.
//   node tools/withLock.mjs <command> [args…]
import { spawnSync } from 'node:child_process';

export const BROWSER_LOCK = '/tmp/myrme-browser.lock';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node tools/withLock.mjs <command> [args…]');
  process.exit(2);
}
if (process.env.MYRME_LOCKED === '1') {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const r = spawnSync('flock', [BROWSER_LOCK, cmd, ...args], { stdio: 'inherit', env: { ...process.env, MYRME_LOCKED: '1' } });
if (r.error) {
  console.error(`[lock] flock failed (${r.error.message}); running without a lock`);
  const r2 = spawnSync(cmd, args, { stdio: 'inherit' });
  process.exit(r2.status ?? 1);
}
process.exit(r.status ?? 1);
