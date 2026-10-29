// Amp's agent.start event: the person submitted a prompt.
//
// Source: @ampcode/plugin 0.0.0-20261004010057-g91b9e0f, index.d.ts
// (AgentStartEvent: thread, message "The user's prompt message", id, a
// ThreadMessageID: a number in a legacy thread, a string in Neo, and
// changesWorkflow only when the Ship or Push to Branch button started it). A
// handler may return { message: { content, display? } }, "appended after the
// user's content in the user message", hidden unless display is true.

export default (message = 'give the user a role', thread = 'T-f9941a55-3765-421e-972f-05dc1138c3a3') => ({
  thread: { id: thread },
  message,
  id: 'msg-0001',
});
