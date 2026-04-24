/**
 * @fileoverview Backend dispatcher — picks a BackendAdapter based on
 * install-time config (SIDEKICK_BACKEND env var → /config → this module)
 * and re-exports its methods as the shell's single entry point.
 *
 * The shell (main.ts) never imports a specific adapter. Swap backends
 * by setting SIDEKICK_BACKEND at install time + restart.
 *
 * Defaults to 'openclaw' for backward compat with existing deployments.
 *
 * @typedef {import('./backends/types.ts').BackendAdapter} BackendAdapter
 */

import { getConfig } from './config.ts';
import { log } from './util/log.ts';

/** @type {BackendAdapter | null} */
let adapter = null;
/** @type {Promise<BackendAdapter> | null}
 *  In-flight loader promise — serves concurrent callers during the
 *  dynamic-import window so we don't print `backend: loading 'openclaw'`
 *  twice or start two import graphs. ES modules do dedupe internally,
 *  but the race produces confusing logs and redundant work. */
let loadingPromise = null;

/** Load the adapter once, based on config. Subsequent calls return the
 *  cached instance — there's only one backend per page load. */
export async function loadAdapter() {
  if (adapter) return adapter;
  if (loadingPromise) return loadingPromise;
  const cfg = getConfig();
  const name = cfg.backend || 'openclaw';
  log(`backend: loading '${name}'`);
  loadingPromise = (async () => {
    switch (name) {
      case 'openclaw': {
        const m = await import('./backends/openclaw.ts');
        adapter = m.openclawAdapter;
        break;
      }
      case 'openai-compat': {
        const m = await import('./backends/openai-compat.ts');
        adapter = m.openaiCompatAdapter;
        break;
      }
      case 'zeroclaw': {
        const m = await import('./backends/zeroclaw.ts');
        adapter = m.zeroclawAdapter;
        break;
      }
      case 'hermes': {
        const m = await import('./backends/hermes.ts');
        adapter = m.hermesAdapter;
        break;
      }
      default:
        throw new Error(`unknown backend: ${name}`);
    }
    return adapter;
  })();
  return loadingPromise;
}

// ─── Thin forwarders ────────────────────────────────────────────────────────
// Shell calls these; they forward to the active adapter. Kept as named
// exports (not `export * from`) so the shape is explicit and stable.

export async function connect(opts) {
  const a = await loadAdapter();
  return a.connect(opts);
}

export function disconnect() { return adapter?.disconnect(); }
export function reconnect() { return adapter?.reconnect?.(); }
export function isConnected() { return adapter?.isConnected() ?? false; }

/** Fire-on-send listeners — shell subscribes once (e.g. to show a "thinking"
 *  indicator the moment the user submits, independent of when the backend
 *  decides to start emitting deltas). Called before the adapter's actual
 *  sendMessage so UI updates aren't blocked by WS latency. */
const sendListeners = new Set<(text: string, opts?: any) => void>();
export function onSend(fn: (text: string, opts?: any) => void) { sendListeners.add(fn); }
export function offSend(fn: (text: string, opts?: any) => void) { sendListeners.delete(fn); }

export function sendMessage(text: string, opts?: any) {
  for (const fn of sendListeners) {
    try { fn(text, opts); } catch {}
  }
  return adapter?.sendMessage(text, opts);
}

export async function fetchHistory(limit) {
  return adapter?.fetchHistory?.(limit) ?? [];
}

/** Start a new agent session via the adapter. Openclaw sends /new over
 *  chat; openai-compat and other minimal backends may no-op. */
export function newSession() { return adapter?.newSession?.(); }

// ─── Model catalog (optional per backend) ──────────────────────────────────

export async function listModels() {
  return (await loadAdapter()).listModels?.() ?? [];
}

export async function getCurrentModel() {
  return (await loadAdapter()).getCurrentModel?.() ?? null;
}

export function setModel(ref: string) {
  return adapter?.setModel?.(ref) ?? false;
}

// ─── Capability introspection ──────────────────────────────────────────────

export function capabilities() {
  return adapter?.capabilities ?? {
    streaming: false, sessions: false, models: false,
    toolEvents: false, history: false, attachments: false,
    sessionBrowsing: false,
  };
}

export function name() { return adapter?.name || '(unloaded)'; }

// ─── Session browser (optional per backend) ────────────────────────────────

export function getCurrentSessionId() {
  return adapter?.getCurrentSessionId?.() ?? null;
}

export async function listSessions(limit) {
  return (await loadAdapter()).listSessions?.(limit) ?? [];
}

export async function resumeSession(id) {
  const a = await loadAdapter();
  if (!a.resumeSession) throw new Error(`backend ${a.name} does not support session resume`);
  return a.resumeSession(id);
}

export async function renameSession(id, title) {
  const a = await loadAdapter();
  if (!a.renameSession) throw new Error(`backend ${a.name} does not support session rename`);
  return a.renameSession(id, title);
}

export async function deleteSession(id) {
  const a = await loadAdapter();
  if (!a.deleteSession) throw new Error(`backend ${a.name} does not support session delete`);
  return a.deleteSession(id);
}
