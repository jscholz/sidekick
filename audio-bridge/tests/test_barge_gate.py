"""Unit tests for BargeGate — extracted from stt_bridge so the
hold-frames + once-per-turn re-arm logic is exercisable without
spinning up an aiortc track + PCM queue.

Semantics (post-halt refactor): the gate fires AT MOST ONCE per TTS
turn. reset_turn() — called from `_pcm_iter` on the active→inactive
transition — re-arms it. Because the fire path now calls
PCMTrack.halt() (which flips is_active() False on the very next mic
frame), reset_turn() runs almost immediately after a barge fires —
so a false-positive halt-then-reset cycle re-arms the gate before
the user's real interrupt voice arrives. Cooldown re-arm is gone;
the symmetric halt protocol replaces it.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from stt_bridge import BargeGate


def test_below_threshold_never_fires():
    gate = BargeGate(threshold=300, hold_frames=8)
    fired = [gate.feed(100) for _ in range(20)]
    assert not any(fired)


def test_above_threshold_for_too_few_frames_does_not_fire():
    gate = BargeGate(threshold=300, hold_frames=8)
    # 7 over-threshold frames followed by an under-threshold frame:
    # hold counter resets, no fire.
    fired = [gate.feed(500) for _ in range(7)]
    fired.append(gate.feed(100))
    assert not any(fired)


def test_fires_at_exactly_hold_frames():
    gate = BargeGate(threshold=300, hold_frames=8)
    fires = [gate.feed(500) for _ in range(8)]
    # The 8th feed crosses threshold and fires.
    assert fires == [False] * 7 + [True]


def test_undershoot_resets_hold_counter():
    gate = BargeGate(threshold=300, hold_frames=8)
    # 7 over, 1 under (resets), then 7 more over → no fire (hold_frames
    # not met yet on the second run since reset).
    [gate.feed(500) for _ in range(7)]
    gate.feed(100)
    fires = [gate.feed(500) for _ in range(7)]
    assert not any(fires)
    # 8th over-threshold frame after reset — fires.
    assert gate.feed(500) is True


def test_fires_only_once_per_turn():
    """After a fire, the gate stays consumed until reset_turn().
    A sustained over-threshold run must NOT keep firing every frame."""
    gate = BargeGate(threshold=300, hold_frames=4)
    fires_a = [gate.feed(500) for _ in range(4)]
    assert fires_a == [False, False, False, True]

    # Continue feeding over-threshold for many more frames — should
    # not refire. The bridge's halt() + reset_turn() cycle is the
    # only legitimate path back to an armed gate.
    fires_b = [gate.feed(500) for _ in range(50)]
    assert not any(fires_b), f"gate refired without reset_turn: {fires_b}"


def test_reset_turn_rearms_gate():
    gate = BargeGate(threshold=300, hold_frames=4)
    # Fire once.
    [gate.feed(500) for _ in range(4)]

    # Reset the turn: gate should re-arm.
    gate.reset_turn()

    # A fresh sustained run should fire on the 4th frame.
    fires = [gate.feed(500) for _ in range(4)]
    assert fires == [False, False, False, True]


def test_reset_turn_clears_hold_counter():
    """reset_turn() must clear the hold counter as well as the
    fired-this-turn flag, so a sustained voice that crossed the
    threshold mid-turn doesn't immediately fire on the next turn."""
    gate = BargeGate(threshold=300, hold_frames=4)
    # Build hold to 3 (one short of fire).
    [gate.feed(500) for _ in range(3)]
    assert gate._hold == 3

    gate.reset_turn()
    assert gate._hold == 0

    # First over-threshold frame post-reset must NOT fire (hold_frames
    # is 4, hold is now 1).
    assert gate.feed(500) is False


if __name__ == "__main__":
    # Run all tests in this file.
    import inspect
    failures = []
    for name, fn in list(globals().items()):
        if name.startswith("test_") and inspect.isfunction(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as e:
                failures.append((name, e))
                print(f"FAIL  {name}: {e}")
    if failures:
        sys.exit(1)
    print(f"\nall {sum(1 for n in globals() if n.startswith('test_'))} passed")
