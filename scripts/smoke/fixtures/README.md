# Smoke fixtures

Inputs the smoke runner reads at runtime. Small + checked in so
the tests are reproducible and don't need to phone home for setup.

## Files

| File | Used by | Notes |
|---|---|---|
| `hello-sidekick.wav` | `audio-transcribe-roundtrip.mjs` | 16-bit mono 16kHz WAV synthesized via Deepgram Aura (`aura-2-thalia-en`). Says "hello sidekick". ~66KB. |

## Regenerating

If you change the expected substring or want a different test phrase:

```bash
DK="$DEEPGRAM_API_KEY"
curl -s -X POST \
  "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000&container=wav" \
  -H "Authorization: Token $DK" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello sidekick"}' \
  -o scripts/smoke/fixtures/hello-sidekick.wav
```

Then update `EXPECT_SUBSTRING` in `audio-transcribe-roundtrip.mjs`
if the phrase changed.
