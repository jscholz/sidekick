// Hermes session delete + hindsight memory scrub. Cascades across all
// fork uuids via lookupAllSessionUuids so cold-start forks don't ghost
// back into the drawer after a delete. See search.ts for the dual
// fork-mechanism explainer.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  HERMES_STORE_DB, HERMES_CLI,
  HINDSIGHT_URL, HINDSIGHT_BANK, HINDSIGHT_API_KEY,
} from './config.ts';
import { lookupAllSessionUuids } from './sessions.ts';

const execFileP = promisify(execFile);

/** Scrub all hindsight memories tagged with this session UUID.
 *
 * Two storage shapes need handling:
 *   1. Live retains (hermes hindsight plugin going forward) — the plugin sets
 *      `document_id = self._session_id`, so document.id == session UUID and
 *      the dedicated `DELETE /documents/{document_id}` endpoint cascades to
 *      the document, all extracted memory units, and their links.
 *   2. Backfilled docs (one document per historical message) — document.id is
 *      a random UUID; the session UUID lives only in `document_metadata.session_id`.
 *      The list-documents endpoint can't filter by metadata, so we paginate
 *      through all docs in the bank and delete those whose metadata matches.
 *
 * Best-effort: any failure is logged but does NOT fail the overall session
 * delete (sqlite cleanup is the primary guarantee — a stranded hindsight row
 * is a privacy bug, but a failed sqlite delete is a UI/state corruption bug).
 */
export async function purgeHindsightSession(sessionUuid: string): Promise<{ docs: number; units: number; errors: number }> {
  if (!HINDSIGHT_URL) return { docs: 0, units: 0, errors: 0 };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (HINDSIGHT_API_KEY) headers['authorization'] = `Bearer ${HINDSIGHT_API_KEY}`;
  const bank = encodeURIComponent(HINDSIGHT_BANK);
  let docs = 0, units = 0, errors = 0;

  // (1) Direct delete by document_id == session UUID. 404 = no such doc
  // (live retain never happened or already gone), which is fine.
  try {
    const r = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${bank}/documents/${encodeURIComponent(sessionUuid)}`,
      { method: 'DELETE', headers });
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}));
      docs++;
      units += j.memory_units_deleted ?? 0;
    } else if (r.status !== 404) {
      console.warn(`[hindsight purge] direct delete returned ${r.status} for ${sessionUuid}`);
      errors++;
    }
  } catch (e: any) {
    console.warn(`[hindsight purge] direct delete failed for ${sessionUuid}:`, e.message);
    errors++;
    // If hindsight is unreachable, skip the metadata sweep — same root cause.
    return { docs, units, errors };
  }

  // (2) Metadata sweep: pull all documents and match on document_metadata.session_id.
  // Bank size is small (~tens of docs per active user), so a paginated full-list
  // scan is fine. If banks grow large, an indexed metadata-filter endpoint would
  // be the right server-side answer.
  const PAGE_SIZE = 200;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let items: any[] = [];
    try {
      const r = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${bank}/documents?limit=${PAGE_SIZE}&offset=${offset}`,
        { headers });
      if (!r.ok) {
        console.warn(`[hindsight purge] list returned ${r.status} at offset ${offset}`);
        errors++;
        break;
      }
      const j: any = await r.json();
      items = Array.isArray(j.items) ? j.items : [];
    } catch (e: any) {
      console.warn(`[hindsight purge] list failed at offset ${offset}:`, e.message);
      errors++;
      break;
    }
    if (items.length === 0) break;
    for (const doc of items) {
      const docSid = doc?.document_metadata?.session_id;
      if (docSid !== sessionUuid) continue;
      // Skip if we already nuked it by id in step (1) — same id won't list anymore,
      // but be defensive against races.
      if (doc.id === sessionUuid) continue;
      try {
        const r = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${bank}/documents/${encodeURIComponent(doc.id)}`,
          { method: 'DELETE', headers });
        if (r.ok) {
          const j: any = await r.json().catch(() => ({}));
          docs++;
          units += j.memory_units_deleted ?? 0;
        } else if (r.status !== 404) {
          console.warn(`[hindsight purge] delete ${doc.id} returned ${r.status}`);
          errors++;
        }
      } catch (e: any) {
        console.warn(`[hindsight purge] delete ${doc.id} failed:`, e.message);
        errors++;
      }
    }
    if (items.length < PAGE_SIZE) break;
  }
  return { docs, units, errors };
}

export async function handleHermesSessionDelete(req, res, name: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 128) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid session id' }));
    return;
  }
  try {
    const uuids = await lookupAllSessionUuids(name);
    if (uuids.length === 0) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }
    // Step 1: hermes CLI delete for EACH fork uuid. The dedup query in
    // searchSessionsImpl collapses cold-start forks into one drawer row,
    // so a delete must fan out to all members or the older forks become
    // orphaned (drawer reads them right back via the slug join).
    let cliErrors = 0;
    for (const uuid of uuids) {
      try {
        await execFileP(HERMES_CLI, ['sessions', 'delete', '--yes', uuid], {
          env: { ...process.env, HERMES_ACCEPT_HOOKS: '1' },
        });
      } catch (e: any) {
        cliErrors++;
        console.error(`[hermes delete] CLI failed for ${uuid}:`, e.message);
      }
    }
    // Step 2: hermes's CLI does NOT clean up response_store.db — conversation
    // name + response chain stay orphaned. Our list reads from conversations,
    // so without this cleanup the "deleted" row would still appear in the UI.
    // Remove the conversation entry + any response rows it referenced.
    // Strict name regex above protects against SQL injection here.
    await execFileP('sqlite3', [HERMES_STORE_DB,
      `DELETE FROM responses WHERE response_id IN (SELECT response_id FROM conversations WHERE name='${name}');`,
      `DELETE FROM conversations WHERE name='${name}';`,
    ]);
    // Step 3: scrub long-term memories the agent retained from this session.
    // Hindsight runs as a separate service and can be unreachable; treat as
    // best-effort so we don't strand the sqlite delete on a memory-service blip.
    let totalDocs = 0, totalUnits = 0, totalErrors = 0;
    for (const uuid of uuids) {
      const purged = await purgeHindsightSession(uuid);
      totalDocs += purged.docs;
      totalUnits += purged.units;
      totalErrors += purged.errors;
    }
    if (totalDocs > 0 || totalErrors > 0) {
      console.log(`[hermes delete] hindsight purge across ${uuids.length} fork(s): ${totalDocs} docs, ${totalUnits} memory units, ${totalErrors} errors`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, forks: uuids.length, hindsightDocs: totalDocs, hindsightUnits: totalUnits, cliErrors }));
  } catch (e: any) {
    console.error('hermes sessions delete failed:', e.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}
