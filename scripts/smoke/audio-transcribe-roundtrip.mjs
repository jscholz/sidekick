// Scenario: a known-text WAV survives the full STT pipeline.
//
// PWA → POST /transcribe (raw audio body) → proxy forwards to
// audio-bridge /v1/transcribe → bridge calls Deepgram REST →
// transcript returns. The fixture says "hello sidekick" (synthesized
// once via Deepgram Aura — see scripts/smoke/fixtures/README if/when
// we need to regenerate). The assertion is a substring match —
// Deepgram may capitalize / punctuate ("Hello, sidekick.") and we
// don't want to spec-fight model drift.
//
// What this catches that audio-bridge-health doesn't:
//  - Bridge ↔ Deepgram auth (key set in env, not just declared
//    in providers config).
//  - Multipart-vs-raw body shape mismatch (curl with -F vs
//    --data-binary surfaces this exact bug).
//  - Audio-format mismatch (Deepgram 400s on something the bridge
//    forwarded successfully).
//
// Marked BACKEND='real' — uses live Deepgram quota (one short STT
// call). Skip with `npm run smoke -- --mocked-only` when iterating.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'audio-transcribe-roundtrip';
export const DESCRIPTION = '/transcribe round-trips a known-text WAV through the audio bridge to Deepgram';
export const STATUS = 'implemented';
export const BACKEND = 'real';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'hello-sidekick.wav');
/** Substring match — Deepgram normalizes (capitalizes, may add a
 *  period). Assert on the unique noun rather than exact equality. */
const EXPECT_SUBSTRING = 'sidekick';

export default async function run({ url, log }) {
  const bytes = await readFile(FIXTURE);
  log(`fixture loaded: ${FIXTURE} (${bytes.length} bytes)`);

  const target = `${url.replace(/\/+$/, '')}/transcribe`;
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: bytes,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`/transcribe fetch failed: ${e?.message ?? e}`);
  }
  if (!res.ok) {
    throw new Error(`/transcribe HTTP ${res.status}`);
  }
  const body = await res.json();
  if (!body?.ok) {
    throw new Error(
      `/transcribe returned !ok: ${JSON.stringify(body?.error ?? body).slice(0, 240)}`,
    );
  }
  const transcript = String(body.transcript ?? '');
  if (!transcript) {
    throw new Error(`/transcribe returned empty transcript`);
  }
  if (!transcript.toLowerCase().includes(EXPECT_SUBSTRING)) {
    throw new Error(
      `transcript missing expected "${EXPECT_SUBSTRING}": got "${transcript}"`,
    );
  }
  log(`transcript: "${transcript}" (contains "${EXPECT_SUBSTRING}" ✓)`);
}
