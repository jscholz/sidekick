import Foundation
import Capacitor
import AVFoundation

/// Owns the app's *desired* AVAudioSession category and flips it on demand.
///
/// Why this exists: the app launches in `.playback` (output-only,
/// A2DP-friendly) so opening Parley while a podcast streams over
/// Bluetooth A2DP does NOT drag the BT route onto the low-sample HFP/SCO
/// call codec. A record-capable category (`.playAndRecord`) forces BT to
/// HFP the instant the session activates, even with `.allowBluetoothA2DP`
/// (that option only grants A2DP for OUTPUT) — that was the field bug
/// (Meta-glasses podcast degraded just by opening the app).
///
/// The JS audio layer (src/audio/shared/ios-specific.ts) calls into this
/// plugin to flip to `.playAndRecord` the moment the user actually starts
/// an audio experience (call / dictate / listen) and back to `.playback`
/// when capture ends. AppDelegate's launch + route-change + interruption
/// handlers all read `desiredCategory` so they re-assert whatever the app
/// currently wants rather than unconditionally forcing record.
///
/// Thread-safety: category mutation + setActive are funneled onto the main
/// queue (AVAudioSession state is not safe to mutate concurrently).
final class AudioSessionController {
    static let shared = AudioSessionController()
    private init() {}

    /// The category the app currently wants. Defaults to `.playback` at
    /// rest. AppDelegate reads this on launch / route-change / interruption
    /// so it never blindly re-forces `.playAndRecord`.
    private(set) var desiredCategory: AVAudioSession.Category = .playback

    /// Options appropriate for a given category. A2DP + BT stay on so the
    /// `.playAndRecord` flip still routes through paired headsets, and
    /// `.mixWithOthers` keeps other apps' audio alive in both states.
    static func options(for category: AVAudioSession.Category) -> AVAudioSession.CategoryOptions {
        if category == .playAndRecord {
            return [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
        }
        // .playback: output-only. .allowBluetoothA2DP keeps the high-quality
        // stereo route; .mixWithOthers lets podcasts/nav coexist.
        return [.allowBluetoothA2DP, .mixWithOthers]
    }

    /// Switch to `.playAndRecord` for an active capture (call/dictate/listen).
    /// Idempotent — a no-op if already record-capable.
    func beginCapture() {
        setCategory(.playAndRecord)
    }

    /// Return to `.playback` after capture ends. Idempotent.
    func endCapture() {
        setCategory(.playback)
    }

    private func setCategory(_ category: AVAudioSession.Category) {
        let apply = {
            self.desiredCategory = category
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setCategory(
                    category,
                    mode: .default,
                    options: AudioSessionController.options(for: category)
                )
                try session.setActive(true)
                NSLog("[Parley] AudioSession flipped to \(category == .playAndRecord ? "playAndRecord" : "playback")")
            } catch {
                NSLog("[Parley] AudioSession flip to \(category.rawValue) failed: \(error.localizedDescription)")
            }
        }
        if Thread.isMainThread {
            apply()
        } else {
            DispatchQueue.main.async(execute: apply)
        }
    }
}

/// Capacitor bridge so JS can flip the AVAudioSession category just-in-time
/// around mic capture. JS would reach it at
/// `window.Capacitor.Plugins.AudioSession`.
///
/// ⚠️ NOT CURRENTLY REGISTERED — THIS PLUGIN HAS NEVER RUN. The original
/// comment here claimed "auto-registered by Capacitor via the @objc runtime";
/// that is false. Capacitor 8's CapacitorBridge.registerPlugins() only loads
/// five hard-coded core plugins plus the npm-derived packageClassList in
/// capacitor.config.json — a local plugin needs an explicit
/// `bridge.registerPluginInstance(AudioSessionPlugin())` in
/// WebViewDelegate.capacitorDidLoad() (see ExternalBrowserPlugin, which does).
/// Because nativeAudioSession() in src/audio/shared/ios-specific.ts null-checks
/// `cap.Plugins?.AudioSession` and no-ops, the failure was silent: the app has
/// been running in whatever category WKWebView's getUserMedia negotiates, so
/// the Bluetooth-A2DP-preservation behaviour this plugin exists to provide
/// (podcast over BT not dropping to HFP when Parley opens) was never active.
/// Registering it is a live audio-routing change and wants its own on-device
/// test pass — deliberately left off until then (found 2026-09-06).
@objc(AudioSessionPlugin)
public class AudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioSessionPlugin"
    public let jsName = "AudioSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "beginCapture", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCapture", returnType: CAPPluginReturnPromise),
    ]

    @objc func beginCapture(_ call: CAPPluginCall) {
        AudioSessionController.shared.beginCapture()
        call.resolve()
    }

    @objc func endCapture(_ call: CAPPluginCall) {
        AudioSessionController.shared.endCapture()
        call.resolve()
    }
}
