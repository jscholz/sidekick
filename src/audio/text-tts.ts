/**
 * @fileoverview HTTP TTS playback for text-typed agent replies.
 *
 * Wired from `main.ts:handleReplyFinal` whenever `settings.tts` is on AND
 * a WebRTC call is NOT in progress (call mode owns audio end-to-end via
 * its own peer-track TTS). Fetches Deepgram Aura via the server's
 * `/tts` proxy and plays the returned mp3 through the shared `#player`
 * audio element. Cancellation is "last reply wins" — a fresh
 * `playReplyTts()` cancels any in-flight playback before starting.
 *
 * iOS gesture binding: the playback path needs a primed AudioContext to
 * actually emit sound on Mobile Safari. The send button handler already
 * touches mic/audio (via memo / dictate / call paths), and the global
 * pointerdown/keydown unlock at boot covers all other entry points.
 * If a future regression surfaces silent playback on iOS for typed
 * sends specifically, add a `primeAudio(player)` call inside
 * `sendTypedMessage` adjacent to `playFeedback('send')`.
 *
 * Text cleaning: re-implements the regex set from
 * `test/tts-clean.test.ts` (whose `cleanForTts` was once exported from
 * `src/pipelines/classic/tts.ts` — file is gone, regex set lives on in
 * the test as the canonical reference). Keep these in sync.
 */

import { log, diag } from '../util/log.ts';

/** Tracks the active fetch + playback so a follow-up reply can cancel
 *  it. Module-level singleton — only one text-mode TTS plays at a time
 *  per page (call-mode TTS is owned separately by the WebRTC peer
 *  track). */
let active: { audio: HTMLAudioElement; abort: AbortController } | null = null;

/** Strip markdown / URLs / emoji that don't read well when synthesized.
 *  Kept in lock-step with `test/tts-clean.test.ts`. */
function cleanForTts(text: string): string {
  let t = text;
  t = t.replace(/^\[[A-Za-z0-9_\- ]+\]\s*/, '');
  t = t.replace(/```[\s\S]*?```/g, '[code block]');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/^[\s]*[-*•]\s+/gm, '');
  t = t.replace(/^#+\s+/gm, '');
  t = t.replace(/https?:\/\/[^\s<)\]"']+/g, '(link in canvas)');
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
  t = t.replace(/\*/g, '');
  t = t.replace(/^[#\-\s]+$/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  // /tts server caps at 2000 chars; stay under to leave headroom.
  return t.slice(0, 1800);
}

/** Cancel any in-flight TTS fetch + playback. Safe to call when idle.
 *  Used by:
 *    - playReplyTts() at the start (last-reply-wins)
 *    - flipMicSetting('tts') when toggling OFF (user wants silence now)
 *    - openCall() when entering a WebRTC call (call owns audio) */
export function cancelReplyTts(): void {
  if (!active) return;
  try { active.abort.abort(); } catch { /* noop */ }
  try {
    active.audio.pause();
    // Drop the blob src so the GC reclaims the decoded audio data.
    if (active.audio.src) {
      try { URL.revokeObjectURL(active.audio.src); } catch { /* noop */ }
      active.audio.removeAttribute('src');
      active.audio.load();
    }
  } catch { /* noop */ }
  active = null;
}

/** Synthesize + play `text` through the page's `#player` element.
 *  Best-effort: returns a resolved Promise on success or after a
 *  cancellation; rejects only on hard errors the caller may want to
 *  log. Caller is `handleReplyFinal` → so failures must NOT throw
 *  past the catch block there.
 *
 *  Voice is read off `settings.voice` (same one WebRTC talk mode uses,
 *  so users get one consistent voice for both surfaces). */
export async function playReplyTts(
  rawText: string,
  voice: string,
): Promise<void> {
  const text = cleanForTts(rawText || '');
  if (!text) return;

  cancelReplyTts();

  const player = document.getElementById('player') as HTMLAudioElement | null;
  if (!player) {
    diag('[text-tts] no #player element — skipping');
    return;
  }

  const abort = new AbortController();
  active = { audio: player, abort };

  let blobUrl: string | null = null;
  try {
    const res = await fetch('/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, model: voice }),
      signal: abort.signal,
    });
    if (!res.ok) {
      diag(`[text-tts] /tts ${res.status}`);
      return;
    }
    const blob = await res.blob();
    if (abort.signal.aborted) return;
    blobUrl = URL.createObjectURL(blob);
    player.src = blobUrl;
    // Avoid pausing in the click-to-pause case from the WebRTC peer
    // track's previous srcObject binding.
    player.srcObject = null;
    await player.play();
    log(`[text-tts] playing ${text.length} chars`);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`[text-tts] failed: ${e?.message || e}`);
  } finally {
    if (active && active.abort === abort) active = null;
  }
}
