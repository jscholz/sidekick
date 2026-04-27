// OpenAI-compatible chat proxy. Only active when SIDEKICK_BACKEND=openai-compat.
// Keeps the upstream URL + API key server-side (off the browser) and streams
// the SSE response through unchanged. Works with OpenAI, Ollama, LMStudio,
// Groq, vLLM, Together — anything that speaks POST /v1/chat/completions.
//
// Lives here for symmetry with src/backends/openai-compat.ts (the
// browser-side adapter); the matching pair makes it obvious where each
// half of the backend protocol lives. Config init follows the same
// pattern as the hermes backend — server.ts owns the deploy-config
// state and pushes resolved values in via initOpenAICompatConfig.

export let OPENAI_COMPAT_URL = '';
export let OPENAI_COMPAT_KEY = '';

export interface OpenAICompatConfigInit {
  OPENAI_COMPAT_URL: string;
  OPENAI_COMPAT_KEY: string;
}

export function initOpenAICompatConfig(c: OpenAICompatConfigInit): void {
  OPENAI_COMPAT_URL = c.OPENAI_COMPAT_URL;
  OPENAI_COMPAT_KEY = c.OPENAI_COMPAT_KEY;
}

export async function handleOpenAICompatChat(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (OPENAI_COMPAT_KEY) headers.Authorization = `Bearer ${OPENAI_COMPAT_KEY}`;
  try {
    const upstream = await fetch(OPENAI_COMPAT_URL, { method: 'POST', headers, body });
    res.writeHead(upstream.status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    console.error('openai-compat proxy error:', e.message);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`upstream error: ${e.message}`);
  }
}
