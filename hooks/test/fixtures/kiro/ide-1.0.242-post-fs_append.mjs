// Kiro IDE 1.0.165 and 1.0.242, PostToolUse after fs_append.
// Source: measured live by awslabs/aidlc-workflows,
// docs/reference/kiro-ide-hook-payload.md: tool_input empty ({}), and
// tool_response "Appended the text to the <PATH> file.".

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PostToolUse',
  cwd,
  tool_name: 'fs_append',
  tool_input: {},
  tool_response: 'Appended the text to the src/models/user.ts file.',
});
