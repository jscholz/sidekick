/**
 * @fileoverview Ambient type declarations for browser APIs that
 * ClawPortal touches but aren't in TypeScript's default DOM lib.
 * Mostly WebKit / Safari extensions.
 */

interface Window {
  webkitAudioContext?: typeof AudioContext;
  webkitSpeechRecognition?: any;
  SpeechRecognition?: any;
}

interface Navigator {
  /** Safari PWA standalone flag (not in DOM spec). */
  standalone?: boolean;
  /** Safari audio-session hint (not in DOM spec). */
  audioSession?: {
    type?: 'auto' | 'playback' | 'ambient' | 'solo-ambient' | 'play-and-record' | 'transient' | 'transient-solo';
  };
}

/** Safari mediaSession exposes a `playbackState` property in addition to
 *  the standard action handlers. */
interface MediaSession {
  playbackState?: 'none' | 'paused' | 'playing';
}

/** Vendor-prefixed audio API on older Safari. */
declare const webkitAudioContext: typeof AudioContext | undefined;
