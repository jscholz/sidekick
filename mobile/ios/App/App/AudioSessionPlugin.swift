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
/// ⚠️ NOT REGISTERED — REGISTERING THIS FREEZES THE DEVICE (reverted 2026-09-06).
///
/// Capacitor 8 does not auto-discover CAPBridgedPlugin classes, so this plugin
/// never ran from its creation until we tried to switch it on. Turning it on
/// produced an audio-session feedback loop that hung the app hard enough to
/// need a force-quit, and Listen never started:
///
///     [Parley] AVAudioSession apply failed: … (OSStatus error 560557684.)
///     [Parley] audio route changed (reason: 3)
///     SessionCore.mm:546  Failed to set properties, error: '!int'
///     …repeating forever
///
/// 560557684 == '!int' == AVAudioSessionErrorCodeCannotInterruptOthers, and
/// route-change reason 3 == .categoryChange. The cycle:
///   setCategory() → iOS posts routeChangeNotification(.categoryChange)
///     → AppDelegate.handleAudioRouteChange() re-asserts unconditionally
///       → applyDesiredCategory() calls setCategory() + setActive(true)
///         → another .categoryChange → …
/// setActive(true) also fails CannotInterruptOthers because the options here
/// include .mixWithOthers. The loop was dormant only because desiredCategory
/// never changed while this plugin was unregistered — re-asserting an
/// already-current category is a no-op that posts no notification. The moment
/// beginCapture() could actually flip it, the loop became live, and because
/// AudioSessionController funnels its work onto the main queue the flood
/// saturated the UI thread — hence the freeze.
///
/// PREREQUISITE before re-registering: make AppDelegate.handleAudioRouteChange
/// ignore .categoryChange (it is our OWN change echoing back; the reasons worth
/// reacting to are .newDeviceAvailable / .oldDeviceUnavailable), and re-check
/// whether setActive(true) belongs on that path at all. Fixing that is what the
/// original A2DP work actually needed; this plugin alone is not enough.
///
/// History: from this file's creation until 2026-09-06 the registration line
/// did not exist, so this plugin never ran once. nativeAudioSession() in
/// src/audio/shared/ios-specific.ts null-checks `cap.Plugins?.AudioSession`
/// and no-ops, so the failure was silent. Two consequences, both now fixed by
/// registering it:
///   1. The A2DP preservation this plugin was written for never happened —
///      the session category was whatever WKWebView's getUserMedia left behind.
///   2. Worse: AppDelegate.applyDesiredCategory() re-asserts `desiredCategory`
///      on launch, route change and interruption-end, and that value was pinned
///      at `.playback` (output-only) forever. A Bluetooth route change or a
///      phone-call interruption DURING a Parley call therefore re-applied an
///      output-only category underneath a live capture.
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
