#!/usr/bin/env node
/**
 * Sidekick smoke runner.
 *
 * Discovers every `scripts/smoke/*.mjs` (except `lib.mjs`), runs each
 * scenario in sequence in its own fresh Chromium context, and prints
 * a one-line-per-scenario result table at the end.
 *
 * Usage:
 *   node scripts/run-smoke.mjs              # run all
 *   node scripts/run-smoke.mjs text-turn    # filter by name
 *   node scripts/run-smoke.mjs --headed     # show browsers (debug)
 *   node scripts/run-smoke.mjs --include-stubs   # run stubs (always FAIL)
 *
 * Exit codes:
 *   0 — all enabled scenarios passed
 *   1 — at least one scenario failed
 *
 * Scenario contract (each file in scripts/smoke/):
 *   export const NAME: string
 *   export const DESCRIPTION: string
 *   export const STATUS: 'implemented' | 'stub'
 *   export default async function run(ctx: SmokeContext): Promise<void>
 *
 * Scenarios should THROW on failure (or call ctx.fail). Returning =
 * passed. Each gets a fresh Playwright context — no state leaks.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  launchBrowser, attachConsoleCapture, dumpLines, DEFAULT_URL,
} from './smoke/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_DIR = path.join(__dirname, 'smoke');

const argv = process.argv.slice(2);
const HEADED = argv.includes('--headed');
const INCLUDE_STUBS = argv.includes('--include-stubs');
const filter = argv.filter(a => !a.startsWith('--'));

function logRunner(msg) { console.log(`[smoke] ${msg}`); }

async function loadScenarios() {
  const files = readdirSync(SMOKE_DIR)
    .filter(f => f.endsWith('.mjs') && f !== 'lib.mjs')
    .sort();
  const scenarios = [];
  for (const f of files) {
    const mod = await import(path.join(SMOKE_DIR, f));
    if (typeof mod.default !== 'function') continue;
    scenarios.push({
      file: f,
      name: mod.NAME || f.replace(/\.mjs$/, ''),
      description: mod.DESCRIPTION || '',
      status: mod.STATUS || 'unknown',
      run: mod.default,
    });
  }
  return scenarios;
}

async function runOne(scenario) {
  const start = Date.now();
  const { ctx, page, cleanup } = await launchBrowser({ headed: HEADED });
  const getConsole = attachConsoleCapture(page);
  const log = (msg) => console.log(`  [${scenario.name}] ${msg}`);
  let failMessage = null;
  const fail = (msg) => { failMessage = msg; throw new Error(msg); };

  try {
    await scenario.run({ page, log, fail, url: DEFAULT_URL, ctx });
    return { status: 'pass', durationMs: Date.now() - start };
  } catch (e) {
    const tail = getConsole(30).map(l => `      ${l}`).join('\n');
    let lineDump = '';
    try { lineDump = await dumpLines(page, 15); } catch {}
    return {
      status: 'fail',
      durationMs: Date.now() - start,
      error: failMessage || e.message,
      stack: e.stack,
      consoleTail: tail,
      lineDump,
    };
  } finally {
    await cleanup();
  }
}

async function main() {
  const scenarios = await loadScenarios();
  let runnable = scenarios.filter(s => INCLUDE_STUBS || s.status === 'implemented');
  if (filter.length > 0) {
    runnable = runnable.filter(s => filter.some(f => s.name.includes(f)));
  }
  const skipped = scenarios.filter(s => !runnable.includes(s));

  if (runnable.length === 0) {
    logRunner('no scenarios matched');
    process.exit(0);
  }

  logRunner(`running ${runnable.length} scenario(s) against ${DEFAULT_URL}${HEADED ? ' (headed)' : ''}`);
  console.log('');

  const results = [];
  for (const s of runnable) {
    process.stdout.write(`▸ ${s.name.padEnd(28)} `);
    const r = await runOne(s);
    if (r.status === 'pass') {
      console.log(`PASS  (${r.durationMs} ms)`);
    } else {
      console.log(`FAIL  (${r.durationMs} ms)`);
      console.log(`    ${r.error}`);
      if (r.lineDump) console.log(`    -- DOM .line dump --\n${r.lineDump}`);
      if (r.consoleTail) console.log(`    -- last 30 console lines --\n${r.consoleTail}`);
    }
    results.push({ scenario: s, ...r });
  }

  console.log('');
  console.log('─── summary ' + '─'.repeat(50));
  for (const r of results) {
    const tag = r.status === 'pass' ? '✓' : '✗';
    const time = `${String(r.durationMs).padStart(5)} ms`;
    console.log(`  ${tag} ${r.scenario.name.padEnd(28)} ${time}  ${r.scenario.description}`);
  }
  for (const s of skipped) {
    if (s.status === 'stub') {
      console.log(`  · ${s.name.padEnd(28)}    skip   ${s.description} [stub]`);
    }
  }
  console.log('─'.repeat(60));

  const failures = results.filter(r => r.status === 'fail');
  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${results.length} FAILED`);
    process.exit(1);
  } else {
    console.log(`\nall ${results.length} passed`);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(`[smoke runner] fatal: ${e.stack || e.message}`);
  process.exit(2);
});
