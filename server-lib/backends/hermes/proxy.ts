// Hermes API pass-through proxy plus the drawer-events SSE channel.
// The drawer-events helpers live alongside the proxy because the proxy
// is their sole producer (announces session-started on the first POST
// of a new conversation slug); handleDrawerEvents itself is dispatched
// by server.ts at GET /api/hermes/drawer-events.
import http from 'node:http';
import https from 'node:https';
import { HERMES_UPSTREAM, HERMES_TOKEN } from './config.ts';

// ─── Drawer events SSE broadcast ─────────────────────────────────────────────
// Persistent SSE channel that pushes session-lifecycle events to all connected
// drawers. Today: `session-started` fires when a new conversation name first
// hits POST /v1/responses (sidekick-originated sessions). Drawers prepend a
// synthesized row by id; the next listSessions reconcile replaces it with the
// server-persisted version. Lets the drawer show a row BEFORE the agent's
// first reply lands — fixes the "switch-away mid-flight loses the row" class
// of bugs.
const drawerSubscribers = new Set<http.ServerResponse>();
// LRU of conversation names we've already announced. Bounded to keep memory
// flat under unbounded-uptime; restart re-announces on next send (drawers
// dedupe on id, so harmless).
const ANNOUNCED_CAP = 200;
const announcedConvs = new Map<string, number>();
function rememberAnnounced(name: string) {
  announcedConvs.set(name, Date.now());
  if (announcedConvs.size > ANNOUNCED_CAP) {
    const oldest = announcedConvs.keys().next().value;
    if (oldest) announcedConvs.delete(oldest);
  }
}
function broadcastDrawerEvent(eventName: string, payload: any) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const sub of drawerSubscribers) {
    try { sub.write(frame); }
    catch { drawerSubscribers.delete(sub); }
  }
}
export function handleDrawerEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // disable any reverse-proxy buffering
  });
  res.write('retry: 5000\n\n');  // EventSource auto-reconnect hint
  drawerSubscribers.add(res);
  const ka = setInterval(() => {
    try { res.write(': ka\n\n'); }
    catch { /* will be evicted on next broadcast */ }
  }, 15_000);
  const detach = () => {
    clearInterval(ka);
    drawerSubscribers.delete(res);
  };
  req.on('close', detach);
  req.on('error', detach);
}
/** Pull the first user-supplied text out of a Responses-API POST body. The
 *  shape we expect: `{ input: [{ role:'user', content:[{type:'text', text:'…'}]}, …] }`.
 *  Older clients sometimes send `input` as a bare string. Returns '' if the
 *  body doesn't match — empty snippet is fine, the drawer row still renders. */
function extractFirstUserText(body: any): string {
  if (!body) return '';
  if (typeof body.input === 'string') return body.input;
  if (!Array.isArray(body.input)) return '';
  for (const turn of body.input) {
    if (turn?.role !== 'user') continue;
    if (typeof turn.content === 'string') return turn.content;
    if (Array.isArray(turn.content)) {
      for (const part of turn.content) {
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part?.text === 'string') return part.text;
      }
    }
  }
  return '';
}

export function handleHermesProxy(req, res) {
  // Map /api/hermes/<path> → /v1/<path> upstream.
  const suffix = req.url.replace(/^\/api\/hermes/, '') || '/';
  const upstreamPath = `/v1${suffix}`;
  const upstream = new URL(upstreamPath, HERMES_UPSTREAM);

  const headers = {};
  // Forward content headers + accept. Strip cookies/host — the upstream
  // only cares about method + body + our injected auth.
  for (const h of ['content-type', 'content-length', 'accept']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  if (HERMES_TOKEN) headers['authorization'] = `Bearer ${HERMES_TOKEN}`;

  const lib = upstream.protocol === 'https:' ? https : http;
  const upReq = lib.request({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers,
  }, (upRes) => {
    // Strip hop-by-hop headers; keep SSE-critical ones.
    const out = { ...upRes.headers };
    delete out.connection;
    delete out['transfer-encoding'];
    // Preserve content-type (text/event-stream for /responses with stream=true).
    res.writeHead(upRes.statusCode || 502, out);

    // Manual relay (instead of upRes.pipe(res)) so a downstream client
    // disconnect does NOT propagate up to hermes. With pipe(), Node
    // closes upRes when res closes, which closes our TCP connection
    // to hermes — and hermes' SSE handler (api_server.py:1157) reacts
    // to that close by calling agent.interrupt + agent_task.cancel.
    // Result before this change: every phone hibernation, network
    // blip, or tab close mid-run killed the agent task. OpenClaw was
    // robust on bike rides; hermes regressed because of this proxy.
    //
    // New behavior: if downstream goes away, we silently drain upRes
    // to /dev/null. The agent finishes naturally, hermes writes the
    // response to response_store.db via its normal completion path,
    // and the next /v1/responses POST on the same conversation name
    // picks up the chained reply via previous_response_id.
    let downstreamLive = true;
    const detach = () => { downstreamLive = false; };
    res.on('close', detach);
    res.on('error', detach);

    upRes.on('data', (chunk) => {
      if (!downstreamLive) return;
      try {
        if (!res.write(chunk)) {
          // Backpressure: pause upRes until res drains. Don't drop
          // chunks — clients (sidekick frontend) parse SSE strictly.
          upRes.pause();
          res.once('drain', () => upRes.resume());
        }
      } catch {
        downstreamLive = false;
      }
    });
    upRes.on('end', () => {
      if (downstreamLive) { try { res.end(); } catch {} }
    });
    upRes.on('error', (e) => {
      console.error('hermes proxy: upstream stream error:', e.message);
      if (downstreamLive) { try { res.end(); } catch {} }
    });
  });

  upReq.on('error', (e) => {
    console.error('hermes proxy: upstream error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream unreachable: ${e.message}` }));
    } else {
      res.end();
    }
  });

  // Forward client body (POST) or just end (GET). For POST /v1/responses we
  // tee the body into a side buffer so we can announce session-started on
  // the first message of a new conversation. The forward stream is unchanged
  // — bytes flow upstream as they arrive (no added forwarding latency); the
  // tee parses on body-end and fires the SSE event a few ms later, well
  // before the agent's first reply could possibly land.
  if (req.method === 'POST' || req.method === 'PUT') {
    const isResponsesPost = req.method === 'POST' && /^\/v1\/responses(?:\?|$)/.test(upstreamPath);
    if (isResponsesPost) {
      const sniff: Buffer[] = [];
      let sniffBytes = 0;
      const SNIFF_CAP = 512 * 1024;  // bound the side buffer; bodies are kB
      req.on('data', (chunk: Buffer) => {
        if (sniffBytes < SNIFF_CAP) {
          sniff.push(chunk);
          sniffBytes += chunk.length;
        }
      });
      req.on('end', () => {
        if (!sniff.length) return;
        let body: any;
        try { body = JSON.parse(Buffer.concat(sniff).toString('utf8')); }
        catch { return; }
        const conv = typeof body?.conversation === 'string' ? body.conversation : null;
        if (!conv) return;
        if (!/^(sidekick|sideclaw)-/.test(conv)) return;  // skip cli/test names
        if (announcedConvs.has(conv)) return;
        rememberAnnounced(conv);
        broadcastDrawerEvent('session-started', {
          id: conv,
          snippet: extractFirstUserText(body).slice(0, 120),
          source: 'api_server',
          started_at: new Date().toISOString(),
        });
      });
    }
    req.pipe(upReq);
  } else upReq.end();
}
