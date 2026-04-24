/**
 * AudioWorklet processor — replaces deprecated ScriptProcessor.
 * Buffers 128-sample render quanta into ~4096-sample frames,
 * computes peak amplitude, converts float32 → int16, and posts
 * to the main thread via transferable ArrayBuffer.
 *
 * Runs on a dedicated audio thread — immune to main-thread jank
 * and Bluetooth profile renegotiation stalls that kill ScriptProcessor.
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(4096);
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      this._buffer[this._pos++] = input[i];
      if (this._pos >= this._buffer.length) {
        let peak = 0;
        for (let j = 0; j < this._buffer.length; j++) {
          const v = Math.abs(this._buffer[j]);
          if (v > peak) peak = v;
        }
        const int16 = new Int16Array(this._buffer.length);
        for (let j = 0; j < this._buffer.length; j++) {
          int16[j] = Math.max(-32768, Math.min(32767, Math.round(this._buffer[j] * 32767)));
        }
        this.port.postMessage({ peak, buffer: int16.buffer }, [int16.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
