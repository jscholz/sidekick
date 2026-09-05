"""Plugin-owned web push dispatch.

Mirrors the openclaw plugin's ``src/push-dispatch.js`` + the
parley proxy's ``proxy/parley/notifications/dispatch.ts``.
Engagement filter + per-kind toggle + mute filter + cron-aware body
shaping + pywebpush send + prune 404/410.

Called from ``ParleyAdapter._safe_send_envelope`` for any envelope
the plugin emits. Decoupled from the proxy's notification module —
when ``PARLEY_PUSH_OWNED_BY_PLUGIN=true``, the proxy delegates to
this and skips its own dispatch path.

Observability: every gate decision logs at WARNING so the journal
answers "why didn't push fire for envelope X?" without re-reading
the code. (Default Python root logger level is WARNING; INFO is
silenced in stock hermes-gateway.)
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
from collections import deque
from typing import Callable, Deque, Dict, Optional, Tuple
from urllib.parse import quote

from pywebpush import webpush, WebPushException  # type: ignore
try:
    from . import parley_apns as apns
except ImportError:  # loaded as a top-level module
    import parley_apns as apns  # type: ignore

from .parley_state import (
    ensure_vapid_keys,
    list_subscriptions,
    list_native_tokens, mark_native_token_used, remove_native_token,
    is_muted,
    get_pref,
    mark_subscription_used,
    remove_subscription,
)

logger = logging.getLogger("hermes.parley.push")

# Visibility heartbeat validity window. The PWA reports while focused every
# 8s, and immediately sends hidden/blurred on loss of engagement. The server
# window must exceed the focused heartbeat interval or a user sitting in the
# active chat will intermittently receive pushes for the chat they are reading.
ENGAGEMENT_WINDOW_MS = 12_000

# How much of the body to ship in the push payload. Watch banners
# truncate hard; Apple's notification service tends to clip ~200
# chars on Series 6/Watch app banners. Keep the budget conservative.
PUSH_BODY_MAX_CHARS = 200


# ── Per-type icons ─────────────────────────────────────────────────────
#
# Title prefix that helps the user discriminate notifications on the
# watch glance. Sourced from envelope `type` first (most specific),
# then `kind` (for `notification` envelopes — cron / reminder /
# approval / etc.), then a generic fallback.
#
# Keep this map small + concrete: any random emoji renders fine on
# Apple Watch banners and the Android system tray; an exhaustive
# taxonomy would just spread cognitive load.
_TYPE_ICONS: Dict[str, str] = {
    # Top-level envelope types the plugin actually pushes.
    "reply_final": "💬",     # agent text reply (most common)
    "notification": "🔔",    # default for unknown kind below; overridden by _KIND_ICONS
}
_KIND_ICONS: Dict[str, str] = {
    "cron": "⏰",        # scheduled task output
    "approval": "⚠️",    # command approval prompt
}


def _icon_for(env: Dict) -> str:
    """Pick the title-prefix emoji. Kind takes precedence over type
    because `notification` envelopes carry the kind discriminator
    while `reply_final` always means agent text."""
    kind = env.get("kind") if isinstance(env.get("kind"), str) else ""
    if kind and kind in _KIND_ICONS:
        return _KIND_ICONS[kind]
    env_type = env.get("type") if isinstance(env.get("type"), str) else ""
    if env_type in _TYPE_ICONS:
        return _TYPE_ICONS[env_type]
    return "💬"  # generic chat icon as a last resort


class EngagementState:
    """Per-chat last-visibility-heartbeat tracker.

    Note: callers must use the SAME chat_id shape on both sides.
    The plugin's envelope path uses the source-stripped id (UUID
    only); ``handle_visibility`` normalizes the PWA-supplied
    ``parley:<uuid>`` form via ``_strip_source_prefix`` before
    recording. See parley_routes.py.
    """

    def __init__(self) -> None:
        self._last_seen: Dict[str, int] = {}

    def mark_visible(self, chat_id: str) -> None:
        self._last_seen[chat_id] = int(time.time() * 1000)

    def mark_hidden(self, chat_id: str) -> None:
        self._last_seen.pop(chat_id, None)

    def is_engaged(self, chat_id: str, *, now_ms: Optional[int] = None) -> bool:
        ts = self._last_seen.get(chat_id)
        if ts is None:
            return False
        if now_ms is None:
            now_ms = int(time.time() * 1000)
        return now_ms - ts < ENGAGEMENT_WINDOW_MS


class ReplyBuffer:
    """Per-chat accumulator for the most recent ``reply_delta`` text.

    ``reply_final`` envelopes carry no text — the agent's reply
    streams as cumulative-text on ``reply_delta``, terminated by an
    empty ``reply_final``. To produce a push body, we cache the last
    delta text per chat and drain it on the matching final.

    Self-healing: if a new turn starts before the prior final
    arrives, its first delta overwrites the stale buffer. Drain
    on final ALWAYS clears, even when the gate suppresses dispatch,
    so the buffer can't accumulate stale state.
    """

    def __init__(self) -> None:
        self._latest: Dict[str, str] = {}

    def set_latest(self, chat_id: str, text: str) -> None:
        if not chat_id or not isinstance(text, str):
            return
        self._latest[chat_id] = text

    def take_and_clear(self, chat_id: str) -> str:
        if not chat_id:
            return ""
        text = self._latest.pop(chat_id, "")
        return text


# ── Cron content shaping ───────────────────────────────────────────────
#
# Hermes' cron scheduler wraps the agent's reply in a fixed
# boilerplate shell:
#
#     Cronjob Response: {task_name}
#     (job_id: {job_id})
#     -------------
#
#     {agent body}
#
#     To stop or manage this job, send me a new message (e.g. ...).
#
# Naive forwarding to a watch banner eats the entire visible band
# on boilerplate + metadata before reaching the agent's actual reply.
# Strip the wrapper so the body LEADS with content the user wants to
# read, and demote metadata to a trailing suffix that only fits when
# there's headroom.
#
# Mirror of proxy/parley/notifications/dispatch.ts parseCronContent
# + stripLeadingMetadata. Verbatim regex for cross-language parity.
_CRON_HEADER_RE = re.compile(
    r"^Cronjob Response:\s*(.+?)\s*\n"
    r"\(job_id:\s*([^)]+)\)\s*\n"
    r"-+\s*\n+"
    r"([\s\S]*?)"
    r"(?:\n+To stop or manage this job[^\n]*\.?\s*)?$"
)
_META_LINE_RE = re.compile(
    r"^\s*(?:session_id|job_id|chat_id|message_id|user_id|run_id|trace_id)\s*:\s*\S",
    re.IGNORECASE,
)
_SEP_OR_BLANK_RE = re.compile(r"^\s*(?:-{3,}|=+|\*+)?\s*$")
_APPROVAL_HEADER_RE = re.compile(r"Dangerous command requires approval", re.IGNORECASE)
_APPROVAL_REASON_RE = re.compile(r"^Reason:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
_APPROVAL_REPLY_RE = re.compile(r"^Reply\s+/approve", re.IGNORECASE | re.MULTILINE)


# Gateway progress heartbeat, emitted every _NOTIFY_INTERVAL of a long turn
# (hermes 0.21: "⏳ Working — 3 min — iteration 4/60, terminal"; pre-0.21:
# "⏳ Still working… (3 min elapsed — iteration 4/60, …)"). A pulse, not a
# reply — send() turns it into an ephemeral `status` envelope instead of a
# bubble. KEEP IN SYNC with src/util/progressHeartbeat.ts and
# proxy/parley/notifications/dispatch.ts isProgressHeartbeat.
_PROGRESS_HEARTBEAT_RE = re.compile(r"^\s*⏳\s*(Working|Still working)\b", re.IGNORECASE)


def is_progress_heartbeat(text: str) -> bool:
    """True for the gateway's mid-turn "⏳ Working — …" progress pulse."""
    return bool(isinstance(text, str) and _PROGRESS_HEARTBEAT_RE.search(text or ""))


def is_approval_prompt(text: str) -> bool:
    """True when Hermes is asking the user to approve a gated command."""
    return bool(isinstance(text, str) and _APPROVAL_HEADER_RE.search(text or ""))


def _approval_preview(raw: str) -> str:
    """Extract the useful command/reason lead for an approval push/banner."""
    text = _strip_leading_metadata(raw or "")
    reason_match = _APPROVAL_REASON_RE.search(text)
    reason = reason_match.group(1).strip() if reason_match else ""

    lines = text.split("\n")
    command_lines = []
    in_command = False
    for line in lines:
        stripped = line.strip()
        if _APPROVAL_HEADER_RE.search(stripped):
            in_command = True
            continue
        if not in_command:
            continue
        if not stripped:
            if command_lines:
                command_lines.append("")
            continue
        if stripped.lower().startswith("reason:") or _APPROVAL_REPLY_RE.match(stripped):
            break
        command_lines.append(line.rstrip())

    command = "\n".join(command_lines).strip()
    if command:
        command = re.sub(r"\n{3,}", "\n\n", command)
    if reason and command:
        return f"{reason}: {command}"
    if reason:
        return reason
    return command or text


def _parse_cron_content(raw: str) -> Dict[str, str]:
    """Split a canonical cron-wrapped reply into {task_name, job_id, body}.

    Falls back to {taskName='', jobId='', body=raw} when the input
    doesn't match the canonical shape — future hermes versions could
    change the template and we degrade gracefully."""
    m = _CRON_HEADER_RE.match(raw or "")
    if not m:
        return {"task_name": "", "job_id": "", "body": raw or ""}
    return {
        "task_name": m.group(1).strip(),
        "job_id": m.group(2).strip(),
        "body": m.group(3).strip(),
    }


def _strip_leading_metadata(s: str) -> str:
    """Strip session_id: / job_id: / chat_id: style metadata lines
    AND leading dashes/blanks from the start of a notification body.
    Stops at the first non-metadata line."""
    lines = (s or "").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if _META_LINE_RE.match(line) or _SEP_OR_BLANK_RE.match(line):
            i += 1
            continue
        break
    return "\n".join(lines[i:])


def _build_payload(env: Dict, *, body_override: Optional[str] = None,
                   badge: Optional[int] = None) -> Dict:
    """Translate an envelope into the push payload shape sw.js
    expects: ``{title, body, chat_id?, tag?, url?, badge?}``.

    ``badge`` is the server-computed unread TOTAL — sw.js passes it to
    ``navigator.setAppBadge`` alongside showNotification, so the OS
    app badge tracks the same clock as the sidebar even while no page
    is open (field bug 2026-07-08: the badge went stale-low when
    pushes arrived with the PWA closed, because nothing updated it
    until a page next opened and reconciled).

    Title carries a discriminator emoji (per envelope type/kind) so
    a user can tell apart agent-reply vs cron-output vs reminder at
    a glance on the watch.

    Body LEADS with content (the agent's actual reply / the cron
    output's agent-body / the notification text), with metadata
    (job_id) demoted to a trailing suffix only if the headroom allows.
    For cron output the wrapper is parsed so we don't waste the
    banner on boilerplate.
    """
    chat_id = env.get("chat_id", "") if isinstance(env.get("chat_id"), str) else ""
    speaker = env.get("speaker") if isinstance(env.get("speaker"), str) else "Parley"
    icon = _icon_for(env)
    kind = env.get("kind") if isinstance(env.get("kind"), str) else ""

    raw_body = body_override or env.get("content") or env.get("text") or ""
    if not isinstance(raw_body, str):
        raw_body = str(raw_body)

    # Cron-shape detection: structured wrapper → split into
    # (task_name, job_id, body). Title can lead with the task name;
    # body leads with the agent's actual content.
    cron_parsed: Optional[Dict[str, str]] = None
    if kind == "cron" or _CRON_HEADER_RE.match(raw_body):
        cron_parsed = _parse_cron_content(raw_body)

    if kind == "approval":
        body = _approval_preview(raw_body)
        title_label = "Approval required"
    elif cron_parsed and cron_parsed["body"]:
        body = cron_parsed["body"]
        # Title carries the task name (more useful than "Parley" on
        # a watch when there are many cron jobs).
        title_label = cron_parsed["task_name"] or speaker
    else:
        # Generic notification: strip leading metadata lines if present.
        body = _strip_leading_metadata(raw_body)
        title_label = speaker

    # Demote remaining job_id/run_id metadata to a trailing suffix.
    # Only attach it if there's slack in the budget — body content
    # wins under truncation.
    suffix = ""
    if cron_parsed and cron_parsed["job_id"]:
        suffix = f"\n— job:{cron_parsed['job_id'][:24]}"

    available = PUSH_BODY_MAX_CHARS - len(suffix)
    if len(body) > available:
        body = body[: max(0, available - 1)].rstrip() + "…"
    body = body + suffix

    message_id = env.get("parley_id") or env.get("message_id") or ""
    if not isinstance(message_id, str):
        message_id = ""
    url = "/"
    if chat_id:
        url_chat_id = chat_id if ":" in chat_id else f"parley:{chat_id}"
        url = f"/?chat={quote(url_chat_id, safe='')}"
        if message_id:
            url += f"&msg={quote(message_id, safe='')}"

    payload = {
        "title": f"{icon} {title_label}".strip(),
        "body": body[:PUSH_BODY_MAX_CHARS],
        "chat_id": chat_id,
        "tag": chat_id or "parley",
        "url": url,
    }
    if isinstance(badge, int):
        payload["badge"] = badge
    return payload


# ── Per-kind toggles ───────────────────────────────────────────────────
#
# Mirrors the proxy's `prefs.ts` / `PushKinds`. Each top-level
# envelope type or notification.kind maps to a pref key the user
# toggles in Settings → Notifications. False = silenced, True or
# unset = enabled.

_PREF_PUSH_KIND_PREFIX = "push_kind_"
_SUPPORTED_PUSH_KINDS = {"agent_reply", "cron", "approval"}


def _kind_pref_enabled(db, kind_name: str) -> bool:
    """Effective enablement for one push-kind pref key. Defaults to
    enabled when the pref is unset so a fresh install still pushes."""
    pref_key = f"{_PREF_PUSH_KIND_PREFIX}{kind_name}"
    val = get_pref(db, pref_key)
    if val is None:
        return True
    if isinstance(val, bool):
        return val
    # Pref store may serialize as "true"/"false" strings.
    if isinstance(val, str):
        return val.lower() not in ("false", "0", "off", "no")
    return True


def _is_kind_enabled(db, env: Dict) -> bool:
    """Pull the relevant pref key for this envelope. Defaults to
    enabled when the pref is unset so a fresh install still pushes."""
    # Top-level type → kind key. reply_final → 'agent_reply';
    # notification with kind=X → X; bare notification → 'notification'.
    env_type = env.get("type") if isinstance(env.get("type"), str) else ""
    kind_name: Optional[str] = None
    if env_type == "reply_final":
        kind_name = "agent_reply"
    elif env_type == "notification":
        env_kind = env.get("kind") if isinstance(env.get("kind"), str) else ""
        kind_name = env_kind if env_kind in _SUPPORTED_PUSH_KINDS else None
    if not kind_name:
        return True  # not a user-facing category; another gate will catch it
    return _kind_pref_enabled(db, kind_name)


# ── Push-health monitor ────────────────────────────────────────────────
#
# Field incident 2026-07: push_kind_* prefs sat at all-false in the live
# parley.db for 9+ days. The dispatcher dutifully logged
# `skip … reason=kind_disabled` per envelope, but nobody tails journals
# — so pushes were silently dead the whole time. This monitor turns the
# per-skip whisper into two aggregate shouts:
#
#   1. Startup: if EVERY supported push kind is disabled when the
#      dispatcher comes up, emit one prominent stderr line.
#   2. Runtime: if pref-driven skips (kind_disabled / quiet_hours)
#      exceed a threshold within a rolling window, emit one prominent
#      stderr line per window (not per skip).
#
# The stderr `print` deliberately bypasses the stdlib logger — same
# rationale as parley_perf_trace._log: the gateway's default handler
# config drops sub-WARNING records and journalctl always captures
# stderr. Snapshot() feeds /v1/push/health → the proxy's diagnostics
# endpoint → the PWA settings panel.

PUSH_HEALTH_WINDOW_SEC = 3600
PUSH_HEALTH_SKIP_ALERT_THRESHOLD = 5

# Skip reasons caused by user prefs (vs transient gates like
# user_engaged): a burst of these means "the user thinks pushes are on,
# the store says off" — exactly the silent-outage shape.
_PREF_SKIP_REASONS = ("kind_disabled", "quiet_hours")


def _push_health_alert(msg: str) -> None:
    """One prominent journal line. Matches the perf-trace stderr
    pattern so it survives the gateway's WARN-and-up logging config."""
    print(f"[push-health ALERT] {msg}", flush=True, file=sys.stderr)


class PushHealthMonitor:
    """Rolling-window skip aggregator + all-kinds-disabled tripwire."""

    def __init__(
        self,
        *,
        window_sec: float = PUSH_HEALTH_WINDOW_SEC,
        alert_threshold: int = PUSH_HEALTH_SKIP_ALERT_THRESHOLD,
    ) -> None:
        self.window_sec = window_sec
        self.alert_threshold = alert_threshold
        self._skips: Deque[Tuple[float, str]] = deque()
        self._last_alert_at: Optional[float] = None
        self.startup_all_kinds_disabled = False

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_sec
        while self._skips and self._skips[0][0] < cutoff:
            self._skips.popleft()

    def record_skip(self, reason: str, *, now: Optional[float] = None) -> None:
        """Track one skip decision. Alerts (at most once per window)
        when pref-driven skips cross the threshold."""
        ts = time.time() if now is None else now
        self._prune(ts)
        self._skips.append((ts, reason))
        pref_skips = sum(1 for _, r in self._skips if r in _PREF_SKIP_REASONS)
        if pref_skips < self.alert_threshold:
            return
        if self._last_alert_at is not None and ts - self._last_alert_at < self.window_sec:
            return
        self._last_alert_at = ts
        _push_health_alert(
            f"{pref_skips} pushes suppressed by user prefs "
            f"(kind_disabled/quiet_hours) within {int(self.window_sec)}s — "
            f"check Settings → Notifications push categories "
            f"(push_kind_* rows in parley.db push_prefs)"
        )

    def check_startup(self, db) -> bool:
        """All supported kinds disabled at dispatcher construction →
        pushes are structurally dead; say so ONCE, loudly."""
        disabled = [k for k in sorted(_SUPPORTED_PUSH_KINDS) if not _kind_pref_enabled(db, k)]
        self.startup_all_kinds_disabled = len(disabled) == len(_SUPPORTED_PUSH_KINDS)
        if self.startup_all_kinds_disabled:
            _push_health_alert(
                "ALL push kinds disabled at startup "
                f"({', '.join(sorted(_SUPPORTED_PUSH_KINDS))}) — every push will be "
                "skipped with reason=kind_disabled until push_kind_* prefs are re-enabled"
            )
        return self.startup_all_kinds_disabled

    def snapshot(self, *, now: Optional[float] = None) -> Dict:
        ts = time.time() if now is None else now
        self._prune(ts)
        counts: Dict[str, int] = {}
        for _, reason in self._skips:
            counts[reason] = counts.get(reason, 0) + 1
        return {
            "window_sec": int(self.window_sec),
            "skips_in_window": counts,
            "pref_skips_in_window": sum(
                n for r, n in counts.items() if r in _PREF_SKIP_REASONS
            ),
            "alert_threshold": self.alert_threshold,
            "last_alert_at": self._last_alert_at,
            "startup_all_kinds_disabled": self.startup_all_kinds_disabled,
        }


def build_push_health(db, dispatcher: Optional["PushDispatcher"] = None) -> Dict:
    """Assemble the push_health blob served by /v1/push/health and
    surfaced through the proxy's notifications/diagnostics response."""
    kinds = {k: _kind_pref_enabled(db, k) for k in sorted(_SUPPORTED_PUSH_KINDS)}
    disabled = sorted(k for k, on in kinds.items() if not on)
    out: Dict = {
        "kinds": kinds,
        "disabled_kinds": disabled,
        "all_kinds_disabled": len(disabled) == len(kinds),
        "quiet_hours": get_pref(db, "quiet_hours"),
        "subscriptions": len(list_subscriptions(db)),
        "native_tokens": len(list_native_tokens(db)),
        "apns_configured": apns.config_from_env() is not None,
    }
    if dispatcher is not None and getattr(dispatcher, "health", None) is not None:
        out["monitor"] = dispatcher.health.snapshot()
    return out


def _is_push_eligible(env: Dict) -> bool:
    """Mirrors the proxy's isPushEligible: explicit `should_push`
    flag wins; falls back to type allowlist.

    Keep this tuple in sync with PUSH_ELIGIBLE_TYPES in
    proxy/parley/notifications/dispatch.ts — the two gates are twins and
    an envelope can reach either.

    `agent_question` is on the list because the agent is BLOCKED waiting
    on an answer: it is the one envelope class where silence costs the
    user a stalled turn rather than a missed line of text. It was
    omitted until 2026-08-25 even though the envelope mints itself with
    `urgent: true`, so questions never once reached a phone (field bug
    2026-08-23: `skip type=agent_question reason=not_eligible`, agent
    parked for hours). Deliberately NOT given a `_SUPPORTED_PUSH_KINDS`
    category: an unmapped kind defaults to enabled, whereas mapping it
    would let a stale/false pref silence it exactly the way the 2026-07
    all-false-prefs incident silenced everything.
    """
    should = env.get("should_push")
    if isinstance(should, bool):
        return should
    return env.get("type") in ("reply_final", "notification", "agent_question")


class PushDispatcher:
    def __init__(
        self,
        db,
        *,
        vapid_subject: str,
        engagement: Optional[EngagementState] = None,
        reply_buffer: Optional[ReplyBuffer] = None,
        unread_total_fn: Optional[Callable[[], int]] = None,
    ) -> None:
        self.db = db
        self.engagement = engagement or EngagementState()
        self.reply_buffer = reply_buffer or ReplyBuffer()
        self._vapid_subject = vapid_subject
        self._vapid = None  # lazy
        # Server-truth unread total for the payload `badge` field (the
        # plugin injects a compute_unread closure). Optional: absent →
        # payloads simply omit badge and sw.js leaves the OS badge to
        # the page-side reconciler.
        self.unread_total_fn = unread_total_fn
        # Native (APNs) lane for the iOS shell. Config is read lazily on the first
        # dispatch (env may be completed after the gateway started); tests inject
        # a fake sender via ``apns_send``.
        self.apns_send = apns.send_via_curl
        self._apns_cfg = None
        self._apns_cfg_loaded = False
        # Aggregate skip observability (field incident 2026-07: all
        # push kinds silently disabled for days). The startup check
        # emits its one loud line right here, before the first
        # envelope, so a structurally-dead config is visible in the
        # journal from boot.
        self.health = PushHealthMonitor()
        try:
            self.health.check_startup(db)
        except Exception as err:  # pragma: no cover — diagnostics never block boot
            logger.warning("push-health startup check failed: %s", err)

    def _ensure_vapid(self) -> Dict[str, str]:
        if self._vapid is None:
            self._vapid = ensure_vapid_keys(self.db, self._vapid_subject)
        return self._vapid

    def observe_envelope(self, env: Dict) -> Optional[str]:
        """Side-channel: record reply_delta text for later use as the
        body on reply_final. Returns the drained body for reply_final
        envelopes (caller passes to dispatch_envelope as body_override).
        No-op for unrelated types.

        Always drain on reply_final, even when the gate suppresses
        dispatch — the buffer would otherwise leak.
        """
        env_type = env.get("type") if isinstance(env.get("type"), str) else ""
        chat_id = env.get("chat_id") if isinstance(env.get("chat_id"), str) else ""
        if not chat_id:
            return None
        if env_type == "reply_delta":
            text = env.get("text")
            if isinstance(text, str) and text:
                self.reply_buffer.set_latest(chat_id, text)
            return None
        if env_type == "reply_final":
            # Drain whether or not we actually push. The accumulated text
            # is the agent's full reply (each delta carries cumulative
            # text — see proxyClient handleEnvelope).
            return self.reply_buffer.take_and_clear(chat_id)
        return None

    def _apns_config(self):
        if not self._apns_cfg_loaded:
            self._apns_cfg = apns.config_from_env()
            self._apns_cfg_loaded = True
            if self._apns_cfg is not None:
                logger.warning("[parley] APNs configured (env=%s, topic=%s)", self._apns_cfg.env, self._apns_cfg.bundle_id)
        return self._apns_cfg

    def _dispatch_native(self, payload_dict: Dict, env_type: str, chat_id: str) -> Dict[str, int]:
        """Fan the same payload out to APNs device tokens. Dead tokens are pruned like web 410s."""
        cfg = self._apns_config()
        tokens = list_native_tokens(self.db)
        if cfg is None or not tokens:
            if tokens and cfg is None:
                logger.warning("skip native type=%s chat=%s reason=apns_unconfigured (%d tokens)", env_type, chat_id, len(tokens))
            return {"delivered": 0, "pruned": 0, "tokens": len(tokens)}
        delivered = pruned = 0
        for row in tokens:
            tok = row["token"]
            try:
                self.apns_send(cfg, tok, payload_dict)
                mark_native_token_used(self.db, tok)
                delivered += 1
            except apns.ApnsError as err:
                if err.prune:
                    remove_native_token(self.db, tok)
                    pruned += 1
                else:
                    logger.warning("apns send failed (%s %s)", err.status, err.reason)
            except Exception as err:  # curl missing / unexpected
                logger.warning("apns send error: %s", err)
        return {"delivered": delivered, "pruned": pruned, "tokens": len(tokens)}

    def dispatch_envelope(self, env: Dict, *, body_override: Optional[str] = None) -> Dict:
        """Fire push for a single envelope. Synchronous (called inside
        the aiohttp worker, but pywebpush itself is sync-blocking;
        per-subscription HTTP is the dominant cost). Returns
        ``{delivered, pruned, skipped?}``.
        """
        env_type = env.get("type", "?")
        chat_id_for_log = env.get("chat_id", "?") if isinstance(env.get("chat_id"), str) else "?"
        if not _is_push_eligible(env):
            logger.warning("skip type=%s chat=%s reason=not_eligible", env_type, chat_id_for_log)
            return {"delivered": 0, "pruned": 0, "skipped": "not_eligible"}
        chat_id = env.get("chat_id")
        if not isinstance(chat_id, str) or not chat_id:
            logger.warning("skip type=%s chat=%s reason=missing_chat_id", env_type, chat_id_for_log)
            return {"delivered": 0, "pruned": 0, "skipped": "missing_chat_id"}
        # Per-kind enablement: user toggled this category off in
        # Settings → Notifications. Cheap check; runs before engagement
        # so a silenced kind doesn't even consume an engagement slot.
        if not _is_kind_enabled(self.db, env):
            logger.warning("skip type=%s chat=%s reason=kind_disabled", env_type, chat_id)
            self.health.record_skip("kind_disabled")
            return {"delivered": 0, "pruned": 0, "skipped": "kind_disabled"}
        if self.engagement.is_engaged(chat_id):
            logger.warning("skip type=%s chat=%s reason=user_engaged", env_type, chat_id)
            self.health.record_skip("user_engaged")
            return {"delivered": 0, "pruned": 0, "skipped": "user_engaged"}
        if is_muted(self.db, chat_id):
            logger.warning("skip type=%s chat=%s reason=muted", env_type, chat_id)
            self.health.record_skip("muted")
            return {"delivered": 0, "pruned": 0, "skipped": "muted"}
        subs = list_subscriptions(self.db)
        native_tokens = list_native_tokens(self.db)
        if not subs and not native_tokens:
            logger.warning("skip type=%s chat=%s reason=no_subscribers", env_type, chat_id)
            return {"delivered": 0, "pruned": 0, "skipped": "no_subscribers"}
        vapid = self._ensure_vapid() if subs else None
        # Badge = unread total, floored at 1: the push being dispatched
        # IS an unread-worthy event, and the msg_links write-through may
        # not have landed yet when the (TTL-cached) count is computed.
        # Compute failure never blocks the push — badge is decorative.
        badge: Optional[int] = None
        if self.unread_total_fn is not None:
            try:
                badge = max(1, int(self.unread_total_fn()))
            except Exception as err:
                logger.debug("badge compute failed (push proceeds): %s", err)
        payload_dict = _build_payload(env, body_override=body_override, badge=badge)
        payload = json.dumps(payload_dict)
        delivered = 0
        pruned = 0
        for sub in subs:
            wp_sub = {
                "endpoint": sub["endpoint"],
                "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
            }
            try:
                webpush(
                    subscription_info=wp_sub,
                    data=payload,
                    vapid_private_key=vapid["private_key"],
                    vapid_claims={"sub": vapid["subject"]},
                    ttl=3600,
                )
                mark_subscription_used(self.db, sub["endpoint"])
                delivered += 1
            except WebPushException as err:
                code = getattr(err.response, "status_code", 0)
                if code in (404, 410):
                    remove_subscription(self.db, sub["endpoint"])
                    pruned += 1
                else:
                    logger.warning("push send failed (%s): %s", code, err)
            except Exception as err:  # network / unexpected
                logger.warning("push send error: %s", err)
        native = self._dispatch_native(payload_dict, env_type, chat_id)
        logger.warning(
            "dispatch type=%s chat=%s delivered=%d pruned=%d (of %d subs) native=%d/%d pruned=%d",
            env_type, chat_id, delivered, pruned, len(subs), native["delivered"], native["tokens"], native["pruned"],
        )
        return {"delivered": delivered + native["delivered"], "pruned": pruned + native["pruned"],
                "web": delivered, "native": native["delivered"]}
