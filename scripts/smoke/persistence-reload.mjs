// Scenario: send a message, reload the page, expect the chat to
// restore from IDB snapshot (chat_id active, transcript visible).
// Catches: chat snapshot save/restore regressing; activeChatId not
// hydrating correctly on connect; the drawer not pinning the right
// session as viewed after reload.

export const NAME = 'persistence-reload';
export const DESCRIPTION = 'Reload after sending a message restores the chat in place';
export const STATUS = 'stub';

export default async function run({ fail }) {
  fail('not implemented yet');
}
