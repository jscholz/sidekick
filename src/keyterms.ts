/**
 * Per-user STT keyterm storage — IndexedDB-backed, separate DB from the
 * outbox queue (different lifecycle: keyterms persist across sessions
 * and never auto-purge; outbox items get deleted on flush).
 *
 * The list seeds itself ONCE on first load by fetching `/api/keyterms`
 * (which the server reads from `default_stt_keyterms.txt`). After that
 * fetch, the seed file is irrelevant — all reads/writes are local.
 *
 * Schema is intentionally trivial: one record `{ id: 'list', terms: string[] }`.
 * No per-term ids, no timestamps; the chip UI mutates the whole list.
 */

const DB_NAME = 'sidekick-keyterms';
const STORE = 'keyterms';
const DB_VERSION = 1;
const RECORD_ID = 'list';

function openDB(): Promise<IDBDatabase> {
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

function reqP<T = any>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Parse the seed file format — newline + comma delimited, '#' comments
 *  stripped, dedup case-insensitive. Same shape the server emits and the
 *  chip-UI commit accepts, so editing the seed file by hand or pasting
 *  comma-separated lists into the input both round-trip correctly. */
function parseSeedBody(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const nocomment = line.replace(/#.*$/, '');
    for (const part of nocomment.split(',')) {
      const t = part.trim();
      if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    }
  }
  return out;
}

/** Read the saved list from IDB. Returns null when this user has never
 *  saved a list (caller should seed from the server). Returns [] when
 *  the user has explicitly cleared the list (caller should respect the
 *  empty state — no re-seeding from the file). */
export async function readList(): Promise<string[] | null> {
  try {
    const db = await openDB();
    const rec: any = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_ID));
    db.close();
    if (rec && Array.isArray(rec.terms)) return rec.terms.map((v: any) => String(v));
    return null;
  } catch {
    return null;
  }
}

/** Persist the given list to IDB. Overwrites any prior list.
 *  Logs to console on success/failure so the chip-UI commit path is
 *  observable from DevTools — Jonathan reported "adding chips fires no
 *  console output" 2026-04-28; without observability, an IDB write
 *  failure (quota, private mode, schema mismatch) was silent. */
export async function writeList(terms: string[]): Promise<void> {
  try {
    const db = await openDB();
    await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put({
      id: RECORD_ID,
      terms: terms.slice(),
      updatedAt: Date.now(),
    }));
    db.close();
    console.log(`[keyterms] writeList ok: ${terms.length} term(s)`,
      terms.length ? terms.slice(0, 5).join(', ') + (terms.length > 5 ? ` (+${terms.length - 5})` : '') : '(empty)');
  } catch (e) {
    // Best-effort: storage quota / private mode failures shouldn't break the UI.
    console.warn('[keyterms] writeList failed:', e);
  }
}

/** First-boot seed: returns the saved list, or fetches the server seed
 *  file and persists it once. The fetched list is then returned so the
 *  caller can render chips immediately. Failures (offline, server down)
 *  surface as an empty list — the user can still type new chips. */
export async function loadOrSeed(): Promise<string[]> {
  const saved = await readList();
  if (saved !== null) {
    console.log(`[keyterms] loadOrSeed: ${saved.length} from IDB`,
      saved.length ? saved.slice(0, 5).join(', ') + (saved.length > 5 ? ` (+${saved.length - 5})` : '') : '(empty)');
    return saved;
  }
  let seeded: string[] = [];
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const r = await fetchWithTimeout('/api/keyterms', { timeoutMs: 5_000 });
    if (r.ok) seeded = parseSeedBody(await r.text());
  } catch (e) {
    console.warn('[keyterms] seed fetch failed:', e);
  }
  console.log(`[keyterms] loadOrSeed: seeded ${seeded.length} from /api/keyterms`);
  await writeList(seeded);
  return seeded;
}
