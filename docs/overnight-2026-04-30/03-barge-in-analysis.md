# Barge-In Bug Root-Cause Analysis

**Date:** 2026-04-30 | **User Report:** Barge-in self-triggered on own playback (desktop), failed to stop when user interrupted (iOS). Sensitivity: 60%.

---

## System Overview: Barge-In Pipeline End-to-End

The barge-in (interrupt-while-TTS-playing) system is **entirely server-side** as of the current architecture.

### Signal Path:

1. **Mic → WebRTC → Bridge:**
   - PWA requests mic via `getUserMedia({echoCancellation: false, noiseSuppression: false, autoGainControl: false})` in `src/pipelines/webrtc/connection.ts:219-224`.
   - Raw PCM flows over the WebRTC audio track to the audio bridge.

2. **Bridge-Side Audio Pipeline (`audio-bridge/stt_bridge.py`):**
   - The pump task (`_pump_audio`, line 148) receives Opus-decoded frames from the inbound track.
   - Resamples to 16 kHz mono int16 PCM.
   - Feeds a queue to the STT task (`_run_stt`, line 204).

3. **Bridge-Side Barge Detection (`_run_stt`, line 249-347):**
   - **VAD Logic** (lines 301–320):
     - When `tts_track.is_active()` is true AND `barge_fired_this_turn` flag is false:
       - Compute RMS of the 20 ms frame via `_frame_rms(chunk)` (line 286, defined at line 369).
       - Compare RMS against `VAD_RMS_THRESHOLD` (default 300, line 91, tunable via env var).
       - If RMS ≥ threshold, increment `vad_hold`.
       - If `vad_hold >= VAD_HOLD_FRAMES` (default 8 = 160 ms), fire barge exactly once: set `barge_fired_this_turn = True`, send `{"type": "barge"}` to PWA data channel, reset `vad_hold`.
       - If RMS < threshold, reset `vad_hold` to 0.
   - **Echo Suppression During TTS** (line 321): While TTS is active, yield `silence_frame` (640 bytes of zeros) instead of real mic PCM, so Deepgram sees clean silence.

4. **PWA-Side Barge Handler (`src/main.ts`, line 923–930):**
   - On `{type: 'barge'}` data channel message:
     - Call `webrtcConnection.cancelRemotePlayback()` (pauses + nulls `srcObject` of the `<audio>` element).
     - Call `webrtcSuppress.onBarge()` to clear user-transcript suppression.

5. **Transcript Suppression (`src/pipelines/webrtc/suppress.ts`):**
   - While TTS is active, suppress incoming user transcripts (lines 51–54).
   - Clear suppression on barge (line 72), or after TTS final + grace period (lines 57–66, grace = 1200 ms).
   - **Rationale:** iOS speakerphone + mic re-captures assistant's TTS as mic input; Deepgram transcribes it as fake "user" text. Suppression blocks these ghost transcripts unless barge fires (real user voice).

---

## Symptom 1: Self-Trigger

**Observation:** Barge fired on the assistant's own playback (desktop, not speakerphone-specific). The system mistook TTS audio looping back into the mic as user voice.

### Hypotheses:

#### A. **Missing Echo Cancellation at Capture Stage**
- **File reference:** `src/pipelines/webrtc/connection.ts:219-224` disables `echoCancellation: false`.
- **Why:** Code comment (lines 198–217) justifies this: server-side gate in the bridge substitutes silence frames during TTS, and browser AEC would reduce (not eliminate) the remaining mic signal anyway.
- **Problem:** This assumes the **bridge's TTS gating is bulletproof**. If the bridge ever misses a frame or the gating logic fails, raw TTS echo hits the STT provider uncancelled.
- **Evidence:** Memo in `reference_sidekick_voice_architecture.md` (line 31) states "Browser AEC nukes user voice during TTS" — so the bridge chose to disable it entirely and gate server-side.

#### B. **Gating Logic Race Condition or Timing Hole**
- **File reference:** `audio-bridge/stt_bridge.py:277-321` checks `tts_track.is_active()` once per frame.
- **Problem:** Between the time the bridge receives a PCM frame and the moment it checks `tts_track.is_active()`, the TTS track state could flip. Or the TTS track's `.is_active()` method lags reality (buffered audio in flight).
- **Scenario:** TTS playback just started on the outbound track, but `.is_active()` hasn't flipped true yet. A few frames of unsilenced TTS echo slip through, accumulating enough RMS to fire barge.
- **Timing:** TTS audio is typically buffered; the bridge may not know immediately when speech is about to play.

#### C. **Threshold Too Low (60% Sensitivity)**
- **File reference:** `SIDEKICK_VAD_RMS_THRESHOLD = int(os.environ.get("SIDEKICK_VAD_RMS_THRESHOLD", "300"))` (line 91).
- **Problem:** User set sensitivity to 60%, presumably a UI control that lowers the threshold. At 60% of default 300 = RMS 180.
  - Normal speech: 1000–3000 RMS.
  - Ambient room noise: 80–300 RMS.
  - **At 180, the threshold is actually in the noise floor.** Any crackle, hum, or bleed will trigger vad_hold.
- **Desktop echo scenario:** If OS audio loopback is enabled (some recording apps, VB-Audio, etc.), TTS → speaker → mic at reduced volume may hit 180–300 RMS.
- **File reference:** `reference_sidekick_voice_architecture.md` (line 51) notes "User normal speech ≈ 1000–3000" but doesn't warn about going below 300 (0% UI).

#### D. **Reference Signal Not Subtracted Pre-Bridge**
- **File reference:** `audio-bridge/stt_bridge.py:24` mentions "raw pre-DSP PCM" — the bridge sees the mic before any OS-level echo cancellation or loopback suppression.
- **Problem:** On desktop, some platforms (macOS, Windows with certain audio routing) allow system audio to bleed into the mic input natively, outside the browser's control. There's no reference signal for the bridge to subtract.
- **Detail:** The silence-swap gating assumes the bridge **knows** when TTS is playing. But if the outbound audio track's buffering or activation lags, TTS audio plays before the bridge swaps to silence.

#### E. **Undetected Loopback from Speaker → Mic During Non-TTS**
- **Problem:** If the user has a physical audio loopback (speaker and mic both picking up room audio), or if the browser's audio output is bleeding into the mic input at the OS level, the bridge can't distinguish "system TTS" from "room noise" during TTS-active windows.
- **Implication:** TTS_track.is_active() = true, but the RMS spike detected is actually room reverberation or previous speech, not the TTS itself.

---

## Symptom 2: Manual Stop Fails

**Observation:** User spoke to interrupt (barge), but the system didn't stop the TTS. The manual interrupt failed even though barge should have fired.

### Hypotheses:

#### A. **Threshold Too High for Real User Voice**
- **Scenario:** Sensitivity 60% = RMS threshold ~180 (assuming 0% = no threshold, 100% = 300).
  - But comment at line 51 of `reference_sidekick_voice_architecture.md` says "User normal speech ≈ 1000–3000."
  - **At sensitivity 60%, threshold is half the default 300 = 150.** This should be well below normal speech.
  - **Unless:** The UI's 60% is inverted (high sensitivity = high threshold?), or the scaling is non-linear.
  - **File reference:** Check `src/settings.ts` for how sensitivity maps to `SIDEKICK_VAD_RMS_THRESHOLD`.

#### B. **Wrong Audio Stream Being Analyzed**
- **Scenario:** The bridge analyzes `pcm_q` (the incoming WebRTC track), but iOS AEC is applied **inside the WebRTC peer connection** before the audio pump sees it.
  - **File reference:** `src/pipelines/webrtc/connection.ts:204-210` notes "Browser AEC actively REDUCES the mic signal whenever it correlates with system output."
  - **Problem:** If the iOS WebRTC stack applies AEC, the pump receives attenuated frames. Even a loud user voice becomes ~140 RMS (line 209), well below any reasonable threshold.
  - **Architecture conflict:** PWA disables browser AEC (line 221), but on iOS, `getUserMedia` + WebRTC might still apply platform-level AEC before the browser even sees it.

#### C. **VAD Hold Counter Requires 160 ms of Continuous Speech**
- **File reference:** `VAD_HOLD_FRAMES = 8` (line 96), 20 ms per frame = 160 ms total.
- **Problem:** User says "stop" = ~300–500 ms of speech. Should easily exceed 160 ms.
  - **Unless:** The frame-by-frame RMS is noisy. If speech has dips (plosives, vowel breaks), some frames might drop below threshold, resetting `vad_hold` to 0. With a short utterance like "stop," this could prevent ever reaching 8 frames.
  - **File reference:** No smoothing or hysteresis on the RMS reading; every frame is independent (line 309).

#### D. **Barge Already Fired, Won't Fire Again**
- **File reference:** `if not peer.extra.get("barge_fired_this_turn"):` (line 308).
- **Problem:** Once barge fires during a TTS turn, it won't fire again until TTS ends (line 334).
  - **Scenario:** TTS turn is playing. At t=0, a sound (noise, echo, user) triggers barge. PWA cancels playback. But TTS track is still `is_active()` (buffered audio in flight). User speaks again at t=2s, but barge won't fire because `barge_fired_this_turn` is already true.
  - **Implication:** User's real interruption is ignored because the system already fired barge once and is waiting for TTS to fully end.
- **Fix would require:** Resetting `barge_fired_this_turn` when barge is actually acted upon (PWA sends a signal back), or increasing the gate to "barge can fire at most once per 500 ms" rather than "once per turn."

#### E. **TTS Playback Not Actually Aborting**
- **File reference:** `src/pipelines/webrtc/connection.ts:168-172` shows `cancelRemotePlayback()`:
  ```typescript
  export function cancelRemotePlayback(): void {
    if (!active?.remoteAudio) return;
    try { active.remoteAudio.pause(); } catch { /* ignore */ }
    try { active.remoteAudio.srcObject = null; } catch { /* ignore */ }
  }
  ```
- **Problem:** This pauses and clears the `<audio>` element, but:
  - `<audio autoplay>` on iOS may have its own playback queue or buffering.
  - Setting `srcObject = null` while autoplay is true might not stop buffered frames.
  - The try/catch swallows exceptions, so if pause() throws on iOS (e.g., permission denied), it silently fails.
- **File reference:** `src/pipelines/webrtc/connection.ts:264-280` sets up the remote audio element with `autoplay = true`. On iOS, autoplay has special handling; pausing may not be immediate.

#### F. **Data Channel Delivery Race**
- **Scenario:** Barge message is sent but doesn't arrive at the PWA before the next TTS turn completes.
  - **File reference:** `audio-bridge/stt_bridge.py:317` calls `_send_data_channel(peer, {"type": "barge"})`.
  - **File reference:** `src/main.ts:923` handler checks `if (ev.type === 'barge')`.
  - **Problem:** If the data channel is congested or lossy, the barge message might be dropped or delayed. The PWA's handler never runs.

---

## Symptom Analysis: Same Root Cause or Different?

**Sensitivity 60%:** If this is a linear 0–100% control where 0% = 300 RMS and 100% = 0 RMS (max sensitivity = no threshold), then 60% = 120 RMS. This is **below the noise floor** (80–300 ambient). **Symptom 1 (self-trigger) is almost guaranteed at this setting.**

**For symptom 2 (real user voice not interrupting):** At 120 RMS threshold, normal speech (1000–3000) should easily exceed it. Unless:
- The iOS WebRTC stack applies platform-level AEC that the PWA's `echoCancellation: false` constraint doesn't disable (Hypothesis B above).
- The user was speaking very softly (unlikely for an "interrupt" action).
- Barge already fired on echo in symptom 1, and the once-per-turn gate prevented it from firing again on real voice (Hypothesis D).

**Likely unified root cause:** The sensitivity slider at 60% sets the threshold to unsafe low levels. This causes:
1. Echo/noise from TTS easily clears the threshold → self-trigger (symptom 1).
2. OR, barge fires on false positive, then when real user voice arrives, the once-per-turn gate is already consumed (symptom 1 shadows symptom 2).
3. AND/OR, iOS platform AEC is applied below the PWA's control, silencing real user voice to <120 RMS, so it never triggers barge even if the gate were open.

---

## Are These the Same Root Cause or Different?

**Likely the same underlying issue: invalid threshold + architecture assumption mismatch.**

- **Primary cause:** Sensitivity 60% = ~120 RMS threshold, which is in the ambient noise floor.
- **Compounding factor:** Once-per-turn barge gate means the first false-positive (echo) consumes the barge event for the entire TTS turn.
- **Secondary cause (iOS only):** Platform-level AEC silences the user's voice below any safe threshold, preventing legitimate barge even if the gate were available.

---

## Testability Assessment

### What CAN be tested:

1. **Threshold mapping:** Write a unit test that confirms the UI sensitivity slider (0–100%) maps to the correct RMS threshold range. Verify that 60% doesn't go below 300 (the safe floor for noise).
2. **RMS computation:** Test `_frame_rms(pcm)` (line 369) with synthetic 16-bit PCM samples of known amplitude to verify the math.
3. **VAD state machine:** Unit test the hold counter logic (lines 309–320) with mock RMS values, confirming it fires only after VAD_HOLD_FRAMES consecutive over-threshold frames.
4. **Barge once-per-turn gate:** Verify the `barge_fired_this_turn` flag (line 316, reset at line 334) behaves correctly across simulated TTS-end transitions.
5. **Data channel delivery:** Trace logs to confirm barge envelopes are actually sent and received.
6. **Silence gating:** Check that the silence-frame substitution (line 321) is working by comparing Deepgram transcripts when TTS is on vs. off.

### What CAN'T be easily tested (requires on-device):

1. **iOS platform-level AEC:** Whether iOS's WebRTC or AVAudioSession applies AEC below the browser's constraints. Needs real device with iOS STT.
2. **Desktop audio loopback:** Whether the user's recording setup (VB-Audio, Loopback, OBS) is allowing TTS to bleed into the mic. Requires reproducing the user's exact desktop setup.
3. **Actual TTS audio buffering lag:** Whether the bridge's `tts_track.is_active()` check lags the actual audio playback by enough frames for echo to slip through. Needs instrumentation on the actual peer connection.
4. **iOS autoplay + pause behavior:** Whether `<audio>` pause() on iOS actually stops buffered playback or if it continues. Requires iOS device testing.

---

## Recommended Fix Direction

1. **Clamp the sensitivity slider to a safe minimum.** Set the lower bound (0% sensitivity) to RMS 500, not 300. Adjust the upper bound (100% sensitivity) to RMS 200 if needed, but never go below 300. Verify in `src/settings.ts` and the UI.

2. **Implement multi-turn barge gating.** Instead of "once per TTS turn," allow barge to fire again if there's a silence gap (e.g., >500 ms below threshold) in the middle of a TTS playback. This prevents the once-per-gate-consumed issue when echo fires first, then real voice arrives.

3. **Add a noise floor learning step at call startup.** Have the bridge measure ambient RMS for the first 100 ms while TTS is off, then set VAD_RMS_THRESHOLD to 3x the measured ambient. This auto-tunes sensitivity to the user's environment and prevents both false positives and false negatives.

---

**Investigation Status:** Ready for user confirmation on sensitivity UI behavior and on-device iOS testing.
