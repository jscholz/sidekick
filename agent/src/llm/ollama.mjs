// Ollama LLM adapter — talks to a local Ollama instance via its
// /api/chat streaming endpoint. Free, runs on your hardware, no key.
//
// Setup: `ollama pull llama3.2` (or any model), then `ollama serve`.
// Default URL is http://127.0.0.1:11434; override via OLLAMA_URL.
// Default model is llama3.2; override via OLLAMA_MODEL.
//
// Ollama's /api/chat returns NDJSON (one JSON object per line). Each
// chunk has `message.content` for the delta and `done: true` on the
// final frame.

export class OllamaLLM {
  /** @param {{baseUrl: string, model: string}} opts */
  constructor(opts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.name = `ollama:${opts.model}`;
  }

  /**
   * @param {Array<{role: string, content: string}>} messages
   */
  async *stream(messages) {
    const body = {
      model: this.model,
      messages: messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
        content: m.content,
      })),
      stream: true,
    };
    let resp;
    try {
      resp = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      yield `[ollama error] ${e?.message ?? e} (is ollama serve running at ${this.baseUrl}?)`;
      return;
    }
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      yield `[ollama error] HTTP ${resp.status}: ${errText.slice(0, 240)}`;
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          const delta = parsed?.message?.content;
          if (typeof delta === 'string' && delta.length) yield delta;
          if (parsed?.done) return;
        } catch {
          // skip malformed line
        }
      }
    }
  }
}
