/**
 * @fileoverview WebRTC peer connection — the new full-duplex voice
 * transport replacing the classic WS+PCM pipeline.
 *
 * Two modes are supported via the same code path; the difference is just
 * whether the server adds an outbound TTS track to the answer SDP:
 *
 *   stream  — mic in, transcripts via SSE/data channel, no TTS audio.
 *             (Equivalent to today's "live mode.")
 *   talk    — mic in + TTS out on the same peer connection.  iOS sees a
 *             real call session: lockscreen UI, BT routing, no
 *             background-audio gymnastics.
 *
 * Lifecycle:
 *
 *   open(mode)
 *     1. getUserMedia({ audio: true })
 *     2. new RTCPeerConnection
 *     3. addTrack(localMicTrack)
 *     4. ontrack -> bind to <audio> sink for talk mode
 *     5. createOffer / setLocalDescription
 *     6. POST /api/rtc/offer { sdp, type, mode } -> answer
 *     7. setRemoteDescription(answer)
 *     8. trickle ICE: onicecandidate -> POST /api/rtc/ice
 *
 *   close()
 *     - close PC, stop tracks, POST /api/rtc/close
 *
 * Phase-1 narrowness: no data channel, no client-side STT.  Captions
 * (interim transcripts) come back via the existing chat SSE — the
 * server pushes them through the same agent-input channel.
 */

import { log, diag } from '../../util/log.ts';
import { playFeedback } from '../../audio/feedback.ts';
import * as audioPlatform from '../../audio/platform.ts';
import type {
  STTProvider,
  TranscriptEvent as STTTranscriptEvent,
  Unsubscribe,
} from '../../audio/stt-provider.ts';

export type CallMode = 'stream' | 'talk';

export type CallState =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'failed';

interface CallSession {
  pc: RTCPeerConnection;
  mode: CallMode;
  micStream: MediaStream;
  peerId: string | null;
  /** Hidden <audio> element playing the remote (TTS) audio track.
   *  Chrome's WebRTC autoplay-exception keeps it audible without
   *  explicit user-gesture context resumption. */
  remoteAudio: HTMLAudioElement | null;
  /** Outbound data channel for transcript + reply text events. */
  dataChannel: RTCDataChannel | null;
  state: CallState;
  /**
   * Pending ICE candidates collected by onicecandidate before the
   * server returned an answer.  We drain them once we have a peer_id.
   */
  pendingCandidates: RTCIceCandidate[];
}

/**
 * Wire-format envelopes from the server's data channel.
 *
 *   - `transcript` — user/assistant text, both interim and final.
 *   - `barge`      — server-side VAD detected user voice during TTS;
 *                    client should cancel local playback.
 *   - `listening`  — STT pipe is hot; bridge is now accepting mic
 *                    frames into the speech-to-text service. Fires at
 *                    call-start AND after every TTS-end transition.
 *                    PWA chimes "your turn." See
 *                    docs/SIDEKICK_AUDIO_PROTOCOL.md.
 */
interface TranscriptEvent {
  type: 'transcript';
  text: string;
  is_final: boolean;
  role: 'user' | 'assistant';
}
interface BargeEvent {
  type: 'barge';
}
interface ListeningEvent {
  type: 'listening';
}
type DataChannelEvent = TranscriptEvent | BargeEvent | ListeningEvent;

let onDataChannelEvent: ((ev: DataChannelEvent) => void) | null = null;

/** Register a single global handler for data-channel events from the
 *  active peer connection.  Replaces any prior handler. */
export function setDataChannelListener(cb: (ev: DataChannelEvent) => void) {
  onDataChannelEvent = cb;
}

/** Read the currently-registered data-channel listener (or null if
 *  none).  Used by dictate.ts to save+restore the call-mode listener
 *  across a dictate session — the registry is single-slot, so a
 *  module that wants to temporarily override needs to remember what
 *  it replaced. */
export function getDataChannelListener(): ((ev: DataChannelEvent) => void) | null {
  return onDataChannelEvent;
}

let active: CallSession | null = null;
let onStateChange: ((s: CallState, mode: CallMode | null) => void) | null = null;
/** Hold-over when ontrack fires before `active` is populated. */
let pendingRemoteAudio: HTMLAudioElement | null = null;

export function setStateListener(cb: (state: CallState, mode: CallMode | null) => void) {
  onStateChange = cb;
}

function notify(s: CallState, mode: CallMode | null) {
  if (onStateChange) {
    try { onStateChange(s, mode); } catch (e) { diag('webrtc state listener err', e); }
  }
}

function setState(s: CallState) {
  if (!active) {
    notify(s, null);
    return;
  }
  active.state = s;
  notify(s, active.mode);
}

export function isOpen(): boolean {
  return active !== null && active.state === 'connected';
}

export function currentMode(): CallMode | null {
  return active ? active.mode : null;
}

/**
 * Send a {type:'dispatch', text} envelope to the audio bridge over the
 * data channel.  The bridge POSTs the text to /api/hermes/responses
 * via the proxy and streams the agent reply back as assistant
 * transcript envelopes.
 *
 * Returns true on success, false if no channel is open or the payload
 * couldn't be serialized.  The dictation module owns the decision of
 * WHEN to call this — silence-timer fire, commit-phrase match, or any
 * future trigger.
 */
/** Read-only access to the live mic MediaStream. Currently unused by
 *  application code (preserved as a small public surface in case a
 *  future feature wants a tap on the local mic — e.g. mic-meter).
 *  Returns null when no call is open. */
export function getMicStream(): MediaStream | null {
  return active?.micStream ?? null;
}

/** No-op kept for call-site compatibility. The bridge's
 *  tts_track.halt() (audio-bridge/tts_bridge.py:367) already drains
 *  the outbound PCM queue and falls back to silence frames within one
 *  20ms tick of the barge fire — the PWA does NOT need to cancel
 *  anything client-side. The previous implementation paused the
 *  <audio> element AND nulled its srcObject, which permanently
 *  unbound it from the peer track: any subsequent reply's TTS frames
 *  reached the peer connection but had nowhere to play, so one false
 *  barge silenced TTS for the rest of the call. The WebRTC jitter
 *  buffer holds 100-300 ms of TTS audio at barge time — that's the
 *  audible tail you'll hear, vs. a permanently-dead playback path. */
export function cancelRemotePlayback(): void {
  /* intentionally empty — see docstring */
}

export function dispatch(text: string): boolean {
  if (!active || !active.dataChannel) return false;
  if (active.dataChannel.readyState !== 'open') return false;
  try {
    active.dataChannel.send(JSON.stringify({ type: 'dispatch', text }));
    return true;
  } catch (e: any) {
    diag('[webrtc] dispatch send failed', e?.message);
    return false;
  }
}

export async function open(
  mode: CallMode,
  opts?: { sessionId?: string | null; chatId?: string | null },
): Promise<void> {
  if (active) {
    log('[webrtc] open() called but session already active; closing first');
    await close();
  }

  setState('requesting-mic');
  let micStream: MediaStream;
  try {
    // ALL DSP OFF on the WebRTC mic. Reasoning:
    //
    //   - Echo handling is already SERVER-SIDE: the bridge's STT gate
    //     swaps mic frames for silence whenever its outbound TTS track
    //     is active (audio-bridge/stt_bridge.py). So Deepgram never
    //     sees a TTS-bleed echo, regardless of browser AEC state.
    //   - Browser AEC actively REDUCES the mic signal whenever it
    //     correlates with system output. With server-side VAD checking
    //     for user-voice-during-TTS to fire barge, AEC means the
    //     bridge sees attenuated audio (max_rms ~140 instead of
    //     2000+ during normal speech). Empirically, user speech during
    //     TTS with AEC on lands at max_rms ~140 — well below any
    //     reasonable VAD threshold.
    //   - noiseSuppression similarly suppresses anything it considers
    //     "background." Mac built-in mic + speakers tend to make AI-
    //     voice-agent setups look noisy from the browser's POV.
    //   - autoGainControl was already off (ducks mic on loud output).
    //
    // Net: trust the bridge to handle echo via server-side gating,
    // get clean unprocessed audio over the wire. Matches Pipecat /
    // LiveKit production WebRTC voice patterns.
    micStream = await audioPlatform.getMicStream('webrtc', {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  } catch (e: any) {
    diag('[webrtc] getUserMedia failed', e?.message);
    setState('failed');
    throw e;
  }

  setState('connecting');

  // Empty iceServers — Tailscale provides reachability between phone and
  // Pi without STUN/TURN.  Add a public STUN server later if we need
  // off-tailnet operation.
  const pc = new RTCPeerConnection({ iceServers: [] });

  // Add the mic track (sendrecv direction).
  for (const t of micStream.getAudioTracks()) {
    pc.addTrack(t, micStream);
  }

  // For talk mode the server adds an outbound track; in stream mode
  // we tell the server "recvonly" by adding a recvonly transceiver.
  // Practically, aiortc's answer will include or omit a sending track
  // based on the mode parameter we POST, so we simply bind ontrack.
  //
  // Playback path: standard <audio srcObject> element. This is
  // Chrome's WebRTC-exception to its autoplay policy — peer-connection
  // audio plays without an explicit user-gesture-tied AudioContext
  // resume. Going via Web Audio destination requires ctx.resume() to
  // land within the gesture window, which by ontrack time has expired,
  // so the AudioContext stays suspended and no audio reaches the
  // speakers.
  let remoteAudio: HTMLAudioElement | null = null;
  pc.addEventListener('track', (ev: RTCTrackEvent) => {
    log('[webrtc] ontrack kind=', ev.track.kind);
    if (ev.track.kind !== 'audio') return;
    const stream = ev.streams && ev.streams[0]
      ? ev.streams[0]
      : (() => { const ms = new MediaStream(); ms.addTrack(ev.track); return ms; })();
    if (!remoteAudio) {
      remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.setAttribute('playsinline', '');
      (remoteAudio as any).playsInline = true;
      remoteAudio.style.position = 'absolute';
      remoteAudio.style.left = '-9999px';
      remoteAudio.style.width = '1px';
      remoteAudio.style.height = '1px';
      document.body.appendChild(remoteAudio);
      if (active) {
        active.remoteAudio = remoteAudio;
      } else {
        pendingRemoteAudio = remoteAudio;
      }
    }
    remoteAudio.srcObject = stream;
    remoteAudio.play().catch((e) => diag('[webrtc] remoteAudio.play err', e?.message));
  });

  // Open a data channel BEFORE createOffer so the SDP includes the
  // m=application section. Server stashes the matching channel via
  // RTCPeerConnection.ondatachannel; messages are JSON envelopes
  // (transcript / reply-delta) routed through onDataChannelEvent.
  const dataChannel = pc.createDataChannel('events', { ordered: true });
  dataChannel.addEventListener('open', () => {
    log('[webrtc] data channel open');
  });
  dataChannel.addEventListener('close', () => {
    log('[webrtc] data channel close');
  });
  dataChannel.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return;
    let parsed: any;
    try { parsed = JSON.parse(ev.data); }
    catch (e: any) { diag('[webrtc] dc bad json:', e?.message); return; }
    if (!parsed || typeof parsed.type !== 'string') return;
    if (onDataChannelEvent) {
      try { onDataChannelEvent(parsed as DataChannelEvent); }
      catch (e: any) { diag('[webrtc] dc listener threw:', e?.message); }
    }
  });

  active = {
    pc,
    mode,
    micStream,
    peerId: null,
    remoteAudio: pendingRemoteAudio ?? remoteAudio,
    dataChannel,
    state: 'connecting',
    pendingCandidates: [],
  };
  pendingRemoteAudio = null;

  // Trickle ICE: queue candidates until we have a peer_id, then POST each.
  pc.addEventListener('icecandidate', (ev) => {
    if (!ev.candidate) return;
    if (!active) return;
    if (active.peerId) {
      void postIce(active.peerId, ev.candidate);
    } else {
      active.pendingCandidates.push(ev.candidate);
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    log('[webrtc] connectionstate=', pc.connectionState);
    if (!active) return;
    if (pc.connectionState === 'connected') {
      setState('connected');
      // No chime here. The 'listening' chime is now driven by the
      // bridge sending {type: 'listening'} over the data channel
      // whenever it actually accepts mic frames into the STT
      // provider — call-start AND every TTS-end transition. Bridge is the source
      // of truth for "STT is hot"; chiming on connectionstatechange
      // would be a half-second early (data channel + STT pipe init
      // happens after peer is "connected") AND would double up at
      // call-start with the bridge's first-frame envelope. See
      // docs/SIDEKICK_AUDIO_PROTOCOL.md.
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      setState('failed');
      void close();
    }
  });

  // Build offer + signal.
  let offer: RTCSessionDescriptionInit;
  try {
    offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
  } catch (e: any) {
    diag('[webrtc] createOffer/setLocalDescription failed', e?.message);
    setState('failed');
    await close();
    throw e;
  }

  // POST the offer. Two routing identifiers, mutually exclusive in
  // practice but both fields are forwarded so the bridge can pick:
  //
  //   conv_name — sidekick's legacy conversation slug (sidekick-<…>),
  //               used when the active backend is the /v1/responses
  //               path. Bridge passes it as body.conversation when
  //               dispatching to /api/<backend>/responses.
  //   chat_id   — hermes-gateway path, opaque PWA-minted UUID per
  //               conversation. When present, bridge dispatches to
  //               /api/sidekick/messages with {chat_id, text}. Set
  //               only when the active backend is hermes-gateway.
  //
  // keyterms: per-user STT vocabulary biasing, sourced from the PWA's
  // IDB-backed list (src/keyterms.ts). The bridge merges this into the
  // STT provider's options at peer setup so this user's terms reach
  // Deepgram for THIS connection only — no shared server-side state.
  // Fetched best-effort: an IDB error or empty list yields [] and the
  // bridge falls back to its own defaults.
  //
  // No silence_sec / commit_phrase here: those decisions are PWA-side
  // now (see dictation.ts). The bridge stays a thin transcript pipe
  // and dispatches only when the PWA sends {type:'dispatch', text}
  // over the data channel.
  // Use loadOrSeed instead of readList so that if the user starts a call
  // BEFORE ever opening the settings panel, the seed file still
  // populates IDB and reaches the bridge. readList alone returned null
  // on first-boot (settings panel hadn't been opened yet to seed IDB),
  // so the offer went out with keyterms=[] and STT ran un-biased.
  let keyterms: string[] = [];
  try {
    const { loadOrSeed } = await import('../../keyterms.ts');
    keyterms = (await loadOrSeed()) || [];
  } catch {}
  log('[webrtc] offer keyterms=', keyterms.length, keyterms.length ? `(first: ${keyterms[0]})` : '');
  const offerPayload: Record<string, unknown> = {
    sdp: pc.localDescription?.sdp ?? '',
    type: pc.localDescription?.type ?? 'offer',
    mode,
    conv_name: opts?.sessionId || null,
    keyterms,
  };
  if (opts?.chatId) offerPayload.chat_id = opts.chatId;

  let answer: { peer_id: string; sdp: string; type: string } | null = null;
  try {
    const res = await fetch('/api/rtc/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offerPayload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`offer ${res.status}: ${txt.slice(0, 200)}`);
    }
    answer = await res.json();
  } catch (e: any) {
    diag('[webrtc] offer POST failed', e?.message);
    setState('failed');
    await close();
    throw e;
  }

  if (!answer || !answer.peer_id) {
    setState('failed');
    await close();
    throw new Error('answer payload missing peer_id');
  }

  if (active) active.peerId = answer.peer_id;

  try {
    await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type as RTCSdpType });
  } catch (e: any) {
    diag('[webrtc] setRemoteDescription failed', e?.message);
    setState('failed');
    await close();
    throw e;
  }

  // Drain queued candidates.
  if (active && active.pendingCandidates.length > 0) {
    const drained = active.pendingCandidates.splice(0, active.pendingCandidates.length);
    for (const c of drained) {
      void postIce(answer.peer_id, c);
    }
  }
}

async function postIce(peerId: string, candidate: RTCIceCandidate) {
  try {
    const body = JSON.stringify({
      peer_id: peerId,
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      },
    });
    const res = await fetch('/api/rtc/ice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      diag('[webrtc] ice POST', res.status, txt.slice(0, 150));
    }
  } catch (e: any) {
    diag('[webrtc] ice POST err', e?.message);
  }
}

export async function close(): Promise<void> {
  if (!active) return;
  setState('closing');
  const session = active;
  active = null;
  // Release the mic stream through the platform shim — capture.ts owns
  // track-stop + wakeLock release + active-stream nullification, all
  // keyed on the 'webrtc' owner tag we acquired with above. Without
  // this release, capture.ts would still think 'webrtc' holds the
  // stream and the next memo/webrtc acquire would throw.
  try { audioPlatform.releaseMicStream('webrtc'); } catch { /* ignore */ }
  if (session.dataChannel) {
    try { session.dataChannel.close(); } catch { /* ignore */ }
  }
  try { session.pc.close(); } catch { /* ignore */ }
  if (session.remoteAudio) {
    try {
      session.remoteAudio.pause();
      session.remoteAudio.srcObject = null;
      session.remoteAudio.remove();
    } catch { /* ignore */ }
  }
  if (session.peerId) {
    try {
      await fetch('/api/rtc/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peer_id: session.peerId }),
      });
    } catch (e: any) {
      diag('[webrtc] close POST err', e?.message);
    }
  }
  notify('idle', null);
}

// ─── STTProvider implementation ────────────────────────────────────────
//
// The WebRTC stack above predates the STTProvider abstraction. Rather
// than rewrite the module, we wrap it: WebRTCSTTProvider is a thin
// shim around `open` / `close` / `getDataChannelListener` that
// satisfies the vendor-neutral interface in `src/audio/stt-provider.ts`.
// Tests that need a synthetic transcript stream can ship a
// MockSTTProvider against the same interface without touching WebRTC.
//
// Caveat: the data-channel listener registry is single-slot (see
// `setDataChannelListener` above) — the provider preserves the
// long-standing save-and-restore pattern that `dictate.ts` already
// used, so existing wiring (main.ts's call-mode listener) survives a
// dictate session unchanged.

/** WebRTC-backed STT provider. Wraps the existing peer-connection +
 *  data-channel pipeline. Concrete implementation behind the
 *  vendor-neutral STTProvider interface. */
export class WebRTCSTTProvider implements STTProvider {
  private listener: ((ev: STTTranscriptEvent) => void) | null = null;
  private savedListener: ((ev: any) => void) | null = null;
  private started = false;

  async start(opts?: { sessionId?: string | null; chatId?: string | null }): Promise<void> {
    if (this.started) return;
    // Save whatever data-channel listener was wired (e.g. main.ts's
    // call-mode listener) so we can restore it on stop. The registry
    // is single-slot; the wrapper has to remember what it replaced.
    this.savedListener = getDataChannelListener();
    setDataChannelListener((ev) => this.dispatch(ev));
    try {
      await open('stream', {
        sessionId: opts?.sessionId ?? null,
        chatId: opts?.chatId ?? null,
      });
      this.started = true;
    } catch (e) {
      // Restore listener on failure so the host page isn't left with a
      // dangling provider listener that won't see any future events.
      if (this.savedListener) setDataChannelListener(this.savedListener);
      this.savedListener = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      // Even if we never finished start(), any in-flight save needs
      // unwinding. Idempotent.
      if (this.savedListener) {
        setDataChannelListener(this.savedListener);
        this.savedListener = null;
      }
      return;
    }
    this.started = false;
    try { await close(); } catch (e: any) { diag('[webrtc-stt] close err', e?.message); }
    if (this.savedListener) {
      setDataChannelListener(this.savedListener);
      this.savedListener = null;
    }
  }

  onTranscript(cb: (ev: STTTranscriptEvent) => void): Unsubscribe {
    this.listener = cb;
    return () => {
      if (this.listener === cb) this.listener = null;
    };
  }

  /** Filter raw data-channel events down to transcript events for the
   *  registered STTProvider listener. Non-transcript envelopes (barge,
   *  listening, etc.) are dropped — they're transport concerns of the
   *  WebRTC impl, not part of the STT contract. */
  private dispatch(ev: any): void {
    if (!this.listener) return;
    if (!ev || ev.type !== 'transcript' || typeof ev.text !== 'string') return;
    if (ev.role !== 'user' && ev.role !== 'assistant') return;
    try {
      this.listener({
        type: 'transcript',
        text: ev.text,
        is_final: !!ev.is_final,
        role: ev.role,
      });
    } catch (e: any) {
      diag('[webrtc-stt] listener threw:', e?.message);
    }
  }
}

/** Default WebRTC STT provider instance — sufficient for the single-
 *  active-session reality of the PWA. Tests can construct a fresh
 *  `WebRTCSTTProvider` or substitute a mock implementing the same
 *  interface. */
export const defaultWebRTCSTTProvider = new WebRTCSTTProvider();
