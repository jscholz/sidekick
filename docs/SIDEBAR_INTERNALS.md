# Sidebar Session Drawer: Architecture & State Management

**Audience:** Jonathan (project lead)  
**Purpose:** Understand the session drawer's end-to-end mechanics so you can reason about timing races and multi-click behavior.  
**Status:** Pedagogical guide; not a debugging manual.

---

## 1. Layered Overview

The session drawer (sidebar) is a five-layer system that fetches, caches, renders, and syncs a list of past conversations. Data flows from the server down through IndexedDB, through the rendering pipeline, and back up when the user clicks.

```
┌────────────────────────────────────┐
│  User Click (session row)          │ ← resume(id) called
└────────────────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  sessionDrawer.ts (state machine)  │ ← optimisticActiveId, viewedSessionId
│  - resume() + resumeInFlight logic │    pending session dedup
│  - refresh() coalesce              │    fingerprint bypasses
└────────────────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  sessionCache.ts (IndexedDB)       │ ← list cache + message cache
│  - getListCache / putListCache     │    one DB, two stores
│  - getMessagesCache / putMessagesCache
└────────────────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  backend.ts (adapter dispatcher)   │ ← dynamic module load
│  - forwarder to active adapter     │    single adapter per page
└────────────────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  hermes-gateway.ts (active adapter)│ ← HTTP POST /api/sidekick/messages
│  - resumeSession(id)               │    persistent EventSource /stream
│  - listSessions(limit)             │    SSE envelopes (deltas/finals)
│  - stream attach/detach            │    session_changed notification
└────────────────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  Proxy /api/sidekick/* HTTP        │ ← chat_id routing
│  - /api/sidekick/sessions (GET)    │    message persistence
│  - /api/sidekick/messages (POST)   │    SSE stream dispatch
│  - /api/sidekick/stream (SSE)      │
└────────────────────────────────────┘
         ↓
┌────────────────────────────────────┐
│  Hermes-agent sessions/state DB    │ ← source-of-truth
│  - state.db: sessions table        │    compression-rotation
│  - sessions.json: chat_id ↔ session_id mapping
└────────────────────────────────────┘
```

### Module Roles

**sessionDrawer.ts** (870 lines, ~45-870)  
The session-list UI + state. Owns optimistic state (`optimisticActiveId`, `pendingSessions`), dedup logic (`resumeGen`, `resumeInFlight`), and coalesce timers (`refreshTimer`). Renders the `<li>` list, wires click handlers, dispatches `onResumeCb` to main.ts, and detects when the viewed chat is deleted server-side (`onSessionGoneCb`).

**sessionCache.ts** (109 lines)  
IndexedDB wrapper around two stores: `list` (server's session metadata) and `messages` (transcripts per chat). Reads are cache-first (instant paint), writes are fire-and-forget. IDB failures don't affect UI — next load just re-fetches from server.

**main.ts** (2900+ lines)  
Central shell that wires events. Owns `lastReplayFingerprint` (avoid re-render on duplicate messages), `historyLoaded` (backfill gate), and `viewedSessionForLoadEarlier` (lazy-load older messages). Routes SSE envelopes (`handleReplyDelta`, `handleReplyFinal`, `handleSessionChanged`) and calls `replaySessionMessages` to clear + paint the chat pane.

**chat.ts** (300+ lines)  
Transcript DOM. Owns the rendered bubble list and persists HTML to IDB. Calls `trackViewedSession(id)` so the snapshot (on reload) remembers which chat was last viewed.

**conversations.ts** (200+ lines)  
IDB-backed registry of chat_ids (UUIDs minted locally by the PWA). Each row IS a sidebar drawer row for hermes-gateway. Active chat_id is cached in-process on connect.

**backend.ts** (179 lines)  
Adapter dispatcher. Loads one of `{openclaw, openai-compat, zeroclaw, hermes-gateway}.ts` dynamically and re-exports its methods. Shell never imports adapters directly.

**hermes-gateway.ts** (450+ lines)  
Active adapter for the proxy's `/api/sidekick/*` surface. Owns the persistent EventSource (`/api/sidekick/stream`), reply-id mapping (`bubbleReplyIds`), health polling, and OS-lifecycle reconnect logic. Calls the shell's subscription callbacks (`onDelta`, `onFinal`, `onSessionChanged`, `onSessionStarted`) with normalized envelopes.

**Server-side sessions.ts** (235 lines)  
GET `/api/sidekick/sessions?limit=N` handler. Walks `sessions.json` for all platforms (sidekick + telegram + slack), JOINs session_ids against `state.db` for metadata, and returns the top N most-recently-active chats (sorted by `last_active_at`).

---

## 2. State Variables: The Ownership Map

Each variable preserves one invariant. Understand the WHY, not just the names.

### sessionDrawer.ts

**`cachedSessions` (line 45)**  
Last-known full session list from server (or IDB fallback). Filter operations apply to THIS, not to fresh server fetches. Enables instant client-side re-render when the user types a filter query without re-hitting the network.

- **Who writes:** `refresh()` after `backend.listSessions(50)` succeeds; `runServerFilterReconcile()` after a server filter query.
- **Who reads:** `renderListFiltered()` for display; `getSourceForChat()` for cross-platform composer read-only; `getCachedSessions()` for the cmd+K palette.
- **Invariant:** Reflects the most-recent-successful-fetch. Stale is acceptable; background refresh reconciles.

**`pendingSessions` (line 53, `new Map`)**  
Sessions announced via SSE `session-started` envelope but not yet persisted server-side. Survives across `refresh()` cycles so the row stays visible even when the user switches chats mid-flight and the next poll's `cachedSessions` overwrites the previous list.

- **Who writes:** `handleSessionAnnounced()` (from adapter's `onSessionStarted` callback); drained when the server's `listSessions` later contains the same id.
- **Who reads:** `mergePending()` (prepends them to the filtered list at render time).
- **Invariant:** IDs here are *not* in `cachedSessions` yet; merging dedupes by id. Cleared atomically when the server sees the same id.

**`viewedSessionId` (line 109)**  
The session id whose transcript is CURRENTLY RENDERED in the chat pane. Set by main.ts via `setViewed(id)` on three paths: `replaySessionMessages`, new-chat, and boot (from saved snapshot).

- **Who writes:** `setViewed()` in main.ts (called from `replaySessionMessages`, chat.clear, boot flow).
- **Who reads:** `getViewed()` — used by `handleReplyDelta/Final` to gate incoming SSE (drop envelopes for off-screen chats), and by `refresh()` to calculate the active-row highlight.
- **Invariant:** Must stay populated whenever there's a chat on screen, even one that's not yet persisted (so incoming deltas don't drop). Load-bearing for SSE render gates: if `getViewed() !== envelope.conversation`, skip the render.

**`optimisticActiveId` (line 93)**  
Override for the drawer's active-row highlight. Set at click-time BEFORE the async resume pipeline. Cleared after resume settles.

- **Who writes:** `resume()` sets it immediately to the clicked id; cleared when `resume()` promise settles (line 672) or fails (line 659).
- **Who reads:** `refresh()` uses it as the second priority (line 171: `viewedSessionId || optimisticActiveId || backend.getCurrentSessionId()`).
- **Invariant:** If set, it means a click is in flight and we want to highlight that row NOW even though the server hasn't updated yet. Prevents stale-id flicker on cache misses (which can take 5-10s).

**`resumeGen` (line 594) and `resumeInFlight` (line 601)**  
Dedup + supersede machinery for rapid clicks on the same or different rows.

- **Who writes:** `resume()` increments `resumeGen` once per call (line 607); stores `{id, gen, promise}` in `resumeInFlight` (line 664); clears on settle (line 669).
- **Who reads:** Inside `resume()`, both the cache-cb (line 621) and server-cb (line 638) guard with `if (myGen === resumeGen)` before calling `onResumeCb`. Same inside `resume()`'s finally block (lines 669, 672).
- **Invariant:** Generations are id-independent. The sequence A → B → A would break an `optimisticActiveId === id` check (A1 sees opt=A again after A2 set it, mistakes itself for the live call); generation sidesteps this. A promise can bail if a newer click (higher gen) has happened, ensuring only the LATEST click's data renders.

**`lastRenderFingerprint` (line 324) and `renderListFingerprint()` (line 331)**  
Sha256-like hash of the visible state. If the (sessions × activeId × placeholder) tuple is unchanged, `renderList()` skips the `innerHTML = '' + appendChild` rebuild.

- **Who writes:** `renderList()` updates it after every successful rebuild (line 364).
- **Who reads:** `renderList()` checks it first thing (line 352); if unchanged, early-return.
- **Invariant:** Kills redundant DOM mutations when the server fetch returns the same list we just painted from cache. For a click sequence: cache-cb → renderList (paints) → server-cb → renderList (same data, fingerprint matches, no-op). Cuts ~half the drawer mutations under normal use.

**`refreshTimer` (line 141) and `refreshInFlight` (line 142)**  
Trailing-edge coalesce window for `refresh()`. Multiple call sites can fire refresh within 50ms; without coalescing, the drawer rebuilds `<ul>` N times per click and flickers visibly.

- **Who writes:** `scheduleRefresh()` arms `refreshTimer` (line 146); `refresh()` sets `refreshInFlight` true, clears it after promise settles (line 157).
- **Who reads:** `scheduleRefresh()` checks both to decide whether to actually run (line 145: `if (refreshTimer) return`) and whether to re-queue (line 148: `if (refreshInFlight) { scheduleRefresh(); return; }`).
- **Invariant:** Use `scheduleRefresh()` from internal call sites (resume callbacks, SSE handlers). Use `refresh()` directly for user-initiated paths (delete, rename, filter-clear, expand) where instant feedback matters. The coalesce is transparent — callers don't think about it.

### main.ts

**`lastReplayFingerprint` (line 2410)**  
Hash of (id, messages.length, first.id, last.id). If unchanged from the previous `replaySessionMessages` call, skip the chat.clear() + N renderHistoryMessage rebuild.

- **Who writes:** `replaySessionMessages()` computes + stores it (line 2433).
- **Who reads:** Checked at the top (line 2430) before any side effects.
- **Invariant:** Catches "click same chat 5x in rapid succession" + "cache-cb result matches server-cb result" without dropping legitimate updates. Any change to id, message count, or boundary message ids invalidates it.

**`historyLoaded` (line 2524)**  
Boolean: we've populated the chat history (either via `replaySessionMessages` or lazy-load backfill). Gates the backfill attempt so we don't request older messages for a chat that's fresh in the session.

- **Who writes:** Set true by `replaySessionMessages()` (line 2438) and `loadEarlierHistory()` after the first page lands (line 2538); set false on new-session (line 1062, 1252).
- **Who reads:** `loadEarlierHistory()` checks it (line 2535) to bail if already loaded.
- **Invariant:** Idempotent flag. Prevents duplicate backfill requests.

**`viewedSessionForLoadEarlier` (line 2498)**  
The chat_id the "Load earlier messages" scroll-top listener should request older messages for. Updated by `replaySessionMessages` (line 2461).

- **Who writes:** `replaySessionMessages()` (line 2461) when switching chats.
- **Who reads:** `loadEarlierHistory()` (line 2501) as the target session_id for the request.
- **Invariant:** Stays synced with the current chat. Prevents load-earlier from fetching into the wrong chat if the user switches sessions mid-scroll.

### conversations.ts

**Active chat_id** (line 49, `activeChatId` in hermes-gateway.ts)  
The in-process memoization of the current conversation. Hydrated on connect from IDB; updated by resume/newSession/first-message paths.

- **Who writes:** Adapter's `setCurrentSessionId()` (or in hermes-gateway, updates in-process `activeChatId`).
- **Who reads:** Adapter's `getCurrentSessionId()` (returns memoized value).
- **Invariant:** Fresh per page load. Enables `refresh()` to calculate the fallback active-row when both `viewedSessionId` and `optimisticActiveId` are null.

### sessionCache.ts (IndexedDB)

**List cache:** `{key: 'current', sessions: [...], updatedAt: timestamp}`  
Keyed by the literal string `'current'` in the `'list'` store. Single record that's atomically replaced on each successful `listSessions` call.

- **Reads are cache-first** in `refresh()` (line 174) for instant paint; background fetch (line 184) reconciles.
- **Stale is fine** — next refresh catches up.

**Messages cache:** `{id: '<chat_id>', messages: [...], updatedAt: timestamp}`  
One record per chat_id in the `'messages'` store. Updated after each `resumeSession` call.

- **Used by `resume()`** (line 614) to replay cached transcript before server fetch.
- **Cleared by delete** (sessionDrawer line 571: `removeMessagesCache(s.id)`).

---

## 3. Click → Render Pipeline

What happens when the user clicks a session row. Every step.

```
1. User clicks <li data-chat-id="abc123">
   ↓
2. body.onclick handler fires (sessionDrawer.ts:431)
   → optimistic visual feedback: li.classList.add('active')
   → resume(s.id) called with id='abc123'
   ↓
3. resume(s.id) runs (sessionDrawer.ts:603)
   → resumeGen++  (now gen=5, say)
   → optimisticActiveId = 'abc123'
   → const myGen = 5
   → scheduleRefresh() queued (line 624)
   ↓
4.a CACHE PATH (lines 614-627)
    → cached = await sessionCache.getMessagesCache('abc123')
    → if (cached?.messages?.length && myGen === resumeGen)
        • log '(N messages from cache)'
        • onResumeCb?.('abc123', cached.messages)
        • scheduleRefresh()
    ↓
4.b SERVER PATH (lines 631-651, always runs)
    → result = await backend.resumeSession('abc123')
    → await sessionCache.putMessagesCache('abc123', result.messages)
    → if (myGen !== resumeGen) return  ← newer click happened; bail
    → cache-match short-circuit (line 648)
    → onResumeCb?.('abc123', server_messages)
    → scheduleRefresh()
    ↓
5. onResumeCb = replaySessionMessages (wired at sessionDrawer.init, line 318)
   main.ts:2419
   → fingerprint = replayFingerprint(id, messages)
   → if (getViewed() === id && fingerprint === lastReplayFingerprint)
        return  ← already on screen with same messages; no-op
   → chat.clear()
   → for each message: renderHistoryMessage(m)
   → sessionDrawer.setViewed('abc123')  ← tell drawer this is now on screen
   → scheduleRefresh()  ← drawer refresh queued
   ↓
6. All scheduleRefresh() calls coalesce (50ms trailing edge)
   → refresh() fires once
   → active = getViewed() || optimisticActiveId || backend.getCurrentSessionId()
   → active = 'abc123'  (viewedSessionId is set now)
   → renderListFiltered(listEl, 'abc123')
   → compares fingerprint; if same as last render, no-op
   → else rebuilds <ul>: traverses cachedSessions, marks active row
   ↓
7. finally block of resume() (line 665)
   → if (resumeInFlight?.gen === myGen) resumeInFlight = null
   → if (myGen === resumeGen && optimisticActiveId === 'abc123')
        optimisticActiveId = null
   ↓
8. DONE. Chat pane shows messages, drawer row is active.
```

### Key Synchronous vs. Async Boundaries

- **Synchronous:** The `li.onclick` handler (line 431) flips the class immediately. This is the *perceived* responsiveness. `resume()` is called but doesn't await.
- **Async starts immediately:** `sessionCache.getMessagesCache()` (cache read), then `backend.resumeSession()` (server request).
- **Coalesced paint:** All `scheduleRefresh()` calls within 50ms collapse to one `refresh()` at the trailing edge. Multiple sources (cache-cb, server-cb, replaySessionMessages) don't trigger N repaints.
- **Fingerprint bypass:** If the data hasn't *meaningfully* changed, the DOM rebuild is skipped entirely.

---

## 4. The Refresh Pipeline

Who calls `refresh()` and what it does internally.

### Call Sites

1. **User-initiated (synchronous):**
   - Sidebar expand: `applyCapabilities()` (line 840)
   - Delete session: `promptDelete()` (line 577)
   - Rename session: `promptRename()` (line 553)
   - Filter changed: `refreshAfterFilterChange()` (line 825)
   - Boot: `boot()` in main.ts calls it indirectly

2. **Background (via `scheduleRefresh()`):**
   - Resume cache-cb: `onResumeCb` fires refresh (line 624)
   - Resume server-cb: `onResumeCb` fires refresh (line 651)
   - Replay: `replaySessionMessages()` calls `scheduleRefresh()` (line 2456)
   - SSE `reply_final`: `handleReplyFinal()` calls `scheduleRefresh()` (line 2818)
   - New session: `newSession()` in main.ts calls refresh indirectly
   - Poll tick: `pollTick()` (line 869) calls refresh every 5s

### Inside `refresh()` (line 161)

```typescript
export async function refresh() {
  const listEl = document.getElementById('sessions-list');
  if (!listEl) return;
  if (!backend.capabilities().sessionBrowsing) { listEl.innerHTML = ''; return; }
  ensureFilterInput();  // idempotent mount
  
  const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
  
  // 1. CACHE PAINT (instant, <100ms)
  const cached = await sessionCache.getListCache();
  if (cached?.sessions?.length) {
    cachedSessions = cached.sessions;
    renderListFiltered(listEl, active);
    // fingerprint check inside renderList() — if unchanged, no-op
  } else {
    listEl.innerHTML = '<li class="sess-empty">Loading…</li>';
  }
  
  // 2. SERVER FETCH (background, 5-10s)
  try {
    const sessions = await backend.listSessions(50);
    await sessionCache.putListCache(sessions);
    cachedSessions = sessions;
    
    // Drain pending sessions (SSE-announced rows that server now knows about)
    if (pendingSessions.size) {
      for (const id of Array.from(pendingSessions.keys())) {
        if (sessions.some(s => s.id === id)) pendingSessions.delete(id);
      }
    }
    
    renderListFiltered(listEl, active);  // might be no-op if fingerprint unchanged
    
    // STALE-FOREGROUND GUARD: viewed session disappeared server-side?
    if (viewedSessionId && !sessions.some(s => s.id === viewedSessionId)) {
      if (lastSeenIds.has(viewedSessionId)) {
        // Was here, now gone → deleted. Clear the chat pane.
        viewedSessionId = null;
        onSessionGoneCb?.();
      }
    }
    for (const s of sessions) lastSeenIds.add(s.id);
  } catch (e) {
    // Server error. Keep showing cached list if available.
    if (!cached?.sessions?.length) {
      listEl.innerHTML = `<li class="sess-empty">Failed to load: ${e.message}</li>`;
    }
  }
}
```

### `renderListFiltered()` (line 293)

Applies the current filter to the merged (pending + cached) list, then calls `renderList()`.

```typescript
function renderListFiltered(listEl: HTMLElement, activeId: string) {
  const merged = mergePending(cachedSessions);
  const filtered = currentFilter
    ? applyFilter(merged, parseQuery(currentFilter))
    : merged;
  
  // Show "No matches" vs. "No past sessions" to distinguish filter vs. empty.
  if (filtered.length === 0 && currentFilter && merged.length > 0) {
    listEl.innerHTML = '<li class="sess-empty">No matches.</li>';
    return;
  }
  
  // Optimistic placeholder: if activeId is fresh (not in merged list yet),
  // show "New conversation" so the user has immediate visual feedback.
  const isFresh = !!activeId && !merged.some(s => s.id === activeId);
  renderList(listEl, filtered, activeId, isFresh);
}
```

### `renderList()` (line 338)

The actual DOM builder. Fingerprint check happens here.

```typescript
function renderList(listEl: HTMLElement, sessions: any[], activeId: string, isFresh = false) {
  const showPlaceholder = isFresh;
  
  // DIFF BYPASS: if nothing visible has changed, skip the rebuild
  const fingerprint = renderListFingerprint(sessions, activeId, showPlaceholder);
  if (fingerprint === lastRenderFingerprint) return;  // ← NO DOM MUTATION
  
  if (sessions.length === 0 && !showPlaceholder) {
    listEl.innerHTML = '<li class="sess-empty">No past sessions yet.</li>';
    lastRenderFingerprint = fingerprint;
    return;
  }
  
  listEl.innerHTML = '';  // ← CLEAR
  if (showPlaceholder) listEl.appendChild(renderPlaceholderRow(activeId));
  for (const s of sessions) {
    listEl.appendChild(renderRow(s, activeId));
  }
  lastRenderFingerprint = fingerprint;  // REMEMBER THIS STATE
}
```

**Fingerprint** (line 331) includes:
- `activeId` (which row is active)
- `showPlaceholder` (is there a "New conversation" row?)
- All fields from each session: `id`, `title`, `snippet`, `messageCount`, `lastMessageAt`, `source`

Any change invalidates it; the rebuild runs on the next `renderList()` call.

---

## 5. Async Sources of State Change

These can interleave with clicks and cause races:

### 5s Polling (line 862-874)

`setInterval(pollTick, POLL_INTERVAL_MS)` where `POLL_INTERVAL_MS = 5000`.

- **Fires:** Every 5s while the tab is visible.
- **Does:** Calls `refresh()`, which background-fetches `listSessions`.
- **Touches:** `cachedSessions`, `pendingSessions`, `lastSeenIds`.
- **Race:** Can overlap with a user click's server fetch. If the poll's fetch is slower, it might paint stale data over fresh user action. Mitigated by: fingerprint bypass (if the lists match, no-op), and `viewedSessionId` + `optimisticActiveId` staying in sync.

### Visibility Change (main.ts, not fully shown here)

Document visibility changes trigger `forceReconnect()` in the hermes-gateway adapter.

- **Fires:** When the PWA foregrounds (visibility → visible).
- **Does:** Tears down + rebuilds the SSE stream, and coalesces reconciliation of the active chat_id.
- **Touches:** Stream state, health polling.
- **Race:** None directly on the drawer, but the new stream might bring in delayed SSE events from the time the PWA was backgrounded.

### SSE Envelopes Arriving

`reply_delta`, `reply_final`, `session_changed`, `session_started` envelopes from the persistent EventSource (`/api/sidekick/stream`).

- **`reply_delta`** (main.ts:2789): Streams one bubble's cumulative text. Calls `showStreamingIndicator()`. Gated on `getViewed() === envelope.conversation`.
- **`reply_final`** (main.ts:2807): Marks the bubble done. Calls `scheduleRefresh()` (drawer refresh, always) and `handleReplyFinal()` (render to chat if on-screen). Gated on `getViewed()`.
- **`session_changed`** (SSE handler in hermes-gateway.ts): Title/metadata updated server-side. Triggers drawer refresh (via `onSessionChanged` callback).
- **`session_started`** (hermes-gateway.ts SSE handler): New chat just started. Calls `handleSessionAnnounced()` (line 792) which populates `pendingSessions` and triggers `renderListFiltered()`.
- **Touches:** Chat DOM, drawer list, streaming state, pending map.
- **Races:** Heavy. A `reply_final` can land while `refresh()` is mid-fetch. The `scheduleRefresh()` coalesce means the two updates collapse to one render at the trailing edge. The `viewedSessionId` gate means off-screen activity doesn't corrupt on-screen chat.

### Session Poll Heartbeat (backends/hermes/plugin, not in this repo)

The backends/hermes/plugin emits a `session_changed` envelope every 1.5s while a session is active.

- **Fires:** Every 1.5s per active session.
- **Does:** Signals to `onSessionChanged()` → `scheduleRefresh()`.
- **Touches:** `cachedSessions`, drawer re-render.
- **Race:** Can fire while a user click's resume is in flight. The coalesce + fingerprint bypass means redundant renders are skipped.

### Stream Reconnect After Disconnect

Mobile Safari backgrounding, cellular handoff, OS network suspension all kill the EventSource.

- **Fires:** On `visibilitychange`, `online`, `pageshow` events.
- **Does:** `forceReconnect()` in hermes-gateway.ts (line ~70) recreates the EventSource.
- **Touches:** Stream state, health polling.
- **Race:** The new stream resumes from `Last-Event-ID` (if the server supports it) to avoid missing events. Existing chat/drawer state is preserved; new envelopes flow in over the fresh connection.

### New Chat Creation (main.ts, lazy flow)

User clicks "New Chat" or sends a message on a fresh install.

- **Fires:** On click or first message.
- **Does:** `conversations.create()` mints a UUID, stores it in conversations.ts IDB, calls `backend.newSession()` (adapter-specific), updates `activeChatId`.
- **Touches:** `conversations` IDB store, adapter state, drawer (via `handleSessionAnnounced()` when the first message fires `session_started` SSE).
- **Race:** Multiple "New Chat" clicks can fire before the first SSE. Handled by: each click increments `resumeGen`, so only the latest click's messages render.

---

## 6. Optimistic vs. Authoritative State

The tension: async resume can take 5-10s on a cache miss, but users expect instant feedback.

### The Priority Chain (line 171)

```typescript
const active = viewedSessionId || optimisticActiveId || backend.getCurrentSessionId?.() || '';
```

1. **`viewedSessionId`** (highest priority)  
   What's ACTUALLY on screen in the chat pane right now. Set by `replaySessionMessages()` after messages land. This is ground truth — the drawer should highlight the row the user is actually reading, regardless of what the adapter thinks its send-target is (they can diverge after a resume where the adapter's token got superseded).

2. **`optimisticActiveId`** (medium priority)  
   Set at click-time, cleared after resume settles. Covers the window between click and `replaySessionMessages()` (which can be 100ms to 10s+). Prevents stale-highlight flicker on cache misses.

3. **`backend.getCurrentSessionId()`** (lowest priority)  
   Adapter's memoized active session. Fresh per page load. Fallback when no user action is in flight and nothing's on screen yet (e.g., boot before snapshot restore).

4. **Empty string** (final fallback)  
   No active row; drawer shows no highlight.

### Timing Window

```
T=0     User clicks "Chat B"
T=0+    li.onclick: optimisticActiveId = 'B', scheduleRefresh()
T=0+50  refresh() fires, paints active='B' (from optimisticActiveId)
T=100   replaySessionMessages('B', messages) calls setViewed('B')
T=100+  next refresh() paints active='B' (now from viewedSessionId)
T=5000  (if cache miss) server-cb fires, re-confirms messages
        replaySessionMessages() already painted, fingerprint matches, no-op
        resume() finally block clears optimisticActiveId
```

Within this window, the three sources ensure the highlight **never** goes stale:
- *T=0 to T=100:* optimisticActiveId covers the click-to-render gap.
- *T=100+:* viewedSessionId takes over as the authoritative source (chat pane is live).
- *After resume settles:* optimisticActiveId clears, leaving viewedSessionId alone.

If the user clicks again before the first settle, `resumeGen++` supersedes the first call's promises, so stale data can't render.

---

## 7. Recent Fixes: Commits 77e25c3, de07931, 799a2ba, fb52f91

**77e25c3: test(smoke) — drawer-rapid-switch + drawer-no-flicker scenarios**  
Added two new smoke tests to catch the two bugs:
- `drawer-rapid-switch.mjs`: 12 clicks across 8 chats at 75ms intervals, with 200ms throttling on the server fetch. Asserts the final transcript ↔ drawer match 1:1 per step (no "showing chat A but drawer says B" mismatches).
- `drawer-no-flicker.mjs`: DOM-mutation counter. Baseline: ~220 list mutations per 5 distinct clicks (flicker visible). Phase 2 tests the fix.

**de07931: fix(sessionDrawer) — generation counter for resume() race**  
Replaced `optimisticActiveId === id` dedup check with `resumeGen` counter. The old check failed on A → B → A click sequences: A1's promise would see opt=A again (because A2 had set it), mistake itself for the live call, and render stale data. Generation is id-independent; a stale promise bails if a newer click has incremented the counter.

**799a2ba: fix(sessionDrawer) — coalesce refresh + diff-bypass on no-op renders**  
Three-layer optimization:
1. `scheduleRefresh()` — trailing 50ms coalesce. Multiple call sites (cache-cb, server-cb, replaySessionMessages, SSE handlers) used to fire refresh() independently, rebuilding the `<ul>` N times per click. Coalesce reduces to one trailing render.
2. `renderList` fingerprint bypass — skip rebuild when (sessions × activeId × placeholder) tuple is unchanged. Kills the cache-then-server double-render in `refresh()`.
3. `replaySessionMessages` fingerprint bypass — skip chat.clear() + N renderHistoryMessage when the same id is already on-screen with the same message tuple. Catches repeated clicks on the same chat and cache-cb / server-cb redundant replays.

Result: drawer-no-flicker phase 1 went from ~220 list mutations to ~50 (4.4x reduction).

**fb52f91: chore(smoke) — drop drawer-switch punt on rapid-fire race**  
Removed a "KNOWN LIMITATION" comment block in `drawer-switch.mjs` that punted on rapid-fire clicks. Now that `drawer-rapid-switch.mjs` covers that case (and passes), the note is obsolete.

---

## 8. DOM Contract

### Elements and Classes

**`#sessions-list`** — The `<ul>` containing session rows.  
- Rebuilt entirely by `renderList()` on state change (or no-op if fingerprint matches).
- Mutations: `innerHTML = ''` + N `appendChild(renderRow())` calls.

**`<li data-chat-id="...">` rows**  
- Created by `renderRow(s, activeId)` (line 391).
- **`li.active`** class — set when `s.id === activeId` (line 393).
- **`data-chat-id` attribute** — exposes the session/chat id so tests + future code can target rows by id, not text content (which may be a placeholder until the server generates a title).
- Click handler: `body.onclick = () => resume(s.id)` (line 431).

**Placeholder row** — `<li class="active">` with `.sess-snippet` text "New conversation" (italicized).  
- Created by `renderPlaceholderRow(id)` (line 367).
- No click handler (already active).
- Replaced by the real row on the next `refresh()` after the first message persists.

**Sub-elements per row:**
- `.sess-row` — wrapper
- `.sess-body` — text container
  - `.sess-snippet` — title or auto-derived snippet
  - `.sess-meta` — `(relative time, message count, [source badge])`
- `.sess-menu-btn` — ⋮ menu button (line 447)

### CSS Classes Doing Visible Work

- **`li.active`** — Border highlight or background color. Must be fast to update (used on every click's optimistic flip).
- **`.sess-empty`** — Placeholder `<li>` for "No past sessions yet" or "No matches."
- **`.line.streaming`** — Chat bubble in-flight (main.ts, not drawer-related).
- **`.line.pending`** — Optimistic bubble awaiting ack (Q1 feature).
- **`.line.failed`** — Send failed (Q1 feature).

### What Invalidates DOM Identity

**Full rebuilds (innerHTML = ''):**
- Any fingerprint mismatch in `renderList()`.
- Any filter change in `runServerFilterReconcile()`.
- Sidebar expand / collapse.
- Delete / rename operations (refresh).

**In-place updates:**
- Coalesce prevents most in-place updates; the `scheduleRefresh()` window means nearby mutations batch into one rebuild.

**Between-click state:**
- The `li.onclick` handler (line 431) modifies the class synchronously before awaiting `resume()`. The optimistic class flip is fast; the async pipeline reconciles later.

---

## 9. Multi-Click-Doesn't-Switch: Failure Mode Categories

This is NOT a bug report—just the architectural surface where races can manifest. Given the system you've read above, here are the fault-trees:

### Category 1: Resume Bailing Out

**Guard: `if (myGen !== resumeGen)`** (lines 621, 638, 658, 672)  
A newer click incremented `resumeGen`. The stale promise bails before calling `onResumeCb` → chat never replays → user sees old messages with new drawer highlight.

*Perception:* "I clicked B but the chat still shows A; clicking again fixed it."

**Guard: `if (cacheRendered && cached.messages.length === messages.length)`** (line 648)  
Cache-cb already rendered the same N messages. Server-cb would re-render a stale snapshot if it ran → chat flickers blank. The check blocks it.

*Perception:* "Messages briefly vanished on double-tap."

### Category 2: Click Event Eating

**No `preventDefault` in our code**, so this is hypothetical. But if an intervening handler ran `e.stopPropagation()` on the li click, the `body.onclick` (line 431) wouldn't fire → `resume()` wouldn't be called.

*Perception:* "Clicking did nothing; clicked a second time, then it worked."

### Category 3: Optimistic-Id Stranded

If a newer click's promise bailed due to `myGen !== resumeGen` (Category 1), but the finally block (line 672) was skipped somehow, `optimisticActiveId` would stay set to the old click's id, and refresh() would keep highlighting the wrong row.

*Perception:* "Clicked C, chat switched to C, but drawer kept highlighting B."

**Guard preventing this:** The finally block runs unconditionally (line 665: `try { await promise; } finally { ... }`), and the check `if (myGen === resumeGen && optimisticActiveId === id)` (line 672) ensures we only clear *our* click's override.

### Category 4: Refresh Skipping a Needed Paint

**Guard: fingerprint mismatch check** (line 352, 430)  
If the fingerprint is a false-positive (it says "no change" when something real changed), `renderList()` early-returns and the DOM doesn't update.

*Perception:* "Clicked B; drawer highlighted B, but chat still showed A's messages."

This would require the fingerprint hash to collide or be incomplete. The current implementation includes: `id`, `messages.length`, `first.id`, `last.id`, `last.content?.length`, plus all list-level fields (`sessions[*].id/title/snippet/messageCount/lastMessageAt/source`). A change to any of these invalidates it.

### Category 5: IDB Read Race

`sessionCache.getMessagesCache(id)` returns a stale record (old messages for that chat_id) while a fresh server-cb's write is in flight.

*Perception:* "Clicked B; chat briefly showed old messages from a previous session on B, then fixed itself."

**Guards:** IDB operations are sequential per database (the transaction model ensures atomicity). The bigger guard is the `lastReplayFingerprint` check — if cache and server return different message counts, the fingerprint won't match and the cache render won't short-circuit the server re-render.

### Category 6: DOM Rebuild Losing Click Target

The `li` element the user clicked is removed from the DOM between `mousedown` and `mouseup` (i.e., the list `innerHTML = ''` happens mid-click).

*Perception:* "Clicked but nothing happened; clicking again worked."

**Current code:** The `li.onclick` handler (line 431) runs synchronously, and `resume()` doesn't await before returning, so the handler stack unwinds before any async work. By the time the first `refresh()` or `renderList()` fires (50ms+ later), the user has released the button.

### Category 7: Fingerprint False-Negative (Legitimate Change Missed)

The opposite of Category 4: fingerprint says "changed" when it didn't, triggering a rebuild, which causes unnecessary flicker.

*Perception:* "Clicking the same chat twice flickers the drawer even though nothing changed."

**Mitigated by:** The fingerprint includes all renderable fields. Flicker would still be visible in mutation counters but doesn't affect correctness—just UX smoothness.

---

## 10. CSS & Styling Hooks

The drawer uses CSS custom properties and standard positioning:

- **`--primary`** — accent color for "· current" badge (line 382).
- **`.sess-snippet`** — the main title text; overflow + truncate if needed.
- **`.sess-meta`** — smaller, secondary text; may wrap on mobile.
- **`li.active`** — likely a border-left or background highlight (CSS file not included here, but assume ~3-5px border or 5-10% background tint).

Sidebar itself uses **`#sb-sessions-section`** for show/hide gating (line 836: `section.style.display = enabled ? '' : 'none'`).

---

## Summary: The Invariant

The session drawer maintains a single invariant across all its machinery:

> **At any moment, the active-row highlight in the drawer reflects either the chat currently being viewed (viewedSessionId, highest trust) or a click in flight (optimisticActiveId, medium trust) or the adapter's last-known session (fallback, lowest trust). The refresh coalesce + fingerprint bypasses ensure redundant renders are skipped, and the generation counter ensures a stale promise from a superseded click can't render out-of-order data.**

This invariant is preserved by:
1. **Priority chain** (viewedSessionId > optimisticActiveId > backend.getCurrentSessionId)
2. **Dedup + supersede** (resumeGen gates which promise can call onResumeCb)
3. **Coalesce** (multiple refresh calls collapse to one trailing render)
4. **Fingerprint bypass** (no-op render when data unchanged)
5. **Stale-foreground guard** (clear the chat if the viewed session was deleted server-side)

Breaks in this invariant manifest as the user seeing the drawer and chat pane out of sync, or flicker from redundant DOM mutations. The fixes (77e25c3—fb52f91) addressed both the correctness path (generation counter) and the UX path (coalesce + fingerprint).
