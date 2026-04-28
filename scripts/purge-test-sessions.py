#!/usr/bin/env python3
"""Purge test/smoke-pollution sidekick sessions.

A test session is one whose first user message matches a known
smoke-test prompt (marker-*, "baseline-content", weather smoke,
greeting variants, etc.). Real user chats are preserved.

Three storage layers get cleaned for each test session:
  1. state.db sessions + messages rows (via DELETE /api/sidekick/...)
  2. ~/.hermes/sessions/sessions.json entry (session_key → session_id)
  3. ~/.hermes/sessions/<session_id>.jsonl transcript file

Usage:
  python3 scripts/purge-test-sessions.py            # dry-run, show plan
  python3 scripts/purge-test-sessions.py --apply    # actually delete
  python3 scripts/purge-test-sessions.py --keep '<sql-LIKE-pattern>'
                                                    # additional preserve
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.request
from pathlib import Path

HERMES_HOME = Path(os.path.expanduser("~/.hermes"))
STATE_DB = HERMES_HOME / "state.db"
SESSIONS_INDEX = HERMES_HOME / "sessions" / "sessions.json"
SESSIONS_DIR = HERMES_HOME / "sessions"
PROXY_BASE = "http://127.0.0.1:3001/api/sidekick"
SIDEKICK_KEY_PREFIX = "agent:main:sidekick:dm:"

# First-user-message patterns that indicate a test session.
TEST_PREFIXES = (
    "marker-",
    "baseline-content",
    "final-content",
    "Search the web for today's weather in London",
    "What do you remember about apples",
    "search the web for one current news",
    "say hi briefly",
    "say hi in 3 words",
    "please respond with: smoke test passed",
    "hello, briefly say hi",
    "reply with: ",
    "reply with the word OK",
    "count to 5",
    "count to 3",
)

TEST_EXACT = (
    "hi", "Hi", "Hello?", "hey", "hey there",
    "test msg", "test2", "say hi", "say hello",
    "what is 2+2?", "what's up?", "whats your name?",
    "reply OK", "reply with ONE word",
    "Hello? You there?",
)


def is_test_message(content: str | None) -> bool:
    if not content:
        return False
    s = content.strip()
    if s in TEST_EXACT:
        return True
    return any(s.startswith(p) for p in TEST_PREFIXES)


def load_sidekick_chat_ids() -> dict[str, str]:
    """Return {chat_id: session_id} from sessions.json for sidekick keys."""
    if not SESSIONS_INDEX.exists():
        return {}
    with open(SESSIONS_INDEX) as f:
        idx = json.load(f)
    out = {}
    for k, v in idx.items():
        if k.startswith(SIDEKICK_KEY_PREFIX) and isinstance(v, dict):
            chat_id = k[len(SIDEKICK_KEY_PREFIX):]
            sid = v.get("session_id")
            if chat_id and sid:
                out[chat_id] = sid
    return out


def classify_sessions() -> tuple[list[dict], list[dict]]:
    """Return (purge, keep) lists of sidekick sessions.

    Each item: {chat_id, session_id, first_user_msg, message_count, started_at}.
    """
    chat_to_sid = load_sidekick_chat_ids()
    sid_to_chat = {v: k for k, v in chat_to_sid.items()}

    conn = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)
    rows = conn.execute("""
        SELECT s.id, s.title, s.message_count, s.started_at,
               (SELECT m.content FROM messages m
                WHERE m.session_id=s.id AND m.role='user'
                ORDER BY m.id ASC LIMIT 1) AS first_user
        FROM sessions s
        WHERE s.source='sidekick'
        ORDER BY s.started_at DESC
    """).fetchall()
    conn.close()

    purge, keep = [], []
    for sid, title, count, started_at, first_user in rows:
        chat_id = sid_to_chat.get(sid)
        item = {
            "chat_id": chat_id,
            "session_id": sid,
            "title": title or "(none)",
            "message_count": count,
            "first_user": (first_user or "")[:80],
            "started_at": started_at,
        }
        if is_test_message(first_user):
            purge.append(item)
        else:
            keep.append(item)
    return purge, keep


def delete_via_proxy(chat_id: str) -> tuple[bool, str]:
    """Use the /api/sidekick/sessions/<chat_id> DELETE endpoint."""
    url = f"{PROXY_BASE}/sessions/{chat_id}"
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status == 200, body
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode()[:120]}"
    except Exception as e:
        return False, str(e)


def remove_sessions_json_entry(chat_id: str) -> bool:
    """Remove agent:main:sidekick:dm:<chat_id> from sessions.json."""
    if not SESSIONS_INDEX.exists():
        return False
    try:
        with open(SESSIONS_INDEX) as f:
            idx = json.load(f)
    except Exception:
        return False
    key = f"{SIDEKICK_KEY_PREFIX}{chat_id}"
    if key not in idx:
        return False
    del idx[key]
    with open(SESSIONS_INDEX, "w") as f:
        json.dump(idx, f, indent=2)
    return True


def remove_jsonl(session_id: str) -> bool:
    p = SESSIONS_DIR / f"{session_id}.jsonl"
    if p.exists():
        p.unlink()
        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="Actually delete. Default is dry-run.")
    args = ap.parse_args()

    purge, keep = classify_sessions()
    print(f"Sidekick sessions in state.db: {len(purge) + len(keep)} "
          f"({len(purge)} purge, {len(keep)} keep)")
    print()
    print(f"=== {len(keep)} sessions that will be KEPT ===")
    for it in keep:
        print(f"  {it['session_id']}  msgs={it['message_count']:>3}  "
              f"title={it['title'][:50]!r}  first={it['first_user']!r}")
    print()
    print(f"=== {len(purge)} sessions that will be PURGED ===")
    for it in purge[:10]:
        print(f"  {it['session_id']}  msgs={it['message_count']:>3}  "
              f"first={it['first_user']!r}")
    if len(purge) > 10:
        print(f"  … and {len(purge) - 10} more")
    print()

    if not args.apply:
        print("DRY RUN. Re-run with --apply to actually delete.")
        return 0

    # Apply.
    print("Applying deletions…")
    deleted = 0
    failed = 0
    for it in purge:
        chat_id = it["chat_id"]
        sid = it["session_id"]
        ok = True
        # 1. Proxy DELETE — drops state.db rows.
        if chat_id:
            success, msg = delete_via_proxy(chat_id)
            if not success:
                print(f"  proxy DELETE failed for {chat_id}: {msg}")
                ok = False
        # 2. sessions.json
        if chat_id:
            remove_sessions_json_entry(chat_id)
        # 3. transcript jsonl
        remove_jsonl(sid)
        if ok:
            deleted += 1
        else:
            failed += 1
    print()
    print(f"Done. Deleted {deleted}, failed {failed}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
