// Kiro IDE 1.1.14, PreToolUse before fs_write (create or overwrite a file).
// Source: measured live by awslabs/aidlc-workflows,
// docs/reference/kiro-ide-hook-payload.md ("On 1.1.14 the PreToolUse fs_write
// input is {path, text}"); the envelope's fields are its 1.0.165 capture's
// (session_id "sess_…", hook_event_name, cwd, tool_name, tool_input). The
// path is workspace-relative, as that page found Kiro's paths to be.

export default (cwd, session) => ({
  session_id: session,
  hook_event_name: 'PreToolUse',
  cwd,
  tool_name: 'fs_write',
  tool_input: { path: 'src/models/user.ts', text: 'export interface User {\n  id: string;\n  role: string;\n}\n' },
});
