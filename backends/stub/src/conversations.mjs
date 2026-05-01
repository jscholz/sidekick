// Conversation state for the stub agent.
//
// `conversation` (string) is a stable thread key supplied by the
// caller (sidekick passes things like `sidekick-foo-2026-04-29`).
// We keep an in-memory Map of conversation → message[] and mirror
// it to a single JSON file on disk so the agent survives restarts.
//
// Storage shape on disk (`<dataDir>/conversations.json`):
//   { "<conversation>": [{ role, content, timestamp }, ...], ... }
//
// Truncation: each conversation keeps its last MAX_TURNS turns
// (one turn = user + assistant = 2 entries) so an open-ended chat
// can't grow without bound. LLM adapters may apply their own
// context-window trimming on top.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_TURNS = 32; // ≈ 64 entries per conversation

/**
 * @typedef {{ role: 'user' | 'assistant' | 'system', content: string, timestamp: number }} Message
 */

export class Conversations {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, Message[]>} */
    this.byId = new Map();
    this._dirty = false;
    this._flushTimer = null;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) this.byId.set(k, v);
      }
    } catch (e) {
      if (e && /** @type {any} */ (e).code !== 'ENOENT') throw e;
      // No file yet — fresh start.
    }
  }

  /** @param {string} id */
  history(id) {
    return this.byId.get(id) ?? [];
  }

  /** Has the caller ever appended to this id? */
  has(id) {
    return this.byId.has(id);
  }

  /**
   * List all conversations as drawer-list summaries (most-recent-first).
   * Bounded by `limit` (default 50, capped at 200).
   * @param {number} limit
   */
  list(limit = 50) {
    const cap = Math.max(1, Math.min(200, limit));
    const out = [];
    for (const [id, msgs] of this.byId) {
      if (msgs.length === 0) continue;
      const firstUser = msgs.find(m => m.role === 'user');
      const last = msgs[msgs.length - 1];
      const created = msgs[0].timestamp ?? 0;
      const lastActive = last?.timestamp ?? created;
      out.push({
        id,
        object: 'conversation',
        created_at: Math.floor(created),
        metadata: {
          title: '',
          message_count: msgs.length,
          last_active_at: Math.floor(lastActive),
          first_user_message: firstUser?.content?.slice(0, 80) ?? null,
        },
      });
    }
    out.sort((a, b) => b.metadata.last_active_at - a.metadata.last_active_at);
    return out.slice(0, cap);
  }

  /**
   * Return transcript items in OpenAI-compatible shape, oldest-first.
   * Cursors via `before` (numeric id, integer index into the message
   * array). Returns null when the conversation doesn't exist.
   * @param {string} id
   * @param {{ limit?: number; before?: number }} opts
   */
  items(id, opts = {}) {
    const msgs = this.byId.get(id);
    if (!msgs) return null;
    const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
    let cutEnd = msgs.length;
    if (typeof opts.before === 'number') {
      cutEnd = Math.min(cutEnd, opts.before);
    }
    const start = Math.max(0, cutEnd - limit);
    const slice = msgs.slice(start, cutEnd);
    const data = slice.map((m, i) => ({
      id: start + i,
      object: 'message',
      role: m.role,
      content: m.content,
      created_at: Math.floor(m.timestamp ?? 0),
    }));
    return {
      data,
      first_id: data.length > 0 ? data[0].id : null,
      has_more: start > 0,
    };
  }

  /**
   * Hard-delete a conversation. Returns true if it existed.
   * @param {string} id
   */
  delete(id) {
    const had = this.byId.delete(id);
    if (had) this._scheduleFlush();
    return had;
  }

  /**
   * Append one message and schedule a debounced flush. Returns the
   * post-append history so callers can hand it to the LLM directly.
   * @param {string} id
   * @param {Message} msg
   */
  append(id, msg) {
    const list = this.byId.get(id) ?? [];
    list.push(msg);
    while (list.length > MAX_TURNS * 2) list.shift();
    this.byId.set(id, list);
    this._scheduleFlush();
    return list;
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this.flush();
    }, 200);
  }

  async flush() {
    if (!this._dirty) return;
    this._dirty = false;
    await mkdir(dirname(this.filePath), { recursive: true });
    /** @type {Record<string, Message[]>} */
    const obj = {};
    for (const [k, v] of this.byId) obj[k] = v;
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }
}
