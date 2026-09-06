import Foundation
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
/// AppDelegate's launch + route-change + interruption handlers read
/// `desiredCategory` so they re-assert whatever the app currently wants
/// rather than unconditionally forcing record.
///
/// NOTE: nothing currently calls beginCapture()/endCapture(), so
/// `desiredCategory` stays `.playback` for the whole life of the process and
/// the CAP build leaves the category to WKWebView's own getUserMedia
/// negotiation. A CAPPlugin bridge that let JS drive these existed here but
/// was never registered (Capacitor 8 does not auto-discover local plugins),
/// so it never ran; switching it on 2026-09-06 produced a route-change
/// feedback loop that froze the device, and it was deleted rather than left
/// as a trap. Before wiring this up again, fix
/// AppDelegate.handleAudioRouteChange: it re-asserts the category on EVERY
/// route change including `.categoryChange`, which is the app's own change
/// echoing back — setCategory → .categoryChange → setCategory → …, with
/// setActive(true) failing CannotInterruptOthers ('!int', OSStatus
/// 560557684) because these options include `.mixWithOthers`. That loop is
/// unreachable only because desiredCategory never changes today.
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
