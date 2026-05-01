# Pocketlock Waveform on iOS — System Analysis & Hypotheses

Date: 2026-04-30 overnight pass
Bug: The fakeLock fullscreen overlay shows a waveform from the live mic. Works on desktop. Does NOT work on iOS PWA.

## System overview

### Pocketlock entry

Triggered by user tapping the lock button (handler in `src/main.ts`). Calls `fakeLock.show()`:
- `src/ios/fakeLock.ts:102-128` — show() runs after the click event has already fired. By the time show() executes, the gesture window may still be open, but `startMeter()` (line 125) → `attachMicAnalyserWhenReady(0)` will then poll asynchronously every 250ms.

### Mic stream acquisition

- `webrtc.getMicStream()` (`src/pipelines/webrtc/connection.ts:161`) returns the active session's `micStream` (line 162), populated by `getUserMedia` at line 219.
- The stream is acquired with `echoCancellation: false, noiseSuppression: false, autoGainControl: false` (lines 220-224) — bridge handles AEC server-side.
- `getMicStream()` returns `null` until a call has started (`active?.micStream ?? null` falls back to null when no session).

### Waveform wiring

`attachMicAnalyserWhenReady(attempt)` (`src/ios/fakeLock.ts:249`):
1. If `analyser` already wired or overlay closed → return.
2. Fetch stream via `getMicStream()`. If null or no audio tracks: poll up to 20 attempts (~5s).
3. When stream is available:
   - Try shared `getAudioCtx()` from `audio-unlock.ts:16`. **On iOS, this is non-null only if `unlock()` has fired in a prior gesture** (e.g. memo button, send button, etc.).
   - **Fallback**: if `getAudioCtx()` is null, lazily create `meterCtx = new AudioContext()` (lines 261-264) — this is the path my recent fix took.
   - `ctx.createMediaStreamSource(stream)` (line 271).
   - `analyser = ctx.createAnalyser()`, fftSize = 256.
   - Connect: source → analyser. **Does NOT connect analyser to ctx.destination** (would loop mic to speaker).
4. `requestAnimationFrame(drawMeter)` runs `analyser.getByteTimeDomainData(data)` per frame to compute RMS bar.

### Why desktop works

- Chrome/Firefox don't enforce gesture-bound AudioContext.
- `new AudioContext()` is immediately in `running` state.
- `createMediaStreamSource` yields frames immediately, and the analyser produces data.

### Why iOS likely fails

#### H1 (most likely): meterCtx created outside a gesture stays suspended

iOS Safari requires AudioContext to be created (or resumed) inside a user-gesture event handler. The fakeLock flow:
1. User clicks lock button → click handler runs → `fakeLock.show()` → `startMeter()` → `attachMicAnalyserWhenReady(0)`.
2. attempt=0: `getMicStream()` likely returns null on the FIRST call when no call is active; polling kicks in.
3. By the time the WebRTC call has started and `getMicStream()` returns non-null, the original click gesture is **long gone**.
4. Line 263: `meterCtx = new AudioContext()` runs WITHOUT a gesture → on iOS, `meterCtx.state === 'suspended'`.
5. `createMediaStreamSource` succeeds, but the source yields no data while the context is suspended.
6. `analyser.getByteTimeDomainData()` returns the silent default (128 = midpoint) every frame → RMS ≈ 0 → bars stay at minimum height.

**Predicted observation**: The waveform shows the BARS draw cycle running but the bars themselves are at their minimum height (`Math.max(4, amp * h * 4)` with amp ≈ 0 → bar of 4px).

**Audio-unlock.ts:101-108 has a defender**: On `visibilitychange` to visible, it calls `audioCtx.resume()` — but this is `audioCtx` from `audio-unlock.ts`, NOT the `meterCtx` from fakeLock. So the meterCtx stays suspended.

#### H2 (medium likely): iOS rejects createMediaStreamSource on a stream owned by a peer connection

The mic MediaStream comes from `getUserMedia` and was added to `pc.addTrack` (connection.ts:241). On iOS, the same `MediaStream` may be exclusively bound to the WebRTC audio route. Creating a Web Audio source from that same stream in a different AudioContext can fail silently (no exception, but the source produces no frames).

**Predicted observation**: source / analyser objects created without throwing, but no frames flow.

**Counter-evidence**: This pattern works in webRTC examples on the web. iOS isn't documented as forbidding this.

#### H3 (low likely): the WebRTC track is muted by AEC interaction

Even with `echoCancellation: false`, iOS Safari may apply a system-level AEC pass on WebRTC tracks. When the assistant is speaking via the remote audio element, iOS may mute or duck the mic track to prevent loopback. So during TTS playback, the meter shows nothing — but during silence, it should still show user voice.

**Predicted observation**: Meter dead during TTS, alive during silent moments. Doesn't match the user's "doesn't work on iOS" if the user expected it to show during their own voice.

## What we ruled out

- `getMicStream()` returning null forever: polling ramps up to 20 attempts; by the time the user sees no waveform, the call has likely connected and the stream IS available.
- DOM canvas not initialized: works on desktop with same DOM, so the canvas + drawMeter pipeline is fine.

## Most likely root cause

**H1**: meterCtx is created outside a gesture → suspended on iOS → analyser yields zeros → flat waveform.

The desktop "fix" I applied earlier silently regressed iOS by introducing a non-gesture AudioContext that iOS treats as suspended.

## Testability assessment

**Cannot reproduce in Playwright Chromium harness**:
- Chromium does not enforce gesture-bound AudioContext.
- iOS-specific suspension semantics aren't replicated.
- A Playwright test that "waveform shows non-zero amplitude given a synthetic mic stream" would PASS in Chromium even with the iOS bug present.

**What CAN be tested in Chromium**:
- "Given fakeLock active + a mock MediaStream with audio frames, attachMicAnalyserWhenReady wires an analyser." This catches the wiring regression (e.g. if the polling loop never fires) but not the iOS-specific suspension issue.

**Recommendation**: Skip writing a Playwright test for this one. The fix is iOS-specific and must be verified on-device. Document the on-device test plan in the overnight report and ship a candidate fix for Jonathan to verify in the morning.

## Recommended fix direction

Three approaches in order of preference:

### Option A: Resume meterCtx on creation (cheapest)

After `new AudioContext()` at line 263, immediately call `meterCtx.resume()`. iOS allows resume() to succeed in the AudioContext-already-touched-by-prior-gesture window (audio-unlock has likely run by the time pocketlock shows, since the user must have touched something to navigate to the screen).

```ts
if (!meterCtx) {
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  meterCtx = new AC();
  // iOS: a resume() call here may succeed if any prior gesture in the
  // page has already touched audio — the audio-unlock flow runs on
  // first send / first memo.
  meterCtx.resume().catch(() => {});
}
ctx = meterCtx;
```

Risk: low. resume() is idempotent and harmless on desktop.

### Option B: Force unlock() before show() (cleaner)

Make the lock-button click handler in main.ts call `audioUnlock.unlock(player)` BEFORE `fakeLock.show()`. The lock click IS a user gesture, so unlock will succeed and `getAudioCtx()` will return a running context. Then attachMicAnalyserWhenReady picks up the shared context (the existing line 259 `let ctx = getAudioCtx()` already prefers the shared context).

Risk: low. Unlocks the shared context whether it's wanted or not, but `unlock()` is idempotent (line 36).

### Option C: Move waveform metering to an AudioWorklet (overkill)

Stream the analyser data through an AudioWorklet that runs in the audio rendering thread, dodging the suspended-state issue. Way more complex than necessary.

**Pick Option A + B together**: A is a defensive guard inside fakeLock; B ensures the shared context is available when show() runs. Both are small, safe, additive.

## Files of interest

- `src/ios/fakeLock.ts:102-128` — show()
- `src/ios/fakeLock.ts:227-289` — startMeter / attachMicAnalyserWhenReady (meterCtx fallback at 261-264)
- `src/ios/audio-unlock.ts:11-69` — gesture-bound AudioContext + resume
- `src/ios/audio-unlock.ts:101-108` — visibility-change resume defender (covers audioCtx, NOT meterCtx)
- `src/pipelines/webrtc/connection.ts:161-163` — getMicStream
- `src/pipelines/webrtc/connection.ts:219-225` — getUserMedia constraints
