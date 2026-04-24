/**
 * @fileoverview Chat transcript — line rendering, speaker labels, copy button.
 */

import { escapeHtml } from './util/dom.ts';
import { miniMarkdown } from './util/markdown.ts';
import { diag } from './util/log.ts';

let transcriptEl = null;
/** @type {HTMLElement|null} */
let scrollToBottomBtn = null;
const speakerNames = {};
let speakerCount = 0;

// Transcript snapshot persistence. Moved from sessionStorage to IndexedDB
// because sessionStorage (a) capped at ~5MB on Safari — base64 attachments
// push a busy chat over the limit and persist() silently rolls back to the
// stale snapshot, (b) vanishes when iOS evicts the PWA, and (c) doesn't
// survive a hard app-kill. IDB: GB-scale quota, survives tab close, and
// keeps the "reload always restores everything" invariant the user expects.
const DB_NAME = 'sidekick-chat';
const STORE = 'transcripts';
const SNAPSHOT_KEY = 'current';
const LEGACY_SS_KEY = 'sidekick.transcript.v1';

function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP<T = any>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function loadSnapshot() {
  try {
    const db = await dbOpen();
    const rec = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(SNAPSHOT_KEY));
    db.close();
    if (rec?.html) return rec.html;
  } catch {}
  // One-time migration from the old sessionStorage snapshot so in-progress
  // sessions don't lose their chat when this version deploys.
  try {
    const legacy = sessionStorage.getItem(LEGACY_SS_KEY);
    if (legacy) return legacy;
  } catch {}
  return null;
}

async function saveSnapshot(html) {
  try {
    const db = await dbOpen();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ key: SNAPSHOT_KEY, html, at: Date.now() }));
    db.close();
  } catch {}
}

async function clearSnapshot() {
  try {
    const db = await dbOpen();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(SNAPSHOT_KEY));
    db.close();
  } catch {}
  try { sessionStorage.removeItem(LEGACY_SS_KEY); } catch {}
}

/** Pixels from bottom within which the user is considered "pinned" to the
 *  live edge — new messages auto-scroll. Past this threshold (they've
 *  scrolled up to read earlier content), auto-scroll is suspended and the
 *  jump-to-bottom button appears. */
const PINNED_THRESHOLD_PX = 80;

let pinnedToBottom = true;
let missedWhileScrolled = 0;

function isPinned() {
  if (!transcriptEl) return true;
  const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
  return distance <= PINNED_THRESHOLD_PX;
}

function updateButton() {
  if (!scrollToBottomBtn) return;
  scrollToBottomBtn.classList.toggle('visible', !pinnedToBottom);
  scrollToBottomBtn.classList.toggle('has-unread', missedWhileScrolled > 0);
  scrollToBottomBtn.setAttribute('aria-hidden', pinnedToBottom ? 'true' : 'false');
  if (missedWhileScrolled > 0) {
    const badge = scrollToBottomBtn.querySelector('.scroll-to-bottom-badge');
    if (badge) badge.textContent = String(Math.min(missedWhileScrolled, 99));
  }
}

/** Unconditional scroll to the live edge. Used by initial loads,
 *  user-initiated jump-to-bottom, and anywhere we deliberately want to
 *  override the "user scrolled up" state. */
export function forceScrollToBottom() {
  if (!transcriptEl) return;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  pinnedToBottom = true;
  missedWhileScrolled = 0;
  updateButton();
}

/** Scroll to the live edge ONLY if the user is already pinned. If they've
 *  scrolled up to read earlier, leave their position alone and count the
 *  new message toward the unread badge on the jump-to-bottom button. */
export function autoScroll() {
  if (!transcriptEl) return;
  if (pinnedToBottom) {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else {
    missedWhileScrolled++;
    updateButton();
  }
}

/** Returns true if a transcript snapshot was restored. Caller may still
 *  run backfill — dedup on text handles overlap. Async because IDB reads
 *  can't be synchronous; the cold-boot flash is sub-frame on modern devices. */
export async function init(el) {
  transcriptEl = el;

  // Jump-to-bottom button wiring. The button lives outside the transcript
  // scroller (as a sibling inside .chat-column) so it stays fixed while
  // the transcript scrolls.
  scrollToBottomBtn = /** @type {HTMLElement|null} */ (document.getElementById('scroll-to-bottom'));
  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener('click', () => forceScrollToBottom());
  }
  if (transcriptEl) {
    // Update pinned state whenever the user scrolls. Passive for perf.
    transcriptEl.addEventListener('scroll', () => {
      const wasPinned = pinnedToBottom;
      pinnedToBottom = isPinned();
      if (pinnedToBottom && !wasPinned) missedWhileScrolled = 0;
      updateButton();
    }, { passive: true });
  }

  try {
    const saved = await loadSnapshot();
    if (saved && transcriptEl) {
      transcriptEl.innerHTML = saved;
      // Strip stale memo cards — their audio element + blob reference are dead
      // after serialization. Caller will re-render them fresh from IndexedDB.
      transcriptEl.querySelectorAll('.memo-card').forEach(el => el.remove());
      // Initial load: always jump to latest regardless of the default
      // pinned-to-bottom state.
      forceScrollToBottom();
      // Re-wire copy buttons on restored elements. Same source-of-truth as
      // the live-create path: prefer dataset.text (raw markdown) over
      // rendered textContent so round-trip copy is lossless.
      transcriptEl.querySelectorAll('.copy-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const line = /** @type {HTMLElement} */ (btn.closest('.line'));
          const text = line?.dataset.text
            || line?.querySelector('.text')?.textContent
            || '';
          navigator.clipboard.writeText(text).catch(() => {});
        };
      });
      // Reset play-bar state on restored agent bubbles. Audio buffers are
      // in-memory and don't survive reload; serialized bar widths + state
      // classes would give a false "already loaded / already played" look.
      // User clicks play → re-synthesis happens fresh.
      const seenIds = new Set();
      transcriptEl.querySelectorAll('.line.agent').forEach(el => {
        const line = /** @type {HTMLElement} */ (el);
        line.classList.remove('tts-active', 'tts-streaming', 'tts-playing', 'tts-paused', 'tts-played');
        const loaded = line.querySelector('.play-bar-loaded');
        const played = line.querySelector('.play-bar-played');
        if (loaded) /** @type {HTMLElement} */ (loaded).style.width = '0%';
        if (played) /** @type {HTMLElement} */ (played).style.width = '0%';
        // Invariant: each agent bubble must have a unique data-reply-id.
        // If a snapshot contains duplicates (from a version that let
        // streamingTtsReplyId leak across replies), re-mint on the
        // duplicates so play-click routing can distinguish them.
        const id = line.dataset.replyId;
        if (!id || seenIds.has(id)) {
          line.dataset.replyId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        seenIds.add(line.dataset.replyId);
      });
      return true;
    }
  } catch {}
  return false;
}

/** Fire-and-forget snapshot write to IndexedDB. Backfill from the gateway
 *  still plugs any gap on next connect (see always-run-backfill branch in
 *  main.ts) in case the IDB write fails mid-flight. */
function persist() {
  if (!transcriptEl) return;
  const html = transcriptEl.innerHTML;
  saveSnapshot(html).catch((e) => diag(`chat.persist failed: ${e?.message || 'idb error'}`));
}

export function speakerLabel(id) {
  if (id == null) return 'Speaker';
  if (!speakerNames[id]) speakerNames[id] = `Speaker ${++speakerCount}`;
  return speakerNames[id];
}

/** Format a timestamp as HH:MM (24h) for top-right display on each line. */
function formatTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/**
 * @param {string} speaker
 * @param {string} text
 * @param {string} [cls]
 * @param {Object} [opts]
 * @param {boolean} [opts.markdown] Render text as markdown (for agent replies).
 * @param {'voice'|'text'|'sent'|undefined} [opts.source] Input source indicator.
 * @param {number|Date|string} [opts.timestamp] Message timestamp; defaults to now.
 * @param {Array<{dataUrl: string, mimeType: string, fileName?: string}>} [opts.attachments] Image thumbnails rendered under the line.
 * @param {string} [opts.replyId] TTS reply id for agent lines — links bubble to playback events (loading/playback bar + play icon wiring).
 */
export function addLine(speaker: string, text: string, cls = '', opts: {
  source?: 'voice' | 'text';
  markdown?: boolean;
  timestamp?: number | Date | string;
  attachments?: Array<{ dataUrl: string; mimeType: string; fileName?: string }>;
  replyId?: string;
} = {}) {
  if (!transcriptEl) return null;
  const div = document.createElement('div');
  div.className = `line ${cls}`;
  if (opts.replyId) div.dataset.replyId = opts.replyId;
  if (cls.includes('agent')) div.dataset.text = text;  // replyPlayer uses this for replay

  // Source icon: minimal line-style indicator of voice vs typed
  const micSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z"/><path d="M4 7a4 4 0 0 0 8 0"/><path d="M8 12v2.5M6 14.5h4"/></svg>`;
  const kbdSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3.5" width="14" height="9" rx="1.5"/><path d="M4 10.5h8"/><circle cx="5" cy="7" r="0.5" fill="currentColor"/><circle cx="8" cy="7" r="0.5" fill="currentColor"/><circle cx="11" cy="7" r="0.5" fill="currentColor"/></svg>`;
  const sourceIcon = opts.source === 'voice' ? `<span class="source-icon" title="voice">${micSvg}</span>`
    : opts.source === 'text' ? `<span class="source-icon" title="typed">${kbdSvg}</span>`
    : '';

  const speakerSpan = `<span class="speaker">${sourceIcon}${escapeHtml(speaker)}:</span> `;
  const rendered = opts.markdown ? miniMarkdown(text) : escapeHtml(text);
  div.innerHTML = speakerSpan + `<span class="text">${rendered}</span>`;

  // Timestamp — top-right, left of the copy icon
  const ts = opts.timestamp ?? Date.now();
  const tsEl = document.createElement('span');
  tsEl.className = 'line-ts';
  tsEl.textContent = formatTime(ts);
  tsEl.title = new Date(ts).toLocaleString();
  div.appendChild(tsEl);

  // Copy button — standard overlapping-rectangles icon
  const copySvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5V3.5a1.5 1.5 0 0 1 1.5-1.5h7"/></svg>`;
  const checkSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>`;
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.title = 'Copy text';
  copyBtn.innerHTML = copySvg;
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    // Read text live from the bubble (not the closure `text` arg), since
    // agent streaming mutates .text span + dataset.text after creation.
    // Prefer dataset.text (raw source) for agent lines — lossless for
    // round-trip paste. Falls back to textContent (strips speaker label
    // since it's in a separate .speaker span).
    const liveText = div.dataset.text
      || (div.querySelector('.text') as HTMLElement | null)?.textContent
      || '';
    navigator.clipboard.writeText(liveText).then(() => {
      copyBtn.innerHTML = checkSvg;
      setTimeout(() => { copyBtn.innerHTML = copySvg; }, 1500);
    });
  };
  div.appendChild(copyBtn);

  // Agent lines get a play button + a loading/playback bar along the top
  // of the bubble. Both play + pause glyphs are rendered; CSS swaps
  // visibility based on .tts-playing / .tts-paused classes so replyPlayer
  // doesn't have to re-render the SVG on every state transition.
  if (cls.includes('agent')) {
    const playGlyph = `<svg class="glyph-play" viewBox="0 0 16 16" fill="none"><polygon points="5 3 13 8 5 13 5 3" fill="currentColor"/></svg>`;
    const pauseGlyph = `<svg class="glyph-pause" viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3" height="10" fill="currentColor"/><rect x="9" y="3" width="3" height="10" fill="currentColor"/></svg>`;
    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.title = 'Play this reply';
    playBtn.innerHTML = playGlyph + pauseGlyph;
    div.appendChild(playBtn);

    const bar = document.createElement('div');
    bar.className = 'play-bar';
    bar.innerHTML = `<div class="play-bar-loaded"></div><div class="play-bar-played"></div>`;
    div.appendChild(bar);
  }

  // All links in rendered markdown open in new tab
  if (opts.markdown) {
    div.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  }

  // Attachment thumbnails — images render as tappable <img>, videos as
  // in-place <video controls>. Both link out via the lightbox for a
  // larger view. Gateway handling is permissive: it bundles both as
  // `type: 'image'` blocks; which models accept video is model-
  // specific (Gemini / some Gemma variants do).
  if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
    const attDiv = document.createElement('div');
    attDiv.className = 'line-attachments';
    for (const att of opts.attachments) {
      if (!att?.dataUrl) continue;
      if (att.mimeType?.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        img.alt = att.fileName || 'attachment';
        img.title = att.fileName || 'attachment';
        img.loading = 'lazy';
        img.onclick = () => openLightbox(att.dataUrl);
        attDiv.appendChild(img);
      } else if (att.mimeType?.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.src = att.dataUrl;
        vid.controls = true;
        vid.preload = 'metadata';
        vid.playsInline = true;
        vid.title = att.fileName || 'attachment';
        attDiv.appendChild(vid);
      }
    }
    if (attDiv.children.length > 0) div.appendChild(attDiv);
  }

  transcriptEl.appendChild(div);
  autoScroll();
  persist();
  return div;
}

/** Open a full-screen overlay showing the given image. Tap anywhere to dismiss. */
function openLightbox(src) {
  document.getElementById('lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'lightbox';
  overlay.onclick = () => overlay.remove();
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  document.body.appendChild(overlay);
}

/** Render a muted, italic, centered "system" line — for session events
 *  like model changes or new-chat resets. Distinct visually from regular
 *  agent/user messages. */
export function addSystemLine(text) {
  if (!transcriptEl) return null;
  const div = document.createElement('div');
  div.className = 'line system';
  div.textContent = text;
  transcriptEl.appendChild(div);
  autoScroll();
  persist();
  return div;
}

/** Clear transcript and persisted state (used by refresh). */
export function clear() {
  if (transcriptEl) transcriptEl.innerHTML = '';
  clearSnapshot().catch(() => {});
}
