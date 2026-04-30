#!/usr/bin/env node
/**
 * Boot the sidekick proxy AND the in-tree stub agent in one command.
 *
 * Spawns two child processes:
 *   - proxy: `node --experimental-strip-types … server.ts` (port 3001)
 *   - agent: `cd agent && npm start` (port 4001, echo LLM)
 *
 * Stdout from each is prefixed (`[proxy]` / `[agent]`) so a single
 * terminal can follow both. SIGINT (Ctrl-C) cleanly tears down both
 * children before the script exits.
 *
 * No new dep — pure `child_process`. Used by the `npm start` script
 * in package.json.
 *
 * Override the agent command with `SIDEKICK_AGENT_CMD` if you want
 * to swap the in-tree stub for a different upstream (a different
 * binary, a docker exec, etc.). Set it to an empty string to skip
 * starting the agent entirely (e.g. when running against an
 * already-running hermes-plugin).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Spawn with prefixed stdout so `[proxy]` and `[agent]` lines are
 *  distinguishable in one terminal. Inherits stderr to surface
 *  crashes loudly. */
function spawnPrefixed(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const prefix = `[${label}] `;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      process.stdout.write(prefix + buf.slice(0, idx + 1));
      buf = buf.slice(idx + 1);
      idx = buf.indexOf('\n');
    }
  });
  child.on('exit', (code, signal) => {
    if (buf.length) process.stdout.write(prefix + buf + '\n');
    process.stdout.write(prefix + `exited (code=${code}${signal ? `, signal=${signal}` : ''})\n`);
  });
  return child;
}

const skipAgent = process.env.SIDEKICK_AGENT_CMD === '';
const agentCmd = process.env.SIDEKICK_AGENT_CMD;

const proxy = spawnPrefixed(
  'proxy',
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'],
);

let agent = null;
if (!skipAgent) {
  if (agentCmd) {
    // User-supplied agent command (e.g. `node my-agent.mjs`). Split on
    // whitespace; not shell-quoting-aware, but adequate for the
    // straightforward override path most callers want.
    const [bin, ...args] = agentCmd.split(/\s+/).filter(Boolean);
    agent = spawnPrefixed('agent', bin, args);
  } else {
    // Default: in-tree stub agent.
    agent = spawnPrefixed('agent', 'npm', ['start'], {
      cwd: path.join(REPO_ROOT, 'agent'),
    });
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[start-all] received ${signal}, stopping children…\n`);
  for (const child of [proxy, agent].filter(Boolean)) {
    try { child.kill(signal); } catch {}
  }
  // Hard backstop — if a child ignores the first signal, force-kill
  // after a grace window so the parent doesn't hang.
  setTimeout(() => {
    for (const child of [proxy, agent].filter(Boolean)) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// If either child exits unexpectedly, take the other down with it —
// running half a stack just makes diagnosis harder.
proxy.on('exit', () => shutdown('SIGTERM'));
if (agent) agent.on('exit', () => shutdown('SIGTERM'));
