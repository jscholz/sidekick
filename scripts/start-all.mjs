#!/usr/bin/env node
/**
 * Boot the sidekick proxy AND the in-tree stub agent in one command.
 *
 * Spawns two child processes:
 *   - proxy: `node --experimental-strip-types ... server.ts`
 *   - agent: `cd backends/stub && npm start` (echo LLM)
 *
 * Stdout from each is prefixed (`[proxy]` / `[agent]`) so a single
 * terminal can follow both. SIGINT (Ctrl-C) cleanly tears down both
 * children before the script exits.
 *
 * Ports + URLs
 * ────────────
 * Reads PROXY_PORT (or PORT) and AGENT_PORT from the env. Defaults:
 * 3001 / 4001. If either port is busy, the pair shifts forward
 * together (3002/4002, 3003/4003, ...) up to PORT_RETRY_MAX so the
 * proxy always knows where the agent is. Pass `SIDEKICK_PLATFORM_URL`
 * explicitly to point the proxy at an already-running agent (and set
 * `SIDEKICK_AGENT_CMD=` to skip booting the in-tree stub).
 *
 * No new dep — pure `child_process`. Used by `npm start`.
 *
 * Override the agent command with `SIDEKICK_AGENT_CMD` to swap the
 * stub for a different upstream (a different binary, a docker exec,
 * etc.). Set it to an empty string to skip starting the agent
 * entirely (useful when running against an already-running
 * backends/hermes/plugin).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const PORT_RETRY_MAX = 8;

/** Probe whether `port` is bindable on 127.0.0.1. Resolves true if
 *  free, false if EADDRINUSE. Other errors propagate. */
function portFree(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
      else reject(err);
    });
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Find the first pair (proxy, agent) that's both free, starting at
 *  the requested base. Shifts the pair forward together so the proxy
 *  → agent URL stays in sync. */
async function pickPortPair(baseProxy, baseAgent) {
  for (let i = 0; i < PORT_RETRY_MAX; i++) {
    const proxyPort = baseProxy + i;
    const agentPort = baseAgent + i;
    if (await portFree(proxyPort) && await portFree(agentPort)) {
      return { proxyPort, agentPort, shifted: i > 0 };
    }
  }
  return null;
}

const skipAgent = process.env.SIDEKICK_AGENT_CMD === '';
const agentCmd = process.env.SIDEKICK_AGENT_CMD;

const requestedProxy = Number(process.env.PROXY_PORT ?? process.env.PORT ?? 3001);
const requestedAgent = Number(process.env.AGENT_PORT ?? 4001);

let proxyPort = requestedProxy;
let agentPort = requestedAgent;

// Skip auto-shift when the user pinned an explicit upstream URL —
// they're driving the agent themselves and the proxy port is the only
// thing we need free.
const explicitUpstream = !!process.env.SIDEKICK_PLATFORM_URL;

if (skipAgent || explicitUpstream) {
  if (!(await portFree(proxyPort))) {
    console.error(`[start-all] proxy port ${proxyPort} is busy. Set PROXY_PORT to override.`);
    process.exit(1);
  }
} else {
  const pair = await pickPortPair(requestedProxy, requestedAgent);
  if (!pair) {
    console.error(
      `[start-all] couldn't find a free port pair after ${PORT_RETRY_MAX} attempts ` +
      `starting at ${requestedProxy}/${requestedAgent}. ` +
      `Free up the ports or set PROXY_PORT/AGENT_PORT explicitly.`,
    );
    process.exit(1);
  }
  proxyPort = pair.proxyPort;
  agentPort = pair.agentPort;
  if (pair.shifted) {
    process.stdout.write(
      `[start-all] ports ${requestedProxy}/${requestedAgent} busy — using ${proxyPort}/${agentPort} instead\n`,
    );
  }
}

// Proxy reads PORT for itself and SIDEKICK_PLATFORM_URL for upstream.
// We always set both so the children's own defaults can't drift.
const upstreamUrl = process.env.SIDEKICK_PLATFORM_URL ?? `http://127.0.0.1:${agentPort}`;

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

const proxy = spawnPrefixed(
  'proxy',
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server.ts'],
  { env: { PORT: String(proxyPort), SIDEKICK_PLATFORM_URL: upstreamUrl } },
);

let agent = null;
if (!skipAgent) {
  if (agentCmd) {
    // User-supplied agent command (e.g. `node my-agent.mjs`). Split on
    // whitespace; not shell-quoting-aware, but adequate for the
    // straightforward override path most callers want.
    const [bin, ...args] = agentCmd.split(/\s+/).filter(Boolean);
    agent = spawnPrefixed('agent', bin, args, {
      env: { AGENT_PORT: String(agentPort) },
    });
  } else {
    // Default: in-tree stub agent.
    agent = spawnPrefixed('agent', 'npm', ['start'], {
      cwd: path.join(REPO_ROOT, 'backends', 'stub'),
      env: { AGENT_PORT: String(agentPort) },
    });
  }
}

process.stdout.write(
  `[start-all] proxy on http://localhost:${proxyPort}` +
  (skipAgent ? ' (no in-tree agent)\n' : `, agent on http://127.0.0.1:${agentPort}\n`),
);

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
