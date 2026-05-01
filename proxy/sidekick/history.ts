// GET /api/sidekick/sessions/<chat_id>/messages — per-chat transcript
// replay through the agent contract. The upstream's
// `/v1/conversations/{id}/items` walks the parent_session_id chain
// server-side so the proxy doesn't need to maintain its own CTE; we
// just translate OAI items → the existing on-the-wire shape that the
// PWA renderer consumes today.

import { getUpstream } from './index.ts';
import type { UpstreamAgent } from './upstream.ts';

export async function handleSidekickSessionMessages(req, res, chatId: string) {
  // Validate chat_id shape — IDB-minted UUIDs are URL-safe base16+dash,
  // but be permissive on length to accommodate the fallback uuid()
  // implementation in src/conversations.ts.
  if (!chatId || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid chat_id' }));
    return;
  }
  const upstream = getUpstream();
  if (!upstream) {
    // Match the sessions-list endpoint: return an empty transcript
    // rather than 503 so the PWA can render its IDB cache without
    // showing an error toast for what's really an enrichment endpoint.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages: [], firstId: null, hasMore: false, unconfigured: true,
    }));
    return;
  }
  const url = new URL(req.url, 'http://x');
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10)));
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && /^\d+$/.test(beforeRaw) ? parseInt(beforeRaw, 10) : null;
  return handleSessionMessagesViaUpstream(upstream, res, chatId, limit, before);
}

async function handleSessionMessagesViaUpstream(
  upstream: UpstreamAgent,
  res: any,
  chatId: string,
  limit: number,
  before: number | null,
): Promise<void> {
  try {
    const r = await upstream.getMessages(chatId, {
      limit,
      ...(before !== null ? { before } : {}),
    });
    // Translate OAI items → existing wire shape ({id, role, content,
    // timestamp, toolName?}). The sidekick extension carries
    // `tool_name` per item so the agent-activity drawer view stays
    // lossless on replay.
    const messages = r.items.map((it) => ({
      id: it.id,
      role: it.role,
      content: it.content,
      timestamp: it.created_at,
      ...(it.tool_name ? { toolName: it.tool_name } : {}),
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      messages,
      firstId: r.first_id,
      hasMore: r.has_more,
    }));
  } catch (e: any) {
    console.error('[sidekick] session messages failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
