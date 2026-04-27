/**
 * @fileoverview Subtle audio feedback sounds — tiny clicks for send/receive.
 * Generated programmatically via AudioContext (no external files).
 */

import * as settings from '../settings.ts';

let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    audioCtx = new Ctx();
  }
  return audioCtx;
}

/**
 * Play a short click/pop sound.
 * @param {'send'|'receive'|'error'|'start'|'commit'|'connect'|'listening'} type
 *   - send:    short rising click, confirms outbound
 *   - receive: soft descending pop, confirms inbound
 *   - error:   two low descending tones — distinct from send/receive so
 *              bike-mode users hear a failure without watching the screen.
 *              Plays at ~1.5x the gain of send/receive because its whole
 *              job is to be noticed over wind/traffic.
 *   - start:   single very short high-pitched tick, ~half the gain of send.
 *              Fires when local audio capture begins (memo or streaming).
 *              Intended as a "seatbelt click": the brain tunes it out as
 *              background, only notices if it's absent — signalling the
 *              mic isn't actually recording.
 *   - commit:  higher rising tick than 'send' — fires the moment the
 *              commit-word ("over") is detected, BEFORE the message is
 *              sent. Pairs with 'send' which fires when the message
 *              actually ships to the backend. Distinct tones so the user
 *              can distinguish "I heard the send-word" from "message
 *              shipped": a shorter commit-send gap is reassuring, a
 *              missing second chime means the send didn't land.
 *   - connect: ascending two-tone chime (C5 → E5) over ~200ms — fires
 *              when a WebRTC peer connection establishes. Distinct from
 *              'commit' (single tick) and 'send' (rising click): the
 *              two-note arc reads unmistakably as "circuit closed,
 *              channel open". Played slightly louder than send/receive
 *              because it's a once-per-call event — being noticed
 *              matters more than fading into background.
 *   - listening: subtle two-tone fade-in (~150ms) — "system is ready
 *              for your voice". Fires for memo at first audio frame
 *              and for call once the WebRTC peer is connected. Sine
 *              wave (smoother than triangle) at low gain so it doesn't
 *              compete with the user starting to speak. Distinct from
 *              'connect' which is the louder handshake notice; this
 *              is the gentler "you can talk now" cue.
 */
export function playFeedback(type) {
  // Volume is 0..1; 0.25 now matches the legacy "subtle" level after
  // the 2×→4× scale bump (gain headroom was underused, max was too
  // quiet for wind / traffic). 1.0 is ~4x louder than legacy; all
  // chime gains still stay well under 1.0 to avoid clipping.
  const volume = settings.get().audioFeedbackVolume ?? 0.5;
  if (volume <= 0) return;
  const scale = volume * 4;
  try {
    const ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    if (type === 'send') {
      // Short rising click — "sent"
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.linearRampToValueAtTime(1200, now + 0.04);
      gain.gain.setValueAtTime(0.08 * scale, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'receive') {
      // Soft descending pop — "received"
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.linearRampToValueAtTime(400, now + 0.06);
      gain.gain.setValueAtTime(0.06 * scale, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'start') {
      // Very short high-pitched tick — "seatbelt click" for mic-live.
      // Triangle wave carries better over wind than sine; 30ms is below
      // the conscious-attention threshold for most listeners but clearly
      // audible. Half the gain of send/receive so it never pulls focus.
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1000, now);
      osc.frequency.linearRampToValueAtTime(1200, now + 0.02);
      gain.gain.setValueAtTime(0.04 * scale, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
      osc.start(now);
      osc.stop(now + 0.03);
    } else if (type === 'commit') {
      // Short high-pitched rising tick — "I heard your over". Brighter
      // than 'send' (starts an octave up) and shorter, so the back-to-back
      // commit-then-send pair reads as two distinct events rather than
      // one smeared chime. Triangle wave carries better over wind for
      // bike-mode users.
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1600, now);
      osc.frequency.linearRampToValueAtTime(2200, now + 0.03);
      gain.gain.setValueAtTime(0.05 * scale, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.start(now);
      osc.stop(now + 0.05);
    } else if (type === 'connect') {
      // Ascending two-tone chime — C5 (~523 Hz) then E5 (~659 Hz),
      // ~100ms each with a short gap. Reads as "channel established"
      // — a major-third interval is universally heard as positive /
      // resolved. Triangle wave for body over wind.
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(523, now);
      gain.gain.setValueAtTime(0.09 * scale, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
      // Second tone — E5, starts at +110ms so the gap reads as a
      // deliberate two-step rather than a slur.
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'triangle';
      const t2 = now + 0.11;
      osc2.frequency.setValueAtTime(659, t2);
      gain2.gain.setValueAtTime(0.09 * scale, t2);
      gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.12);
      osc2.start(t2);
      osc2.stop(t2 + 0.12);
    } else if (type === 'listening') {
      // Two-tone fade-in chime — A4 (~440 Hz) → C5 (~523 Hz). Gentler
      // than 'connect' (lower overall gain, sine instead of triangle,
      // shorter total duration ~150ms). Reads as a soft "your turn" cue
      // rather than a circuit-closed announcement. Used when the mic
      // path is actually live and the user can start speaking.
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.05 * scale, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      osc.start(now);
      osc.stop(now + 0.07);
      // Second tone — C5, follows immediately for an upward lift. The
      // brief gap reads as a deliberate two-step rather than a slur,
      // keeping it distinct from the single-tick 'start' chime.
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'sine';
      const t2 = now + 0.08;
      osc2.frequency.setValueAtTime(523, t2);
      gain2.gain.setValueAtTime(0.001, t2);
      gain2.gain.exponentialRampToValueAtTime(0.06 * scale, t2 + 0.03);
      gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.08);
      osc2.start(t2);
      osc2.stop(t2 + 0.08);
    } else if (type === 'error') {
      // Two short low-pitched descending tones — alert, not alarming.
      // Uses triangle wave for a fuller sound that carries over wind
      // noise better than sine. 1.5x gain scale for audibility on bike.
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.linearRampToValueAtTime(330, now + 0.12);
      gain.gain.setValueAtTime(0.12 * scale, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.14);
      // Second tone 60ms later — paired-beep pattern reads as "alert"
      // across most cultures. Built as its own osc/gain pair since the
      // first one will already be stopped.
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.type = 'triangle';
      const t2 = now + 0.2;
      osc2.frequency.setValueAtTime(330, t2);
      osc2.frequency.linearRampToValueAtTime(260, t2 + 0.12);
      gain2.gain.setValueAtTime(0.12 * scale, t2);
      gain2.gain.exponentialRampToValueAtTime(0.001, t2 + 0.14);
      osc2.start(t2);
      osc2.stop(t2 + 0.14);
    }
  } catch { /* ignore audio errors */ }
}
