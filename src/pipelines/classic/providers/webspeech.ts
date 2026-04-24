/**
 * @fileoverview Web Speech API STT provider. The reference implementation
 * of the STTProvider contract (see ./types.ts). Works offline on most
 * mobile browsers and is a natural fallback when a server provider
 * (Deepgram WS) can't reach its backend.
 *
 * Limitations vs. server providers:
 *   - No word-level timings (`words` in STTResult is always empty)
 *   - No speaker diarisation
 *   - The browser's internal mic capture isn't exposed, so we can't tap
 *     it for barge-in detection — that has to be done via a separate
 *     AudioWorklet on the shared stream (see bargeIn.ts startMonitor).
 *   - Quality varies wildly by browser (Safari iOS: very good; Chrome
 *     desktop: decent; Firefox: not implemented).
 *
 * @typedef {import('./types.js').STTProvider} STTProvider
 * @typedef {import('./types.js').STTSession} STTSession
 * @typedef {import('./types.js').STTStartOptions} STTStartOptions
 */

import { log } from '../../../util/log.ts';
import * as bargeIn from '../bargeIn.ts';

function hasSpeechApi() {
  const w = /** @type {any} */ (window);
  return typeof w.webkitSpeechRecognition !== 'undefined'
      || typeof w.SpeechRecognition !== 'undefined';
}

/** @type {STTProvider} */
export const webspeechProvider = {
  name: 'webspeech',

  isAvailable: hasSpeechApi,

  async start(opts) {
    if (!hasSpeechApi()) return null;
    const w = /** @type {any} */ (window);
    const SpeechRec = w.webkitSpeechRecognition || w.SpeechRecognition;
    if (!SpeechRec) return null;

    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    // Session-local state. Captured by the session's methods below — not
    // module-level because each start() creates an independent session.
    let stopped = false;
    let pausedForTts = false;

    rec.onresult = (/** @type {any} */ e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const transcript = r[0].transcript;
        if (transcript) opts.onResult({ transcript, isFinal: r.isFinal, words: [] });
      }
    };

    rec.onend = () => {
      // SR can end without emitting a final for the last interim (short
      // phrase, ambient noise cutoff, iOS internal timeout). Tell the
      // orchestrator so voice.handleResult can promote the orphan to a
      // final before we restart. Deepgram sends its own UtteranceEnd —
      // this makes Web Speech match that contract.
      try { opts.onUtteranceEnd?.(); } catch {}
      // iOS/Safari sometimes stops early. Auto-restart unless we're
      // intentionally stopped or paused for TTS playback.
      if (!stopped && !pausedForTts) {
        try { rec.start(); } catch {}
      }
    };

    rec.onerror = (/** @type {any} */ e) => {
      if (e.error !== 'no-speech') {
        log('webspeech STT error:', e.error);
        if (opts.onError) opts.onError(e.error);
      }
    };

    // Start a dedicated barge-in monitor on the shared stream — SR has
    // its own internal mic capture, so this is the only way to detect
    // user speech during TTS playback in this provider.
    if (opts.audioCtx && opts.stream) {
      bargeIn.startMonitor(opts.stream, opts.audioCtx);
    }

    // If TTS is currently playing, defer SR start — the browser mic would
    // pick up the TTS audio from the speakers and transcribe it back into
    // the draft (feedback loop).
    if (opts.isTtsActive?.()) {
      pausedForTts = true;
      log('webspeech STT pending — TTS active; resume on TTS end');
    } else {
      try {
        rec.start();
        log('webspeech STT active');
      } catch (e) {
        log('webspeech STT start failed:', /** @type {Error} */ (e).message);
        bargeIn.stopMonitor();
        return null;
      }
    }

    /** @type {STTSession} */
    const session = {
      stop() {
        stopped = true;
        pausedForTts = false;
        // Null handlers so the queued onend (which fires after abort)
        // doesn't keep the SR object alive via closure. iOS then
        // releases the SFSpeechRecognizer + mic session promptly.
        try { rec.onresult = null; } catch {}
        try { rec.onend = null; } catch {}
        try { rec.onerror = null; } catch {}
        try { rec.abort(); } catch {}
        bargeIn.stopMonitor();
      },
      pauseForTts() {
        if (pausedForTts) return;
        pausedForTts = true;
        try { rec.abort(); } catch {}
        log('webspeech STT paused for TTS (SR aborted, mic alive)');
      },
      resumeAfterTts() {
        if (!pausedForTts || stopped) return;
        pausedForTts = false;
        try { rec.start(); } catch (e) {
          log('webspeech STT resume failed:', /** @type {Error} */ (e).message);
        }
        log('webspeech STT resumed after TTS');
      },
    };
    return session;
  },
};
