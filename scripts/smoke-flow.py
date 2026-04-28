#!/usr/bin/env python3
"""End-to-end smoke for the hermes-gateway PWA flow.

Drives the same HTTP surface the PWA uses — fresh chat_id, persistent
SSE listener, fire-and-forget POSTs — and asserts the agent's replies
appear on the SSE stream within a reasonable window. Run against a
live blueberry deployment to verify the round-trip without browser
involvement.

Exit code 0 on success; 1 with diagnostic output otherwise. Prints a
running narrative so partial failures are obvious.
"""
from __future__ import annotations

import argparse
import http.client
import json
import queue
import re
import sys
import threading
import time
import urllib.parse
import uuid


def parse_sse_event(buf: str) -> dict | None:
    """Parse one SSE event block (already split on \n\n) into a dict
    with `event` and `data` (parsed JSON if possible)."""
    out: dict = {"event": "message", "data": None, "id": None}
    raw_data: list[str] = []
    for line in buf.splitlines():
        if not line or line.startswith(":"):
            continue
        if line.startswith("event:"):
            out["event"] = line[6:].strip()
        elif line.startswith("data:"):
            raw_data.append(line[5:].lstrip())
        elif line.startswith("id:"):
            out["id"] = line[3:].strip()
    if not raw_data:
        return None
    raw = "\n".join(raw_data)
    try:
        out["data"] = json.loads(raw)
    except Exception:
        out["data"] = raw
    return out


def stream_reader(host: str, port: int, q: queue.Queue, stop: threading.Event,
                  log_prefix: str) -> None:
    """Persistent GET on /api/sidekick/stream — pushes parsed events
    onto `q`. Reconnects on transient failure."""
    while not stop.is_set():
        try:
            conn = http.client.HTTPConnection(host, port, timeout=120)
            conn.request("GET", "/api/sidekick/stream",
                         headers={"Accept": "text/event-stream"})
            resp = conn.getresponse()
            if resp.status != 200:
                print(f"{log_prefix} stream HTTP {resp.status}; retry in 1s")
                time.sleep(1.0)
                continue
            buf = ""
            while not stop.is_set():
                chunk = resp.read1(2048)
                if not chunk:
                    break
                buf += chunk.decode("utf-8", errors="replace")
                while "\n\n" in buf:
                    block, _, buf = buf.partition("\n\n")
                    evt = parse_sse_event(block)
                    if evt is not None:
                        q.put(evt)
            conn.close()
        except Exception as exc:
            if not stop.is_set():
                print(f"{log_prefix} stream error: {exc}; retry")
                time.sleep(0.5)


def post_message(host: str, port: int, chat_id: str, text: str) -> dict:
    """POST /api/sidekick/messages — fire-and-forget. Returns the JSON ack."""
    body = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
    conn = http.client.HTTPConnection(host, port, timeout=10)
    conn.request("POST", "/api/sidekick/messages", body=body,
                 headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8")
    conn.close()
    if resp.status != 202:
        raise RuntimeError(f"POST returned {resp.status}: {raw[:200]}")
    return json.loads(raw)


def collect_until(q: queue.Queue, chat_id: str,
                  pred, timeout_s: float) -> list[dict]:
    """Drain queue until `pred(events_so_far)` returns truthy or timeout.
    Filters to events matching `chat_id`. Returns the chat-tagged list."""
    deadline = time.time() + timeout_s
    seen: list[dict] = []
    while time.time() < deadline:
        remaining = deadline - time.time()
        try:
            evt = q.get(timeout=max(0.1, remaining))
        except queue.Empty:
            break
        data = evt.get("data") or {}
        if not isinstance(data, dict):
            continue
        if data.get("chat_id") != chat_id:
            continue
        seen.append(evt)
        if pred(seen):
            return seen
    return seen


def has_reply_final(events: list[dict]) -> bool:
    return any(e.get("event") == "reply_final" for e in events)


def has_two_reply_finals(events: list[dict]) -> bool:
    return sum(1 for e in events if e.get("event") == "reply_final") >= 2


def has_tool_round_trip(events: list[dict]) -> bool:
    calls = {(e.get("data") or {}).get("call_id")
             for e in events if e.get("event") == "tool_call"}
    results = {(e.get("data") or {}).get("call_id")
               for e in events if e.get("event") == "tool_result"}
    return bool(calls) and bool(calls & results) and has_reply_final(events)


def render(events: list[dict]) -> str:
    """One-line-per-event summary of what arrived for diagnostics."""
    lines: list[str] = []
    for e in events:
        d = e.get("data") or {}
        t = e.get("event", "?")
        if t == "reply_delta":
            txt = (d.get("text") or "")[:60].replace("\n", " ")
            lines.append(f"  [reply_delta msg={d.get('message_id')}] {txt!r}")
        elif t == "reply_final":
            lines.append(f"  [reply_final msg={d.get('message_id')}]")
        elif t == "tool_call":
            args_repr = json.dumps(d.get("args") or {}, default=str)[:80]
            lines.append(f"  [tool_call call={d.get('call_id')} {d.get('tool_name')}({args_repr}…)]")
        elif t == "tool_result":
            res = (d.get("result") or "")[:60].replace("\n", " ")
            err = d.get("error")
            lines.append(f"  [tool_result call={d.get('call_id')} dur={d.get('duration_ms')}ms err={err!r}] {res!r}")
        elif t == "typing":
            lines.append(f"  [typing]")
        elif t == "session_changed":
            lines.append(f"  [session_changed title={d.get('title')!r} session={d.get('session_id')}]")
        else:
            lines.append(f"  [{t}] {json.dumps(d)[:80]}")
    return "\n".join(lines) if lines else "  (no events for this chat)"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3001)
    ap.add_argument("--memory-prompt",
                    default="What do you remember about apples? Use the recall_memory tool.",
                    help="Prompt that should trigger a tool call.")
    ap.add_argument("--turn-timeout", type=float, default=60.0,
                    help="Seconds to wait per turn before giving up.")
    ap.add_argument("--keep-chat", action="store_true",
                    help="Don't print the chat_id banner (useful for piping).")
    args = ap.parse_args()

    chat_id = str(uuid.uuid4())
    print(f"=== sidekick smoke flow — chat_id={chat_id} ===")
    print(f"persistent stream: http://{args.host}:{args.port}/api/sidekick/stream")
    print()

    q: queue.Queue = queue.Queue()
    stop = threading.Event()
    reader = threading.Thread(target=stream_reader,
                              args=(args.host, args.port, q, stop, "[sse]"),
                              daemon=True)
    reader.start()

    # Give the SSE channel a beat to subscribe before posting the first
    # message, so we don't miss the home-channel nudge bubble.
    time.sleep(0.5)

    failures: list[str] = []

    # ── Turn 1: simple greeting ────────────────────────────────────────
    print("--- turn 1: 'hi' ---")
    ack = post_message(args.host, args.port, chat_id, "hi")
    print(f"POST ack: {ack}")
    # Expect TWO reply_finals on a fresh chat: home-channel nudge + agent reply.
    events = collect_until(q, chat_id, has_two_reply_finals, args.turn_timeout)
    print(render(events))
    finals = [e for e in events if e.get("event") == "reply_final"]
    if len(finals) < 2:
        failures.append(f"turn 1: expected 2 reply_finals (nudge + agent), got {len(finals)}")
    elif not any("text" in (e.get("data") or {}) and "No home channel" in ((e.get("data") or {}).get("text") or "")
                 for e in events if e.get("event") == "reply_delta"):
        failures.append("turn 1: home-channel nudge missing — bubble routing may be broken")
    print()

    # ── Turn 2: tool-using prompt ──────────────────────────────────────
    print(f"--- turn 2: tool-using prompt ---")
    ack = post_message(args.host, args.port, chat_id, args.memory_prompt)
    print(f"POST ack: {ack}")
    events = collect_until(q, chat_id, has_tool_round_trip, args.turn_timeout)
    print(render(events))
    if not has_tool_round_trip(events):
        # Tool call may not fire if the model doesn't choose to use a tool.
        # Check at least that we got a reply_final (turn completed cleanly).
        if has_reply_final(events):
            print("  (note: no tool_call envelope — model declined to use a tool. "
                  "Reply still arrived, so the protocol path works.)")
        else:
            failures.append("turn 2: no reply_final and no tool round-trip in window")
    print()

    stop.set()

    print("=== summary ===")
    if failures:
        for f in failures:
            print(f"  FAIL: {f}")
        return 1
    print("  PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
