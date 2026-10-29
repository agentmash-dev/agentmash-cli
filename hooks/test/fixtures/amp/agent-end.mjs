// Amp's agent.end event: the agent finished a turn.
//
// Source: @ampcode/plugin 0.0.0-20261004010057-g91b9e0f, index.d.ts
// (AgentEndEvent: thread, message, the prompt that started the turn, id,
// status 'done' | 'error' | 'cancelled', and messages, every message since
// agent.start, which the plugin never reads or sends). A handler may return
// { action: 'continue', … } to start another turn, which the plugin never does.

export default (status = 'done', thread = 'T-f9941a55-3765-421e-972f-05dc1138c3a3') => ({
  thread: { id: thread },
  message: 'give the user a role',
  id: 'msg-0001',
  status,
  messages: [],
});
