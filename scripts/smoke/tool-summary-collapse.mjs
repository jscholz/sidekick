// Scenario: with agentActivity='summary' (default), the activity row
// renders as a single one-line summary "🔧 N tools · X.Xs ✓" with the
// tool details collapsed. Clicking the summary expands the inline
// detail rows. Catches: summary mode regressing to always-expanded
// (clutters the chat) OR summary mode not rendering at all.
//
// Test plan:
//   1. Verify settings.agentActivity === 'summary' (default).
//   2. Send a tool-using prompt, wait for activity row to finalize.
//   3. Assert the row has:
//      - .activity-row-summary visible
//      - .activity-row-full hidden / not visible (collapsed)
//   4. Click the summary → assert .activity-row-full becomes visible.
//   5. (Bonus) toggle agentActivity to 'full' mid-conversation,
//      send another tool prompt, assert .activity-row-full is
//      visible by default WITHOUT a click.

export const NAME = 'tool-summary-collapse';
export const DESCRIPTION = 'agentActivity=summary collapses tool rows; click expands';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet — write FIRST to confirm summary collapse renders + toggles');
}
