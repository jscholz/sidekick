//
//  WebViewDelegate.swift
//  App
//
//  Auto-grants getUserMedia (microphone/camera) prompts inside the
//  Capacitor WKWebView. Without this, calls to navigator.mediaDevices.getUserMedia
//  inside the wrapper silently fail because WKWebView's default WKUIDelegate
//  has no media-capture permission handler — even when iOS-level mic permission
//  is granted via NSMicrophoneUsageDescription.
//
//  Reference: https://blog.silverpc.hu/2025/10/23/a-guide-to-permissions-how-can-i-access-the-microphone-via-a-webview/
//

import Foundation
import Capacitor
import WebKit

/// Subclass the Capacitor bridge view controller so we own the WKUIDelegate.
/// The default Main.storyboard already instantiates `CAPBridgeViewController`;
/// we re-point it at this subclass below in didFinishLaunching.
class ParleyBridgeViewController: CAPBridgeViewController, WKUIDelegate, WKScriptMessageHandler {

    /// Cap-specific JS+CSS injected at document_start so the PWA core
    /// (index.html, styles/app.css) has zero Capacitor-conditional code.
    /// Architectural rule: Cap-specific behavior stays inside
    /// `mobile/ios/App/` so the Cap shell could be ripped out by
    /// deleting the directory without touching shared sources.
    ///
    /// Three things need Cap-only treatment:
    ///   1. `viewport-fit=cover` — required for env(safe-area-inset-*)
    ///      to return real values. CANNOT be in the PWA's static meta
    ///      because iOS Safari PWA standalone interprets it differently
    ///      (caps the layout viewport at "screen − safe-area" → composer
    ///      floats in unreachable WebView space). Cap-only.
    ///   2. `<html class="capacitor-app">` — body class for CSS scoping.
    ///      Cap's WKWebView does NOT report `display-mode: standalone`
    ///      to matchMedia despite rendering edge-to-edge, so the @media
    ///      query alone misses it.
    ///   3. Cap-only safe-area padding rules for .header and .sidebar-top
    ///      so the brand + Menu label clear the iOS Dynamic Island /
    ///      status bar.
    private static let capOverlayScript = """
    (function() {
      // documentElement exists at .atDocumentStart — class can be set
      // immediately so first paint already sees `<html class="capacitor-app">`.
      document.documentElement.classList.add('capacitor-app');

      // <head> + its children (including <meta name=viewport>) DO NOT
      // yet exist at .atDocumentStart — only <html> has been opened.
      // The meta-tag mutation + <style> injection must wait until <head>
      // is parsed, otherwise:
      //   - querySelector for the viewport meta returns null → no
      //     viewport-fit=cover ever gets added → env(safe-area-inset-*)
      //     returns 0 → `.capacitor-app .header` rule resolves to
      //     `padding: max(4px, -20px) ...` = 4px → brand draws 4px
      //     from screen top, overlapping the status bar / clock.
      //     (Pre-isolation the meta was static in index.html so CSS
      //     saw real env values; post-refactor the WKUserScript path
      //     must wait for <head> before injecting.)
      // Use MutationObserver to fire as soon as <head> appears (more
      // reliable than DOMContentLoaded for Cap's WKWebView, which can
      // sometimes lay out before DCL fires).
      function applyOverlay() {
        var vp = document.querySelector('meta[name=viewport]');
        if (vp && !/viewport-fit=cover/.test(vp.getAttribute('content') || '')) {
          vp.setAttribute('content', vp.getAttribute('content') + ', viewport-fit=cover');
        }
        if (!document.getElementById('cap-overlay-style')) {
          var s = document.createElement('style');
          s.id = 'cap-overlay-style';
          s.textContent = [
            '.capacitor-app .header {',
            '  /* -8px (was -20px): shifts the brand down ~12px more,',
            '   * clearing the iOS clock with a comfortable gap. max()',
            '   * floor of 4px keeps non-notch devices sane (env',
            '   * returns 0 there). */',
            '  padding: max(4px, calc(env(safe-area-inset-top) - 8px)) 18px 4px;',
            '}',
            '.capacitor-app .sidebar-top {',
            '  /* Buttons inside (sb-toggle, sb-search) must be tappable —',
            '   * use the FULL safe-area inset (not the -20px shift the header',
            '   * brand uses). With -20 the search button on the right could',
            '   * end up under the iOS signal/wifi icons or in the swipe-zone',
            '   * iOS reserves for system gestures, making it unreachable. */',
            '  padding-top: max(10px, env(safe-area-inset-top));',
            '}'
          ].join('\\n');
          document.head.appendChild(s);
        }
      }

      if (document.head) {
        applyOverlay();
      } else {
        // Watch for <head> being added to <html>. Fires before any
        // <link rel=stylesheet> children are parsed, so our <style>
        // gets ordered after them — same-specificity tiebreak by
        // source order favors our rule.
        var obs = new MutationObserver(function() {
          if (document.head) { obs.disconnect(); applyOverlay(); }
        });
        obs.observe(document.documentElement, { childList: true });
        // Belt-and-braces fallback in case the observer never fires.
        document.addEventListener('DOMContentLoaded', applyOverlay, { once: true });
      }
    })();
    """

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Local (non-npm) plugins MUST be registered by hand. Capacitor 8 does
        // NOT scan the Objective-C runtime for CAPBridgedPlugin conformers:
        // CapacitorBridge.registerPlugins() builds an explicit list of the five
        // built-in core plugins (Http/Console/WebView/Cookies/SystemBars) plus
        // whatever class names `cap sync` wrote into capacitor.config.json's
        // packageClassList — and that list only ever contains npm-installed
        // plugins. A plugin file sitting in this target compiles fine, exports
        // nothing, and every JS call rejects with "not implemented on ios"
        // (field 2026-09-06: transcript links did nothing in the CAP app; the
        // JS console showed the plugin missing, and
        // `Capacitor.PluginHeaders` listed only the six npm/core plugins).
        //
        // NOTE: AudioSessionPlugin + SpeechRecognizerPlugin are NOT registered
        // here yet, so they have never actually run — their own doc comments
        // claiming "@objc runtime auto-registration" are wrong. Their JS
        // callers null-check and no-op silently, which is why nothing looked
        // broken. Registering them changes live audio-routing behaviour, so
        // that's a deliberate separate change, not a drive-by.
        bridge?.registerPluginInstance(ExternalBrowserPlugin())
        guard let webView = self.bridge?.webView else { return }
        // Take ownership of the UI delegate slot. Capacitor itself only sets
        // the navigation delegate, so we don't conflict with the bridge.
        webView.uiDelegate = self
        // Inject the Cap-only viewport / body-class / safe-area-CSS overlay.
        // forMainFrameOnly: true — sub-frames don't need this. injectionTime:
        // .atDocumentStart so the body class + viewport meta are in place
        // before the PWA's main bundle parses + the first paint happens.
        let userScript = WKUserScript(
            source: ParleyBridgeViewController.capOverlayScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        webView.configuration.userContentController.addUserScript(userScript)
        // Wire up the lockscreen / BT-headset remote-control bridge.
        // CallControls (singleton in AppDelegate) now uses this closure
        // to reach the WebView when MPRemoteCommandCenter callbacks
        // fire. Weak-self on the bridge avoids retain cycles if Cap
        // ever recreates the controller; webView is also a weak hop.
        CallControls.shared.webViewProvider = { [weak self] in
            self?.bridge?.webView
        }
        // Reset-server bridge: the in-app "Reset Server URL" button
        // posts a webkit.messageHandlers.parleyReset message. We
        // can't navigate JS-side from an HTTPS origin back to
        // capacitor:// scheme (Cap blocks it for security), so the
        // native side must perform the load. JS posts → we receive
        // → load the bundled bootstrap with ?config=1 to force the
        // form display.
        webView.configuration.userContentController.add(self, name: "parleyReset")
    }

    // MARK: - WKScriptMessageHandler
    //
    // Single dispatch for all named messages from the bundled JS.
    // Today only `parleyReset` is registered; future bridges can
    // add more named handlers in capacitorDidLoad().
    func userContentController(_ userContentController: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        switch message.name {
        case "parleyReset":
            handleParleyReset()
        default:
            NSLog("[Parley] unknown JS message: \(message.name)")
        }
    }

    /// Load the bundled bootstrap (mobile/webdir/index.html) with
    /// ?config=1 in the WebView. Used by the in-app "Reset Server URL"
    /// button to bring the user back to the URL picker without
    /// reinstalling the app. The ?config=1 query param tells the
    /// bootstrap to suppress its auto-redirect even when a saved URL
    /// is present, and pre-fill the field with the prior choice.
    private func handleParleyReset() {
        guard let webView = self.bridge?.webView else {
            NSLog("[Parley] parleyReset: no webView")
            return
        }
        // The bundled webDir lands as `public/` inside the .app at
        // sync time. Cap exposes the path via Bundle.main; index.html
        // is the entry point we want.
        guard let bundleURL = Bundle.main.url(forResource: "public/index",
                                               withExtension: "html") else {
            NSLog("[Parley] parleyReset: bundled index.html not found in app")
            return
        }
        // Append the query param. URLComponents handles the encoding.
        var components = URLComponents(url: bundleURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "config", value: "1")]
        guard let target = components?.url else {
            NSLog("[Parley] parleyReset: URLComponents failed")
            return
        }
        DispatchQueue.main.async {
            // allowingReadAccessTo: the public/ directory so the
            // bootstrap can load any sibling assets it might add later.
            let readDir = bundleURL.deletingLastPathComponent()
            webView.loadFileURL(target, allowingReadAccessTo: readDir)
            NSLog("[Parley] parleyReset: loaded bootstrap with ?config=1")
        }
    }

    // iOS 15+ — modern media-capture permission callback.
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

    // MARK: - JavaScript dialog handlers
    //
    // WKWebView's default behavior is to silently swallow JS
    // alert/confirm/prompt calls unless the WKUIDelegate provides
    // these methods. Without them, `window.alert(...)` does nothing,
    // `window.confirm(...)` returns false, `window.prompt(...)`
    // returns null. Without these handlers, the Reset Server URL button's
    // confirm() dialog is suppressed → confirm()=false → handler bails
    // → user sees nothing happen.
    //
    // These handlers route the dialogs through native UIAlertController
    // so they actually appear. Each preserves the page that issued
    // the dialog by passing through the completion handler the WebView
    // is waiting on.

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        DispatchQueue.main.async { self.present(alert, animated: true) }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        DispatchQueue.main.async { self.present(alert, animated: true) }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        // Capacitor's injected `native-bridge.js` uses synchronous
        // `window.prompt(JSON.stringify({type: 'CapacitorCookies.isEnabled'}))`
        // and `prompt(JSON.stringify({type: 'CapacitorHttp'}))` at startup as a
        // sync IPC channel to ask the native side whether those features are
        // enabled. Cap's own `WebViewDelegationHandler` intercepts these and
        // replies inline without showing UI.
        //
        // We took over the WKUIDelegate slot in capacitorDidLoad() to wire up
        // mic permission + JS dialogs, which displaced Cap's handler — so its
        // bridge probes started falling through to this default text-input
        // implementation, popping up two UIAlertControllers showing the raw
        // JSON on every fresh iOS launch.
        //
        // Detect those bridge prompts here and answer them the same way Cap
        // does when the plugin is disabled in config (we don't enable either
        // in capacitor.config.ts): reply "false" for CapacitorHttp + the
        // CapacitorCookies.isEnabled probe; reply "" for CapacitorCookies.get
        // and .set so `document.cookie` reads/writes don't throw if some
        // future dep ever touches them.
        if let data = prompt.data(using: .utf8),
           let payload = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? [String: Any],
           let type = payload["type"] as? String {
            if type == "CapacitorHttp" || type == "CapacitorCookies.isEnabled" {
                completionHandler("false")
                return
            }
            if type == "CapacitorCookies.get" || type == "CapacitorCookies.set" {
                completionHandler("")
                return
            }
        }
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { tf in tf.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        DispatchQueue.main.async { self.present(alert, animated: true) }
    }
}
