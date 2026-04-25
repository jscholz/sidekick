/**
 * @fileoverview Tiny IDB key-value store for the cmdk/filter feature —
 * stores the inline session filter so it survives page reload, and is the
 * obvious place to drop future cmdk-related persisted state (recent
 * searches etc., when those land).
 *
 * Namespace: `sidekick.cmdk` (DB), with key `filter` for the drawer's
 * inline value. Sibling DB to the main chat snapshot store so a malformed
 * write here can never corrupt the chat transcript.
 */

const DB_NAME = 'sidekick.cmdk';
const STORE = 'kv';
const FILTER_KEY = 'filter';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
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

export async function getFilter(): Promise<string> {
  try {
    const db = await open();
    const v = await reqP<any>(db.transaction(STORE, 'readonly').objectStore(STORE).get(FILTER_KEY));
    db.close();
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

export async function putFilter(value: string): Promise<void> {
  try {
    const db = await open();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, FILTER_KEY));
    db.close();
  } catch {}
}

export async function clearFilter(): Promise<void> {
  try {
    const db = await open();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(FILTER_KEY));
    db.close();
  } catch {}
}
