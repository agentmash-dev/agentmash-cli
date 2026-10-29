// Kiro IDE / kiro-cli V3, PreToolUse before read_file (alias fs_read).
// Source: the tool's name from kiro.dev/docs/tools.md (checked 2026-10-05);
// its input's shape is not documented, and {path} is assumed. It reaches the
// hook only when a matcher lets it (login's matches writes alone), and a read
// is never asked about either way.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  cwd,
  tool_name: 'read_file',
  tool_input: { path: 'src/models/user.ts' },
});
