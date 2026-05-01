# Speak Replies for Text Messages - Implementation Proposal

**Date:** 2026-04-30  
**Estimated Effort:** 60-80 lines + 40-50 lines of smoke tests  
**Status:** Research-only (no implementation)

## 1. Goal and Non-Goals

### Goal
Extend the "Speak replies" toggle (currently WebRTC call-mode only) to play agent replies via TTS when the user sends text-typed messages outside a call. The toggle wording ("Speak replies") already implies universal behavior; the implementation today is call-mode-only, creating a UX gap.

### Non-Goals
- Streaming TTS (low-latency chunk-at-a-time synthesis) — v1 stitches final reply text at `handleReplyFinal`
- Local TTS synthesis (Web Speech API) — reuse existing Deepgram Aura server proxy (`POST /tts`)
- Interruption via barging (user speaking during TTS playback) — text mode has no VAD
- Priority/queueing strategy beyond "last reply wins" — simplify to cancel-and-replace

---

## 2. Current State

### Existing TTS Infrastructure

**Server-side (`server.ts:159-207`)**
- `/tts` endpoint: `POST /tts { text: string, model?: string }`
  - Returns: `audio/mpeg` blob (streamed from Deepgram Aura)
  - Model defaults to `'aura-2-thalia-en'` (voice-gender-neutral, English)
  - Text capped at 2000 chars; errors return JSON `{ error, status, message }`
  - Already wired and functional; tested in production via WebRTC talk mode

**Client-side (`src/audio/tts-provider.ts`)**
- Abstract interface (TTSProvider) with three methods:
  - `speak(text, opts?: { voice?: string }): Promise<void>`
  - `cancel(): Promise<void>`
  - `onState(cb): Unsubscribe`
- **Status: Dead code.** The interface exists; no concrete implementation wired to the text-reply path. Only WebRTC talk mode uses TTS (via server's audio-bridge, not this interface).

**Audio playback elements**
- `index.html:461` — `<audio id="player" playsinline preload="auto"></audio>` — generic sink, currently unused for TTS
- `src/pipelines/webrtc/connection.ts:255-275` — creates a hidden `<audio>` element on-demand for talk-mode peer-track TTS playback
  - Set to `autoplay=true` + WebRTC `srcObject` binding (MediaStream track)
  - Positioned off-screen (`left: -9999px`)

**Voice selection**
- `src/settings.ts:163,165,169-170`
  - `tts: boolean` — toggle (the "Speak replies" setting)
  - `voice: 'aura-2-thalia-en'` — default Deepgram Aura model (not per-device)
  - `ttsVoiceLocal: ''` — per-device voice for Web Speech API (separate path, out of scope)
  - `ttsEngine: 'server'` — defaults to server proxy; alternative `'local'` uses Web Speech

---

## 3. Recommended Insertion Point

### Primary: `src/main.ts:handleReplyFinal` (line 3172)

Location: Immediately after `playFeedback('receive')` at line 3248, before card parsing.

**Pseudo-code:**
```typescript
function handleReplyFinal({ replyId, text, content = [], conversation, messageId }: any) {
  // ... existing code up to line 3248 ...
  playFeedback('receive');

  // NEW: Fire TTS for text replies if toggle is on AND not in a call
  if (finalText && settings.get().tts && !webrtcControls.isOpen()) {
    playReplyTts(finalText).catch(err => {
      diag('playReplyTts failed:', err.message);
    });
  }

  // ... rest of the function (card parsing, etc.) ...
}
```

### Why This Location?
1. Reply is fully complete and validated (NO_REPLY_RE filter has run)
2. `finalText` is available (accumulated from streaming or final envelope)
3. Synchronous gating logic (check settings, check call state) lives here
4. Async playback (fetch + audio) doesn't block bubble rendering
5. If playback fails, it's a best-effort side effect, not a critical path

### Call Hierarchy
```
sendTypedMessage (line 1067)
  → backend.sendMessage(text)
    → [SSE/WS from backend]
      → handleReplyFinal (line 3172)
        → playReplyTts(finalText)  [NEW, async, non-blocking]
```

---

## 4. iOS Gesture-Binding Analysis

### Current Gesture Lock Situation

**Gesture window:** Opened by user click/touch (send button, Enter key)
- `sendTypedMessage()` runs synchronously in the gesture handler
- `playFeedback('send')` line 1160 runs in the gesture (synchronous)
- Agent reply arrives **asynchronously** (seconds later), **outside the gesture window**

**Priming:** `src/audio/platform.ts:primeAudio(player)`
- Locks in the AudioContext + primes HTMLAudioElement for iOS gesture requirements
- **Called from:** Unknown in codebase (search didn't find callers)
- **Should be called from:** Send button handler or somewhere in the compose path

### Finding: No Current Prime
Searching the codebase for `primeAudio(` calls finds **zero results**. This is a risk:
- If text-TTS tries to play from an unpaired HTMLAudioElement on iOS, it will hang/fail
- The existing gesture-lock system exists but isn't being used

### Mitigation Strategy for v1

**Option A (Recommended): Lazy Prime on Send**
```typescript
// In sendTypedMessage, line 1160 (after playFeedback('send')):
const player = document.getElementById('player') as HTMLAudioElement | null;
if (player) {
  primeAudio(player);
}
```
- Minimal code (1-2 lines)
- Fires inside the send gesture, so iOS allows it
- Idempotent (primeAudio is safe to call multiple times)
- Covers all send paths (typed message, auto-send, slash commands)

**Option B (Future): Eager Prime on Page Load**
- Prime during the settings panel open or on first user focus
- Would help other audio paths too (potential future features)
- Out of scope for v1

### Reality Check
The WebRTC talk mode also needs gesture binding (it plays TTS via `<audio>`). Checking `src/pipelines/webrtc/controls.ts:openCall()` — **I don't see an explicit primeAudio call before the TTS track arrives.** Either:
1. The peer-connection's `srcObject` binding bypasses the gesture requirement on iOS, OR
2. There's gesture binding elsewhere in the call-open flow (e.g., in the mic-request handler), OR
3. This is a latent iOS bug that hasn't surfaced because talk-mode replies are fast (in-call, lower latency)

**Recommendation:** Add the send-path prime (Option A) as safe baseline; defer investigation of WebRTC prime-timing to a separate issue if needed.

---

## 5. Interruption Rules and Edge Cases

### Four Scenarios

#### Scenario A: Normal Reply (user not talking)
```
t=0:    User sends message
t=0+:   Send button click fires sendTypedMessage
t=0+:   playReplyTts primed (gesture lock)
t=2s:   Agent reply completes, handleReplyFinal fires
        → Check: settings.tts=true, !webrtcControls.isOpen() → playReplyTts(text)
        → POST /tts → fetch mp3 blob → play
t=5s:   TTS audio finishes
```
**Behavior:** TTS plays from text reply, as intended.

#### Scenario B: Second Message Arrives While First TTS Still Playing
```
t=0:    User sends message A
t=0+:   playReplyTts primed
t=2s:   Reply A arrives → playReplyTts(A) → audio starts
t=3s:   User sends message B (during A's TTS playback)
t=3+:   playReplyTts primed (fresh gesture)
t=4.5s: Reply B arrives → playReplyTts(B)
        → Cancel/stop A's playback, start B
```
**Behavior:** Replace A with B (truncate, no queue). Matches ChatGPT voice mode.

**Implementation:**
```typescript
async function playReplyTts(text: string): Promise<void> {
  // Cancel any in-flight playback
  if (activeReplyTts) {
    await activeReplyTts.cancel();
    activeReplyTts = null;
  }
  
  activeReplyTts = { /* ... */ };
  try {
    // Fetch + play
    await fetchAndPlayTts(text);
  } finally {
    activeReplyTts = null;
  }
}
```

#### Scenario C: User Toggles "Speak replies" OFF Mid-Playback
```
t=3s:   TTS audio playing
        → User presses Alt+T (or clicks toggle in mic menu)
        → flipMicSetting('tts') → settings.set('tts', false)
t=3.1s: stopReplyTts() fires (new listener on settings.tts change)
        → Cancel active TTS, stop playback
```
**Behavior:** Stop immediately, no resume.

**Implementation:**
```typescript
// In main.ts, after settings.init():
settings.onChanged('tts', (newVal) => {
  if (!newVal && activeReplyTts) {
    void activeReplyTts.cancel();
    activeReplyTts = null;
  }
});
```

#### Scenario D: Call Mode Opens While Text TTS Playing
```
t=3s:   Text TTS playing, settings.tts=true
        → User clicks mic to open call
        → webrtcControls.openCall('talk') → peer connection establishes
t=3.5s: Server sends TTS audio track over WebRTC
        → Both "text TTS" and "peer TTS" compete for speaker
```
**Behavior:** Stop text TTS, hand audio ownership to WebRTC.

**Implementation:**
```typescript
// In src/pipelines/webrtc/connection.ts openCall, after PC connects:
export async function openCall(mode: CallMode) {
  // ... existing code ...
  if (mode === 'talk' && activeReplyTts) {
    // Stop text-mode TTS so peer track owns the speaker
    await activeReplyTts.cancel();
    activeReplyTts = null;
  }
  // ... rest of open ...
}
```

### Summary Table

| Scenario | Trigger | Action | Expected |
|----------|---------|--------|----------|
| A. Normal | Reply arrives, toggle on, no call | Play TTS | Audio ▶️ |
| B. Second msg | Reply arrives while A playing | Cancel A, play B | B ▶️ (A stops) |
| C. Toggle off | User disables "Speak replies" | Cancel active | Audio ⏹️ |
| D. Call opens | WebRTC peer connection starts | Cancel text TTS | WebRTC ▶️ (text stops) |

---

## 6. Voice Selection Strategy

### Current Settings
- `settings.voice` = `'aura-2-thalia-en'` (default Deepgram Aura model)
  - Used by WebRTC talk mode
  - Deployment-wide setting (yaml-backed, not per-device)
- `settings.ttsVoiceLocal` = per-device local voice for Web Speech API
  - Separate from server TTS

### Decision: Reuse `voice` Setting
**Rationale:**
1. Consistency — same voice everywhere (text replies + call replies)
2. Single UX surface — users don't need separate UI for "voice for text" vs "voice for calls"
3. Minimal schema change — no new settings key
4. The `/tts` endpoint already accepts `model` param; use `settings.voice`

**Implementation:**
```typescript
async function playReplyTts(text: string): Promise<void> {
  const model = settings.get().voice;  // e.g., 'aura-2-thalia-en'
  const res = await fetch('/tts', {
    method: 'POST',
    body: JSON.stringify({ text, model }),
  });
  // ...
}
```

### No UI Change Needed
The "Speak replies" toggle already exists in the mic-mode menu (main.ts:2278). Voice selection is a separate UI (if users want it) — out of scope for v1. Ship v1 with the default voice, add voice picker in v2 if needed.

---

## 7. Smoke Test Sketch

### Test File: `test/speak-replies-text.test.ts` (new)

```typescript
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

describe('Speak replies for text messages', () => {
  let mockFetch;
  let mockAudioElement;
  let mockSettings;
  let mockWebRtcControls;

  beforeEach(() => {
    // Mock global fetch
    mockFetch = mock.fn(async (url, opts) => {
      if (url === '/tts') {
        assert.equal(opts.method, 'POST');
        const body = JSON.parse(opts.body);
        assert.ok(body.text, 'text required');
        assert.ok(body.model, 'model should default or be set');
        // Return a stub mp3 blob
        return {
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1024),
        };
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    // Mock HTMLAudioElement
    mockAudioElement = {
      src: null,
      play: mock.fn(async () => {}),
      pause: mock.fn(() => {}),
      addEventListener: mock.fn((evt, cb) => {}),
    };

    // Mock settings
    mockSettings = {
      get: () => ({
        tts: true,
        voice: 'aura-2-thalia-en',
      }),
      set: mock.fn((key, val) => {}),
    };

    // Mock WebRTC controls
    mockWebRtcControls = {
      isOpen: () => false,  // Not in a call
    };
  });

  it('fetches /tts with reply text and voice setting', async () => {
    const text = 'This is the agent reply.';
    // Simulating: await playReplyTts(text)
    await mockFetch('/tts', {
      method: 'POST',
      body: JSON.stringify({
        text,
        model: mockSettings.get().voice,
      }),
    });

    assert.equal(mockFetch.mock.callCount(), 1);
    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call.arguments[1].body);
    assert.equal(body.text, text);
    assert.equal(body.model, 'aura-2-thalia-en');
  });

  it('sets audio element src/play when TTS is fetched', async () => {
    // After fetch returns, playReplyTts sets player.src and calls play()
    // This assertion verifies the audio element binding
    assert.ok(mockAudioElement.play);
  });

  it('cancels prior TTS playback before starting new one', async () => {
    // Scenario B: second message arrives while first is playing
    // Assertion: activeReplyTts.cancel() was called
    // (Requires instrumentation of the module under test)
  });

  it('does not play TTS if settings.tts is false', async () => {
    mockSettings.get = () => ({ tts: false, voice: 'aura-2-thalia-en' });
    // playReplyFinal should bail early
    assert.equal(mockFetch.mock.callCount(), 0);
  });

  it('does not play TTS if WebRTC call is open', async () => {
    mockWebRtcControls.isOpen = () => true;
    // playReplyFinal should bail early (call mode owns audio)
    assert.equal(mockFetch.mock.callCount(), 0);
  });

  it('cleans text with cleanForTts before posting to /tts', () => {
    // Use existing cleanForTts function from src/pipelines/classic/tts.ts
    // Verify that **bold** → bold, [Speaker] stripped, URLs → (link in canvas), etc.
    const dirty = '**Hi** from [Agent] — see https://example.com for details';
    // After clean: 'Hi from Agent see (link in canvas) for details'
    // (Implementation calls cleanForTts(finalText) before fetch)
  });

  it('handles /tts error gracefully (no throw, log only)', async () => {
    mockFetch = mock.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'tts_failed' }),
    }));
    // playReplyTts should catch and diag, not throw
    // Verify no unhandled rejection
  });
});
```

### Test Strategy
- **Unit tests** (above) — isolated playReplyTts logic with mocks
- **Integration test** (Playwright, if smoke harness extends to TTS)
  - Open UI, send text message
  - Assert `POST /tts` fires with correct text + voice
  - Intercept `/tts`, return a tiny stub mp3
  - Assert audio element's `src` was set
- **Manual on-device** — late in sprint, Pi5 + Bluetooth speaker
  - Send text message
  - "Speak replies" toggle on → hear audio
  - Toggle off mid-playback → audio stops
  - Send second message while first plays → second interrupts

---

## 8. Estimated Effort

### Code Changes

**1. Core playReplyTts function (src/main.ts or new src/audio/text-tts.ts)**
- Fetch `/tts` endpoint
- Set audio element src
- Handle cancel/interruption
- Clean text before posting
- **Lines: 30-40**

**2. Insert point (src/main.ts:handleReplyFinal)**
- Call `playReplyTts(finalText)` with gate check
- Catch error and diag
- **Lines: 5-8**

**3. Audio element priming (src/main.ts:sendTypedMessage)**
- Call `primeAudio(player)` in gesture context
- **Lines: 3-4**

**4. Interruption wiring**
- Settings change listener (toggle off mid-play)
- WebRTC open listener (cancel text TTS when call starts)
- Second-message handler (cancel active, start new)
- **Lines: 15-20**

**5. Text cleaning**
- Reuse existing `cleanForTts` from src/pipelines/classic/tts.ts or duplicate it
- **Lines: 0 if reused, ~30 if duplicated**

**Subtotal: ~55-75 lines of production code**

### Tests

**Smoke test harness (test/speak-replies-text.test.ts)**
- Mock setup (settings, fetch, audio element, WebRTC controls)
- 6-8 test cases (happy path, both interruption scenarios, error cases)
- **Lines: 40-50**

**Manual on-device test checklist**
- [ ] Send text msg, hear TTS (toggle on, not in call)
- [ ] Toggle off mid-audio → stops
- [ ] Send second msg while first TTS plays → interrupts
- [ ] Open call while TTS playing → TTS stops, call audio plays
- [ ] Offline → /tts fails → diag logged, no crash
- [ ] iOS Safari + Bluetooth headphones → works (primeAudio did its job)

**Subtotal: ~40-50 lines of tests + manual checklist**

### Total Estimate
- **Production:** 55-75 lines
- **Tests:** 40-50 lines + manual smoke
- **Total:** 95-125 lines + integration test coverage

**Original estimate ("~50-100 lines + smoke") is accurate.** The main variables:
- Whether we reuse `cleanForTts` or duplicate it (+30 lines if duplicate)
- Whether we build a separate text-tts.ts module or inline in main.ts (affects organization, not line count)

---

## 9. Open Questions

### Infrastructure Questions (Answerable by Code Review)

1. **primeAudio not called anywhere?** — Search confirms zero existing callers. Is gesture lock actually needed for `<audio>` playback on iOS, or only for `play()` on a specific element? The WebRTC path's peer-track audio seems to work without an explicit prime.
   - *Action:* Investigate WebRTC talk-mode iOS behavior; might reveal whether prime is actually necessary for text TTS too.

2. **cleanForTts location** — Should we reuse `src/pipelines/classic/tts.ts:cleanForTts` or duplicate it? The module lives in a WebRTC-specific path; text TTS is non-WebRTC.
   - *Action:* Move cleanForTts to `src/audio/` as a public utility, or duplicate in text-tts.ts.

3. **activeReplyTts state holder** — Where should we store the in-flight TTS object? Module-level in main.ts? Separate audio/text-tts.ts module? settings-watcher lifecycle?
   - *Action:* Design depends on whether we want text-tts.ts as a standalone module or inline in main.ts.

### Operational Questions (Requires Estimation or Product Judgment)

4. **Deepgram pricing impact** — Text TTS will add ~1 synthesis per text reply. Estimate cost delta?
   - *Action:* Check Deepgram Aura per-char pricing; run a cost projection for 100 active users, 10 replies/day avg.

5. **Latency on Pi5** — Server fetches Deepgram (40-100ms), returns mp3. Client fetches, decodes, plays. Total latency to first audio?
   - *Action:* Benchmark POST /tts round-trip on a real Pi5 with typical network (Tailscale WireGuard).

6. **Bandwidth** — mp3 blobs for typical agent replies (200-500 words). Estimated size per reply?
   - *Action:* Test a few Deepgram Aura responses; estimate 100-500 KB per reply, likely acceptable.

### Testing Questions

7. **iOS Safari + gesture window size** — How long after send() does the gesture remain valid? If agent reply takes 3-5 seconds, does the primed audio still play?
   - *Action:* Test on real iOS Safari: send, wait 5 seconds, verify TTS plays.

8. **Web Speech conflict** — Users with `ttsEngine: 'local'` use Web Speech API; does Deepgram audio playback interfere?
   - *Action:* Note as "not supported in v1 if ttsEngine='local'" and add a feature flag or setting validation if needed.

---

## 10. Implementation Checklist (Post-Research)

- [ ] Create `src/audio/text-tts.ts` with `playReplyTts(text)` function
  - [ ] POST `/tts` with text + voice setting
  - [ ] Handle blob → audio element binding
  - [ ] Cancel mechanism for interruption
  - [ ] Error handling (diag, no throw)
- [ ] Update `src/main.ts:handleReplyFinal` to call `playReplyTts()`
  - [ ] Gate: `settings.get().tts && !webrtcControls.isOpen()`
  - [ ] Catch and log errors
- [ ] Add gesture-lock prime in `sendTypedMessage`
  - [ ] Call `primeAudio(player)` in gesture context
- [ ] Wire interruption listeners
  - [ ] Settings change (toggle off)
  - [ ] WebRTC open (call starts, cancel text TTS)
  - [ ] Second message (cancel prior, start new)
- [ ] Reuse/move `cleanForTts` utility
  - [ ] Verify text cleaning before POST /tts
- [ ] Create unit tests (`test/speak-replies-text.test.ts`)
  - [ ] Mock fetch, audio element, settings, WebRTC controls
  - [ ] Test all four interruption scenarios
  - [ ] Test error cases
- [ ] Smoke test on device
  - [ ] iOS Safari + Bluetooth
  - [ ] Desktop Chrome + speakers
  - [ ] Toggle on/off mid-playback
  - [ ] Back-to-back sends (interruption)
- [ ] Update CONTRIBUTING.md audit rules (if any new modules added)

---

## Summary

The infrastructure is **mostly ready**. The `/tts` endpoint works. The `<audio>` element exists. The gesture-binding system exists but isn't being used. The "Speak replies" toggle exists.

**What's missing:** A ~60-80 line glue function (`playReplyTts`) wired into `handleReplyFinal`, with gesture-lock priming on send and four interruption rules for edge cases. Straightforward implementation, high confidence in the estimate.

**Highest risk:** iOS gesture-binding window on slow networks (reply takes 5+ seconds to arrive). Mitigation (lazy prime on send) is included in the proposal.

**Nice-to-have for v2:** Voice picker UI, streaming synthesis for lower latency, call-mode TTS cancellation on user barging (today call-mode owns audio end-to-end, no client interrupt).
