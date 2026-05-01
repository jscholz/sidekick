# Bubble Dupe — System Analysis & Hypotheses

Date: 2026-04-30 overnight pass
Bug: One assistant message in hermes DB renders as TWO bubbles in the PWA chat. User-reported diagnostic shows only one `[bubble-diag] reply_delta` and one `reply_final` per `msg_id` per session — so the dedup at envelope receipt is working. The duplication happens in the **render path**.

User's clue: "the timestamp was different by a minute, which made me think the ring buffer wasn't clearing or the index in pwa wasn't advancing."

## System overview

### Envelope flow (proxy → client → DOM)

1. Hermes (or stub) emits envelopes over WS to the proxy.
2. Proxy's SSE multiplexer (`proxy/sidekick/stream.ts`) appends each envelope to a 128-entry monotonic-id ring and fans it to all subscribers of `/api/sidekick/stream`. On reconnect, `?last_event_id=N` skips already-seen entries.
3. PWA `proxyClient.ts` opens an EventSource on `/api/sidekick/stream`, optionally with `last_event_id=N` cursor (line 217-219).
4. Each envelope is parsed in `onEvent` (line 230). The defensive **envelope-id dedup** (`seenEventIds`, line 247-261) drops re-deliveries.
5. Surviving envelopes go to `handleEnvelope` (line 416). For `reply_delta` and `reply_final`, `replyIdFor(env, chatId)` (line 119) mints/returns a stable `replyId` keyed on `env.message_id`. The **reply-id dedup** map (`bubbleReplyIds`) ensures delta and final share one id.
6. `handleEnvelope` invokes `subs.onDelta` / `subs.onFinal` → `main.ts:handleReplyDelta` (2886) / `main.ts:handleReplyFinal` (2904).

### Render path (the suspect zone)

Module-level state in `src/main.ts`:
- `streamingEl: HTMLElement | null` — currently active streaming bubble.

Lifecycle:
- `showThinking()` (line 2706): Called via `backend.onSend` (line 807). Creates a tentative pending bubble, sets `streamingEl`. Has its own orphan check (`if (streamingEl && !streamingEl.isConnected) streamingEl = null;`, line 2713).
- `showStreamingIndicator(text, replyId)` (line 2776): Called from `handleReplyDelta`. Drops orphan ref (line 2781). If `!streamingEl`, sweeps `.line.streaming` and creates new bubble (lines 2783-2797). Else, adopts replyId on existing bubble (lines 2798-2808).
- `finalizeStreamingBubble(text)` (line 2821): Called from `handleReplyFinal`. If `!streamingEl`, returns null. Otherwise mutates existing bubble (remove `.streaming`, set text, etc), sets `streamingEl = null`, returns the element.
- `handleReplyFinal` (line 2904): If `finalizeStreamingBubble` returned `null`, **falls back to `chat.addLine(...)` at line 2950** with the `replyId` — creating a fresh bubble.

### Persistence path

`chat.persist()` (`src/chat.ts:256`) writes `transcriptEl.innerHTML` to IDB on every `addLine`/finalize/clear.
`chat.init()` reads the snapshot back on boot (`src/chat.ts:200-247`); `clear()` wipes both DOM and snapshot (`src/chat.ts:493-498`).

### Replay path

`replaySessionMessages(id, messages, pagination)` (`src/main.ts:2512`) runs on:
- Boot resume (line 717, 738)
- Drawer click (`sessionDrawer.init({ onResume: replaySessionMessages, ... })`, line 358)
- cmdkPalette resume (line 380)
- Adapter-driven reconcile after long gap (line 789)

It checks `replayFingerprint(id, messages)` (line 2505) — if `(viewed === id && fingerprint matches)`, **skips rebuild**. Otherwise: `chat.clear()` + `renderHistoryMessage(m)` per message.

`reconcileActiveChat` (`proxyClient.ts:357`) is gated by `gapMs < 10_000` (line 359-362) — short visibility flips ride the SSE replay ring instead.

## What we know

1. User report: TWO bubbles for ONE assistant message in hermes DB.
2. iOS PWA log: exactly one `[bubble-diag] reply_delta` + one `[bubble-diag] reply_final` per `msg_id`. So `replyIdFor` minted ONCE; `seenEventIds` dedup is intact.
3. Timestamps differ by a minute → two render events at different wall-clock moments.
4. Earlier visibility-flip dupe was fixed (`project_sidekick_visibility_replay_bug.md`, ref `ff5a21b`) — that fix restored `last_event_id` on reconnect.
5. User explicitly said "ring buffer wasn't clearing or the index in pwa wasn't advancing" — points at `seenEventIds` / `lastEventId` / `bubbleReplyIds`, not the render layer per se.

## What we've ruled out

- **Envelope duplication on the wire**: the diagnostic logs show one of each per msg_id. If the same envelope arrived twice, we'd see two log lines.
- **`replyIdFor` minting different IDs for delta and final**: same `[bubble-diag]` log → same `replyId`.
- **Adapter sending two reply_finals with different msg_ids**: would show as two log lines.

## Hypotheses ranked

### H1 (most likely): Replay path duplicates a freshly-streamed bubble

**Mechanism**:
1. Live stream: `delta` then `final` arrive. `streamingEl=A` finalized cleanly. Bubble A in DOM with `data-reply-id=sk-XXX` (client-minted) and `Date.now()` timestamp at delta moment.
2. iOS visibility flip / iOS Safari pageshow (persisted) some time later (>10s).
3. `forceReconnect` → `scheduleReconcile` → after 500ms debounce, `reconcileActiveChat` runs (`proxyClient.ts:357`).
4. `reconcileActiveChat` calls `bubbleReplyIds.clear()` (line 378) and `subs.onResume({messages, ...})` → `replaySessionMessages`.
5. `replaySessionMessages` computes `replayFingerprint`. If `lastReplayFingerprint === null` (e.g. module reset on iOS bfcache restore), skipRebuild=false → `chat.clear()` + render all history messages (line 2530-2562). Including the now-persisted assistant reply with **hermes-side timestamp**.
6. **However**: `chat.clear()` does `transcriptEl.innerHTML = ''` first, so bubble A is removed before the rebuild. After rebuild: ONE bubble A' with hermes timestamp. **Should be one bubble, not two.**

**Where this could fail**:
- `chat.clear()` runs but the streamed bubble was ALSO persisted to the snapshot before clear — and the snapshot is already on screen via `chat.init`'s `transcriptEl.innerHTML = saved.html`. After clear+render, the second `addLine` for the assistant message creates a fresh bubble. Net: 1 bubble. **Still not 2.**
- **UNLESS**: replaySessionMessages is called BEFORE chat.clear()'s effect propagates — the rendered messages are appended on top of the unsweptDOM. But the code is synchronous: `chat.clear()` returns immediately after `innerHTML = ''`.
- **More plausible**: `replaySessionMessages` short-circuits via skipRebuild (fingerprint matched a prior render) AND a duplicate streaming-finalize path adds bubble A again. But `streamingEl` ref handling is one-shot.

**Smoking gun to look for in test**: a session resume / reconnect AFTER the streaming bubble finalized renders the message a second time without `chat.clear()` being effective.

### H2: `chat.clear()` runs but `streamingEl` ref persists; finalize mutates a detached node; fallback at line 2950 creates a new bubble

**Mechanism**:
1. Delta arrives → `streamingEl=A`, A in DOM.
2. Some path runs `chat.clear()` BEFORE final arrives (e.g. `/reset` slash command, drawer switch, sessionGone handler, replaySessionMessages from reconcile).
3. `transcriptEl.innerHTML = ''` detaches A. `streamingEl` ref still non-null but `isConnected=false`.
4. Final arrives → `finalizeStreamingBubble` is called.
5. `finalizeStreamingBubble` does NOT check `streamingEl.isConnected` (only `if (!streamingEl)`). It mutates the detached node, sets `streamingEl = null`, returns the detached node.
6. Caller line 2949: `if (!bubble)` is false (bubble truthy), so **the fallback at line 2950 does not fire**.

**Conclusion: H2 actually does NOT produce 2 bubbles.** It produces an invisible-mutation + missing bubble. So H2 is ruled out by the symptom.

### H3: Persisted snapshot already contains the bubble, and replay re-adds it

**Mechanism**:
1. Live: delta → bubble A streaming → `persist()` → snapshot has A. final → A finalized → `persist()` → snapshot has finalized A.
2. iOS Safari bfcache (`pageshow persisted=true`): JS module state is **preserved** in iOS bfcache! `streamingEl=null`, `bubbleReplyIds={}`, `lastReplayFingerprint` is whatever it was. DOM is preserved (bubble A visible).
3. `forceReconnect` fires → reconcile schedules.
4. `reconcileActiveChat`: `bubbleReplyIds.clear()` no-op (already empty for finalized turn), then `replaySessionMessages` with new messages from /messages.
5. `lastReplayFingerprint`: if it was set before bfcache, comparison is against current fetch. Fingerprint includes `messages.length` and last message's content length. If hermes added/changed something between the live render and the bfcache restore, fingerprint MISMATCHES → chat.clear() + render. **One bubble.** OK.
6. BUT — what if `replaySessionMessages` is called via the adapter `onResume` path (line 789) **AND** `reconcileActiveChat` ALSO fires `subs.onResume` (`proxyClient.ts:379`)? Both do the same thing. With debounce/coalesce, only one runs. Probably not the cause.

### H4 (most likely concrete pathway): renderHistoryMessage adds a bubble for the SAME assistant message that streamingEl was tracking

**Mechanism**:
1. Live: delta → bubble A streaming → `persist()` runs, snapshot has A with `data-reply-id=sk-XXX` and `data-text` populated.
2. final arrives in two phases: the SSE channel drops mid-final delivery (iOS background), then visibility-flip restores and the replay ring delivers final at T0+60s.
3. **At T0+60s**: `seenEventIds` dedup decides. If `lastEventId` was preserved across the kill (because the page didn't reload, just went background), and we resubscribe with `?last_event_id=lastEventId`, the server skips already-delivered entries. The dropped final WAS in the ring with id > lastEventId, so it gets delivered.
4. Final processed normally → finalizes bubble A. ONE bubble. OK.
5. **BUT**: if the kill was hard enough to wipe `lastEventId` (module reset) AND the snapshot was loaded from IDB, then bubble A is back in DOM via snapshot HTML. `chat.init` ran `transcriptEl.innerHTML = saved.html`. `streamingEl=null` (fresh module). Then SSE reopens WITHOUT cursor → ring replays all 128 entries (or fewer). The replayed delta+final hit `seenEventIds` (empty after reset) and proceed: `replyIdFor` mints a NEW replyId (different from the persisted one in snapshot HTML). `showStreamingIndicator` finds `streamingEl=null` → creates NEW bubble B. final → `finalizeStreamingBubble(B)` → finalizes B. Result: TWO bubbles in DOM (A from snapshot HTML restore, B from replay rendering).

**Prediction**: bubble A has `data-reply-id` from previous session's mint; bubble B has a fresh client-minted id. Both are `.line.agent`. Bubble A's text comes from the pre-kill state (might be partial). Bubble B's text is the full final.

**Why timestamps differ by a minute**: A's timestamp was generated client-side at the original delta (T0). B's timestamp was generated client-side at the replay (T0+60). Client-side `Date.now()` not the persisted hermes timestamp.

**Defense at boot** (chat.ts:230-246): the seenIds loop re-mints replyIds on duplicates. But that handles the case where the snapshot itself has duplicates — NOT the case where the snapshot's bubble survives + a replay creates a new one.

### H5: Snapshot restore + replaySessionMessages race

**Mechanism**:
1. Boot: `chat.init` does `transcriptEl.innerHTML = saved.html`. Bubble A from snapshot in DOM.
2. `replaySessionMessages` called from boot resume path (line 717). `chat.clear()` runs at 2530 → wipes innerHTML → bubble A removed.
3. Render history messages → bubble A' in DOM. Net: ONE bubble.

This SHOULD work. Unless replaySessionMessages skipRebuild fires at boot? `lastReplayFingerprint` is `null` initially — first call always rebuilds. So this path is sound.

## Most likely root cause (ranked)

**H4** is the most plausible: a **reset-without-snapshot-clear** path on iOS bfcache or hard kill. The snapshot persists the bubble; after restore, the replay path re-creates it. The defense (`replaySessionMessages` → `chat.clear` → render fresh) only fires if `replaySessionMessages` is called AT ALL on the path that produced the bubble. If the SSE replay ring delivers the message but `replaySessionMessages` never fires (e.g. reconcile gap < 10s), the bubble from snapshot HTML coexists with the bubble from replay rendering.

A simpler **H6 alternative**: **`renderHistoryMessage` adds without `chat.clear` first**. Searching the code: `renderHistoryMessage` is only called inside `replaySessionMessages` (after `chat.clear`) and inside `loadEarlierHistory` (prepend mode). Both are well-fenced. Unless there's a stale invocation path I'm missing.

## What the Playwright test should look like

We want a test that catches **the most concrete failure mode**: a snapshot survives, the page reloads (or simulated `pageshow persisted`), the replay ring re-delivers the same envelopes, and after the dust settles **only one bubble exists in the DOM**.

```js
// scripts/smoke/bubble-dupe-render.mjs
//
// Setup: mock backend that streams a reply, finalize it, persist snapshot.
// Action: simulate a "fresh module + replay ring" event sequence:
//   - close stream
//   - reload the page (snapshot restores from IDB, bubble visible)
//   - reopen stream WITHOUT last_event_id (so the proxy replays)
//   - mock pushes the same delta + final envelopes again
// Assertion: querySelectorAll('.line.agent[data-reply-id]') === 1
```

Specifically test these cases (sub-tests):

**Case A — replay-ring re-delivers a finalized message**:
1. Send a user message, mock streams `reply_delta` + `reply_final`.
2. Wait for finalization (`.line.agent:not(.streaming)`).
3. Programmatically close the EventSource on the client (`page.evaluate(() => /* hack to close streamES */)`) — or use `page.evaluate(() => window.stop())`, then re-open via visibility or refresh.
4. Have mock backend re-broadcast the same envelopes (replay ring would do this if `last_event_id` was lost).
5. Assert `.line.agent` count is exactly 1.

**Case B — page reload between deltas**:
1. Send a user message, mock streams `reply_delta` (no final yet).
2. Wait for streaming bubble visible.
3. Reload page (`page.reload()`).
4. Mock backend re-broadcasts the same delta + final.
5. Assert exactly 1 `.line.agent` bubble in DOM after final.

**Case C — visibility-flip after final, with replay ring**:
1. Send + complete a turn.
2. Trigger `visibilitychange` to hidden then visible.
3. Mock backend re-emits the same envelopes (simulating replay).
4. Assert exactly 1 agent bubble.

**Mock-backend hooks needed**: `mock.broadcast(env)` or similar to fire raw envelopes into the SSE channel; check `scripts/smoke/mock-backend.mjs` for what's already exposed. If not exposed, may need to add a `replay-last-N` hook.

**Diagnostic capture**: dump `[bubble-diag]` log lines after the assertion fails — look for `replyIdFor minted=true mapSize=N`. If `minted=true` happens twice for the same msg_id, the map is being cleared between the two deliveries (the H4 path). If `minted=false`, the dedup is intact and the dupe is purely render-side.

The test will tell us which hypothesis is right.

## Files of interest

- `src/main.ts:2512-2567` — replaySessionMessages
- `src/main.ts:2706-2842` — showThinking / showStreamingIndicator / finalizeStreamingBubble / clearStreamingIndicator
- `src/main.ts:2886-2968` — handleReplyDelta / handleReplyFinal (incl. line 2950 fallback)
- `src/proxyClient.ts:119-140` — replyIdFor / clearBubble
- `src/proxyClient.ts:230-302` — onEvent / seenEventIds dedup / startStreamChannel
- `src/proxyClient.ts:357-388` — reconcileActiveChat (and bubbleReplyIds.clear())
- `src/chat.ts:200-260` — init / loadSnapshot / persist
- `src/chat.ts:230-246` — snapshot-restore replyId dedup
- `src/chat.ts:493-498` — clear()
- `proxy/sidekick/stream.ts` — replay ring + last_event_id semantics
