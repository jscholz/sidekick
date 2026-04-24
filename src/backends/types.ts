/**
 * @fileoverview Backend adapter contract — Sidekick's abstraction over
 * different streaming-chat services (OpenClaw gateway, OpenAI-compatible
 * endpoints, Anthropic, custom HTTP + SSE, future conversational audio
 * services like Gemini Live).
 *
 * Goals:
 *   - Shell code (src/main.ts, src/chat.ts, etc.) never imports from a
 *     specific backend. It subscribes to normalized events from whichever
 *     adapter is active.
 *   - A new backend = drop a module implementing `BackendAdapter`, register
 *     it in the dispatcher (src/backend.ts).
 *   - Backends advertise capability flags so the UI can hide controls
 *     whose backing feature isn't supported (e.g. hide the model picker
 *     against a backend that doesn't expose one).
 *
 * See src/backends/README.md for the adding-a-backend checklist.
 */

// ─── Events the adapter emits upward to the shell ───────────────────────────

/**
 * Streaming partial — agent text as it arrives. `cumulativeText` is the
 * full reply text so far (NOT the incremental delta). This matches what
 * the streaming-TTS pipeline expects (it recomputes sentence boundaries
 * from the running text).
 *
 * @typedef {Object} DeltaEvent
 * @property {string} replyId
 * @property {string} cumulativeText
 */

/**
 * Complete agent reply.
 *
 * @typedef {Object} FinalEvent
 * @property {string} replyId
 * @property {string} text
 * @property {Array<{type: string, [key: string]: any}>} [content]
 *   Raw content blocks from the backend — used by the shell to extract
 *   image blocks for inline display. Backends without a blocks concept
 *   can omit this.
 */

/**
 * Tool-call / tool-event relay — for side channels like canvas.show,
 * function results the shell wants to visualize, etc. Not every backend
 * emits these (flag via capabilities.toolEvents).
 *
 * @typedef {Object} ToolEvent
 * @property {string} kind     - e.g. "canvas.show"
 * @property {*} payload
 */

/**
 * @typedef {Object} HistoryMessage
 * @property {'user' | 'assistant' | 'system'} role
 * @property {string} [text]   - Convenience; some backends fill this.
 * @property {*[]} [content]   - Raw content blocks if present.
 * @property {string | number} [timestamp]
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} id         - Canonical provider/model string the backend accepts.
 * @property {string} [name]     - Human-readable label for the UI.
 * @property {string[]} [input]  - Supported modalities: 'text', 'image', 'audio', 'video'.
 */

// ─── Subscription shape ─────────────────────────────────────────────────────

/**
 * Activity signal — positive evidence that the agent is actively processing
 * the user's most recent message, distinct from the optimistic "we pressed
 * send" state. Fires as soon as the adapter has ANY confirmation from the
 * backend (tool calls, streaming tokens, reasoning emissions, etc.).
 *
 * Enables a two-state thinking indicator: "sending…" (optimistic, dim)
 * transitions to "working…" (confirmed, bright) the instant the first
 * activity arrives. Addresses the "blank chat for 10s while agent runs
 * tools" UX — user gets confirmation something is happening, not just
 * that their keystroke was captured locally.
 *
 * @typedef {Object} ActivityEvent
 * @property {boolean} working   - True = agent is actively processing;
 *                                 false = finished (usually paired with
 *                                 onFinal).
 * @property {string}  [detail]  - Optional short label for what the agent
 *                                 is doing ('tool', 'streaming',
 *                                 'canvas.show', etc.). Free-form string;
 *                                 shell may surface as "Using X…".
 */

/**
 * Passed to `connect`. Adapter fires these as events arrive from its wire
 * protocol. Missing handlers = adapter silently drops that event class.
 *
 * @typedef {Object} ConnectOpts
 * @property {(connected: boolean) => void} [onStatus]
 * @property {(d: DeltaEvent) => void} [onDelta]
 * @property {(f: FinalEvent) => void} [onFinal]
 * @property {(e: ToolEvent) => void} [onToolEvent]
 * @property {(a: ActivityEvent) => void} [onActivity]
 */

/**
 * @typedef {Object} SendOpts
 * @property {Array<{type?: string, mimeType: string, fileName?: string, content: string}>} [attachments]
 * @property {boolean} [voice]  Flag this message as voice-dictated. Backends
 *                              that use in-band prefixes to hint origin (e.g.
 *                              OpenClaw's "[voice]") apply them here; others
 *                              ignore. Shell calls this for any message sent
 *                              via the dictation / memo paths.
 */

// ─── Capability flags ───────────────────────────────────────────────────────

/**
 * Backends set these to true for features they support. The shell reads
 * them at startup to decide which UI controls to render.
 *
 * @typedef {Object} BackendCapabilities
 * @property {boolean} streaming    - Emits `onDelta` events. Almost always true.
 * @property {boolean} sessions     - Has session-scoped model overrides + `getCurrentModel` / `setModel`.
 * @property {boolean} models       - Exposes `listModels()` — UI renders a picker.
 * @property {boolean} toolEvents   - Emits `onToolEvent` (canvas cards, function results, etc.).
 * @property {boolean} history      - Supports `fetchHistory()`.
 * @property {boolean} attachments  - Accepts image / media attachments in sendMessage.
 * @property {boolean} [sessionBrowsing]
 *   Supports `listSessions` / `resumeSession`. UI renders a session drawer when
 *   true. Distinct from `sessions`: that flag is about model-override scope,
 *   this flag is about a browsable list of past conversations.
 */

/**
 * Session index entry — one row in the session drawer.
 *
 * @typedef {Object} SessionInfo
 * @property {string} id              - Identifier the backend uses to resume (e.g. hermes conversation name).
 * @property {string} [title]         - Optional display label. Falls back to snippet or id.
 * @property {number} lastMessageAt   - Unix-epoch seconds of the most recent turn.
 * @property {number} messageCount
 * @property {string} [snippet]       - Short preview of the last message.
 */

/**
 * Messages the shell replays into chat on resume.
 *
 * @typedef {Object} SessionMessage
 * @property {'user' | 'assistant' | 'system' | 'tool'} role
 * @property {string} content
 * @property {number} [timestamp]
 * @property {string} [toolName]    - For role='tool': which tool produced this.
 */

// ─── The adapter itself ─────────────────────────────────────────────────────

/**
 * @typedef {Object} BackendAdapter
 * @property {string} name
 * @property {BackendCapabilities} capabilities
 * @property {(opts: ConnectOpts) => Promise<void>} connect
 * @property {() => void} disconnect
 * @property {() => void} [reconnect]
 * @property {() => boolean} isConnected
 * @property {(text: string, opts?: SendOpts) => void} sendMessage
 * @property {(limit?: number) => Promise<HistoryMessage[]>} [fetchHistory]
 * @property {() => Promise<ModelEntry[]>} [listModels]
 * @property {() => Promise<string | null>} [getCurrentModel]
 * @property {(modelRef: string) => boolean} [setModel]
 * @property {() => void} [newSession]
 *   Reset / start a new agent session. For OpenClaw: sends the "/new" slash
 *   command. For backends without a session primitive: no-op or local-only
 *   cleanup. Callers typically pair this with local UI cleanup (chat.clear(),
 *   draft.dismiss(), voiceMemos.clearAll(), etc.).
 * @property {() => string | null} [getCurrentSessionId]
 *   Identifier of the currently-active session (conversation name for hermes).
 *   Shell uses it to highlight the active row in the drawer + to resume on
 *   reconnect. Null if no session has been opened yet.
 * @property {(limit?: number) => Promise<SessionInfo[]>} [listSessions]
 *   Available when `capabilities.sessionBrowsing` is true.
 * @property {(id: string) => Promise<{ messages: SessionMessage[], firstId?: number|null, hasMore?: boolean }>} [resumeSession]
 *   Point the adapter at an existing session and return its transcript. The
 *   shell replays the messages into chat UI. Next `sendMessage` continues
 *   that session server-side (e.g. hermes chains via previous_response_id).
 *   May return only the newest page; `firstId` + `hasMore` describe the
 *   cursor for loadEarlier (omitted = full transcript returned).
 * @property {(id: string, beforeId: number) => Promise<{ messages: SessionMessage[], firstId?: number|null, hasMore?: boolean }>} [loadEarlier]
 *   Fetch the next older page of a session's transcript. Called by the
 *   chat pane when the user scrolls near the top and `hasMore` was true.
 */

// JSDoc-only.
export {};
