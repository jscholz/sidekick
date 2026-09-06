// Pinned-messages store — server-driven, cross-device coherent.
//
// SSOT for pins lives in the backend plugin's `pins` table (see
// project_hermes_parley_parity.md). This module is a read-through
// cache + thin client over those routes:
//   GET    /api/parley/pins              → snapshot
//   POST   /api/parley/pins              ← {chat_id, msg_id, role, text, timestamp}
//   DELETE /api/parley/pins/{chat}/{msg}
//
// Cross-device sync rides the `pins_changed` envelope that proxyClient
// observes on /api/parley/stream — when it arrives, the base store's
// serverChangeEvent listener fires a debounced refresh.
//
// Why server-driven (mirror of badge.ts's history): IDB-side pins were
// strictly per-device — pins created on desktop were not visible on
// mobile. Server SSOT fixes this structurally.
//
// localStorage perf cache (via ServerBackedStore): pins now persist to
// localStorage so a cold relaunch rehydrates the pin drawer INSTANTLY
// instead of leaving it empty until the network /pins GET returns
// (the device-relaunch regression). The server remains SSOT — the cache
// is only a first-paint accelerator that the background refresh
// reconciles against.

import { log } from '../util/log.ts';
import { apiUrl } from '../apiBase.ts';
import { ServerBackedStore } from '../util/serverBackedStore.ts';
import { isDurableMessageKey } from '../transcript/keys.ts';

const PINS_ENDPOINT = '/api/parley/pins';

export interface PinnedItem {
  chatId: string;
  msgId: string;
  role: string;       // 'user' / 'assistant' / 'system' — drives the row glyph in the drawer
  text: string;       // body preview, truncated upstream if needed
  timestamp: number;  // message wall-clock time (for display in the drawer)
  pinnedAt: number;   // when the user pinned it (for sort order)
}

const STORAGE_KEY = 'parley.pins.items.v1'; // server-owned mirror — renamed w/o migration, rebuilds

const key = (chatId: string, msgId: string) => `${chatId}|${msgId}`;

function normalizeEpochMs(value: unknown, fallback = Date.now()): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  // Backend pin tables store timestamps as Unix seconds; older PWA-local
  // and optimistic paths use JavaScript milliseconds. Normalize at the
  // store boundary so renderers can consistently format milliseconds.
  return value < 10_000_000_000 ? value * 1000 : value;
}

function parsePin(p: any): PinnedItem | null {
  if (typeof p?.chatId !== 'string' || typeof p?.msgId !== 'string') return null;
  return {
    chatId: p.chatId,
    msgId: p.msgId,
    role: typeof p.role === 'string' ? p.role : 'user',
    text: typeof p.text === 'string' ? p.text : '',
    timestamp: normalizeEpochMs(p.timestamp),
    pinnedAt: normalizeEpochMs(p.pinnedAt),
  };
}

function notifyPinError(message: string): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('parley:pin-error', { detail: { message } }));
    }
  } catch { /* non-DOM hosts (test runner) */ }
}

const store = new ServerBackedStore<PinnedItem>({
  storageKey: STORAGE_KEY,
  endpoint: PINS_ENDPOINT,
  extract: (data) => (data?.pins ?? []),
  parse: parsePin,
  idOf: (item) => key(item.chatId, item.msgId),
  changeEvent: 'parley:pins-changed',
  serverChangeEvent: 'parley:server-pins-changed',
  // Foreground refresh — iOS PWA can come back after long background.
  refreshOnVisible: true,
  // Pin mutations are typically user-initiated singletons, not
  // cron-triggered cascades, so a shorter debounce than badge's is fine.
  debounceMs: 800,
  log: (m) => log(`[pins] ${m}`),
  // Diff only on the fields the drawer renders + sorts by; ignore
  // incidental field churn so a no-op server snapshot doesn't trigger a
  // repaint storm (mirror of badge.ts's Mac WindowServer guard).
  equal: (a, b) => {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      const o = b.get(k);
      if (!o || o.pinnedAt !== v.pinnedAt || o.text !== v.text) return false;
    }
    return true;
  },
});

/** Boot-time hydrate. Stable name kept for existing call sites. Idempotent. */
export async function hydrate(): Promise<void> {
  store.hydrate();
}

/** Add a pin. Optimistic local update for instant UI feedback (and an
 *  immediate localStorage write so a relaunch keeps it), then POST to
 *  server. The server emits `pins_changed` which triggers a background
 *  re-fetch to reconcile. */
export async function pinMessage(item: Omit<PinnedItem, 'pinnedAt'>): Promise<void> {
  if (!item.chatId || !item.msgId) return;
  // Choke point for every pin-from-a-bubble call site (chat.ts's pin
  // button, transcriptHighlight.ts's keyboard toggle). A synthetic key
  // (pending:turn:…, turn:status, …) has no server-side row — pinning
  // one persists a target that `around=<key>` (prewarmPinnedWindows,
  // src/sessionResume.ts) can never resolve. The primary chat.ts button
  // is already gated so this shouldn't fire in practice; kept as the
  // structural guarantee for every current and future caller.
  if (!isDurableMessageKey(item.msgId)) {
    log(`[pins] refusing to pin synthetic key chat=${item.chatId} msgId=${item.msgId}`);
    return;
  }
  const full: PinnedItem = { ...item, pinnedAt: Date.now() };
  store.items.set(key(item.chatId, item.msgId), full);
  store.commit();
  try {
    const r = await store.trackWrite(() => fetch(apiUrl(PINS_ENDPOINT), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: item.chatId,
        msg_id: item.msgId,
        role: item.role,
        text: item.text,
        timestamp: item.timestamp,
      }),
    }));
    if (!r.ok) {
      let detail = '';
      try { detail = await r.text(); } catch { /* ignore */ }
      log(`[pins] POST failed: HTTP ${r.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
      if (isUnsupported(r.status)) {
        // Backend without a pins endpoint (e.g. the trial stub): the pin
        // DID work — it's persisted device-locally by the optimistic
        // write above — so a red "could not pin" is a false error
        // (field bug 2026-07-07, first npx tester). Say what's actually
        // true, once per session, and stay quiet after.
        notifyLocalOnlyOnce();
      } else {
        notifyPinError(r.status === 400 && /body too large/i.test(detail)
          ? 'This message is too large to pin.'
          : 'Could not pin this message.');
      }
    }
  } catch (e: any) {
    log(`[pins] POST failed: ${e?.message ?? e}`);
    notifyPinError('Could not pin this message.');
  }
  void store.refreshFromServer();
}

/** 404/405/501 = the backend has no pins surface at all — a capability
 *  gap, not a failure. Anything else stays a real error. */
function isUnsupported(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

let localOnlyNoticeShown = false;
function notifyLocalOnlyOnce(): void {
  if (localOnlyNoticeShown) return;
  localOnlyNoticeShown = true;
  notifyPinError('Pinned on this device — this backend doesn’t sync pins across devices.');
}

/** Remove a pin. Optimistic local delete + DELETE on server. */
export async function unpinMessage(chatId: string, msgId: string): Promise<void> {
  if (!chatId || !msgId) return;
  if (!store.items.delete(key(chatId, msgId))) return;
  store.commit();
  try {
    const r = await store.trackWrite(() => fetch(
      `${apiUrl(PINS_ENDPOINT)}/${encodeURIComponent(chatId)}/${encodeURIComponent(msgId)}`,
      { method: 'DELETE' },
    ));
    if (!r.ok) {
      let detail = '';
      try { detail = await r.text(); } catch { /* ignore */ }
      log(`[pins] DELETE failed: HTTP ${r.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
      // Same capability-gap treatment as pinMessage: the local delete
      // already stuck; a pins-less backend has nothing to unpin.
      if (!isUnsupported(r.status)) notifyPinError('Could not unpin this message.');
    }
  } catch (e: any) {
    log(`[pins] DELETE failed: ${e?.message ?? e}`);
    notifyPinError('Could not unpin this message.');
  }
  void store.refreshFromServer();
}

/** Wipe every pin across every chat. No batch endpoint server-side yet;
 *  fan out one DELETE per pin. Pin counts are typically small
 *  (single-digit to dozens) so the round-trip cost is fine. */
export async function clearAllPins(): Promise<void> {
  if (store.items.size === 0) return;
  const entries = Array.from(store.items.values());
  store.items.clear();
  store.commit();
  log(`[pins] clearAllPins — ${entries.length} pin(s)`);
  await store.trackWrite(() => Promise.all(entries.map((p) =>
    fetch(`${apiUrl(PINS_ENDPOINT)}/${encodeURIComponent(p.chatId)}/${encodeURIComponent(p.msgId)}`, {
      method: 'DELETE',
    }).catch(() => {}),
  )));
  void store.refreshFromServer();
}

/** Sync pin check — drives the per-bubble + per-row UI repaint after
 *  hydrate() resolves. */
export function isPinned(chatId: string, msgId: string): boolean {
  if (!chatId || !msgId) return false;
  return store.items.has(key(chatId, msgId));
}

/** All pins across every chat, sorted newest-first by pinnedAt.
 *  Backs the right-side pin drawer. */
export function listAllPins(): PinnedItem[] {
  return Array.from(store.items.values()).sort((a, b) => b.pinnedAt - a.pinnedAt);
}

/** Synchronous count across all chats. Used by the right-drawer
 *  toggle button's banner. */
export function totalPinCount(): number {
  return store.items.size;
}

/** Pins for one chat — cheap to expose; not used by the aggregating
 *  drawer. */
export function pinsForChat(chatId: string): PinnedItem[] {
  const out: PinnedItem[] = [];
  for (const item of store.items.values()) {
    if (item.chatId === chatId) out.push(item);
  }
  return out.sort((a, b) => b.pinnedAt - a.pinnedAt);
}

// Test-only window-exposed seam — lets smokes read the in-memory pin
// state synchronously without poking at the server. Production code
// never references this.
if (typeof window !== 'undefined') {
  (window as any).__pinsDebug = {
    size: () => store.items.size,
    snapshot: () => Array.from(store.items.entries()),
    clearForTest: () => { store.items.clear(); },
  };
}
