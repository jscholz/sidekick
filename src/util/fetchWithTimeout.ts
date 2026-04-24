/**
 * @fileoverview fetch() wrapper with AbortController timeout. Used
 * anywhere a stalled network call could block the UI — on weak cellular
 * the browser's default socket timeout is minutes. We want to know
 * sooner so fallbacks (retry via queue, chime the user, surface "weak
 * signal" in the header) can engage.
 *
 * Policy: timeout means "this attempt didn't land, will retry later" —
 * NEVER means "user's data is lost." Callers that produce persistent
 * artifacts (memo blobs, chat messages) must persist BEFORE the fetch,
 * not after. See queue.ts / voiceMemos.ts — both already save before
 * invoking the handler.
 */

export class TimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`fetch timed out after ${ms}ms: ${url}`);
    this.name = 'TimeoutError';
  }
}

/** Thin wrapper around fetch() that rejects with TimeoutError if the
 *  response doesn't start arriving within `timeoutMs`. Note: this times
 *  the HEADERS, not the full body — a streaming response that takes
 *  minutes to finish is fine as long as headers arrive in time. For the
 *  body, caller can wrap the .json() / .blob() / .text() call separately
 *  if needed. */
export async function fetchWithTimeout(url: string, opts: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { timeoutMs, ...rest } = opts;
  const controller = new AbortController();
  // Respect caller-provided signal: abort our controller when theirs
  // fires. Avoids ping-ponging between two independent aborts.
  if (rest.signal) {
    if (rest.signal.aborted) controller.abort(rest.signal.reason);
    else rest.signal.addEventListener('abort', () => controller.abort(rest.signal.reason), { once: true });
  }
  const t = setTimeout(() => controller.abort(new TimeoutError(url, timeoutMs)), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (e) {
    // Normalize AbortError-with-TimeoutError-reason back to TimeoutError
    // so callers can instanceof-check without touching AbortSignal.reason.
    const anyE = e as { name?: string };
    if (anyE?.name === 'AbortError' && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}
