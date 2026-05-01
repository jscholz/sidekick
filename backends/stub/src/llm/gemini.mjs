// Gemini LLM adapter — talks to generativelanguage.googleapis.com.
// Free tier (15 req/min on gemini-2.0-flash) is enough for casual
// use. Get a key at https://aistudio.google.com/apikey.
//
// Streaming: Gemini's :streamGenerateContent endpoint returns an
// SSE-style chunked response. We just split on `\r\n` boundaries and
// pull out `text` deltas as they land — no fancy parsing needed
// because each chunk is a complete JSON object.
//
// On API error, we fall back to a single-shot apology message rather
// than throwing — the server-side error path renders better than a
// stuck thinking-cursor.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiLLM {
  /** @param {{apiKey: string, model: string}} opts */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.name = `gemini:${opts.model}`;
  }

  /**
   * @param {Array<{role: string, content: string}>} messages
   */
  async *stream(messages) {
    if (!this.apiKey) {
      yield '[gemini error] no GEMINI_API_KEY set';
      return;
    }
    // Gemini uses 'user' / 'model' instead of 'user' / 'assistant'.
    // System prompts live on the request, not in `contents`.
    const systemPrompt = messages.find(m => m.role === 'system')?.content;
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    const url =
      `${ENDPOINT}/${encodeURIComponent(this.model)}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      contents,
      ...(systemPrompt
        ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
        : {}),
    };
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      yield `[gemini error] ${e?.message ?? e}`;
      return;
    }
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      yield `[gemini error] HTTP ${resp.status}: ${errText.slice(0, 240)}`;
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
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const parsed = JSON.parse(json);
          const parts =
            parsed?.candidates?.[0]?.content?.parts ?? [];
          for (const p of parts) {
            if (typeof p?.text === 'string' && p.text.length) yield p.text;
          }
        } catch {
          // skip malformed chunk
        }
      }
    }
  }
}
