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
 * href is http(s) and not our own origin are handed to the custom
 * `ExternalBrowser` native plugin (mobile/ios/App/App/
 * ExternalBrowserPlugin.swift) — `UIApplication.shared.open()`, which
 * routes to the OS's registered default browser (Chrome, Edge, etc. as
 * of iOS 14+, not always Safari — he asked 2026-09-06).
 *
 * No first-party `@capacitor/*` plugin (Browser, Camera, PushNotifications,
 * …) is linked into this app: mobile/ios/App/CapApp-SPM/Package.swift only
 * depends on bare Capacitor+Cordova (unchanged since 2026-05-04), and push
 * notifications are hand-registered in AppDelegate.swift rather than via
 * `@capacitor/push-notifications`'s native side. `ExternalBrowserPlugin`
 * follows that same established pattern (see AudioSessionPlugin.swift /
 * SpeechRecognizerPlugin.swift) — a `@capacitor/browser` fallback here
 * would be dead code that can never resolve, so there isn't one.
 *
 * Same-origin links (`?msg=` drills, hash anchors) and non-http schemes
 * (mailto:, tel:) are left to the web view, which already handles them.
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
      log(`[external-links] ExternalBrowser.open failed: ${(e as Error)?.message || e}`);
    }
  }
  // NOT falling back to `window.location.href`: allowNavigation is '*'
  // (capacitor.config.ts), so that would navigate the app's OWN web view
  // to the external site instead of handing off, stranding the user
  // outside the chat with no way back — worse than the dead tap this
  // function exists to fix.
  log(`[external-links] no way to open ${url} — ExternalBrowser plugin not available (build didn't pick it up?)`);
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
