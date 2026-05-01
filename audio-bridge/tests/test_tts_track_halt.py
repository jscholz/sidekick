"""Unit tests for PCMTrack.halt() — the symmetric "stop speaking now"
primitive that mirrors the PWA-side <audio> pause on barge.

Regression target (2026-04-30 follow-up to commit 58ed68e): before
halt(), a server-side barge fired a {type:'barge'} envelope to the PWA
but the bridge's tts_track kept generating frames. tts_track.is_active()
stayed True for the TTS_TAIL_GRACE_S window (1.2s) plus however long
the synth loop kept feeding the queue, so the mic→Deepgram gate kept
substituting silence. The user couldn't be heard. The cooldown re-arm
in BargeGate let a SECOND barge fire 1.5s later — band-aid. halt() is
the structural fix: drop queued frames + flip is_active() False
immediately.
"""

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from tts_bridge import PCMTrack, TTS_FRAME_BYTES


def _frame(byte_value: int = 0x42) -> bytes:
    """A non-zero PCM frame so feed() doesn't pad it."""
    return bytes([byte_value]) * TTS_FRAME_BYTES


def test_halt_drains_frame_queue():
    track = PCMTrack()
    # Prime the queue with several frames.
    for _ in range(5):
        track.feed(_frame())
    assert track._frame_queue.qsize() == 5
    track.halt()
    assert track._frame_queue.qsize() == 0


def test_halt_flips_is_active_false_immediately():
    track = PCMTrack()
    # Simulate a recent non-silent emission — this is what makes
    # is_active() return True under normal TTS playback.
    track._last_nonsilent_at = time.monotonic()
    assert track.is_active() is True
    track.halt()
    # The TTS_TAIL_GRACE_S window would normally keep is_active() True
    # for 1.2s after the last non-silent frame. halt() must short-
    # circuit that — the mic→Deepgram gate consults this per frame
    # and we want the user heard on the very next frame.
    assert track.is_active() is False


def test_halt_sets_halt_event():
    track = PCMTrack()
    assert track.halt_event.is_set() is False
    track.halt()
    # The synth loop in _run_tts polls this between provider chunks
    # and bails. Without the event being set, halt-after-drain still
    # leaves the synth task free to refill the queue with the next
    # provider chunk before our barge envelope reaches the PWA.
    assert track.halt_event.is_set() is True


def test_halt_is_idempotent():
    track = PCMTrack()
    for _ in range(3):
        track.feed(_frame())
    track.halt()
    # A second halt() on an already-halted track must not raise and
    # must leave the track in the same halted state.
    track.halt()
    track.halt()
    assert track._frame_queue.qsize() == 0
    assert track._last_nonsilent_at is None
    assert track.halt_event.is_set() is True


def test_halt_on_empty_track_is_noop_safe():
    """Calling halt() on a fresh, never-fed track must not raise."""
    track = PCMTrack()
    track.halt()  # should not raise even though queue was already empty
    assert track._frame_queue.qsize() == 0
    assert track._last_nonsilent_at is None
    assert track.halt_event.is_set() is True


def test_halt_does_not_close_track():
    """halt() is not the same as stop(). The track must still be
    feedable + receivable after halt — this is explicitly NOT a
    teardown, just a "stop speaking right now" signal. The next
    reply round will refill the queue."""
    track = PCMTrack()
    track.halt()
    assert track._closed is False
    # After clearing the event (which _run_tts does after draining
    # the text queue), feed() should work normally for the next
    # reply round.
    track.halt_event.clear()
    track.feed(_frame())
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
