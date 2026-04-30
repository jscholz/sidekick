// LLM adapter interface + factory for the stub agent.
//
// An adapter takes the conversation history and yields the assistant
// reply, optionally streaming text deltas. Three impls ship in-tree:
//
//   echo   — returns "You said: <last>".  No setup, default if nothing else.
//   gemini — Google's Gemini API.        Set GEMINI_API_KEY.
//   ollama — Local Ollama instance.       Set OLLAMA_URL (default 11434).
//
// Add a new adapter by implementing `LLM` below and registering it
// in `pickAdapter()`. Streaming is optional: if your adapter only
// has a non-streaming completion, yield the final text once and
// return — the server handles both shapes.

import { EchoLLM } from './echo.mjs';
import { GeminiLLM } from './gemini.mjs';
import { OllamaLLM } from './ollama.mjs';

/**
 * @typedef {{ role: 'user' | 'assistant' | 'system', content: string }} ChatMessage
 *
 * @typedef {object} LLM
 * @property {string} name           — short id surfaced in /v1/responses `model` field
 * @property {(messages: ChatMessage[]) => AsyncIterable<string>} stream
 *   Yield text deltas (any chunk size, including the whole reply at once).
 *   When the iterator returns, the response is complete.
 */

/** @returns {LLM} */
export function pickAdapter(env = process.env) {
  const mode = (env.AGENT_LLM || '').toLowerCase();
  if (mode === 'gemini' || (!mode && env.GEMINI_API_KEY)) {
    return new GeminiLLM({
      apiKey: env.GEMINI_API_KEY ?? '',
      model: env.GEMINI_MODEL || 'gemini-2.0-flash',
    });
  }
  if (mode === 'ollama' || (!mode && env.OLLAMA_URL)) {
    return new OllamaLLM({
      baseUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434',
      model: env.OLLAMA_MODEL || 'llama3.2',
    });
  }
  return new EchoLLM();
}
