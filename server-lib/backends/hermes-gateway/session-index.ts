// Reads ~/.hermes/sessions/sessions.json — hermes' on-disk
// session_key → session_id mapping (kept in sync by gateway/mirror.py).
//
// state.db's `sessions` table holds session metadata keyed by session_id
// only; the chat_id mapping lives in this JSON file. Rebuilding it
// would mean replaying every transcript, so we just read it.
//
// Stale-cache risk is low: the gateway rewrites the file on every
// session creation / rotation, and the proxy reads it per-request.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HERMES_STATE_DB } from '../hermes/config.ts';

export const SIDEKICK_KEY_PREFIX = 'agent:main:sidekick:dm:';
const HERMES_KEY_PREFIX = 'agent:main:';

/** Parse a hermes session_key into platform / chat_type / chat_id.
 *  Returns null for keys that don't match the `agent:main:<platform>:
 *  <chat_type>:<chat_id>` shape. chat_id may contain colons (some
 *  platforms have JIDs like `123@s.whatsapp.net` or composite ids). */
export function parseSessionKey(key: string): {
  platform: string;
  chatType: string;
  chatId: string;
} | null {
  if (!key.startsWith(HERMES_KEY_PREFIX)) return null;
  const rest = key.slice(HERMES_KEY_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length < 3) return null;
  const [platform, chatType, ...idParts] = parts;
  if (!platform || !chatType) return null;
  const chatId = idParts.join(':');
  if (!chatId) return null;
  return { platform, chatType, chatId };
}

export interface SessionsIndexEntry {
  session_key: string;
  session_id: string;
  platform?: string;
  chat_id?: string;
  updated_at?: string;
  created_at?: string;
}

function indexPath(): string {
  // sessions.json lives at <hermes-home>/sessions/sessions.json. Derive
  // hermes-home from HERMES_STATE_DB (same parent dir).
  return path.join(path.dirname(HERMES_STATE_DB), 'sessions', 'sessions.json');
}

/** Hermes' gateway/mirror.py writes `updated_at` / `created_at` as
 *  `datetime.now().isoformat()` — a NAIVE timestamp in the server's
 *  LOCAL timezone, with no offset/Z marker. JS Date.parse interprets
 *  unmarked ISO strings as the BROWSER's local time, which gives a
 *  TZ-mismatched result whenever the user is in a different timezone
 *  from the server (Pi in Philly, browser in London → 5h drift).
 *
 *  Fix at the proxy boundary: the timestamp's source IS the server,
 *  so the server can interpret its own naive ISO correctly via
 *  `new Date(naive)` (Node parses naive ISO as server-local) and
 *  re-emit as a Z-tagged UTC ISO. The PWA then parses unambiguously. */
function normalizeNaiveTimestamp(s: string | null | undefined): string | null {
  if (!s || typeof s !== 'string') return null;
  // Already has a TZ marker (Z, +HH:MM, -HH:MM)? Trust it.
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString();
}

export async function loadSessionsIndex(): Promise<Record<string, SessionsIndexEntry>> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Normalize naive timestamps to UTC ISO so downstream consumers
    // (the drawer's "5h ago") render correctly regardless of which
    // TZ the browser is in.
    for (const entry of Object.values(parsed)) {
      if (entry && typeof entry === 'object') {
        const e = entry as SessionsIndexEntry;
        e.updated_at = normalizeNaiveTimestamp(e.updated_at) || undefined;
        e.created_at = normalizeNaiveTimestamp(e.created_at) || undefined;
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

/** Resolve `chat_id` → `session_id`. Tries the sidekick-prefixed key
 *  first (fast path; most callers), then walks all platforms looking
 *  for a matching `:<chat_id>` suffix. Cross-platform lookup supports
 *  the cross-platform drawer view (telegram/slack/etc chats appear in
 *  the same drawer; clicking them resumes their transcript).
 *
 *  Returns null if no entry matches. */
export async function resolveChatIdToSessionId(chatId: string): Promise<string | null> {
  const idx = await loadSessionsIndex();
  const sidekick = idx[`${SIDEKICK_KEY_PREFIX}${chatId}`];
  if (sidekick?.session_id) return sidekick.session_id;
  for (const [key, entry] of Object.entries(idx)) {
    const parsed = parseSessionKey(key);
    if (parsed?.chatId === chatId && entry?.session_id) return entry.session_id;
  }
  return null;
}

/** Enumerate every sidekick chat_id we've ever seen. Returns
 *  `(chat_id, session_id, updated_at)` rows ordered by updated_at desc.
 *  Drawer enrichment then queries state.db for title + message_count
 *  per session_id. */
export async function listSidekickChats(limit = 200): Promise<{
  chat_id: string;
  session_id: string;
  updated_at: string | null;
}[]> {
  const idx = await loadSessionsIndex();
  const rows: { chat_id: string; session_id: string; updated_at: string | null }[] = [];
  for (const [key, entry] of Object.entries(idx)) {
    if (!key.startsWith(SIDEKICK_KEY_PREFIX)) continue;
    const chat_id = key.slice(SIDEKICK_KEY_PREFIX.length);
    if (!chat_id) continue;
    rows.push({
      chat_id,
      session_id: entry.session_id,
      updated_at: entry.updated_at || null,
    });
  }
  rows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return rows.slice(0, limit);
}

/** Enumerate ALL platforms' chats from sessions.json. Used by the
 *  cross-platform drawer view so telegram/slack/whatsapp/etc sessions
 *  appear alongside sidekick. The drawer renders a source badge per
 *  row; the composer goes read-only when viewing a non-sidekick chat
 *  (cross-platform send isn't supported — would require gateway-side
 *  adapter routing).
 *
 *  Returns `(chat_id, session_id, source, chat_type, updated_at)`
 *  ordered by updated_at desc. */
export async function listAllChats(limit = 200): Promise<{
  chat_id: string;
  session_id: string;
  source: string;
  chat_type: string;
  updated_at: string | null;
}[]> {
  const idx = await loadSessionsIndex();
  const rows: {
    chat_id: string;
    session_id: string;
    source: string;
    chat_type: string;
    updated_at: string | null;
  }[] = [];
  for (const [key, entry] of Object.entries(idx)) {
    const parsed = parseSessionKey(key);
    if (!parsed) continue;
    if (!entry?.session_id) continue;
    rows.push({
      chat_id: parsed.chatId,
      session_id: entry.session_id,
      source: parsed.platform,
      chat_type: parsed.chatType,
      updated_at: entry.updated_at || null,
    });
  }
  rows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return rows.slice(0, limit);
}
