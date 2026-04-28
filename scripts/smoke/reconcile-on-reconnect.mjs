// Scenario: simulate the EventSource being killed mid-conversation;
// verify forceReconnect (visibility/online/pageshow) restores the
// stream and onResume re-fetches transcript history if the gap is
// long enough that the proxy's 128-entry replay ring may have rolled
// over.
//
// Hard to simulate cleanly headless — Playwright doesn't easily fake
// "iOS background-kill". Possible approaches:
//   - Dispatch a `visibilitychange` event from the page context.
//   - kill the sidekick.service mid-flight then restart it (heavy,
//     touches real systemd; only viable on blueberry).
// Picking the lighter approach for v1 stub.

export const NAME = 'reconcile-on-reconnect';
export const DESCRIPTION = 'EventSource reconnect after gap reconciles transcript via onResume';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet');
}
