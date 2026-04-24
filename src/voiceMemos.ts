/**
 * Voice memo storage — IndexedDB blob persistence + waveform extraction.
 * Separate from the outbox queue: blobs stay here until /reset so the user
 * can play back their memos in the chat history.
 */

const DB_NAME = 'sidekick-voice-memos';
const STORE = 'memos';
const DB_VERSION = 1;

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

/** Save a memo record. waveform is a Float32Array (~40 amplitude values). */
export async function save({ id, blob, mimeType, durationMs, waveform, transcript = null, status = 'pending', timestamp = Date.now() }) {
  const db = await openDB();
  // Copy waveform to a plain array for IDB cloneability
  const waveArr = Array.from(waveform);
  await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).put({
    id, blob, mimeType, durationMs, waveform: waveArr, transcript, status, timestamp,
  }));
  db.close();
}

export async function get(id) {
  const db = await openDB();
  const rec = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  db.close();
  return rec;
}

export async function update(id, patch) {
  const db = await openDB();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const existing = await reqP(store.get(id));
  if (!existing) { db.close(); return; }
  await reqP(store.put({ ...existing, ...patch }));
  db.close();
}

export async function getAll() {
  const db = await openDB();
  const all = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  db.close();
  return all.sort((a, b) => a.timestamp - b.timestamp);
}

export async function clearAll() {
  const db = await openDB();
  await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
  db.close();
}

/** Delete a single record by id. Used by the autoSend=off memo path: once
 *  /transcribe succeeds the text goes to the composer, the placeholder card
 *  is removed from the DOM, and this drops the blob so it doesn't reappear
 *  on reload. */
export async function remove(id) {
  const db = await openDB();
  await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  db.close();
}

/** Delete only records where status !== 'pending'. Used on reload to clear
 *  sent-memo history while preserving the offline outbox queue. */
export async function clearSent() {
  const db = await openDB();
  const all = await reqP(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  for (const rec of all) {
    if (rec.status !== 'pending') {
      await reqP(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(rec.id));
    }
  }
  db.close();
}

/** Extract a ~nBars amplitude envelope from an audio blob. Times out after 5s. */
export async function extractWaveform(blob: Blob, nBars = 40): Promise<Float32Array> {
  const extract = async (): Promise<Float32Array> => {
    const arrayBuffer = await blob.arrayBuffer();
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctx();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const channel = audioBuffer.getChannelData(0);
      const bucketSize = Math.max(1, Math.floor(channel.length / nBars));
      const bars = new Float32Array(nBars);
      for (let i = 0; i < nBars; i++) {
        let max = 0;
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, channel.length);
        for (let j = start; j < end; j++) {
          const v = Math.abs(channel[j]);
          if (v > max) max = v;
        }
        bars[i] = max;
      }
      return bars;
    } finally {
      try { ctx.close(); } catch {}
    }
  };
  // Race against timeout — decodeAudioData can hang on some browsers/states
  return Promise.race([
    extract(),
    new Promise<Float32Array>((_, reject) => setTimeout(() => reject(new Error('extract timeout')), 5000)),
  ]);
}
