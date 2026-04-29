// Scenario: web-search-prompting message → web_search tool fires
// against Tavily, an activity row + tool row render, the reply
// finalizes with a real fact, and state.db captures the tool turn.
//
// This is a tighter cousin of tool-turn.mjs that pins the Tavily
// integration end-to-end. tool-turn.mjs picks any tool the model
// chooses (often weather or browser_navigate); this scenario asserts
// that web_search SPECIFICALLY runs and returns useful content.
//
// BACKEND='real' is mandatory: the mock backend can't synthesize
// Tavily responses faithfully (and the whole point is to verify that
// the live integration works).
//
// Note on the state.db assertion: the user-facing instructions said
// "look for tool_name='web_search' on the tool row." In the current
// schema (~/.hermes/state.db) the messages.tool_name column is empty
// for newly-created rows; the tool name is stored in the preceding
// assistant row's tool_calls JSON. We assert on that — same intent
// (the turn invoked web_search), correct mechanics for today's data
// shape. If/when hermes starts populating tool_name, the assertion
// still passes (it OR's both forms).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { waitForReady, clickNewChat, send, deleteChat, SEL, assert } from './lib.mjs';

export const NAME = 'tool-turn-web-search';
export const DESCRIPTION = 'web_search tool runs via Tavily, renders, and lands in state.db';
export const STATUS = 'implemented';
// Real backend required — Tavily integration end-to-end is the thing
// under test. Mock cannot stand in.
export const BACKEND = 'real';

const STATE_DB = `${process.env.HOME}/.hermes/state.db`;
const TOOL_PROMPT = 'Use web_search to find one fact about the Eiffel Tower.';

const execFileP = promisify(execFile);

// Mirrors server-lib/generic/sql.ts (can't import a .ts file from
// .mjs without a build step; the helper is two lines).
async function sqlQuery(db, sql) {
  const { stdout } = await execFileP('sqlite3', ['-json', db, sql], {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout);
}

function captureNextChatId(page) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('new-session log not seen in 5s')), 5000);
    const handler = (msg) => {
      const m = /new session \(chat_id=([0-9a-f-]+)\)/.exec(msg.text());
      if (m) {
        clearTimeout(t);
        page.off('console', handler);
        resolve(m[1]);
      }
    };
    page.on('console', handler);
  });
}

// Strings that signal the model declined / failed to actually use
// the tool. If the finalized reply matches any of these, we treat it
// as a placeholder and fail the scenario (the whole point is that
// Tavily returned real content).
const PLACEHOLDER_PATTERNS = [
  /search blocked/i,
  /\bi cannot\b/i,
  /\bi can'?t\b/i,
  /unable to (search|access)/i,
  /no results found/i,
];

export default async function run({ page, log, fail }) {
  await waitForReady(page);
  const chatIdP = captureNextChatId(page);
  await clickNewChat(page);
  const chatId = await chatIdP;

  const t0 = await send(page, TOOL_PROMPT);

  // 1. Activity row appears as soon as the first tool_call envelope
  //    arrives. (Same gate as tool-turn.mjs.)
  await page.waitForSelector(SEL.activityRow, { timeout: 30_000 });
  const tActivity = Date.now();
  log(`activity row appeared in ${tActivity - t0} ms`);

  // 2. A tool row carrying tool name 'web_search' renders. The DOM
  //    structure is .tool-row > .tool-row-summary > .tool-name (see
  //    src/activityRow.ts).
  await page.waitForFunction(
    () => {
      const rows = document.querySelectorAll('.tool-row .tool-name');
      return Array.from(rows).some((el) => (el.textContent || '').trim() === 'web_search');
    },
    null,
    { timeout: 60_000, polling: 250 },
  );
  log(`web_search tool row rendered`);

  // 3. Reply finalizes — count baseline first because the home-channel
  //    nudge from earlier chats may already have one finalized bubble.
  const baselineCount = await page.locator(SEL.agentFinal).count();
  await page.waitForFunction(
    ({ sel, baseline }) => document.querySelectorAll(sel).length > baseline,
    { sel: SEL.agentFinal, baseline: baselineCount },
    { timeout: 90_000, polling: 250 },
  );
  const tReply = Date.now();
  log(`reply finalized in ${tReply - t0} ms`);

  // 4. Reply text is a real fact, not a placeholder / refusal string.
  const finalText = await page.evaluate((sel) => {
    const nodes = document.querySelectorAll(sel);
    const last = nodes[nodes.length - 1];
    return (last?.textContent || '').trim();
  }, SEL.agentFinal);
  log(`reply text (${finalText.length} chars): ${finalText.slice(0, 160)}`);
  assert(finalText.length > 20, `reply too short to contain a real fact: ${JSON.stringify(finalText)}`);
  for (const re of PLACEHOLDER_PATTERNS) {
    assert(!re.test(finalText), `reply matched placeholder pattern ${re}: ${JSON.stringify(finalText.slice(0, 200))}`);
  }

  // 5. state.db has a tool turn for web_search in this session. Map
  //    chat_id → session_id via the proxy's sessions endpoint, then
  //    look for either an assistant row whose tool_calls JSON names
  //    web_search OR a tool row with tool_name='web_search'.
  const sessions = await page.evaluate(async () => {
    const r = await fetch('/api/sidekick/sessions');
    return r.json();
  });
  const sess = (sessions?.sessions || []).find((s) => s.chat_id === chatId);
  assert(sess, `no session record for chat_id=${chatId} in /api/sidekick/sessions`);
  const sessionId = sess.session_id;
  log(`mapped chat_id=${chatId} → session_id=${sessionId}`);

  // SQL escaping: session_id is a hermes-generated timestamp+hex string,
  // safe to interpolate. We're shelling out to sqlite3 with execFile so
  // there's no shell-injection surface either way.
  const rows = await sqlQuery(
    STATE_DB,
    `SELECT id, role, tool_name, tool_calls FROM messages
       WHERE session_id = '${sessionId}'
         AND (
           tool_name = 'web_search'
           OR (role = 'assistant' AND tool_calls LIKE '%"name": "web_search"%')
         )
       ORDER BY id ASC`,
  );
  log(`state.db rows matching web_search: ${rows.length}`);
  assert(rows.length >= 1, `expected ≥1 web_search row in state.db for session ${sessionId}, got 0`);

  await deleteChat(page, chatId);
}
