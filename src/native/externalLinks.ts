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
 * href is http(s) and not our own origin are opened by, in order:
 *
 *  1. the custom `ExternalBrowser` native plugin (mobile/ios/App/App/
 *     ExternalBrowserPlugin.swift) — `UIApplication.shared.open()`, which
 *     hands the URL to the OS's registered default browser (Chrome, Edge,
 *     etc. as of iOS 14+). This is the one he actually wants: he asked
 *     2026-09-06 whether a tap would honor his default browser or always
 *     open Safari.
 *  2. `@capacitor/browser` (SFSafariViewController — always Safari's
 *     engine, ignores the default-browser setting) if the native plugin
 *     is missing (app not yet rebuilt with it).
 *
 * Same-origin links (`?msg=` drills, hash anchors) and non-http schemes
 * (mailto:, tel:) are left to the web view, which already handles them.
 *
 * Runtime access is via the injected `window.Capacitor.Plugins` global
 * (same pattern as speechRecognizer.ts / notifications/native.ts) so the
 * PWA bundle carries no import of either plugin.
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

function nativePlugin(name: string): any {
  const cap = (window as any).Capacitor;
  return cap?.Plugins?.[name] ?? (typeof cap?.registerPlugin === 'function' ? cap.registerPlugin(name) : null);
}

export async function openExternal(url: string): Promise<boolean> {
  const externalBrowser = nativePlugin('ExternalBrowser');
  if (externalBrowser && typeof externalBrowser.open === 'function') {
    try {
      await externalBrowser.open({ url });
      return true;
    } catch (e) {
      log(`[external-links] ExternalBrowser.open failed, falling back to in-app sheet: ${(e as Error)?.message || e}`);
    }
  }
  // Older build without the native plugin yet — the in-app Safari sheet
  // beats a dead tap even though it can't honor the default-browser
  // setting.
  const browser = nativePlugin('Browser');
  if (browser && typeof browser.open === 'function') {
    try {
      await browser.open({ url, presentationStyle: 'popover' });
      return true;
    } catch (e) {
      log(`[external-links] Browser.open failed: ${(e as Error)?.message || e}`);
    }
  }
  // Neither plugin is available. NOT falling back to
  // `window.location.href`: allowNavigation is '*' (capacitor.config.ts),
  // so that would navigate the app's OWN web view to the external site
  // instead of handing off, stranding the user outside the chat with no
  // way back — worse than the dead tap this function exists to fix.
  log(`[external-links] no way to open ${url} — neither ExternalBrowser nor Browser plugin available`);
  return false;
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
  log('[external-links] native shell: routing off-origin links to the default browser');
}
