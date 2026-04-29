/**
 * Proxy test harness — drives the hermes-gateway proxy as system-under-test.
 *
 * Each test gets:
 *   - A scratch tmp dir (state.db + sessions/sessions.json + sessions/*.jsonl)
 *   - A FakePlugin WS server on an ephemeral port (replaces hermes-plugin)
 *   - A real http.Server hosting /api/sidekick/* routes with the actual handlers
 *
 * The FakePlugin intentionally mimics only the behaviors the proxy reads.
 * If hermes-plugin grows new side-effects (extra columns, new files), those
 * won't appear in tests until the harness mimics them — keep this file in
 * sync with what gateway/run.py + plugin do on first message.
 *
 * Test isolation: client is a process-singleton; keep all proxy tests in
 * ONE file so they run serially.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer, WebSocket as WS } from 'ws';

import {
  client,
} from '../client.ts';
import {
  handleSidekickMessage,
  handleSidekickSessionsList,
  handleSidekickSessionDelete,
  handleSidekickSessionMessages,
  handleSidekickStream,
  init as initHermesGateway,
} from '../index.ts';
import { initHermesConfig } from '../../hermes/config.ts';

const execFileP = promisify(execFile);

// Minimal subset of the real state.db schema — only columns the proxy reads.
// Triggers (FTS) intentionally omitted to keep the test harness focused.
const SCHEMA_SQL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  message_count INTEGER DEFAULT 0,
  title TEXT
);
CREATE INDEX idx_sessions_source ON sessions(source);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
`;

async function runSql(db: string, sql: string): Promise<void> {
  await execFileP('sqlite3', [db, sql]);
}

export interface ProxyRig {
  tmpDir: string;
  stateDb: string;
  sessionsJson: string;
  sessionsDir: string;
  fakePlugin: FakePlugin;
  proxyUrl: string;
  proxyServer: http.Server;
  /** Seed a sessions table row. */
  seedSession(row: {
    id: string;
    source?: string;
    title?: string;
    message_count?: number;
    started_at?: number;
    ended_at?: number | null;
    parent_session_id?: string | null;
  }): Promise<void>;
  /** Seed a messages row for an existing session. */
  seedMessage(row: {
    session_id: string;
    role: string;
    content?: string;
    timestamp?: number;
    tool_name?: string | null;
  }): Promise<void>;
  /** Write sessions.json with the given keyed entries. */
  writeSessionsIndex(entries: Record<string, {
    session_key: string;
    session_id: string;
    platform?: string;
    chat_id?: string;
    updated_at?: string;
    created_at?: string;
  }>): Promise<void>;
  /** Touch a transcript file. */
  writeJsonl(sessionId: string, content?: string): Promise<void>;
  cleanup(): Promise<void>;
}

export class FakePlugin {
  port = 0;
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  /** Envelopes the proxy has sent us. */
  received: any[] = [];
  /** Active client connection (proxy → us). Only one expected. */
  private conn: WS | null = null;
  /** Resolved when the proxy connects. */
  connected!: Promise<void>;
  private resolveConnected!: () => void;
  /** Optional hook: when proxy sends an envelope, call this. Useful for
   *  T2-style tests where we need to mimic plugin's side-effects on the
   *  scratch state.db. */
  onMessage?: (env: any) => void | Promise<void>;

  async start(): Promise<void> {
    this.connected = new Promise<void>((resolve) => { this.resolveConnected = resolve; });
    this.httpServer = http.createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      this.conn = ws;
      this.resolveConnected();
      ws.on('message', async (raw) => {
        let env: any;
        try { env = JSON.parse(raw.toString('utf8')); } catch { return; }
        this.received.push(env);
        if (this.onMessage) {
          try { await this.onMessage(env); } catch (e: any) {
            console.warn('[fake-plugin] onMessage threw:', e?.message);
          }
        }
      });
      ws.on('close', () => { if (this.conn === ws) this.conn = null; });
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (typeof addr !== 'object' || !addr) throw new Error('no addr');
        this.port = addr.port;
        resolve();
      });
    });
  }

  /** Push an envelope down to the proxy. */
  emit(env: any): void {
    if (!this.conn) throw new Error('FakePlugin: no proxy connection yet');
    this.conn.send(JSON.stringify(env));
  }

  async stop(): Promise<void> {
    if (this.conn) try { this.conn.close(); } catch { /* noop */ }
    this.conn = null;
    if (this.wss) await new Promise<void>((r) => this.wss!.close(() => r()));
    this.wss = null;
    if (this.httpServer) await new Promise<void>((r) => this.httpServer!.close(() => r()));
    this.httpServer = null;
  }
}

/** Wait until predicate returns truthy or timeout. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

/** Build the proxy http.Server: only the /api/sidekick/* routes we care about. */
function buildProxyServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'POST' && p === '/api/sidekick/messages') {
        return await handleSidekickMessage(req, res);
      }
      if (req.method === 'GET' && p === '/api/sidekick/sessions') {
        return await handleSidekickSessionsList(req, res);
      }
      if (req.method === 'GET' && p === '/api/sidekick/stream') {
        return handleSidekickStream(req, res);
      }
      const m = p.match(/^\/api\/sidekick\/sessions\/([^/]+)(?:\/messages)?$/);
      if (m) {
        const chatId = decodeURIComponent(m[1]);
        if (req.method === 'DELETE') {
          return await handleSidekickSessionDelete(req, res, chatId);
        }
        if (req.method === 'GET' && p.endsWith('/messages')) {
          return await handleSidekickSessionMessages(req, res, chatId);
        }
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'route not found in test harness', path: p, method: req.method }));
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || 'unknown' }));
    }
  });
  return server;
}

export async function setupProxyTest(): Promise<ProxyRig> {
  // Tear down any prior client state from the previous test.
  client.shutdownClient();
  // Reset internal singletons by re-instantiating (no API for it; we mutate).
  // The init() function in client.ts no-ops if `url` is already set, so we
  // need to clear it. Easiest path: assign new state via internals.
  (client as any).url = '';
  (client as any).token = '';
  (client as any).ws = null;
  (client as any).reconnectAttempt = 0;
  (client as any).reconnectTimer = null;
  (client as any).shutdown = false;
  (client as any).connected = false;
  (client as any).listeners = new Map();
  (client as any).wildcardListeners = new Set();

  // Reset the stream module's `wired` flag so initHermesGateway re-attaches
  // the wildcard subscription on the new client state.
  // (No API for it; the field is inside stream.ts.) We reach in via a
  // dynamic import + re-eval — simpler to just accept idempotency here:
  // initHermesGateway() is no-op-on-second-call, but the wildcard listener
  // we registered on the OLD client is now orphaned, which is fine because
  // we cleared the listeners array above.
  const streamMod = await import('../stream.ts');
  (streamMod as any).__resetForTest?.();
  // Drop previously-registered subscriber state so cross-test bleed doesn't
  // happen. We can't reach the subscribers Set directly from here — it's
  // module-private. Instead, rely on the fact that nothing should be
  // subscribed at test boundaries (we close the http.Server which closes
  // open SSE streams).

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-proxy-test-'));
  const stateDb = path.join(tmpDir, 'state.db');
  const sessionsDir = path.join(tmpDir, 'sessions');
  const sessionsJson = path.join(sessionsDir, 'sessions.json');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(sessionsJson, '{}', 'utf8');
  await runSql(stateDb, SCHEMA_SQL);

  // Wire hermes config to the scratch.
  initHermesConfig({
    HERMES_STORE_DB: '',
    HERMES_STATE_DB: stateDb,
    HERMES_CLI: '',
    HINDSIGHT_URL: '',
    HINDSIGHT_BANK: '',
    HINDSIGHT_API_KEY: '',
    HERMES_SESSION_PREFIX: '',
    HERMES_SESSION_SOURCES: [],
    HERMES_TOKEN: '',
    HERMES_UPSTREAM: '',
  });

  const fakePlugin = new FakePlugin();
  await fakePlugin.start();

  // Boot the WS client + stream wiring.
  initHermesGateway({
    token: 'test-token',
    url: `ws://127.0.0.1:${fakePlugin.port}`,
  });

  // Wait for the proxy WS client to connect to FakePlugin.
  await fakePlugin.connected;
  await waitFor(() => client.isConnected(), 2000);

  // Boot the http.Server hosting proxy routes.
  const proxyServer = buildProxyServer();
  const proxyUrl = await new Promise<string>((resolve, reject) => {
    proxyServer.once('error', reject);
    proxyServer.listen(0, '127.0.0.1', () => {
      const addr = proxyServer.address();
      if (typeof addr !== 'object' || !addr) return reject(new Error('no addr'));
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  const seedSession: ProxyRig['seedSession'] = async (row) => {
    const r = {
      source: 'sidekick',
      message_count: 0,
      started_at: Date.now() / 1000,
      ended_at: null,
      title: null as string | null,
      parent_session_id: null as string | null,
      ...row,
    };
    const sql = `INSERT INTO sessions
      (id, source, title, message_count, started_at, ended_at, parent_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    // sqlite3 CLI doesn't take parameters via -cmd easily; build a literal
    // INSERT with quoted values (test data is fully controlled).
    const lit = (v: any) => v === null || v === undefined
      ? 'NULL'
      : typeof v === 'number' ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;
    const inlined = `INSERT INTO sessions
      (id, source, title, message_count, started_at, ended_at, parent_session_id)
      VALUES (${lit(r.id)}, ${lit(r.source)}, ${lit(r.title)},
              ${lit(r.message_count)}, ${lit(r.started_at)}, ${lit(r.ended_at)},
              ${lit(r.parent_session_id)});`;
    await runSql(stateDb, inlined);
  };

  const seedMessage: ProxyRig['seedMessage'] = async (row) => {
    const r = {
      content: '',
      timestamp: Date.now() / 1000,
      tool_name: null as string | null,
      ...row,
    };
    const lit = (v: any) => v === null || v === undefined
      ? 'NULL'
      : typeof v === 'number' ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;
    const inlined = `INSERT INTO messages
      (session_id, role, content, timestamp, tool_name)
      VALUES (${lit(r.session_id)}, ${lit(r.role)}, ${lit(r.content)},
              ${lit(r.timestamp)}, ${lit(r.tool_name)});`;
    await runSql(stateDb, inlined);
  };

  const writeSessionsIndex: ProxyRig['writeSessionsIndex'] = async (entries) => {
    await fs.writeFile(sessionsJson, JSON.stringify(entries, null, 2), 'utf8');
  };

  const writeJsonl: ProxyRig['writeJsonl'] = async (sessionId, content = '') => {
    await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), content, 'utf8');
  };

  const cleanup = async () => {
    // Tear down stream module state first — this clears any open SSE
    // subscribers, which would otherwise keep proxyServer.close() blocked
    // on draining keep-alive responses.
    const streamModForCleanup = await import('../stream.ts');
    streamModForCleanup.__resetForTest?.();
    client.shutdownClient();
    // Belt-and-suspenders for any non-SSE keep-alive sockets.
    proxyServer.closeAllConnections?.();
    await new Promise<void>((r) => proxyServer.close(() => r()));
    await fakePlugin.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  };

  return {
    tmpDir, stateDb, sessionsJson, sessionsDir,
    fakePlugin, proxyUrl, proxyServer,
    seedSession, seedMessage, writeSessionsIndex, writeJsonl, cleanup,
  };
}

/** SSE helper: open a stream and collect parsed events until predicate or timeout. */
export interface SseEvent {
  id?: string;
  event?: string;
  data: any;
}

export class SseClient {
  private url: string;
  private headers: Record<string, string>;
  private req: http.ClientRequest | null = null;
  events: SseEvent[] = [];
  /** Resolves when the response headers arrive. */
  ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: any) => void;
  private buffer = '';

  constructor(url: string, headers: Record<string, string> = {}) {
    this.url = url;
    this.headers = headers;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async start(): Promise<void> {
    const u = new URL(this.url);
    this.req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...this.headers },
    }, (res) => {
      this.resolveReady();
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        this.buffer += chunk;
        // Frames are separated by '\n\n'.
        let idx;
        while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
          const frame = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);
          this.parseFrame(frame);
        }
      });
    });
    this.req.on('error', (e) => this.rejectReady(e));
    this.req.end();
    await this.ready;
  }

  private parseFrame(frame: string): void {
    if (!frame.trim() || frame.startsWith(':')) return;
    const ev: SseEvent = { data: undefined };
    for (const line of frame.split('\n')) {
      if (line.startsWith('id: ')) ev.id = line.slice(4);
      else if (line.startsWith('event: ')) ev.event = line.slice(7);
      else if (line.startsWith('data: ')) {
        const raw = line.slice(6);
        try { ev.data = JSON.parse(raw); } catch { ev.data = raw; }
      }
    }
    this.events.push(ev);
  }

  close(): void {
    try { this.req?.destroy(); } catch { /* noop */ }
  }
}
