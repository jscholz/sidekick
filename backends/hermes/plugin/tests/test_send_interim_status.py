"""``ParleyAdapter.send()`` mid-turn semantics (field 2026-09-05).

Hermes' gateway routes three kinds of mid-turn output through the
adapter's ``send()`` (we deliberately don't implement ``edit_message``):

* the progress heartbeat ``⏳ Working — N min — iteration i/n, tool``
  (marked with ``_interim_send`` metadata),
* the inactivity warning (also marked interim),
* the agent's own holding replies (NOT marked).

Before this change every send() in a turn returned the SAME reserved
``msg_*`` id, so each later send edited the earlier bubble and the
holding reply vanished when the real reply landed. Heartbeats rendered
as bubbles, pushed to the phone and auto-dismissed pending approvals.

Now: heartbeats become an ephemeral ``status`` envelope keyed per chat;
the reservation is consumed on first use so each send owns a bubble;
interim advisories carry ``interim: true`` and never take the reserved id.
"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_user_message_broadcast import _load_plugin, _make_adapter  # noqa: E402


@pytest.fixture(scope="module")
def plugin():
    return _load_plugin()


def _adapter(plugin):
    adapter = _make_adapter(plugin)
    adapter._turn_buffer = None
    sent: list[dict] = []

    async def capture(env):
        sent.append(dict(env))
        return True

    adapter._safe_send_envelope = capture
    return adapter, sent


def test_heartbeat_regex_matches_both_gateway_formats(plugin):
    disp = importlib.import_module("plugin.parley_dispatcher")
    assert disp.is_progress_heartbeat("⏳ Working — 3 min — iteration 4/60, terminal")
    assert disp.is_progress_heartbeat("⏳ Working — 1 min")
    assert disp.is_progress_heartbeat("⏳ Still working… (3 min elapsed — iteration 4/60, tool)")
    assert not disp.is_progress_heartbeat("Working on it, back shortly.")
    assert not disp.is_progress_heartbeat("⚠️ No activity for 5 min.")
    assert not disp.is_progress_heartbeat("")
    assert not disp.is_progress_heartbeat(None)  # type: ignore[arg-type]


def test_heartbeat_becomes_status_envelope_not_a_bubble(plugin):
    adapter, sent = _adapter(plugin)
    adapter._reserve_response_message_id("c1", "msg_reserved")

    res = asyncio.run(adapter.send(
        "c1", "⏳ Working — 3 min — iteration 4/60, terminal",
        metadata={"_interim_send": True},
    ))

    assert res.success
    assert res.message_id == "status_c1"
    assert [e["type"] for e in sent] == ["status"]
    env = sent[0]
    assert env["message_id"] == "status_c1"
    assert env["state"] == "working"
    assert env["should_push"] is False
    assert env["text"].startswith("⏳ Working")
    # A heartbeat must not consume the turn's reserved reply id.
    assert adapter._response_message_ids == {"c1": "msg_reserved"}

    # Second beat (gateway's edit_message fell back to send again):
    # same key, so the PWA replaces the indicator text in place.
    asyncio.run(adapter.send("c1", "⏳ Working — 4 min — iteration 5/60, terminal"))
    assert sent[1]["message_id"] == "status_c1"


def test_each_send_in_a_turn_gets_its_own_bubble(plugin):
    adapter, sent = _adapter(plugin)
    adapter._reserve_response_message_id("c1", "msg_reserved")

    first = asyncio.run(adapter.send("c1", "On it — checking the logs now."))
    second = asyncio.run(adapter.send("c1", "Found it: the cron was paused."))

    # First (unmarked) send takes the OAI item id, consuming the reservation.
    assert first.message_id == "msg_reserved"
    assert adapter._response_message_ids == {}
    # The next one mints its own id instead of editing the first bubble.
    assert second.message_id != "msg_reserved"
    assert second.message_id.startswith("msg_")
    ids = [e["message_id"] for e in sent]
    assert ids == ["msg_reserved", "msg_reserved", second.message_id, second.message_id]
    assert all("interim" not in e for e in sent)
    # The route's own finally-release is a no-op now, not an error.
    adapter._release_response_message_id("c1", "msg_reserved")


def test_interim_advisory_never_takes_reserved_id_and_is_flagged(plugin):
    adapter, sent = _adapter(plugin)
    adapter._reserve_response_message_id("c1", "msg_reserved")

    warn = asyncio.run(adapter.send(
        "c1", "⚠️ No activity for 5 min. If the agent does not respond soon…",
        metadata={"_interim_send": True},
    ))
    final = asyncio.run(adapter.send("c1", "Done."))

    assert warn.message_id != "msg_reserved"
    assert sent[0]["type"] == "reply_delta" and sent[0]["interim"] is True
    assert sent[1]["type"] == "reply_final" and sent[1]["interim"] is True
    # The real reply still gets the reserved id.
    assert final.message_id == "msg_reserved"
    assert "interim" not in sent[2] and "interim" not in sent[3]


def test_send_without_reservation_mints_fresh_ids(plugin):
    adapter, sent = _adapter(plugin)
    a = asyncio.run(adapter.send("c9", "hello"))
    b = asyncio.run(adapter.send("c9", "world"))
    assert a.message_id != b.message_id
    assert a.message_id.startswith("msg_") and b.message_id.startswith("msg_")
