#!/usr/bin/env python3
"""Smoke test for the sidekick hermes platform adapter.

Connects as a fake sidekick proxy, sends a single ``message`` envelope, prints
every envelope received from the adapter for ~30 s, then exits cleanly.

Usage::

    SIDEKICK_PLATFORM_TOKEN=<token> python3 wscat-test.py
    # optional: --port 8645  --chat-id test-conv-1  --text "count to 5"

Requires hermes-gateway to be running with the sidekick plugin loaded
(i.e. ``Platform.SIDEKICK`` enabled in config + the patch applied). See
the README in this directory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Optional

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:
    print(
        "websockets not installed. Install with: pip install websockets",
        file=sys.stderr,
    )
    sys.exit(2)


async def run(
    *,
    host: str,
    port: int,
    token: str,
    chat_id: str,
    text: str,
    duration_s: float,
) -> int:
    url = f"ws://{host}:{port}/ws"
    headers = [("Authorization", f"Bearer {token}")]

    print(f"[wscat-test] connecting to {url}")
    try:
        async with websockets.connect(
            url, additional_headers=headers, open_timeout=5
        ) as ws:
            print("[wscat-test] connected")

            # Send the test message
            outbound = {"type": "message", "chat_id": chat_id, "text": text}
            print(f"[wscat-test] -> {json.dumps(outbound)}")
            await ws.send(json.dumps(outbound))

            # Drain inbound envelopes for the configured duration.
            deadline = asyncio.get_running_loop().time() + duration_s
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                except ConnectionClosed as exc:
                    print(f"[wscat-test] connection closed: {exc}")
                    return 1
                try:
                    parsed = json.loads(raw)
                    print(f"[wscat-test] <- {json.dumps(parsed)}")
                    if parsed.get("type") == "reply_final":
                        # Got the end of the turn; we can stop early.
                        print("[wscat-test] reply_final received, exiting")
                        break
                except json.JSONDecodeError:
                    print(f"[wscat-test] <- (raw, non-JSON): {raw!r}")

            return 0
    except OSError as exc:
        print(f"[wscat-test] cannot reach adapter: {exc}", file=sys.stderr)
        return 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("SIDEKICK_PLATFORM_PORT", "8645")),
    )
    parser.add_argument(
        "--token",
        default=os.getenv("SIDEKICK_PLATFORM_TOKEN", ""),
        help="defaults to SIDEKICK_PLATFORM_TOKEN env var",
    )
    parser.add_argument("--chat-id", default="test-conv-1")
    parser.add_argument("--text", default="count to 5")
    parser.add_argument("--duration", type=float, default=30.0)
    args = parser.parse_args()

    if not args.token:
        print(
            "Missing --token (or SIDEKICK_PLATFORM_TOKEN env var)",
            file=sys.stderr,
        )
        sys.exit(2)

    rc = asyncio.run(
        run(
            host=args.host,
            port=args.port,
            token=args.token,
            chat_id=args.chat_id,
            text=args.text,
            duration_s=args.duration,
        )
    )
    sys.exit(rc)


if __name__ == "__main__":
    main()
