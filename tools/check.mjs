#!/usr/bin/env node
// Scoped gate (PLAN §10.4, D22).
//
//   npm run check                         full typecheck + all unit tests
//   npm run check -- src/sim src/world/nav
//       typecheck the WHOLE project but report only diagnostics under the given path prefixes,
//       then run only the unit tests whose path starts with one of them.
//
// Exit code is non-zero only for in-scope failures; out-of-scope type errors (other streams'
// in-flight work) are counted and printed as info.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipTests = args.includes('--no-tests');
const scopes = args
  .filter((a) => !a.startsWith('--'))
  .map((a) => path.relative(root, path.resolve(root, a)).replaceAll('\\', '/').replace(/\/+$/, ''));
const scoped = scopes.length > 0;
// prefix match, so `src/world/nav` covers nav.ts, nav.test.ts and a nav/ directory alike
const inScope = (file) => !scoped || scopes.some((s) => file.startsWith(s));
const bin = (name) => path.join(root, 'node_modules', '.bin', name);

console.log(`[check] typecheck${scoped ? ` (scope: ${scopes.join(', ')})` : ''}`);
const tsc = spawnSync(bin('tsc'), ['--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
const lines = (tsc.stdout + tsc.stderr).split('\n');
const diag = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+:/;
let inErrors = 0;
let outErrors = 0;
let showing = false;
for (const line of lines) {
  const m = diag.exec(line);
  if (m) {
    const file = m[1].replaceAll('\\', '/');
    showing = inScope(file);
    if (m[4] === 'error') showing ? inErrors++ : outErrors++;
    if (showing) console.log(line);
  } else if (line.startsWith(' ') && showing) {
    console.log(line); // continuation of an in-scope diagnostic
  } else if (line.trim() && !m) {
    // global (file-less) diagnostics, e.g. config errors: always in scope
    if (/error TS\d+/.test(line)) {
      inErrors++;
      console.log(line);
    }
    showing = false;
  }
}
console.log(`[check] type errors: ${inErrors} in scope${scoped ? `, ${outErrors} out of scope (info only)` : ''}`);

let testFailed = false;
if (!skipTests) {
  console.log(`[check] unit tests${scoped ? ` (scope: ${scopes.join(', ')})` : ''}`);
  const vt = spawnSync(bin('vitest'), ['run', '--passWithNoTests', ...scopes], { cwd: root, stdio: 'inherit' });
  testFailed = vt.status !== 0;
}

const failed = inErrors > 0 || testFailed;
console.log(`[check] ${failed ? 'FAILED' : 'ok'}${inErrors ? ` — ${inErrors} type error(s)` : ''}${testFailed ? ' — unit tests failed' : ''}`);
process.exit(failed ? 1 : 0);
