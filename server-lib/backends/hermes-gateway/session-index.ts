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

export async function loadSessionsIndex(): Promise<Record<string, SessionsIndexEntry>> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/** Resolve `chat_id` → `session_id` via the sidekick session-key shape.
 *  Returns null if the chat_id isn't in the index (no message has been
 *  sent yet, or the index file is missing). */
export async function resolveChatIdToSessionId(chatId: string): Promise<string | null> {
  const idx = await loadSessionsIndex();
  const entry = idx[`${SIDEKICK_KEY_PREFIX}${chatId}`];
  return entry?.session_id || null;
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
