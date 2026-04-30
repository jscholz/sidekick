/**
 * @fileoverview Backend dispatcher — picks a BackendAdapter based on
 * install-time config (SIDEKICK_BACKEND env var → /config → this module)
 * and re-exports its methods as the shell's single entry point.
 *
 * Post-refactor, sidekick has a single backend: the proxy's hermes-
 * gateway (the agent contract over /api/sidekick/*). The legacy
 * openclaw / openai-compat / zeroclaw direct-PWA-to-LLM adapters were
 * removed in step 7 of the sidekick backend refactor; new
 * deployments wire any agent — hermes, stub, openclaw plugin,
 * a third-party `/v1/responses`-speaker — through the proxy by
 * setting SIDEKICK_PLATFORM_URL + SIDEKICK_PLATFORM_TOKEN.
 *
 * @typedef {import('./backends/types.ts').BackendAdapter} BackendAdapter
 */

import { log } from './util/log.ts';

/** @type {BackendAdapter | null} */
let adapter = null;
/** @type {Promise<BackendAdapter> | null}
 *  In-flight loader promise — serves concurrent callers during the
 *  dynamic-import window so we don't print `backend: loading 'X'`
 *  twice or start two import graphs. */
let loadingPromise = null;

/** Load the adapter once. Subsequent calls return the cached instance —
 *  there's only one backend per page load. */
export async function loadAdapter() {
  if (adapter) return adapter;
  if (loadingPromise) return loadingPromise;
  log("backend: loading 'proxy-client'");
  loadingPromise = (async () => {
    const m = await import('./backends/proxy-client.ts');
    adapter = m.proxyClientAdapter;
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
/** Wall-clock ms since the SSE channel last delivered an envelope.
 *  Returns 0 when no envelope has arrived yet (fresh connect, post-
 *  reset). Adapters without this method return 0 too. Used by
 *  main.ts's status-state poll to flag weak/stalled connections. */
export function msSinceLastEnvelope(): number {
  return adapter?.msSinceLastEnvelope?.() ?? 0;
}

/** Fire-on-send listeners — shell subscribes once (e.g. to show a "thinking"
 *  indicator the moment the user submits, independent of when the backend
 *  decides to start emitting deltas). Called before the adapter's actual
 *  sendMessage so UI updates aren't blocked by network latency. */
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

export async function loadEarlier(id, beforeId) {
  const a = await loadAdapter();
  if (!a.loadEarlier) return { messages: [], firstId: null, hasMore: false };
  return a.loadEarlier(id, beforeId);
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

/** Server-authoritative search forwarder. Returns `{sessions:[], hits:[]}`
 *  when the active adapter doesn't implement `search` so callers can
 *  fall back to the cached client-side filter without special-casing. */
export async function search(q, kind, opts) {
  const a = await loadAdapter();
  if (!a.search) return { sessions: [], hits: [] };
  return a.search(q, kind, opts);
}

/** Whether the active backend implements server-authoritative search.
 *  Lets call sites short-circuit to the cached client-side filter when
 *  there's no server index (avoids spinning up debounce timers and
 *  abort controllers for a no-op call). */
export function hasSearch() {
  return !!adapter?.search;
}
