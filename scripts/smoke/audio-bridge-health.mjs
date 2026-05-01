// Scenario: audio-bridge is up + reports its provider configuration.
//
// Cheap canary. Catches the audio bridge being missing / dead /
// misconfigured (no STT or TTS provider declared) before the more
// expensive transcribe-roundtrip test wastes Deepgram quota proving
// the same thing. No DG quota usage — the bridge's /v1/rtc/health
// just reports what providers it WOULD use; doesn't call them.
//
// Marked BACKEND='real' because it requires an actual sidekick
// proxy + audio bridge running; not exercisable against the mock
// backend.

export const NAME = 'audio-bridge-health';
export const DESCRIPTION = 'audio bridge /v1/rtc/health responds + declares STT/TTS providers';
export const STATUS = 'implemented';
export const BACKEND = 'real';

export default async function run({ url, log }) {
  const target = `${url.replace(/\/+$/, '')}/api/rtc/health`;
  // Proxy forwards /api/rtc/* to the bridge's /v1/rtc/*. Hitting the
  // proxy path mirrors what the PWA does (no need to know the
  // bridge's port from the smoke runner).
  let res;
  try {
    res = await fetch(target, { signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    throw new Error(`bridge health fetch failed: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    throw new Error(`bridge health HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body?.ok !== true) {
    throw new Error(`bridge health body.ok != true: ${JSON.stringify(body)}`);
  }
  const providers = body.providers ?? {};
  if (!providers.stt) {
    throw new Error(`bridge providers.stt missing: ${JSON.stringify(body)}`);
  }
  if (!providers.tts) {
    throw new Error(`bridge providers.tts missing: ${JSON.stringify(body)}`);
  }
  log(`bridge OK; stt=${providers.stt} tts=${providers.tts}`);
}
