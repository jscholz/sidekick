"""Integration test: server-side barge fire → tts_track.halt() →
is_active() returns False on the next check.

Mirrors the logic in stt_bridge._pcm_iter at the gate-fire site
without spinning up the full peer connection / Deepgram WSS / synth
task. Verifies the contract that lets us drop the BargeGate cooldown:
on barge fire we halt the track, and the next per-frame poll of
is_active() must return False so the mic→Deepgram gate releases.
"""

import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from stt_bridge import BargeGate, VAD_RMS_THRESHOLD, VAD_HOLD_FRAMES
from tts_bridge import PCMTrack, TTS_FRAME_BYTES


def _frame() -> bytes:
    return b"\x42" * TTS_FRAME_BYTES


def test_barge_fire_halts_track_and_releases_mic_gate():
    """End-to-end-but-in-process: barge fires, we halt the track, and
    is_active() — which the STT bridge polls per-frame to gate
    mic→Deepgram — flips False on the next call."""
    track = PCMTrack()
    # Pre-populate the queue + last_nonsilent_at to mimic an active
    # TTS turn mid-flight.
    for _ in range(10):
        track.feed(_frame())
    track._last_nonsilent_at = time.monotonic()
    assert track.is_active() is True
    assert track._frame_queue.qsize() == 10

    # Drive a gate fire with a sustained over-threshold RMS run, the
    # exact branch the real loop takes when the user starts speaking.
    gate = BargeGate(
        threshold=VAD_RMS_THRESHOLD,
        hold_frames=VAD_HOLD_FRAMES,
    )
    fired = False
    for _ in range(VAD_HOLD_FRAMES):
        if gate.feed(VAD_RMS_THRESHOLD * 5):
            fired = True
            break
    assert fired, "expected gate to fire within hold_frames sustained over-threshold frames"

    # The bridge's response on fire: call halt() BEFORE sending the
    # barge envelope. We assert the post-halt observable state.
    track.halt()

    # Critical assertions — together these guarantee the user is heard
    # immediately on the very next mic frame:
    #   1. is_active() flips False on the next call (not after 1.2s).
    #   2. Frame queue is empty (recv() falls back to silence).
    #   3. halt_event is set (the synth loop will bail on its next
    #      provider chunk).
    assert track.is_active() is False, \
        "is_active() must flip False on the very next call post-halt"
    assert track._frame_queue.qsize() == 0, \
        "frame queue must be empty post-halt"
    assert track.halt_event.is_set(), \
        "halt_event must be set so _run_tts bails out of in-flight synth"


def test_barge_then_halt_then_next_turn_works():
    """After halt + the synth-loop's drain/clear cycle, the track
    must be ready to play TTS again on the next reply turn."""
    track = PCMTrack()
    track._last_nonsilent_at = time.monotonic()
    track.halt()
    assert track.is_active() is False
    assert track.halt_event.is_set()

    # Simulate _run_tts post-halt cleanup: drain text queue (nothing
    # to drain in this stub), clear the event.
    track.halt_event.clear()

    # Next reply round — feed should accept frames again, and the
    # next is_active() check (after a recv() emits a non-silent
    # frame, simulated here by stamping _last_nonsilent_at) should
    # return True.
    track.feed(_frame())
    track._last_nonsilent_at = time.monotonic()
    assert track.is_active() is True
    assert track._frame_queue.qsize() == 1


if __name__ == "__main__":
    import inspect
    failures = []
    test_names = [n for n, fn in globals().items()
                  if n.startswith("test_") and inspect.isfunction(fn)]
    for name in test_names:
        fn = globals()[name]
        try:
            fn()
            print(f"PASS  {name}")
        except AssertionError as e:
            failures.append((name, e))
            print(f"FAIL  {name}: {e}")
        except Exception as e:
            failures.append((name, e))
            print(f"ERROR {name}: {type(e).__name__}: {e}")
    if failures:
        sys.exit(1)
    print(f"\nall {len(test_names)} passed")
