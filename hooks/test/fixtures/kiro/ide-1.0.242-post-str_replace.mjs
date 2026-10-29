// Kiro IDE 1.0.165 and 1.0.242, PostToolUse after str_replace.
// Source: measured live by awslabs/aidlc-workflows,
// docs/reference/kiro-ide-hook-payload.md: tool_input empty ({}), and
// tool_response "Replaced text in <PATH>", which "may carry a trailing
// (N occurrences)".

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PostToolUse',
  cwd,
  tool_name: 'str_replace',
  tool_input: {},
  tool_response: 'Replaced text in src/models/user.ts (2 occurrences)',
});
