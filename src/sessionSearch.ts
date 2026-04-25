/**
 * @fileoverview Single client-side search API for the unified server
 * endpoint at GET /api/hermes/search. Both the inline drawer filter and
 * the cmd+K palette consume this module — no other call site for the
 * server endpoint should exist.
 *
 * Three modes (mirroring the server's `kind` param):
 *   - searchSessions(q, limit)   → SessionRow[]   (glob/substring over
 *                                                  title/source/id/conv)
 *   - searchMessages(q, limit)   → MessageHit[]   (FTS5 over messages_fts)
 *   - searchBoth(q, limit)       → {sessions, hits, error?}
 *
 * The pure functions in src/sessionFilter.ts (parseQuery + applyFilter)
 * remain the client-side fallback used by the drawer for instant feedback
 * over the cached list while a debounced server round-trip is in flight.
 * They are NOT replaced by this module — they're complementary.
 */

import { diag } from './util/log.ts';

export type SessionRow = {
  id: string;
  source?: string | null;
  title?: string | null;
  snippet?: string | null;
  messageCount?: number | null;
  lastMessageAt?: number | null;
  [k: string]: any;
};

export type MessageHit = {
  session_id: string;
  message_id: number;
  role: string;
  snippet: string;
  timestamp: number;
  session_title?: string;
  session_source?: string;
};

export type SearchBothResult = {
  sessions: SessionRow[];
  hits: MessageHit[];
  /** FTS5/index error (sessions still populated). Only set on the messages path. */
  error?: string;
};

function buildUrl(kind: 'sessions' | 'messages' | 'both', q: string, limit: number): string {
  const params = new URLSearchParams({ kind, q, limit: String(limit) });
  return `/api/hermes/search?${params}`;
}

/** Server-side session search. Empty `q` returns all sessions (limit=50
 *  by default — matches the legacy /api/hermes/sessions semantics so
 *  callers that switch endpoints don't need to special-case the empty
 *  query). Returns [] on network/parse failure. */
export async function searchSessions(q: string, limit = 50, signal?: AbortSignal): Promise<SessionRow[]> {
  try {
    const r = await fetch(buildUrl('sessions', q, limit), { signal });
    if (!r.ok) return [];
    const body = await r.json();
    return (body.sessions || []) as SessionRow[];
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    diag(`sessionSearch.searchSessions failed: ${e?.message || e}`);
    return [];
  }
}

/** Server-side FTS5 message search. Empty `q` returns []. Returns []
 *  on network/parse failure. */
export async function searchMessages(q: string, limit = 20, signal?: AbortSignal): Promise<MessageHit[]> {
  try {
    const r = await fetch(buildUrl('messages', q, limit), { signal });
    if (!r.ok) return [];
    const body = await r.json();
    return (body.hits || []) as MessageHit[];
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    diag(`sessionSearch.searchMessages failed: ${e?.message || e}`);
    return [];
  }
}

/** Combined sessions+messages search — what cmd+K wants by default.
 *  Single round trip, both result sections in one envelope. */
export async function searchBoth(q: string, limit = 20, signal?: AbortSignal): Promise<SearchBothResult> {
  try {
    const r = await fetch(buildUrl('both', q, limit), { signal });
    if (!r.ok) return { sessions: [], hits: [] };
    const body = await r.json();
    return {
      sessions: (body.sessions || []) as SessionRow[],
      hits: (body.hits || []) as MessageHit[],
      error: body.error,
    };
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    diag(`sessionSearch.searchBoth failed: ${e?.message || e}`);
    return { sessions: [], hits: [] };
  }
}
