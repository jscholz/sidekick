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
 *                    client should cancel local playback. See
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
type DataChannelEvent = TranscriptEvent | BargeEvent;

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

/** Cancel local TTS playback by pausing + clearing the audio
 *  element. Idempotent and safe when no call is open. Called by
 *  main.ts when the bridge sends a server-side `barge` envelope. */
export function cancelRemotePlayback(): void {
  if (!active?.remoteAudio) return;
  try { active.remoteAudio.pause(); } catch { /* ignore */ }
  try { active.remoteAudio.srcObject = null; } catch { /* ignore */ }
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

export async function open(mode: CallMode, opts?: { sessionId?: string | null }): Promise<void> {
  if (active) {
    log('[webrtc] open() called but session already active; closing first');
    await close();
  }

  setState('requesting-mic');
  let micStream: MediaStream;
  try {
    // echoCancellation/noiseSuppression on for STT clarity (the bridge
    // sees AEC'd mic samples, which is what Deepgram wants). AGC off:
    // on iOS Safari AGC amplifies remote-audio echo above the AEC
    // threshold and we lose echo cancellation on speakerphone; on
    // desktop Chrome AGC ducks the mic when system output is loud.
    // Production WebRTC voice apps (Discord web, Meet) leave AGC off
    // in voice-call constraints.
    //
    // Note: client-side barge detection is gone — the bridge runs an
    // RMS VAD on raw pre-DSP PCM and sends `{type:'barge'}` over the
    // data channel. Browser AEC ducks anything correlated with
    // system output, so a client-side mic analyser cannot reliably
    // see user voice during TTS regardless of constraints. See
    // docs/SIDEKICK_AUDIO_PROTOCOL.md for the new envelope.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
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
      // Tone on connection — the plan calls for a short two-tone chime.
      try { playFeedback('connect'); } catch { /* ignore */ }
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

  // POST the offer. conv_name is sidekick's stable conversation
  // identifier (sidekick-<slug>), the same key classic-mode chat sends
  // — the audio bridge passes it as body.conversation when dispatching
  // to /api/hermes/responses so voice and text turns chain through one
  // session row.
  //
  // No silence_sec / commit_phrase here: those decisions are PWA-side
  // now (see dictation.ts). The bridge stays a thin transcript pipe
  // and dispatches only when the PWA sends {type:'dispatch', text}
  // over the data channel.
  const offerPayload = {
    sdp: pc.localDescription?.sdp ?? '',
    type: pc.localDescription?.type ?? 'offer',
    mode,
    conv_name: opts?.sessionId || null,
  };

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
  try {
    for (const t of session.micStream.getTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
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
