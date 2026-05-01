// Generic SQLite shell-out helper. Used by the hermes backend for direct
// reads of response_store.db / state.db; placed here because the helper
// itself isn't hermes-specific (any other backend that needs to peek at
// a sqlite file can import it).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function sqlQuery(db: string, sql: string): Promise<any[]> {
  const { stdout } = await execFileP('sqlite3', ['-json', db, sql], {
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!stdout.trim()) return [];
  return JSON.parse(stdout);
}
