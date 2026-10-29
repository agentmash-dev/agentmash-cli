// Kiro IDE 1.0.165 and 1.0.242, PostToolUse after fs_write.
// Source: measured live by awslabs/aidlc-workflows,
// docs/reference/kiro-ide-hook-payload.md: tool_input arrives empty ({}) after
// a write, and tool_response is prose naming the file, workspace-relative:
// "Created the <PATH> file.". There is no success flag.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PostToolUse',
  cwd,
  tool_name: 'fs_write',
  tool_input: {},
  tool_response: 'Created the src/models/user.ts file.',
});
