// Scenario: changing agentActivity from 'summary' → 'full' mid-
// conversation takes effect on the NEXT tool event without requiring
// reload. Catches: settings change cached at module-load time and
// not re-read per event.

export const NAME = 'settings-mid-chat';
export const DESCRIPTION = 'agentActivity setting takes effect immediately when toggled';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet');
}
