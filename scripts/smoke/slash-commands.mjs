// Scenario: type a slash command (/new, /clear, /sethome, /compress)
// and verify the agent's response shape + side effects:
//   /new       — current chat resets / new chat_id minted.
//   /clear     — local chat history clears (server retains).
//   /sethome   — agent confirms; subsequent fresh chats skip the
//                home-channel nudge.
//   /compress  — agent compresses session; reply summarizes.

export const NAME = 'slash-commands';
export const DESCRIPTION = 'Slash commands reach the gateway and produce expected side effects';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet');
}
