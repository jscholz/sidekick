import Foundation
import Capacitor
import UIKit

/// Hands an http(s) URL to iOS's default-browser resolution instead of
/// `@capacitor/browser`, which always renders through
/// SFSafariViewController — a Safari-branded in-app sheet that ignores
/// which browser the user has set as default (field 2026-09-06: he asked
/// whether a tapped transcript link would open his default browser,
/// Chrome, or always Safari — with only the Browser plugin, always Safari).
///
/// `UIApplication.shared.open(_:options:completionHandler:)` is Apple's
/// documented "hand this URL to whichever app owns it" API; for http/https
/// that's the OS's registered default browser as of iOS 14+.
///
/// Registered by hand in WebViewDelegate.capacitorDidLoad() via
/// `bridge.registerPluginInstance(_:)`. That call is NOT optional: Capacitor 8
/// does not auto-discover CAPBridgedPlugin classes, so without it this file
/// compiles into the binary and is never reachable from JS. See the comment in
/// capacitorDidLoad() for the full mechanism. JS reaches it at
/// `window.Capacitor.Plugins.ExternalBrowser`.
@objc(ExternalBrowserPlugin)
public class ExternalBrowserPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ExternalBrowserPlugin"
    public let jsName = "ExternalBrowser"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("invalid or missing url")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { success in
                if success {
                    call.resolve(["opened": true])
                } else {
                    call.reject("system could not open url")
                }
            }
        }
    }
}
