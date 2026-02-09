#!/usr/bin/env node
/**
 * Binary search for the exact row count that triggers the nanoarrow SIGTRAP crash.
 * Spawns Electron child processes (which die on crash) and checks exit codes.
 *
 * Known: 100,000 OK, 200,000 CRASH (58 columns, mixed types)
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ELECTRON = resolve('node_modules/.bin/electron');
const TEST_SCRIPT = resolve('scripts/crash-test-single.mjs');

function testRowCount(rows) {
  try {
    execFileSync(ELECTRON, [TEST_SCRIPT, String(rows)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 120_000,
      stdio: 'pipe',
    });
    return true; // exited 0 = success
  } catch {
    return false; // crashed or non-zero exit
  }
}

let lo = 100_000; // known OK
let hi = 200_000; // known CRASH
let attempt = 0;

console.log(`Binary search for crash threshold: [${lo.toLocaleString()}, ${hi.toLocaleString()}]`);
console.log(`58 columns, mixed types, Electron ${process.versions?.electron ?? 'via wrapper'}\n`);

while (hi - lo > 1) {
  const mid = Math.floor((lo + hi) / 2);
  attempt++;
  process.stdout.write(`#${attempt}: ${mid.toLocaleString()} rows → `);

  const ok = testRowCount(mid);
  console.log(ok ? 'OK' : 'CRASH');

  if (ok) lo = mid;
  else hi = mid;
}

console.log(`\nResult after ${attempt} attempts:`);
console.log(`  Last OK:    ${lo.toLocaleString()} rows`);
console.log(`  First CRASH: ${hi.toLocaleString()} rows`);
