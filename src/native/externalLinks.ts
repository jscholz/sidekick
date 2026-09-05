/**
 * @fileoverview External links in the Capacitor iOS shell.
 *
 * Every anchor the transcript / cards / drawers render gets
 * `target="_blank"` (chat.ts, reconciler.ts, cards/kinds/*). In a browser
 * or the PWA that opens a tab. Inside WKWebView there is no tab: a
 * `_blank` navigation asks the host for a new web view, Capacitor
 * declines, and the tap does nothing (field 2026-09-05: "when I tap on
 * links the agent provides in the transcript, nothing opens").
 *
 * Fix: one delegated click listener, native shell only. Anchors whose
 * href is http(s) and not our own origin are opened through the
 * `@capacitor/browser` plugin (SFSafariViewController sheet with a Done
 * button, so the user lands back in the chat). Same-origin links (`?msg=`
 * drills, hash anchors) and non-http schemes (mailto:, tel:) are left to
 * the web view, which already handles them.
 *
 * Runtime access is via the injected `window.Capacitor.Plugins` global
 * (same pattern as speechRecognizer.ts / notifications/native.ts) so the
 * PWA bundle carries no import of the plugin.
 */

import { log } from '../util/log.ts';

export function isNativeShell(): boolean {
  const cap = (window as any).Capacitor;
  return !!cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() === true;
}

/** Pure decision: the absolute URL to hand to the native browser, or
 *  null when the web view should handle the click itself. */
export function externalLinkTarget(href: string | null | undefined, currentOrigin: string): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, currentOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === currentOrigin) return null;
  return url.toString();
}

function browserPlugin(): any {
  const cap = (window as any).Capacitor;
  return cap?.Plugins?.Browser ?? (typeof cap?.registerPlugin === 'function' ? cap.registerPlugin('Browser') : null);
}

export async function openExternal(url: string): Promise<boolean> {
  const browser = browserPlugin();
  if (browser && typeof browser.open === 'function') {
    try {
      await browser.open({ url, presentationStyle: 'popover' });
      return true;
    } catch (e) {
      log(`[external-links] Browser.open failed: ${(e as Error)?.message || e}`);
    }
  }
  // Last resort: a plain top-level navigation still beats a dead tap.
  // (Capacitor's decidePolicyFor hands off-origin navigations to the
  // system browser when the host isn't in allowNavigation.)
  try {
    window.location.href = url;
    return true;
  } catch {
    return false;
  }
}

let installed = false;

/** Idempotent. No-op outside the native shell. */
export function installExternalLinkHandler(): void {
  if (installed || typeof document === 'undefined') return;
  if (!isNativeShell()) return;
  installed = true;
  document.addEventListener('click', (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const url = externalLinkTarget(a.getAttribute('href'), window.location.origin);
    if (!url) return;
    e.preventDefault();
    e.stopPropagation();
    void openExternal(url);
  }, true);
  log('[external-links] native shell: routing off-origin links through Browser.open');
}
