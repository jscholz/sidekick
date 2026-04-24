/**
 * @fileoverview Tiny PCM/WAV encoder for pushing raw int16 audio into a
 * Blob that /transcribe (and by extension Deepgram) will accept.
 *
 * Extracted so the silent-keepalive path in session.ts and the STT
 * backfill path in sttBackfill.ts can share one well-tested WAV-header
 * construction — no difference in bits between them.
 *
 * Output: 16-bit mono PCM WAV. 44-byte header + raw samples.
 */

/**
 * Build a WAV Blob from Int16 mono PCM samples.
 *
 * @param {Int16Array} samples — PCM samples at `sampleRate`.
 * @param {number} sampleRate — usually `audioCtx.sampleRate` (48000 on
 *     desktop/iOS). Whatever produced the samples must match here.
 * @returns {Blob} `audio/wav` Blob ready to POST as Content-Type: audio/wav.
 */
export function int16ToWav(samples, sampleRate) {
  const numSamples = samples.length;
  const dataSize = numSamples * 2; // 2 bytes per 16-bit sample
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  // Helper: write an ASCII string into the header at offset `o`.
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };

  // RIFF container
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // file size - 8
  writeStr(8, 'WAVE');

  // fmt sub-chunk: 16 bytes of format info for PCM
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM format tag
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * block align)
  view.setUint16(32, 2, true);           // block align (channels * bytes/sample)
  view.setUint16(34, 16, true);          // bits per sample

  // data sub-chunk: raw samples (little-endian int16).
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  // DataView's setInt16 writes little-endian when the second arg is true.
  // We copy sample-by-sample to avoid endianness surprises from TypedArray
  // byte ordering varying across platforms.
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(offset, samples[i], true);
    offset += 2;
  }

  return new Blob([buf], { type: 'audio/wav' });
}
