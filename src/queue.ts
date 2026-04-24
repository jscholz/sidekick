/**
 * IndexedDB-backed outbox queue for offline message reliability.
 * Stores text messages and audio blobs, flushes in order when connected.
 */

const DB_NAME = 'sidekick-outbox';
const STORE = 'messages';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Enqueue a message or audio blob for later delivery.
 * @param {({ type: 'text', text: string, source: string } | { type: 'audio', blob: Blob, mimeType: string, durationMs?: number }) & { id?: string }} item
 */
export async function enqueue(item) {
  const db = await openDB();
  const record = {
    id: item.id || crypto.randomUUID(),
    timestamp: Date.now(),
    status: 'pending',
    ...item,
  };
  await reqP(tx(db, 'readwrite').put(record));
  db.close();
  return record.id;
}

/** In-process mutex — two concurrent flush() calls would each read the
 *  same pending list and each try to send-then-delete every item,
 *  producing duplicate server-side sends. Real-world race seen on mobile:
 *  a memo completion fires flushOutbox() while a gateway reconnect fires
 *  it 2s later, both flushing the same queued blob. Lock keeps flush
 *  serial; second caller gets {skipped: true} back and can retry later.
 *  Lock is in-memory only so it resets on page reload (no stuck "sending"
 *  rows in IndexedDB to clean up). */
let isFlushing = false;

/**
 * Flush pending items in order. Stops on first failure to preserve ordering.
 * Concurrent calls skip (second caller returns skipped=true); the in-flight
 * flush will cover whatever was pending when it started.
 * @param {(text: string, source: string) => Promise<void>} sendTextFn
 * @param {(blob: Blob, mimeType: string, id: string) => Promise<void>} transcribeAndSendFn
 * @returns {Promise<{ sent: number, remaining: number, skipped?: boolean }>}
 */
export async function flush(sendTextFn, transcribeAndSendFn) {
  if (isFlushing) return { sent: 0, remaining: 0, skipped: true };
  isFlushing = true;
  const db = await openDB();
  let sent = 0;
  let remaining = 0;
  try {
    // Loop until queue is empty OR a send fails. Re-reading the pending
    // list each pass catches items that got enqueued DURING the previous
    // pass — e.g. rapid-fire memos: memo 1's handleMemoResult fires
    // flushOutbox which locks the mutex, but memos 2/3 arrive while
    // memo 1 is mid-/transcribe. Their handleMemoResult-triggered
    // flushOutbox calls skip (mutex held), so without re-reading here
    // they'd wait until the 30s periodic retry. With re-read they get
    // picked up on this same flush pass.
    while (true) {
      const all = await reqP(tx(db, 'readonly').getAll());
      const items = all.filter(i => i.status === 'pending').sort((a, b) => a.timestamp - b.timestamp);
      if (items.length === 0) break;
      let processed = false;
      let failed = false;
      for (const item of items) {
        try {
          if (item.type === 'text') await sendTextFn(item.text, item.source);
          else if (item.type === 'audio') await transcribeAndSendFn(item.blob, item.mimeType, item.id);
          await reqP(tx(db, 'readwrite').delete(item.id));
          sent++;
          processed = true;
        } catch {
          // stop on first failure — preserve ordering
          failed = true;
          remaining = items.length - sent;
          break;
        }
      }
      if (failed || !processed) break;
    }
    db.close();
    return { sent, remaining };
  } finally {
    isFlushing = false;
  }
}

/** Return count of pending items. */
/** Remove a single item by id. Called from the live memo path
 *  (transcribeAndRoute) once /transcribe succeeds, so the periodic
 *  outbox flush doesn't later find + re-transcribe the same blob
 *  and produce a duplicate composer append / chat send. */
export async function remove(id) {
  const db = await openDB();
  try { await reqP(tx(db, 'readwrite').delete(id)); } catch {}
  db.close();
}

export async function pending() {
  const db = await openDB();
  const all = await reqP(tx(db, 'readonly').getAll());
  db.close();
  return all.filter(i => i.status === 'pending').length;
}

/** Richer pending view — count + total audio duration. Used by status
 *  bar to show "N queued (M:SS audio)" so the user can reason about
 *  what's stuck. durationMs comes from the memo record itself (set at
 *  recording stop); text items contribute 0. */
export async function summary() {
  const db = await openDB();
  const all = await reqP(tx(db, 'readonly').getAll());
  db.close();
  const pending = all.filter(i => i.status === 'pending');
  const count = pending.length;
  const totalAudioMs = pending.reduce((s, i) => s + (i.durationMs || 0), 0);
  return { count, totalAudioMs };
}

/** Delete all items. */
export async function clear() {
  const db = await openDB();
  await reqP(tx(db, 'readwrite').clear());
  db.close();
}
