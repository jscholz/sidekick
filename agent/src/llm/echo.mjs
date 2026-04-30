// Echo LLM — replies "You said: <user message>". The default if no
// other adapter is configured. Useful as a first-clone smoke test
// (sidekick boots, you type "hi", you see a reply) and as the
// fast/deterministic backend for tests that don't care about LLM
// content.

export class EchoLLM {
  name = 'echo';

  /**
   * @param {Array<{role: string, content: string}>} messages
   */
  async *stream(messages) {
    const last = messages.slice().reverse().find(m => m.role === 'user');
    const text = last?.content ?? '';
    yield `You said: ${text}`;
  }
}
