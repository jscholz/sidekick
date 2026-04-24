/**
 * @fileoverview Voice-to-draft pipeline — turns Deepgram STT events into
 * draft-block updates (the orange card in the transcript). Handles
 * commit-word detection, post-barge-in dismissive-speech cooldown, and
 * the silence-timer auto-send loop.
 *
 * Why the draft card (not the composer) for streaming STT:
 *   • Hands-free conversation + autoSend-on-silence is a different
 *     interaction paradigm from "type a message." Auto-submitting
 *     whatever's in the composer — including half-typed text — surprises.
 *   • Long dictations are more legible in a scaling orange card than a
 *     two-line textarea. Matters on the bike.
 *   • Commit-word ("over") as hands-free send lives naturally in a
 *     dedicated buffer; trying to make it work inside a typing field is
 *     awkward.
 *
 * The memo button (composer row) uses a different path and DOES target
 * the composer — see main.ts. That's a brief record-and-review flow,
 * matching chat-app convention.
 *
 * State owned here:
 *   • silenceTimer — debounce for auto-send in live mode
 *   • bargeInCooldownUntil — wall-clock ms; speech before this time is
 *     filtered for dismissive phrases ("ok", "yeah", "shut up", etc.)
 *     right after the user interrupts TTS with their voice.
 */

import { log, diag } from '../../util/log.ts';
import * as settings from '../../settings.ts';
import * as chat from '../../chat.ts';
import * as draft from '../../draft.ts';
import * as sttBackfill from './sttBackfill.ts';
import { playFeedback } from '../../audio/feedback.ts';

let silenceTimer = null;
let bargeInCooldownUntil = 0;

/** Last interim transcript that hasn't been superseded by a final yet.
 *  Used by the UtteranceEnd handler to promote orphaned interims — the
 *  recognizer sometimes ends an utterance (Web Speech `onend`, DG
 *  `UtteranceEnd` after a stall) without emitting a matching isFinal=true.
 *  Without promotion the grey interim text vanishes from the draft and
 *  the user watches their words disappear. */
let lastInterim = null;

const DISMISSIVE_RE = /^(shut up|stop|quiet|enough|ok|okay|yeah|yes|got it|i get it|ok i get it|yeah i get it|okay i get it|yeah ok|ok ok|alright|never\s?mind|shh+)\.?$/i;

/** Set a cooldown window (ms from now) during which short / dismissive
 *  speech is swallowed instead of appended. Called by the TTS stop
 *  callback when stop reason is 'barge-in'. */
export function setBargeInCooldown(ms) {
  bargeInCooldownUntil = Date.now() + ms;
}

/** Clear any pending auto-send timer. Call on mic stop, TTS-toggle-off,
 *  and draft focus (user started editing → don't send under them). */
export function cancelPendingFlush() {
  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
}

/** Schedule an auto-send flush `delayMs` from now, but defer the actual
 *  flush if we're currently inside a Deepgram WS dropout. Otherwise long
 *  connectivity hiccups produce two user messages: one at silence-timer
 *  expiry against the partial pre-drop draft, and a second when the
 *  sttBackfill-recovered text arrives to extend the same thought.
 *
 *  Implementation: the timer always fires after `delayMs`, but if a gap
 *  is still open we just reschedule another `delayMs`. Next firing
 *  re-checks; once the gap closes, the next tick flushes normally.
 *  `cancelPendingFlush()` aborts the loop at any time. */
function scheduleAutoFlush(delayMs) {
  cancelPendingFlush();
  const tick = () => {
    if (sttBackfill.isInGap()) {
      diag(`voice: silence timer fired during DG dropout — deferring flush ${delayMs}ms`);
      silenceTimer = setTimeout(tick, delayMs);
      return;
    }
    silenceTimer = null;
    draft.flush();
  };
  silenceTimer = setTimeout(tick, delayMs);
}

/** After a dictation session ends, ask sttBackfill for any post-hoc
 *  transcripts of periods where DG was offline and splice them into
 *  the draft. Each gap arrives as a distinct segment with the
 *  .draft-backfill visual marker so the user knows it's recovered
 *  audio rather than live transcription. */
export async function flushBackfill() {
  try {
    const gaps = await sttBackfill.flushGaps();
    if (!gaps.length) return;
    for (const g of gaps) {
      if (g.text && g.text.trim()) {
        // ctxStart is the audio-context time at gap start — draft.ts
        // uses it to splice the text at the chronologically correct
        // position relative to live segments it recorded.
        draft.appendBackfill(g.text.trim(), g.ctxStart);
      }
    }
    log(`voice.flushBackfill: spliced ${gaps.length} gap segment(s) into draft`);
  } catch (e) {
    log(`voice.flushBackfill failed: ${e.message}`);
  }
}

/** Build a whole-utterance regex from a pipe-separated keyword list.
 *  Anchored so only a bare "previous chat." (± punctuation) matches,
 *  not "yeah previous chat seemed fine." Empty/whitespace input
 *  returns null → that command is disabled. */
function buildNavRegex(phrases) {
  if (!phrases || typeof phrases !== 'string') return null;
  const parts = phrases.split('|').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const escaped = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(?:${escaped})[\\s.,!?]*$`, 'i');
}

/** Detect voice-nav command at end-of-utterance. Phrases come from
 *  settings (navPrev / navNext / navPause), so users can customize or
 *  add aliases via pipe-separator (`previous chat|back chat`). Evaluated
 *  lazily so a settings change takes effect on the next utterance. */
function detectNavCommand(transcript) {
  const s = transcript.trim();
  const cfg = settings.get();
  const patterns: Array<{ action: 'prev' | 'next' | 'pause'; raw: string }> = [
    { action: 'prev',  raw: cfg.navPrev },
    { action: 'next',  raw: cfg.navNext },
    { action: 'pause', raw: cfg.navPause },
  ];
  for (const { action, raw } of patterns) {
    const re = buildNavRegex(raw);
    if (re && re.test(s)) return action;
  }
  return null;
}

/** True when the configured commit phrase was just spoken at end-of-utterance.
 *  Returns { committed, text } — `text` is the transcript with the commit
 *  phrase stripped (may be empty if the whole utterance was just the phrase). */
function detectCommit(transcript) {
  const s = settings.get();
  if (!s.commitPhrase) return { committed: false, text: transcript };
  const escaped = s.commitPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(.*)\\s*\\b${escaped}\\b[\\s.,!?]*$`, 'i');
  const m = transcript.match(re);
  if (!m) return { committed: false, text: transcript };
  const stripped = m[1].trim();
  if (stripped) return { committed: true, text: stripped };
  // Whole utterance was the commit phrase — commit iff there's already
  // a draft to flush (otherwise a stray "over" is just noise).
  return { committed: draft.hasContent(), text: '' };
}

/** Main entry point — called from deepgram.ts with every STT event. */
export function handleResult(data) {
  if (data.type === 'Results') {
    const alt = data.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    const isFinal = data.is_final;
    const words = alt.words || [];
    const speaker = words.length > 0 ? words[0].speaker : null;
    const label = chat.speakerLabel(speaker);

    if (isFinal && alt.transcript.trim()) {
      let transcript = alt.transcript.trim();
      // A final supersedes any pending interim — the recognizer has
      // confirmed the text, so there's nothing to promote on UtteranceEnd.
      lastInterim = null;

      // Voice nav keywords ("prev chat" / "next chat" / "pause chat") —
      // short-circuit BEFORE commit-word + draft-append so they don't
      // get sent to the agent as a message. Dispatches a window event;
      // main.ts routes to skipTo() / tts.pause().
      const navAction = detectNavCommand(transcript);
      if (navAction) {
        diag(`voice: nav command: ${navAction}`);
        window.dispatchEvent(new CustomEvent('sidekick:nav', { detail: { action: navAction } }));
        draft.clearInterim();
        return;
      }

      const commit = detectCommit(transcript);
      transcript = commit.text;
      const committed = commit.committed;

      // Diagnostic trace for the "interim-to-final drop" investigation.
      // Shows what DG finalized, what passed the commit-word strip, and
      // what happened next (append / swallow / empty-after-strip).
      // Silent unless ?debug=1 or localStorage.sidekick_debug=1.
      diag(`voice: final raw="${alt.transcript.trim().slice(0,60)}" strip="${transcript.slice(0,60)}" committed=${committed}`);

      if (transcript) {
        if (Date.now() < bargeInCooldownUntil) {
          // Only swallow if it actually matches a dismissive phrase.
          // The old ≤3-words heuristic was too aggressive: DG's 300ms
          // endpointing chops real speech into short finals, and the
          // filter was eating the first couple of those after every
          // barge-in — user saw interim text in grey but finals never
          // landed until one chunk happened to exceed 3 words.
          if (DISMISSIVE_RE.test(transcript)) {
            log('post-barge-in swallowed (dismissive):', transcript);
          } else {
            bargeInCooldownUntil = 0;
            draft.append(transcript, label);
          }
        } else {
          draft.append(transcript, label);
        }
      }

      if (settings.get().autoSend && !draft.isEditing()) {
        if (committed) {
          // Audible confirmation that we heard the commit word. Pairs
          // with the 'send' chime that fires from main.ts when the
          // message actually ships. Distinct tones so the user can
          // hear whether the send landed without looking at the screen.
          playFeedback('commit');
          const delaySec = settings.get().commitDelaySec ?? 1.5;
          if (delaySec === 0) {
            cancelPendingFlush();
            draft.flush();
          } else {
            scheduleAutoFlush(delaySec * 1000);
          }
        } else if (draft.hasContent()) {
          scheduleAutoFlush(settings.get().silenceSec * 1000);
        }
      }
    } else if (!isFinal && alt.transcript.trim()) {
      const interimText = alt.transcript.trim();
      diag(`voice: interim="${interimText.slice(0,80)}"`);
      lastInterim = { text: interimText, label };
      draft.setInterim(interimText, label);
    }
  }

  if (data.type === 'UtteranceEnd') {
    // Promote any orphaned interim to a final before clearing. Finals
    // null lastInterim, so if it's still set the recognizer showed text
    // but never confirmed it — treat the last interim as the final take.
    if (lastInterim && lastInterim.text) {
      diag(`voice: promoting interim on UtteranceEnd: "${lastInterim.text.slice(0,60)}"`);
      draft.append(lastInterim.text, lastInterim.label);
      if (settings.get().autoSend && !draft.isEditing()) {
        scheduleAutoFlush(settings.get().silenceSec * 1000);
      }
    }
    lastInterim = null;
    draft.clearInterim();
    draft.appendParagraphBreak();
    if (settings.get().autoSend && !draft.isEditing() && !silenceTimer && draft.hasContent()) {
      scheduleAutoFlush(settings.get().silenceSec * 1000);
    }
  }
}
