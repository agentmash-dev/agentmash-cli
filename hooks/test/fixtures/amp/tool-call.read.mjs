// Amp's tool.call event for a read: the one tool call Amp's docs print whole.
//
// Source: ampcode.com/docs/cli/streaming-json, "Tool usage example" (read
// 2026-10-05, Amp CLI 0.0.1791146283-g5c3f72): an assistant message with
// {"type":"tool_use","id":"toolu_019cyniPYrSgaJitUSMyxyNV","name":"read",
// "input":{"path":"/Users/orb/project"}}, in thread
// T-d2fc4acc-dd1d-497f-9609-ed0da22a7c95; laid out as @ampcode/plugin
// 0.0.0-20261004010057-g91b9e0f's ToolCallEvent, with the path in the test's
// checkout. A read changes no file: Amp's helper answers null for it.

export default (project) => ({
  toolUseID: 'toolu_019cyniPYrSgaJitUSMyxyNV',
  tool: 'read',
  input: { path: `${project}/src/models/user.ts` },
  thread: { id: 'T-d2fc4acc-dd1d-497f-9609-ed0da22a7c95' },
});

/** amp.helpers.filesModifiedByToolCall's answer: null, "if the tool doesn't modify files". */
export const modifies = () => null;
