// /api/sidekick/sessions handlers — drawer list + per-chat delete.
// Both go through the agent contract (HTTP+SSE), which means the
// proxy doesn't reach into hermes's filesystem (state.db,
// sessions.json, jsonl) anymore — the plugin owns that read.
//
//   GET    /api/sidekick/sessions          → drawer list
//   DELETE /api/sidekick/sessions/<chatId> → cascade delete
//
// Drawer-list behavior:
//   1. Probe `/v1/gateway/conversations` (gateway extension). Hermes
//      and any other multi-platform agent implements it and returns
//      cross-source rows with `source` + `chat_type` in metadata.
//   2. On 404 (single-channel agent — stub, raw OAI third-party),
//      fall back to `/v1/conversations` and stamp `source: 'sidekick'`
//      on each row so the composer stays editable.

import { getUpstream } from './index.ts';
import type {
  ConversationSummary,
  GatewayConversationSummary,
  UpstreamAgent,
} from './upstream.ts';

interface SidekickSessionRow {
  chat_id: string;
  source: string;
  title: string;
  message_count: number;
  last_active_at: string | null;
  created_at: string | null;
  /** Snippet of the first user message in this session, truncated to
   *  ~80 chars by the upstream. Lets the drawer fall back to a
   *  meaningful label when the agent hasn't generated a title yet
   *  (model error / blip / race). Null when no user message exists
   *  on disk yet. */
  first_user_message: string | null;
}

/** GET /api/sidekick/sessions
 *
 *  Returns: { sessions: [{ chat_id, source, title, message_count,
 *                          last_active_at, created_at,
 *                          first_user_message }] }
 *
 *  Order: most-recently-active first.
 *  Limit via ?limit=N (1..200, default 50).
 *
 *  No-token cases return an empty list (NOT 503) — the PWA can render
 *  its own IDB-backed drawer offline and would otherwise show an
 *  unhelpful disconnected-state toast for what's really an
 *  enrichment endpoint. */
export async function handleSidekickSessionsList(req, res) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessions: [], unconfigured: true }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
  let rows: SidekickSessionRow[] = [];
  try {
    const gateway = await upstream.listGatewayConversations(limit);
    if (gateway !== null) {
      rows = gateway.map(gatewayRowToSidekickRow);
    } else {
      const channel = await upstream.listConversations(limit);
      rows = channel.map(channelRowToSidekickRow);
    }
  } catch (e: any) {
    console.warn('[sidekick] sessions list failed:', e.message);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ sessions: rows }));
}

/** DELETE /api/sidekick/sessions/<chat_id>
 *
 *  Hard delete via the agent contract — the upstream cascades through
 *  its own state (state.db, sessions.json, jsonl, hindsight memory).
 *  Returns 200 on success, 503 if the platform isn't configured. */
export async function handleSidekickSessionDelete(req, res, chatId: string) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sidekick_platform_unconfigured' }));
    return;
  }
  if (!chatId || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  try {
    await upstream.deleteConversation(chatId);
  } catch (e: any) {
    console.warn(`[sidekick] delete failed for ${chatId}:`, e?.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message || 'upstream delete failed' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

/** Translate the agent's OAI-shape gateway row into the on-the-wire
 *  shape the PWA already expects. Plugin returns unix-second
 *  timestamps; we ISO-format them for parity with what the legacy
 *  filesystem-direct path used to send. */
function gatewayRowToSidekickRow(
  row: GatewayConversationSummary,
): SidekickSessionRow {
  const m = row.metadata;
  return {
    chat_id: row.id,
    source: m.source,
    title: m.title,
    message_count: m.message_count,
    last_active_at: m.last_active_at
      ? new Date(m.last_active_at * 1000).toISOString()
      : null,
    created_at: row.created_at
      ? new Date(row.created_at * 1000).toISOString()
      : null,
    first_user_message: m.first_user_message,
  };
}

/** Channel-only fallback: source defaults to 'sidekick' so the
 *  composer stays editable (`source !== 'sidekick'` => read-only,
 *  src/main.ts:2446). For single-channel agents (stub / raw OAI
 *  third-party / future openclaw-without-gateway), the agent IS the
 *  sidekick channel by definition. */
function channelRowToSidekickRow(
  row: ConversationSummary,
): SidekickSessionRow {
  const m = row.metadata;
  return {
    chat_id: row.id,
    source: 'sidekick',
    title: m.title,
    message_count: m.message_count,
    last_active_at: m.last_active_at
      ? new Date(m.last_active_at * 1000).toISOString()
      : null,
    created_at: row.created_at
      ? new Date(row.created_at * 1000).toISOString()
      : null,
    first_user_message: m.first_user_message,
  };
}
