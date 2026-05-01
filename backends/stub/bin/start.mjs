#!/usr/bin/env node
// CLI entry for the sidekick stub agent.
//
// Run via `node agent/bin/start.mjs` or `npm start` from the agent
// folder. Reads config from environment variables:
//
//   AGENT_HOST              default 127.0.0.1
//   AGENT_PORT              default 4001
//   AGENT_DATA_DIR          default ./data    (where conversations.json lives)
//   AGENT_BEARER_TOKEN      optional. when set, /v1/responses requires
//                           Authorization: Bearer <token>.
//
//   AGENT_LLM               'echo' | 'gemini' | 'ollama'. when unset,
//                           we auto-pick: gemini if GEMINI_API_KEY,
//                           ollama if OLLAMA_URL, else echo.
//   GEMINI_API_KEY          required for gemini
//   GEMINI_MODEL            default gemini-2.0-flash
//   OLLAMA_URL              default http://127.0.0.1:11434
//   OLLAMA_MODEL            default llama3.2

import { resolve } from 'node:path';
import { Conversations } from '../src/conversations.mjs';
import { pickAdapter } from '../src/llm/index.mjs';
import { createServer } from '../src/server.mjs';

const HOST = process.env.AGENT_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.AGENT_PORT || '4001', 10);
const DATA_DIR = resolve(process.env.AGENT_DATA_DIR || './data');
const BEARER_TOKEN = process.env.AGENT_BEARER_TOKEN || undefined;

const conversations = new Conversations(`${DATA_DIR}/conversations.json`);
await conversations.load();
const llm = pickAdapter();

const server = createServer({ conversations, llm, bearerToken: BEARER_TOKEN });
server.listen(PORT, HOST, () => {
  console.log(`[stub-agent] listening on http://${HOST}:${PORT}`);
  console.log(`[stub-agent] llm: ${llm.name}`);
  console.log(`[stub-agent] data dir: ${DATA_DIR}`);
  if (BEARER_TOKEN) console.log('[stub-agent] bearer token: required');
});

const flushAndExit = async (signal) => {
  console.log(`[stub-agent] ${signal} received, flushing state`);
  try { await conversations.flush(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => void flushAndExit('SIGINT'));
process.on('SIGTERM', () => void flushAndExit('SIGTERM'));
