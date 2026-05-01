# Overnight TDD Pass — 2026-04-30

Jonathan asked for an audit + Playwright TDD on the bugs that were still red after the day, plus an arrow-key sidebar nav feature. He wanted me to research first ("research subagent → markdown summary → test → fix → report"), not jump straight to defensive guards. This file is the morning-read summary.

## What shipped

| Item | Type | Test | Status |
|---|---|---|---|
| **Bubble-dupe fix** (cross-render-path dedup by `message_id`) | Bug | `scripts/smoke/bubble-dupe-replay.mjs` (Playwright, RED→GREEN) | ✅ |
| **iOS pocketlock waveform** (resume() the meterCtx if suspended; longer poll window) | Bug | NONE — iOS-specific, not Chromium-reproducible (analysis explains why) | ⚠ needs on-device verify |
| **Barge-in cooldown re-arm** (`BargeGate` class replacing once-per-turn boolean) | Bug | `audio-bridge/tests/test_barge_gate.py` (7 unit tests, all green) | ⚠ needs on-device verify |
| **Arrow-key sidebar nav** | Feature | `scripts/smoke/sidebar-arrow-nav.mjs` (Playwright, full test plan green) | ✅ |
| Service worker version bump (`v2.119` → `v2.120`) | Plumbing | — | ✅ |

Full mocked smoke suite was passing before this overnight pass and the changes here add to it (no regressions in the 24 mocked scenarios + 2 new ones).

## Bug 1 — bubble dupe

**Symptom**: One assistant message in hermes DB rendering as two bubbles in the chat. iOS PWA log showed exactly one `[bubble-diag] reply_delta` and one `reply_final` per `msg_id`, so the duplication was in the render path, not at envelope receipt. Two timestamps, ~1 minute apart.

**Root cause** (see `01-bubble-dupe-analysis.md`): two render paths — `renderHistoryMessage` (timestamp = hermes `m.timestamp`) and `showStreamingIndicator` (timestamp = client `Date.now()`) — were both rendering the same logical message, with no dedup mechanism between them. The two-bubble timestamps differing by a minute is exactly this signature: client and server clock skew on a phone.

The trigger condition: history fetch renders a finalized bubble, then SSE delivers a fresh `reply_delta` + `reply_final` for that same message. This happens whenever hermes pushes the reply via the persistent stream after `/messages` already returned it (timing: `chat.clear()` in `replaySessionMessages` only saves the current order; flip it and the bug fires).

**Test (RED first)**: `scripts/smoke/bubble-dupe-replay.mjs`. Mock seeds a chat with a user msg + assistant reply already in `/messages`. Test waits for history render, then calls `mock.pushReply(CHAT_ID, REPLY_TEXT, MESSAGE_ID)` — pushing the SAME `message_id` via SSE. Pre-fix DOM dump confirmed the bug:

```
[0] class="line s0"     text="You: tell me a joke17:49"
[1] class="line agent"  text="Clawdian: Why did the chicken... 17:49"
[2] class="line agent"  text="Clawdian: Why did the chicken... 17:50"
```

**Fix**: dedup at the envelope handler level using the wire `message_id`.
- `chat.addLine` now accepts `messageId` opt and stamps `data-message-id` on the bubble.
- `proxyClient.ts` forwards `env.message_id` through `onDelta`/`onFinal`.
- `main.ts:handleReplyDelta` and `:handleReplyFinal` check
  `.line.agent[data-message-id="${msgId}"]:not(.streaming)` — if a finalized bubble for this id exists, drop the envelope. The `:not(.streaming)` selector lets an in-flight live stream keep updating its own bubble.
- `renderHistoryMessage` stamps `data-message-id` from `m.id` (the proxy's `/messages` `id` field already maps 1:1 to upstream's `it.id` which is the same string emitted as the SSE `message_id` in `proxy/sidekick/upstream.ts`).
- Mock backend updated to mirror the real proxy's id-namespace alignment.

**After fix**: test goes GREEN. Diagnostic shows the dedup firing:
```
[bubble-diag] DROPPING reply_delta for already-rendered messageId=mock-msg-dupe-1
[bubble-diag] DROPPING reply_final for already-rendered messageId=mock-msg-dupe-1
```

**Files changed**: `src/chat.ts`, `src/proxyClient.ts`, `src/main.ts`, `scripts/smoke/mock-backend.mjs`, plus the new smoke test.

**Edge cases verified**:
- Live stream + same chat: in-flight bubble has `.streaming`, dedup uses `:not(.streaming)`, so showStreamingIndicator continues to update its own bubble through the delta stream. Only finalized bubbles dedupe.
- Boot path (where SSE replay arrives BEFORE history fetch, then `chat.clear()` wipes everything before render): `chat.clear()` removes the `data-message-id` along with the bubble, so the post-clear render proceeds normally. Confirmed by the test's first scenario which had this ordering and went GREEN even pre-fix.

## Bug 2 — iOS pocketlock waveform

**Symptom**: Pocketlock fullscreen overlay's mic waveform works on desktop, dead on iOS PWA.

**Root cause** (see `02-pocketlock-waveform-analysis.md`): My recent fix introduced a fallback `meterCtx = new AudioContext()` when `getAudioCtx()` (the iOS-unlocked context) is null. On iOS Safari, an AudioContext created OUTSIDE a user gesture stays in `'suspended'` state — and `createMediaStreamSource` on a suspended context yields zero frames. Desktop Chromium doesn't enforce this, so my desktop testing said "works".

**Fix** (best-effort, not testable in Chromium harness):
- `meterCtx.resume()` immediately after creation. Allowed without a fresh gesture once any prior gesture in the page has touched audio (the unlock dance from a memo button or send click typically already ran by the time pocketlock is shown). Fire-and-forget; no-op on a running context.
- Polling window extended from ~5s (20 attempts) to ~30s (120 attempts) so pocket-lock-then-call-later still wires the meter.
- `log()` line includes `ctx.state` so on-device debugging can see whether the resume took.

**Why no Playwright test**: Chromium does not enforce iOS's gesture-bound AudioContext semantics. Any test in the headless harness will pass even with the iOS bug present — exactly how the regression got past me earlier today. **Needs on-device verification on Jonathan's iPhone PWA.** The fix is small and additive; if it doesn't take, the analysis lists Option B (force `unlock(player)` from the lock-button click handler in `main.ts`) as the next-best lever.

**Files changed**: `src/ios/fakeLock.ts`.

## Bug 3 — barge-in (self-trigger + manual-stop-fails)

**Symptom**: Barge-in fired on the assistant's own playback (false positive on TTS echo). Then when the user actually spoke to interrupt, nothing happened. Sensitivity 60%.

**Root cause** (see `03-barge-in-analysis.md`): The bridge's VAD logic in `audio-bridge/stt_bridge.py` used a `barge_fired_this_turn` boolean that latched true on first fire and only cleared when `tts_track.is_active()` flipped false. If a false-positive consumed the gate, subsequent (real) user voice was silently swallowed for the rest of the TTS turn. The PWA's barge handler only paused LOCAL playback (`cancelRemotePlayback` nulls srcObject); the bridge's tts_track kept emitting, so `is_active()` stayed true → gate stayed consumed.

(Sensitivity 60% in the PWA settings panel turned out to be ORPHANED — the slider writes `bargeThreshold` into yaml but the bridge reads its own `SIDEKICK_VAD_RMS_THRESHOLD` env var, no control channel between them. That's a separate cleanup item, not blocking the bug.)

**Fix**: extracted the gate logic into a small `BargeGate` class with cooldown re-arm semantics:
- `feed(rms)` — ingests one 20ms frame; returns True when ready to fire.
- Hold-frames + cooldown gating: after firing, ignore re-fires for `VAD_BARGE_COOLDOWN_S` seconds (default 1.5s, env-tunable).
- `reset_turn()` called on TTS end clears both hold counter and cooldown.

A false positive now blocks for 1.5s, then re-arms. The user's real interrupt voice — arriving even seconds later, while the bridge's tts_track is still active — can fire a second barge.

**Test**: `audio-bridge/tests/test_barge_gate.py` — 7 unit tests, all green:
```
PASS  test_below_threshold_never_fires
PASS  test_above_threshold_for_too_few_frames_does_not_fire
PASS  test_fires_at_exactly_hold_frames
PASS  test_undershoot_resets_hold_counter
PASS  test_cooldown_blocks_immediate_refire_then_rearms
PASS  test_reset_turn_clears_hold_and_cooldown
PASS  test_real_world_scenario_false_positive_then_real_interrupt
```

The "real world scenario" test simulates exactly the user's reported failure mode: TTS-echo false positive at t=0, then real user voice at t=2s. Pre-fix this would silently swallow the user's interrupt; post-fix the second barge fires.

**What this DOESN'T fix** (needs follow-up + on-device verify):
- The asymmetry between PWA-side pause and bridge-side TTS still exists: when barge fires, the PWA pauses local playback but the bridge keeps streaming TTS frames. With the cooldown re-arm, this is no longer fatal (the second fire reaches through), but it's still the cleanest architectural fix. `audio-bridge/dispatch_listener.py:107-109` has a stub for `interrupt` messages that's currently a no-op — wiring that up to halt `tts_track` is the right structural fix for next pass.
- The 300 RMS threshold is still global. If desktop echo bleed regularly hits 300+, the threshold could be auto-tuned to 3× ambient at call start (also a follow-up).

**Files changed**: `audio-bridge/stt_bridge.py` (BargeGate class + integration), `audio-bridge/tests/test_barge_gate.py` (new).

## Feature — arrow-key sidebar navigation

ArrowUp / ArrowDown cycle through visible drawer rows when the composer / filter input is not focused.

- Wired into the existing `installSelectionKeyboardListener` in `src/sessionDrawer.ts`.
- Anchors on `optimisticActiveId || viewedSessionId`; clamps at list boundaries (no wrap — wrap-around feels like an accident at the top).
- Skips when the user has any modifier other than shift (alt/ctrl/meta left for browser shortcuts), when focus is in a text input, or when multi-select is active (shift+arrow handles that path).
- Synchronous `.active` class flip for instant feedback (mirrors the click handler), then async `resume(id)` for transcript render — same behavior as a click.

**Test**: `scripts/smoke/sidebar-arrow-nav.mjs` covers the full plan: click A, ArrowDown to B, ArrowDown to C, ArrowDown clamps at end, ArrowUp back to B then A, focus composer + ArrowUp does NOT navigate. All assertions pass.

**Files changed**: `src/sessionDrawer.ts`, plus the new smoke test.

## Files inventory (overnight pass)

```
docs/overnight-2026-04-30/
  01-bubble-dupe-analysis.md         (~600 words, hypotheses + test plan)
  02-pocketlock-waveform-analysis.md (~500 words, iOS-specific gotchas)
  03-barge-in-analysis.md            (~700 words, two-symptom analysis)
  STATUS.md                          (this file)

audio-bridge/
  stt_bridge.py                      (BargeGate class + cooldown rearm)
  tests/test_barge_gate.py           (7 unit tests, NEW)

src/
  chat.ts                            (+messageId opt → data-message-id)
  proxyClient.ts                     (forward message_id on onDelta/onFinal)
  main.ts                            (dedup + showStreamingIndicator messageId)
  ios/fakeLock.ts                    (resume() meterCtx + 30s poll window)
  sessionDrawer.ts                   (navigateByKey + ArrowUp/Down handler)

scripts/smoke/
  mock-backend.mjs                   (history `id` aligned with envelope `message_id`)
  bubble-dupe-replay.mjs             (NEW, RED→GREEN)
  sidebar-arrow-nav.mjs              (NEW)

sw.js                                (v2.119 → v2.120)
```

## What I'd test on-device first thing in the morning

1. **Reload the iOS PWA** to pick up v2.120 (Refresh button or full reload).
2. **Bubble dupe**: Start a call, say a few things, lock+unlock the phone a few times to trigger visibility flips. Should now see exactly ONE bubble per assistant message regardless of timing. If a dupe still happens, dump the console for `[bubble-diag] DROPPING …` lines — they tell you whether the dedup fired or whether there's a third render path I haven't found.
3. **Pocketlock waveform**: Start a call, engage the lock overlay. Watch console for `[fakeLock] mic meter wired to WebRTC mic stream (ctx.state=running)`. If state shows `suspended`, the resume() didn't take and we need Option B (gesture-bound unlock from the lock-button click).
4. **Barge-in**: Trigger a long TTS reply, deliberately speak over it. Should now interrupt even if a false-positive fired earlier in the turn. If the system never barges at all, the threshold may need lowering for that environment (env: `SIDEKICK_VAD_RMS_THRESHOLD=200`); if it self-triggers constantly, raise it (`SIDEKICK_VAD_RMS_THRESHOLD=500`). Cooldown also tunable: `SIDEKICK_VAD_BARGE_COOLDOWN_S=2.0` for a calmer rearm.
5. **Arrow-key nav**: Press ↑ / ↓ with composer NOT focused. Should walk through drawer rows. With composer focused, should fall through to caret-move / send-button focus normally.

## What's still open / parking lot

- iOS pocketlock waveform: no harness coverage; relies on on-device verify.
- Barge-in: PWA-side `cancelRemotePlayback` ↔ bridge-side `tts_track.halt()` asymmetry still present; a future pass should wire the `interrupt` data-channel message (already stubbed in `dispatch_listener.py`) to drain the tts_track frame queue. Cooldown re-arm masks the bug; doesn't fix the architecture.
- The orphaned PWA "barge sensitivity" slider in settings.ts → `bargeThreshold` writes yaml that nothing reads. Either delete it or wire it through a new data-channel control message to update `BargeGate.threshold` at runtime. **Pick one — leaving it as-is invites the same "I changed sensitivity to 60% and nothing happened" surprise.**
- The `barge_fired_this_turn` peer.extra key is no longer set anywhere (BargeGate handles state internally). I left peer.extra alone elsewhere in the file in case other callers read it; quick grep showed no other readers, so it's a safe removal whenever convenient.
