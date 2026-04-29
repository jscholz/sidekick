# Frontend Architecture Overview

**Audience**: anyone modifying the sidekick PWA shell (composer,
drawer, chat, voice pipeline, settings). Read before non-trivial
changes; the atomicity audit at the end is where every recent bug
class has lived.

**Last updated 2026-04-29** (after the proxy contract suite landed
and a research pass on the layer above).

---

## TL;DR

1. **Component coupling is loose but state coherence is fragile.**
   The chat, drawer, composer, and backend talk through well-named
   interfaces (`backend.sendMessage`, `sessionDrawer.setViewed`,
   `chat.addLine`), but several multi-step state transitions
   (send → user bubble → draft flush → drawer refresh) are not
   atomic — partial failures leave the UI inconsistent with the
   server.

2. **The viewed-session gate is the linchpin.**
   `sessionDrawer.getViewed()` routes inbound envelopes to the
   correct chat pane. This ID is cached in-memory and persisted
   naively. Race conditions between IDB writes, drawer clicks, and
   SSE deliveries produce the documented bugs (stale drawer
   highlight, drawer/chat content mismatch).

3. **The frontend prioritizes responsiveness over atomicity.**
   Optimistic rendering (drawer highlight flips on click before the
   session resume completes) and fire-and-forget adapter state
   updates (`conversations.updateLastMessageAt` on every envelope)
   are user-facing wins but create half-states where IDB, in-memory
   caches, and DOM diverge until the next refresh cycle heals them.

---

## Component map

| Component | Files | State owned | State read | Input events | Output events |
|-----------|-------|-------------|------------|--------------|---------------|
| **Composer** | `composer.ts` | interim text | (none) | keydown (Enter), voice `appendText()` | onChange, onSubmit callbacks |
| **Draft** | `draft.ts` | blockEl, textEl, segments[], editing flag, interim span | transcriptEl from chat | keydown (Esc, Ctrl+Enter), focus/blur, voice append() | onFlush(text), onChange, onFocus callbacks; DOM mutations |
| **Attachments** | `attachments.ts` | pending[] (file list) | settings.getCurrentModelEntry (image gate) | file picker change, remove clicks | onChange callback, chips DOM |
| **Chat window** | `chat.ts` | transcriptEl innerHTML (snapshot + live), viewedSessionIdRef, pinnedToBottom | (none) | scroll (pinned detection), copy / jump-to-bottom clicks | autoScroll(), persist() to IDB; DOM mutations |
| **Session drawer** | `sessionDrawer.ts` | cachedSessions[], pendingSessions Map, currentFilter, optimisticActiveId, viewedSessionId | backend.getCurrentSessionId, conversations (IDB), sessionCache (IDB) | row clicks, filter input, menu buttons | onResume(id, messages), onSessionGone() callbacks; refresh() re-renders from server |
| **Conversations (IDB)** | `conversations.ts` | IDB store: conversations (chat_id → record), meta (active_chat_id pointer) | (none) | create(), updateLastMessageAt(), updateTitle(), setActive() | IDB mutations; promise-based async API |
| **Backend adapter** | `backend.ts` | adapter singleton, loadingPromise | config.backend name | connect(), sendMessage() | onStatus, onDelta, onFinal, onActivity, onNotification callbacks |
| **Hermes-gateway adapter** | `backends/hermes-gateway.ts` | activeChatId (in-memory), bubbleReplyIds Map, streamES EventSource, health poll timer | conversations.getActive() on boot | connect(), sendMessage(text, opts) | subs.onStatus, onDelta, onFinal, onActivity, onNotification |
| **Settings** | `settings.ts` + `settings/mobile-bottomsheet.ts` | localStorage (JSON blob, v2 schema) | (reads on demand via `get()`) | toggle/select changes | onThemeChange, onVoiceChange, onMicChange, etc.; theme.applyTheme() |
| **Main shell** | `main.ts` | streamingEl, streamingIdleTimer, historyLoaded, viewedSessionForLoadEarlier, releaseCaptureIfActive closure | all modules | clicks, keyboard shortcuts, WS events (onDelta, onFinal, onActivity) | chat.addLine(), backend.sendMessage(), sessionDrawer.setViewed(), draft.flush() |

---

## Data-flow narrative — happy path

User types "hello" in composer → presses Enter → user bubble appears
→ SSE replies stream in → drawer title updates → user clicks another
chat → transcript flips, composer ideally clears.

### 1. Keystroke → composer input
- `main.ts` keydown listener (line 1052).
- On Enter: `sendTypedMessage()` (line 1053).

### 2. sendTypedMessage → user bubble (atomic within main.ts)
- Validate composer.value (line 989).
- `chat.addLine('You', text, 's0')` (line 1010). **DOM + IDB persist queued.**
- Clear composer (line 1030), `updateSendButtonState()` (line 1032).
- `backend.sendMessage(text, opts)` (line 1017).

**⚠ Atomicity hole**: if `sendMessage` throws, the user bubble is already in DOM
and the composer was cleared — duplicate of the message remains visible
without recovery path.

### 3. backend.sendMessage → adapter.sendMessage → POST
- `backend.ts` fires sendListeners, delegates to active adapter.
- `hermes-gateway.ts` POSTs `/api/sidekick/messages {chat_id, text}`.
- **No IDB update here** — adapter trusts the SSE stream to tell it
  what happened.

### 4. SSE → onDelta / onFinal / onActivity
- `hermes-gateway.ts` EventSource receives `reply_delta` (line 345).
- Parses chat_id + cumulative text, computes replyId (line 348).
- Calls `subs.onDelta({ replyId, cumulativeText, conversation: chatId })`.

### 5. main.ts onDelta → streaming bubble
- `handleReplyDelta(...)` (line 2497).
- **Gate check**: if `conversation !== sessionDrawer.getViewed()`, early return.
- `showStreamingIndicator(partialText, replyId)` (line 2483).
- DOM streaming bubble created.

### 6. reply_final → onFinal
- Adapter receives reply_final, calls `subs.onFinal(...)` (line 366).
- `main.ts handleReplyFinal()` upgrades bubble to finalized.
- Adapter calls `conversations.updateLastMessageAt(chatId, Date.now())`
  (line 369). **IDB write queued — fire-and-forget.**

### 7. Drawer refresh
- `sessionDrawer.refresh()` fetches from cache (line 148).
- If server hasn't updated yet, drawer renders stale until reconcile.

### 8. User clicks another chat
- Drawer row click (sessionDrawer.ts line 351).
- **Optimistic highlight applied** at line 362 (`li.classList.add('active')`).
- Calls `resume(s.id)` → main.ts `replaySessionMessages`.

**⚠ Atomicity hole**: highlight changes BEFORE resume completes. If
the resume fetch hangs or returns out of order, the drawer
highlights row B but the chat pane shows row A's bubbles.

### 9. Transcript flips
- `chat.clear()` → `sessionDrawer.setViewed(newId)` →
  render messages → `chat.forceScrollToBottom()`.

### 10. Composer clears (...not really)
- `replaySessionMessages` does NOT clear `composer.value`. The user's
  partially-typed text from the previous session persists. **Bug
  surface.**

---

## Atomicity audit — top 5 hot spots

These are the seams where every recent bug has lived. Each entry
includes a principle-level fix sketch (NOT prescriptive
implementation).

### 1. Drawer highlight ≠ chat content (session-resume race)
- **Where**: `sessionDrawer.ts:362` (synchronous DOM highlight) vs.
  `main.ts:replaySessionMessages` (async completion).
- **Half-state**: user taps row → highlight flips → fetch hangs 5s
  → drawer shows row B, chat still shows row A's bubbles.
- **Root**: highlight is sync; fetch is async. No generation counter
  pairing the two.
- **Fix principle**: pair every async resume with a generation token.
  Bump on each click. If a fetch returns with a stale token, drop.
  Highlight only after the matching token's fetch completes (OR
  apply optimistic highlight but keep an `optimisticGen` separate
  from `committedGen` and gate render on the latter).

### 2. Viewed-session gate drops envelopes (cache-first + SSE timing)
- **Where**: `main.ts:handleReplyDelta` line 2459 (viewed gate).
- **Half-state**: user clicks row #2 → cache-first render (cached
  list is stale) → drawer paints empty → server fetch reconciles 5s
  later → SSE reply_delta for #2 already arrived during the 2s
  window where `getViewed()` was null. Envelope dropped, never
  rendered. (The "three replies in active chat" bug class.)
- **Root**: `setViewed(id)` called AFTER cache render, not atomically
  before it.
- **Fix principle**: set the viewed-id atomically WITH the render
  call. Or buffer inbound envelopes for ~100ms during a known
  render cycle and replay against the new gate.

### 3. `conversations.updateLastMessageAt` fire-and-forget (IDB-write half-state)
- **Where**: `hermes-gateway.ts:369` + drawer sort (reads IDB
  last_message_at).
- **Half-state**: reply arrives → adapter queues IDB write → drawer
  renders before write completes. Sort order is stale; user's active
  session sinks to the bottom of the list briefly.
- **Root**: fire-and-forget IDB writes raced by render-blocking
  drawer code paths.
- **Fix principle**: maintain an in-memory mirror of last_message_at
  that updates synchronously. Drawer sort uses the mirror; IDB write
  is a background commit. On IDB error, mirror stays correct (it
  never depended on success).

### 4. New-chat doesn't atomically clear all input surfaces
- **Where**: `main.ts:newChat` (line 1132) calls `draft.dismiss()`
  but NOT `composer.value = ''`.
- **Half-state**: user types "hello" → clicks new chat → chat
  clears, draft dismisses, but composer still has "hello". Click
  new-chat again → type "world" → see "helloworld".
- **Root**: input-surface clearing is per-source, not atomic.
- **Fix principle**: define a `resetInputSurfaces()` helper that
  clears composer + draft + attachments + scroll state in one sync
  block. Every transition that should "start fresh" calls it.

### 5. Multiple sources of truth for "active session"
- **Where**: `sessionDrawer.ts` has `optimisticActiveId` (line 92),
  `viewedSessionId`, AND reads `backend.getCurrentSessionId()`.
- **Half-state**: user clicks row #1 → optimisticActiveId = #1 →
  refresh() runs → renders with active = optimisticActiveId →
  resume completes → optimisticActiveId cleared → 2s later another
  refresh fires → reads `backend.getCurrentSessionId()` (still old)
  → highlight flips back to old row. **Drawer flicker.**
- **Root**: priority order at line 145 is correct, but
  optimisticActiveId is cleared after resume — leaves a window where
  the next refresh reads the wrong source.
- **Fix principle**: don't clear `optimisticActiveId` until
  `viewedSessionId` is set AND a subsequent refresh has rendered
  with it. Or fold all three into a single "currentSessionId" with
  generation tracking.

---

## Boundary check

| Pair | Interface | Coupling | Notes |
|------|-----------|----------|-------|
| Composer ↔ Chat | `composer.onSubmit → sendTypedMessage → chat.addLine` | **Loose** | Composer doesn't import chat; main.ts wires the callback |
| Composer ↔ Voice | `composer.appendText / setInterim / submit` | **Loose** | Voice pipeline calls exported functions only |
| Draft ↔ Chat | `draft` imports `chat.autoScroll` (line 23) | **⚠ Tight** | Should be a callback, not a direct import |
| Drawer ↔ Chat | `setViewed → chat.trackViewedSession → chat.persist` | **Loose** | Drawer doesn't directly modify chat state |
| Drawer ↔ Backend | `backend.listSessions / resumeSession` | **Loose** | Adapter methods are well-named |
| Backend ↔ Chat / Drawer | Adapter fires callbacks (onDelta, onFinal, …) | **Loose** | main.ts subscribes and dispatches |
| Settings ↔ Everything | `settings.get()` called live by multiple modules | **⚠ Cache incoherence** | Live localStorage reads, no invalidation. Multi-tab sees stale values until next get() call |
| Conversations (IDB) ↔ Drawer/Chat | drawer reads, chat writes | **⚠ Latency-coupled** | Cache-first hides IDB latency; transient sort flicker |

### Abstraction leaks flagged
1. `draft.ts:23` imports `chat.autoScroll` directly → should be a callback parameter.
2. `settings.ts` reads localStorage live with no cache invalidation → multi-tab/PWA-multi-window stale reads.
3. `main.ts` holds `streamingEl` (DOM ref) → can become orphaned when `chat.clear()` runs underneath; `isConnected` check is defensive, not preventive.
4. Drawer wholesale re-renders on every refresh → no incremental DOM diffing; partial-failure mid-render can corrupt the list view (rare).

---

## Verdict

**Refactor before adding features.**

The frontend works for the current feature set and recovers from
transient failures (the bugs are flicker / wrong-highlight / dropped
envelopes — annoying but not data-loss). But adding more async
features (offline outbox, multi-tab sync, undo/redo, background
sends) without addressing the 5 hot spots will multiply the
brittleness — every new async path is another window where IDB,
in-memory state, and DOM diverge.

The refactor is **not** a wholesale rewrite. It's targeted fixes:

1. **Generation counters on async actions.** Every click → bump a
   counter. Stale fetches drop their results.
2. **Separate optimistic from committed state.** Drawer highlight =
   optimistic. Render gate = committed. Don't conflate.
3. **In-memory mirrors for IDB writes used by render-blocking code.**
   Sort/list uses mirror; IDB is a background commit.
4. **`resetInputSurfaces()` helper** for transitions that should
   start fresh.
5. **Replace stale-ref patterns with formal ownership.** `streamingEl`
   moves into `chat.ts`; main.ts subscribes to events instead of
   holding DOM refs.
6. **Defer abstraction-leak cleanups** to a separate pass — the 5
   atomicity fixes deliver the user-visible reliability, the
   boundary cleanups (draft → callback, settings → cache) are
   maintenance hygiene.

Tier-1 tests in `docs/UX_TEST_PLAN.md` pin behavior at exactly these
seams. Land the tests RED, refactor under them, watch them go
green.
