// Amp's tool.result event: the same call after it ran, before its result goes
// back to the model.
//
// Source: @ampcode/plugin 0.0.0-20261004010057-g91b9e0f, index.d.ts
// (ToolResultEvent extends ToolResult: toolUseID, tool, input, status 'done' |
// 'error' | 'cancelled', error?, output?: unknown, and thread.id). The shape
// of `output` for an edit is not documented, and the plugin never reads it: a
// handler that returns nothing leaves the result as it was ("Return nothing to
// keep the original result", ampcode.com/docs/customize/plugins, 2026-10-05).

/** The result of `call` (one of the tool-call fixtures), with `status`. */
export default (call, status = 'done') => ({
  toolUseID: call.toolUseID,
  tool: call.tool,
  input: call.input,
  status,
  output: status === 'done' ? 'done' : undefined,
  ...(status === 'error' ? { error: 'failed' } : {}),
  thread: call.thread,
});
