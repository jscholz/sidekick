/**
 * @fileoverview IndexedDB-backed cache for the session drawer's list +
 * per-session transcripts. Makes tap-to-resume feel instant instead of
 * the 5-10s it was taking to round-trip through the server + SQL.
 *
 * Design:
 *   - One DB (sidekick-sessions), two stores:
 *     - 'list'     : keyed by 'current'      { sessions: SessionInfo[], updatedAt }
 *     - 'messages' : keyed by conversation name { id, messages, updatedAt }
 *   - sessionDrawer.refresh() reads the cached list first (instant render),
 *     then background-fetches from server + updates cache + re-renders.
 *   - sessionDrawer.resume() does the same for messages: replay cached
 *     transcript immediately, background-fetch to reconcile.
 *
 * Stale data is better than a 5s spinner. Background refresh catches up.
 * IDB writes are fire-and-forget; if they fail, the UI is unaffected —
 * next load just re-populates from server.
 */

const DB_NAME = 'sidekick-sessions';
const LIST_STORE = 'list';
const MESSAGES_STORE = 'messages';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIST_STORE)) {
        db.createObjectStore(LIST_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function getListCache(): Promise<{ sessions: any[], updatedAt: number } | null> {
  try {
    const db = await openDB();
    const rec = await reqP(db.transaction(LIST_STORE).objectStore(LIST_STORE).get('current'));
    db.close();
    return rec ? { sessions: rec.sessions, updatedAt: rec.updatedAt } : null;
  } catch { return null; }
}

export async function putListCache(sessions: any[]): Promise<void> {
  try {
    const db = await openDB();
    await reqP(
      db.transaction(LIST_STORE, 'readwrite').objectStore(LIST_STORE)
        .put({ key: 'current', sessions, updatedAt: Date.now() })
    );
    db.close();
  } catch {}
}

export async function getMessagesCache(id: string): Promise<{ messages: any[], updatedAt: number } | null> {
  try {
    const db = await openDB();
    const rec = await reqP(db.transaction(MESSAGES_STORE).objectStore(MESSAGES_STORE).get(id));
    db.close();
    return rec ? { messages: rec.messages, updatedAt: rec.updatedAt } : null;
  } catch { return null; }
}

export async function putMessagesCache(id: string, messages: any[]): Promise<void> {
  try {
    const db = await openDB();
    await reqP(
      db.transaction(MESSAGES_STORE, 'readwrite').objectStore(MESSAGES_STORE)
        .put({ id, messages, updatedAt: Date.now() })
    );
    db.close();
  } catch {}
}

/** Drop a cached transcript — called after rename/delete so stale previews
 *  don't linger. The list cache is always refetched after those ops too. */
export async function removeMessagesCache(id: string): Promise<void> {
  try {
    const db = await openDB();
    await reqP(db.transaction(MESSAGES_STORE, 'readwrite').objectStore(MESSAGES_STORE).delete(id));
    db.close();
  } catch {}
}
