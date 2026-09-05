// Push dispatch — fan an envelope out to every stored subscription via
// the web-push library, prune dead subscriptions on the wire, and
// stamp lastUsedAt on success.
//
// Phase 3c. Wired into proxy/parley/stream.ts's broadcast path:
// `pushEnvelope` calls `maybeDispatchEnvelope` AFTER broadcasting to
// live SSE subscribers; the gate inside decides whether to actually
// send a push based on type + active-subscriber presence.
//
// Eligibility policy today: `reply_final` and `notification` envelopes
// get pushed when no live SSE subscriber for that chat_id is attached.
// The longer-term goal is a plugin-driven `should_push: true` flag;
// when the plugin lands the flag, replace isPushEligibleType() with a
// flag check. Until then, hardcoded type policy keeps this pure-parley.

import webpush from 'web-push';
import { getVapidConfig } from './index.ts';
import {
  listSubscriptions,
  removeSubscription,
  markUsed,
} from './storage.ts';

let vapidApplied = false;

/** Per-subscription send function. The default wraps webpush.sendNotification
 *  (real network call to Apple/FCM/Mozilla relay) and is gated by lazy
 *  setVapidDetails on first call. Tests replace this via __setSenderForTest
 *  so the proxy/dispatch chain can be smoked without hitting external
 *  services AND without needing real (65-byte-decoded) VAPID keys — every
 *  gate decision becomes pinnable.
 *
 *  Errors should throw with `.statusCode` (number) so the dispatch loop's
 *  404/410-prune branch still works. Other failures don't need a statusCode. */
export type PushSender = (
  target: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
  opts: { TTL: number },
) => Promise<void>;

const defaultSender: PushSender = async (target, body, opts) => {
  if (!vapidApplied) {
    const vapid = getVapidConfig();
    if (!vapid) throw new Error('VAPID not configured');
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    vapidApplied = true;
  }
  await webpush.sendNotification(target, body, opts);
};

let sender: PushSender = defaultSender;

/** Cheap configured-vs-not check for the dispatch gate. The real
 *  VAPID-key-validation happens inside defaultSender on first use;
 *  a mocked sender bypasses it entirely. */
function ensureConfigured(): boolean {
  return getVapidConfig() !== null;
}

/** Test-only seam: swap the sender for a stub. Production never calls
 *  this. Returns a restore-callback for symmetry with patch/unpatch
 *  patterns elsewhere. */
export function __setSenderForTest(fn: PushSender): () => void {
  const prev = sender;
  sender = fn;
  return () => { sender = prev; };
}

/** Test-only seam: reset module-level state. Mirrors the
 *  notifications/index.ts __resetForTest pattern so a test rig can
 *  start each case from a clean slate. */
export function __resetDispatchForTest(): void {
  sender = defaultSender;
  vapidApplied = false;
}

export interface PushPayload {
  title: string;
  body: string;
  chat_id?: string;
  tag?: string;
  icon?: string;
  url?: string;
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
  pruned: number;
}

/** Send `payload` to every stored subscription. Returns a summary. On
 *  a 404 or 410 from the push service (subscription expired / unsubscribed
 *  on the client side without a roundtrip), the row is removed from
 *  storage so future dispatches don't keep trying it. Other failures
 *  (timeouts, transient 5xx) are counted as failed but the row stays. */
export async function dispatchPush(payload: PushPayload): Promise<DispatchResult> {
  if (!ensureConfigured()) {
    console.warn('[notifications] dispatchPush called but VAPID unconfigured');
    return { dispatched: 0, failed: 0, pruned: 0 };
  }
  const subs = listSubscriptions();
  if (subs.length === 0) return { dispatched: 0, failed: 0, pruned: 0 };

  let dispatched = 0;
  let failed = 0;
  let pruned = 0;
  const body = JSON.stringify(payload);

  await Promise.all(subs.map(async (sub) => {
    try {
      await sender(
        { endpoint: sub.endpoint, keys: sub.keys },
        body,
        // 30s TTL — push services hold for delivery up to this long if
        // the device is offline. Beyond that the message is dropped;
        // the user has plainly missed it and the SSE state.db replay
        // will catch them up when they next open the app.
        { TTL: 30 },
      );
      dispatched += 1;
      await markUsed(sub.endpoint);
    } catch (e: any) {
      const code = e?.statusCode ?? 0;
      if (code === 404 || code === 410) {
        // Gone-style errors: the subscription is dead. Prune so we
        // don't keep trying. The client will re-subscribe on next
        // toggle-on or app open with the permission grant intact.
        await removeSubscription(sub.endpoint);
        pruned += 1;
      } else {
        failed += 1;
        console.warn(
          `[notifications] dispatchPush failure ` +
          `(endpoint=${sub.endpoint.slice(0, 60)}…, status=${code}, msg=${e?.message ?? e})`,
        );
      }
    }
  }));

  return { dispatched, failed, pruned };
}

/** Envelope-types eligible for push delivery — fallback policy when an
 *  envelope arrives WITHOUT an explicit `should_push` flag from the
 *  plugin. Newer plugins set the flag directly per envelope and
 *  preempt this list (see isPushEligible). Conservative list — only
 *  user-facing turn outputs (the final assistant reply) and explicit
 *  `notification` envelopes. Streaming deltas / typing / tool events
 *  deliberately don't push. */
const PUSH_ELIGIBLE_TYPES = new Set<string>([
  'reply_final',
  'notification',
  // The agent is BLOCKED waiting on an answer, so silence here costs a
  // stalled turn rather than a missed line of text. Omitted until
  // 2026-08-25 despite the envelope minting itself `urgent: true`, so
  // questions never reached a phone at all (field bug 2026-08-23).
  // Keep in sync with _is_push_eligible in
  // backends/hermes/plugin/parley_dispatcher.py.
  'agent_question',
]);

/** Decide whether an envelope should be pushed. Plugin-driven flag
 *  takes precedence; falls back to the type allowlist when the flag
 *  isn't present (backwards compat with plugin versions that haven't
 *  adopted should_push yet).
 *
 *  Truthy `should_push` → eligible regardless of type. Lets the plugin
 *  promote a tool-summary `notification` or suppress a chatty
 *  `reply_final` based on content the proxy can't see.
 *
 *  Boolean false `should_push: false` → NOT eligible, even if the
 *  type would otherwise qualify. Lets the plugin opt out of push for
 *  a `reply_final` that's just a tool acknowledgement.
 *
 *  Absent / non-boolean → consult PUSH_ELIGIBLE_TYPES. Old plugins
 *  keep working unchanged. */
export function isPushEligible(env: Record<string, any>): boolean {
  if (typeof env.should_push === 'boolean') return env.should_push;
  return PUSH_ELIGIBLE_TYPES.has(env.type);
}

/** @deprecated Use isPushEligible(env) — the type-only variant ignores
 *  the plugin's should_push flag. Kept as a thin shim during the
 *  flag-adoption window so any external caller doesn't break. */
export function isPushEligibleType(envelopeType: string): boolean {
  return PUSH_ELIGIBLE_TYPES.has(envelopeType);
}

/** Hermes' cron scheduler wraps the agent's reply in a fixed boilerplate
 *  shell (see hermes-agent/cron/scheduler.py:515-522):
 *
 *      Cronjob Response: {task_name}
 *      (job_id: {job_id})
 *      -------------
 *
 *      {agent body}
 *
 *      To stop or manage this job, send me a new message (e.g. "stop reminder {task_name}").
 *
 *  For a watch-sized push the raw form eats the entire visible band on
 *  boilerplate and never reaches the agent's actual content before
 *  truncation.
 *
 *  Parser splits the wrapper into its parts so we can lead with the
 *  agent's reply and let the title + suffix carry the metadata. */
export function parseCronContent(raw: string): {
  taskName: string;
  jobId: string;
  body: string;
} {
  const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
  const m = headerRe.exec(raw);
  if (!m) {
    // Not the canonical shape — return raw as body, no metadata
    // extracted. Defensive: future hermes versions could change the
    // template; we degrade gracefully to "show the whole content."
    return { taskName: '', jobId: '', body: raw };
  }
  return {
    taskName: m[1].trim(),
    jobId: m[2].trim(),
    body: m[3].trim(),
  };
}

/** Strip "session_id: ..." / "job_id: ..." / "chat_id: ..." style
 *  metadata lines from the START of a notification body. Cron jobs
 *  often include these in their agent prompt's reply text — useful
 *  for desktop debugging but pure noise on a watch banner. Also
 *  drops leading dash-only separators ("------") and blank lines.
 *  Stops at the first non-metadata line so the agent's real content
 *  is preserved verbatim. */
export function stripLeadingMetadata(s: string): string {
  const META_LINE_RE = /^\s*(?:session_id|job_id|chat_id|message_id|user_id|run_id|trace_id)\s*:\s*\S/i;
  const SEP_OR_BLANK_RE = /^\s*(?:-{3,}|=+|\*+)?\s*$/;
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length && (META_LINE_RE.test(lines[i]) || SEP_OR_BLANK_RE.test(lines[i]))) {
    i++;
  }
  return lines.slice(i).join('\n');
}

export function approvalPreview(raw: string): string {
  const text = stripLeadingMetadata(raw || '');
  const reason = /^Reason:\s*(.+)$/im.exec(text)?.[1]?.trim() || '';
  const lines = text.split('\n');
  const command: string[] = [];
  let inCommand = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/Dangerous command requires approval/i.test(trimmed)) {
      inCommand = true;
      continue;
    }
    if (!inCommand) continue;
    if (!trimmed) {
      if (command.length) command.push('');
      continue;
    }
    if (/^Reason:/i.test(trimmed) || /^Reply\s+\/approve/i.test(trimmed)) break;
    command.push(line.replace(/\s+$/, ''));
  }
  const cmd = command.join('\n').trim().replace(/\n{3,}/g, '\n\n');
  if (reason && cmd) return `${reason}: ${cmd}`;
  return reason || cmd || text;
}

/** True for the transient progress "heartbeat" the agent emits once per
 *  iteration during a long autonomous turn, e.g.
 *    "⏳ Still working... (12 min elapsed — iteration 47/60, running: terminal)"
 *  These arrive as reply_final and would otherwise fire a push EACH
 *  iteration — pure noise, and (sharing the per-chat tag) they
 *  coalesce-overwrite each other and buried a real approval (field
 *  2026-05-26). Suppress them from push; the in-app transcript/Activity
 *  still shows progress, and the reply that actually ENDS the turn isn't a
 *  heartbeat so it still pushes. Two matchers: the ⏳-prefixed form, plus a
 *  structural fallback in case the emoji is stripped upstream. */
export function isProgressHeartbeat(raw: string): boolean {
  const s = (raw || '').trim();
  if (!s) return false;
  // hermes 0.21 shortened the beat to "⏳ Working — N min — iteration i/n,
  // tool"; the older "⏳ Still working… (N min elapsed — …)" still matches.
  return /^⏳\s*(Working|Still working)\b/i.test(s)
    || /\bStill working\.{0,3}\s*\(\s*\d+\s*min elapsed\b.*\biteration\s*\d+\s*\/\s*\d+/i.test(s);
}

/** Translate a parley envelope into a push payload. The shape matches
 *  the sw.js push listener's expectations:
 *    { title, body, chat_id?, tag?, icon?, url? }
 *  Falls back to "Parley" / empty body when the envelope is missing
 *  the obvious fields — the receive side handles those gracefully.
 *
 *  Format strategy:
 *    - Title carries the category emoji + a short scannable label
 *      (chat speaker, cron task name, etc.). NO boilerplate words.
 *    - Body leads with the agent's actual content. Metadata that's
 *      useful for debugging (job_id) goes in a suffix after a dot
 *      separator, so a watch banner shows agent text first; on a
 *      desktop banner the suffix is still visible after wrap.
 *    - Known boilerplate patterns ("session_id: ...", separators)
 *      are stripped from the body prefix so the first ~30 chars
 *      (the only ones a watch shows) carry signal.
 *
 *  `bodyOverride` lets the caller supply text the envelope itself
 *  doesn't carry. Used for reply_final, which has no `text`/`content`
 *  field; stream.ts drains the per-chat replyBuffer (accumulated from
 *  preceding reply_delta envelopes) and threads the result through. */
export function envelopeToPayload(env: Record<string, any>, bodyOverride?: string): PushPayload {
  const chatId = typeof env.chat_id === 'string' ? env.chat_id : '';
  const speaker = typeof env.speaker === 'string' && env.speaker
    ? env.speaker
    : 'Parley';
  const envTitle = typeof env.title === 'string' && env.title ? env.title : '';
  const raw = typeof bodyOverride === 'string' && bodyOverride ? bodyOverride
    : typeof env.content === 'string' ? env.content
    : typeof env.text === 'string' ? env.text
    : '';

  let title: string;
  let body: string;
  let suffix = '';

  // Detect cron envelopes two ways:
  //   1. Explicit: env.type === 'notification' && env.kind === 'cron'
  //      — what the protocol DOCUMENTED, but no production path
  //      actually emits these. Synthetic tests use this shape, and
  //      a future emitter could.
  //   2. Shape-detected: content matches the canonical
  //      "Cronjob Response: <task>\n(job_id: X)\n-------..."
  //      wrapper. This is what hermes' cron scheduler ACTUALLY
  //      produces — and it ships as reply_delta + reply_final via
  //      the parley adapter's send() method, not as a notification
  //      envelope. The kind-only gate never fires in production, so
  //      cron pushes arrived with the full boilerplate filling the
  //      banner without this shape-detection path.
  const parsedCron = parseCronContent(raw);
  const isCronShape = !!parsedCron.taskName;
  const isCronEnvelope = isCronShape
    || (env.type === 'notification' && env.kind === 'cron');

  if (isCronEnvelope) {
    // Lead with the task name + clock emoji. Push the job_id to a
    // body suffix so a watch banner shows the agent's reply text
    // first (the part the user actually wants to read).
    const taskName = parsedCron.taskName || envTitle || 'Cron';
    title = `⏰ ${taskName}`;
    body = stripLeadingMetadata(parsedCron.body);
    if (parsedCron.jobId) {
      const shortJob = parsedCron.jobId.length > 8
        ? parsedCron.jobId.slice(0, 8) : parsedCron.jobId;
      suffix = ` · ${shortJob}`;
    }
  } else if (env.type === 'reply_final') {
    title = `💬 ${envTitle || speaker}`;
    body = raw;
  } else if (env.type === 'notification' && env.kind === 'approval') {
    title = '⚠️ Approval required';
    body = approvalPreview(raw);
  } else if (env.type === 'notification') {
    title = `🔔 ${envTitle || speaker}`;
    body = stripLeadingMetadata(raw);
  } else {
    title = envTitle || speaker;
    body = raw;
  }

  // Trim + bound the body so a watch banner stays single-screen.
  // Reserve room for the suffix when present.
  const BODY_CAP = 140;
  const suffixBudget = suffix.length;
  const bodyBudget = Math.max(40, BODY_CAP - suffixBudget);
  const trimmed = body.trim();
  const bodyClipped = trimmed.length > bodyBudget
    ? trimmed.slice(0, bodyBudget - 1) + '…'
    : trimmed;
  const finalBody = bodyClipped + suffix;

  // Include parley_id (when plugin minted one) so the click handler
  // can scroll to the specific transcript row. Notifications now
  // persist as parley_notifications rows with their own
  // parley_id (notif_*) — the PWA's URL handler reads `?msg=` and
  // passes it as targetMessageId to replaySessionMessages, which
  // reuses the pin-drawer-jump scroll-to machinery.
  const parleyId = typeof env.parley_id === 'string' ? env.parley_id : '';
  const url = chatId
    ? (parleyId
        ? `/?chat=${encodeURIComponent(chatId)}&msg=${encodeURIComponent(parleyId)}`
        : `/?chat=${encodeURIComponent(chatId)}`)
    : '/';

  // tag coalesces per-chat: same chat = same tag = OS replaces the prior
  // notification instead of stacking. BUT approvals get their OWN tag
  // namespace: an approval is urgent + actionable and must NOT be
  // overwritten by the stream of `reply_final` ("Still working…") pushes
  // that share the chat during a long autonomous turn (a delivered
  // approval push can be silently replaced by the next heartbeat reply
  // for the same chat, so the approval banner never surfaces). Approvals
  // still coalesce with each other per-chat (one outstanding approval
  // banner), just independent of replies.
  const isApproval = env.type === 'notification' && env.kind === 'approval';
  const tag = chatId
    ? (isApproval ? `approval:${chatId}` : `chat:${chatId}`)
    : undefined;

  return {
    title,
    body: finalBody,
    chat_id: chatId,
    tag,
    url,
  };
}
